# forge-mcp — IMPLEMENTATION_PLAN.md
> Plan-of-record: **Blueprint v5** = v4 + F1–F6 + audit fixes + M0 native-binding spike + ast-grep/napi + event-driven invalidation (signed off).
> Format: LLM-executable. Every step = `run / verify / on_fail`. Execute milestones strictly in order (M0 → M7). Do not skip gates.
> Environment: Windows 11 · PowerShell 7 · Bun ≥ 1.3.x
> Code root (repo): `c:\Users\PLACEHOLDER\Desktop\Dev-Environtment\Company\forge-mcp` — machine-specific; do NOT "normalize" this path.
> Runtime-state root: `%LOCALAPPDATA%\forge-mcp\` — resolved as `process.env.LOCALAPPDATA ?? join(homedir(),"AppData","Local")` + `\forge-mcp`.

---

## 0 · Global Constraints (read before any step)

```yaml
constraints:
  - opencode_json: "NEVER modified by agent. Registration snippet delivered for manual user apply. 'lsp': true stays verbatim."
  - nav_mcp: "reference_files/ is READ-ONLY port source. Live nav-mcp install untouched until M7 cutover."
  - bun_compile: "BANNED. Run TS source directly (SDK subpath-export issues under bun build --compile)."
  - dependency_policy: "EXACT version pins, bun.lock committed, manual bumps only. No ^ or ~ in package.json."
  - never_throw: "Every tool returns a NavEnvelope. Errors are envelopes with ok:false, never transport exceptions."
  - security_floor: "127.0.0.1 bind, bearer token, Origin validation, .env guard, canonical path guard, cmd-shim metachar gate."
  - fallback_floor: "Worst-case service level == current nav-mcp (embedded mode, stat-based invalidation, CLI/ripgrep ast). Anything below = build failure."
  - runtime_state: "daemon.json (contains TOKEN), boot.lock, logs/ live ONLY in %LOCALAPPDATA%\\forge-mcp\\. NEVER in the repo. The token must never be committable by construction."
  - secrets_in_repo: ".gitignore committed in M0 BEFORE any runtime artifact can exist. Live forge.json gitignored; forge.example.json committed."
  - native_bindings: "@ast-grep/napi and @parcel/watcher are M0-gated. Either failing under Bun → that feature defaults OFF behind its fallback; no other milestone blocks."
  - invalidation_authority: "Fingerprints (mtime-in-key) are the CORRECTNESS layer. Watcher events are an eviction ACCELERATOR only. No correctness may ever depend on the watcher."
```

## 1 · Libraries & Installers

```yaml
runtime:
  bun: ">=1.3.x"            # verify: bun --version  (1.3.11 confirmed working baseline; detached-spawn + N-API maturity)
  node_required: false       # node:http via Bun node-compat
preinstalled_assumed:        # on PATH from nav-mcp era
  - ripgrep (rg)             # ast floor rung
  - ast-grep (sg)            # CLI rung; napi makes this OPTIONAL after M0/M6
  - git
  - universal-ctags          # outline fallback rung
  - "LSP servers: vtsls, ty (pyright fallback), rust-analyzer, gopls, marksman (+ yaml-ls, bash-ls pre-installed to PATH)"
dependencies:                # bun add <name>@<exact> — freeze EXACT resolved versions after first install
  "@modelcontextprotocol/sdk": "latest 1.x at install time, then FREEZE exact"
  "zod": "3.23.8"                        # SDK peer; do NOT hoist to zod@4
  "lru-cache": "11.x exact"
  "async-mutex": "0.5.x exact"
  "web-tree-sitter": "0.25.x exact"      # ABI-14. Do NOT bump to 0.26+ (ABI-15 → getDylinkMetadata error on these grammars)
  "tree-sitter-wasms": "0.1.13"
  "@ast-grep/napi": "0.43.x exact"       # M0-gated; version-aligned with CLI sg 0.43
  "@parcel/watcher": "2.5.6"             # M0-gated; win32-x64 binding via optionalDependencies
optional_lang_packages:      # install ONLY if napi routing for these langs is wanted (M6 decision point)
  - "@ast-grep/lang-python"
  - "@ast-grep/lang-rust"
  - "@ast-grep/lang-go"
