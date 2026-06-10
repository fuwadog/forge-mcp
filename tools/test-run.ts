import { runBounded, tail, looksLikePanic, findProjectRoot } from "../lib/withTimeout";
import type { NavEnvelope, RunResult } from "../lib/withTimeout";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * test-run — one adaptive tool for tests + lint + type-checks across stacks.
 * Detects the project by marker files, runs the right toolchain, and returns
 * ONLY failures + a tally (passing-test noise is stripped — that's the live
 * coding token saver). Timeout-bounded per rung (#25360).
 *
 * M6 adaptation: plain function returning NavEnvelope (no @opencode-ai/plugin).
 * Never cached. AbortSignal kills test children on cancel.
 *
 *   mode = "check"       -> tests + lint + types, READ-ONLY
 *   mode = "fix"         -> also format + autofix (MUTATING; includes destructiveHint)
 *   mode = "last-failed" -> re-run only previously-failed tests
 *     - Python: pytest --lf
 *     - Jest:   jest --onlyFailures (native)
 *     - Vitest: falls back to full suite
 *     - Rust/Go: full suite (unsupported)
 *
 * Python types: ty (fast, beta) FIRST; if ty is missing or PANICS (not just
 * "found type errors"), fall back to mypy. ty type-errors are reported as-is.
 */

type Stack = "python" | "node" | "rust" | "go" | "none";

interface Rung {
  name: string;
  cmd: string[];
  mutating?: boolean;
  /** optional: treat nonzero as failure only if this predicate says so */
  fallback?: (r: RunResult) => Rung | null;
}

// Marker files that mark a project root, in the same priority order detect()
// uses (python before node so a pyproject in a JS-tooled repo still wins).
const MARKERS = ["pyproject.toml", "uv.lock", "package.json", "Cargo.toml", "go.mod"];

function detect(cwd: string): Stack {
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "uv.lock"))) return "python";
  if (existsSync(join(cwd, "package.json"))) return "node";
  if (existsSync(join(cwd, "Cargo.toml"))) return "rust";
  if (existsSync(join(cwd, "go.mod"))) return "go";
  return "none";
}

