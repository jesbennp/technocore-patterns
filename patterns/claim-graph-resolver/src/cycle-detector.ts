// pattern: claim-graph-resolver / cycle-detector.ts
// Detects circular references in a claim graph before resolution to prevent
// infinite recursion and to surface trust-loop misconfigurations early.
//
// A "claim graph" is a directed graph of claims, where each edge A -> B means
// "claim A depends on (or references) claim B". Cycles can be:
//   * back-edges within a single trust root's subtree (bad: A -> B -> A)
//   * cross-root loops (often worse: root1.x -> root2.y -> root1.x)
//
// This module exports:
//   - ClaimNode: minimal shape any backing store (SQL, KV, in-memory) must satisfy
//   - GraphLoader: async loader interface so we can fetch from any storage layer
//   - detectCycles(loader, roots): async DFS with Tarjan-style coloring, returns
//       all cycles as ordered lists of node ids, plus a stats summary.
//
// Worked example at the bottom: an in-memory loader with a deliberate loop.
// Run with: `node --import tsx patterns/claim-graph-resolver/src/cycle-detector.ts`
// (or compile to JS). Expected output is printed in the comment block above main().

export interface ClaimNode {
  id: string;
  refs: readonly string[]; // ids of claims this node depends on
}

export interface GraphLoader {
  get(id: string): Promise<ClaimNode | null>;
}

export interface CycleReport {
  cycles: string[][];        // each cycle as [a, b, c, ..., a]
  visitedCount: number;
  hasCycle: boolean;
}

type Color = 0 | 1 | 2; // 0=white, 1=gray, 2=black

export async function detectCycles(
  loader: GraphLoader,
  roots: readonly string[],
  opts: { maxDepth?: number; maxNodes?: number } = {},
): Promise<CycleReport> {
  const maxDepth = opts.maxDepth ?? 1000;
  const maxNodes = opts.maxNodes ?? 100_000;
  const color = new Map<string, Color>();
  const stack: string[] = [];          // current DFS path
  const cycles: string[][] = [];
  let visitedCount = 0;

  // Deduplicate cycles by canonical rotation (smallest id first).
  const seen = new Set<string>();
  const record = (cycleNodes: string[]) => {
    // Rotate so the lexicographically smallest id is first.
    let minIdx = 0;
    for (let i = 1; i < cycleNodes.length - 1; i++) {
      if (cycleNodes[i] < cycleNodes[minIdx]) minIdx = i;
    }
    const rotated = [
      ...cycleNodes.slice(minIdx),
      ...cycleNodes.slice(0, minIdx),
    ];
    const key = rotated.join(">");
    if (!seen.has(key)) {
      seen.add(key);
      cycles.push([...rotated, rotated[0]]); // close the loop
    }
  };

  async function visit(id: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      throw new Error(`claim-graph: maxDepth ${maxDepth} exceeded at "${id}"`);
    }
    if (visitedCount > maxNodes) {
      throw new Error(`claim-graph: maxNodes ${maxNodes} exceeded`);
    }
    const c = color.get(id) ?? 0;
    if (c === 2) return;            // fully processed, no cycle through here
    if (c === 1) {
      // Back-edge: extract the cycle from the current stack.
      const idx = stack.indexOf(id);
      if (idx >= 0) record(stack.slice(idx).concat(id));
      return;
    }
    color.set(id, 1);
    stack.push(id);
    visitedCount++;

    const node = await loader.get(id);
    if (node) {
      for (const ref of node.refs) {
        await visit(ref, depth + 1);
      }
    }

    stack.pop();
    color.set(id, 2);
  }

  for (const root of roots) {
    await visit(root, 0);
  }

  return {
    cycles,
    visitedCount,
    hasCycle: cycles.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Worked example (runnable). Expected stdout:
//
//   { hasCycle: true, visitedCount: 8, cycles: [ [ 'a', 'b', 'c', 'a' ] ] }
//   depth-limit message: claim-graph: maxDepth 3 exceeded at "e"
// ---------------------------------------------------------------------------

class InMemoryLoader implements GraphLoader {
  private store = new Map<string, ClaimNode>();
  set(node: ClaimNode) { this.store.set(node.id, node); return this; }
  async get(id: string): Promise<ClaimNode | null> {
    return this.store.get(id) ?? null;
  }
}

async function main() {
  const ld = new InMemoryLoader()
    .set({ id: "a", refs: ["b"] })
    .set({ id: "b", refs: ["c"] })
    .set({ id: "c", refs: ["a"] }) // closes loop a -> b -> c -> a
    .set({ id: "d", refs: ["e"] })
    .set({ id: "e", refs: ["f"] })
    .set({ id: "f", refs: [] });

  console.log(await detectCycles(ld, ["a", "d"]));

  try {
    await detectCycles(ld, ["d"], { maxDepth: 3 });
  } catch (err) {
    console.log("depth-limit message:", (err as Error).message);
  }
}

// Auto-run when executed directly; safe no-op when imported.
const isDirect = typeof process !== "undefined"
  && process.argv[1]
  && (process.argv[1].endsWith("cycle-detector.ts")
    || process.argv[1].endsWith("cycle-detector.js"));
if (isDirect) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
