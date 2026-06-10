/**
 * Shared timeout + bounded-subprocess helper for forge-mcp custom tools.
 *
 * WHY THIS EXISTS: OpenCode wraps a custom tool's execute() in
 * Effect.promise() with NO host timeout. A hung subprocess (watch mode, a
 * test that never exits, a REPL, a slow structural search) freezes the WHOLE
 * session. NAV solved this internally; ast-grep / git-view / test-run are
 * custom tools too and need the same treatment. This module is that treatment.
 *
 * PLACEMENT: this file is in lib/, NOT tools/. The OpenCode tool scanner walks
 * tools/ and would grab a tools/_shared/ helper as a phantom tool (a bug the
 * prior toolchain hit). Keeping shared code one level up avoids that entirely.
 *
 * NO SYNC I/O anywhere. Everything is async + race-bounded.
 *
 * R7 AMENDMENTS:
 * - Concurrent stdout/stderr consumption (never await exited first — deadlocks
 *   on full pipe buffers on Windows).
 * - Combined output cap (children.outputCapBytes, default 10 MB) → kill child,
 *   set truncated:true.
 * - AbortSignal (opts.signal) → immediate kill of child.
 * - Module-level semaphore (async-mutex) for children.concurrency (default 8),
 *   FIFO queue.
 * - F1 gate: cmd.exe shim path + any argument matching /[&|<>^%"]/ → refuse
 *   cleanly, never execute.
 */

import { Semaphore } from "async-mutex";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated?: boolean;
  spawnError?: string;
}

/** NavEnvelope-compatible return shape. Every public function uses this. */
export interface NavEnvelope<T = unknown> {
  ok: boolean;
  payload?: T;
  truncated?: boolean;
  notes?: string;
  engine?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const HARD_CEILING_MS = 120_000;
const DEFAULT_OUTPUT_CAP = 10 * 1024 * 1024; // 10 MB
const DEFAULT_CONCURRENCY = 8;

/** F1 gate: shell metacharacters that are dangerous in cmd.exe context. */
const CMD_SHIM_METACHAR_RE = /[&|<>^%"]/;

// ── Module-level semaphore (R7) ────────────────────────────────────────────────

let childSemaphore = new Semaphore(DEFAULT_CONCURRENCY);

/**
 * Reconfigure the concurrency semaphore after loading forge.json.
 * Safe to call multiple times; only the latest value takes effect.
 */
export function configureConcurrency(concurrency: number): void {
  const safe =
    typeof concurrency === "number" &&
    Number.isFinite(concurrency) &&
    concurrency > 0
      ? Math.floor(concurrency)
      : DEFAULT_CONCURRENCY;
  childSemaphore = new Semaphore(safe);
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/** Shared mutable state for output-cap enforcement across stream readers. */
interface OutputCapState {
  combinedBytes: number;
  truncated: boolean;
  cap: number;
  kill: () => void;
}

/**
 * Read a ReadableStream into a string, enforcing a shared output cap.
 * When the combined byte total exceeds the cap, sets truncated=true and
 * kills the child process so both readers unwind promptly.
 */
async function readStreamCapped(
  stream: ReadableStream<Uint8Array> | null,
  state: OutputCapState,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      if (state.truncated) break; // sibling reader already exceeded cap
      const { done, value } = await reader.read();
      if (done) break;
      state.combinedBytes += value.byteLength;
      if (state.combinedBytes > state.cap) {
        state.truncated = true;
        state.kill(); // R7: kill child immediately on cap breach
        break;
      }
      chunks.push(value);
    }
  } catch {
    // Stream cancelled/closed after kill — swallow (never-throw contract)
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  // Decode accumulated chunks into a single string
  let totalLen = 0;
  for (const c of chunks) totalLen += c.byteLength;
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(combined);
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Spawn a process with array-argv (NO shell — so $-metavariables, globs and
 * quotes are never mangled; this is the same fix that unbroke ast-grep).
 * Races the process against a deadline; kills it and returns a degraded
 * result on timeout instead of throwing or hanging.
 *
 * R7: stdout+stderr consumed CONCURRENTLY; combined output capped;
 *     module semaphore limits concurrency; AbortSignal → immediate kill.
 */
export async function runBounded(
  cmd: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
    outputCapBytes?: number;
  } = {},
): Promise<NavEnvelope<RunResult>> {
  try {
    // ── Guard: empty cmd ─────────────────────────────────────────────────
    if (!cmd || cmd.length === 0) {
      return {
        ok: false,
        notes: "runBounded: cmd array is empty",
        payload: {
          code: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          spawnError: "empty cmd",
        },
      };
    }

    // ── NaN-hardened bounds ──────────────────────────────────────────────
    const requested = opts.timeoutMs;
    const base =
      typeof requested === "number" && Number.isFinite(requested)
        ? requested
        : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(base, 1_000), HARD_CEILING_MS);
    const outputCap =
      typeof opts.outputCapBytes === "number" &&
      Number.isFinite(opts.outputCapBytes) &&
      opts.outputCapBytes > 0
        ? opts.outputCapBytes
        : DEFAULT_OUTPUT_CAP;

    // ── Win32 shim resolution ────────────────────────────────────────────
    let argv = cmd;
    if (process.platform === "win32" && cmd.length > 0) {
      const resolved = Bun.which(cmd[0]) ?? cmd[0];
      if (/\.(cmd|bat)$/i.test(resolved)) {
        // F1 gate: refuse shell metacharacters in cmd.exe context
        for (const arg of cmd.slice(1)) {
          if (CMD_SHIM_METACHAR_RE.test(arg)) {
            return {
              ok: false,
              notes: `F1 gate: refusing cmd.exe shim — argument contains shell metacharacters: ${arg}`,
              payload: {
                code: null,
                stdout: "",
                stderr: "",
                timedOut: false,
                spawnError: `F1 gate: metachar in arg: ${arg}`,
              },
            };
          }
        }
        // Batch shim: hand cmd.exe the BARE command name, NOT the resolved
        // path. cmd.exe honors PATHEXT itself, and a bare name has no spaces.
        // Passing the resolved path unquoted (e.g. "C:\Program Files\nodejs\
        // npm.cmd") makes cmd.exe parse "C:\Program" as the command.
        argv = ["cmd.exe", "/d", "/s", "/c", cmd[0], ...cmd.slice(1)];
      } else {
        // Real .exe: spawn directly. CreateProcessW handles a spaced exe path
        // fine, and ast-grep's $-metavariable patterns are never shell-mangled.
        argv = [resolved, ...cmd.slice(1)];
      }
    }

    // ── Acquire semaphore slot (FIFO queue, R7) ──────────────────────────
    const release = await childSemaphore.acquire();

    let proc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      proc = Bun.spawn({
        cmd: argv,
        cwd: opts.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      });
    } catch (e) {
      release();
      return {
        ok: false,
        notes: `spawn failed: ${String(e)}`,
        payload: {
          code: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          spawnError: String(e),
        },
      };
    }

    const child = proc;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    // R7: output cap state — shared between concurrent stdout/stderr readers
    const capState: OutputCapState = {
      combinedBytes: 0,
      truncated: false,
      cap: outputCap,
      kill: () => {
        try {
          child.kill();
        } catch {
          /* already dead */
        }
      },
    };

    const killWith = (reason: "timeout" | "abort") => {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      return reason;
    };

    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve(killWith("timeout")), timeoutMs);
    });

    const aborted = new Promise<"abort">((resolve) => {
      if (!opts.signal) return; // never resolves → never wins the race
      if (opts.signal.aborted) return resolve(killWith("abort"));
      onAbort = () => resolve(killWith("abort"));
      opts.signal.addEventListener("abort", onAbort, { once: true });
    });

    // R7: Consume stdout+stderr CONCURRENTLY — never await exited first.
    // Awaiting exited before reading pipes deadlocks on full pipe buffers
    // on Windows (the child blocks on write, the parent blocks on exit).
    const stdoutP = readStreamCapped(child.stdout, capState);
    const stderrP = readStreamCapped(child.stderr, capState);

    try {
      const outcome = await Promise.race([
        child.exited.then((code) => ({ code })),
        deadline,
        aborted,
      ]);

      // Wait for stream reads to finish (they return quickly after kill)
      const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);

      if (outcome === "timeout") {
        return {
          ok: true,
          truncated: capState.truncated,
          payload: {
            code: null,
            stdout,
            stderr,
            timedOut: true,
            truncated: capState.truncated,
          },
        };
      }
      if (outcome === "abort") {
        return {
          ok: true,
          truncated: capState.truncated,
          notes: "aborted",
          payload: {
            code: null,
            stdout,
            stderr,
            timedOut: false,
            truncated: capState.truncated,
            spawnError: "aborted",
          },
        };
      }
      return {
        ok: true,
        truncated: capState.truncated,
        payload: {
          code: (outcome as { code: number }).code,
          stdout,
          stderr,
          timedOut: false,
          truncated: capState.truncated,
        },
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (opts.signal && onAbort)
        opts.signal.removeEventListener("abort", onAbort);
      release();
    }
  } catch (e) {
    // Never-throw contract — every error becomes an ok:false envelope
    return {
      ok: false,
      notes: `unexpected error: ${String(e)}`,
      payload: {
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: String(e),
      },
    };
  }
}

