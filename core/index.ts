/**
 * FORGE core — the dispatch engine behind forge-mcp.
 *
 * Ported from nav-mcp/core/index.ts with forge-mcp adaptations:
 *   - LSP stub (M2) instead of real client (M3 will rewrite)
 *   - No ROOT global — root comes from req.root or cwd
 *   - F2 path guard middleware before locate healing
 *   - Extended NavEnvelope with cache/recovery fields
 *   - Extra mode: glob (file finder by pattern)
 *
 * Contract: dispatch(req) NEVER throws — it returns a degraded envelope.
 *
 * Read modes : tree | outline | symbols | read | peek | search | glob | def | refs | hover | diagnostics | wsymbol
 * Write modes: edit | write | rename | action (write side honors `expect` stale-guard)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "fs"
import { resolve, dirname, join, relative, extname } from "path"
import { locate, toPosix } from "./locate.js"
import { createLspClient } from "./lsp-client.js"
import { hasFileOperations, applyWorkspaceEdit } from "./workspace-edit.js"
import { tsOutline } from "./treesitter.js"
import { runBounded as runBoundedLib } from "../lib/withTimeout.js"

// ── LSP client instance (M2 stub — M3 rewrites to real client) ─────────────
const lspClient = createLspClient()

// ── types ──────────────────────────────────────────────────────────────────
export type NavRequest = Record<string, unknown> & { mode: string; root?: string }
export interface NavEnvelope {
  ok: boolean
  mode: string
  path?: string
  budget_source: "env" | "config" | "default" | "floor"
  truncated: boolean
  fingerprint?: string
  anchor?: string
  total_lines?: number
  next?: string | null
  outline?: string
  matches?: string[]
  notes?: string
  engine?: string  // for symbols mode: "lsp" | "ctags" | "regex" | "none"
  partial?: boolean              // wsymbol: results were capped at `limit`
  diagnostics?: unknown[]        // post-edit enrichment (edit/write) + diagnostics mode
  diagnostics_pending?: boolean  // true = server hasn't finished analyzing yet
  files_changed?: number         // rename/action scope=lsp
  total_edits?: number           // rename/action scope=lsp
  scope?: string                 // rename: "file" | "lsp"
  applied_title?: string         // action: title of the applied code action
  cache?: { hit: boolean; fingerprint: string; ttl_remaining_ms: number }
  recovery?: { attempted?: boolean; corrected_params?: any; restarts?: number; cooldown?: boolean }
  payload: string
}

// ── secret guard (subagent-proof at the nav layer) ────────────────────────────
// Mirrors plugins/env-sitter.ts + nav-mcp/core/lsp-client.ts. nav must refuse to
// read/peek/search/edit/write/def/refs/hover any .env* file, even when a subagent
// drives it directly (plugin hooks don't intercept subagent tool calls — #5894).
// Allow only the public templates: .env.example|sample|template.
const ENV_RE = /(^|[\\\/])\.env(\b|\.)/i
const ENV_OK = /\.env\.(example|sample|template)$/i
const isSecretPath = (p?: string): boolean => !!p && ENV_RE.test(p) && !ENV_OK.test(p)

// A Windows abs path serializes as file:///C:/... (drive in the path, not host).
// The file://C:/... form makes the LSP server treat "C:" as the host -> no result.
function pathToFileUri(abs: string): string {
  const norm = abs.replace(/\\/g, "/")
  return norm.startsWith("/") ? `file://${norm}` : `file:///${norm}`
}

const IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".output", ".next",
  "coverage", ".venv", "venv", "target", ".turbo", ".cache", "__pycache__",
])
const OUTLINE_RE =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(public\s+|private\s+|protected\s+)?(function|func|def|class|interface|type|enum|struct|fn|impl|const|module|namespace)\b/

// ── budget ───────────────────────────────────────────────────────────────────
// "env" when NAV_MAX_SLICE/NAV_MAX_CONTEXT is set, "config" when the caller
// passed max_context, else "default". Never "floor" — that is reserved by
// nav-mcp/index.ts for the unbound-core degrade path, and the install probe
// treats it as a binding failure.
function budget(req: NavRequest): { cap: number; source: NavEnvelope["budget_source"] } {
  if (process.env.NAV_MAX_SLICE || process.env.NAV_MAX_CONTEXT) {
    return { cap: Number(process.env.NAV_MAX_SLICE ?? process.env.NAV_MAX_CONTEXT), source: "env" }
  }
  if (typeof req.max_context === "number" && req.max_context > 0) {
    return { cap: req.max_context as number, source: "config" }
  }
  return { cap: 120_000, source: "default" }
}

function fingerprint(content: string): string {
  return `${content.length}:${Bun.hash(content).toString(16)}`
}

function degraded(mode: string, notes: string, src: NavEnvelope["budget_source"] = "default"): NavEnvelope {
  return { ok: false, mode, budget_source: src, truncated: true, notes, payload: "" }
}

// ── F2 path guard (must run BEFORE locate healing) ───────────────────────────
// Canonical+realpath path jail — ensures resolved path stays within project root.
function pathGuard(root: string, filePath: string): { ok: boolean; error?: string } {
  try {
    const resolved = resolve(root, filePath)
    const real = realpathSync(resolved)
    const rootReal = realpathSync(root)
    if (!real.startsWith(rootReal)) {
      return { ok: false, error: `Path escapes project root: ${filePath}` }
    }
  } catch {
    // If realpath fails (e.g., file doesn't exist yet), allow it.
    // The locate function will handle the "not found" case.
  }
  return { ok: true }
}

// ── bounded subprocess wrapper ──────────────────────────────────────────────
// Adapts the lib/withTimeout.ts runBounded to the simpler { code, out, err }
// shape expected by the rest of this module.
async function runBoundedCmd(
  cmd: string[],
  cwd: string,
  timeoutMs = 15_000,
): Promise<{ code: number | null; out: string; err: string }> {
  const result = await runBoundedLib(cmd, { cwd, timeoutMs })
  if (!result.ok) {
    return { code: null, out: "", err: result.notes ?? "runBounded failed" }
  }
  return {
    code: result.payload?.code ?? null,
    out: result.payload?.stdout ?? "",
    err: result.payload?.stderr ?? "",
  }
}

async function which(bin: string): Promise<boolean> {
  const probe = process.platform === "win32" ? ["where", bin] : ["bash", "-lc", `command -v ${bin}`]
  const r = await runBoundedCmd(probe, process.cwd(), 4_000)
  return r.code === 0 && r.out.trim().length > 0
}

// ── outline (ctags -> regex fallback) ────────────────────────────────────────
async function outlineOf(abs: string): Promise<string> {
  if (await which("ctags")) {
    const r = await runBoundedCmd(["ctags", "-x", "--sort=no", abs], process.cwd())
    if (r.code === 0 && r.out.trim()) {
      return r.out.trim().split(/\r?\n/).map((l) => {
        const m = l.match(/^(\S+)\s+(\S+)\s+(\d+)/)
        return m ? `${m[3].padStart(5)}  ${m[2].padEnd(11)} ${m[1]}` : l
      }).join("\n")
    }
  }
  // regex fallback
  let raw = ""
  try { raw = readFileSync(abs, "utf8") } catch { return "" }
  const hits: string[] = []
  raw.split(/\r?\n/).forEach((line, i) => {
    if (OUTLINE_RE.test(line)) hits.push(`${String(i + 1).padStart(5)}  ${line.trim().slice(0, 100)}`)
  })
  return hits.join("\n")
}

// Find a symbol's 1-based start line from an outline blob (for peek #symbol).
function lineOfSymbol(outline: string, symbol: string): number | null {
  for (const l of outline.split("\n")) {
    const m = l.match(/^\s*(\d+)\s+\S+\s+(.+)$/) || l.match(/^\s*(\d+)\s+(.+)$/)
    if (m && new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(m[2])) return Number(m[1])
  }
  return null
}

// ── path resolution shared by every file mode ────────────────────────────────
async function resolveFile(root: string, p: string | undefined): Promise<{ abs?: string; note?: string; diag?: string }> {
  if (!p) return { diag: "no path given" }
  if (isSecretPath(p)) return { diag: "refused: .env* is protected" }
  // F2 path guard — before locate healing
  const guard = pathGuard(root, p)
  if (!guard.ok) return { diag: guard.error! }
  const loc = locate(resolve(root, p))
  if (!loc.healed) return { diag: loc.diag ?? `FILE NOT FOUND: ${toPosix(resolve(root, p))}` }
  return { abs: loc.healed, note: loc.note }
}

function numbered(lines: string[], from: number): string {
  return lines.map((l, i) => `${String(from + i).padStart(5)}│${l}`).join("\n")
}

// ── modes ────────────────────────────────────────────────────────────────────
async function modeTree(req: NavRequest, root: string, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const start = req.path ? resolve(root, String(req.path)) : root
  if (!existsSync(start)) return degraded("tree", `directory not found: ${toPosix(start)}`, src)
  const maxDepth = typeof req.depth === "number" ? req.depth : 2
  const lines: string[] = []
  const walk = (dir: string, depth: number, prefix: string) => {
    if (depth > maxDepth) return
    let entries: ReturnType<typeof readdirSync>
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    const sorted = entries
      .filter((e) => !IGNORE.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const e of sorted) {
      lines.push(`${prefix}${e.isDirectory() ? e.name + "/" : e.name}`)
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1, prefix + "  ")
      if (lines.length > 800) return
    }
  }
  walk(start, 1, "")
  const truncated = lines.length > 800
  return {
    ok: true, mode: "tree", path: toPosix(relative(root, start) || "."),
    budget_source: src, truncated, total_lines: lines.length,
    notes: truncated ? "tree truncated at 800 entries" : undefined,
    payload: lines.slice(0, 800).join("\n"),
  }
}

async function modeOutline(req: NavRequest, root: string, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const r = await resolveFile(root, req.path ? String(req.path) : undefined)
  if (!r.abs) return degraded("outline", r.diag!, src)
  const total = (readFileSync(r.abs, "utf8").match(/\r?\n/g)?.length ?? 0) + 1
  const relPath = toPosix(relative(root, r.abs))
  const ext = extname(r.abs)

  // LSP outline rung — only when a warm client already exists (avoids cold-start latency)
  if (lspClient.hasWarmClient(root, ext)) {
    try {
      const client = await lspClient.getClient(root, ext)
      if (client) {
        const fileUri = pathToFileUri(r.abs)
        const syms = await Promise.race([
          lspClient.waitForDiagnostics(fileUri, 2000),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("lsp-outline-timeout")), 2000)),
        ])
        // Note: with the stub, getClient always returns null, so this path won't execute.
        // When M3 provides the real client, this will use client.documentSymbols(fileUri).
      }
    } catch { /* fall through to tree-sitter */ }
  }

  // Tree-sitter rung — grammar-aware outline for .java/.rb/.cs/.kt etc.
  try {
    const tsSyms = await tsOutline(r.abs, ext)
    if (tsSyms && tsSyms.length > 0) {
      const lines = tsSyms.map((s) =>
        `${String(s.startLine).padStart(5)}  ${s.kind.padEnd(14)} ${s.name}`,
      )
      return {
        ok: true, mode: "outline", path: relPath,
        budget_source: src, truncated: false, total_lines: total,
        engine: "tree-sitter",
        notes: r.note,
        payload: lines.join("\n"),
      }
    }
  } catch { /* fall through to ctags/regex */ }

  const outline = await outlineOf(r.abs)
  const fallbackEngine = outline ? (await which("ctags") ? "ctags" : "regex") : "none"
  return {
    ok: true, mode: "outline", path: relPath,
    budget_source: src, truncated: false, total_lines: total,
    engine: fallbackEngine,
    notes: [r.note, outline ? undefined : "no symbols found (file exists)"].filter(Boolean).join(" ") || undefined,
    payload: outline || "(no symbols)",
  }
}

