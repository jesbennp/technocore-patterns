import type { Claim, ResolutionContext, Resolver } from "./types";
import { defaultResolve } from "./resolver";

/**
 * Compose two claims but fail if either side is considered stale.
 *
 * "Freshness" gives a claim a useful life; "staleness" is the policy
 * that says: this claim, once past its freshness window, no longer
 * composes safely with peers. This is different from revocation
 * (the issuer actively said "no more") and different from expiration
 * (the claim hard-stops at a wall-clock time). Staleness is a soft
 * decay: the claim is still resolvable, still signed, still unrevoked,
 * but downstream compositions should refuse to use it because the
 * underlying assertion is too old to be acted on.
 *
 * Use cases:
 * - "temperature sensor reading must be < 30s old to compose with
 *    a control policy"
 * - "KYC attestation must be refreshed within 24h to be combined
 *    with a transaction authorization"
 * - "membership proof must be re-asserted within 1h to participate
 *    in a quorum decision"
 *
 * The check is pluggable: callers supply a `staleness` predicate
 * over (claim, ctx) so the same composer can serve different
 * freshness policies without forking the composition logic.
 *
 * Example:
 *   const r = composeWithFreshnessStaleness({
 *     stalenessMs: 30_000,
 *     now: ctx.now,
 *   });
 *   const out = await r.resolve(
 *     { kind: "allOf", claims: [temp, policy] },
 *     ctx,
 *   );
 *   // -> fails fast if `temp` is older than 30s, even if `policy`
 *   //    is fresh and both claims are individually valid.
 */

export interface StalenessConfig {
  /** Maximum age, in milliseconds, a claim may have and still compose. */
  stalenessMs: number;
  /**
   * Wall-clock now in ms. Injectable so tests can pin time and
   * so the same module works in deterministic replay contexts.
   */
  now: () => number;
  /**
   * Optional override: decide staleness per claim. Receives the
   * leaf claim and ctx, returns true if the claim is too stale
   * to compose. If omitted, the default rule is:
   *   (now - claim.issuedAt) > stalenessMs
   *
   * The predicate is consulted only for claims that carry an
   * `issuedAt` field; claims without a timestamp are assumed
   * to be timeless (e.g. public-key bindings) and are never
   * considered stale.
   */
  isStale?: (claim: Claim, ctx: ResolutionContext) => boolean;
}

export class StaleClaimError extends Error {
  readonly claim: Claim;
  readonly ageMs: number;
  readonly limitMs: number;
  constructor(claim: Claim, ageMs: number, limitMs: number) {
    super(
      `claim ${claim.id ?? claim.kind ?? "<unnamed>"} is stale ` +
      `(age=${ageMs}ms, limit=${limitMs}ms)`,
    );
    this.name = "StaleClaimError";
    this.claim = claim;
    this.ageMs = ageMs;
    this.limitMs = limitMs;
  }
}

function defaultIsStale(claim: Claim, now: number, limit: number): boolean {
  const issuedAt = (claim as { issuedAt?: number }).issuedAt;
  if (typeof issuedAt !== "number") return false; // timeless -> never stale
  return now - issuedAt > limit;
}

/**
 * Walk a claim tree, fail on the first stale leaf, otherwise
 * delegate to the underlying resolver. Order: fail-fast means a
 * composition with N stale leaves reports the *shallowest* stale
 * leaf first, which is usually the one the caller controls.
 */
export function composeWithFreshnessStaleness(
  cfg: StalenessConfig,
  inner: Resolver = defaultResolve,
): Resolver {
  const isStale = cfg.isStale
    ? (c: Claim, ctx: ResolutionContext) => cfg.isStale!(c, ctx)
    : (c: Claim, _ctx: ResolutionContext) =>
        defaultIsStale(c, cfg.now(), cfg.stalenessMs);

  return {
    async resolve(claim: Claim, ctx: ResolutionContext): Promise<unknown> {
      // Pre-order traversal: check this node before descending.
      // We treat `allOf` / `anyOf` / `oneOf` containers as transparent
      // for staleness purposes — only leaves (or claims with an
      // issuedAt) are checked. This matches how revocation checks
      // work elsewhere in the claim-graph package.
      if (!isContainer(claim)) {
        if (isStale(claim, ctx)) {
          const issuedAt = (claim as { issuedAt?: number }).issuedAt ?? 0;
          throw new StaleClaimError(
            claim,
            cfg.now() - issuedAt,
            cfg.stalenessMs,
          );
        }
      } else {
        // For containers, recursively check children.
        const children = collectChildren(claim);
        for (const child of children) {
          if (!isContainer(child) && isStale(child, ctx)) {
            const issuedAt = (child as { issuedAt?: number }).issuedAt ?? 0;
            throw new StaleClaimError(
              child,
              cfg.now() - issuedAt,
              cfg.stalenessMs,
            );
          }
        }
      }

      return inner.resolve(claim, ctx);
    },
  };
}

// --- shape helpers (kept local; the package's types module owns the canonical ones) ---

function isContainer(claim: Claim): boolean {
  const k = (claim as { kind?: string }).kind;
  return k === "allOf" || k === "anyOf" || k === "oneOf";
}

function collectChildren(claim: Claim): Claim[] {
  const k = (claim as { kind?: string }).kind;
  const claims = (claim as { claims?: Claim[] }).claims;
  if (!Array.isArray(claims)) return [];
  if (k === "allOf" || k === "anyOf" || k === "oneOf") return claims;
  return [];
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
