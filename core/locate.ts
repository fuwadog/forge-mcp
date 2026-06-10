// Path-resolution helpers for the NAV core. Copied verbatim from the proven
// tools/_shared/locate.ts so the MCP core heals path drift identically to the
// legacy outline/smart-read/patch-lines tools it supersedes.
// Pure fs/path only -> no external deps -> safe inside the standalone MCP process.
import { existsSync, statSync, readdirSync } from "fs"
import { dirname, basename, join } from "path"

// LLMs handle POSIX-style paths more reliably and avoid backslash-escape glitches.
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/")
}

// Ordered, de-duplicated package-index filenames to try when healing
// `foo.<ext>` -> `foo/<index>`. Prefers the requested extension's language family.
export function indexCandidates(reqExt: string): string[] {
  const byExt: Record<string, string[]> = {
    py: ["__init__.py", "index.py"],
    rs: ["mod.rs", "lib.rs", "index.rs"],
    go: ["index.go"],
    java: ["index.java"],
  }
  const generic = [
    "index.ts", "index.tsx", "index.js", "index.jsx", "index.mts", "index.cts", "index.mjs", "index.cjs",
    "index.vue", "index.svelte", "index.html", "__init__.py", "mod.rs", "lib.rs",
  ]
  const ordered = [...(byExt[reqExt] ?? []), ...(reqExt ? [`index.${reqExt}`] : []), ...generic]
  return [...new Set(ordered)]
}

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) d[i][0] = i
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[m][n]
}

export type LocateResult = { healed?: string; note?: string; diag?: string }

// Resolve a requested absolute path to an existing FILE, self-healing common drift.
export function locate(abs: string, relocateHint = "`list`/`outline`"): LocateResult {
  if (existsSync(abs) && statSync(abs).isFile()) return { healed: abs }

  const dir = dirname(abs)
  const name = basename(abs)
  const stem = name.replace(/\.[^.]+$/, "")
  const reqExt = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : ""

  // 1. directory-with-index form (foo.ts -> foo/index.ts ; foo.py -> foo/__init__.py)
  const idxDir = join(dir, stem)
  if (existsSync(idxDir) && statSync(idxDir).isDirectory()) {
    for (const f of indexCandidates(reqExt)) {
      const cand = join(idxDir, f)
      if (existsSync(cand)) return { healed: cand, note: `[self-heal: "${name}" -> "${toPosix(join(stem, f))}" (directory-with-index form)]` }
    }
  }

  // 2. requested path is itself a directory -> its index file
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    for (const f of indexCandidates(reqExt)) {
      const cand = join(abs, f)
      if (existsSync(cand)) return { healed: cand, note: `[self-heal: directory "${name}" -> "${toPosix(join(name, f))}"]` }
    }
  }

  // 3. nearest-name match inside the parent directory
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    const entries = readdirSync(dir, { withFileTypes: true })
    const files = entries.filter((e) => e.isFile()).map((e) => e.name)

    const stemMatch = files.filter((f) => f.replace(/\.[^.]+$/, "").toLowerCase() === stem.toLowerCase())
    if (stemMatch.length === 1)
      return { healed: join(dir, stemMatch[0]), note: `[self-heal: "${name}" -> "${stemMatch[0]}" (same name, different extension)]` }

    const near = files
      .map((f) => ({ f, d: levenshtein(f.toLowerCase(), name.toLowerCase()) }))
      .sort((a, b) => a.d - b.d)
      .filter((r) => r.d <= Math.max(2, Math.ceil(name.length * 0.34)))
      .slice(0, 5)
      .map((r) => r.f)

    const listing = entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).slice(0, 60)
    return {
      diag:
        `FILE NOT FOUND: ${toPosix(abs)}\n` +
        `Parent dir contains (${entries.length}): ${listing.join(", ")}` +
        (near.length ? `\nClosest names: ${near.join(", ")}` : "") +
        `\nRelocate with ${relocateHint} - do not guess the path.`,
    }
  }

  return { diag: `FILE NOT FOUND: ${toPosix(abs)}\nParent directory does not exist either: ${toPosix(dir)}\nRelocate with ${relocateHint} - do not guess the path.` }
}