function readSlice(root: string, abs: string, offset: number, limit: number, cap: number, src: NavEnvelope["budget_source"], note?: string, mode = "read"): NavEnvelope {
  let raw: string
  try { raw = readFileSync(abs, "utf8") } catch (e: any) { return degraded(mode, `read failed: ${e?.message ?? e}`, src) }
  const lines = raw.split(/\r?\n/)
  const total = lines.length
  const from = Math.max(1, offset)
  let to = Math.min(total, from + Math.max(1, limit) - 1)
  let body = numbered(lines.slice(from - 1, to), from)
  let truncated = false
  if (body.length > cap) {
    // shrink the window to fit the char budget
    while (to > from && body.length > cap) { to--; body = numbered(lines.slice(from - 1, to), from) }
    truncated = true
  }
  const next = to < total ? `${toPosix(relative(root, abs))}:${to + 1}-${Math.min(total, to + limit)}` : null
  return {
    ok: true, mode, path: toPosix(relative(root, abs)),
    budget_source: src, truncated,
    fingerprint: fingerprint(raw),
    anchor: `${toPosix(relative(root, abs))}:${from}-${to}`,
    total_lines: total, next,
    notes: note,
    payload: body,
  }
}

async function modeRead(req: NavRequest, root: string, cap: number, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const r = await resolveFile(root, req.path ? String(req.path) : undefined)
  if (!r.abs) return degraded("read", r.diag!, src)
  const offset = typeof req.offset === "number" ? req.offset : 1
  const limit = typeof req.limit === "number" ? req.limit : 200
  const env = readSlice(root, r.abs, offset, limit, cap, src, r.note, "read")
  if (env.ok) env.outline = await outlineOf(r.abs)   // read returns an outline alongside the slice
  return env
}

