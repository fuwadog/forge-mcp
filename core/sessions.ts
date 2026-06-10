/**
 * forge-mcp — session triad management.
 *
 * Cleanup triad:
 *   transport.onclose → 10s grace (cancel on re-attach) → reap
 *   HTTP DELETE → immediate reap
 *   60s sweeper reaps sessions idle > idleSweepMin
 *
 * "reap" = close transport, close mcpServer, delete entry from map.
 * M3 will add: decrement openedFiles refs (LSP hook).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/** Per-session bookkeeping. */
export interface SessionEntry {
  mcpServer: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  /** Client-declared roots (M2 will populate). */
  rootsCache: string[];
  /** Recovery stats (M4 will populate). */
  recovery: { attempted?: number; restarts?: number; cooldown?: boolean };
  /** Last activity timestamp (epoch ms). */
  lastSeen: number;
  /** Grace timer handle after transport.onclose; null = active. */
  graceTimer: ReturnType<typeof setTimeout> | null;
}

export interface SessionManagerOptions {
  /** Ms before onclose grace expires and the session is reaped. Default: 10_000. */
  oncloseGraceMs?: number;
  /** Ms idle before the sweeper reaps. Default: 30 * 60_000. */
  idleSweepMinMs?: number;
  /** Interval between sweeper ticks. Default: 60_000. */
  sweepIntervalMs?: number;
}

const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_IDLE_SWEEP_MS = 30 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export class SessionManager {
  private readonly _sessions = new Map<string, SessionEntry>();
  private readonly _graceMs: number;
  private readonly _idleSweepMs: number;
  private _sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** Callback invoked when a session is reaped (for logging / cleanup). */
  onReap?: (sid: string) => void;

  constructor(opts?: SessionManagerOptions) {
    this._graceMs = opts?.oncloseGraceMs ?? DEFAULT_GRACE_MS;
    this._idleSweepMs = opts?.idleSweepMinMs ?? DEFAULT_IDLE_SWEEP_MS;
    const sweepInterval = opts?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this._sweepTimer = setInterval(() => this._sweep(), sweepInterval);
  }

  /** Total active sessions. */
  get size(): number {
    return this._sessions.size;
  }

  /** All active session IDs. */
  get ids(): string[] {
    return [...this._sessions.keys()];
  }

  /** Get a session entry by ID. */
  get(sid: string): SessionEntry | undefined {
    return this._sessions.get(sid);
  }

  /**
   * Register a new session.
   * Wires the transport.onclose handler to start the grace timer.
   */
  register(
    sid: string,
    mcpServer: McpServer,
    transport: WebStandardStreamableHTTPServerTransport,
  ): SessionEntry {
    const entry: SessionEntry = {
      mcpServer,
      transport,
      rootsCache: [],
      recovery: {},
      lastSeen: Date.now(),
      graceTimer: null,
    };

    // Wire onclose → grace timer
    transport.onclose = () => {
      this._startGrace(sid);
    };

    this._sessions.set(sid, entry);
    return entry;
  }

  /**
   * Re-attach: cancel a pending grace timer (client reconnected).
   * Returns true if a grace was cancelled.
   */
  cancelGrace(sid: string): boolean {
    const entry = this._sessions.get(sid);
    if (!entry || !entry.graceTimer) return false;
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
    return true;
  }

  /** Touch lastSeen to prevent idle sweep. */
  touch(sid: string): void {
    const entry = this._sessions.get(sid);
    if (entry) entry.lastSeen = Date.now();
  }

  /** Immediately reap a session (HTTP DELETE path). */
  reapImmediate(sid: string): void {
    this._reap(sid);
  }

  /** Start the grace timer after transport closes. */
  private _startGrace(sid: string): void {
    const entry = this._sessions.get(sid);
    if (!entry || entry.graceTimer) return; // already grace or already gone

    entry.graceTimer = setTimeout(() => {
      this._reap(sid);
    }, this._graceMs);
  }

  /** Core reap: close transport + mcpServer, remove from map. */
  private async _reap(sid: string): Promise<void> {
    const entry = this._sessions.get(sid);
    if (!entry) return;

    // Clear grace timer if still pending
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }

    // Close transport (ignore errors — it may already be closed)
    try {
      await entry.transport.close();
    } catch {
      // already closed or transport error — swallow
    }

    // Close mcpServer
    try {
      await entry.mcpServer.close();
    } catch {
      // swallow
    }

    this._sessions.delete(sid);
    this.onReap?.(sid);
  }

  /** Sweeper: reaps sessions idle longer than idleSweepMs. */
  private _sweep(): void {
    const now = Date.now();
    for (const [sid, entry] of this._sessions) {
      // Skip sessions with an active grace timer (handled by grace path)
      if (entry.graceTimer) continue;
      if (now - entry.lastSeen > this._idleSweepMs) {
        this._reap(sid);
      }
    }
  }

  /** Shutdown: reap all sessions, clear sweep timer. */
  async shutdown(): Promise<void> {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    const sids = [...this._sessions.keys()];
    for (const sid of sids) {
      await this._reap(sid);
    }
  }
}
