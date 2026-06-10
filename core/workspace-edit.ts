/**
 * workspace-edit.ts — apply LSP WorkspaceEdit responses to disk.
 *
 * Handles both format variants:
 *   - changes: { uri: TextEdit[] }           (LSP 3.14 and older)
 *   - documentChanges: TextDocumentEdit[]    (LSP 3.15+)
 *
 * Safety rules (from Attack 3):
 *   - File create/rename/delete operations cause an immediate refusal (never partial apply)
 *   - Edits are applied per-file in REVERSE range order to preserve position offsets
 *   - All-or-nothing: if any file read/write fails, the operation errors
 *
 * R8 amendment: retryOnLock wraps fs.writeFile to handle Windows Defender
 * transient file locks (EPERM/EBUSY/EACCES) with exponential backoff.
 */

import { readFile, writeFile } from "node:fs/promises"

// ─── R8: retryOnLock ────────────────────────────────────────────────────────

interface RetryOnLockOpts {
  /** Maximum retry attempts. Default: 5 */
  tries?: number
  /** Base delay in ms before first retry. Default: 100 */
  baseMs?: number
  /** Exponential base for backoff. Default: 2 */
  exp?: number
  /** Error codes eligible for retry. Default: ['EPERM', 'EBUSY', 'EACCES'] */
  codes?: string[]
}

const DEFAULT_RETRY_CODES = ["EPERM", "EBUSY", "EACCES"] as const

/**
 * Retry an async operation on Windows Defender transient lock errors.
 *
 * Uses exponential backoff: `baseMs * exp^attempt` between retries.
 * If the error code is not in the retry set or max tries is exceeded,
 * the original error is re-thrown.
 */
export async function retryOnLock<T>(
  fn: () => Promise<T>,
  opts?: RetryOnLockOpts,
): Promise<T> {
  const tries = opts?.tries ?? 5
  const baseMs = opts?.baseMs ?? 100
  const exp = opts?.exp ?? 2
  const codes = opts?.codes ?? [...DEFAULT_RETRY_CODES]

  let lastError: unknown

  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      lastError = err

      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : ""

      if (!codes.includes(code)) {
        // Not a retryable error — fail immediately
        throw err
      }

      if (attempt < tries - 1) {
        const delay = baseMs * Math.pow(exp, attempt)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  // All retries exhausted
  throw lastError
}

// ─── LSP types ──────────────────────────────────────────────────────────────

export interface Position {
  line: number
  character: number
}
export interface Range {
  start: Position
  end: Position
}
export interface TextEdit {
  range: Range
  newText: string
}
export interface TextDocumentEdit {
  textDocument: { uri: string; version?: number | null }
  edits: TextEdit[]
}
export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>
  documentChanges?: Array<TextDocumentEdit | { kind: string }>
  changeAnnotations?: unknown
}

export interface ApplyResult {
  filesChanged: number
  totalEdits: number
  changed: Array<{ file: string; editsCount: number }>
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** True when the edit contains file-level operations (create/rename/delete). */
export function hasFileOperations(edit: WorkspaceEdit): boolean {
  if (!edit.documentChanges) return false
  return edit.documentChanges.some((c) => "kind" in c)
}

/** Collect all TextEdit arrays keyed by file URI, merging both format variants. */
function collectEditsMap(edit: WorkspaceEdit): Map<string, TextEdit[]> {
  const map = new Map<string, TextEdit[]>()

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      map.set(uri, [...(map.get(uri) ?? []), ...edits])
    }
  }

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("kind" in change) continue // file operation — caller should have refused already
      const tde = change as TextDocumentEdit
      map.set(tde.textDocument.uri, [...(map.get(tde.textDocument.uri) ?? []), ...tde.edits])
    }
  }

  return map
}

function fileUriToPath(uri: string): string {
  let p = uri
  try {
    p = decodeURIComponent(uri)
  } catch {
    /* keep raw */
  }
  p = p.replace(/^file:\/\//, "")
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return p.replace(/\//g, "\\") // normalize to Windows paths
}

/** Apply a list of edits to a file in reverse-range order (preserves offsets). */
function applyEditsToContent(content: string, edits: TextEdit[]): string {
  const lines = content.split(/\r?\n/)
  const eol = content.includes("\r\n") ? "\r\n" : "\n"

  // Sort DESCENDING by start position so later edits don't invalidate earlier positions
  const sorted = [...edits].sort((a, b) => {
    if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line
    return b.range.start.character - a.range.start.character
  })

  for (const edit of sorted) {
    const { start, end } = edit.range
    const startLine = lines[start.line] ?? ""
    const endLine = lines[end.line] ?? ""
    const before = startLine.slice(0, start.character)
    const after = endLine.slice(end.character)
    const replacement = (before + edit.newText + after).split(/\r?\n/)
    lines.splice(start.line, end.line - start.line + 1, ...replacement)
  }

  return lines.join(eol)
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Apply a WorkspaceEdit to disk. Refuses if file operations are present.
 * Returns a summary of what changed.
 *
 * Writes are wrapped in retryOnLock (R8) to survive Windows Defender
 * transient file locks with exponential backoff.
 */
export async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<ApplyResult> {
  if (hasFileOperations(edit)) {
    throw new Error("rename involves file create/rename/delete operations — apply manually")
  }

  const editsMap = collectEditsMap(edit)
  if (editsMap.size === 0) {
    return { filesChanged: 0, totalEdits: 0, changed: [] }
  }

  const changed: ApplyResult["changed"] = []
  let totalEdits = 0

  for (const [uri, edits] of editsMap) {
    const filePath = fileUriToPath(uri)

    // Read the original file (no retry needed for reads — transient lock is write-side)
    const original = await readFile(filePath, "utf8")
    const updated = applyEditsToContent(original, edits)

    // R8: wrap the write in retryOnLock for Windows Defender transient locks
    await retryOnLock(() => writeFile(filePath, updated, "utf8"))

    changed.push({ file: filePath, editsCount: edits.length })
    totalEdits += edits.length
  }

  return { filesChanged: changed.length, totalEdits, changed }
}