// peek anchor: "relpath:start-end"  OR  "relpath#symbol"
async function modePeek(req: NavRequest, root: string, cap: number, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const anchor = req.anchor ? String(req.anchor) : (req.path ? String(req.path) : "")
  if (!anchor) return degraded("peek", "peek needs an anchor 'relpath:start-end' or 'relpath#symbol'", src)

  const rangeM = anchor.match(/^(.+):(\d+)-(\d+)$/)
  const symM = anchor.match(/^(.+)#(.+)$/)
  const relPath = rangeM ? rangeM[1] : symM ? symM[1] : anchor

  const r = await resolveFile(root, relPath)
  if (!r.abs) return degraded("peek", r.diag!, src)

  if (rangeM) {
    const start = Number(rangeM[2]); const end = Number(rangeM[3])
    return readSlice(root, r.abs, start, end - start + 1, cap, src, r.note, "peek")
  }
  if (symM) {
    const outline = await outlineOf(r.abs)
    const line = lineOfSymbol(outline, symM[2])
    if (line == null) return degraded("peek", `symbol "${symM[2]}" not found in ${toPosix(relative(root, r.abs))}`, src)
    return readSlice(root, r.abs, line, 60, cap, src, r.note, "peek")
  }
  // bare path -> first window
  return readSlice(root, r.abs, 1, 80, cap, src, r.note, "peek")
}

async function modeSearch(req: NavRequest, root: string, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const pattern = req.pattern ? String(req.pattern) : ""
  if (!pattern) return degraded("search", "search needs a `pattern`", src)
  const max = typeof req.max === "number" ? req.max : 80
  const where = req.path ? String(req.path) : "."
  if (isSecretPath(where)) return degraded("search", "refused: .env* is protected", src)

  if (await which("rg")) {
    const r = await runBoundedCmd(["rg", "--line-number", "--no-heading", "--max-count", String(max), pattern, where], root)
    if (r.code === null) return degraded("search", "ripgrep timed out", src)
    const hits = r.out.trim().split("\n").filter(Boolean).slice(0, max)
    return {
      ok: true, mode: "search", budget_source: src, truncated: hits.length >= max,
      matches: hits, total_lines: hits.length,
      payload: hits.join("\n") || `no matches for /${pattern}/`,
    }
  }
  // JS fallback: walk tree, regex per line
  let re: RegExp
  try { re = new RegExp(pattern) } catch (e) { return degraded("search", `bad regex: ${e}`, src) }
  const hits: string[] = []
  const walk = (dir: string) => {
    if (hits.length >= max) return
    let entries: ReturnType<typeof readdirSync>
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (IGNORE.has(e.name) || e.name.startsWith(".")) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (![ ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".md", ".json" ].includes(extname(e.name))) continue
      let raw = ""
      try { raw = readFileSync(full, "utf8") } catch { continue }
      raw.split(/\r?\n/).forEach((l, i) => {
        if (hits.length < max && re.test(l)) hits.push(`${toPosix(relative(root, full))}:${i + 1}:${l.trim().slice(0, 160)}`)
      })
    }
  }
  walk(resolve(root, where))
  return {
    ok: true, mode: "search", budget_source: src, truncated: hits.length >= max,
    matches: hits, total_lines: hits.length,
    notes: "[degraded: ripgrep not installed, used JS scan]",
    payload: hits.join("\n") || `no matches for /${pattern}/`,
  }
}

