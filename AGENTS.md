# forge-mcp — Agent Guide

## What this repo is

forge-mcp is a **pre-implementation** MCP server project. Only design docs and reference files exist until milestones land — no runnable source yet.

- `README.md` — architecture overview, tool surface, guarantees
- `implementation_plan.md` — **the source of truth**: LLM-executable build plan (M0–M7), gates, rollbacks
- `reference_files/` — nav-mcp source to port (READ-ONLY; never edit)
- `forge.example.json` — config template (live `forge.json` is gitignored)

## Target runtime & locations

- **Language**: TypeScript (strict) · **Runtime**: Bun ≥ 1.3.x — **not** Node · **OS**: Windows 11, PowerShell 7
- **Code root**: this repo. All source is committed here.
- **Runtime state**: `%LOCALAPPDATA%\forge-mcp\` — `daemon.json` (contains the bearer **token**), `boot.lock`, `logs/`. **Never** in the repo. If `daemon.json` ever appears under the repo root, that is a bug (and a secret leak) — stop and fix.

## Key constraints (from implementation_plan.md §0)

| Constraint | Detail |
|---|---|
| `bun build --compile` | **BANNED** — run TS source directly (SDK subpath-export issues) |
| Dependencies | **EXACT** pins only. No `^`/`~`. `bun.lock` committed. Manual bumps. Re-run M0 spike after any Bun bump. |
| Never-throw | Every tool returns a `NavEnvelope` (`ok:false` on error; transport never sees exceptions) |
| `reference_files/` | Read-only port source. Live nav-mcp install untouched until M7 cutover. |
| `opencode.json` | **NEVER** modified by agent. Snippets delivered for manual user apply. |
| Security floor | `127.0.0.1` bind · bearer token · Origin validation/403 · `.env*` guard · canonical+realpath path jail · cmd-shim metachar gate |
| Invalidation authority | Fingerprints (mtime-in-key) = correctness. Watcher events = eviction accelerator only. |
| Fallback floor | Worst case == nav-mcp parity (embedded mode, stat invalidation, CLI/ripgrep ast). Below that = build failure. |

## Build order (sequential, gated — do not skip)

0. **M0** — Native-binding spike (`@ast-grep/napi`, `@parcel/watcher` under Bun) + `.gitignore` + `forge.example.json`. Failures here only disable those features behind flags; nothing else blocks.
1. **M1** — Daemon skeleton, boot protocol, session triad, `%LOCALAPPDATA%` state
2. **M2** — Core port (dispatch, 15 modes) + path guard + hardened `withTimeout`
3. **M3** — LSP concurrency ((root,lang) pool, refcounted didOpen, fan-out waiters)
4. **M4** — Supervisor + param self-correction
5. **M5** — Cache + cooldown + event-driven invalidation (`core/watcher.ts`)
6. **M6** — Tool port (4 tools) + ast-grep/napi routing matrix + security planes
7. **M7** — Integration, cutover, RUNBOOK, permanent test suite

Each milestone has `run / verify / on_fail` + rollback in `implementation_plan.md`. Commit convention: **one tagged commit per milestone gate passed** (`m0-pass`, `m1-pass`, …) — repo history must show the gated process.

## Port gotchas (battle scars — violating any is a known production bug)

- `pathToFileUri` MUST emit `file:///C:/...` — `file://C:/` treats `C:` as host → empty file → no symbols.
- cmd.exe shim passes the **bare command name**, never the resolved path (`C:\Program Files\...\npm.cmd` splits at the space).
- web-tree-sitter stays **0.25.x** (ABI-14). 0.26+ → `getDylinkMetadata` error on the 21 bundled grammars. Named exports (`Parser`, `Language`), wasm in `tree-sitter-wasms/out/`.
- Consume child stdout/stderr **concurrently from spawn** — awaiting `exited` first deadlocks on full pipe buffers.
- Every `fs.rename` on Windows goes through `retryOnLock` (EPERM/EBUSY/EACCES, 5×100ms exp) — Defender holds transient locks.

## NavEnvelope contract (what every tool returns)

```typescript
{ ok, mode, path?, budget_source, truncated, fingerprint?, anchor?, total_lines?, next?,
  outline?, matches?, notes?, engine?, partial?, diagnostics?, diagnostics_pending?,
  files_changed?, total_edits?, scope?, applied_title?, payload,
  cache?:    {hit:true, fingerprint, ttl_remaining_ms},          // EMIT ONLY on hit
  recovery?: {attempted?, corrected_params?, restarts?, cooldown?} } // EMIT ONLY when recovery occurred
```
`engine` attribution values include: `lsp` · `tree-sitter` · `ctags` · `regex` · `ast-napi` · `ast-cli` · `ripgrep`.

## Runtime flags & endpoints

| Flag | Effect |
|---|---|
| `FORGE_EMBEDDED=1` | Proxy loads core in-process (single-client, no daemon) |
| `FORGE_CACHE=0` | Disable result cache (cooldown too) |
| `FORGE_LSP=0` | All LSP modes route to tree-sitter chain |
| `FORGE_SUPERVISE=0` | Disable restart/circuit logic (degradation chain only) |
| `FORGE_WATCH=0` | Stat-based invalidation (no native watcher) |
| `FORGE_NAPI=0` | ast_grep collapses to CLI→ripgrep |

Endpoints (token-gated where mutating): `GET /health` `{ok, forgeVersion, pid}` · `GET /stats` (sessions, warm procs per root, cache bytes/hit-rate, circuit states, invalidation mode per root) · `POST /admin/restart` (graceful drain).

## Development commands

```powershell
bun --version          # >= 1.3.x
bun test               # permanent regression suite (parity, soak, security, backpressure, events)
bun test/spike/napi.spike.ts ; bun test/spike/watcher.spike.ts   # M0 — rerun after ANY Bun bump
bun daemon.ts          # foreground daemon for dev (proxy normally spawns it detached)
bun pm ls              # deps present; package.json must contain zero ^ or ~
```

## External binaries vs LSP servers (distinct things — don't conflate)

- **CLI binaries** (PATH): `rg` (ripgrep), `sg` (ast-grep — *optional* once napi passes M0), `git`, `universal-ctags`.
- **LSP servers** (spawned warm by `core/lsp-client.ts`): vtsls (TS/JS), ty→pyright fallback (Python), rust-analyzer, gopls, marksman (Markdown); yaml-ls + bash-ls pre-installed to PATH.

## Gotchas

- `reference_files/` subtrees appear in tree output but exist only under `reference_files/` — they are not repo-root modules.
- `forge.json` config errors fall back to defaults — a config error never kills the daemon.
- Idle daemon exits after 30 min with zero sessions; cold restart ≈ Bun boot (LSP warms lazily).
- Embedded mode is the floor: daemon unstartable → proxy serves nav-mcp-equivalent single-client service.
- Multiple repo clones share one daemon via `%LOCALAPPDATA%`; the proxy's version-skew check forces a drain/restart when code differs.
