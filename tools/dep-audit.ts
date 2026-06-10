import { runBounded, findProjectRoot } from "../lib/withTimeout";
import type { NavEnvelope } from "../lib/withTimeout";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * dep-audit — Dependency vulnerability audit. Detects the project stack
 * (npm/pip/cargo/go) and runs the appropriate audit tool, returning ONLY
 * failures + a PASS/FAIL tally.
 *
 * M6 adaptation: exported function returning NavEnvelope instead of
 * opencode-ai/plugin tool() wrapper. Online calls emit an upfront warning
 * since they send dependency data to external registries.
 *
 * readOnlyHint: this tool reads lockfiles and invokes audit processes but
 * never mutates lockfiles, manifests, or source code.
 */

const MARKERS = ["package-lock.json", "bun.lock", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod"];

// ── .env plane guard ─────────────────────────────────────────────────────────
const ENV_RE = /(^|[\\/])\.env(\b|\.)/i;
const ENV_OK = /\.env\.(example|sample|template)$/i;

export interface DepAuditArgs {
  /** Project directory to audit (default: auto-detect from cwd) */
  path?: string;
  /** Use cached advisory data only; skip external network calls */
  offline?: boolean;
  /** Minimum severity to report: "critical", "high", or "all" */
  severity?: "critical" | "high" | "all";
}

type AuditEntry = {
  engine: string;
  failures: string[];
  clean?: boolean;
  skipped?: boolean;
  reason?: string;
};

/**
 * Dependency vulnerability audit.
 *
 * @param args.path     - Project directory to audit (default: auto-detect from cwd)
 * @param args.offline  - Use cached advisory data only (default: false)
 * @param args.severity - Minimum severity to report: "critical" | "high" | "all" (default: "high")
 */
export async function depAuditTool(args: DepAuditArgs): Promise<NavEnvelope> {
  // ── .env plane guard (path must never point at a secret) ────────────────
  if (args.path && ENV_RE.test(args.path) && !ENV_OK.test(args.path)) {
    return {
      ok: false,
      mode: "dep_audit",
      engine: "dep-audit",
      notes: "[dep-audit REFUSED] target path looks like a .env file — secrets must not pass through tool output.",
    };
  }

  const startDir = args.path ?? process.cwd();
  const root = findProjectRoot(startDir, MARKERS) ?? startDir;

  // ── Upfront online warning ─────────────────────────────────────────────
  const onlineNotes: string[] = [];
  if (!args.offline) {
    onlineNotes.push(
      "Online mode: dependency data will be sent to external registries (npm/PyPA/go.dev). " +
      "Set offline=true for air-gapped/corporate environments.",
    );
  }

  const results: AuditEntry[] = [];

  // ── npm / bun ──────────────────────────────────────────────────────────
  if (existsSync(join(root, "package-lock.json")) || existsSync(join(root, "bun.lock"))) {
    const cmd = args.offline
      ? ["npm", "audit", "--offline", "--json", "--audit-level=high"]
      : ["npm", "audit", "--json", "--audit-level=high"];
    const r = await runBounded(cmd, { cwd: root, timeoutMs: 30_000 });
    if (!r.ok) {
      results.push({ engine: "npm", failures: [], skipped: true, reason: r.notes ?? "spawn failed" });
    } else {
      const result = r.payload!;
      if (result.spawnError) {
        results.push({ engine: "npm", failures: [], skipped: true, reason: result.spawnError });
      } else if (result.timedOut) {
        results.push({ engine: "npm", failures: [], skipped: true, reason: "timed out" });
      } else {
        try {
          const data = JSON.parse(result.stdout) as { vulnerabilities?: Record<string, { severity: string; isDirect: boolean }> };
          const vulns = Object.entries(data.vulnerabilities ?? {})
            .filter(([, v]) => {
              if (args.severity === "critical") return v.severity === "critical";
              if (args.severity === "all") return true;
              return v.severity === "critical" || v.severity === "high";
            })
            .map(([name, v]) => `${name} (${v.severity}${v.isDirect ? ", direct" : ""})`);
          results.push({ engine: "npm", failures: vulns, clean: vulns.length === 0 });
        } catch {
          results.push({ engine: "npm", failures: [], skipped: true, reason: "failed to parse npm audit output" });
        }
      }
    }
  }

  // ── Python pip-audit ───────────────────────────────────────────────────
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) {
    const cmd = args.offline
      ? ["uv", "run", "pip-audit", "--local", "--format=json"]
      : ["uv", "run", "pip-audit", "--format=json"];
    const r = await runBounded(cmd, { cwd: root, timeoutMs: 60_000 });
    if (!r.ok) {
      results.push({ engine: "pip-audit", failures: [], skipped: true, reason: r.notes ?? "spawn failed" });
    } else {
      const result = r.payload!;
      if (result.spawnError) {
        results.push({ engine: "pip-audit", failures: [], skipped: true, reason: result.spawnError });
      } else if (result.timedOut) {
        results.push({ engine: "pip-audit", failures: [], skipped: true, reason: "timed out" });
      } else {
        try {
          const data = JSON.parse(result.stdout) as Array<{ name: string; version: string; vulns: Array<{ id: string; description: string }> }>;
          const vulns = data.flatMap((pkg) =>
            pkg.vulns.map((v) => `${pkg.name}@${pkg.version} — ${v.id}: ${v.description.slice(0, 120)}`),
          );
          results.push({ engine: "pip-audit", failures: vulns, clean: vulns.length === 0 });
        } catch {
          results.push({ engine: "pip-audit", failures: [], skipped: true, reason: "failed to parse pip-audit output" });
        }
      }
    }
  }

  // ── Rust cargo-audit ───────────────────────────────────────────────────
  if (existsSync(join(root, "Cargo.toml"))) {
    const cmd = args.offline
      ? ["cargo", "audit", "--no-fetch", "--json"]
      : ["cargo", "audit", "--json"];
    const r = await runBounded(cmd, { cwd: root, timeoutMs: 60_000 });
    if (!r.ok) {
      results.push({ engine: "cargo-audit", failures: [], skipped: true, reason: r.notes ?? "spawn failed" });
    } else {
      const result = r.payload!;
      if (result.spawnError) {
        results.push({ engine: "cargo-audit", failures: [], skipped: true, reason: result.spawnError });
      } else if (result.timedOut) {
        results.push({ engine: "cargo-audit", failures: [], skipped: true, reason: "timed out" });
      } else {
        try {
          const data = JSON.parse(result.stdout) as {
            vulnerabilities?: { list?: Array<{ advisory: { id: string; title: string }; package: { name: string; version: string } }> };
          };
          const vulns = (data.vulnerabilities?.list ?? []).map(
            (v) => `${v.package.name}@${v.package.version} — ${v.advisory.id}: ${v.advisory.title}`,
          );
          results.push({ engine: "cargo-audit", failures: vulns, clean: vulns.length === 0 });
        } catch {
          results.push({ engine: "cargo-audit", failures: [], skipped: true, reason: "failed to parse cargo audit output" });
        }
      }
    }
  }

  // ── Go govulncheck ─────────────────────────────────────────────────────
  if (existsSync(join(root, "go.mod"))) {
    if (args.offline) {
      results.push({ engine: "govulncheck", failures: [], skipped: true, reason: "offline mode; govulncheck requires network" });
    } else {
      const r = await runBounded(["govulncheck", "-json", "./..."], { cwd: root, timeoutMs: 60_000 });
      if (!r.ok) {
        results.push({ engine: "govulncheck", failures: [], skipped: true, reason: r.notes ?? "spawn failed" });
      } else {
        const result = r.payload!;
        if (result.spawnError) {
          results.push({ engine: "govulncheck", failures: [], skipped: true, reason: result.spawnError });
        } else if (result.timedOut) {
          results.push({ engine: "govulncheck", failures: [], skipped: true, reason: "timed out" });
        } else {
          try {
            const vulns: string[] = [];
            for (const line of result.stdout.split("\n")) {
              const t = line.trim();
              if (!t) continue;
              try {
                const obj = JSON.parse(t) as { finding?: { osv: string; trace?: Array<{ module: string; version: string }> } };
                if (obj.finding) {
                  const mod = obj.finding.trace?.[0]?.module ?? "unknown";
                  const ver = obj.finding.trace?.[0]?.version ?? "";
                  vulns.push(`${mod}${ver ? `@${ver}` : ""} — ${obj.finding.osv}`);
                }
              } catch { /* not a finding line */ }
            }
            results.push({ engine: "govulncheck", failures: vulns, clean: vulns.length === 0 });
          } catch {
            results.push({ engine: "govulncheck", failures: [], skipped: true, reason: "failed to parse govulncheck output" });
          }
        }
      }
    }
  }

  // ── Build result ───────────────────────────────────────────────────────
  if (results.length === 0) {
    const payload = "[dep-audit] no recognized project lockfile found (package-lock.json, bun.lock, pyproject.toml, requirements.txt, Cargo.toml, go.mod)";
    return {
      ok: true,
      mode: "dep_audit",
      engine: "dep-audit",
      payload,
      notes: onlineNotes.length ? onlineNotes.join(" ") : undefined,
    };
  }

  const allFailures = results.flatMap((r) => r.failures);
  const passCount = results.filter((r) => r.clean).length;
  const failCount = results.filter((r) => !r.clean && !r.skipped).length;
  const skipCount = results.filter((r) => r.skipped).length;
  const engines = results.map((r) => (r.skipped ? `${r.engine}(skipped: ${r.reason ?? "?"})` : r.engine));
  const tally = `PASS ${passCount}  FAIL ${failCount}  SKIP ${skipCount}   [engines: ${engines.join(", ")}]`;

  if (allFailures.length === 0 && failCount === 0) {
    return {
      ok: true,
      mode: "dep_audit",
      engine: "dep-audit",
      payload: `All audits clean.\n${tally}`,
      notes: onlineNotes.length ? onlineNotes.join(" ") : undefined,
    };
  }

  return {
    ok: true,
    mode: "dep_audit",
    engine: "dep-audit",
    payload: `${allFailures.join("\n")}\n\n${tally}`,
    notes: onlineNotes.length ? onlineNotes.join(" ") : undefined,
  };
}
