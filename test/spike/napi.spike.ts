/**
 * M0 Spike: @ast-grep/napi under Bun
 *
 * Tests:
 * 1. parse() — parse a TS fixture and verify AST root
 * 2. findInFiles() — search test/fixtures/ for "console.log($A)" pattern, assert ≥1 match
 *
 * Pass: both assertions succeed
 * Fail: any assertion fails or import throws
 */

import { parse, findInFiles, Lang } from "@ast-grep/napi";
import { readFileSync } from "fs";
import { join } from "path";

const FIXTURE_PATH = join(import.meta.dir, "..", "fixtures", "sample.ts");
const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures");

console.log("=== @ast-grep/napi Spike ===");
console.log(`Fixture: ${FIXTURE_PATH}`);

// --- Test 1: parse() ---
console.log("\n[Test 1] parse() — TS fixture");
try {
  const code = readFileSync(FIXTURE_PATH, "utf-8");
  const root = parse(Lang.TypeScript, code);
  const rootString = root.root().toString();
  console.log(`  AST root (first 200 chars): ${rootString.slice(0, 200)}...`);
  if (rootString.length === 0) {
    throw new Error("parse() returned empty AST");
  }
  console.log("  ✓ parse() succeeded");
} catch (e) {
  console.error("  ✗ parse() FAILED:", e);
  process.exit(1);
}

// --- Test 2: findInFiles() ---
console.log("\n[Test 2] findInFiles() — console.log($A) in fixtures/");
try {
  const matches = await new Promise<{ file: string; range: { start: { line: number; column: number }; end: { line: number; column: number } }; text: () => string }[]>((resolve, reject) => {
    const results: { file: string; range: { start: { line: number; column: number }; end: { line: number; column: number } }; text: () => string }[] = [];
    findInFiles(
      Lang.TypeScript,
      {
        paths: [FIXTURE_DIR],
        matcher: {
          rule: {
            pattern: "console.log($A)",
          },
        },
      },
      (err, nodes) => {
        if (err) {
          reject(err);
          return;
        }
        for (const node of nodes) {
          const range = node.range();
          results.push({
            file: node.getRoot().filename(),
            range: range,
            text: () => node.text(),
          });
        }
      }
    ).then(() => resolve(results)).catch(reject);
  });

  console.log(`  Found ${matches.length} match(es):`);
  for (const m of matches) {
    console.log(`    ${m.file}:${m.range.start.line}:${m.range.start.column} — "${m.text()}"`);
  }

  if (matches.length < 1) {
    throw new Error(`findInFiles() returned ${matches.length} matches, expected ≥1`);
  }
  console.log("  ✓ findInFiles() succeeded");
} catch (e) {
  console.error("  ✗ findInFiles() FAILED:", e);
  process.exit(1);
}

console.log("\n=== All spike tests PASSED ===");
