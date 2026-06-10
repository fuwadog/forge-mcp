/**
 * FORGE supervisor — restart budgets, circuit-breakers, and param self-correction.
 *
 * Ported from nav-mcp supervisor concepts for M4:
 *   - Per (root,lang) restart tracking with exponential backoff
 *   - Circuit-breaker: closed → open → half-open → closed
 *   - Degradation chain routing for fail-soft
 *   - Param self-correction (pre-dispatch, max 1 retry)
 *
 * Contract: every public function is pure/side-effect-free except state mutation
 * on the supervisor instance. No exceptions escape — callers always get a result.
 */
import { resolve, relative } from "path"
import { locate, levenshtein, toPosix } from "./locate.js"

// ── types ───────────────────────────────────────────────────────────────────

export interface CircuitState {
  status: "closed" | "open" | "half-open"
  failures: number
  lastFailure: number
  opensAt: number
}

export interface SupervisorConfig {
  restartBudget: number     // max restarts within budget window (default 3)
  budgetWindowMin: number   // budget window in minutes (default 5)
  halfOpenProbeSec: number  // seconds before half-open probe (default 60)
}

export interface Supervisor {
  /** Check if a process is allowed to restart. */
  canRestart(root: string, lang: string): boolean
  /** Record a crash event. Opens circuit if budget exhausted. */
  recordCrash(root: string, lang: string): void
  /** Get current circuit state for a (root,lang). Auto-transitions open→half-open if probe elapsed. */
  getCircuitState(root: string, lang: string): CircuitState
  /** Attempt a half-open probe. Returns true if allowed (one-shot). */
  tryHalfOpen(root: string, lang: string): boolean
  /** Record a successful use — resets failure count, closes circuit. */
  recordSuccess(root: string, lang: string): void
  /** Get ordered degradation chain for a mode type. */
  getDegradationChain(mode: string): string[]
}

export interface CorrectionResult {
  corrected: boolean
  params: Record<string, any>
  notes?: string
}

// ── constants ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SupervisorConfig = {
  restartBudget: 3,
  budgetWindowMin: 5,
  halfOpenProbeSec: 60,
}

/** Mode → ordered degradation chain (first = primary engine). */
const DEGRADATION_CHAINS: Record<string, string[]> = {
  // LSP modes
  def:     ["lsp", "tree-sitter", "ctags", "regex"],
  refs:    ["lsp", "tree-sitter", "ctags", "regex"],
  hover:   ["lsp", "tree-sitter", "ctags", "regex"],
  symbols: ["lsp", "tree-sitter", "ctags", "regex"],
  wsymbol: ["lsp", "tree-sitter", "ctags", "regex"],
  diagnostics: ["lsp", "tree-sitter", "ctags", "regex"],
  // Read modes
  outline: ["lsp", "tree-sitter", "ctags", "regex"],
  read:    ["lsp", "tree-sitter", "ctags", "regex"],
  peek:    ["lsp", "tree-sitter", "ctags", "regex"],
  search:  ["lsp", "tree-sitter", "ctags", "regex"],
  // AST modes
  "ast-napi":  ["ast-napi", "ast-cli", "ripgrep"],
  "ast-cli":   ["ast-cli", "ripgrep"],
  rename:  ["lsp", "tree-sitter", "ctags", "regex"],
  action:  ["lsp", "tree-sitter", "ctags", "regex"],
}

const DEFAULT_CHAIN = ["lsp", "tree-sitter", "ctags", "regex"]

/** Mutating modes — correction is REPORTED only, never auto-applied. */
const MUTATING_MODES = new Set(["edit", "write", "rename", "action"])

/** Enum-like param fields and their valid values (extensible). */
const ENUM_FIELDS: Record<string, string[]> = {
  scope:    ["file", "lsp"],
  kind:     ["quickfix", "refactor", "source.organizeImports"],
  budget_source: ["env", "config", "default", "floor"],
}

