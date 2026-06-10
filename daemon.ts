#!/usr/bin/env bun
/**
 * forge-mcp daemon — M1 skeleton.
 *
 * Runs as a detached background process. Single entry point that owns:
 *   - 127.0.0.1 HTTP server (random free port)
 *   - Bearer token (crypto.randomUUID)
 *   - McpServer-per-session via WebStandardStreamableHTTPServerTransport
 *   - Atomic daemon.json write (tmp + rename, EPERM/EBUSY backoff)
 *   - Idle shutdown (zero sessions → graceful exit)
 *   - Boot-time log rotation
 *
 * M1 has NO tools registered. M2 adds core/port and registerTool calls.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync, renameSync, readFileSync, existsSync, statSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ensureStateDirs, daemonJsonPath, daemonLogPath } from "./core/statePaths.js";
import { SessionManager } from "./core/sessions.js";

// ── Version ────────────────────────────────────────────────────────────────
let forgeVersion = "0.0.0-dev";
try {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf-8"));
  forgeVersion = pkg.version ?? forgeVersion;
} catch {
  // version stays "0.0.0-dev"
}

// ── File logger ─────────────────────────────────────────────────────────────
let logStream: ReturnType<typeof createWriteStream> | null = null;

function initLogger(): void {
  try {
    logStream = createWriteStream(daemonLogPath, { flags: "a" });
  } catch {
    // degraded: no file logging, console still works
  }
}

function log(level: string, ...args: unknown[]): void {
  const ts = new Date().toISOString();
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `${ts} [${level}] ${msg}\n`;
  process.stdout.write(line); // keep console behavior
  logStream?.write(line);    // also append to file
}

// Replace console.log/error for daemon use
console.log = (...args: unknown[]) => log("INFO", ...args);
console.error = (...args: unknown[]) => log("ERROR", ...args);

// ── Load forge.json config ──────────────────────────────────────────────────
interface ForgeConfig {
  daemon?: { port?: number; idleShutdownMin?: number; drainMs?: number };
  security?: { bindHost?: string; originAllowlist?: string[] };
}
let config: ForgeConfig = {};
try {
  const cfgPath = join(import.meta.dir, "forge.json");
  if (existsSync(cfgPath)) {
    config = JSON.parse(readFileSync(cfgPath, "utf-8"));
  }
} catch {
  // config errors fall back to defaults (never kill the daemon)
}

// ── State ──────────────────────────────────────────────────────────────────
ensureStateDirs();

const PORT = config.daemon?.port ?? 0; // 0 = random free port
const IDLE_SHUTDOWN_MIN = config.daemon?.idleShutdownMin ?? 30;
const BIND_HOST = config.security?.bindHost ?? "127.0.0.1";
const ORIGIN_ALLOWLIST = config.security?.originAllowlist ?? [
  "http://127.0.0.1",
  "http://localhost",
];
const DRAIN_MS = config.daemon?.drainMs ?? 5_000;

const sessions = new SessionManager({
  oncloseGraceMs: 10_000,
  idleSweepMinMs: 30 * 60_000,
});

// Bearer token: generated once per daemon lifetime
const BEARER_TOKEN = randomUUID();
let assignedPort = 0;

// Idle timer handle (reset on session create/reap)
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// ── HTTP server ────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // DNS rebinding protection: validate Origin header
  const origin = req.headers["origin"];
  if (origin && !ORIGIN_ALLOWLIST.includes(origin)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden: invalid Origin" }));
    return;
  }

  // Route dispatch
  if (req.url === "/mcp") {
    await handleMcp(req, res);
  } else if (req.url === "/health" && req.method === "GET") {
    handleHealth(res);
  } else if (req.url === "/stats" && req.method === "GET") {
    handleStats(req, res);
  } else if (req.url === "/admin/restart" && req.method === "POST") {
    await handleAdminRestart(req, res);
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ── Routes ─────────────────────────────────────────────────────────────────

function handleHealth(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      forgeVersion,
      pid: process.pid,
    }),
  );
}

function handleStats(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      sessions: sessions.size,
      uptime_s: Math.floor((Date.now() - bootTime) / 1000),
      session_ids: sessions.ids,
    }),
  );
}

function requireAuth(req: IncomingMessage): boolean {
  const auth = req.headers["authorization"];
  return auth === `Bearer ${BEARER_TOKEN}`;
}

async function handleAdminRestart(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!requireAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  // F4 graceful shutdown path
  await gracefulShutdown();
}

/**
 * Handle MCP protocol traffic on /mcp.
 *
 * POST  — initialize new session OR forward to existing session
 * GET   — SSE stream for an existing session (Mcp-Session-Id header required)
 * DELETE — terminate an existing session
 */
