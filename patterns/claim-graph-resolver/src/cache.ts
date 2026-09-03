// patterns/claim-graph-resolver/src/cache.ts
//
// A small, dependency-free caching layer for the claim-graph resolver.
// Rationale: when you dereference a DID or fetch a verifiable claim over the
// network, the response is content-addressed and (ideally) immutable. That
// makes it perfect for a bounded LRU cache keyed by the request URL.
//
// The resolver in ./resolver.ts is intentionally synchronous-looking — it
// returns whatever the resolver instance has. This cache wraps any async
// resolver and adds: (1) TTL, (2) LRU eviction, (3) single-flight so a
// thundering herd of concurrent lookups for the same URL only hits the
// network once.
//
// Worked usage:
//
//   import { CachingResolver } from "./cache";
//   import { HttpResolver } from "./resolver";
//
//   const resolver = new CachingResolver(new HttpResolver(), {
//     maxEntries: 500,
//     ttlMs: 60_000,
//   });
//
//   // Two concurrent calls for the same URL share one network fetch.
//   const [a, b] = await Promise.all([
//     resolver.resolve("did:example:abc"),
//     resolver.resolve("did:example:abc"),
//   ]);
//   assert.strictEqual(a, b);
//
// The cache is transparent: callers still get a Result type identical to the
// underlying resolver's. Invalidation is by TTL only; if you need to bust an
// entry (e.g. a 401), call resolver.invalidate(url).

export type ResolveResult = {
  ok: boolean;
  url: string;
  value?: unknown;
  error?: string;
  fetchedAt: number;
  fromCache: boolean;
};

export interface Resolver {
  resolve(url: string): Promise<ResolveResult>;
  invalidate(url: string): void;
}

export interface CacheOptions {
  /** Max entries before LRU eviction. Default 256. */
  maxEntries?: number;
  /** Time-to-live per entry in ms. Default 30_000. */
  ttlMs?: number;
  /** Optional clock for tests. */
  now?: () => number;
}

interface Entry {
  value: ResolveResult;
  expiresAt: number;
}

type PendingMap = Map<string, Promise<ResolveResult>>;

export class CachingResolver implements Resolver {
  private readonly inner: Resolver;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly inflight: PendingMap = new Map();

  constructor(inner: Resolver, opts: CacheOptions = {}) {
    this.inner = inner;
    this.maxEntries = Math.max(1, opts.maxEntries ?? 256);
    this.ttlMs = Math.max(0, opts.ttlMs ?? 30_000);
    this.now = opts.now ?? Date.now;
  }

  async resolve(url: string): Promise<ResolveResult> {
    const hit = this.entries.get(url);
    if (hit && hit.expiresAt > this.now()) {
      // LRU touch: re-insert to move to most-recently-used end.
      this.entries.delete(url);
      this.entries.set(url, hit);
      return { ...hit.value, fromCache: true };
    }
    if (hit) {
      // Expired — drop and refetch.
      this.entries.delete(url);
    }

    const pending = this.inflight.get(url);
    if (pending) return pending;

    const p = (async () => {
      try {
        const fresh = await this.inner.resolve(url);
        const stamped: ResolveResult = { ...fresh, fromCache: false };
        this.set(url, stamped);
        return stamped;
      } finally {
        this.inflight.delete(url);
      }
    })();
    this.inflight.set(url, p);
    return p;
  }

  invalidate(url: string): void {
    this.entries.delete(url);
    this.inner.invalidate?.(url);
  }

  /** Drop everything. Useful between tests. */
  clear(): void {
    this.entries.clear();
  }

  /** Stats for observability / tests. */
  stats(): { size: number; inflight: number; maxEntries: number; ttlMs: number } {
    return {
      size: this.entries.size,
      inflight: this.inflight.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
    };
  }

  private set(url: string, value: ResolveResult): void {
    if (this.entries.has(url)) this.entries.delete(url);
    this.entries.set(url, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      // Map iteration order is insertion order, so the first key is the LRU.
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

// -- Self-test (run with: npx tsx patterns/claim-graph-resolver/src/cache.ts) --
if (typeof require !== 'undefined' && require.main === module) {
  (async () => {
    const calls: string[] = [];
    const fake: Resolver = {
      async resolve(url: string): Promise<ResolveResult> {
        calls.push(url);
        // Simulate latency so single-flight is observable.
        await new Promise((r) => setTimeout(r, 10));
        return { ok: true, url, value: { id: url }, fetchedAt: Date.now(), fromCache: false };
      },
      invalidate() {},
    };
    const c = new CachingResolver(fake, { maxEntries: 2, ttlMs: 1_000 });

    const [a, b, d] = await Promise.all([
      c.resolve("u1"),
      c.resolve("u1"),
      c.resolve("u2"),
    ]);
    if (calls.length !== 2) throw new Error(`expected 2 upstream calls, got ${calls.length}`);
    if (a.value !== b.value) throw new Error("concurrent lookups should share one result");
    if (!b.fromCache || !d.fromCache) throw new Error("subsequent reads should be cached");

    c.invalidate("u1");
    await c.resolve("u1");
    if (calls.length !== 3) throw new Error(`expected 3 upstream calls after invalidate, got ${calls.length}`);

    // LRU eviction: fill to maxEntries+1
    await c.resolve("u3");
    await c.resolve("u4"); // evicts u2
    if (c.stats().size !== 2) throw new Error(`expected size 2, got ${c.stats().size}`);

    console.log("cache self-test OK", c.stats());
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
