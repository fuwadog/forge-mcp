/**
 * forge-mcp — Fingerprint-based result cache with cooldown map.
 *
 * LRU cache keyed by SHA-256 fingerprints, with per-class TTL,
 * byte-accounting size limits, path-based eviction, generation
 * counters for LSP invalidation, and a cooldown map for retry-after.
 *
 * M5 deliverable. FORGE_CACHE=0 disables all operations.
 *
 * Usage:
 *   const cache = createCache({ maxBytes: 64e6, maxEntryBytes: 2e6, enabled: true, cooldownMs: 2000 });
 *   const fp = computeFingerprint("nav_read", "read", { path: "foo.ts" }, { "foo.ts": 12345 });
 *   cache.set(fp, { payload: "...", payloadBytes: 1024 }, "file-pure", ["foo.ts"]);
 *   const entry = cache.get(fp);
 */
import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Cache class taxonomy — determines TTL and invalidation behavior.
 *
 * | Class       | Modes                                      | Key basis              | TTL  |
 * |-------------|--------------------------------------------|------------------------|------|
 * | file-pure   | read/peek/outline/symbols/search(file)     | +file mtime            | 5m   |
 * | dir-shaped  | tree/glob/search(dir)                      | dir+args               | 20s  |
 * | lsp-point   | def/hover                                  | +file mtime            | 60s  |
 * | lsp-proj    | refs/wsymbol/diagnostics                   | (root, generation)     | 30s  |
 * | subprocess  | ast_grep(search)/git_view                  | git HEAD+index mtime   | 30s  |
 * | dep_audit   | dep_audit                                  | lockfile hash          | 1h   |
 *
 * NEVER cached: edit/write/rename/action/test_run/ast_grep(apply)/any ok:false envelope.
 */
export type CacheClass =
  | "file-pure"
  | "dir-shaped"
  | "lsp-point"
  | "lsp-proj"
  | "subprocess"
  | "dep_audit";

export interface CacheConfig {
  /** Total byte budget for all cached entries. @default 64MB */
  maxBytes: number;
  /** Maximum bytes for a single cache entry. @default 2MB */
  maxEntryBytes: number;
  /** Enable/disable the cache. @default true */
  enabled: boolean;
  /** Cooldown window in ms for failed fingerprints. @default 2000 */
  cooldownMs: number;
}

/** LOCKED value type — every cached entry is this shape. */
export interface CacheEntry {
  /** Serialised NavEnvelope payload. */
  payload: string;
  /** Byte length of `payload` — used by sizeCalculation. */
  payloadBytes: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Number of entries currently in the LRU. */
  size: number;
  /** hits / (hits + misses). */
  hitRate: number;
}