async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sid = req.headers["mcp-session-id"] as string | undefined;

  // ── DELETE → immediate session termination ──────────────────────────────
  if (req.method === "DELETE") {
    if (!sid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32_000, message: "Mcp-Session-Id header required" },
          id: null,
        }),
      );
      return;
    }
    sessions.reapImmediate(sid);
    res.writeHead(200);
    res.end();
    return;
  }

  // ── GET → SSE stream (existing session required) ───────────────────────
  if (req.method === "GET") {
    if (!sid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32_000,
            message: "Mcp-Session-Id header required for GET",
          },
          id: null,
        }),
      );
      return;
    }
    const entry = sessions.get(sid);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32_001, message: "Session not found" },
          id: null,
        }),
      );
      return;
    }
    // Cancel any pending grace timer
    sessions.cancelGrace(sid);
    sessions.touch(sid);

    const webReq = nodeToWebRequest(req);
    const webRes = await entry.transport.handleRequest(webReq);
    await writeWebResponse(res, webRes);
    return;
  }

  // ── POST → new session or forward to existing ──────────────────────────
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "GET, POST, DELETE" });
    res.end();
    return;
  }

  // Existing session → forward
  if (sid) {
    const entry = sessions.get(sid);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32_001, message: "Session not found" },
          id: null,
        }),
      );
      return;
    }
    // Cancel grace + touch
    sessions.cancelGrace(sid);
    sessions.touch(sid);

    const webReq = nodeToWebRequest(req);
    const webRes = await entry.transport.handleRequest(webReq);
    await writeWebResponse(res, webRes);
    return;
  }

  // ── New session ──────────────────────────────────────────────────────
  try {
    const mcpServer = new McpServer({
      name: "forge",
      version: forgeVersion,
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedOrigins: ORIGIN_ALLOWLIST,
      onsessioninitialized: (sessionId: string) => {
        sessions.register(sessionId, mcpServer, transport);
        resetIdleTimer();
      },
    });

    // M1: no tools registered (M2 adds core/port + registerTool calls)
    // The server starts with an empty tool set.
    await mcpServer.connect(transport);

    const webReq = nodeToWebRequest(req);
    const webRes = await transport.handleRequest(webReq);
    await writeWebResponse(res, webRes);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32_603,
          message: `Internal error: ${String(err)}`,
        },
        id: null,
      }),
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert Node.js IncomingMessage → Web Standard Request. */
function nodeToWebRequest(req: IncomingMessage): Request {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  // Read the full body so the transport can parse it
  return new Request(url.href, {
    method: req.method,
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(
        ([, v]) => v !== undefined,
      ) as [string, string][],
    ),
    body: req.method === "GET" || req.method === "DELETE"
      ? undefined
      : new ReadableStream({
          start(controller) {
            req.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
            req.on("end", () => controller.close());
            req.on("error", (err) => controller.error(err));
          },
        }),
  });
}

/** Write a Web Standard Response to a Node.js ServerResponse. */
async function writeWebResponse(
  res: ServerResponse,
  webRes: Response,
): Promise<void> {
  const headers: Record<string, string> = {};
  webRes.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(webRes.status, headers);

  if (webRes.body) {
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // stream cancelled or error — swallow
    }
  }
  res.end();
}

