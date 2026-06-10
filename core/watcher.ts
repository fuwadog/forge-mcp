/**
 * forge-mcp — event-driven filesystem watcher for M5 invalidation.
 *
 * Uses @parcel/watcher to subscribe per-root and batch events with debounce.
 * Events accelerate cache eviction only; fingerprint mtime-keys remain the
 * sole correctness layer (authority invariant DA-S2).
 *
 * FORGE_WATCH=0 or config.enabled=false → dormant stat-based invalidation.
 */
import watcher from "@parcel/watcher";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvalidationMode = "events" | "stat";

export interface WatcherConfig {
  enabled: boolean;
  debounceMs: number;
  coarseThreshold: number;
  ignore: string[];
}

export interface WatcherCallbacks {
  /** Called per changed path during fine-grained eviction. */
  onEvict(path: string): void;
  /** Called once when coarse mode fires (batch exceeds threshold). */
  onCoarseFlush(root: string): void;
  /** Called after every batch (fine or coarse) to invalidate lsp-proj entries. */
  onGenerationBump(root: string): void;
}

export interface RootWatcher {
  root: string;
  mode: InvalidationMode;
  unsubscribe(): Promise<void>;
}

export interface ForgeWatcher {
  subscribe(root: string, callbacks: WatcherCallbacks): RootWatcher;
  unsubscribeAll(): Promise<void>;
  getMode(root: string): InvalidationMode;
  stats(): Record<string, InvalidationMode>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/.venv/**",
  "**/target/**",
];

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_COARSE_THRESHOLD = 500;

// ---------------------------------------------------------------------------
// Internal state per root
// ---------------------------------------------------------------------------

interface RootState {
  subscription: watcher.AsyncSubscription | null;
  mode: InvalidationMode;
  callbacks: WatcherCallbacks;
  /** Buffered event paths awaiting debounce flush. */
  buffer: string[];
  /** Active debounce timer id. Null when idle. */
  timer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function createWatcher(config: WatcherConfig): ForgeWatcher {
  const enabled = config.enabled && !isWatchDisabled();
  const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const coarseThreshold = config.coarseThreshold ?? DEFAULT_COARSE_THRESHOLD;
  const ignore = config.ignore?.length ? config.ignore : DEFAULT_IGNORE;

  const roots = new Map<string, RootState>();

  function isWatchDisabled(): boolean {
    return process.env.FORGE_WATCH === "0";
  }

  // -- flush buffered events for a root ----------------------------------

  function flushBuffer(state: RootState): void {
    const batch = state.buffer.splice(0);
    if (batch.length === 0) return;

    if (batch.length > coarseThreshold) {
      // COARSE MODE (DA-W2): flush everything, single generation bump.
      state.callbacks.onCoarseFlush(state.root);
      console.error(
        `[watcher] COARSE flush root=${state.root} paths=${batch.length}`,
      );
    } else {
      // Fine-grained: evict each changed path.
      for (const p of batch) {
        state.callbacks.onEvict(p);
      }
    }

    // Always bump generation after any batch.
    state.callbacks.onGenerationBump(state.root);
  }

  // -- debounce helper ---------------------------------------------------

  function scheduleFlush(state: RootState): void {
    if (state.timer !== null) return; // already scheduled
    state.timer = setTimeout(() => {
      state.timer = null;
      flushBuffer(state);
    }, debounceMs);
  }

  // -- subscribe ---------------------------------------------------------

  function subscribe(
    root: string,
    callbacks: WatcherCallbacks,
  ): RootWatcher {
    // DORMANT PATH: watcher disabled or FORGE_WATCH=0.
    if (!enabled) {
      const dormant: RootWatcher = {
        root,
        mode: "stat",
        unsubscribe: async () => {},
      };
      roots.set(root, {
        subscription: null,
        mode: "stat",
        callbacks,
        buffer: [],
        timer: null,
      });
      return dormant;
    }

    // Re-use existing subscription for this root.
    const existing = roots.get(root);
    if (existing) {
      return {
        root,
        mode: existing.mode,
        unsubscribe: async () => {
          await removeRoot(root);
        },
      };
    }

    const state: RootState = {
      subscription: null,
      mode: "events",
      callbacks,
      buffer: [],
      timer: null,
    };

    // Subscribe asynchronously; degrade to stat on failure.
    watcher
      .subscribe(root, (err, events) => {
        if (err) {
          console.error(
            `[watcher] subscription error root=${root}:`,
            err.message ?? err,
          );
          degradeToStat(state);
          return;
        }
        for (const ev of events) {
          // @parcel/watcher events have `path` and `type`.
          const p = (ev as { path?: string }).path;
          if (p) state.buffer.push(p);
        }
        scheduleFlush(state);
      }, { ignore })
      .then((sub) => {
        state.subscription = sub;
      })
      .catch((err: unknown) => {
        console.error(
          `[watcher] subscribe failed root=${root}:`,
          err instanceof Error ? err.message : err,
        );
        degradeToStat(state);
      });

    roots.set(root, state);

    return {
      root,
      mode: state.mode,
      unsubscribe: async () => {
        await removeRoot(root);
      },
    };
  }

  // -- degrade to stat mode ----------------------------------------------

  function degradeToStat(state: RootState): void {
    if (state.mode === "stat") return;
    state.mode = "stat";
    console.error(
      `[watcher] degraded to stat mode root=${state.root}`,
    );
  }

  // -- remove / unsubscribe ----------------------------------------------

  async function removeRoot(root: string): Promise<void> {
    const state = roots.get(root);
    if (!state) return;

    // Cancel pending debounce.
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    // Flush any remaining buffered events before teardown.
    flushBuffer(state);

    // Unsubscribe native watcher.
    if (state.subscription) {
      try {
        await state.subscription.unsubscribe();
      } catch {
        // Swallow — subscription may already be dead.
      }
    }

    roots.delete(root);
  }

  // -- unsubscribeAll ----------------------------------------------------

  async function unsubscribeAll(): Promise<void> {
    const entries = Array.from(roots.keys());
    await Promise.all(entries.map(removeRoot));
  }

  // -- queries -----------------------------------------------------------

  function getMode(root: string): InvalidationMode {
    return roots.get(root)?.mode ?? "stat";
  }

  function stats(): Record<string, InvalidationMode> {
    const out: Record<string, InvalidationMode> = {};
    for (const [root, state] of roots) {
      out[root] = state.mode;
    }
    return out;
  }

  return { subscribe, unsubscribeAll, getMode, stats };
}

export { createWatcher };
