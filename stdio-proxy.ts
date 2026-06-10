#!/usr/bin/env bun
/**
 * forge-mcp stdio proxy — bridges stdin/stdout ↔ daemon HTTP.
 *
 * Usage: forge-mcp-stdio (or configured as MCP server command)
 *
 * Boot protocol:
 *   1. Read daemon.json from %LOCALAPPDATA%\forge-mcp
 *   2. Healthy + version match → bridge stdio ↔ HTTP (SSE streaming)
 *   3. Version mismatch → POST /admin/restart → wait → respawn daemon → bridge
 *   4. Daemon absent/stale → boot.lock arbitration → spawn daemon detached → bridge
 *   5. Daemon unstartable → EMBEDDED MODE (import core/ in-process, single-client)
 *
 * FORGE_EMBEDDED=1 forces embedded mode.
 */
import { spawn, type Subprocess } from "bun";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── State directory resolution (same as core/statePaths) ───────────────────
const LOCALAPPDATA =
  process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const STATE_DIR = join(LOCALAPPDATA, "forge-mcp");
const DAEMON_JSON = join(STATE_DIR, "daemon.json");
const BOOT_LOCK = join(STATE_DIR, "boot.lock");

// ── Config ─────────────────────────────────────────────────────────────────
let forgeVersion = "0.0.0-dev";
try {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf-8"));
  forgeVersion = pkg.version ?? forgeVersion;
} catch {
  // stay "0.0.0-dev"
}

interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  forgeVersion: string;
  startedAt: string;
}

// ── Read daemon.json ───────────────────────────────────────────────────────
function readDaemonJson(): DaemonInfo | null {
  try {
    if (!existsSync(DAEMON_JSON)) return null;
    return JSON.parse(readFileSync(DAEMON_JSON, "utf-8"));
  } catch {
    return null;
  }
}

// ── Health probe ───────────────────────────────────────────────────────────
async function probeHealth(
  port: number,
  token: string,
): Promise<{ ok: boolean; forgeVersion: string }> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return { ok: false, forgeVersion: "" };
    const body = (await resp.json()) as { ok: boolean; forgeVersion: string };
    return { ok: body.ok, forgeVersion: body.forgeVersion };
  } catch {
    return { ok: false, forgeVersion: "" };
  }
}

// ── Boot lock arbitration ──────────────────────────────────────────────────
async function acquireBootLock(): Promise<boolean> {
  // O_EXCL-like: try to create exclusively
  try {
    const file = Bun.file(BOOT_LOCK, { type: "application/json" });
    if (await file.exists()) {
      // Another process holds the lock — poll for daemon.json
      return false;
    }
  } catch {
    // file doesn't exist — proceed
  }

  try {
    // Write our PID into the lock file
    await Bun.write(BOOT_LOCK, JSON.stringify({ pid: process.pid }));
    return true;
  } catch {
    return false;
  }
}

// ── Spawn daemon detached ──────────────────────────────────────────────────
async function spawnDaemonDetached(): Promise<boolean> {
  const daemonScript = join(import.meta.dir, "daemon.ts");
  try {
    const proc = spawn(["bun", "daemon.ts"], {
      cwd: import.meta.dir,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    // Release the lock after a short delay (daemon will write daemon.json)
    proc.unref();
    return true;
  } catch {
    return false;
  }
}

// ── Poll for daemon.json ───────────────────────────────────────────────────
async function pollForDaemonJson(
  timeoutMs = 10_000,
): Promise<DaemonInfo | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = readDaemonJson();
    if (info) return info;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

// ── Bridge stdio ↔ HTTP ────────────────────────────────────────────────────
async function bridgeStdioToHttp(
  port: number,
  token: string,
  sessionId?: string,
): Promise<void> {
  // Read lines from stdin and forward to the daemon's /mcp endpoint
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Start a session if we don't have one
  let currentSessionId = sessionId;
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;

  process.stdin.setEncoding("utf-8");

  let buffer = "";
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;
    // Process complete lines (newline-delimited JSON-RPC)
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const message = JSON.parse(line);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        };
        if (currentSessionId) {
          headers["Mcp-Session-Id"] = currentSessionId;
        }

        const resp = await fetch(mcpUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(message),
        });

        // Capture session ID from response
        const newSid = resp.headers.get("mcp-session-id");
        if (newSid) currentSessionId = newSid;

        // Parse response body
        const contentType = resp.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream")) {
          // SSE stream — read and emit events
          const reader = resp.body?.getReader();
          if (reader) {
            let sseBuffer = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              sseBuffer += decoder.decode(value, { stream: true });
              // Process SSE events
              const events = sseBuffer.split("\n\n");
              sseBuffer = events.pop() ?? "";
              for (const evt of events) {
                const dataLine = evt
                  .split("\n")
                  .find((l) => l.startsWith("data: "));
                if (dataLine) {
                  const jsonStr = dataLine.slice(6);
                  if (jsonStr) {
                    process.stdout.write(jsonStr + "\n");
                  }
                }
              }
            }
          }
        } else {
          // JSON response
          const body = await resp.text();
          if (body) {
            process.stdout.write(body + "\n");
          }
        }
      } catch (err) {
        // Never crash on a single message error
        process.stderr.write(`[proxy] message error: ${String(err)}\n`);
      }
    }
  });

  process.stdin.on("end", async () => {
    // Clean exit → HTTP DELETE session
    if (currentSessionId) {
      try {
        await fetch(mcpUrl, {
          method: "DELETE",
          headers: {
            "Mcp-Session-Id": currentSessionId,
            Authorization: `Bearer ${token}`,
          },
        });
      } catch {
        // best-effort cleanup
      }
    }
  });
}