function hasUv(cwd: string): boolean {
  if (existsSync(join(cwd, "uv.lock"))) return true;
  try {
    return /\[tool\.uv\]/.test(readFileSync(join(cwd, "pyproject.toml"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Smart feedback chooser for Node projects: returns the FIRST useful command
 * the project actually supports, so test-run gives signal on ANY repo — not
 * only ones with a `test` script. Chain: test -> lint -> typecheck -> build.
 * (A project with just `"lint": "eslint ."` and no test script now lints
 * instead of dying on "Missing script: test".)
 */
function nodeFeedbackRung(cwd: string): { name: string; cmd: string[] } {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const deps = { ...pkg.devDependencies, ...pkg.dependencies };

    // A real test script (npm's placeholder "Error: no test specified" doesn't count).
    if (scripts.test && !/no test specified/i.test(scripts.test)) return { name: "test", cmd: ["npm", "run", "test", "--silent"] };
    if (deps.vitest) return { name: "vitest", cmd: ["npx", "vitest", "run"] };
    if (deps.jest) return { name: "jest", cmd: ["npx", "jest"] };
    if (scripts.lint) return { name: "lint", cmd: ["npm", "run", "lint", "--silent"] };
    if (scripts.typecheck) return { name: "typecheck", cmd: ["npm", "run", "typecheck", "--silent"] };
    if (deps.typescript || existsSync(join(cwd, "tsconfig.json"))) return { name: "tsc --noEmit", cmd: ["npx", "tsc", "--noEmit"] };
    if (scripts.build) return { name: "build", cmd: ["npm", "run", "build", "--silent"] };
  } catch {
    /* fall through to default */
  }
  return { name: "test", cmd: ["npm", "run", "test", "--silent"] };
}

/** Does this Node project expose the given npm script? (guards mode=fix rungs) */
function hasNodeScript(cwd: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts?.[name]);
  } catch {
    return false;
  }
}

function buildRungs(stack: Stack, cwd: string, fix: boolean): Rung[] {
  const uv = (c: string[]) => (hasUv(cwd) ? ["uv", "run", ...c] : c);

  switch (stack) {
    case "python": {
      const rungs: Rung[] = [];
      if (fix) {
        rungs.push({ name: "ruff format", cmd: uv(["ruff", "format", "."]), mutating: true });
        rungs.push({ name: "ruff check --fix", cmd: uv(["ruff", "check", "--fix", "."]), mutating: true });
      } else {
        rungs.push({ name: "ruff check", cmd: uv(["ruff", "check", "."]) });
      }
      // ty first, mypy as fallback on panic/missing.
      rungs.push({
        name: "ty check",
        cmd: uv(["ty", "check"]),
        fallback: (r) =>
          r.spawnError || looksLikePanic(r.stderr, r.code)
            ? { name: "mypy (fallback: ty crashed/missing)", cmd: uv(["mypy", "."]) }
            : null,
      });
      rungs.push({ name: "pytest", cmd: uv(["pytest", "-q"]) });
      return rungs;
    }
    case "node": {
      const rungs: Rung[] = [];
      // Only run `format` if the project actually defines it (else it'd FAIL on "Missing script").
      if (fix && hasNodeScript(cwd, "format")) rungs.push({ name: "format", cmd: ["npm", "run", "format", "--silent"], mutating: true });
      const fb = nodeFeedbackRung(cwd);
      rungs.push({ name: fb.name, cmd: fb.cmd });
      return rungs;
    }
    case "rust": {
      const rungs: Rung[] = [];
      if (fix) rungs.push({ name: "clippy --fix", cmd: ["cargo", "clippy", "--fix", "--allow-dirty", "--allow-staged"], mutating: true });
      else rungs.push({ name: "clippy", cmd: ["cargo", "clippy", "-q"] });
      rungs.push({ name: "cargo test", cmd: ["cargo", "test", "--quiet"] });
      return rungs;
    }
    case "go": {
      const rungs: Rung[] = [];
      if (fix) rungs.push({ name: "gofmt -w", cmd: ["gofmt", "-w", "."], mutating: true });
      rungs.push({ name: "go vet", cmd: ["go", "vet", "./..."] });
      rungs.push({ name: "go test", cmd: ["go", "test", "./...", "-count=1"] });
      return rungs;
    }
    default:
      return [];
  }
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface TestRunArgs {
  /**
   * "check" = read-only (tests+lint+types).
   * "fix" = also format + autofix (mutating).
   * "last-failed" = re-run only previously-failed tests
   *   (native pytest --lf for Python; jest --onlyFailures for Jest; full suite otherwise).
   */
  mode: "check" | "fix" | "last-failed";
  /** Seconds per rung before degrading (5–120, default 90). */
  timeout?: number;
  /** AbortSignal — kills test children on cancel (M6). */
  signal?: AbortSignal;
  /** Working directory (defaults to process.cwd()). */
  cwd?: string;
}

/**
 * Adaptive test/lint/type runner. Auto-detects the stack (python/node/rust/go) by
 * marker files and returns ONLY failures + a PASS/FAIL tally (passing noise stripped).
 *
 * NEVER cached — every call produces fresh results.
 *
 * @param args - Mode, timeout, abort signal, and working directory.
 * @returns NavEnvelope with payload = text output (failures only + tally).
 *   In fix mode, notes includes "destructiveHint".
 */
export async function testRunTool(args: TestRunArgs): Promise<NavEnvelope> {
  // ── Resolve project root (walk UP from start to nearest marker) ─────────────
  const startDir = args.cwd ?? process.cwd();
  const cwd = findProjectRoot(startDir, MARKERS);
  if (!cwd) {
    return {
      ok: true,
      mode: "test-run",
      engine: "test-run",
      payload: `[test-run] no recognized project at or above '${startDir}' (looked for pyproject.toml/uv.lock, package.json, Cargo.toml, go.mod). Nothing run.`,
    };
  }

  const timeoutSec = Number.isFinite(args.timeout) ? args.timeout! : 90;
  const timeoutMs = timeoutSec * 1000;

  // ── last-failed mode ────────────────────────────────────────────────────────
  if (args.mode === "last-failed") {
    const lf_stack = detect(cwd);

    // Python: native pytest --lf
    if (lf_stack === "python") {
      const r = await runBounded(
        hasUv(cwd) ? ["uv", "run", "pytest", "--lf", "-q", "--tb=short"] : ["pytest", "--lf", "-q", "--tb=short"],
        { cwd, timeoutMs, signal: args.signal },
      );
      if (!r.ok) return { ok: false, mode: "test-run", engine: "test-run", notes: r.notes };
      const rr = r.payload!;
      if (rr.timedOut) return { ok: true, mode: "test-run", engine: "test-run", payload: `[test-run last-failed] pytest --lf timed out after ${timeoutSec}s` };
      if (rr.spawnError) return { ok: true, mode: "test-run", engine: "test-run", payload: `[test-run last-failed] could not run pytest: ${rr.spawnError}` };
      const out = (rr.stdout + "\n" + rr.stderr).trim();
      return { ok: true, mode: "test-run", engine: "test-run", payload: `LAST-FAILED (pytest --lf) mode_used=native-pytest-lf\n${out}` };
    }

    // Node: detect Jest (native --onlyFailures) vs Vitest/custom (full suite)
    if (lf_stack === "node") {
      try {
        const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
          devDependencies?: Record<string, string>;
          dependencies?: Record<string, string>;
        };
        const deps = { ...pkg.devDependencies, ...pkg.dependencies };

        if (deps.jest) {
          // M6: use Jest's native --onlyFailures (no custom stored-state file)
          const r = await runBounded(
            ["npx", "jest", "--onlyFailures", "--passWithNoTests"],
            { cwd, timeoutMs, signal: args.signal },
          );
          if (!r.ok) return { ok: false, mode: "test-run", engine: "test-run", notes: r.notes };
          const rr = r.payload!;
          if (rr.timedOut) return { ok: true, mode: "test-run", engine: "test-run", payload: `[test-run last-failed] jest --onlyFailures timed out after ${timeoutSec}s` };
          const out = (rr.stdout + "\n" + rr.stderr).trim();
          return { ok: true, mode: "test-run", engine: "test-run", payload: `LAST-FAILED (jest --onlyFailures) mode_used=jest-only-failures\n${out}` };
        }
        // Vitest or other test runner: fall through to full suite
      } catch { /* fall through */ }

      // No native last-failed support — run full suite
      const fb = nodeFeedbackRung(cwd);
      const r = await runBounded(fb.cmd, { cwd, timeoutMs, signal: args.signal });
      if (!r.ok) return { ok: false, mode: "test-run", engine: "test-run", notes: r.notes };
      const rr = r.payload!;
      const out = (rr.stdout + "\n" + rr.stderr).trim();
      return { ok: true, mode: "test-run", engine: "test-run", payload: `LAST-FAILED (no native last-failed support for this Node project, ran full suite) mode_used=full-suite\n${out}` };
    }

    // Rust / Go / none: no native last-failed support; run full suite
    const lf_cmd = lf_stack === "rust" ? ["cargo", "test", "--quiet"]
      : lf_stack === "go" ? ["go", "test", "./...", "-count=1"]
      : null;
    if (!lf_cmd) {
      return { ok: true, mode: "test-run", engine: "test-run", payload: "[test-run last-failed] no recognized project (looked for pyproject.toml/uv.lock, package.json, Cargo.toml, go.mod). Nothing run." };
    }
    const r = await runBounded(lf_cmd, { cwd, timeoutMs, signal: args.signal });
    if (!r.ok) return { ok: false, mode: "test-run", engine: "test-run", notes: r.notes };
    const rr = r.payload!;
    const out = (rr.stdout + "\n" + rr.stderr).trim();
    return { ok: true, mode: "test-run", engine: "test-run", payload: `LAST-FAILED (unsupported for ${lf_stack}, ran full suite) mode_used=unsupported-ran-full\n${out}` };
  }

  // ── check / fix mode ────────────────────────────────────────────────────────
  const stack = detect(cwd);
  if (stack === "none") {
    return { ok: true, mode: "test-run", engine: "test-run", payload: "[test-run] no recognized project (looked for pyproject.toml/uv.lock, package.json, Cargo.toml, go.mod). Nothing run." };
  }

  const fix = args.mode === "fix";
  let rungs = buildRungs(stack, cwd, fix);

  const failures: string[] = [];
  let pass = 0;
  let fail = 0;
  const ranNames: string[] = [];

  for (let i = 0; i < rungs.length; i++) {
    const rung = rungs[i];
    const r = await runBounded(rung.cmd, { cwd, timeoutMs, signal: args.signal });

    // If runBounded itself failed (ok:false), treat as a failed rung
    if (!r.ok) {
      fail++;
      failures.push(`### ${rung.name} — internal error (${r.notes ?? "runBounded returned ok:false"})`);
      continue;
    }
    const rr = r.payload!;

    // ty -> mypy style fallback: swap this rung for its fallback and re-run.
    if (rung.fallback) {
      const fb = rung.fallback(rr);
      if (fb) {
        rungs.splice(i + 1, 0, fb);
        ranNames.push(`${rung.name} (skipped: crashed/missing -> fallback)`);
        continue;
      }
    }

    ranNames.push(rung.name);

    if (rr.timedOut) {
      fail++;
      failures.push(`### ${rung.name} — TIMED OUT after ${timeoutSec}s\n${tail(rr.stderr || rr.stdout, 20)}`);
      continue;
    }
    if (rr.spawnError) {
      fail++;
      failures.push(`### ${rung.name} — could not run (${rr.spawnError}). Is the tool installed?`);
      continue;
    }
    if (rr.code === 0) {
      pass++;
    } else {
      fail++;
      const blob = (rr.stdout + "\n" + rr.stderr).trim();
      failures.push(`### ${rung.name} — FAILED (exit ${rr.code})\n${tail(blob, 40)}`);
    }
  }

  const tally = `PASS ${pass}  FAIL ${fail}   [stack: ${stack}, mode: ${args.mode}, rungs: ${ranNames.join(" -> ")}]`;

  // Build envelope: output only failures + tally
  const result: NavEnvelope = {
    ok: true,
    mode: "test-run",
    engine: "test-run",
    payload: fail === 0
      ? `All ${pass} rung(s) passed.\n${tally}`
      : `${failures.join("\n\n")}\n\n${tally}`,
  };

  // M6: destructiveHint annotation for fix mode (informs the agent about mutation)
  if (fix) {
    result.notes = "destructiveHint: fix mode is destructive — it formats and autofixes code in place.";
  }

  return result;
}
