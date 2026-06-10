import { runBounded, tail } from "../lib/withTimeout";
import type { NavEnvelope } from "../lib/withTimeout";

/**
 * git-view — READ-ONLY git/gh inspector. It can never mutate the repo: only
 * an allowlist of inspection verbs is permitted, everything else is refused
 * (fail-safe). Missing-arg is guarded so it can't TypeError.
 *
 * M6 adaptation: exported function returning NavEnvelope instead of
 * opencode-ai/plugin tool() wrapper.
 */

// Read-only git subcommands only. Anything not here is refused.
const GIT_READ = new Set([
  "status", "log", "diff", "show", "branch", "remote", "config",
  "stash", "blame", "shortlog", "describe", "tag", "reflog", "ls-files", "rev-parse",
]);

// Hard-deny tokens — if they appear anywhere in the extra args, refuse.
const MUTATORS = /\b(push|commit|merge|rebase|reset|checkout|switch|restore|clean|rm|mv|add|apply|cherry-pick|revert|fetch|pull|clone|init|gc|prune|stash\s+(pop|apply|drop|clear)|tag\s+-d|branch\s+-[dD]|config\s+--(global|system|local)\s+\S+\s+\S)/i;

// Refused mutating subcommands — user-facing hint list
const REFUSED_HINTS: Record<string, string> = {
  commit: "Use a git client or run `git commit` directly.",
  push: "Use a git client or run `git push` directly.",
  merge: "Use a git client or run `git merge` directly.",
  rebase: "Use a git client or run `git rebase` directly.",
  reset: "Use a git client or run `git reset` directly.",
  checkout: "Use a git client or run `git checkout` directly.",
  switch: "Use a git client or run `git switch` directly.",
  restore: "Use a git client or run `git restore` directly.",
  clean: "Use a git client or run `git clean` directly.",
  rm: "Use a git client or run `git rm` directly.",
  mv: "Use a git client or run `git mv` directly.",
  add: "Use a git client or run `git add` directly.",
  apply: "Use a git client or run `git apply` directly.",
  "cherry-pick": "Use a git client or run `git cherry-pick` directly.",
  revert: "Use a git client or run `git revert` directly.",
  fetch: "Use a git client or run `git fetch` directly.",
  pull: "Use a git client or run `git pull` directly.",
  clone: "Use a git client or run `git clone` directly.",
  init: "Use a git client or run `git init` directly.",
  gc: "Use a git client or run `git gc` directly.",
  prune: "Use a git client or run `git prune` directly.",
};

export interface GitViewArgs {
  subcommand: string;
  args?: string;
  gh?: boolean;
  workdir?: string;
  timeout?: number;
}

/**
 * Read-only git/gh inspector. Returns a NavEnvelope with the command output.
 *
 * @param args.subcommand - A read-only git verb (status, log, diff, branch, etc.)
 * @param args.args       - Extra arguments, e.g. '--oneline -10' or 'HEAD~1'
 * @param args.gh         - Route to `gh` CLI instead of git
 * @param args.workdir    - Working directory (project root)
 * @param args.timeout    - Seconds before degrading (1-60, default 30)
 */
export async function gitViewTool(args: GitViewArgs): Promise<NavEnvelope> {
  const root = args.workdir ?? process.cwd();

  const sub = (args.subcommand ?? "").trim();
  const extra = (args.args ?? "").trim();

  if (!sub) {
    return {
      ok: false,
      mode: "git-view",
      engine: "git",
      notes: "[git-view] no subcommand given. Try: status, log --oneline -10, diff, branch -a.",
    };
  }

  // ── .env plane guard ────────────────────────────────────────────────────
  if (/\.env(\.|$)/i.test(extra)) {
    return {
      ok: false,
      mode: "git-view",
      engine: "git",
      notes: "[git-view REFUSED] refusing to read .env files — secrets must not pass through tool output.",
    };
  }

  // ── Mutator detection ──────────────────────────────────────────────────
  if (MUTATORS.test(`${sub} ${extra}`)) {
    const hint = REFUSED_HINTS[sub.toLowerCase()] ?? "Run mutations directly or via a builder agent with explicit approval.";
    return {
      ok: false,
      mode: "git-view",
      engine: "git",
      notes: `[git-view REFUSED] '${sub} ${extra}'.trim() looks mutating. git-view is read-only by design — ${hint}`,
    };
  }

  // Tokenize extra args without a shell (no metavar mangling).
  const extraTokens = extra.length ? extra.split(/\s+/) : [];

  let cmd: string[];
  if (args.gh) {
    // gh: allow only obviously read-only verbs.
    const ghVerb = sub.toLowerCase();
    const GH_READ = new Set(["pr", "issue", "repo", "run", "release", "status", "api"]);
    if (!GH_READ.has(ghVerb)) {
      return {
        ok: false,
        mode: "git-view",
        engine: "git",
        notes: `[git-view REFUSED] gh '${ghVerb}' not in the read-only allowlist (pr/issue/repo/run/release/status/api).`,
      };
    }
    // Block gh api writes.
    if (ghVerb === "api" && /-X\s*(POST|PUT|PATCH|DELETE)|--method\s*(POST|PUT|PATCH|DELETE)/i.test(extra)) {
      return {
        ok: false,
        mode: "git-view",
        engine: "git",
        notes: "[git-view REFUSED] gh api with a write method is not allowed.",
      };
    }
    cmd = ["gh", ghVerb, ...extraTokens];
  } else {
    if (!GIT_READ.has(sub)) {
      return {
        ok: false,
        mode: "git-view",
        engine: "git",
        notes: `[git-view REFUSED] '${sub}' is not in the read-only git allowlist. Allowed: ${[...GIT_READ].join(", ")}.`,
      };
    }
    cmd = ["git", sub, ...extraTokens];
  }

  const r = await runBounded(cmd, { cwd: root, timeoutMs: (args.timeout ?? 30) * 1000 });

  if (!r.ok) {
    return {
      ok: false,
      mode: "git-view",
      engine: "git",
      notes: r.notes ?? `[git-view] runBounded failed for '${cmd.join(" ")}'`,
    };
  }

  const result = r.payload!;
  if (result.timedOut) {
    return {
      ok: false,
      mode: "git-view",
      engine: "git",
      notes: `[git-view degraded] '${cmd.join(" ")}' timed out after ${args.timeout ?? 30}s.`,
    };
  }
  if (result.spawnError) {
    return {
      ok: false,
      mode: "git-view",
      engine: "git",
      notes: `[git-view degraded] ${result.spawnError}`,
    };
  }

  const out = (result.stdout || result.stderr).trim();
  if (!out) {
    return {
      ok: true,
      mode: "git-view",
      engine: "git",
      payload: `(${cmd.join(" ")}) produced no output.`,
    };
  }

  return {
    ok: true,
    mode: "git-view",
    engine: "git",
    truncated: result.truncated ?? false,
    payload: tail(out, 200),
  };
}
