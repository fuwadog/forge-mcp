# forge-mcp — RUNBOOK

> Operations, recovery, and troubleshooting guide for the forge-mcp daemon.
>
> **Runtime state root:** `%LOCALAPPDATA%\forge-mcp\`
> **Language/Runtime:** TypeScript · Bun ≥ 1.3.x · Windows 11 · PowerShell 7
> **Last updated:** M7 — Integration & Cutover

---

## Table of Contents

- [1. Stale Lock (boot.lock)](#1-stale-lock-bootlock)
- [2. Port Conflict](#2-port-conflict)
- [3. Zombie Daemon](#3-zombie-daemon)
- [4. Circuit & Invalidation-Mode Diagnosis via /stats](#4-circuit--invalidation-mode-diagnosis-via-stats)
- [5. Full Reset Procedure](#5-full-reset-procedure)
- [6. Kill Switches](#6-kill-switches)
  - [FORGE_EMBEDDED=1 — Embedded Mode (No Daemon)](#forge_embedded1--embedded-mode-no-daemon)
  - [FORGE_NAPI=0 — Disable N-API ast-grep](#forge_napi0--disable-n-api-ast-grep)
  - [FORGE_WATCH=0 — Disable Native Watcher](#forge_watch0--disable-native-watcher)
  - [FORGE_CACHE=0 — Disable Result Cache](#forge_cache0--disable-result-cache)
  - [FORGE_LSP=0 — Disable LSP Servers](#forge_lsp0--disable-lsp-servers)
  - [FORGE_SUPERVISE=0 — Disable Supervisor](#forge_supervise0--disable-supervisor)
- [7. Log Location](#7-log-location)
- [8. Endpoints](#8-endpoints)
- [9. Troubleshooting Quick-Reference Table](#9-troubleshooting-quick-reference-table)

---

## 1. Stale Lock (boot.lock)

The daemon uses `%LOCALAPPDATA%\forge-mcp\boot.lock` as a single-instance guard.
If the daemon crashed or was killed hard (e.g., `taskkill /F`, power loss), the lock
may be left behind, preventing a new daemon from starting.

### Symptoms

- `boot.lock` file exists.
- A new daemon instance refuses to start with a "lock held" error.
- No matching process is running (confirmed via `Get-Process`).

### Resolution

```powershell
# Verify the lock exists
Test-Path "$env:LOCALAPPDATA\forge-mcp\boot.lock"

# Confirm no forge daemon process is running
Get-Process -Name "bun" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match "daemon\.ts"
}

# Delete the stale lock
Remove-Item -LiteralPath "$env:LOCALAPPDATA\forge-mcp\boot.lock" -Force
```

After deletion, restart the proxy or launch the daemon normally. The lock is
recreated automatically on next boot.

### Prevention

The daemon cleans up `boot.lock` during graceful shutdown. Only forced kills
or system crashes produce stale locks.

---

## 2. Port Conflict

The daemon binds to `127.0.0.1` on a configurable port (default: random free port
via `port: 0` in `forge.json`; a specific port can be set). When a specific port
is configured and already bound, startup fails.

### Symptoms

- Daemon logs show `EADDRINUSE` or "address already in use".
- The proxy reports "failed to connect" if the port is occupied by another service.

### Diagnosis

```powershell
# Check what is listening on the forge port (replace PORT with your configured value)
netstat -ano | Select-String ":PORT "

# Identify the owning process
$listening = netstat -ano | Select-String ":PORT "
$pid = $listening -replace '.*\s+(\d+)$', '$1'
Get-Process -Id $pid -ErrorAction SilentlyContinue | Format-Table Id, ProcessName, CommandLine
```

### Resolution

1. **Kill the conflicting process** if it is an orphaned forge daemon (see [§3](#3-zombie-daemon)).
2. **Change the port** in `forge.json` — set `daemon.port` to `0` for auto-assign
   or to an unused port number.
3. **Bind to a different interface** — this is not recommended; the daemon is
   designed for `127.0.0.1` only (security invariant). Do not set `bindHost`
   to `0.0.0.0` in production.

---

## 3. Zombie Daemon

A zombie daemon is a forge-mcp process that is still running but disconnected,
unreachable, or non-functional (e.g., after a network interface change, disk
sleep, or partial crash).

### Diagnosis

```powershell
# Find all bun processes likely running forge daemon
Get-Process -Name "bun" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match "daemon\.ts"
} | Format-Table Id, StartTime, @{N="CommandLine";E={$_.CommandLine -replace '.{80}', '$0...'}}

