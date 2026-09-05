// patterns/composable-claim-graph/src/cycle-detector.ts
//
// Cycle detection for a directed claim graph where edges represent
// "depends-on" relationships between attestations. We need both
// (1) detection of any directed cycle, and
// (2) identification of one concrete cycle path so callers can render
// a useful error or apply a policy.
//
// The algorithm is a deterministic three-color DFS:
//   WHITE (0) = unvisited
//   GRAY  (1) = on the current DFS stack
//   BLACK (2) = fully explored
//
// A back-edge to a GRAY node proves a cycle. To produce a reproducible
// path we keep an explicit stack of node ids rather than relying on
// the recursion frame, and we sort each node's successors before
// traversing them so output is stable across runtimes (Map iteration
// order is otherwise a footgun in JS).
//
// Complexity: O(V + E) time, O(V) extra space.

export type NodeId = string;

export interface Adjacency {
  // successors(id) returns nodes that id depends on.
  // Returned order does not matter; we sort internally.
  successors(id: NodeId): Iterable<NodeId>;
}

export interface CycleResult {
  hasCycle: boolean;
  // Concrete cycle path in traversal order, e.g. [a, b, c, a].
  // Empty when hasCycle is false.
  cycle: NodeId[];
}

export class MapAdjacency implements Adjacency {
  private readonly edges: Map<NodeId, Set<NodeId>>;
  constructor(edges: Map<NodeId, Set<NodeId>>) {
    this.edges = edges;
  }
  *successors(id: NodeId): Iterable<NodeId> {
    const next = this.edges.get(id);
    if (!next) return;
    for (const n of next) yield n;
  }
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

export function detectCycle(
  roots: Iterable<NodeId>,
  adjacency: Adjacency,
  // Optional cap to bound worst-case work when the graph is hostile.
  maxNodes = 100_000,
): CycleResult {
  const color = new Map<NodeId, number>();
  const stack: NodeId[] = [];
  let visited = 0;

  const sortedSuccessors = (id: NodeId): NodeId[] => {
    const out: NodeId[] = [];
    for (const s of adjacency.successors(id)) out.push(s);
    out.sort();
    return out;
  };

  // Iterative DFS so deep graphs do not blow the JS call stack.
  const start: Array<{ node: NodeId; iter: NodeId[]; childIdx: number }> = [];

  for (const root of roots) {
    if (visited >= maxNodes) break;
    if (color.get(root) === BLACK) continue;

    color.set(root, GRAY);
    stack.push(root);
    start.push({ node: root, iter: sortedSuccessors(root), childIdx: 0 });

    while (start.length > 0) {
      if (visited++ >= maxNodes) {
        return { hasCycle: true, cycle: stack.slice() };
      }
      const frame = start[start.length - 1];
      if (frame.childIdx >= frame.iter.length) {
        // Done with this node.
        color.set(frame.node, BLACK);
        start.pop();
        stack.pop();
        continue;
      }
      const child = frame.iter[frame.childIdx++];
      const c = color.get(child) ?? WHITE;
      if (c === GRAY) {
        // Back-edge: child is an ancestor on the current stack.
        const startIdx = stack.indexOf(child);
        const cycle = stack.slice(startIdx);
        cycle.push(child);
        return { hasCycle: true, cycle };
      }
      if (c === WHITE) {
        color.set(child, GRAY);
        stack.push(child);
        start.push({ node: child, iter: sortedSuccessors(child), childIdx: 0 });
      }
      // BLACK: already fully explored, no new cycle through it.
    }
  }

  return { hasCycle: false, cycle: [] };
}

// ---------- minimal self-test (run with: tsx cycle-detector.ts) ----------

function selfTest(): void {
  const cases: Array<{ name: string; edges: [string, string][]; expectCycle: boolean }> = [
    { name: "empty", edges: [], expectCycle: false },
    { name: "linear", edges: [["a", "b"], ["b", "c"]], expectCycle: false },
    { name: "diamond", edges: [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]], expectCycle: false },
    { name: "self-loop", edges: [["a", "a"]], expectCycle: true },
    { name: "triangle", edges: [["a", "b"], ["b", "c"], ["c", "a"]], expectCycle: true },
    { name: "deep cycle", edges: [["a", "b"], ["b", "c"], ["c", "d"], ["d", "b"]], expectCycle: true },
  ];

  let pass = 0;
  for (const tc of cases) {
    const m = new Map<NodeId, Set<NodeId>>();
    for (const [from, to] of tc.edges) {
      let s = m.get(from);
      if (!s) { s = new Set(); m.set(from, s); }
      s.add(to);
    }
    const adj = new MapAdjacency(m);
    const nodes = new Set<NodeId>();
    for (const [from, to] of tc.edges) { nodes.add(from); nodes.add(to); }
    const r = detectCycle(nodes, adj);
    const ok = r.hasCycle === tc.expectCycle;
    if (ok) pass++;
    // eslint-disable-next-line no-console
    console.log(`${ok ? "ok" : "FAIL"}  ${tc.name}  hasCycle=${r.hasCycle}  path=${r.cycle.join("->")}`);
  }
  if (pass !== cases.length) throw new Error("cycle-detector self-test failed");
}

if (typeof require !== "undefined" && (require as { main?: unknown }).main === module) {
  selfTest();
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
