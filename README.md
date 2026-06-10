# forge-mcp

**A production-grade, LLM-agnostic local development engine over the Model Context Protocol.**
One resident daemon. Any MCP client. Shared warm language servers, structural code intelligence, fingerprint caching, event-driven invalidation, and a self-healing supervisor — built so an AI coding agent gets compiler-grade answers without burning context, crashing tools, or leaking memory.

> WIP personal tool. Successor to my `nav-mcp`; runs in parallel during migration. Design hardened across five iterations of research + devil's-advocate review against 2025–2026 MCP spec revisions, SDK issue history, and field-reported failure classes.

---

## What it is

A single long-lived **daemon** on `127.0.0.1` speaking **MCP Streamable HTTP**, plus a tiny **stdio proxy** any MCP host launches as a "local server." The proxy auto-starts the daemon, authenticates with a per-boot bearer token, and bridges stdio ↔ HTTP. Result: OpenCode, Claude Desktop, Claude Code, Cursor — all sharing **one** engine: one set of warm LSP processes per *(project root, language)*, one cache, one security policy.

```
OpenCode ──stdio──┐
Claude Desktop ───┤── stdio-proxy ──HTTP+token──▶ forge-mcp daemon (127.0.0.1)
Cursor ──http─────┘     (auto-starts daemon,        ├─ dispatch core (15 modes)
                         embedded fallback)          ├─ warm LSP pool, (root,lang)-keyed
                                                     ├─ supervisor (restart → circuit-break)
                                                     ├─ fingerprint cache (LRU+TTL, 64MB)
                                                     ├─ native fs-watcher invalidation
                                                     └─ 6 flat tools
```

## Why

AI coding agents fail in three repeatable ways: **blind text I/O** (re-reading whole files, grepping names, no type-level truth), **fragile tooling** (a crashed language server becomes an error-retry loop), and **duplicated heavyweight state** (every host spawning its own 300–700 MB `tsserver`). forge-mcp answers each: real LSP (definitions, references, diagnostics, semantic rename) with an AST/structural layer on top; a **never-throw** contract where every failure degrades down a fidelity ladder (LSP → tree-sitter → ctags → regex) inside a structured envelope while a supervisor restarts crashed servers; and one shared warm server per project+language across all clients.

## Tool surface

| Tool | Modes / behavior | Safety |
|---|---|---|
| `read` | tree · outline · symbols · read · peek · search · glob · def · refs · hover · diagnostics · wsymbol | read-only |
| `edit` | edit · write · rename · action — fingerprint stale-guard, per-path mutex, all-or-nothing workspace edits | destructive, guarded |
| `ast_grep` | structural search/rewrite — in-process `@ast-grep/napi` for TS/JS, CLI for other langs, ripgrep floor; `apply=true` gates mutation and writes only through the guarded writer | dry-run default |
| `git_view` | read-only git inspection; mutating subcommands refused with hints | read-only |
| `test_run` | check · fix · last-failed; cancellation-aware; failures-only output | fix = mutating |
| `dep_audit` | lockfile-driven CVE scan; offline-safe; declares network calls | read-only, networked |

Every response is a **NavEnvelope** — `ok`, `engine` (which fidelity rung answered), notes, pagination anchors, fingerprints — with `cache`/`recovery` fields emitted *only when something noteworthy happened* (token-lean by design).

## Core guarantees

- **Never-throw** — the transport never sees an exception; agents always get a usable, attributed answer or a clean refusal.
- **Self-healing** — restart budget (3/5 min, exponential backoff) → circuit-breaker → fallback chain → half-open recovery. Daemon itself is crash-only: all state reconstructible; a daemon crash costs each client at most one failed call.
- **Memory-bounded by construction** — byte-accounted LRU cache (64 MB, 2 MB/entry, strict TTLs, errors never cached), LSP pool LRU + idle reap, refcounted didOpen/didClose, session sweep triad, child-process registry with kill-sweeps, capped child heaps. Validated by a <15 % RSS soak gate.
- **Fresh by events, correct by fingerprints** — a native filesystem watcher evicts caches within ~100 ms of external edits, but correctness never depends on it: mtime-keyed fingerprints remain the authority, and the watcher degrades to stat-based invalidation if it dies.
- **Concurrency-correct** — shared LSP processes with session-scoped views; diagnostics fan out to all waiters; cross-client writes serialized by per-path mutex *and* rejected on stale fingerprints.
- **Windows-correct** — cmd-shim command-injection gate, EPERM/EBUSY rename backoff (Defender locks), pipe-backpressure draining, detached daemon spawn done right.
- **Secure by default** — `127.0.0.1` bind, per-boot bearer token (stored only in `%LOCALAPPDATA%`, never in the repo), Origin validation/DNS-rebinding 403, canonical+symlink-resolved path jail, `.env*` guard, per-client tool profiles, exact-pinned deps.

## Layout

Code lives in this repo. Runtime state (`daemon.json` + token, `boot.lock`, `logs/`) lives in `%LOCALAPPDATA%\forge-mcp\` — by construction, secrets can't be committed. `forge.example.json` documents config; the live `forge.json` is gitignored.

## Status

Pre-implementation: design docs + `reference_files/` (nav-mcp port source) only. Build proceeds through gated milestones **M0–M7** defined in [`implementation_plan.md`](implementation_plan.md) — each with verify gates, fallback behavior, and rollback. Agents working in this repo: read [`AGENTS.md`](AGENTS.md) first.

| Doc | Purpose |
|---|---|
| `implementation_plan.md` | Source of truth: M0–M7 with run/verify/on_fail |
| `AGENTS.md` | Constraints, port gotchas, envelope contract, flags |
| `RUNBOOK.md` | Ops & recovery (lands at M7) |
| `test/` | Permanent `bun test` regression suite (lands progressively) |