// ── glob mode (file finder by pattern) ──────────────────────────────────────
async function modeGlob(req: NavRequest, root: string, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const pattern = req.pattern ? String(req.pattern) : ""
  if (!pattern) return degraded("glob", "glob needs a `pattern`", src)
  const where = req.path ? String(req.path) : "."
  if (isSecretPath(where)) return degraded("glob", "refused: .env* is protected", src)
  const max = typeof req.max === "number" ? req.max : 200

  // Simple glob-to-regex: ** matches anything, * matches non-slash, ? matches single char
  let regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*")
  const re = new RegExp(`^${regexStr}$`)

  const matches: string[] = []
  const baseDir = resolve(root, where)

  const walk = (dir: string) => {
    if (matches.length >= max) return
    let entries: ReturnType<typeof readdirSync>
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (IGNORE.has(e.name) || e.name.startsWith(".")) continue
      const full = join(dir, e.name)
      const rel = toPosix(relative(baseDir, full))
      if (e.isDirectory()) {
        walk(full)
      } else if (re.test(rel) || re.test(e.name)) {
        matches.push(rel)
        if (matches.length >= max) break
      }
    }
  }
  walk(baseDir)

  return {
    ok: true, mode: "glob", budget_source: src, truncated: matches.length >= max,
    matches, total_lines: matches.length,
    payload: matches.join("\n") || `no files matched /${pattern}/`,
  }
}

// ── LSP symbol kind map ───────────────────────────────────────────────────────
const LSP_KIND: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
  6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
  11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
  15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
  20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
}

