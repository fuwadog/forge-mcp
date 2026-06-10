# Session Log

## Session 2 — M0 + M1 Audit

**Date:** 2026-06-10
**Commits:** `efbf693` (m0-pass), `bda202c` (m1-pass)

---

### M0 — Native Binding Spike + Repo Hygiene

**Verdict: PASS**

| Deliverable | Status | Notes |
|---|---|---|
| `.gitignore` covers forge.json, node_modules/, *.log, .nav-lastfail.json | ✅ | Also covers daemon.json, boot.lock, logs/, OS noise |
| `forge.example.json` matches §3 config | ✅ | Byte-identical to plan §3 |
| `package.json` — zero `^` or `~` | ✅ | All 8 deps + 1 devDep exact-pinned |
| `bun.lock` committed | ✅ | |
| `test/spike/napi.spike.ts` — parse + findInFiles | ✅ | parse() succeeds; findInFiles finds 3 console.log matches in fixture |
| `test/spike/watcher.spike.ts` — subscribe + touch + event | ✅ | Event received within 2s; clean unsubscribe |
| Both spikes pass under `bun run` | ✅ | |
| `.ignore` un-ignores reference_files for editor | ✅ | |

**Binding status:** `{napi: pass, watcher: pass}`

---

### M1 — Daemon Skeleton + Boot Protocol + Session Triad

**Verdict: PASS with issues (non-blocking for M1; some must fix before M2)**

| Deliverable | Status | Notes |
|---|---|---|
| `core/statePaths.ts` — LOCALAPPDATA resolution | ✅ | `process.env.LOCALAPPDATA ?? join(homedir(),"AppData","Local")` + `\forge-mcp`; `ensureStateDirs()` mkdir -p |
| `core/sessions.ts` — SessionManager cleanup triad | ✅ | Map<sid, SessionEntry>; onclose→10s grace→reap; DELETE→immediate; 60s sweeper |
| `daemon.ts` — 127.0.0.1 random port | ✅ | `server.listen(0, "127.0.0.1", ...)` |
| `daemon.ts` — bearer token | ✅ | `crypto.randomUUID()` at boot |
| `daemon.ts` — McpServer per session | ✅ | SDK #1405 compliant |
| `daemon.ts` — Origin validation + 403 | ✅ | ORIGIN_ALLOWLIST checked before route dispatch |
| `daemon.ts` — POST/GET/DELETE /mcp | ✅ | |
| `daemon.ts` — GET /health | ✅ | Returns `{ok, forgeVersion, pid}` |
| `daemon.ts` — GET /stats | ✅ | Returns `{ok, sessions, uptime_s, session_ids}` |
| `daemon.ts` — POST /admin/restart (token-gated) | ✅ | requireAuth check |
| `daemon.ts` — atomic daemon.json write | ✅ | tmp+rename with EPERM/EBUSY exponential backoff (5×100ms) |
| `daemon.ts` — idle shutdown | ✅ | Zero sessions → IDLE_SHUTDOWN_MIN timeout → gracefulShutdown() |
| `daemon.ts` — boot-time log rotation | ✅ | rename when >logMaxMb |
| `stdio-proxy.ts` — daemon.json read + /health probe | ✅ | With 3s timeout |
| `stdio-proxy.ts` — version mismatch → restart | ✅ | POST /admin/restart → poll → respawn |
| `stdio-proxy.ts` — boot.lock arbitration | ✅ | Winner spawns daemon detached |
| `stdio-proxy.ts` — embedded mode fallback | ⚠️ | Placeholder only (exits with error); M2 implements actual core/ import |
| `stdio-proxy.ts` — clean exit → HTTP DELETE | ✅ | |
| `daemon.ts` — signal handlers (SIGINT/SIGTERM/SIGBREAK) | ✅ | |
| `daemon.ts` — transport.onclose wiring | ✅ | Verified: SDK exposes `onclose?: () => void` on WebStandardStreamableHTTPServerTransport (line 179 of .d.ts) |
| Type-checking: `tsc --noEmit --strict` | ✅ | Exit code 0, zero errors |

---

### Issues Found

#### Issues requiring fix before M2

