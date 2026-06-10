/**
 * ast-grep — structural (AST) code search tool.
 *
 * M6 adaptation: engine routing matrix + napi integration + guarded writer.
 *
 * Engine routing (DA-N2):
 *   ts/tsx/js/jsx → @ast-grep/napi (findInFiles ONLY)
 *   py/rs/go      → napi IFF @ast-grep/lang-* package available, else CLI sg
 *   all other     → CLI sg → ripgrep floor
 *
 * Napi apply (DA-N4): in-memory edits (SgNode.replace → commitEdits) written
 * through retryOnLock guarded writer — never touches disk directly.
 *
 * .env plane: refuses .env files (allows .env.example|sample|template).
 * Annotations: destructiveHint when apply=true.
 *
 * Resolver: napi → ast-grep → sg → ripgrep (text fallback). Array-argv, no
 * shell, so $-metavariables in patterns survive. Timeout-bounded.
 */

import { runBounded, tail } from "../lib/withTimeout";
import type { NavEnvelope } from "../lib/withTimeout";
import { retryOnLock } from "../core/workspace-edit";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// ── Language maps ──────────────────────────────────────────────────────────────

/** Language ids that can use @ast-grep/napi natively (built-in Lang enum). */
const NAPI_NATIVE = new Set(["ts", "tsx", "js", "jsx"]);

/** Map short lang id to @ast-grep/napi Lang enum string. */
const NAPI_LANG_MAP: Record<string, string> = {
  ts:  "TypeScript",
  tsx: "Tsx",
  js:  "JavaScript",
  jsx: "JavaScript",
};

/** Map short lang id to CLI (sg/ast-grep) language name. */
const CLI_LANG_MAP: Record<string, string> = {
  ts:  "typescript",
  tsx: "tsx",
  js:  "javascript",
  jsx: "javascript",
  py:  "python",
  rs:  "rust",
  go:  "go",
  java: "java",
  c:   "c",
  cpp: "cpp",
  rb:  "ruby",
  php: "php",
};

/**
 * Languages that could use napi via @ast-grep/lang-* dynamic packages.
 * Not installed by default — checked at runtime.
 */
const DYNAMIC_LANG_PKG: Record<string, string> = {
  py: "@ast-grep/lang-python",
  rs: "@ast-grep/lang-rust",
  go: "@ast-grep/lang-go",
};

/**
 * Set of dynamic language pkg names already verified as loadable.
 * Cached so we only try once per session.
 */
const DYNAMIC_LANG_LOADED = new Set<string>();