// ── LSP-backed modes ──────────────────────────────────────────────────────────

// Converts a file:// URI to a relative path (1-based line anchor)
function uriToAnchor(root: string, uri: string, lspLine: number): string {
  try {
    // file:// pathname on Windows starts with /C:/...
    let pathname = new URL(uri).pathname
    // On Windows, pathname is /C:/foo → remove leading slash
    if (process.platform === "win32" && /^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1)
    }
    const rel = toPosix(relative(root, pathname))
    return `${rel}:${lspLine + 1}`  // LSP 0-based → 1-based
  } catch {
    return uri
  }
}

async function modeSymbols(req: NavRequest, root: string, cap: number, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const r = await resolveFile(root, req.path ? String(req.path) : undefined)
  if (!r.abs) return degraded("symbols", r.diag!, src)
  const total = (readFileSync(r.abs, "utf8").match(/\r?\n/g)?.length ?? 0) + 1
  const relPath = toPosix(relative(root, r.abs))
  const ext = extname(r.abs)
  const fileUri = pathToFileUri(r.abs)

  // Try LSP first
  try {
    const client = await lspClient.getClient(root, ext)
    if (client) {
      // Note: with the stub, getClient always returns null. M3 will provide the real client.
      // When that happens, this path will use client.documentSymbols(fileUri).
    }
  } catch {
    // Fall through to ctags/regex
  }

  // ctags fallback (via outlineOf which handles both ctags + regex)
  const outline = await outlineOf(r.abs)
  const engine = await which("ctags") ? "ctags" : "regex"
  return {
    ok: true, mode: "symbols", path: relPath,
    budget_source: src, truncated: false, total_lines: total,
    engine: outline ? engine : "none",
    notes: [r.note, outline ? undefined : "no symbols found"].filter(Boolean).join(" ") || undefined,
    payload: outline || "(no symbols)",
  }
}

async function modeDef(req: NavRequest, root: string, _cap: number, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const r = await resolveFile(root, req.path ? String(req.path) : undefined)
  if (!r.abs) return degraded("def", r.diag!, src)
  const line = typeof req.line === "number" ? req.line : 0
  const character = typeof req.character === "number" ? req.character : 0
  const ext = extname(r.abs)
  const fileUri = pathToFileUri(r.abs)

  try {
    const client = await lspClient.getClient(root, ext)
    if (!client) {
      return { ok: true, mode: "def", budget_source: src, truncated: false, matches: [], total_lines: 0, notes: "no LSP client for this file type", payload: "" }
    }
    // Note: with the stub, getClient always returns null. M3 will provide the real client.
    // When that happens, this path will use client.definition(fileUri, line, character).
    return { ok: true, mode: "def", budget_source: src, truncated: false, matches: [], total_lines: 0, notes: "no LSP client for this file type", payload: "" }
  } catch (e) {
    return degraded("def", `LSP error: ${String(e)}`, src)
  }
}

async function modeRefs(req: NavRequest, root: string, _cap: number, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const r = await resolveFile(root, req.path ? String(req.path) : undefined)
  if (!r.abs) return degraded("refs", r.diag!, src)
  const line = typeof req.line === "number" ? req.line : 0
  const character = typeof req.character === "number" ? req.character : 0
  const includeDecl = req.include_declaration === true
  const ext = extname(r.abs)
  const fileUri = pathToFileUri(r.abs)

  try {
    const client = await lspClient.getClient(root, ext)
    if (!client) {
      return { ok: true, mode: "refs", budget_source: src, truncated: false, matches: [], total_lines: 0, notes: "no LSP client for this file type", payload: "" }
    }
    // Note: with the stub, getClient always returns null. M3 will provide the real client.
    // When that happens, this path will use client.references(fileUri, line, character, includeDecl).
    return { ok: true, mode: "refs", budget_source: src, truncated: false, matches: [], total_lines: 0, notes: "no LSP client for this file type", payload: "" }
  } catch (e) {
    return degraded("refs", `LSP error: ${String(e)}`, src)
  }
}

async function modeHover(req: NavRequest, root: string, cap: number, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const r = await resolveFile(root, req.path ? String(req.path) : undefined)
  if (!r.abs) return degraded("hover", r.diag!, src)
  const line = typeof req.line === "number" ? req.line : 0
  const character = typeof req.character === "number" ? req.character : 0
  const ext = extname(r.abs)
  const fileUri = pathToFileUri(r.abs)

  try {
    const client = await lspClient.getClient(root, ext)
    if (!client) {
      return { ok: true, mode: "hover", budget_source: src, truncated: false, notes: "no LSP client for this file type", payload: "" }
    }
    // Note: with the stub, getClient always returns null. M3 will provide the real client.
    // When that happens, this path will use client.hover(fileUri, line, character).
    return { ok: true, mode: "hover", budget_source: src, truncated: false, notes: "no LSP client for this file type", payload: "" }
  } catch (e) {
    return degraded("hover", `LSP error: ${String(e)}`, src)
  }
}