export interface ForgeCache {
  /** Lookup by fingerprint. Returns undefined on miss or cooldown-block. */
  get(key: string): CacheEntry | undefined;
  /**
   * Store an entry with the given class TTL.
   * @param paths  File/dir paths touched by this result — used by evictByPath.
   */
  set(key: string, value: CacheEntry, cacheClass: CacheClass, paths?: string[]): void;
  /** Explicit delete. */
  delete(key: string): void;
  /** Evict all entries whose path index includes `path`. */
  evictByPath(path: string): void;
  /** Increment the generation counter for `root`, invalidating lsp-proj entries. */
  bumpGeneration(root: string): void;
  /** True if `fingerprint` failed within the cooldown window. */
  checkCooldown(fingerprint: string): boolean;
  /** Record a failing fingerprint with the current timestamp. */
  recordFailure(fingerprint: string): void;
  /** Current cache statistics. */
  stats(): CacheStats;
  /** Flush everything (LRU + path index + generations + cooldowns). */
  clear(): void;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Per-class TTL in milliseconds. */
export const TTL_MAP: Record<CacheClass, number> = {
  "file-pure": 5 * 60 * 1000, // 5m
  "dir-shaped": 20 * 1000, // 20s
  "lsp-point": 60 * 1000, // 60s
  "lsp-proj": 30 * 1000, // 30s
  "subprocess": 30 * 1000, // 30s
  "dep_audit": 60 * 60 * 1000, // 1h
};

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024; // 64 MB
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024; // 2 MB
const DEFAULT_COOLDOWN_MS = 2_000; // 2 s
const COOLDOWN_FIFO_CAP = 1_000; // L9

// ── Fingerprint ────────────────────────────────────────────────────────────

/**
 * Deterministic cache fingerprint.
 *
 * SHA-256( tool \0 mode \0 canonicalJSON(args) \0 sorted(path:mtimeMs)... )
 *
 * - `args` keys are sorted for canonical ordering.
 * - `mtimes` entries are sorted by path and joined as `path:mtimeMs` pairs.
 * - Two requests that touch the same files with the same mtimes produce the
 *   same fingerprint; any difference (file edit, arg change) yields a new one.
 */
export function computeFingerprint(
  tool: string,
  mode: string,
  args: Record<string, unknown>,
  mtimes?: Record<string, number>,
): string {
  // Canonical JSON: sorted keys, no extra whitespace
  const argsJson = JSON.stringify(args, Object.keys(args ?? {}).sort());

  // Mtime digest: sorted path -> mtimeMs pairs
  let mtimeDigest = "";
  if (mtimes && Object.keys(mtimes).length > 0) {
    const sorted = Object.keys(mtimes).sort();
    mtimeDigest = sorted.map((p) => `${p}:${mtimes[p]!}`).join("|");
  }

  const input = `${tool}\0${mode}\0${argsJson}\0${mtimeDigest}`;
  return createHash("sha256").update(input).digest("hex");
}

// ── Cooldown bookkeeping ───────────────────────────────────────────────────

interface CooldownRecord {
  timestamp: number;
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a ForgeCache instance.
 *
 * Every public method is wrapped in try/catch — cache errors are silently
 * bypassed (treated as misses) so the daemon never crashes on cache bugs.
 *
 * `FORGE_CACHE=0` in the environment disables all operations (no-ops).
 */
export function createCache(config: CacheConfig): ForgeCache {
  const enabled = config.enabled && process.env.FORGE_CACHE !== "0";
  const cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  // ── LRU instance ─────────────────────────────────────────────────────
  const lru = new LRUCache<string, CacheEntry>({
    maxSize: config.maxBytes ?? DEFAULT_MAX_BYTES,
    maxEntrySize: config.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
    sizeCalculation: (entry) => entry.payloadBytes,
    ttlAutopurge: true,
    allowStale: false,
    updateAgeOnGet: false,
    dispose: (_value, _key, _reason) => {
      // Byte accounting is automatic via maxSize + sizeCalculation.
      // dispose is kept for potential future metrics hooks.
    },
  });

  // ── Path index: path -> Set<fingerprint> for evictByPath ─────────────
  const pathIndex = new Map<string, Set<string>>();

  // ── Generation counters per root for lsp-proj invalidation ──────────
  const generations = new Map<string, number>();

  // ── Cooldown map (plain Map, NOT in lru-cache) ──────────────────────
  const cooldowns = new Map<string, CooldownRecord>();

  // ── Stats ───────────────────────────────────────────────────────────
  let hitCount = 0;
  let missCount = 0;

  // ── Internal helpers ────────────────────────────────────────────────

  /** Record that `key` touches the given `paths` for eviction. */
  function indexPaths(key: string, paths?: string[]): void {
    if (!paths) return;
    for (const p of paths) {
      let set = pathIndex.get(p);
      if (!set) {
        set = new Set();
        pathIndex.set(p, set);
      }
      set.add(key);
    }
  }

  /** Purge oldest cooldown entries to stay under FIFO cap. */
  function purgeCooldowns(): void {
    if (cooldowns.size <= COOLDOWN_FIFO_CAP) return;
    const entries = [...cooldowns.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.length - COOLDOWN_FIFO_CAP;
    for (let i = 0; i < toRemove; i++) {
      cooldowns.delete(entries[i]![0]!);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  return {
    get(key: string): CacheEntry | undefined {
      if (!enabled) return undefined;

      try {
        // Check cooldown first — identical failing fingerprint in window -> miss
        const cd = cooldowns.get(key);
        if (cd) {
          if (Date.now() - cd.timestamp < cooldownMs) {
            return undefined; // still in cooldown window
          }
          cooldowns.delete(key); // cooldown expired
        }

        const entry = lru.get(key);
        if (entry) {
          hitCount++;
          return entry;
        }
        missCount++;
        return undefined;
      } catch {
        // Cache error — bypass (treat as miss)
        return undefined;
      }
    },

    set(key: string, value: CacheEntry, cacheClass: CacheClass, paths?: string[]): void {
      if (!enabled) return;

      try {
        // Oversized entry guard — lru-cache also rejects via maxEntrySize,
        // but we check early to avoid index work for oversized payloads.
        const maxEntry = config.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
        if (value.payloadBytes > maxEntry) return;

        const ttl = TTL_MAP[cacheClass];
        lru.set(key, value, { ttl });
        indexPaths(key, paths);

        // Successful set clears any prior failure cooldown
        cooldowns.delete(key);
      } catch {
        // Cache error — bypass silently
      }
    },

    delete(key: string): void {
      if (!enabled) return;

      try {
        lru.delete(key);
        cooldowns.delete(key);
      } catch {
        // Bypass
      }
    },

    evictByPath(path: string): void {
      if (!enabled) return;

      try {
        // Exact path match
        const keys = pathIndex.get(path);
        if (keys) {
          for (const k of keys) {
            lru.delete(k);
          }
          pathIndex.delete(path);
        }

        // Prefix match: evict entries whose indexed path is under `path/`
        const prefix = path.endsWith("/") ? path : `${path}/`;
        for (const [p, keys] of pathIndex) {
          if (p.startsWith(prefix)) {
            for (const k of keys) {
              lru.delete(k);
            }
            pathIndex.delete(p);
          }
        }
      } catch {
        // Bypass
      }
    },

    bumpGeneration(root: string): void {
      if (!enabled) return;

      try {
        const current = generations.get(root) ?? 0;
        generations.set(root, current + 1);
        // lsp-proj entries embed (root, generation) in their fingerprint key.
        // After bump, new requests produce a different fingerprint -> cache miss.
        // Old entries expire naturally via their 30s TTL.
      } catch {
        // Bypass
      }
    },

    checkCooldown(fingerprint: string): boolean {
      if (!enabled) return false;

      try {
        const cd = cooldowns.get(fingerprint);
        if (!cd) return false;
        return Date.now() - cd.timestamp < cooldownMs;
      } catch {
        return false;
      }
    },

    recordFailure(fingerprint: string): void {
      if (!enabled) return;

      try {
        cooldowns.set(fingerprint, { timestamp: Date.now() });
        purgeCooldowns();
      } catch {
        // Bypass
      }
    },

    stats(): CacheStats {
      const total = hitCount + missCount;
      return {
        hits: hitCount,
        misses: missCount,
        size: lru.size,
        hitRate: total > 0 ? hitCount / total : 0,
      };
    },

    clear(): void {
      lru.clear();
      pathIndex.clear();
      generations.clear();
      cooldowns.clear();
      hitCount = 0;
      missCount = 0;
    },
  };
}