// Heavy dirs excluded from CLI scans (gitignore-style globs, `!` = exclude).
const CLI_EXCLUDES = [
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/.git/**",
  "!**/.venv/**",
  "!**/target/**",
];

// ── Helpers ────────────────────────────────────────────────────────────────────

async function which(bin: string): Promise<boolean> {
  const probe =
    process.platform === "win32"
      ? ["where", bin]
      : ["bash", "-lc", `command -v ${bin}`];
  const r = await runBounded(probe, { timeoutMs: 4_000 });
  if (!r.ok) return false;
  const p = r.payload!;
  return p.code === 0 && p.stdout.trim().length > 0;
}

/**
 * Try to dynamically register a @ast-grep/lang-* package for the given lang.
 * Returns true if successful (package exists + loaded).
 */
async function tryDynamicLang(lang: string): Promise<boolean> {
  if (DYNAMIC_LANG_LOADED.has(lang)) return true;
  const pkg = DYNAMIC_LANG_PKG[lang];
  if (!pkg) return false;
  try {
    // Dynamic import of the lang package — registers itself with napi
    await import(/* @vite-ignore */ pkg);
    DYNAMIC_LANG_LOADED.add(lang);
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine if napi is available for this language.
 * - ts/tsx/js/jsx → always true (built-in Lang enum)
 * - py/rs/go      → true if @ast-grep/lang-* can be loaded
 * - everything    → false (CLI only)
 */
async function napiAvailableFor(lang: string): Promise<boolean> {
  if (NAPI_NATIVE.has(lang)) return true;
  if (lang in DYNAMIC_LANG_PKG) return tryDynamicLang(lang);
  return false;
}

// ── .env plane guard ──────────────────────────────────────────────────────────

const ENV_RE = /(^|[\\/])\.env(\b|\.)/i;
const ENV_OK = /\.env\.(example|sample|template)$/i;
const isSecretPath = (p?: string): boolean =>
  !!p && ENV_RE.test(p) && !ENV_OK.test(p);

// ── Args interface ─────────────────────────────────────────────────────────────

export interface AstGrepArgs {
  /** ast-grep pattern, e.g. 'useEffect($$$)' or 'def $F($$$):' */
  pattern: string;
  /** Directory or file to search (default: project root) */
  path?: string;
  /** Language id: ts, tsx, py, rs, go, java, c, cpp... */
  lang?: string;
  /** Max matches to return (1-200, default 50) */
  max?: number;
  /** Seconds before degrading (1-120, default 45) */
  timeout?: number;
  /**
   * Replacement pattern using ast-grep $META-VARIABLE syntax.
   * Returns a preview by default; set apply=true to mutate files.
   */
  rewrite?: string;
  /**
   * If true and rewrite is set, apply rewrites to files in place (mutating).
   * Default false = dry-run preview only.
   */
  apply?: boolean;
}

/** Pending write for napi apply mode — collected from findInFiles callbacks. */
interface PendingWrite {
  filePath: string;
  newContent: string;
}

// ── Napi-backed search ─────────────────────────────────────────────────────────

interface NapiMatch {
  file: string;
  line: number;
  text?: string;
  replacement?: string;
}

/**
 * Attempt search via @ast-grep/napi.
 * Returns null if napi is unavailable or finds 0 files (degrade gracefully).
 * Throws are caught externally.
 */
async function tryNapiSearch(
  pattern: string,
  searchPath: string,
  lang: string,
  max: number,
  rewrite?: string,
): Promise<{ matches: NapiMatch[]; engine: "ast-napi" } | null> {
  let napi: typeof import("@ast-grep/napi") | undefined;
  try {
    napi = await import("@ast-grep/napi");
  } catch {
    return null; // napi not loadable
  }

  const napiLangStr = NAPI_LANG_MAP[lang];
  if (!napiLangStr) return null; // no napi lang mapping

  const napiLang = (napi.Lang as Record<string, unknown>)[napiLangStr] as
    | string
    | undefined;
  if (!napiLang) return null;

  const config = {
    paths: [searchPath],
    matcher: { rule: { pattern } },
  };

  const matches: NapiMatch[] = [];

  const fileCount = await napi.findInFiles(
    napiLang,
    config,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err: unknown, nodes: any[]) => {
      if (err || !nodes || nodes.length === 0) return;
      const root = nodes[0].getRoot();
      const file = root.filename() as string;

      for (const node of nodes) {
        const range = node.range() as { start: { line: number } };
        const m: NapiMatch = {
          file,
          line: range.start.line + 1,
        };
        if (rewrite !== undefined) {
          m.text = (node.text() as string).slice(0, 120);
          try {
            const edit = node.replace(rewrite) as {
              insertedText: string;
            };
            m.replacement = edit.insertedText.slice(0, 120);
          } catch {
            m.replacement = "(replacement failed)";
          }
        }
        matches.push(m);
        if (matches.length >= max) return; // early stop (still in callback)
      }
    },
  );

  // findInFiles returned 0 files processed — likely a napi compatibility issue
  if (fileCount === 0) return null;

  // Truncate to max (in case callback was called after we hit cap)
  if (matches.length > max) matches.length = max;

  return { matches, engine: "ast-napi" };
}

// ── Napi-backed apply (rewrite mode with apply=true) ─────────────────────────

/**
 * Apply rewrites via @ast-grep/napi in-memory editing.
 * Uses commitEdits for in-memory transformations, then writes through
 * the retryOnLock guarded writer — never touches disk directly (DA-N4).
 */
async function tryNapiApply(
  pattern: string,
  rewrite: string,
  searchPath: string,
  lang: string,
  max: number,
): Promise<{ filesChanged: number; totalEdits: number; engine: "ast-napi" } | null> {
  let napi: typeof import("@ast-grep/napi") | undefined;
  try {
    napi = await import("@ast-grep/napi");
  } catch {
    return null;
  }

  const napiLangStr = NAPI_LANG_MAP[lang];
  if (!napiLangStr) return null;

  const napiLang = (napi.Lang as Record<string, unknown>)[napiLangStr] as
    | string
    | undefined;
  if (!napiLang) return null;

  const config = {
    paths: [searchPath],
    matcher: { rule: { pattern } },
  };

  const pending: PendingWrite[] = [];
  let processedFiles = 0;

  const fileCount = await napi.findInFiles(
    napiLang,
    config,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err: unknown, nodes: any[]) => {
      if (err || !nodes || nodes.length === 0) return;

      const root = nodes[0].getRoot();
      const filePath = root.filename() as string;

      // In-memory: replace each match and commit edits
      const edits: { startPos: number; endPos: number; insertedText: string }[] =
        [];
      for (const node of nodes) {
        try {
          const edit = node.replace(rewrite) as {
            startPos: number;
            endPos: number;
            insertedText: string;
          };
          edits.push(edit);
        } catch {
          // Skip nodes that can't be replaced
        }
      }

      if (edits.length === 0) return;

      // commitEdits is on SgNode (the root node); returns new content string
      try {
        const rootNode = root.root() as { commitEdits: (edits: unknown[]) => string };
        const newContent = rootNode.commitEdits(edits);
        pending.push({ filePath, newContent });
        processedFiles++;
      } catch {
        // commitEdits failed — skip this file
      }
    },
  );

  if (fileCount === 0 && processedFiles === 0) return null;
  if (pending.length === 0) return null;

  // Apply pending writes via guarded writer (retryOnLock — DA-N4)
  let totalEdits = 0;
  for (const w of pending) {
    await retryOnLock(() => writeFile(w.filePath, w.newContent, "utf8"));
    totalEdits++;
  }

  return { filesChanged: pending.length, totalEdits, engine: "ast-napi" };
}

// ── CLI-backed search/rewrite (sg / ast-grep) ──────────────────────────────────

async function findCliBin(): Promise<string | null> {
  if (await which("ast-grep")) return "ast-grep";
  if (await which("sg")) return "sg";
  return null;
}

async function runCliSearch(
  pattern: string,
  searchPath: string,
  cliLang: string | undefined,
  max: number,
  timeoutMs: number,
): Promise<{ stdout: string; matches: string[]; stderr: string; timedOut: boolean } | NavEnvelope> {
  const bin = await findCliBin();
  if (!bin) return { ok: false, mode: "ast-grep", engine: "ast-cli", notes: "CLI ast-grep/sg not found" } as NavEnvelope;

  const cmd = [bin, "run", "--pattern", pattern, "--json=stream"];
  if (cliLang) cmd.push("--lang", cliLang);
  for (const ex of CLI_EXCLUDES) cmd.push("--globs", ex);
  cmd.push(searchPath);

  const r = await runBounded(cmd, { timeoutMs });
  if (!r.ok) {
    return { ok: false, mode: "ast-grep", engine: "ast-cli", notes: r.notes ?? "CLI search failed" } as NavEnvelope;
  }

  const result = r.payload!;
  if (result.timedOut) {
    return { ok: false, mode: "ast-grep", engine: "ast-cli", notes: `[ast-grep] timed out after ${Math.round(timeoutMs / 1000)}s on pattern: ${pattern}` } as NavEnvelope;
  }
  if (result.spawnError) {
    return { ok: false, mode: "ast-grep", engine: "ast-cli", notes: `[ast-grep] ${result.spawnError}` } as NavEnvelope;
  }

  const matches: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t) as { file?: string; range?: { start?: { line?: number } } };
      const ln = (m.range?.start?.line ?? 0) + 1;
      if (m.file) matches.push(`${m.file}:${ln}`);
    } catch {
      /* non-JSON line (banner) — ignore */
    }
    if (matches.length >= max) break;
  }

  return { stdout: result.stdout, matches, stderr: result.stderr, timedOut: false };
}

