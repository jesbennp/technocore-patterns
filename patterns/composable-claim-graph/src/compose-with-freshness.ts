// patterns/composable-claim-graph/src/compose-with-freshness.ts
//
// Compose a claim graph while enforcing a "freshness" policy: every resolved
// claim in the transitive closure must have been issued within `maxAgeMs`
// of `now`, unless the claim itself carries a `freshnessOverride: true`
// flag (e.g. long-lived identity roots that are explicitly trusted to be
// cached indefinitely).
//
// Use case: many real-world delegations (VCs, x509 chains, capability
// tokens) become weaker the older they get. A verifier may want to reject
// a chain where, say, a 3-hop delegation includes a hop that is 2 years
// old even if nothing has been revoked. This module makes that policy
// composable and explicit.
//
// Depends on:
//   ./compose-with-cycle-guard.ts  (GraphC#ComposeResult, safeCompose)
//   ./resolver.ts                  (resolveClaim)
//
// Public API:
//   type FreshnessVerdict = { ok: boolean; reason?: string; staleClaims?: ClaimId[] }
//   function evaluateFreshness(root: ClaimId, opts?: { now?: number; maxAgeMs?: number }): FreshnessVerdict
//   function safeComposeFresh(root: ClaimId, opts?: { now?: number; maxAgeMs?: number }): ComposeResult & { freshness: FreshnessVerdict }
//
// Worked example (see ../examples/freshness-policy-rejection.json):
//   A root claim issued today delegates to an intermediate claim issued
//   400 days ago, which delegates to a leaf issued today. With
//   maxAgeMs = 90 days, the intermediate is flagged stale; the leaf is
//   rejected because the closure is not fresh.

import { safeCompose, ComposeResult, ClaimId } from './compose-with-cycle-guard';
import { resolveClaim, ClaimNode } from './resolver';

export interface FreshnessOptions {
  /** Reference time in ms since epoch. Defaults to Date.now(). */
  now?: number;
  /** Maximum permitted age in ms. Claims older than this are stale. Defaults to 24h. */
  maxAgeMs?: number;
}

export interface FreshnessVerdict {
  ok: boolean;
  reason?: string;
  staleClaims?: ClaimId[];
  checkedAt: number;
  threshold: number;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Walk the resolved graph breadth-first, reading the `issuedAt` field on
 * each claim. A claim without `issuedAt` is treated as non-overridable
 * and immediately stale (forces callers to be explicit about timing).
 */
export function evaluateFreshness(
  root: ClaimId,
  opts: FreshnessOptions = {}
): FreshnessVerdict {
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const threshold = now - maxAge;

  const visited = new Set<ClaimId>();
  const queue: ClaimId[] = [root];
  const stale: ClaimId[] = [];

  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const node = resolveClaim(id);
    if (!node) {
      // Unresolved nodes are the cycle-guard's problem, not ours.
      continue;
    }

    if (node.freshnessOverride === true) {
      // Explicitly trusted as cacheable. Skip age check.
    } else if (typeof node.issuedAt !== 'number') {
      stale.push(id);
    } else if (node.issuedAt < threshold) {
      stale.push(id);
    }

    for (const child of node.delegates ?? []) {
      if (!visited.has(child)) queue.push(child);
    }
  }

  if (stale.length === 0) {
    return { ok: true, checkedAt: now, threshold };
  }
  return {
    ok: false,
    reason: `freshness policy violated: ${stale.length} claim(s) older than ${maxAge}ms`,
    staleClaims: stale,
    checkedAt: now,
    threshold,
  };
}

/**
 * Composition + freshness in one call. Returns the cycle-guarded
 * ComposeResult augmented with a FreshnessVerdict. A freshness failure
 * does not erase the composition result; callers can decide whether to
 * short-circuit on staleness or surface both diagnostics.
 */
export function safeComposeFresh(
  root: ClaimId,
  opts: FreshnessOptions = {}
): ComposeResult & { freshness: FreshnessVerdict } {
  const composed = safeCompose(root);
  const freshness = evaluateFreshness(root, opts);
  return { ...composed, freshness };
}

// Minimal local extension typing — kept here so this file is
// self-contained and doesn't require resolver.ts to be re-edited.
declare module './resolver' {
  interface ClaimNode {
    issuedAt?: number;
    freshnessOverride?: boolean;
    delegates?: ClaimId[];
  }
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