// ── write side ───────────────────────────────────────────────────────────────
function checkExpect(raw: string, expect: unknown, mode: string, src: NavEnvelope["budget_source"]): NavEnvelope | null {
  if (typeof expect !== "string" || !expect) return null
  const fp = fingerprint(raw)
  if (fp !== expect) {
    return degraded(mode, `stale: file changed underneath you (expect=${expect} actual=${fp}). Re-read with nav_read, then retry with the fresh fingerprint.`, src)
  }
  return null
}

// Post-edit diagnostics enrichment (warm-only, default on). Fires ONLY when an LSP
// server is already warm for this ext — never cold-starts a server on an edit, so
// edits in a not-yet-touched language pay zero latency. Pushes fresh content via
// didChange/didOpen, races 5s, degrades to diagnostics_pending:true. Non-fatal.
async function enrichPostEditDiagnostics(req: NavRequest, root: string, abs: string, env: NavEnvelope): Promise<void> {
  if (req.postDiagnostics === false) return
  const ext = extname(abs)
  if (!lspClient.hasWarmClient(root, ext)) return
  try {
    const client = await lspClient.getClient(root, ext)
    if (!client) return
    // Note: with the stub, getClient always returns null. M3 will provide refreshDiagnostics.
    const fileUri = pathToFileUri(abs)
    const d = await Promise.race([
      lspClient.waitForDiagnostics(fileUri, 5000),
      new Promise<{ diagnostics: unknown[]; pending: boolean }>((resolve) =>
        setTimeout(() => resolve({ diagnostics: [], pending: true }), 5000)),
    ])
    ;(env as any).diagnostics = d.diagnostics
    ;(env as any).diagnostics_pending = d.pending
  } catch { /* non-fatal — never block the edit on diagnostics */ }
}

async function modeEdit(req: NavRequest, root: string, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const r = await resolveFile(root, req.path ? String(req.path) : undefined)
  if (!r.abs) return degraded("edit", r.diag!, src)
  let raw: string
  try { raw = readFileSync(r.abs, "utf8") } catch (e: any) { return degraded("edit", `read failed: ${e?.message ?? e}`, src) }
  const stale = checkExpect(raw, req.expect, "edit", src)
  if (stale) return stale

  const eol = raw.includes("\r\n") ? "\r\n" : "\n"
  const lines = raw.split(/\r?\n/)
  let next: string

  if (req.anchor) {
    const m = String(req.anchor).match(/:(\d+)-(\d+)$/)
    if (!m) return degraded("edit", "anchor for a range edit must be 'relpath:start-end'", src)
    const start = Number(m[1]); const end = Number(m[2])
    if (end > lines.length) return degraded("edit", `anchor end ${end} exceeds file length ${lines.length}`, src)
    const replacement = String(req.replace ?? req.content ?? "")
    next = [...lines.slice(0, start - 1), ...replacement.split(/\r?\n/), ...lines.slice(end)].join(eol)
  } else if (typeof req.find === "string") {
    const find = req.find
    if (!raw.includes(find)) return degraded("edit", `find text not present in ${toPosix(relative(root, r.abs))}`, src)
    const replace = String(req.replace ?? "")
    if (req.all) next = raw.split(find).join(replace)
    else next = raw.replace(find, replace)
  } else {
    return degraded("edit", "edit needs either `find` (with `replace`) or `anchor` (relpath:start-end)", src)
  }

  try { writeFileSync(r.abs, next, "utf8") } catch (e: any) { return degraded("edit", `write failed: ${e?.message ?? e}`, src) }
  const env: NavEnvelope = {
    ok: true, mode: "edit", path: toPosix(relative(root, r.abs)),
    budget_source: src, truncated: false,
    fingerprint: fingerprint(next),
    total_lines: next.split(/\r?\n/).length,
    notes: r.note,
    payload: `edited ${toPosix(relative(root, r.abs))} (${lines.length} -> ${next.split(/\r?\n/).length} lines)`,
  }
  await enrichPostEditDiagnostics(req, root, r.abs, env)
  return env
}