async function runCliRewrite(
  pattern: string,
  rewrite: string,
  searchPath: string,
  cliLang: string | undefined,
  max: number,
  timeoutMs: number,
  apply: boolean,
): Promise<NavEnvelope> {
  const bin = await findCliBin();
  if (!bin) {
    return {
      ok: false,
      mode: "ast-grep",
      engine: "ast-cli",
      notes: "CLI ast-grep/sg not found",
    };
  }

  if (apply) {
    // Apply mode — mutates files directly (CLI handles disk I/O)
    const rwCmd = [bin, "run", "--pattern", pattern, "--rewrite", rewrite, "--update-all"];
    if (cliLang) rwCmd.push("--lang", cliLang);
    for (const ex of CLI_EXCLUDES) rwCmd.push("--globs", ex);
    rwCmd.push(searchPath);

    const r = await runBounded(rwCmd, { timeoutMs });
    if (!r.ok) {
      return { ok: false, mode: "ast-grep", engine: "ast-cli", notes: r.notes ?? "CLI rewrite failed" };
    }
    const result = r.payload!;
    if (result.timedOut) {
      return { ok: false, mode: "ast-grep", engine: "ast-cli", notes: `[ast-grep rewrite] timed out after ${Math.round(timeoutMs / 1000)}s` };
    }
    if (result.spawnError) {
      return { ok: false, mode: "ast-grep", engine: "ast-cli", notes: `[ast-grep rewrite] ${result.spawnError}` };
    }

    return {
      ok: true,
      mode: "ast-grep",
      engine: "ast-cli",
      payload: `ast-grep rewrite applied (apply=true).\n${result.stdout.trim() || "(no output — check files for changes)"}`,
    };
  }

  // Dry-run: collect match+replacement pairs from --json=stream
  const rwCmd = [bin, "run", "--pattern", pattern, "--rewrite", rewrite, "--json=stream"];
  if (cliLang) rwCmd.push("--lang", cliLang);
  for (const ex of CLI_EXCLUDES) rwCmd.push("--globs", ex);
  rwCmd.push(searchPath);

  const r = await runBounded(rwCmd, { timeoutMs });
  if (!r.ok) {
    return { ok: false, mode: "ast-grep", engine: "ast-cli", notes: r.notes ?? "CLI rewrite preview failed" };
  }
  const result = r.payload!;
  if (result.timedOut) {
    return { ok: false, mode: "ast-grep", engine: "ast-cli", notes: `[ast-grep rewrite] timed out after ${Math.round(timeoutMs / 1000)}s` };
  }
  if (result.spawnError) {
    return { ok: false, mode: "ast-grep", engine: "ast-cli", notes: `[ast-grep rewrite] ${result.spawnError}` };
  }

  const previews: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t) as {
        file?: string;
        range?: { start?: { line?: number } };
        text?: string;
        replacement?: string;
      };
      if (m.file) {
        const ln = (m.range?.start?.line ?? 0) + 1;
        previews.push(
          `${m.file}:${ln}\n  original:    ${(m.text ?? "").slice(0, 120)}\n  replacement: ${(m.replacement ?? "").slice(0, 120)}`,
        );
      }
    } catch {
      /* non-JSON banner line */
    }
    if (previews.length >= max) break;
  }

  if (previews.length === 0) {
    return {
      ok: true,
      mode: "ast-grep",
      engine: "ast-cli",
      payload: `No matches for rewrite pattern: ${pattern}`,
    };
  }

  const truncNote = previews.length >= max ? ` (truncated to ${max})` : "";
  return {
    ok: true,
    mode: "ast-grep",
    engine: "ast-cli",
    payload: `ast-grep rewrite preview (apply=false, ${previews.length} match${previews.length === 1 ? "" : "es"}${truncNote}):\n\n${previews.join("\n\n")}`,
  };
}