// ── internal state ──────────────────────────────────────────────────────────

interface ProcState {
  failures: number[]           // timestamps of crashes within budget window
  circuitOpenAt: number        // timestamp when circuit opened (0 = closed)
  halfOpenUsed: boolean        // true = half-open probe already dispatched
}

function key(root: string, lang: string): string {
  return `${root}::${lang}`
}

// ── factory ─────────────────────────────────────────────────────────────────

export function createSupervisor(config?: Partial<SupervisorConfig>): Supervisor {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const procs = new Map<string, ProcState>()

  function getState(k: string): ProcState {
    let s = procs.get(k)
    if (!s) {
      s = { failures: [], circuitOpenAt: 0, halfOpenUsed: false }
      procs.set(k, s)
    }
    return s
  }

  /** Prune crash timestamps older than budget window. */
  function pruneFailures(s: ProcState): void {
    const cutoff = Date.now() - cfg.budgetWindowMin * 60_000
    s.failures = s.failures.filter((t) => t > cutoff)
  }

  function canRestart(root: string, lang: string): boolean {
    const s = getState(key(root, lang))
    pruneFailures(s)
    // Circuit open → no restart
    if (s.circuitOpenAt > 0) return false
    // Within budget → allow
    return s.failures.length < cfg.restartBudget
  }

  function recordCrash(root: string, lang: string): void {
    const s = getState(key(root, lang))
    s.failures.push(Date.now())
    pruneFailures(s)
    // Budget exhausted → open circuit
    if (s.failures.length >= cfg.restartBudget && s.circuitOpenAt === 0) {
      s.circuitOpenAt = Date.now()
      s.halfOpenUsed = false
    }
  }

  function getCircuitState(root: string, lang: string): CircuitState {
    const s = getState(key(root, lang))
    pruneFailures(s)

    // Auto-transition: open → half-open after probe window
    if (s.circuitOpenAt > 0 && !s.halfOpenUsed) {
      const elapsed = (Date.now() - s.circuitOpenAt) / 1000
      if (elapsed >= cfg.halfOpenProbeSec) {
        return { status: "half-open", failures: s.failures.length, lastFailure: s.failures.at(-1) ?? 0, opensAt: s.circuitOpenAt }
      }
      return { status: "open", failures: s.failures.length, lastFailure: s.failures.at(-1) ?? 0, opensAt: s.circuitOpenAt }
    }

    if (s.circuitOpenAt > 0 && s.halfOpenUsed) {
      return { status: "open", failures: s.failures.length, lastFailure: s.failures.at(-1) ?? 0, opensAt: s.circuitOpenAt }
    }

    return { status: "closed", failures: s.failures.length, lastFailure: s.failures.at(-1) ?? 0, opensAt: 0 }
  }

  function tryHalfOpen(root: string, lang: string): boolean {
    const s = getState(key(root, lang))
    if (s.circuitOpenAt === 0 || s.halfOpenUsed) return false
    const elapsed = (Date.now() - s.circuitOpenAt) / 1000
    if (elapsed < cfg.halfOpenProbeSec) return false
    s.halfOpenUsed = true
    return true
  }

  function recordSuccess(root: string, lang: string): void {
    const s = getState(key(root, lang))
    s.failures = []
    s.circuitOpenAt = 0
    s.halfOpenUsed = false
  }

  function getDegradationChain(mode: string): string[] {
    return DEGRADATION_CHAINS[mode] ?? DEFAULT_CHAIN
  }

  return { canRestart, recordCrash, getCircuitState, tryHalfOpen, recordSuccess, getDegradationChain }
}

// ── param self-correction ───────────────────────────────────────────────────

