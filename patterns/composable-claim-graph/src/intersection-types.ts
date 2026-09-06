// patterns/composable-claim-graph/src/intersection-types.ts
//
// Intersection types for composable claim graphs.
//
// A claim graph resolves a principal to a set of facts (claims). Often a
// downstream consumer needs the principal to satisfy MULTIPLE independent
// types at once: e.g. "is-a-human AND is-over-18 AND is-eu-resident".
//
// This module:
//   1. Defines a normalized Intersection<T> type — a conjunction of named
//      claims each with its own resolver strategy.
//   2. Provides intersect(resolvers, ctx) which fans out to each branch and
//      returns the *narrowest* (most restrictive) composite result, plus
//      per-branch outcomes for debugging.
//   3. Provides explain(intersection, ctx) which returns a human-readable
//      proof trail suitable for audit logs.
//
// It composes with the existing compose.ts / delegation-depth-guard.ts
// modules: each branch of the intersection can itself be a composed
// claim-graph resolution.

import { resolveClaim, type ClaimNode, type ResolutionContext, type ResolutionResult } from './resolver.js';

/**
 * A single branch of an intersection. `name` is the human label used in
 * `explain()` output and errors. `claim` is the claim-graph node to resolve.
 */
export interface IntersectionBranch {
  name: string;
  claim: ClaimNode;
}

/**
 * An intersection is a conjunction of independent claim branches. All
 * branches must resolve to `true` for the intersection to hold.
 */
export interface Intersection {
  kind: 'intersection';
  branches: IntersectionBranch[];
}

/** Result of resolving a single branch. */
export interface BranchOutcome {
  name: string;
  ok: boolean;
  result: ResolutionResult;
  /** Optional reason string if the branch failed — helps explain() output. */
  reason?: string;
}

/**
 * Result of resolving an intersection. The intersection is satisfied iff
 * `ok === true`, which requires every branch to be ok.
 */
export interface IntersectionResult {
  ok: boolean;
  /** Per-branch outcomes, in declaration order. */
  outcomes: BranchOutcome[];
  /** Narrowest effective confidence across all branches, in [0, 1]. */
  confidence: number;
}

/**
 * Resolve an intersection: every branch must succeed. Branches are resolved
 * independently so a failure in one does not short-circuit the others — this
 * preserves the full proof trail for explain().
 *
 * Returns `{ ok: false }` with all per-branch outcomes if any branch fails.
 */
export async function intersect(
  inter: Intersection,
  ctx: ResolutionContext
): Promise<IntersectionResult> {
  if (inter.kind !== 'intersection') {
    throw new Error(`intersect: expected kind='intersection', got '${(inter as any).kind}'`);
  }
  if (!Array.isArray(inter.branches) || inter.branches.length === 0) {
    throw new Error('intersect: intersection must have at least one branch');
  }
  if (inter.branches.length > 16) {
    // Bound fan-out so a malformed config cannot trigger unbounded work.
    throw new Error('intersect: intersection supports at most 16 branches');
  }

  // Names must be unique — otherwise explain() becomes ambiguous.
  const seen = new Set<string>();
  for (const b of inter.branches) {
    if (seen.has(b.name)) {
      throw new Error(`intersect: duplicate branch name '${b.name}'`);
    }
    seen.add(b.name);
  }

  const outcomes: BranchOutcome[] = [];
  for (const branch of inter.branches) {
    const result = await resolveClaim(branch.claim, ctx);
    outcomes.push({
      name: branch.name,
      ok: result.ok,
      result,
      reason: result.ok ? undefined : result.reason,
    });
  }

  const allOk = outcomes.every((o) => o.ok);

  // Narrowest confidence = min across all branches (conjunction narrows).
  let confidence = allOk ? 1 : 0;
  if (allOk) {
    for (const o of outcomes) {
      const c = typeof o.result.confidence === 'number' ? o.result.confidence : 1;
      if (c < confidence) confidence = c;
    }
  }

  return { ok: allOk, outcomes, confidence };
}

/**
 * Produce a human-readable explanation of an intersection result. Safe to
 * log or return to API callers — it does not leak raw credentials, only
 * branch names and pass/fail reasons.
 *
 * Example:
 *   is-adult (ok, conf=0.97)
 *   is-eu-resident (ok, conf=0.91)
 *   is-human (FAIL: liveness-check failed at depth 2)
 *   => overall: FAIL
 */
export function explain(result: IntersectionResult): string[] {
  const lines: string[] = [];
  for (const o of result.outcomes) {
    const conf =
      typeof o.result.confidence === 'number'
        ? o.result.confidence.toFixed(2)
        : '1.00';
    if (o.ok) {
      lines.push(`${o.name} (ok, conf=${conf})`);
    } else {
      const reason = o.reason ?? o.result.reason ?? 'unspecified';
      lines.push(`${o.name} (FAIL: ${reason})`);
    }
  }
  lines.push(`=> overall: ${result.ok ? 'PASS' : 'FAIL'}`);
  return lines;
}

/**
 * Convenience builder so callers don't have to remember the discriminator.
 *
 *   const v = intersection(
 *     [ branch('is-human', humanClaim), branch('is-adult', ageClaim) ],
 *   );
 */
export function intersection(branches: IntersectionBranch[]): Intersection {
  return { kind: 'intersection', branches };
}

export function branch(name: string, claim: ClaimNode): IntersectionBranch {
  return { name, claim };
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