// ── Ripgrep floor ──────────────────────────────────────────────────────────────

async function runRipgrep(
  pattern: string,
  searchPath: string,
  max: number,
  timeoutMs: number,
): Promise<NavEnvelope> {
  if (!(await which("rg"))) {
    return {
      ok: false,
      mode: "ast-grep",
      engine: "ripgrep",
      notes: "none of ast-grep, sg, or rg are installed. Run the install script, or fall back to built-in grep.",
    };
  }

  const cmd = ["rg", "--line-number", "--no-heading", "--max-count", String(max), pattern, searchPath];
  const r = await runBounded(cmd, { timeoutMs });
  if (!r.ok) {
    return { ok: false, mode: "ast-grep", engine: "ripgrep", notes: r.notes ?? "ripgrep failed" };
  }
  const result = r.payload!;
  if (result.timedOut) {
    return { ok: false, mode: "ast-grep", engine: "ripgrep", notes: `[ast-grep->rg degraded] timed out after ${Math.round(timeoutMs / 1000)}s` };
  }

  const out = result.stdout.trim();
  const header = "[degraded: ast-grep/sg not found, used ripgrep TEXT match — not structural]\n";
  return {
    ok: true,
    mode: "ast-grep",
    engine: "ripgrep",
    payload: out ? header + tail(out, max) : header + `No text matches for: ${pattern}`,
  };
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Structural AST search + rewrite tool.
 *
 * Engine routing (DA-N2):
 *   - ts/tsx/js/jsx → @ast-grep/napi (findInFiles) → CLI sg → ripgrep
 *   - py/rs/go      → napi (if @ast-grep/lang-* loaded) → CLI sg → ripgrep
 *   - all others    → CLI sg → ripgrep
 *
 * @returns NavEnvelope with payload containing match results or rewrite output.
 */
export async function astGrepTool(args: AstGrepArgs): Promise<NavEnvelope> {
  // ── Input validation ─────────────────────────────────────────────────
  const pattern = (args.pattern ?? "").trim();
  if (!pattern) {
    return {
      ok: false,
      mode: "ast-grep",
      engine: "none",
      notes: "pattern is required",
    };
  }

  // ── .env plane guard ──────────────────────────────────────────────────
  if (isSecretPath(args.path)) {
    return {
      ok: false,
      mode: "ast-grep",
      engine: "none",
      notes: "[ast-grep REFUSED] refusing to search .env files — secrets must not pass through tool output.",
    };
  }

  // ── Resolve path ──────────────────────────────────────────────────────
  const searchPath = (args.path ?? ".").trim() || ".";
  const absPath = resolve(searchPath);

  // ── Language resolution ───────────────────────────────────────────────
  const rawLang = (args.lang ?? "").trim().toLowerCase() || undefined;
  const cliLang = rawLang ? (CLI_LANG_MAP[rawLang] ?? rawLang) : undefined;

  // Timeout bounds
  const timeoutSec = Number.isFinite(args.timeout) ? args.timeout! : 45;
  const timeoutMs = timeoutSec * 1000;

  // Max bounds
  const max = Math.min(Math.max(args.max ?? 50, 1), 200);

  // ── Engine routing ────────────────────────────────────────────────────
  const canUseNapi = rawLang ? await napiAvailableFor(rawLang) : false;

  // ── Rewrite mode ──────────────────────────────────────────────────────
  if (args.rewrite !== undefined) {
    if (args.rewrite === "") {
      return {
        ok: false,
        mode: "ast-grep",
        engine: "none",
        notes: "refused: empty rewrite string would delete all matches",
      };
    }

    // Try napi apply first for napi-capable langs
    if (canUseNapi && args.apply) {
      const napiResult = await tryNapiApply(
        pattern,
        args.rewrite,
        absPath,
        rawLang!,
        max,
      );

      if (napiResult) {
        return {
          ok: true,
          mode: "ast-grep",
          engine: "ast-napi",
          payload: `ast-grep rewrite applied (apply=true) via napi. Files changed: ${napiResult.filesChanged}, total edits: ${napiResult.totalEdits}.`,
          files_changed: napiResult.filesChanged,
          total_edits: napiResult.totalEdits,
          notes: "[destructive] files were modified in place",
        };
      }
      // napi apply returned null — degrade to CLI
    }

    // CLI rewrite (handles both apply and preview)
    return await runCliRewrite(pattern, args.rewrite, absPath, cliLang, max, timeoutMs, args.apply ?? false);
  }

  // ── Search mode ───────────────────────────────────────────────────────

  // Try napi search first for napi-capable langs
  if (canUseNapi) {
    const napiResult = await tryNapiSearch(pattern, absPath, rawLang!, max);

    if (napiResult) {
      const { matches } = napiResult;
      if (matches.length === 0) {
        return {
          ok: true,
          mode: "ast-grep",
          engine: "ast-napi",
          payload: `No structural matches for: ${pattern}`,
        };
      }

      const matchLines = matches.map((m) => `${m.file}:${m.line}`);
      const truncNote = matches.length >= max ? ` (truncated to ${max})` : "";
      return {
        ok: true,
        mode: "ast-grep",
        engine: "ast-napi",
        payload: `ast-grep (ast-napi) — ${matches.length} match(es)${truncNote}:\n` + matchLines.join("\n"),
      };
    }
    // napi returned null — degrade to CLI
  }

  // CLI search
  const cliResult = await runCliSearch(pattern, absPath, cliLang, max, timeoutMs);

  // Check if runCliSearch returned a NavEnvelope (error)
  if ("ok" in cliResult && "notes" in cliResult) {
    // Propagation of error envelope — ripgrep fallback
    const rgResult = await runRipgrep(pattern, absPath, max, timeoutMs);
    return rgResult;
  }

  // Normal CLI result
  const { matches, stderr } = cliResult;

  if (matches.length === 0) {
    const why = stderr.trim() ? `\n${tail(stderr, 8)}` : "";
    // Try ripgrep as final floor
    const rgResult = await runRipgrep(pattern, absPath, max, timeoutMs);
    return rgResult;
  }

  return {
    ok: true,
    mode: "ast-grep",
    engine: "ast-cli",
    payload: `ast-grep (ast-cli) — ${matches.length} match(es):\n` + matches.join("\n"),
  };
}