/**
 * Pre-dispatch param correction. Max 1 retry, recovery.corrected_params.
 *
 * Rules:
 * - path: run through locate chain (after F2 guard); suggest nearest match if typo (levenshtein ≤ 2, unambiguous)
 * - enum typo: suggest closest match if ≤ 2 distance
 * - line/char clamp: clamp to valid range (1..total_lines, 0..line_length)
 * - mutating modes: correction REPORTED only, never auto-applied
 */
export function correctParams(
  mode: string,
  params: Record<string, any>,
  roots: string[],
): CorrectionResult {
  const corrected = { ...params }
  const notes: string[] = []
  let changed = false

  // ── path correction ─────────────────────────────────────────────────────
  if (typeof corrected.path === "string" && corrected.path.length > 0) {
    const root = roots[0] ?? process.cwd()
    const abs = resolve(root, corrected.path)

    // Run locate chain (F2 guard is upstream — we assume it passed)
    const loc = locate(abs, "`list`/`outline`")
    if (loc.healed && loc.healed !== abs) {
      // locate healed the path — use the corrected absolute, store relative
      corrected.path = toPosix(relative(root, loc.healed))
      notes.push(loc.note ?? `path corrected: ${corrected.path}`)
      changed = true
    } else if (!loc.healed && loc.diag) {
      // locate failed — try levenshtein suggestion from the diag output
      const nearMatch = loc.diag.match(/Closest names: (.+)/)
      if (nearMatch) {
        const candidates = nearMatch[1]!.split(", ").map((s: string) => s.trim())
        if (candidates.length === 1) {
          // Unambiguous single suggestion — auto-correct
          corrected.path = candidates[0]!
          notes.push(`path corrected (typo): ${corrected.path}`)
          changed = true
        } else if (candidates.length > 1) {
          // Ambiguous — report but don't auto-correct
          notes.push(`path ambiguous: candidates [${candidates.join(", ")}] — needs explicit selection`)
        }
      }
    }
  }

  // ── enum field correction ───────────────────────────────────────────────
  for (const [field, validValues] of Object.entries(ENUM_FIELDS)) {
    const val = corrected[field]
    if (typeof val !== "string") continue
    if (validValues.includes(val)) continue // already valid

    // Find closest match by levenshtein distance
    const scored = validValues
      .map((v) => ({ v, d: levenshtein(val.toLowerCase(), v.toLowerCase()) }))
      .sort((a, b) => a.d - b.d)

    const best = scored[0]
    if (best && best.d <= 2) {
      // Check unambiguous: no other candidate at same distance
      const tied = scored.filter((s) => s.d === best.d)
      if (tied.length === 1) {
        corrected[field] = best.v
        notes.push(`enum ${field}: "${val}" → "${best.v}"`)
        changed = true
      } else {
        notes.push(`enum ${field}: "${val}" is ambiguous — candidates: ${tied.map((t) => t.v).join(", ")}`)
      }
    }
  }

  // ── line/char clamping ──────────────────────────────────────────────────
  if (typeof corrected.line === "number") {
    const line = Math.max(1, Math.round(corrected.line))
    if (line !== corrected.line) {
      notes.push(`line clamped: ${corrected.line} → ${line}`)
      corrected.line = line
      changed = true
    }
  }
  if (typeof corrected.character === "number") {
    const char = Math.max(0, Math.round(corrected.character))
    if (char !== corrected.character) {
      notes.push(`character clamped: ${corrected.character} → ${char}`)
      corrected.character = char
      changed = true
    }
  }

  // ── mutating mode guard ─────────────────────────────────────────────────
  if (MUTATING_MODES.has(mode) && changed) {
    // Correction REPORTED only — params are NOT auto-applied for mutations.
    // Return the original params with notes explaining what would be corrected.
    return {
      corrected: false,
      params,  // original, unmutated
      notes: `[correction blocked for mutating mode "${mode}"]: ${notes.join("; ")}`,
    }
  }

  return {
    corrected: changed,
    params: corrected,
    notes: notes.length > 0 ? notes.join("; ") : undefined,
  }
}
