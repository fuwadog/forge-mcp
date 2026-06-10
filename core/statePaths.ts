/**
 * forge-mcp — state directory resolution and path exports.
 *
 * All mutable daemon state lives under %LOCALAPPDATA%\forge-mcp\ (Windows)
 * or $XDG_DATA_HOME/forge-mcp/ (Linux/macOS fallback).
 * The repo root must NEVER contain daemon.json or boot.lock.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

/** Root state directory: %LOCALAPPDATA%\forge-mcp */
export const stateDir = join(LOCALAPPDATA, "forge-mcp");

/** Daemon descriptor written LAST (atomic tmp+rename). */
export const daemonJsonPath = join(stateDir, "daemon.json");

/** Lock file for boot arbitration (O_EXCL). */
export const bootLockPath = join(stateDir, "boot.lock");

/** Log directory. */
export const logsDir = join(stateDir, "logs");

/** Main daemon log path. */
export const daemonLogPath = join(logsDir, "daemon.log");

/**
 * Ensure the state directory tree exists (mkdir -p).
 * Called once at daemon boot. Never throws — logs and swallows errors.
 */
export function ensureStateDirs(): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
  } catch (err) {
    // Non-fatal: daemon may still run with degraded logging.
    console.error("[statePaths] ensureStateDirs failed:", err);
  }
}