dev_dependencies:
  "@types/bun": "latest exact"
install:
  run: |
    # in repo root
    bun init -y
    bun add @modelcontextprotocol/sdk zod@3.23.8 lru-cache async-mutex web-tree-sitter@0.25 tree-sitter-wasms@0.1.13 @ast-grep/napi @parcel/watcher@2.5.6
    bun add -d @types/bun
    # then: replace every ^/~ range in package.json with exact versions from bun.lock
  verify: "bun pm ls clean; package.json contains zero ^ or ~; .gitignore present BEFORE first daemon run"
```

## 2 · Target Layout

```
<repo root>/                          # code only — everything here is committable
├── package.json / bun.lock
├── .gitignore                        # forge.json, node_modules/, *.log  (M0 deliverable)
├── forge.example.json                # committed template; live forge.json is gitignored
├── README.md / AGENTS.md / implementation_plan.md / RUNBOOK.md (M7)
├── daemon.ts            # node:http server, StreamableHTTPServerTransport host, boot protocol, F4 shutdown
├── stdio-proxy.ts       # per-host bridge: lockfile autostart, /health+token probe, F3 version-skew, embedded mode
├── core/
│   ├── index.ts         # dispatch + session middleware + cache wrap + cooldown + F2 path guard
│   ├── lsp-client.ts    # REWRITTEN: (root,lang)-keyed pool, refcounted didOpen, fan-out waiters, mtime resync
│   ├── supervisor.ts    # NEW: healthy→restarting→circuit-open→half-open
│   ├── cache.ts         # NEW: lru-cache wrapper, fingerprints, class policy, generation counter, cooldown map
│   ├── watcher.ts       # NEW: @parcel/watcher per-root subscriptions, debounce, coarse mode, stat-degradation
│   ├── sessions.ts      # NEW: per-session McpServer registry, onclose-grace/DELETE/idle-sweep triad
│   ├── mutex.ts         # NEW: keyed async-mutex (~20 lines)
│   ├── locate.ts        # ported verbatim ← reference_files/nav-mcp/core/locate.ts
│   ├── treesitter.ts    # ported verbatim ← reference_files/nav-mcp/core/treesitter.ts (21 langs, 0.25 named-export API)
│   └── workspace-edit.ts# ported + Windows rename backoff ← reference_files/nav-mcp/core/workspace-edit.ts
├── tools/               # ported ← reference_files/tools/{ast-grep,git-view,test-run,dep-audit}.ts
├── lib/withTimeout.ts   # ported + R7 amendments ← reference_files/lib/withTimeout.ts
├── test/                # permanent bun test suite (F5)
└── reference_files/     # nav-mcp port source — READ-ONLY, never edited

