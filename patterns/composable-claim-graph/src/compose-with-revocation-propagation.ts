/**
 * compose-with-revocation-propagation.ts
 *
 * Resolves a composable claim graph and propagates revocations through
 * delegation chains and intersection conjunctions. A claim is treated as
 * RESOLVED only if (a) the claim itself is not revoked, (b) every claim it
 * transitively depends on is not revoked, and (c) for intersection types,
 * none of the conjuncts are revoked.
 *
 * Design notes
 * ------------
 * - Revocation is modelled as a separate set of `{id, revokedAt, reason}`
 *   records, keyed by claim id. This keeps the claim payload itself
 *   append-only / content-addressed, which is friendly to CIDs and
 *   verifiable logs.
 * - Propagation is BFS over the dependency edges produced by the
 *   `compose` step. We track a visited set so cycles (already guarded by
 *   compose-with-cycle-guard) cannot cause infinite traversal.
 * - The result distinguishes between a successful resolution and a
 *   `RevokedReason`-tagged failure so callers can present an audit trail
 *   to users ("this was suspended because <upstream claim X> was revoked
 *   on 2025-04-01T00:00:00Z").
 *
 * Usage
 * -----
 *   import { resolveWithRevocationPropagation } from "./compose-with-revocation-propagation";
 *   const result = resolveWithRevocationPropagation(rootId, graph, revocations);
 *   if (result.status === "resolved") { ... } else { ... }
 *
 * Where:
 *   graph        - the composed set of claims as produced by compose.ts
 *   revocations  - a Map<ClaimId, RevocationRecord>
 */

import { resolve } from "./resolver"; // expects { id, type, deps: ClaimId[], ... }

export type ClaimId = string;

export type RevocationRecord = {
  id: ClaimId;
  revokedAt: string; // ISO-8601
  reason: string;
};

export type RevocationIndex = Map<ClaimId, RevocationRecord>;

export type ResolutionResult =
  | { status: "resolved"; id: ClaimId; visited: ClaimId[] }
  | {
      status: "revoked";
      id: ClaimId;
      reason: string;
      revokedAt: string;
      via: ClaimId[]; // chain of dependencies from root to the revoked node
    }
  | { status: "missing"; id: ClaimId };

export function buildRevocationIndex(
  records: RevocationRecord[]
): RevocationIndex {
  const idx: RevocationIndex = new Map();
  for (const r of records) idx.set(r.id, r);
  return idx;
}

/**
 * Walk the graph from `rootId`, yielding claim ids in BFS order. The
 * resolver is the single source of truth for what counts as a
 * dependency edge; we do not duplicate that logic here.
 */
function* traverse(rootId: ClaimId, graph: unknown): Generator<ClaimId> {
  const seen = new Set<ClaimId>();
  const queue: ClaimId[] = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    yield id;
    const node = resolve(id, graph);
    if (!node) continue;
    const deps = Array.isArray((node as any).deps) ? (node as any).deps : [];
    for (const d of deps) {
      if (!seen.has(d)) queue.push(d);
    }
  }
}

/**
 * Resolve `rootId` against `graph`, propagating revocations. The first
 * revoked claim encountered on the dependency frontier causes the whole
 * root claim to be reported as revoked; we surface the path through the
 * graph so the cause is auditable.
 */
export function resolveWithRevocationPropagation(
  rootId: ClaimId,
  graph: unknown,
  revocations: RevocationIndex
): ResolutionResult {
  const root = resolve(rootId, graph);
  if (!root) return { status: "missing", id: rootId };

  // Direct hit: root itself revoked.
  const direct = revocations.get(rootId);
  if (direct) {
    return {
      status: "revoked",
      id: rootId,
      reason: direct.reason,
      revokedAt: direct.revokedAt,
      via: [rootId],
    };
  }

  // BFS: record parent chain so we can report via-path on a revoked dep.
  const parent = new Map<ClaimId, ClaimId | null>();
  parent.set(rootId, null);
  const visited: ClaimId[] = [rootId];
  const queue: ClaimId[] = [rootId];

  while (queue.length) {
    const id = queue.shift()!;
    const node = resolve(id, graph);
    if (!node) continue;

    const deps: ClaimId[] = Array.isArray((node as any).deps)
      ? (node as any).deps
      : [];

    for (const dep of deps) {
      const depNode = resolve(dep, graph);
      if (!depNode) {
        return { status: "missing", id: dep };
      }
      if (!parent.has(dep)) {
        parent.set(dep, id);
        visited.push(dep);
        queue.push(dep);
      }
      const rev = revocations.get(dep);
      if (rev) {
        // Reconstruct the chain root -> ... -> dep.
        const chain: ClaimId[] = [];
        let cur: ClaimId | null = dep;
        while (cur) {
          chain.unshift(cur);
          cur = parent.get(cur) ?? null;
        }
        return {
          status: "revoked",
          id: rootId,
          reason: rev.reason,
          revokedAt: rev.revokedAt,
          via: chain,
        };
      }
    }
  }

  return { status: "resolved", id: rootId, visited };
}

/**
 * Convenience: revoke a claim at `at` (ISO-8601). Returns a new
 * RevocationRecord the caller can push into their log.
 */
export function revoke(
  id: ClaimId,
  reason: string,
  at: string = new Date().toISOString()
): RevocationRecord {
  return { id, reason, revokedAt: at };
}

// Exported for tests and for compose-with-revocation-propagation examples.
export const _internal = { traverse };

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