# Alternative: find by listening port
netstat -ano | Select-String ":3199"   # or whatever port forge uses

# Check if the daemon responds
curl.exe -s http://127.0.0.1:PORT/health
```

### Resolution

```powershell
# Kill the zombie by PID (replace PID with the actual process id)
Stop-Process -Id PID -Force

# Or kill all forge daemon instances
Get-Process -Name "bun" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match "daemon\.ts"
} | Stop-Process -Force
```

After killing, clean up the stale lock if present ([§1](#1-stale-lock-bootlock))
and restart.

---

## 4. Circuit & Invalidation-Mode Diagnosis via /stats

The `GET /stats` endpoint exposes internal daemon health: session count, warm LSP
processes, cache state, circuit-breaker status, and invalidation mode per root.

### Fetching Stats

```powershell
# Requires the bearer token from daemon.json
$token = (Get-Content "$env:LOCALAPPDATA\forge-mcp\daemon.json" | ConvertFrom-Json).token
$port  = (Get-Content "$env:LOCALAPPDATA\forge-mcp\daemon.json" | ConvertFrom-Json).port
$stats = curl.exe -s -H "Authorization: Bearer $token" "http://127.0.0.1:$port/stats"
$stats | ConvertFrom-Json | ConvertTo-Json -Depth 5
```

### Key Fields

| Field | Meaning |
|---|---|
| `sessions` | Active MCP session count |
| `session_ids` | List of active session IDs |
| `uptime_s` | Seconds since daemon started |
| `warm_procs` | Warm LSP processes per `(root, language)` |
| `cache.bytes` | Current cache size in bytes |
| `cache.hit_rate` | Cache hit rate (0.0–1.0) |
| `circuit_states` | Per-root circuit-breaker state: `closed`, `open`, `half-open` |
| `inv_mode` | Invalidation mode: `event` (native watcher) or `stat` (polling fallback) |

### Reading Circuit States

- **`closed`** — normal operation. LSP restarts within budget.
- **`open`** — budget exhausted (3 restarts in 5 min). Fallback chain active
  (LSP → tree-sitter → ctags → regex). The supervisor probes with
  half-open checks every 60 seconds.
- **`half-open`** — probing. One restart attempt allowed; success → `closed`,
  failure → `open` again.

### Reading Invalidation Modes

- **`event`** — native `@parcel/watcher` is active. Cache evictions happen
  within ~100 ms of external file changes.
- **`stat`** — native watcher unavailable or `FORGE_WATCH=0`. Cache relies on
  stat-based (mtime) invalidation with a 30-second TTL. Correctness is preserved,
  but freshness is delayed.

---

## 5. Full Reset Procedure

A full reset destroys all daemon state and starts fresh. Use when the daemon is
unresponsive, corrupted, or you want to clear all sessions and caches.

### Steps

```powershell
# 1. Kill the daemon if running
Get-Process -Name "bun" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match "daemon\.ts"
} | Stop-Process -Force

# 2. Delete the entire runtime state directory
Remove-Item -LiteralPath "$env:LOCALAPPDATA\forge-mcp" -Recurse -Force

# 3. Verify nothing remains
Test-Path "$env:LOCALAPPDATA\forge-mcp"

# 4. Restart — launch the proxy (which auto-starts the daemon)
bun stdio-proxy.ts