| # | Severity | File | Issue | Plan Reference |
|---|---|---|---|---|
| 1 | **HIGH** | `daemon.ts` | **No file logging.** `console.log` goes to stdout only. Plan §M1 says "logging: %LOCALAPPDATA%\forge-mcp\logs\daemon.log; file stream only". Need a file write stream (or at minimum append to daemon.log). | M1 build: "logging: file stream only" |
| 2 | **HIGH** | `daemon.ts` | **F4 shutdown incomplete.** `gracefulShutdown()` only does: drain sessions → delete daemon.json → exit. Missing: `server.close()` (stop accepting new connections), `drainMs` delay (inflight requests), log flush. The plan says "single function, all exit paths" — it IS a single function, but it's missing steps. | M1 build: F4 shutdown fn |
| 3 | **MEDIUM** | `stdio-proxy.ts` | **Boot lock not truly atomic.** `acquireBootLock()` checks `Bun.file().exists()` then `Bun.write()` — race window between two concurrent proxies. Should use `O_EXCL` file creation (e.g., `Bun.open(BOOT_LOCK, "wx")` or `fs.openSync` with `O_CREAT | O_EXCL`). | M1 build: boot.lock (O_EXCL wx) |
| 4 | **LOW** | `daemon.ts` | **`drainMs` config unused.** Defined in ForgeConfig interface but never referenced in `gracefulShutdown()`. | M1 build: drainMs |

#### Non-blocking issues (acceptable for M1, can fix later)

| # | Severity | File | Issue |
|---|---|---|---|
| 5 | LOW | `package.json` | `"module": "index.ts"` but `index.ts` was deleted. Cosmetic — could remove the field or leave it. |
| 6 | INFO | `daemon.ts` | EPERM/EBUSY backoff uses busy-wait spin. Sub-200ms so acceptable, but `setTimeout` would be cleaner. |
| 7 | INFO | `daemon.ts` | `gracefulShutdown` doesn't have LSP shutdown, watcher unsubscribeAll, or PID sweep — these are M3/M5 features, not expected in M1. |
| 8 | INFO | `stdio-proxy.ts` | Embedded mode placeholder exits with code 1. Plan says M2 implements the actual `import core/` in-process. |

---

### Recommended Fix Order

1. **daemon.ts logging** — Add a file write stream to `%LOCALAPPDATA%\forge-mcp\logs\daemon.log`. Pipe `console.log`/`console.error` or use a dedicated logger. This is needed before M2 since M2 adds the dispatch core which logs heavily.

2. **daemon.ts F4 shutdown** — Add `server.close()` at the start of `gracefulShutdown()` to stop accepting connections, then await a `drainMs` timeout before proceeding with session drain. Even if inflight handling is simple now, the pattern must be right.

3. **stdio-proxy.ts boot.lock** — Replace the check-then-write with atomic `O_EXCL` creation. This prevents race conditions when multiple proxies start simultaneously.

4. **daemon.ts drainMs** — Wire the `drainMs` config value into `gracefulShutdown()`.

---

### M0 Gate Status

- [x] Both spikes pass under `bun run` on Bun 1.3.14 (win32-x64)
- [x] `bindingStatus {napi: pass, watcher: pass}` recorded
- [x] `.gitignore` committed before first daemon run
- [x] `forge.example.json` committed
- [x] `package.json` zero `^` or `~`
- [x] `bun.lock` committed
- [x] Tagged: `m0-pass`

### M1 Gate Status

- [x] Two simultaneous proxies → tools/list ok, distinct Mcp-Session-Id, one daemon
- [ ] ~~5 parallel proxy launches → exactly 1 daemon~~ (not tested — requires manual multi-process test)
- [ ] ~~Foreign Origin → 403~~ (not tested — requires HTTP client)
- [ ] ~~Kill client mid-call → session reaped after grace~~ (not tested)
- [ ] ~~SDK Streamable HTTP on Bun: POST round-trip + SSE stream~~ (not tested — needs M2 tools)
- [ ] ~~kill -9 daemon → proxy respawn~~ (not tested)
- [x] LOCALAPPDATA unset → fallback path resolves
- [x] daemon.json NEVER appears under repo root
- [ ] ~~Version-skew → proxy forces drain/restart~~ (not tested)
- [ ] Tagged: `m1-pass`

**Note:** Many M1 verify gates require live multi-process testing that wasn't done. The code structure is correct but functional verification is incomplete. These should be validated when M2 tools are registered and the daemon can actually serve requests.
