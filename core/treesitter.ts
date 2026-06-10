/**
 * treesitter.ts — tree-sitter WASM grammar extension for the nav-mcp outline chain.
 *
 * Provides a richer, language-aware outline for extensions not served by LSP
 * (between the LSP rung and the ctags/regex fallback).
 *
 * ABI safety: each grammar is probed with Language.load() at init time; any that
 * throw (ABI mismatch, missing file) are silently excluded from the live map.
 * The server never crashes on a bad grammar — it degrades to the next rung.
 *
 * Supported extensions (confirmed in tree-sitter-wasms@0.1.13):
 *   .java .c .h .cpp .cc .cxx .hpp .hxx .cs .kt .kts .rb .sh .bash
 *   .toml .yaml .yml .json .jsonc .lua .scala
 */

import { resolve } from "node:path"
import { readFileSync } from "node:fs"

export interface TsSymbol {
  name: string
  kind: string
  startLine: number  // 1-based
  endLine: number    // 1-based
}

// ── grammar map ───────────────────────────────────────────────────────────────

const EXT_GRAMMAR: Record<string, string> = {
  ".java":  "tree-sitter-java.wasm",
  ".c":     "tree-sitter-c.wasm",
  ".h":     "tree-sitter-c.wasm",
  ".cpp":   "tree-sitter-cpp.wasm",
  ".cc":    "tree-sitter-cpp.wasm",
  ".cxx":   "tree-sitter-cpp.wasm",
  ".hpp":   "tree-sitter-cpp.wasm",
  ".hxx":   "tree-sitter-cpp.wasm",
  ".cs":    "tree-sitter-c_sharp.wasm",
  ".kt":    "tree-sitter-kotlin.wasm",
  ".kts":   "tree-sitter-kotlin.wasm",
  ".rb":    "tree-sitter-ruby.wasm",
  ".sh":    "tree-sitter-bash.wasm",
  ".bash":  "tree-sitter-bash.wasm",
  ".toml":  "tree-sitter-toml.wasm",
  ".yaml":  "tree-sitter-yaml.wasm",
  ".yml":   "tree-sitter-yaml.wasm",
  ".json":  "tree-sitter-json.wasm",
  ".jsonc": "tree-sitter-json.wasm",
  ".lua":   "tree-sitter-lua.wasm",
  ".scala": "tree-sitter-scala.wasm",
}

// ── lazy init ─────────────────────────────────────────────────────────────────

let Parser: typeof import("web-tree-sitter") | null = null
let parserInitialized = false
let liveExtMap: Record<string, string> | null = null

function wasmPackageDir(): string {
  try {
    // tree-sitter-wasms places wasm files in the out/ subdirectory
    const pkgJson = require.resolve("tree-sitter-wasms/package.json")
    return resolve(pkgJson, "..", "out")
  } catch {
    return resolve(process.cwd(), "node_modules", "tree-sitter-wasms", "out")
  }
}

async function probeGrammar(Language: any, wasmPath: string, name: string): Promise<boolean> {
  try {
    await Language.load(wasmPath)
    return true
  } catch (e) {
    if (process.env.NAV_TS_DEBUG) console.error(`[treesitter] grammar ${name} ABI probe failed: ${e}`)
    return false
  }
}

async function ensureReady(): Promise<{ Parser: typeof import("web-tree-sitter"); liveMap: Record<string, string> } | null> {
  if (liveExtMap !== null && Parser !== null) return { Parser, liveMap: liveExtMap }

  try {
    const mod = await import("web-tree-sitter")
    // web-tree-sitter 0.25.x: Parser and Language are named exports, not a default
    const ParserCls = (mod as any).Parser ?? mod.default
    if (!ParserCls || typeof ParserCls.init !== "function") {
      throw new Error("web-tree-sitter: cannot find Parser.init — unexpected module shape")
    }
    await ParserCls.init()
    Parser = ParserCls
    parserInitialized = true
  } catch (e) {
    if (process.env.NAV_TS_DEBUG) console.error(`[treesitter] Parser.init failed: ${e}`)
    liveExtMap = {}
    return null
  }

  const dir = wasmPackageDir()
  const mod2 = await import("web-tree-sitter")
  const Language = (mod2 as any).Language

  const probeResults = await Promise.all(
    Object.entries(EXT_GRAMMAR).map(async ([ext, wasmFile]) => {
      const wasmPath = resolve(dir, wasmFile)
      const ok = await probeGrammar(Language, wasmPath, wasmFile)
      return ok ? { ext, wasmPath } : null
    }),
  )

  liveExtMap = {}
  for (const r of probeResults) {
    if (r) liveExtMap[r.ext] = r.wasmPath
  }

  if (process.env.NAV_TS_DEBUG) {
    const total = Object.keys(EXT_GRAMMAR).length
    const live = Object.keys(liveExtMap).length
    console.error(`[treesitter] probeGrammars: ${live}/${total} passed ABI check`)
  }

  return { Parser: Parser!, liveMap: liveExtMap }
}

