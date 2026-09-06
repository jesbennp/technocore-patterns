// compose-with-trust-scoring.ts
// Computes a numeric trust score for a composed claim graph so that downstream
// verifiers can apply risk-based policy (e.g. "accept if score >= 0.7").
//
// Inputs:
//   - claims: a resolved claim graph (from resolver.ts / compose.ts)
//   - issuerWeights: DID -> weight in [0,1], where 1 is fully trusted
//   - depthPenalty: per-hop multiplicative penalty in (0,1] applied to
//     delegations; default 0.9 means each hop keeps 90% of the upstream
//     weight
//   - freshnessHalfLifeMs: how long until an issuer's weight is halved
//     because of staleness (0 = ignore staleness)
//
// Output:
//   { score: number in [0,1], breakdown: { ... } }
//
// Design notes:
//   * Scoring is monotonic and bounded so it composes: if every component
//     gets worse, the total gets worse.
//   * Cycle-safe (delegation depth is already guarded upstream, but we
//     clamp depth to a sane maximum defensively).
//   * Revoked claims contribute 0 regardless of issuer weight.
//   * Independent claims are combined multiplicatively; the result is
//     then raised to 1/n so an adversary has to defeat every leg, not
//     just one. (Geometric mean is the right "AND" combinator for
//     trust.)

import type { ResolvedClaim } from "./resolver";

export interface TrustScoreInput {
  claims: ResolvedClaim[];
  issuerWeights: Record<string, number>;
  depthPenalty?: number;          // default 0.9
  freshnessHalfLifeMs?: number;    // default 0 (no staleness)
  now?: number;                    // default Date.now()
  maxDepth?: number;               // default 8
}

export interface TrustScoreBreakdown {
  perClaim: Array<{
    id: string;
    issuer: string;
    rawWeight: number;
    effectiveWeight: number;
    depth: number;
    revoked: boolean;
    ageMs: number | null;
  }>;
  combined: number;
}

export interface TrustScoreResult {
  score: number;
  breakdown: TrustScoreBreakdown;
}

const DEFAULT_DEPTH_PENALTY = 0.9;
const DEFAULT_MAX_DEPTH = 8;

export function computeTrustScore(input: TrustScoreInput): TrustScoreResult {
  const depthPenalty = clamp01(input.depthPenalty ?? DEFAULT_DEPTH_PENALTY);
  const maxDepth = Math.max(1, input.maxDepth ?? DEFAULT_MAX_DEPTH);
  const now = input.now ?? Date.now();
  const halfLife = Math.max(0, input.freshnessHalfLifeMs ?? 0);

  const perClaim: TrustScoreBreakdown["perClaim"] = [];
  const values: number[] = [];

  for (const c of input.claims) {
    const revoked = c.revoked === true;
    const depth = clampDepth(c.delegationDepth ?? 0, maxDepth);
    const raw = clamp01(input.issuerWeights[c.issuer] ?? 0);

    const hopFactor = Math.pow(depthPenalty, depth);
    const freshFactor = freshnessFactor(c.issuedAt, now, halfLife);

    const effective = revoked ? 0 : raw * hopFactor * freshFactor;

    perClaim.push({
      id: c.id,
      issuer: c.issuer,
      rawWeight: raw,
      effectiveWeight: effective,
      depth,
      revoked,
      ageMs: typeof c.issuedAt === "number" ? Math.max(0, now - c.issuedAt) : null,
    });

    values.push(effective);
  }

  const combined = geometricMean(values);
  return {
    score: clamp01(combined),
    breakdown: { perClaim, combined: clamp01(combined) },
  };
}

// ---------- helpers ----------

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function clampDepth(d: number, max: number): number {
  if (!Number.isFinite(d) || d < 0) return 0;
  if (d > max) return max;
  return Math.floor(d);
}

function freshnessFactor(
  issuedAt: number | string | undefined,
  now: number,
  halfLifeMs: number,
): number {
  if (!halfLifeMs || issuedAt === undefined) return 1;
  const ts = typeof issuedAt === "string" ? Date.parse(issuedAt) : issuedAt;
  if (!Number.isFinite(ts)) return 1;
  const age = Math.max(0, now - ts);
  // Exponential decay: f = 2^(-age / halfLife)
  return Math.pow(2, -age / halfLifeMs);
}

function geometricMean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) {
    // any 0 short-circuits the AND to 0 (revoked or unknown issuer)
    if (x <= 0) return 0;
    sum += Math.log(x);
  }
  return Math.exp(sum / xs.length);
}

// ---------- usage example ----------
//
// const result = computeTrustScore({
//   claims: [
//     { id: "a", issuer: "did:key:z6Mk...", issuedAt: Date.now() - 1000,
//       delegationDepth: 1, revoked: false, ...},
//     { id: "b", issuer: "did:key:z6Mn...", issuedAt: Date.now(),
//       delegationDepth: 0, revoked: false, ...},
//   ],
//   issuerWeights: {
//     "did:key:z6Mk...": 0.95,
//     "did:key:z6Mn...": 0.80,
//   },
//   depthPenalty: 0.9,
//   freshnessHalfLifeMs: 1000 * 60 * 60 * 24 * 30, // 30 days
// });
//
// if (result.score >= 0.7) { /* accept */ }

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
