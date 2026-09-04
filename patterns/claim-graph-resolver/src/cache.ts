"use strict";
// In-memory resolver cache with LRU eviction and negative caching.
// Pattern: deterministic keys, content-hashable values, optional TTL, optional negative caching.
// This is a building block for any recursive claim-graph resolver — caching resolved claims
// avoids re-walking the same sub-graph thousands of times in policy evaluation.
//
// Why it matters: a single top-level policy eval may resolve the same `did:example:foo` claim
// dozens of times (different paths, cycle-breaking retries, etc.). A small cache collapses that
// to one upstream fetch per key within the TTL window.

const DEFAULT_MAX = 1000;
const DEFAULT_TTL_MS = 60_000;
const NEG_TTL_MS = 10_000;

export type CacheEntry<V> = {
  value: V;
  expiresAt: number; // epoch ms; 0 = no expiry
  insertedAt: number;
  hits: number;
};

export type CacheOptions = {
  max?: number;
  ttlMs?: number;
  negativeTtlMs?: number;
  now?: () => number; // injectable clock for tests
};

export class ResolverCache<V> {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  // Map preserves insertion order; combined with re-insert on hit we get LRU semantics.
  private readonly store = new Map<string, CacheEntry<V>>();

  // Stats — useful for logs and for deciding whether to tune TTL/max in production.
  public stats = {
    hits: 0,
    misses: 0,
    negatives: 0,
    evictions: 0,
    expirations: 0,
  };

  constructor(opts: CacheOptions = {}) {
    this.max = Math.max(1, opts.max ?? DEFAULT_MAX);
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.negativeTtlMs = opts.negativeTtlMs ?? NEG_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Build a stable cache key from the parts a resolver actually cares about. */
  static key(...parts: Array<string, number>): string {
    return parts
      .map((p) => (typeof p === "number" ? String(p) : p))
      .join("|");
  }

  get(key: string): V | undefined {
    const e = this.store.get(key);
    if (!e) {
      this.stats.misses++;
      return undefined;
    }
    if (e.expiresAt !== 0 && e.expiresAt <= this.now()) {
      this.store.delete(key);
      this.stats.expirations++;
      this.stats.misses++;
      return undefined;
    }
    // LRU touch
    this.store.delete(key);
    e.hits++;
    this.store.set(key, e);
    this.stats.hits++;
    return e.value;
  }

  set(key: string, value: V, opts: { ttlMs?: number; negative?: boolean } = {}): void {
    if (this.store.has(key)) this.store.delete(key);
    const ttl = opts.ttlMs ?? (opts.negative ? this.negativeTtlMs : this.ttlMs);
    this.store.set(key, {
      value,
      expiresAt: ttl > 0 ? this.now() + ttl : 0,
      insertedAt: this.now(),
      hits: 0,
    });
    if (opts.negative) this.stats.negatives++;
    this.evictIfNeeded();
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  private evictIfNeeded(): void {
    while (this.store.size > this.max) {
      // First key in iteration order is the least-recently-used (oldest untouched).
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
      this.stats.evictions++;
    }
  }
}

// --- Worked example: how to wire the cache into a recursive claim resolver ---
// (Not exported via the public API; shown so the file is self-documenting.)
/*
import type { ClaimResolver } from "./types";

export function withCache<V>(
  inner: ClaimResolver<V>,
  opts: CacheOptions = {}
): ClaimResolver<V> {
  const c = new ResolverCache<V>(opts);
  return async (id, depth) => {
    const k = ResolverCache.key(id, depth);
    const hit = c.get(k);
    if (hit !== undefined) return hit;
    try {
      const v = await inner(id, depth);
      c.set(k, v);
      return v;
    } catch (err) {
      // Negative cache: cache the throw so we don't hammer an unreachable node.
      c.set(k, undefined as unknown as V, { negative: true });
      throw err;
    }
  };
}
*/

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