// ── symbol extraction ─────────────────────────────────────────────────────────

// Node types that represent named declarations across supported languages.
// Covers both long-form (Java/C#/Kotlin) and short-form (Ruby/Lua) type names.
const DECL_TYPES = new Set([
  // Functions / methods (long-form)
  "function_declaration", "function_definition", "function_item",
  "method_declaration", "method_definition",
  // Short-form (Ruby, Lua, bash)
  "method", "function", "singleton_method",
  // Classes / structs
  "class_declaration", "class_definition", "class",
  "struct_item", "impl_item", "struct_specifier",
  // Interfaces / types
  "interface_declaration", "interface_definition",
  "type_alias_declaration", "type_definition",
  // Enums
  "enum_declaration", "enum_definition", "enum_item", "enum_specifier",
  // Namespaces / modules
  "namespace_declaration", "namespace_definition",
  "module_item", "module",
  // Constants / statics
  "const_declaration", "const_item",
  "static_item",
  // Top-level variables (JS/TS)
  "lexical_declaration", "variable_declaration",
])

// Intermediate "body" container types that should be traversed but not collected
const BODY_TYPES = new Set([
  "class_body", "body_statement", "declaration_list", "block",
  "namespace_body", "module_body", "source_file", "program",
  "translation_unit",  // C/C++
  "compilation_unit",  // Java/C#
])

function kindLabel(nodeType: string): string {
  if (/function|method|fn/.test(nodeType)) return "Function"
  if (/class/.test(nodeType)) return "Class"
  if (/interface/.test(nodeType)) return "Interface"
  if (/struct|impl/.test(nodeType)) return "Struct"
  if (/enum/.test(nodeType)) return "Enum"
  if (/type/.test(nodeType)) return "Type"
  if (/namespace|module/.test(nodeType)) return "Module"
  if (/const|static/.test(nodeType)) return "Const"
  return "Symbol"
}

function extractName(node: any): string {
  const nameNode = node.childForFieldName?.("name") ?? node.firstNamedChild
  return (nameNode?.text ?? "").split(/\s+/)[0] ?? ""
}

function collectSymbols(node: any, out: TsSymbol[], maxDepth: number, depth = 0): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child || !child.isNamed) continue

    if (DECL_TYPES.has(child.type)) {
      const name = extractName(child)
      if (name) {
        out.push({
          name,
          kind: kindLabel(child.type),
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        })
      }
      // Recurse into container declarations (class bodies, impl blocks, etc.) to collect members
      if (depth < maxDepth) {
        collectSymbols(child, out, maxDepth, depth + 1)
      }
    } else if (BODY_TYPES.has(child.type) && depth < maxDepth) {
      // Traverse intermediate body containers without incrementing depth
      collectSymbols(child, out, maxDepth, depth)
    }
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/** Returns true if the extension has a probe-verified grammar available. */
export async function hasGrammarForExt(ext: string): Promise<boolean> {
  const ctx = await ensureReady()
  if (!ctx) return false
  return ext.toLowerCase() in ctx.liveMap
}

/**
 * Parse a file and return top-level symbols using tree-sitter.
 * Returns null if the grammar is unavailable or parsing fails.
 */
export async function tsOutline(filePath: string, ext: string): Promise<TsSymbol[] | null> {
  const ctx = await ensureReady()
  if (!ctx) return null

  const wasmPath = ctx.liveMap[ext.toLowerCase()]
  if (!wasmPath) return null

  try {
    const wtsmod = await import("web-tree-sitter")
    const Language = (wtsmod as any).Language
    const language = await Language.load(wasmPath)
    const parser = new (ctx.Parser as any)()
    parser.setLanguage(language)

    const source = readFileSync(filePath, "utf8")
    const tree = parser.parse(source)
    if (!tree) return null

    const symbols: TsSymbol[] = []
    collectSymbols(tree.rootNode, symbols, 2)  // depth 2: top-level + one nesting (class members)
    return symbols.length > 0 ? symbols : null
  } catch (e) {
    if (process.env.NAV_TS_DEBUG) console.error(`[treesitter] tsOutline failed for ${filePath}: ${e}`)
    return null
  }
}
