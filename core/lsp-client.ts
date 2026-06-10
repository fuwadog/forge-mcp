/**
 * core/lsp-client.ts — M3 LSP Concurrency Layer for forge-mcp
 *
 * Ported from nav-mcp/core/lsp-client.ts with forge-mcp M3 adaptations:
 *   - (root, lang)-keyed pool with global LRU eviction
 *   - Refcounted didOpen/didClose with session tracking
 *   - Shared diagnostic cache + fan-out waiters with per-waiter timeout
 *   - Configurable via forge.json (lsp.* fields)
 *   - vtsls init: typescript.tsserver.maxTsServerMemory
 *   - 2s initialize, 5s other requests, 60s idle sweep
 *
 * Design rules:
 *  - Never throw: all exported functions return degraded values on error
 *  - No imports outside Bun built-ins + Node/Bun APIs
 *  - Warm process: spawn once, reuse; restart on crash or timeout
 *  - Self-contained: does NOT import from core/index.ts
 */

import { existsSync, readFileSync, realpathSync } from "fs"
import { join, extname } from "path"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WarmProc {
  rootUri: string
  lang: string
  alive: boolean
  process: ReturnType<typeof Bun.spawn>
  /** internal fields for M3 concurrency */
  _proc: ReturnType<typeof Bun.spawn>
  _pending: Map<number, PendingRequest>
  _nextId: number
  _buffer: string
  _dead: boolean
  _lastUsed: number
  _serverCapabilities: Record<string, unknown>
  _root: string
}

export interface LspClient {
  getClient(root: string, lang: string): Promise<WarmProc | null>
  hasWarmClient(root: string, lang: string): boolean
  shutdown(): Promise<void>
  waitForDiagnostics(uri: string, timeoutMs: number): Promise<any>
  getCachedDiagnostics(uri: string): any[]
  // M3 additions
  didOpen(uri: string, content: string, lang: string, root: string, sid: string): void
  didClose(uri: string, sid: string): void
  didChange(uri: string, content: string): void
}

// ── Internal types ─────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface OpenedFileEntry {
  refcount: number
  sessions: Set<string>
  mtimeAtOpen: number
  languageId: string
}

interface DiagnosticWaiter {
  sid: string
  resolve: (diags: unknown[]) => void
  timer: ReturnType<typeof setTimeout>
}

interface LspConfig {
  lruCap?: number
  idleReapMin?: number
  tsMaxMemoryMb?: number
}

// ── Config loading ─────────────────────────────────────────────────────────────

function loadLspConfig(): LspConfig {
  try {
    const cfgPath = join(import.meta.dir, "..", "forge.json")
    if (existsSync(cfgPath)) {
      const raw = JSON.parse(readFileSync(cfgPath, "utf-8"))
      return raw?.lsp ?? {}
    }
  } catch { /* config errors fall back to defaults — never kill the daemon */ }
  return {}
}

const _cfg = loadLspConfig()
const LRU_CAP: number = Math.max(1, _cfg.lruCap ?? 5)
const IDLE_REAP_MS: number = Math.max(60_000, (_cfg.idleReapMin ?? 5) * 60_000)
const TS_MAX_MEMORY_MB: number = Math.max(1024, _cfg.tsMaxMemoryMb ?? 3072)

// ── Constants ──────────────────────────────────────────────────────────────────

const INIT_TIMEOUT_MS = 2_000
const REQUEST_TIMEOUT_MS = 5_000
const REAP_SWEEP_MS = 60_000

// ── Secret guard (mirrors core/index.ts + env-sitter plugin) ──────────────────
// Never let an LSP server didOpen a .env file. Allow only the public templates.
const SECRET_RE = /(^|[\\/])\.env(\b|\.)/i
const SECRET_ALLOW_RE = /\.env\.(example|sample|template)$/i
function isSecretPath(p?: string): boolean {
  return !!p && SECRET_RE.test(p) && !SECRET_ALLOW_RE.test(p)
}