%LOCALAPPDATA%\forge-mcp\             # runtime state only — never in repo
├── daemon.json          # {port, pid, token, forgeVersion, started} — contains the bearer TOKEN
├── boot.lock
└── logs\daemon.log      # boot-rotated
```

## 3 · forge.json (live copy at repo root, gitignored; forge.example.json committed)

```jsonc
{
  "daemon":   { "port": 0, "idleShutdownMin": 30, "logMaxMb": 5, "drainMs": 5000 },
  "cache":    { "maxBytes": 67108864, "maxEntryBytes": 2097152, "enabled": true, "cooldownMs": 2000 },
  "lsp":      { "lruCap": 5, "idleReapMin": 5, "restartBudget": 3, "budgetWindowMin": 5,
                "halfOpenProbeSec": 60, "tsMaxMemoryMb": 3072, "warmup": "lazy" },
  "watch":    { "enabled": true, "debounceMs": 100, "coarseThreshold": 500,
                "ignore": ["**/node_modules/**","**/.git/**","**/dist/**","**/.venv/**","**/target/**"] },
  "ast":      { "napi": true, "langPackages": [] },
  "sessions": { "idleSweepMin": 30, "oncloseGraceMs": 10000 },
  "children": { "concurrency": 8, "outputCapBytes": 10485760, "defaultTimeoutMs": 30000 },
  "limits":   { "maxSliceTokens": 120000 },
  "profiles": { "claude-ai": ["read","edit","ast_grep"], "default": "all" },
  "security": { "bindHost": "127.0.0.1", "allowOutsideRoot": false,
                "originAllowlist": ["http://127.0.0.1","http://localhost"] }
}
```

Env kill-switches (all override forge.json): `FORGE_CACHE=0` · `FORGE_LSP=0` · `FORGE_SUPERVISE=0` · `FORGE_WATCH=0` · `FORGE_NAPI=0` · `FORGE_EMBEDDED=1`.

---

## M0 — Native Binding Spike + Repo Hygiene  (NEW · ~30 min · gates napi + watcher only)

```yaml
M0:
  build:
    - commit .gitignore FIRST: forge.json, node_modules/, *.log, .nav-lastfail.json
    - commit forge.example.json (§3 content)
    - spike scripts (test/spike/):
        - napi.spike.ts: import {parse,Lang,findInFiles} from "@ast-grep/napi";
          parse a TS fixture; findInFiles over test/fixtures/ for "console.log($A)"; assert ≥1 match
        - watcher.spike.ts: import watcher from "@parcel/watcher";
          subscribe(fixtureDir) → touch file → assert event within 2s → unsubscribe() → clean exit
  verify:
    - both spikes pass under `bun run` on this exact Bun version (1.3.x, win32-x64)
    - record results in SESSION-CHANGELOG: bindingStatus {napi: pass|fail, watcher: pass|fail}
  on_fail:
    - napi fail   → forge.json ast.napi=false default; ast_grep ships CLI→ripgrep only (v4 behavior); M6 routing matrix collapses to CLI-primary
    - watcher fail → forge.json watch.enabled=false default; invalidation stays stat-based (v4 behavior); core/watcher.ts still built but dormant
    - NEITHER failure blocks M1–M7
  rollback: "git revert; no runtime artifacts exist yet"
```

## M1 — Daemon Skeleton + Boot Protocol + Session Triad

```yaml
M1:
  build:
    - statePaths.ts helper: LOCALAPPDATA resolution = process.env.LOCALAPPDATA ?? join(homedir(),"AppData","Local"), + "\\forge-mcp"; mkdir -p on boot
    - daemon.ts:
        - node:http on 127.0.0.1:<random free port>; bearer token = crypto.randomUUID() at boot
        - StreamableHTTPServerTransport per session; sessionIdGenerator: () => randomUUID()
        - "ONE McpServer PER SESSION (SDK #1405): construct in onsessioninitialized, store in sessions map"
        - enableDnsRebindingProtection: true + Origin allowlist + 403 on mismatch (R9 — HARD GATE)
        - routes: POST/GET/DELETE /mcp · GET /health {ok,forgeVersion,pid} · GET /stats · POST /admin/restart (token-gated)
        - commit point: write %LOCALAPPDATA%\forge-mcp\daemon.json LAST, atomic tmp+rename (with EPERM/EBUSY backoff)
        - idle shutdown: zero sessions for idleShutdownMin → F4 graceful shutdown
        - F4 shutdown fn (single function, all exit paths): stop accept → drain inflight (drainMs) →
          LSP shutdown→exit→SIGKILL(2s) → watcher unsubscribeAll → PID sweep → flush/close log → delete daemon.json → exit
        - logging: %LOCALAPPDATA%\forge-mcp\logs\daemon.log; boot-time rotation (rename w/ backoff); file stream only
    - sessions.ts:
        - map sid → {mcpServer, transport, rootsCache, recovery, lastSeen}
        - cleanup triad: transport.onclose → 10s grace (cancel on re-attach) → reap; HTTP DELETE → immediate; 60s sweeper reaps idle > idleSweepMin
        - reap = decrement openedFiles refs (M3 hook), close transport+server, delete entry
    - stdio-proxy.ts:
        - read daemon.json from %LOCALAPPDATA% → /health probe with token + forgeVersion compare (F3)
        - healthy+match → bridge stdio↔HTTP; mid-session error → re-probe → respawn → re-init
        - version mismatch (e.g. second repo clone / updated code) → POST /admin/restart → wait → respawn
        - absent/stale → boot.lock (O_EXCL wx); winner: Bun.spawn({cmd:["bun","daemon.ts"],detached:true,stdio:["ignore","ignore","ignore"]}); loser polls daemon.json (100ms, 10s cap)
        - daemon unstartable → EMBEDDED MODE (import core/ in-process, single-client); FORGE_EMBEDDED=1 forces it
        - clean exit → HTTP DELETE session
  verify:
    - two simultaneous proxies → tools/list ok, distinct Mcp-Session-Id, one daemon
    - 5 parallel proxy launches → exactly 1 daemon
    - foreign Origin → 403 (R9 gate)
    - kill client mid-call → session reaped after grace, RSS baseline (L1 gate)
    - SDK Streamable HTTP on Bun: POST round-trip + SSE stream (DA12 gate)
    - kill -9 daemon → proxy respawn → next call succeeds (≤1 failed call)
    - LOCALAPPDATA unset in env → fallback path resolves; daemon.json NEVER appears under repo root (runtime_state gate)
    - version-skew: hand-edit daemon.json forgeVersion → proxy forces drain/restart (F3/multi-clone gate)
  on_fail:
    - DA12 → thin Express shim per SDK reference pattern; re-verify
    - else → proxy ships embedded-only; flag; later milestones proceed against embedded core
  rollback: "git clean -fdX in repo + delete %LOCALAPPDATA%\\forge-mcp\\"