# Or start the daemon directly in foreground for debugging
bun daemon.ts
```

### What Gets Deleted

| File/Dir | Contents |
|---|---|
| `daemon.json` | Bearer token, assigned port, boot timestamp |
| `boot.lock` | Instance lock |
| `logs/` | All daemon logs |

After deletion, a fresh `daemon.json` with a new random token and port is created
on next boot. All client connections with the old token will be rejected and must
reconnect.

---

## 6. Kill Switches

All kill switches are **environment variables** read by the proxy (and plumbed to
the daemon). Set them before launch.

### FORGE_EMBEDDED=1 — Embedded Mode (No Daemon)

```powershell
# Run without a background daemon — proxy loads core in-process
$env:FORGE_EMBEDDED=1
bun stdio-proxy.ts
```

**Behavior:** The proxy bypasses the daemon entirely and loads the dispatch core
in-process. Single-client only. No session sharing across hosts. No cache sharing.
This is the **fallback floor**: if the daemon cannot start, embedded mode provides
nav-mcp-equivalent service.

**Use when:** Debugging daemon issues, running in resource-constrained environments,
or as a temporary workaround during daemon outages.

---

### FORGE_NAPI=0 — Disable N-API ast-grep

```powershell
$env:FORGE_NAPI=0
bun stdio-proxy.ts
```

**Behavior:** The `@ast-grep/napi` native binding is disabled. Structural code
search routes through the CLI `sg` (ast-grep) binary first, then falls back to
`ripgrep` if the CLI is unavailable.

**Use when:** `@ast-grep/napi` fails under your Bun version (run `bun
test/spike/napi.spike.ts` to verify). The M0 spike gates this; if the spike
fails, this flag should remain set for that Bun version.

**Effect on performance:** N-API is ~2–5× faster than CLI invocation. Expect
slower `ast_grep` tool responses.

---

### FORGE_WATCH=0 — Disable Native Watcher

```powershell
$env:FORGE_WATCH=0
bun stdio-proxy.ts
```

**Behavior:** The native `@parcel/watcher` filesystem watcher is disabled. Cache
invalidation falls back to stat-based (mtime) polling with a 30-second TTL floor.
Correctness is never compromised — fingerprints remain the authority — but cache
freshness is delayed from ~100 ms to up to 30 s.

**Use when:** The native watcher crashes, consumes too many file handles, or
`@parcel/watcher` fails under your Bun version (M0 spike gate).

**Checking current mode:** See invalidation mode in `GET /stats` (`inv_mode`).

---

### FORGE_CACHE=0 — Disable Result Cache

```powershell
$env:FORGE_CACHE=0
bun stdio-proxy.ts
```

**Behavior:** The fingerprint result cache (LRU, 64 MB, 2 MB/entry limit) and
cooldown logic are both disabled. Every tool request hits the engine fresh.
Cooldown debouncing is also skipped.

**Use when:** Debugging cache-related issues, profiling cold-path performance, or
validating that cache eviction is not hiding logic bugs.

**Note:** This increases latency on repeated identical requests. Not recommended
for production use.

---

### FORGE_LSP=0 — Disable LSP Servers

```powershell
$env:FORGE_LSP=0
bun stdio-proxy.ts
```

**Behavior:** All LSP-backed operations (definitions, references, hover,
diagnostics, document symbols, workspace symbols) route through the tree-sitter
fallback chain instead of starting language servers. No `vtsls`, `rust-analyzer`,
`gopls`, etc. are spawned.

**Use when:** LSP servers crash, consume too much memory, or you need to isolate
tree-sitter/ctags/regex capability. Also useful for low-memory environments.

**Effect on fidelity:** Tree-sitter provides structural understanding but no
type-level resolution. Expect less accurate "go to definition" (e.g., no type
inference).

---

### FORGE_SUPERVISE=0 — Disable Supervisor

```powershell
$env:FORGE_SUPERVISE=0
bun stdio-proxy.ts
```

**Behavior:** The supervisor's restart-budget tracking, circuit-breaker, and
half-open probing are disabled. If an LSP server crashes, it is **not**
automatically restarted. The fallback chain (LSP → tree-sitter → ctags → regex)
engages immediately without retry.

**Use when:** The supervisor logic itself exhibits a bug, or you want to
manually control LSP lifecycle for debugging.

**Note:** With `FORGE_SUPERVISE=0`, a transient LSP crash causes permanent
degradation until the daemon is restarted. Set `FORGE_LSP=0` in conjunction if
you need to force tree-sitter-only mode entirely.

---

## 7. Log Location

All daemon logs are written to a rotating file:

```
%LOCALAPPDATA%\forge-mcp\logs\daemon.log
```

### Viewing Logs

```powershell
# Tail the log (PowerShell 7+)
Get-Content -Path "$env:LOCALAPPDATA\forge-mcp\logs\daemon.log" -Tail 50 -Wait

# Read the full log
Get-Content -Path "$env:LOCALAPPDATA\forge-mcp\logs\daemon.log"

# Search for errors
Select-String -Path "$env:LOCALAPPDATA\forge-mcp\logs\daemon.log" -Pattern "ERROR|FATAL|CRASH"
```

### Log Rotation

Logs are rotated automatically at boot when the file exceeds the configured
maximum size (`daemon.logMaxMb` in `forge.json`, default 5 MB). The rotated file
gets a timestamp suffix. No old logs are deleted automatically — purge manually
as needed.

```powershell
# Check current log size
(Get-Item "$env:LOCALAPPDATA\forge-mcp\logs\daemon.log").Length / 1MB