// ── Main boot sequence ─────────────────────────────────────────────────────
async function main(): Promise<void> {
  // FORGE_EMBEDDED=1 → force embedded mode
  if (process.env.FORGE_EMBEDDED === "1") {
    console.error("[proxy] FORGE_EMBEDDED=1 — entering embedded mode");
    await enterEmbeddedMode();
    return;
  }

  const daemonInfo = readDaemonJson();

  // ── Case 1: daemon.json exists → probe health ──────────────────────
  if (daemonInfo) {
    const health = await probeHealth(daemonInfo.port, daemonInfo.token);

    if (health.ok) {
      // Version match → bridge
      if (health.forgeVersion === forgeVersion) {
        await bridgeStdioToHttp(daemonInfo.port, daemonInfo.token);
        return;
      }

      // Version mismatch → POST /admin/restart → wait → respawn
      console.error(
        `[proxy] version mismatch: daemon=${health.forgeVersion} client=${forgeVersion} — restarting daemon`,
      );
      try {
        await fetch(
          `http://127.0.0.1:${daemonInfo.port}/admin/restart`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${daemonInfo.token}` },
            signal: AbortSignal.timeout(5000),
          },
        );
      } catch {
        // daemon may have already exited
      }

      // Wait for daemon.json to be cleaned up, then spawn fresh
      const start = Date.now();
      while (existsSync(DAEMON_JSON) && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 100));
      }

      // Try boot lock + spawn
      const lockWon = await acquireBootLock();
      if (lockWon) {
        await spawnDaemonDetached();
        const newInfo = await pollForDaemonJson();
        if (newInfo) {
          await bridgeStdioToHttp(newInfo.port, newInfo.token);
          return;
        }
      }
      // Fallback: enter embedded mode
      console.error("[proxy] daemon unstartable after restart — entering embedded mode");
      await enterEmbeddedMode();
      return;
    }

    // Daemon present but unhealthy → assume stale, try boot lock
    console.error("[proxy] daemon unhealthy — attempting re-spawn");
  }

  // ── Case 2: daemon.json absent → boot lock arbitration ──────────────
  const lockWon = await acquireBootLock();
  if (lockWon) {
    // We won the race — spawn daemon detached
    const spawned = await spawnDaemonDetached();
    if (spawned) {
      const info = await pollForDaemonJson();
      if (info) {
        await bridgeStdioToHttp(info.port, info.token);
        return;
      }
    }
    console.error("[proxy] daemon failed to start — entering embedded mode");
    await enterEmbeddedMode();
    return;
  }

  // ── Case 3: lock held by another process → poll for daemon.json ────
  const info = await pollForDaemonJson();
  if (info) {
    await bridgeStdioToHttp(info.port, info.token);
    return;
  }

  // ── Case 4: everything failed → embedded mode ──────────────────────
  console.error("[proxy] daemon unavailable — entering embedded mode");
  await enterEmbeddedMode();
}

// ── Embedded mode (fallback floor) ─────────────────────────────────────────
async function enterEmbeddedMode(): Promise<void> {
  console.error(
    "[proxy] EMBEDDED MODE: running core in-process, single-client only",
  );
  // M2 will implement: import core/index and serve in-process
  // For M1, just block on stdin (placeholder)
  process.stderr.write(
    "[proxy] embedded mode not yet implemented (M2 adds core binding)\n",
  );
  process.stderr.write("[proxy] daemon should be running — check %LOCALAPPDATA%\\forge-mcp\\daemon.json\n");
  process.exit(1);
}

// ── Entry ──────────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error("[proxy] fatal:", err);
  process.exit(1);
});