// ── Utility exports ────────────────────────────────────────────────────────────

/** Keep only the last N lines of a blob — failures-only output stays cheap. */
export function tail(text: string, lines = 40): string {
  const arr = text.replace(/\s+$/, "").split("\n");
  return arr.length <= lines ? arr.join("\n") : arr.slice(-lines).join("\n");
}

/**
 * Resolve the cwd OpenCode hands a custom tool. (BUG-1)
 *
 * OpenCode passes context = { directory, worktree, ... }. Empirically:
 *   - `directory` = the project root in ALL cases (correct).
 *   - `worktree`  = git root for git repos, but "/" (fs root) for NON-git
 *                   folders, and the git root (NOT the package dir) inside a
 *                   monorepo subdir. "/" is truthy, so a `worktree ?? directory`
 *                   order wrongly picks it → detect("/") finds no markers.
 * So `directory` MUST come first.
 */
export function resolveCwd(context: unknown): string {
  const c = (context ?? {}) as { directory?: string; worktree?: string };
  return c.directory ?? c.worktree ?? process.cwd();
}

/**
 * Walk UP from `start` to the nearest ancestor containing any marker file.
 * Fixes monorepo subdirs and nested invocations (detecting at the exact cwd
 * misses a root one level up). Returns null if no marker exists up to fs root.
 */
export function findProjectRoot(start: string, markers: string[]): string | null {
  let dir = start;
  for (;;) {
    if (markers.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/**
 * True when a tool's stderr looks like a Rust/ty/native crash, not a normal
 * "I found type errors" exit. Used to decide ty → mypy fallback.
 */
export function looksLikePanic(stderr: string, code: number | null): boolean {
  if (code === 101) return true; // Rust panic exit code
  return /panicked|RUST_BACKTRACE|internal error|fatal runtime|SIGSEGV|abort\b/i.test(
    stderr,
  );
}