# Manually purge old rotated logs
Remove-Item "$env:LOCALAPPDATA\forge-mcp\logs\daemon.log.*" -Force
```

---

## 8. Endpoints

All endpoints listen on `127.0.0.1:<port>` where `port` is written to
`daemon.json` after boot.

| Endpoint | Method | Auth Required | Description |
|---|---|---|---|
| `/health` | GET | No | Returns `{ok, forgeVersion, pid}` |
| `/stats` | GET | No | Returns sessions, warm procs, cache stats, circuit states, invalidation modes |
| `/admin/restart` | POST | Yes (bearer token) | Graceful drain + daemon restart |
| `/mcp` | POST/GET/DELETE | Yes (bearer token) | MCP session lifecycle |

### /health

```powershell
$port = (Get-Content "$env:LOCALAPPDATA\forge-mcp\daemon.json" | ConvertFrom-Json).port
curl.exe -s http://127.0.0.1:$port/health | ConvertFrom-Json | ConvertTo-Json
```

**Response:**
```json
{
  "ok": true,
  "forgeVersion": "0.1.0",
  "pid": 12345
}
```

### /stats

```powershell
$port = (Get-Content "$env:LOCALAPPDATA\forge-mcp\daemon.json" | ConvertFrom-Json).port
curl.exe -s http://127.0.0.1:$port/stats | ConvertFrom-Json | ConvertTo-Json
```

**Response:**
```json
{
  "ok": true,
  "sessions": 2,
  "uptime_s": 8421,
  "session_ids": ["sid_abc", "sid_def"],
  "warm_procs": {
    "C:\\Projects\\app (ts)": { "pid": 6789, "server": "vtsls" },
    "C:\\Projects\\app (py)": { "pid": 6790, "server": "pyright" }
  },
  "cache": { "bytes": 4194304, "hit_rate": 0.87 },
  "circuit_states": {
    "C:\\Projects\\app": "closed"
  },
  "inv_mode": {
    "C:\\Projects\\app": "event"
  }
}
```

### /admin/restart

```powershell
$token = (Get-Content "$env:LOCALAPPDATA\forge-mcp\daemon.json" | ConvertFrom-Json).token
$port  = (Get-Content "$env:LOCALAPPDATA\forge-mcp\daemon.json" | ConvertFrom-Json).port

curl.exe -s -X POST `
  -H "Authorization: Bearer $token" `
  http://127.0.0.1:$port/admin/restart
```

**Response:** `200 OK` — daemon drains sessions (5 second timeout) and exits.
The proxy (or systemd/supervisor) restarts it.

---

## 9. Troubleshooting Quick-Reference Table

| Symptom | Likely Cause | Action |
|---|---|---|
| "lock held" on start | Stale `boot.lock` | Delete `%LOCALAPPDATA%\forge-mcp\boot.lock` |
| Daemon won't bind (EADDRINUSE) | Port conflict | Change port in `forge.json` or kill the process on that port |
| Daemon unreachable but process exists | Zombie daemon | Kill with `Stop-Process -Force`, then restart |
| LSP tools return degraded results | LSP server crashed | Check `FORGE_SUPERVISE=0`; if set, restart daemon |
| All tools fall back to regex | Full degradation chain | Restart daemon; check logs for LSP/crash errors |
| Cache not evicting after edits | Watcher disabled or `FORGE_WATCH=0` | Check `inv_mode` in `/stats`; wait up to 30 s for stat-TTL |
| Daemon exits immediately | Idle timeout (30 min with 0 sessions) | Normal behavior; restart on next request |
| Token errors (401) | Stale token after daemon restart | Client must reconnect; token is per-boot |
| `ast_grep` slow | N-API disabled, using CLI sg or rg | Set `FORGE_NAPI=0` only if necessary; otherwise ensure napi binding is functional |
| Proxy can't find daemon | Daemon not started or port mismatch | Run `bun daemon.ts` manually to check for startup errors |
| High memory usage | Many LSP servers / large cache | Check `/stats` for warm procs; set `FORGE_CACHE=0` or `FORGE_LSP=0` |
| MCP session errors | Session reaped by idle sweep | Client reconnects automatically; check `sessions.idleSweepMin` config |
| Daemon.json missing | Full reset or first boot | Normal; created on first successful daemon start |

---

> **Note:** This RUNBOOK is a living document. Update it when new failure modes
> are discovered, when kill switches are added or removed, or when the `/stats`
> payload changes.