```

## M2 — Core Port + Path Guard

```yaml
M2:
  port_sources:   # explicit — reference_files/ is in-repo and read-only
    - reference_files/nav-mcp/core/locate.ts        → core/locate.ts        (verbatim)
    - reference_files/nav-mcp/core/treesitter.ts    → core/treesitter.ts    (verbatim — 21 langs; web-tree-sitter 0.25 NAMED exports Parser/Language; wasm in tree-sitter-wasms/out/)
    - reference_files/nav-mcp/core/workspace-edit.ts → core/workspace-edit.ts (+R8 backoff)
    - reference_files/nav-mcp/core/index.ts         → core/index.ts          (dispatch; adapted)
    - reference_files/lib/withTimeout.ts            → lib/withTimeout.ts     (+R7 amendments)
  port_gotchas:   # carried from nav-mcp battle scars — violating any = known production bug
    - "pathToFileUri MUST emit file:///C:/... (file://C:/ treats C: as host → empty file → no symbols)"
    - "cmd.exe shim passes the BARE NAME, never the resolved path (C:\\Program Files\\...\\npm.cmd splits at the space)"
    - "tree-sitter: do NOT bump web-tree-sitter past 0.25.x (ABI-14 grammars)"
  build:
    - workspace-edit.ts: wrap every fs.rename in retryOnLock(fn,{tries:5,baseMs:100,exp:2,codes:[EPERM,EBUSY,EACCES]})
    - lib/withTimeout.ts:
        - consume stdout+stderr CONCURRENTLY from spawn (never await exited first)
        - combined output cap children.outputCapBytes → kill child, truncated:true
        - opts.signal AbortSignal → immediate kill; module semaphore(children.concurrency) FIFO
        - keep: win32 shim, looksLikePanic, resolveCwd, findProjectRoot, NaN-hardened bounds
        - F1 gate: cmd.exe shim path + any arg matching /[&|<>^%"]/ → refuse cleanly, never execute
    - core/index.ts: port dispatch, all 15 modes (11 read + 4 edit); remove ROOT global; root = explicit arg → session roots/list → cwd
    - F2 path guard middleware (BEFORE locate healing): resolve → fs.realpath → case-normalized prefix vs root → refuse outside
    - envelope: optional cache/recovery fields, EMIT-ON-EXCEPTION ONLY
    - register read + edit per session (zod schemas from reference_files/nav-mcp/index.ts; readOnlyHint/destructiveHint)
  verify:
    - 15-mode dispatch smoke suite green via MCP client (envelope diff vs nav-mcp per mode)
    - paths with spaces + non-ASCII on Windows pass read/edit
    - symlink/junction escape + ..\..\ traversal → refused (F2 gate)
    - 64MB-stdout child → killed, truncated:true, no deadlock; 20 parallel calls respect semaphore (R7 gate)
    - workspace-edit batch under synthetic 200ms lock → completes, never partial (R8 gate)
    - metachar args via cmd-shim → refused (F1 gate)
  on_fail: "per-mode envelope diff vs nav-mcp; fix before proceeding"
  rollback: "core/ additive; M1 daemon functional with zero tools"
```

## M3 — LSP Concurrency Layer

```yaml
M3:
  build:
    - core/lsp-client.ts rewrite:
        - pool: Map<"${realRoot}::${lang}", WarmProc>; rootUri per project (DA3); global LRU(lruCap) across roots
        - languages (from nav): ts/tsx/js/jsx→vtsls · py/pyi→ty then pyright · rs→rust-analyzer · go→gopls · md→marksman
        - openedFiles: Map<WarmProc, Map<uri,{refcount,sessions:Set<sid>,mtimeAtOpen}>>; first ref→didOpen; refcount0+60s idle→didClose (L3)
        - diagnosticCache shared/file-truth; diagnosticWaiters Map<uri,Set<{sid,resolve,timer}>>;
          publishDiagnostics → fan out to ALL then cache; per-waiter 10s self-timeout → diagnostics_pending (L4)
        - mtime drift on LSP-backed read → didChange full-sync before serving (watcher events schedule this proactively when enabled)
        - root-liveness: zero sessions on root 10min → reap that root's procs first (L2) + watcher.unsubscribe(root) (L10)
        - vtsls init: typescript.tsserver.maxTsServerMemory = lsp.tsMaxMemoryMb (≥1024 enforced)
        - keep: resolveSpawn win32 shim, 2s/5s request caps, 60s reap sweep
    - core/mutex.ts: keyed async-mutex per abs path; wraps all mutating modes; expect fingerprint = second plane
  verify:
    - two sessions SAME root+lang → one proc; DIFFERENT roots same lang → two procs, correct rootUris (DA3 gate)
    - both sessions await diagnostics same file → BOTH resolve identical payload
    - concurrent edit: second blocked by mutex then rejected by stale expect
    - kill session holding files → didClose after idle (L3); crash proc w/ waiters → all diagnostics_pending ≤10s (L4)
  on_fail: "single global LSP mutex (correct, slower); flag; revisit"
  rollback: "FORGE_LSP=0 → tree-sitter chain"
```

## M4 — Supervisor + Param Self-Correction

```yaml
M4:
  build:
    - core/supervisor.ts per WarmProc:
        - detect: unexpected exited, framing corruption, request timeout, looksLikePanic
        - restart backoff 1s→4s→16s; budget restartBudget/budgetWindowMin per (root,lang)
        - in-flight crash → fail-soft to chain (tree-sitter→ctags→regex); engine/notes report rung
        - budget exhausted → circuit-open → chain; half-open single-initialize probe after halfOpenProbeSec
        - resurrection: replay didOpen for refcount>0 files; crash drains that proc's waiters immediately
        - watcher.ts also supervisor-wrapped: 1 restart attempt → permanent stat-degradation for that root (DA-W3)
    - param self-correction (pre-dispatch, max 1 retry, recovery.corrected_params):
        - path → locate chain (AFTER F2 guard); enum typo ≤2 distance unambiguous; line/char clamp
        - mutating modes: correction REPORTED only, never auto-applied
  verify:
    - kill vtsls mid-request → tree-sitter envelope, transport clean
    - 4th crash in window → circuit-open + recovery.restarts; half-open restores
    - typo'd read path → corrected + recovery field; typo'd EDIT path → refused with suggestion
    - kill watcher backend → /stats shows invalidation:"stat" for that root; caches still correct (DA-S2 authority gate)
  on_fail: "degrade to nav behavior (chain only); flag"
  rollback: "FORGE_SUPERVISE=0"
```

## M5 — Cache + Cooldown + Event-Driven Invalidation

```yaml
M5:
  build:
    - core/cache.ts:
        - LRUCache({maxSize:cache.maxBytes, maxEntrySize:cache.maxEntryBytes, ttlAutopurge:true,
                    allowStale:false, updateAgeOnGet:false, sizeCalculation:v=>v.payloadBytes, dispose:byte-accounting})
        - value type LOCKED: {payload:string, payloadBytes:number}
        - fingerprint: SHA-256(tool+mode+canonicalJSON(args)+⊕(mtimeMs:size of touched files))
        - class table (per-set TTL):
            file-pure  read/peek/outline/symbols/search(file)   key:+file mtime          ttl 5m
            dir-shaped tree/glob/search(dir)                     key:dir+args             ttl 20s
            lsp-point  def/hover                                 key:+file mtime          ttl 60s
            lsp-proj   refs/wsymbol/diagnostics                  key:(root,generation)    ttl 30s
            subprocess ast_grep(search)/git_view                 key:git HEAD+index mtime ttl 30s
            dep_audit                                            key:lockfile hash        ttl 1h
            NEVER: edit/write/rename/action/test_run/ast_grep(apply)/any ok:false envelope
        - mutations: bypass, bump generation, evict touched-path intersections
        - cooldown map (plain Map, NOT in lru-cache): fingerprint→ts, cooldownMs window, 1k FIFO cap (L9);
          identical failing fingerprint in window → {ok:false, notes:"retry-after", recovery:{cooldown:true}}
        - try/catch every get/set → bypass on cache error; FORGE_CACHE=0 kill switch
    - core/watcher.ts (NEW):
        - @parcel/watcher.subscribe(root, cb, {ignore: watch.ignore}) on first LSP proc per root; unsubscribe on root reap (L10)
        - debounce watch.debounceMs batch → per-path eviction (file-pure/dir-shaped/subprocess classes) + generation bump + schedule LSP didChange resync for open files
        - batch > watch.coarseThreshold paths → COARSE MODE: flush all entries for root, single generation bump (DA-W2)
        - AUTHORITY INVARIANT (DA-S2): events accelerate eviction only; fingerprint mtime-keys remain sole correctness layer
        - failure → supervisor 1-restart → stat-degradation; /stats invalidation:"events"|"stat" per root
        - FORGE_WATCH=0 / watch.enabled=false / M0 fail → dormant, stat path active
  verify:
    - repeat read → hit + ttl_remaining; edit → lsp-proj entries evicted (generation gate)
    - 10k flood incl >2MB entries → oversize rejected, calculatedSize ≤ maxBytes
    - cooldown: identical fail ×2 in window → blocked; mutate between → passes; errors never cached
    - EXTERNAL edit (touch file outside daemon) → dir-shaped/lsp-proj entries evicted within 1s (event gate)
    - storm: touch 1k files → coarse flush fires once, RSS stable, JS thread responsive (DA-W2 gate)
    - watcher killed → stat mode; stale data never served (fingerprint authority gate)
  on_fail: "FORGE_CACHE=0 and/or FORGE_WATCH=0 defaults; server fully functional"
  rollback: "same flags"
```

## M6 — Tool Port (4 tools) + ast-grep/napi Routing + Security Planes

```yaml
M6:
  port_sources:
    - reference_files/tools/ast-grep.ts  → tools/ast-grep.ts   (+napi routing)
    - reference_files/tools/git-view.ts  → tools/git-view.ts
    - reference_files/tools/test-run.ts  → tools/test-run.ts
    - reference_files/tools/dep-audit.ts → tools/dep-audit.ts
  build:
    - port pattern: @opencode-ai/plugin tool() → per-session registerTool; context.directory → root param + roots/list fallback; zod shapes reused
    - ast_grep ENGINE ROUTING MATRIX (DA-N2) — applies only if M0 napi=pass AND ast.napi=true:
        ts/tsx/js/jsx        → @ast-grep/napi (findInFiles ONLY — deep SgNode traversal banned in hot paths, DA-N3)
        py/rs/go             → napi IFF matching @ast-grep/lang-* in ast.langPackages, else CLI sg
        all other langs      → CLI sg → ripgrep floor
        sg binary absent     → napi still answers its langs; ripgrep answers the rest; LOUD engine/notes attribution
        engine field values  → "ast-napi" | "ast-cli" | "ripgrep"
    - ast_grep apply=true via napi: edits produced IN-MEMORY (commitEdits) → routed through forge guarded writer
      (mutex + expect + atomic rename + backoff). The binding NEVER touches disk directly (DA-N4). CLI --update-all fallback unchanged
    - fold Session-13 fixes: loud sg-missing degradation; git-view command-hint refusals;
      test-run Jest --onlyFailures (vitest gap documented); dep-audit EOFFLINE + network_calls + upfront warning
    - annotations: git_view/dep_audit readOnlyHint; ast_grep destructiveHint (apply gated); test_run destructiveHint(fix)
    - test_run: AbortSignal ↔ MCP cancellation; NEVER cached
    - server-side .env plane across all 6 tools; .env.example|sample|template allowlist
    - per-client profiles: clientInfo.name → profiles → filtered registration (DA7)
  verify:
    - per-tool output parity vs OpenCode originals
    - routing: TS pattern w/ sg REMOVED from PATH → engine:"ast-napi" answers; py pattern same condition → engine:"ripgrep" + loud note
    - napi apply → write goes through mutex+expect (instrumented check); stale expect → refused
    - .env attempts from foreign client → refused (all 6); claude-ai profile → 3 tools only; mid-run cancellation kills test child
  on_fail: "per-tool independent rollback; FORGE_NAPI=0 collapses routing to CLI-primary (v4 behavior)"
```

## M7 — Integration, Cutover, Deliverables

```yaml
M7:
  build:
    - host snippets delivered (USER applies; paths are machine-specific — never auto-normalize):
        opencode.json  mcp.forge: {type:"local", command:["bun","<repo>/stdio-proxy.ts"], enabled:false}
        claude_desktop_config.json: same command shape
        cursor/claude-code: type:"http" direct-to-daemon variants (proxy-less where supported)
    - RUNBOOK.md (F6): stale lock, port conflict, zombie daemon, circuit + invalidation-mode diagnosis via /stats,
      full reset (kill → delete %LOCALAPPDATA%\forge-mcp → reconnect), FORGE_EMBEDDED=1, FORGE_NAPI=0, FORGE_WATCH=0
    - SESSION-CHANGELOG.md entry incl. M0 bindingStatus
    - test/ finalized as permanent bun test target (F5): parity, soak, security gates, backpressure, cooldown, event-invalidation, routing
  cutover_protocol:
    1. user flips forge enabled:true (nav still on)
    2. full 10-category live matrix from TWO hosts concurrently
    3. green → user disables nav entry in same edit; forge sole provider
    4. red → flip back, file findings, forge stays disabled
  done_definition:
    - [ ] all M0–M7 gates green
    - [ ] zero envelope regressions vs nav-mcp parity suite (15 modes)
    - [ ] two hosts sharing one vtsls confirmed via process count
    - [ ] circuit-breaker live; cache hit-rate + invalidation mode in /stats
    - [ ] external-edit eviction <1s demonstrated (or stat-mode documented if M0 watcher=fail)
    - [ ] ast_grep answers TS with sg binary absent (or CLI-primary documented if M0 napi=fail)
    - [ ] .env refused from non-OpenCode host; Origin 403 verified
    - [ ] RSS soak <15% across full suite
    - [ ] daemon.json + token exist ONLY under %LOCALAPPDATA%; repo `git status` clean after full run
    - [ ] opencode.json byte-identical except user-applied entry
    - [ ] bun test green; RUNBOOK.md present; pins exact; bun.lock committed
```

## 4 · Residual-Risk Ledger (accepted, final)

| Risk | Disposition |
|---|---|
| Bun N-API edge cases on future Bun upgrades | M0 spike re-run is mandatory after ANY Bun version bump; kill-switches FORGE_NAPI/FORGE_WATCH |
| No SSE event-store resumption v1 | Proxy respawn+re-init covers; revisit with 2026-07-28 stateless spec migration |
| Staleness on lsp-proj caches | ≈ debounceMs (100ms) under events; 30s TTL bound only in stat-degraded mode |
| Defender lock >3s on rename | Clean failure, fingerprint intact, retry safe |
| vitest headless last-failed gap | Upstream; documented in tool notes |
| sizeCalculation = payload chars ≠ V8 retained bytes | Soak gate is the hard bound |
| MCP spec 2026-07-28 breaking changes | Exact-pinned SDK; deliberate future migration session |
| napi lang packages drift vs CLI version | Lang packages exact-pinned to 0.43.x family with @ast-grep/napi; bump together or not at all |