async function modeWrite(req: NavRequest, root: string, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  if (!req.path) return degraded("write", "write needs a `path`", src)
  if (isSecretPath(String(req.path))) return degraded("write", "refused: .env* is protected", src)
  if (typeof req.content !== "string") return degraded("write", "write needs `content`", src)
  const abs = resolve(root, String(req.path))
  if (existsSync(abs) && req.expect !== undefined) {
    const raw = readFileSync(abs, "utf8")
    const stale = checkExpect(raw, req.expect, "write", src)
    if (stale) return stale
  }
  try {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, req.content as string, "utf8")
  } catch (e: any) { return degraded("write", `write failed: ${e?.message ?? e}`, src) }
  const content = req.content as string
  const env: NavEnvelope = {
    ok: true, mode: "write", path: toPosix(relative(root, abs)),
    budget_source: src, truncated: false,
    fingerprint: fingerprint(content),
    total_lines: content.split(/\r?\n/).length,
    payload: `wrote ${toPosix(relative(root, abs))} (${content.split(/\r?\n/).length} lines)`,
  }
  await enrichPostEditDiagnostics(req, root, abs, env)
  return env
}

// ── diagnostics mode ────────────────────────────────────────────────────────
async function modeDiagnostics(req: NavRequest, root: string, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const r = await resolveFile(root, req.path ? String(req.path) : undefined)
  if (!r.abs) return degraded("diagnostics", r.diag!, src)
  const ext = extname(r.abs)
  const fileUri = pathToFileUri(r.abs)
  const relPath = toPosix(relative(root, r.abs))

  try {
    const client = await lspClient.getClient(root, ext)
    if (!client) {
      return {
        ok: true, mode: "diagnostics", path: relPath,
        budget_source: src, truncated: false,
        engine: "none", notes: "no LSP client for this file type",
        payload: "[]",
      }
    }
    // Note: with the stub, getClient always returns null. M3 will provide awaitDiagnostics.
    // When that happens, this path will use client.awaitDiagnostics(fileUri).
    return {
      ok: true, mode: "diagnostics", path: relPath,
      budget_source: src, truncated: false,
      engine: "none", notes: "no LSP client for this file type",
      payload: "[]",
    }
  } catch (e) {
    return degraded("diagnostics", `LSP error: ${String(e)}`, src)
  }
}

// ── workspace/symbol mode ────────────────────────────────────────────────────
async function modeWsymbol(req: NavRequest, root: string, _cap: number, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const query = req.pattern ? String(req.pattern) : (req.query ? String(req.query) : "")
  const limit = typeof req.limit === "number" ? req.limit : 50
  const ext = req.path ? extname(String(req.path)) : ".ts"

  try {
    const client = await lspClient.getClient(root, ext)
    if (!client) {
      return {
        ok: true, mode: "wsymbol",
        budget_source: src, truncated: false, total_lines: 0,
        engine: "none", notes: "no LSP client for this file type",
        payload: "[]",
      }
    }
    // Note: with the stub, getClient always returns null. M3 will provide workspaceSymbol.
    // When that happens, this path will use client.workspaceSymbol(query).
    return {
      ok: true, mode: "wsymbol",
      budget_source: src, truncated: false, total_lines: 0,
      engine: "none", notes: "no LSP client for this file type",
      payload: "[]",
    }
  } catch (e) {
    return degraded("wsymbol", `LSP error: ${String(e)}`, src)
  }
}