// ── file:// URI helpers ───────────────────────────────────────────────────────
// A Windows path must serialize as file:///C:/... (the drive sits in the PATH,
// not the host). The buggy file://C:/... form makes URL parsing treat "C:" as
// the host, so didOpen reads an empty file and the server returns nothing.
function pathToFileUri(p: string): string {
  const norm = p.replace(/\\/g, "/")
  return norm.startsWith("/") ? `file://${norm}` : `file:///${norm}`
}

function fileUriToPath(uri: string): string {
  let p = uri
  try { p = decodeURIComponent(uri) } catch { /* keep raw */ }
  p = p.replace(/^file:\/\//, "")
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)  // strip leading slash before a Windows drive
  return p
}

// ── Win32 shim-safe spawn ─────────────────────────────────────────────────────
// On Windows, resolve the binary via PATHEXT. A .cmd/.bat shim (e.g. bun-global
// language servers) must be run through cmd.exe; a real .exe (e.g. marksman) is
// spawned directly. Non-win32 passes through untouched.
function resolveSpawn(cmd: string[]): string[] {
  if (process.platform !== "win32") return cmd
  const bin = Bun.which(cmd[0])
  if (bin && /\.(cmd|bat)$/i.test(bin)) return ["cmd.exe", "/d", "/s", "/c", ...cmd]
  return bin ? [bin, ...cmd.slice(1)] : cmd
}

// ── Minimal helpers (inline — cannot import from core/index.ts) ───────────────

async function _runBounded(cmd: string[], timeoutMs = 4_000): Promise<{ code: number | null; out: string }> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn({ cmd, cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
  } catch {
    return { code: null, out: "" }
  }
  const timer = new Promise<"t">((r) => setTimeout(() => { try { proc.kill() } catch { /**/ } r("t") }, timeoutMs))
  const res = await Promise.race([proc.exited, timer])
  const out = await new Response(proc.stdout).text().catch(() => "")
  return { code: res === "t" ? null : (res as number), out }
}

async function _which(bin: string): Promise<boolean> {
  const probe = process.platform === "win32" ? ["where", bin] : ["bash", "-lc", `command -v ${bin}`]
  const r = await _runBounded(probe, 4_000)
  return r.code === 0 && r.out.trim().length > 0
}

function _timeout<T>(ms: number): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`LSP op timeout after ${ms}ms`)), ms))
}

// ── JSON-RPC framing ──────────────────────────────────────────────────────────

