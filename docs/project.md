# forge-mcp

**A production-grade, LLM-agnostic local development engine over the Model Context Protocol.**
One resident daemon. Any MCP client. Shared warm language servers, structural code intelligence, fingerprint caching, and a self-healing supervisor — built so an AI coding agent gets compiler-grade answers without burning context, crashing tools, or leaking memory.

> Successor to `nav-mcp`. Runs in parallel during migration; nav-mcp remains untouched until cutover.

---

## What is it?

forge-mcp is a single long-lived **daemon** on `127.0.0.1` speaking **MCP Streamable HTTP**, plus a tiny **stdio proxy** that any MCP host launches as a "local server." The proxy auto-starts the daemon, authenticates with a boot-random bearer token, and bridges stdio ↔ HTTP. The result: OpenCode, Claude Desktop, Claude Code, Cursor, and any other MCP-compliant client share **one** engine — one set of warm LSP processes, one cache, one security policy.

```
OpenCode ──stdio──┐
Claude Desktop ───┤── stdio-proxy ──HTTP+token──▶ forge-mcp daemon (127.0.0.1)
Cursor ──http─────┘        │                        ├─ dispatch core (15 modes)
                    (auto-starts daemon,            ├─ warm LSP pool, (root,lang)-keyed
                     embedded fallback)             ├─ supervisor (restart/circuit-break)
                                                    ├─ fingerprint cache (LRU+TTL, 64MB)
                                                    └─ 6 flat tools
```

## Why does it exist?

AI coding agents waste tokens, time, and trust on three failure classes:

1. **Blind file I/O** — agents re-read whole files, grep without structure, and miss type-level truth. forge-mcp gives them paginated reads, outlines, AST search, and real LSP answers (definitions, references, diagnostics, rename, code actions).
2. **Fragile tooling** — a crashed language server or a missing binary normally surfaces as a raw error the agent retries in a loop. forge-mcp **never throws**: every failure degrades down a fidelity ladder (LSP → tree-sitter → ctags → regex → clean refusal) inside a structured envelope, and a supervisor restarts crashed servers behind the scenes.
3. **Duplicated heavyweight state** — every editor/agent spawning its own `tsserver` costs 300–700 MB each. forge-mcp shares one warm server per *(project root, language)* across all connected clients.

## Tool surface (6 flat tools)

| Tool | Modes / behavior | Safety |
|---|---|---|
| `read` | tree · outline · symbols · read · peek · search · glob · def · refs · hover · diagnostics · wsymbol | read-only |
| `edit` | edit · write · rename · action — fingerprint stale-guard (`expect`), per-path mutex, all-or-nothing workspace edits | destructive, guarded |
| `ast_grep` | structural search/rewrite; `apply=true` gates mutation; loud degradation if `sg` missing | dry-run default |
| `git_view` | read-only git inspection; mutating subcommands refused with hints | read-only |
| `test_run` | check · fix · last-failed (Jest `--onlyFailures`); cancellation-aware | fix = mutating |
| `dep_audit` | lockfile-driven CVE scan; offline-safe; declares its network calls | read-only, networked |

Every response is a **NavEnvelope**: `ok`, `engine` (which fidelity rung answered), `notes`, pagination anchors, fingerprints — plus `cache`/`recovery` fields *only when something noteworthy happened* (token-lean by design).

## Core guarantees

- **Never-throw contract** — transport never sees an exception; the agent always gets a usable, attributed answer or a clean refusal.
- **Self-healing** — per-server restart budget (3 / 5 min, exponential backoff) → circuit-breaker → fallback chain → half-open recovery probe. In-flight requests fail soft, not loud.
- **Crash-only daemon** — all state reconstructible; a daemon crash costs each client at most one failed call (proxy probes, respawns, re-initializes).
- **Memory-bounded by construction** — byte-accounted LRU cache (64 MB, 2 MB/entry, strict TTLs, no error caching), LSP pool LRU(5) + idle reap, refcounted `didOpen`/`didClose`, session sweep triad (onclose-grace / HTTP DELETE / idle), global child-process registry with kill-sweep on every exit path, capped child heaps (`maxTsServerMemory`). Validated by a <15 % RSS soak gate.
- **Concurrency-correct** — shared LSP processes with session-scoped views; diagnostics fan out to *all* waiters; cross-client writes serialized by per-path mutex **and** rejected on stale fingerprints.
- **Windows-correct** — `.cmd` shim with command-injection metachar gate, EPERM/EBUSY rename backoff (atomic writes + log rotation), detached daemon spawn done right, NTFS-mtime fingerprints.
- **Secure by default** — `127.0.0.1` bind, per-boot bearer token, Origin validation/DNS-rebinding 403, canonical+symlink-resolved path jail per project root, `.env*` read guard across all tools, per-client tool profiles, exact-pinned dependencies.

## Quick start

```powershell
# 1. Install (see IMPLEMENTATION_PLAN.md §1 for exact pins)
mkdir ~/.config/forge-mcp; cd ~/.config/forge-mcp
bun add @modelcontextprotocol/sdk zod@3.23.8 lru-cache async-mutex web-tree-sitter@0.25 tree-sitter-wasms@0.1.13

# 2. Register in any MCP host (it auto-starts the daemon):
#    command: ["bun", "C:/Users/<you>/.config/forge-mcp/stdio-proxy.ts"]
#    Cursor / Claude Code may instead point type:"http" at the daemon URL from daemon.json

# 3. Verify
bun test            # permanent regression suite: parity, soak, security gates
# GET http://127.0.0.1:<port>/stats  → sessions, warm procs, cache hit-rate, restarts
```

Configuration lives in `forge.json` (cache size, LSP caps, restart budgets, session sweeps, per-client tool profiles, security). Invalid config falls back to defaults — a config error never kills the daemon.

## Operational notes

- `GET /health` — liveness + version (used by the proxy's skew check; mismatched daemon drains and restarts itself).
- `GET /stats` — live observability: per-session protocol versions, process pool, cache bytes/hit-rate, circuit states.
- **Embedded mode** — if the daemon can't start at all, the proxy loads the core in-process (single-client, no sharing): the floor is always full nav-mcp-equivalent service.
- `RUNBOOK.md` — stale locks, port conflicts, zombie daemons, circuit diagnosis, full reset.
- Idle daemon exits after 30 min with zero sessions; cold restart ≈ Bun boot, language servers warm lazily.

## Project documents

| File | Purpose |
|---|---|
| `IMPLEMENTATION_PLAN.md` | LLM-executable build plan: M1–M7 with run/verify/on_fail, gates, rollbacks |
| `RUNBOOK.md` | Operations & recovery (delivered at M7) |
| `forge.json` | Runtime configuration |
| `test/` | Permanent `bun test` regression suite |

## Status & lineage

Design validated through four hardening iterations (architecture → concurrency/DA corrections → memory/lifecycle audit → security/production-principles audit) against 2025–2026 MCP specification revisions, SDK issue history, and field-reported failure classes (session-map leaks, pipe-buffer deadlocks, Windows rename locks, MCP command-injection CVE wave). `opencode.json` is never modified by tooling; nav-mcp is decommissioned only after the M7 live cutover matrix passes from two concurrent hosts.
