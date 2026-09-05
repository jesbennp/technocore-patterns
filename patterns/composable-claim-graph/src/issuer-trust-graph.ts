// patterns/composable-claim-graph/src/issuer-trust-graph.ts
//
// Walks a composable claim graph and computes a per-principal trust score
// by combining direct attestations with transitive ones, damped by path
// length and weighted by claim-strength. Useful for ranking issuers before
// composing a higher-order claim, or for surfacing "who vouches for whom".
//
// Pattern: a graph traversal that produces a normalized trust vector and
// an ordered ranking. Pure function, no I/O, no globals.
//
// Quick example (also see examples/issuer-trust-ranking.json):
//
//   import { rankIssuers } from "./issuer-trust-graph";
//   const ranking = rankIssuers(graph, { root: "did:key:z6Mk...",
//                                        damping: 0.7,
//                                        selfWeight: 0.5 });
//   // -> [ { did: "did:key:z6MkAlice...", score: 0.83, hops: 1 }, ... ]
//

export type ClaimStrength =
  | "self"            // a node declaring itself (least weight, used for selfWeight only)
  | "unverified"      // unsigned assertion (0.1)
  | "verified"        // cryptographic signature present (0.5)
  | "notarized"       // signed by a notary/registry issuer (0.8)
  | "root";           // pinned root of trust in the graph (1.0)

export interface ClaimNode {
  id: string;                  // DID or any opaque principal id
  strength?: ClaimStrength;    // defaults to "verified"
  selfWeight?: number;         // override for the root's own contribution (0..1)
}

export interface ClaimEdge {
  from: string;                // issuer (the attester)
  to: string;                  // subject (who is being attested)
  strength?: ClaimStrength;    // strength of *this* attestation
  weight?: number;             // optional explicit override (0..1)
}

export interface ClaimGraph {
  nodes: ClaimNode[];
  edges: ClaimEdge[];
}

export interface RankOptions {
  root: string;                // principal we trust directly (the anchor)
  damping?: number;            // multiplicative decay per hop, default 0.7
  maxHops?: number;            // BFS depth cap, default 6
  selfWeight?: number;         // base score granted to the root, default 0.5
}

export interface IssuerScore {
  did: string;
  score: number;               // 0..1, sum of damped path contributions
  hops: number;                // shortest path from root (Infinity if unreachable)
  paths: number;               // number of independent paths discovered
}

const STRENGTH_TABLE: Record<ClaimStrength, number> = {
  self: 0,
  unverified: 0.1,
  verified: 0.5,
  notarized: 0.8,
  root: 1.0,
};

function nodeById(graph: ClaimGraph, id: string): ClaimNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

/**
 * Multi-source shortest-path style accumulation. We track the *best*
 * score to each node (max over all discovered paths) and the number of
 * distinct paths so callers can later filter by quorum if they wish.
 */
export function rankIssuers(
  graph: ClaimGraph,
  opts: RankOptions,
): IssuerScore[] {
  const damping = opts.damping ?? 0.7;
  const maxHops = opts.maxHops ?? 6;
  const selfWeight = opts.selfWeight ?? 0.5;

  // Adjacency list: subject -> attestations *about* that subject.
  // We want to walk FROM issuers TO subjects; edges go from attester
  // (from) to subject (to), so to expand from the root we look at
  // outgoing edges of the current node.
  const outgoing = new Map<string, ClaimEdge[]>();
  for (const e of graph.edges) {
    const list = outgoing.get(e.from) ?? [];
    list.push(e);
    outgoing.set(e.from, list);
  }

  const scores = new Map<string, IssuerScore>();
  scores.set(opts.root, {
    did: opts.root,
    score: selfWeight,
    hops: 0,
    paths: 1,
  });

  // BFS frontier of (nodeId, incomingScore, hops)
  type Front = { id: string; incoming: number; hops: number };
  const queue: Front[] = [{ id: opts.root, incoming: selfWeight, hops: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.hops >= maxHops) continue;

    const edges = outgoing.get(current.id) ?? [];
    for (const edge of edges) {
      const edgeStrength =
        edge.weight ?? STRENGTH_TABLE[edge.strength ?? "verified"];
      // Contribution to the subject is the attester's score * edge strength
      // * damping^(hops+1) so that each hop costs a multiplicative factor.
      const contribution =
        current.incoming * edgeStrength * Math.pow(damping, current.hops + 1);

      const existing = scores.get(edge.to);
      if (!existing) {
        scores.set(edge.to, {
          did: edge.to,
          score: contribution,
          hops: current.hops + 1,
          paths: 1,
        });
        queue.push({
          id: edge.to,
          incoming: contribution,
          hops: current.hops + 1,
        });
      } else {
        // Keep the BEST score (shortest, strongest path) but count paths.
        const candidate = current.hops + 1 < existing.hops
          ? contribution
          : Math.max(existing.score, contribution);
        scores.set(edge.to, {
          did: edge.to,
          score: candidate,
          hops: Math.min(existing.hops, current.hops + 1),
          paths: existing.paths + 1,
        });
        if (current.hops + 1 < existing.hops) {
          queue.push({
            id: edge.to,
            incoming: contribution,
            hops: current.hops + 1,
          });
        }
      }
    }
  }

  // Normalize so the top score is <= 1 (keeps scores comparable across graphs).
  const topScore = Math.max(selfWeight, ...Array.from(scores.values()).map((s) => s.score));
  const normalized = Array.from(scores.values()).map((s) => ({
    ...s,
    score: topScore > 0 ? Math.min(1, s.score / topScore) : 0,
  }));

  // Stable, deterministic ordering: score desc, then hops asc, then did asc.
  normalized.sort((a, b) =>
    b.score - a.score ||
    a.hops - b.hops ||
    a.did.localeCompare(b.did)
  );

  return normalized;
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