function _frame(msg: unknown): Uint8Array {
  const body = JSON.stringify(msg)
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`
  return Buffer.from(header + body, "utf8")
}

function _send(wp: WarmProc, msg: unknown): void {
  if (wp._dead) return
  try {
    const bytes = _frame(msg)
    wp._proc.stdin!.write(bytes)
  } catch {
    // If stdin is gone the process is dead; crash recovery handles it
  }
}

function _notify(wp: WarmProc, method: string, params: unknown): void {
  _send(wp, { jsonrpc: "2.0", method, params })
}

function _request(wp: WarmProc, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  if (wp._dead) return Promise.reject(new Error("process dead"))
  const id = wp._nextId++
  const msg = { jsonrpc: "2.0", id, method, params }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      wp._pending.delete(id)
      reject(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    wp._pending.set(id, { resolve, reject, timer })
    _send(wp, msg)
  })
}

// Parse Content-Length framed messages from a text buffer.
// Returns { messages: parsed[], remaining: string }
function _parseMessages(buf: string): { messages: unknown[]; remaining: string } {
  const messages: unknown[] = []
  let pos = 0

  while (pos < buf.length) {
    // Look for header terminator
    const headerEnd = buf.indexOf("\r\n\r\n", pos)
    if (headerEnd === -1) break  // need more data

    const header = buf.slice(pos, headerEnd)
    const clMatch = header.match(/Content-Length:\s*(\d+)/i)
    if (!clMatch) {
      // Malformed header — skip to next header
      pos = headerEnd + 4
      continue
    }

    const contentLength = parseInt(clMatch[1], 10)
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + contentLength

    if (bodyEnd > buf.length) break  // incomplete body, wait for more

    const bodyText = buf.slice(bodyStart, bodyEnd)
    try {
      messages.push(JSON.parse(bodyText))
    } catch {
      // Malformed JSON — skip
    }
    pos = bodyEnd
  }

  return { messages, remaining: buf.slice(pos) }
}

// ── Extension → language mapping ──────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ".ts":       "typescript",
  ".tsx":      "typescript",
  ".js":       "typescript",
  ".jsx":      "typescript",
  ".py":       "python",
  ".pyi":      "python",
  ".rs":       "rust",
  ".go":       "go",
  ".md":       "markdown",
  ".markdown": "markdown",
  ".yaml":     "yaml",
  ".yml":      "yaml",
  ".sh":       "bash",
  ".bash":     "bash",
}

// ── Language ID for didOpen ───────────────────────────────────────────────────

function _langIdForExt(ext: string): string {
  switch (ext) {
    case ".ts":       return "typescript"
    case ".tsx":      return "typescriptreact"
    case ".js":       return "javascript"
    case ".jsx":      return "javascriptreact"
    case ".py":
    case ".pyi":      return "python"
    case ".rs":       return "rust"
    case ".go":       return "go"
    case ".md":
    case ".markdown": return "markdown"
    case ".yaml":
    case ".yml":      return "yaml"
    case ".sh":
    case ".bash":     return "shellscript"
    default:          return "plaintext"
  }
}

// ── Language → LSP server command ─────────────────────────────────────────────

async function _resolveCommand(lang: string): Promise<string[] | null> {
  switch (lang) {
    case "typescript":
      if (await _which("vtsls")) return ["vtsls", "--stdio"]
      return null

    case "python":
      if (await _which("ty")) return ["ty", "lsp"]
      if (await _which("pyright-langserver")) return ["pyright-langserver", "--stdio"]
      return null

    case "rust":
      if (await _which("rust-analyzer")) return ["rust-analyzer"]
      return null

    case "go":
      if (await _which("gopls")) return ["gopls", "serve"]
      return null

    case "markdown":
      if (await _which("marksman")) return ["marksman", "server"]
      return null

    case "yaml":
      if (await _which("yaml-language-server")) return ["yaml-language-server", "--stdio"]
      return null

    case "bash":
      if (await _which("bash-language-server")) return ["bash-language-server", "start"]
      return null

    default:
      return null
  }
}

// ── Pool: (root, lang)-keyed warm processes ───────────────────────────────────

// Global pool keyed by "${realRoot}::${lang}"
const pool = new Map<string, WarmProc | null>()

// Reverse lookup: WarmProc → pool key (for quick cleanup)
const procToKey = new Map<WarmProc, string>()

// LRU tracking: pool key → lastUsed timestamp (updated on each use)
const lruOrder = new Map<string, number>()

function _poolKey(root: string, lang: string): string {
  // Normalize root via realpathSync for consistent keys across symlinks / casing
  let realRoot = root
  try { realRoot = realpathSync(root) } catch { /* fall back to raw root */ }
  return `${realRoot}::${lang}`
}

// ── Shared diagnostic state ───────────────────────────────────────────────────

// Shared file-truth cache: URI → diagnostics array
const diagnosticCache = new Map<string, unknown[]>()

// Fan-out waiters: URI → Set<DiagnosticWaiter>
const diagnosticWaiters = new Map<string, Set<DiagnosticWaiter>>()

// ── Refcounted open-file tracking ─────────────────────────────────────────────

// Per-WarmProc: URI → OpenedFileEntry
const openedFiles = new Map<WarmProc, Map<string, OpenedFileEntry>>()

// ── Spawn + initialize ────────────────────────────────────────────────────────

async function _spawnWarm(lang: string, root: string): Promise<WarmProc | null> {
  const cmd = await _resolveCommand(lang)
  if (!cmd) return null

  // Inject vtsls max memory setting via initOptions
  const isVtsls = cmd[0] === "vtsls"

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn({
      cmd: resolveSpawn(cmd),
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch {
    return null
  }

  const rootUri = pathToFileUri(root)
  const wp: WarmProc = {
    rootUri,
    lang,
    alive: true,
    process: proc,
    _proc: proc,
    _pending: new Map(),
    _nextId: 1,
    _buffer: "",
    _dead: false,
    _lastUsed: Date.now(),
    _serverCapabilities: {},
    _root: root,
  }

  // Watch for process death
  proc.exited.then(() => {
    wp._dead = true
    wp.alive = false
    // Reject all pending requests
    for (const [, pending] of wp._pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error("LSP process exited unexpectedly"))
    }
    wp._pending.clear()
    // Mark for restart in the pool
    const key = procToKey.get(wp)
    if (key) pool.set(key, null)
    procToKey.delete(wp)
  }).catch(() => {
    wp._dead = true
    wp.alive = false
    const key = procToKey.get(wp)
    if (key) pool.set(key, null)
    procToKey.delete(wp)
  })

  // Read stdout and dispatch messages
  ;(async () => {
    try {
      const reader = proc.stdout!.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        wp._buffer += decoder.decode(value, { stream: true })
        const { messages, remaining } = _parseMessages(wp._buffer)
        wp._buffer = remaining
        for (const msg of messages) {
          _dispatchMessage(wp, msg as Record<string, unknown>)
        }
      }
    } catch {
      // stream ended
    }
  })()

  // Send initialize request
  try {
    const initParams: Record<string, unknown> = {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
          },
          hover: { dynamicRegistration: false },
          publishDiagnostics: {},
        },
      },
      workspaceFolders: [{ uri: rootUri, name: root }],
    }

    // vtsls-specific: set maxTsServerMemory
    if (isVtsls) {
      initParams.initializationOptions = {
        typescript: {
          tsserver: {
            maxTsServerMemory: TS_MAX_MEMORY_MB,
          },
        },
      }
    }

    const initResult = await Promise.race([
      _request(wp, "initialize", initParams, INIT_TIMEOUT_MS),
      _timeout<unknown>(INIT_TIMEOUT_MS),
    ])

    if (!initResult) {
      wp._dead = true
      wp.alive = false
      try { proc.kill() } catch { /**/ }
      return null
    }

    // Store server capabilities
    const initRes = initResult as Record<string, unknown>
    wp._serverCapabilities = (initRes.capabilities as Record<string, unknown>) ?? {}

    // Send initialized notification
    _notify(wp, "initialized", {})
  } catch {
    wp._dead = true
    wp.alive = false
    try { proc.kill() } catch { /**/ }
    return null
  }

  return wp
}

// ── Message dispatch ──────────────────────────────────────────────────────────

function _dispatchMessage(wp: WarmProc, msg: Record<string, unknown>): void {
  // Responses have an `id` field
  if (msg.id !== undefined && typeof msg.id === "number") {
    const pending = wp._pending.get(msg.id)
    if (pending) {
      wp._pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.error) {
        pending.reject(new Error(JSON.stringify(msg.error)))
      } else {
        pending.resolve(msg.result)
      }
    }
    return
  }

  // Handle textDocument/publishDiagnostics notifications
  if (msg.method === "textDocument/publishDiagnostics") {
    const params = msg.params as { uri?: string; diagnostics?: unknown[] } | undefined
    if (params?.uri) {
      const diags = params.diagnostics ?? []

      // Update shared diagnostic cache
      diagnosticCache.set(params.uri, diags)

      // Fan out to ALL waiters for this URI
      const waiters = diagnosticWaiters.get(params.uri)
      if (waiters && waiters.size > 0) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer)
          waiter.resolve(diags)
        }
        diagnosticWaiters.delete(params.uri)
      }
    }
    return
  }

  // Other notifications ignored (window/logMessage, etc.)
}

// ── Kill a process and clean up ───────────────────────────────────────────────

function _killProc(wp: WarmProc): void {
  wp._dead = true
  wp.alive = false
  for (const [, pending] of wp._pending) {
    clearTimeout(pending.timer)
    pending.reject(new Error("LSP process reaped"))
  }
  wp._pending.clear()
  try { wp._proc.kill() } catch { /**/ }
  openedFiles.delete(wp)

  const key = procToKey.get(wp)
  if (key) {
    pool.set(key, null)
    lruOrder.delete(key)
  }
  procToKey.delete(wp)

  // Drain all waiters for files owned by this proc → diagnostics_pending
  // (The diagnostics will come from another proc if one exists, or timeout handles it)
}

// ── LRU eviction ──────────────────────────────────────────────────────────────

function _evictLRU(): void {
  const live: Array<[string, WarmProc]> = []
  for (const [key, wp] of pool) {
    if (wp && !wp._dead) live.push([key, wp])
  }
  while (live.length > LRU_CAP) {
    // Sort by lastUsed ascending (oldest first)
    live.sort((a, b) => (lruOrder.get(a[0]) ?? 0) - (lruOrder.get(b[0]) ?? 0))
    const [oldestKey, oldestWp] = live.shift()!
    _killProc(oldestWp)
  }
}

// ── Idle sweep ────────────────────────────────────────────────────────────────
// Reap any warm process untouched for IDLE_REAP_MS. Runs every 60s and
// is unref'd so it never keeps the MCP process alive on its own.
const _sweep = setInterval(() => {
  const now = Date.now()
  for (const [key, wp] of pool) {
    if (wp && !wp._dead && now - wp._lastUsed > IDLE_REAP_MS) {
      _killProc(wp)
    }
  }
}, REAP_SWEEP_MS)
if (typeof _sweep === "object" && typeof (_sweep as any).unref === "function") (_sweep as any).unref()

// ── Get or spawn a warm process ───────────────────────────────────────────────

async function _getWarmProc(lang: string, root: string): Promise<WarmProc | null> {
  const key = _poolKey(root, lang)
  const existing = pool.get(key)
  if (existing !== undefined) {
    // null means previously tried and failed/died — retry spawn
    if (existing !== null && !existing._dead) {
      existing._lastUsed = Date.now()
      lruOrder.set(key, Date.now())
      return existing
    }
  }

  // Spawn fresh
  pool.set(key, null)  // sentinel while spawning
  const wp = await _spawnWarm(lang, root)
  pool.set(key, wp)
  if (wp) {
    wp._lastUsed = Date.now()
    lruOrder.set(key, Date.now())
    procToKey.set(wp, key)
    _evictLRU()  // bound the live-server count
  }
  return wp
}

// ── Refcounted didOpen / didClose ─────────────────────────────────────────────

function _ensureFileEntry(wp: WarmProc, fileUri: string, languageId: string, sid: string, content?: string): void {
  let fileMap = openedFiles.get(wp)
  if (!fileMap) {
    fileMap = new Map()
    openedFiles.set(wp, fileMap)
  }

  const existing = fileMap.get(fileUri)
  if (existing) {
    // Already opened — bump refcount if new session
    if (!existing.sessions.has(sid)) {
      existing.refcount++
      existing.sessions.add(sid)
    }
    return
  }

  // First open: send textDocument/didOpen
  const text = content ?? ""
  _notify(wp, "textDocument/didOpen", {
    textDocument: {
      uri: fileUri,
      languageId,
      version: 1,
      text,
    },
  })

  fileMap.set(fileUri, {
    refcount: 1,
    sessions: new Set([sid]),
    mtimeAtOpen: Date.now(),
    languageId,
  })
}

async function _ensureFileOpen(wp: WarmProc, fileUri: string, languageId: string): Promise<void> {
  // Secret guard: never hand a .env file to any LSP server
  let decoded = fileUri
  try { decoded = decodeURIComponent(fileUri) } catch { /* keep raw */ }
  if (isSecretPath(decoded)) return Promise.resolve()

  // Check if already opened on this proc
  const fileMap = openedFiles.get(wp)
  if (fileMap?.has(fileUri)) return Promise.resolve()

  // Read file content and open
  let text = ""
  try {
    const filePath = fileUriToPath(fileUri)
    text = await Bun.file(filePath).text()
  } catch {
    // File unreadable — send empty text, LSP will deal
  }

  _notify(wp, "textDocument/didOpen", {
    textDocument: {
      uri: fileUri,
      languageId,
      version: 1,
      text,
    },
  })

  let fileMap2 = openedFiles.get(wp)
  if (!fileMap2) {
    fileMap2 = new Map()
    openedFiles.set(wp, fileMap2)
  }
  fileMap2.set(fileUri, {
    refcount: 1,
    sessions: new Set(),
    mtimeAtOpen: Date.now(),
    languageId,
  })

  return Promise.resolve()
  return Promise.resolve()
}

// ── Exported API ──────────────────────────────────────────────────────────────

export function createLspClient(): LspClient {
  // Proxy that delegates getClient/hasWarmClient per root+ext
  const proxyClient: LspClient = {
    async getClient(root: string, lang: string): Promise<WarmProc | null> {
      const ext = lang.startsWith(".") ? lang : ""
      const mappedLang = EXT_TO_LANG[ext.toLowerCase()] ?? ""
      if (!mappedLang) return null
      return await _getWarmProc(mappedLang, root)
    },

    hasWarmClient(root: string, lang: string): boolean {
      const ext = lang.startsWith(".") ? lang : ""
      const mappedLang = EXT_TO_LANG[ext.toLowerCase()] ?? ""
      if (!mappedLang) return false
      const key = _poolKey(root, mappedLang)
      const wp = pool.get(key)
      return !!(wp && !wp._dead)
    },

    async shutdown(): Promise<void> {
      for (const [key, wp] of pool) {
        if (wp && !wp._dead) {
          try {
            _notify(wp, "shutdown", null)
            _notify(wp, "exit", null)
          } catch { /**/ }
          try { wp._proc.kill() } catch { /**/ }
        }
      }
      pool.clear()
      lruOrder.clear()
      procToKey.clear()
      openedFiles.clear()
      diagnosticCache.clear()
      for (const [, waiters] of diagnosticWaiters) {
        for (const w of waiters) {
          clearTimeout(w.timer)
          w.resolve([])
        }
      }
      diagnosticWaiters.clear()
      clientCache.clear()
    },

    async waitForDiagnostics(uri: string, timeoutMs: number): Promise<any> {
      if (diagnosticCache.has(uri)) {
        return { diagnostics: diagnosticCache.get(uri)!, pending: false }
      }

      return new Promise<any>((resolve) => {
        const waiter: DiagnosticWaiter = {
          sid: "",
          resolve: (diags: unknown[]) => resolve({ diagnostics: diags, pending: false }),
          timer: setTimeout(() => {
            const set = diagnosticWaiters.get(uri)
            if (set) {
              for (const w of set) {
                if (w === waiter) { set.delete(waiter); break }
              }
              if (set.size === 0) diagnosticWaiters.delete(uri)
            }
            resolve({ diagnostics: [], pending: true })
          }, timeoutMs),
        }

        let set = diagnosticWaiters.get(uri)
        if (!set) {
          set = new Set()
          diagnosticWaiters.set(uri, set)
        }
        set.add(waiter)
      })
    },

    getCachedDiagnostics(uri: string): any[] {
      return diagnosticCache.get(uri) ?? []
    },

    didOpen(uri: string, content: string, lang: string, root: string, sid: string): void {
      try {
        const ext2 = extname(fileUriToPath(uri))
        const languageId = _langIdForExt(ext2)
        const mappedLang = EXT_TO_LANG[ext2.toLowerCase()] ?? lang
        _getWarmProc(mappedLang, root).then((wp) => {
          if (!wp || wp._dead) return
          let decoded = uri
          try { decoded = decodeURIComponent(uri) } catch { /* keep raw */ }
          if (isSecretPath(decoded)) return
          _ensureFileEntry(wp, uri, languageId, sid, content)
        }).catch(() => { /* non-fatal */ })
      } catch { /* never throw */ }
    },

    didClose(uri: string, sid: string): void {
      try {
        for (const [wp, fileMap] of openedFiles) {
          const entry = fileMap.get(uri)
          if (entry && entry.sessions.has(sid)) {
            entry.sessions.delete(sid)
            entry.refcount--
            if (entry.refcount <= 0) {
              fileMap.delete(uri)
              _notify(wp, "textDocument/didClose", {
                textDocument: { uri },
              })
            }
            break
          }
        }
      } catch { /* never throw */ }
    },

    didChange(uri: string, content: string): void {
      try {
        for (const [wp, fileMap] of openedFiles) {
          const entry = fileMap.get(uri)
          if (entry) {
            _notify(wp, "textDocument/didChange", {
              textDocument: { uri, version: Date.now() },
              contentChanges: [{ text: content }],
            })
            diagnosticCache.delete(uri)
            break
          }
        }
      } catch { /* never throw */ }
    },
  }

  return proxyClient
}