// ── rename mode ───────────────────────────────────────────────────────────────
async function modeRename(req: NavRequest, root: string, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const newName = req.newName ? String(req.newName) : req.new_name ? String(req.new_name) : ""
  if (!newName) return degraded("rename", "rename requires `newName`", src)

  const scope = req.scope ? String(req.scope) : "file"
  const anchor = req.anchor ? String(req.anchor) : (req.path ? String(req.path) : "")
  if (!anchor) return degraded("rename", "rename requires `anchor` (relpath:line or relpath#symbol) or `path`", src)

  // Parse anchor: "relpath:42" or "relpath#symbolName" or bare "relpath"
  const rangeM = anchor.match(/^(.+):(\d+)$/)
  const symM = !rangeM ? anchor.match(/^(.+)#(.+)$/) : null
  const relPath = rangeM ? rangeM[1] : symM ? symM[1] : anchor
  const r = await resolveFile(root, relPath)
  if (!r.abs) return degraded("rename", r.diag!, src)

  // ── scope=file: in-file regex replace (no LSP) ─────────────────────────────
  if (scope === "file") {
    const oldName = req.oldName ? String(req.oldName) : (symM ? symM[2] : "")
    if (!oldName) return degraded("rename", "rename scope=file requires `oldName` or anchor `file#symbolName`", src)
    let raw: string
    try { raw = readFileSync(r.abs, "utf8") } catch (e: any) {
      return degraded("rename", `read failed: ${e?.message ?? e}`, src)
    }
    const stale = checkExpect(raw, req.expect, "rename", src)
    if (stale) return stale
    // Word-boundary replace
    const re = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g")
    const count = (raw.match(re) ?? []).length
    if (count === 0) return degraded("rename", `symbol '${oldName}' not found in ${toPosix(relative(root, r.abs))}`, src)
    const next = raw.replace(re, newName)
    try { writeFileSync(r.abs, next, "utf8") } catch (e: any) {
      return degraded("rename", `write failed: ${e?.message ?? e}`, src)
    }
    return {
      ok: true, mode: "rename", path: toPosix(relative(root, r.abs)),
      budget_source: src, truncated: false,
      fingerprint: fingerprint(next),
      total_lines: next.split(/\r?\n/).length,
      engine: "file-regex",
      notes: `renamed ${count} occurrence(s) of '${oldName}' → '${newName}' (file-scoped)`,
      payload: `scope=file: ${count} rename(s) applied in ${toPosix(relative(root, r.abs))}`,
    }
  }

  // ── scope=lsp: full workspace rename via LSP ────────────────────────────────
  if (scope !== "lsp") return degraded("rename", `unknown scope '${scope}' — use 'file' or 'lsp'`, src)

  const ext = extname(r.abs)
  const fileUri = pathToFileUri(r.abs)

  try {
    const client = await lspClient.getClient(root, ext)
    if (!client) return degraded("rename", "no LSP client for this file type", src)

    // Note: with the stub, getClient always returns null. M3 will provide the real client.
    // When that happens, this path will use client.documentSymbols, prepareRename, and rename.
    return degraded("rename", "no LSP client for this file type", src)
  } catch (e) {
    return degraded("rename", `LSP error: ${String(e)}`, src)
  }
}

// ── codeAction mode ───────────────────────────────────────────────────────────
async function modeAction(req: NavRequest, root: string, src: NavEnvelope["budget_source"]): Promise<NavEnvelope> {
  const anchor = req.anchor ? String(req.anchor) : (req.path ? String(req.path) : "")
  if (!anchor) return degraded("action", "action requires `anchor` (relpath:line or relpath:start-end)", src)

  const rangeM = anchor.match(/^(.+):(\d+)-(\d+)$/)
  const lineM = !rangeM ? anchor.match(/^(.+):(\d+)$/) : null
  const relPath = rangeM ? rangeM[1] : lineM ? lineM[1] : anchor
  const r = await resolveFile(root, relPath)
  if (!r.abs) return degraded("action", r.diag!, src)

  const range = rangeM
    ? { start: { line: Number(rangeM[2]) - 1, character: 0 }, end: { line: Number(rangeM[3]) - 1, character: 0 } }
    : lineM
      ? { start: { line: Number(lineM[2]) - 1, character: 0 }, end: { line: Number(lineM[2]) - 1, character: 9999 } }
      : { start: { line: 0, character: 0 }, end: { line: 0, character: 9999 } }

  const ext = extname(r.abs)
  const fileUri = pathToFileUri(r.abs)

  try {
    const client = await lspClient.getClient(root, ext)
    if (!client) return degraded("action", "no LSP client for this file type", src)

    // Note: with the stub, getClient always returns null. M3 will provide the real client.
    // When that happens, this path will use client.awaitDiagnostics, client.rawRequest, etc.
    return degraded("action", "no LSP client for this file type", src)
  } catch (e) {
    return degraded("action", `LSP error: ${String(e)}`, src)
  }
}

// ── entry point ──────────────────────────────────────────────────────────────
export async function dispatch(req: NavRequest): Promise<NavEnvelope> {
  const root = req.root ? resolve(String(req.root)) : process.cwd()
  const { cap, source } = budget(req)
  try {
    switch (req.mode) {
      case "tree":       return await modeTree(req, root, source)
      case "outline":    return await modeOutline(req, root, source)
      case "symbols":    return await modeSymbols(req, root, cap, source)
      case "read":       return await modeRead(req, root, cap, source)
      case "peek":       return await modePeek(req, root, cap, source)
      case "search":     return await modeSearch(req, root, source)
      case "glob":       return await modeGlob(req, root, source)
      case "def":        return await modeDef(req, root, cap, source)
      case "refs":       return await modeRefs(req, root, cap, source)
      case "hover":      return await modeHover(req, root, cap, source)
      case "edit":       return await modeEdit(req, root, source)
      case "write":      return await modeWrite(req, root, source)
      case "diagnostics": return await modeDiagnostics(req, root, source)
      case "wsymbol":    return await modeWsymbol(req, root, cap, source)
      case "rename":     return await modeRename(req, root, source)
      case "action":     return await modeAction(req, root, source)
      default:           return degraded(req.mode || "unknown", `unknown mode '${req.mode}'`, source)
    }
  } catch (e) {
    return degraded(req.mode || "unknown", `core error: ${String(e)}`, source)
  }
}

export default dispatch