// ── Boot-time log rotation ─────────────────────────────────────────────────
function rotateLogs(): void {
  try {
    if (existsSync(daemonLogPath)) {
      const logMaxMb = (config.daemon as Record<string, unknown>)?.logMaxMb;
      const MAX_BYTES = (typeof logMaxMb === "number" ? logMaxMb : 5) * 1024 * 1024;
      const { size } = statSync(daemonLogPath);
      if (size > MAX_BYTES) {
        renameSync(daemonLogPath, `${daemonLogPath}.${Date.now()}`);
      }
    }
  } catch {
    // log rotation is best-effort
  }
}

// ── Atomic daemon.json write (tmp + rename, EPERM/EBUSY backoff) ───────────
function writeDaemonJson(): void {
  const data = JSON.stringify(
    {
      pid: process.pid,
      port: assignedPort,
      token: BEARER_TOKEN,
      forgeVersion,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  );

  const tmpPath = `${daemonJsonPath}.tmp.${process.pid}`;
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      writeFileSync(tmpPath, data, "utf-8");
      renameSync(tmpPath, daemonJsonPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        // Windows: Defender holds transient locks
        const delay = 100 * Math.pow(2, attempt);
        const start = Date.now();
        while (Date.now() - start < delay) {
          // busy-wait spin (sub-200ms, avoids setTimeout overhead)
        }
        continue;
      }
      // Non-retryable error — best-effort, don't crash daemon
      console.error("[daemon] writeDaemonJson failed:", err);
      return;
    }
  }
  console.error("[daemon] writeDaemonJson: all retries exhausted");
}

// ── Idle shutdown timer ────────────────────────────────────────────────────
function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (sessions.size === 0) {
    idleTimer = setTimeout(() => {
      console.log("[daemon] idle shutdown triggered");
      gracefulShutdown().catch(() => {});
    }, IDLE_SHUTDOWN_MIN * 60 * 1000);
  }
}

// ── Graceful shutdown (single function, all exit paths — F4) ───────────────
let shuttingDown = false;
async function gracefulShutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("[daemon] shutdown initiated");

  // 1. Stop accepting new connections
  server.close(() => {
    console.log("[daemon] server stopped accepting connections");
  });

  // 2. Drain inflight sessions (with drainMs timeout)
  console.log(`[daemon] draining sessions (drainMs=${DRAIN_MS})`);
  const drainTimeout = new Promise<void>((resolve) => setTimeout(resolve, DRAIN_MS));
  await Promise.race([sessions.shutdown(), drainTimeout]);

  // 3. LSP shutdown hook (M3 adds this)
  // await lspShutdown();

  // 4. Watcher unsubscribeAll hook (M5 adds this)
  // await watcherUnsubscribeAll();

  // 5. PID sweep hook (M3 adds this)
  // await pidSweep();

  // 6. Remove daemon.json
  try {
    unlinkSync(daemonJsonPath);
  } catch {
    // may not exist
  }

  // 7. Flush/close log stream
  console.log("[daemon] shutting down");
  logStream?.end();
  logStream = null;

  // 8. Exit
  process.exit(0);
}

// ── Boot ───────────────────────────────────────────────────────────────────
rotateLogs();
initLogger();

const bootTime = Date.now();

server.listen(PORT, BIND_HOST, () => {
  const addr = server.address();
  if (addr && typeof addr === "object") {
    assignedPort = addr.port;
  }

  console.log(`[daemon] forge-mcp ${forgeVersion} listening on ${BIND_HOST}:${assignedPort}`);
  console.log(`[daemon] pid=${process.pid} token=${BEARER_TOKEN}`);

  // Write daemon.json LAST (atomic tmp+rename)
  writeDaemonJson();

  // Reset idle timer on boot
  resetIdleTimer();
});

// ── Signal handlers ────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  gracefulShutdown().catch(() => {});
});
process.on("SIGTERM", () => {
  gracefulShutdown().catch(() => {});
});
// Windows: SIGBREAK is sent by Ctrl+C in some terminals
if (process.platform === "win32") {
  process.on("SIGBREAK" as NodeJS.Signals, () => {
    gracefulShutdown().catch(() => {});
  });
}
