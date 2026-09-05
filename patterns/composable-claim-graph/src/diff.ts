// src/diff.ts
// Structural diff between two resolved claim graphs.
// Useful for: change-detection in trust registries, audit trails,
// proof-of-non-mutation between two snapshots, regression testing
// of policy outputs.
//
// Pure TypeScript, zero deps, works in Node 18+ and the browser.

import type { ClaimNode, ClaimGraph } from "./types";

/** A single edge between two claim nodes. */
export interface ClaimEdge {
  from: string;
  to: string;
  rel: string;
}

export interface FlatGraph {
  nodes: Record<string, ClaimNode>;
  edges: ClaimEdge[];
}

export interface GraphDiff {
  addedNodes: ClaimNode[];
  removedNodes: ClaimNode[];
  modifiedNodes: { id: string; before: ClaimNode; after: ClaimNode; changedKeys: string[] }[];
  addedEdges: ClaimEdge[];
  removedEdges: ClaimEdge[];
  summary: { added: number; removed: number; modified: number };
}

/** Flatten a graph into a node map + edge list (deterministic order). */
export function flatten(g: ClaimGraph): FlatGraph {
  const nodes: Record<string, ClaimNode> = {};
  const edges: ClaimEdge[] = [];
  for (const n of g.nodes ?? []) nodes[n.id] = n;
  for (const e of g.edges ?? []) edges.push({ from: e.from, to: e.to, rel: e.relation });
  edges.sort((a, b) =>
    a.from === b.from ? (a.to === b.to ? a.rel.localeCompare(b.rel) : a.to.localeCompare(b.to)) : a.from.localeCompare(b.from),
  );
  return { nodes, edges };
}

function diffClaim(a: ClaimNode, b: ClaimNode): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete("id");
  const changed: string[] = [];
  for (const k of keys) {
    const av = JSON.stringify((a as any)[k]);
    const bv = JSON.stringify((b as any)[k]);
    if (av !== bv) changed.push(k);
  }
  return changed.sort();
}

function edgeKey(e: ClaimEdge): string {
  return `${e.from}\u241F${e.rel}\u241F${e.to}`;
}

/** Compute a structural diff from `before` to `after`. */
export function diffGraph(before: ClaimGraph, after: ClaimGraph): GraphDiff {
  const a = flatten(before);
  const b = flatten(after);

  const addedNodes: ClaimNode[] = [];
  const removedNodes: ClaimNode[] = [];
  const modifiedNodes: GraphDiff["modifiedNodes"] = [];

  for (const id of Object.keys(b.nodes)) {
    if (!(id in a.nodes)) {
      addedNodes.push(b.nodes[id]);
    } else {
      const changedKeys = diffClaim(a.nodes[id], b.nodes[id]);
      if (changedKeys.length) {
        modifiedNodes.push({ id, before: a.nodes[id], after: b.nodes[id], changedKeys });
      }
    }
  }
  for (const id of Object.keys(a.nodes)) {
    if (!(id in b.nodes)) removedNodes.push(a.nodes[id]);
  }

  const aEdgeSet = new Map(a.edges.map((e) => [edgeKey(e), e] as const));
  const bEdgeSet = new Map(b.edges.map((e) => [edgeKey(e), e] as const));
  const addedEdges: ClaimEdge[] = [];
  const removedEdges: ClaimEdge[] = [];
  for (const [k, e] of bEdgeSet) if (!aEdgeSet.has(k)) addedEdges.push(e);
  for (const [k, e] of aEdgeSet) if (!bEdgeSet.has(k)) removedEdges.push(e);

  return {
    addedNodes,
    removedNodes,
    modifiedNodes,
    addedEdges,
    removedEdges,
    summary: {
      added: addedNodes.length + addedEdges.length,
      removed: removedNodes.length + removedEdges.length,
      modified: modifiedNodes.length,
    },
  };
}

/** Render a compact, human-readable diff (one line per change). */
export function formatDiff(d: GraphDiff): string {
  const lines: string[] = [];
  for (const n of d.addedNodes) lines.push(`+ node  ${n.id}`);
  for (const n of d.removedNodes) lines.push(`- node  ${n.id}`);
  for (const m of d.modifiedNodes) lines.push(`~ node  ${m.id}  (${m.changedKeys.join(",")})`);
  for (const e of d.addedEdges) lines.push(`+ edge  ${e.from} -[${e.rel}]-> ${e.to}`);
  for (const e of d.removedEdges) lines.push(`- edge  ${e.from} -[${e.rel}]-> ${e.to}`);
  lines.push(
    `# ${d.summary.added} added, ${d.summary.removed} removed, ${d.summary.modified} modified`,
  );
  return lines.join("\n");
}

// --- Demo / smoke test ------------------------------------------------------
if (require.main === module) {
  const before: ClaimGraph = {
    nodes: [
      { id: "issuer:root", kind: "issuer", trust: 1.0 },
      { id: "holder:alice", kind: "holder" },
      { id: "cred:1", kind: "credential", issuer: "issuer:root", subject: "holder:alice", validUntil: 1000 },
    ],
    edges: [
      { from: "cred:1", to: "issuer:root", relation: "issuedBy" },
      { from: "cred:1", to: "holder:alice", relation: "bindsTo" },
    ],
  };
  const after: ClaimGraph = {
    nodes: [
      { id: "issuer:root", kind: "issuer", trust: 0.9 }, // trust dropped
      { id: "holder:alice", kind: "holder" },
      { id: "cred:1", kind: "credential", issuer: "issuer:root", subject: "holder:alice", validUntil: 1000, revoked: true }, // revoked
      { id: "cred:2", kind: "credential", issuer: "issuer:root", subject: "holder:alice", validUntil: 2000 }, // new
    ],
    edges: [
      { from: "cred:1", to: "issuer:root", relation: "issuedBy" },
      { from: "cred:1", to: "holder:alice", relation: "bindsTo" },
      { from: "cred:2", to: "issuer:root", relation: "issuedBy" }, // new
      { from: "cred:2", to: "holder:alice", relation: "bindsTo" }, // new
    ],
  };
  const d = diffGraph(before, after);
  // eslint-disable-next-line no-console
  console.log(formatDiff(d));
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
