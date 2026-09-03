// patterns/claim-graph-resolver/src/cycle-detector.ts
//
// Cycle detection for a claim graph resolver. When resolving a node's
// dependencies recursively, an accidental cycle (A -> B -> C -> A) will
// cause unbounded recursion and stack blow-up. This module provides a
// deterministic, allocation-light cycle detector that the resolver can
// consult before descending into a dependency.
//
// Design choices:
//  - IDs are opaque strings (e.g. CID, URI, or hash). We never assume
//    they are URLs or sortable.
//  - We track an in-progress set for the current DFS frontier and a
//    completed set so we don't redo work across independent subtrees.
//  - On cycle detection, we return the offending path so the caller can
//    surface it as a structured error to the client.
//  - Pure logic, no I/O. Trivial to unit test.

export interface CycleDetector {
  /** Begin visiting a node. Throws or returns false on a back-edge. */
  enter(id: string): void;
  /** Finish visiting a node (post-order). Idempotent. */
  leave(id: string): void;
  /** Reset all state. */
  reset(): void;
  /** Snapshot for debugging / logging. */
  snapshot(): { stack: string[]; visited: string[] };
}

export class CycleError extends Error {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`Claim graph cycle detected: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
    this.cycle = cycle;
  }
}

export function createCycleDetector(opts?: { throwOnCycle?: boolean }): CycleDetector {
  const throwOnCycle = opts?.throwOnCycle ?? true;
  // stack: nodes on the current DFS path (parent chain)
  // visited: nodes that are fully processed in this traversal
  const stack: string[] = [];
  const stackSet = new Set<string>();
  const visited = new Set<string>();

  function enter(id: string): void {
    if (stackSet.has(id)) {
      const idx = stack.indexOf(id);
      const cycle = idx >= 0 ? [...stack.slice(idx), id] : [...stack, id];
      if (throwOnCycle) throw new CycleError(cycle);
      return;
    }
    if (visited.has(id)) return; // already done in another branch, safe to skip
    stackSet.add(id);
    stack.push(id);
  }

  function leave(id: string): void {
    if (!stackSet.has(id)) return;
    stackSet.delete(id);
    stack.pop();
    visited.add(id);
  }

  return {
    enter,
    leave,
    reset() {
      stack.length = 0;
      stackSet.clear();
      visited.clear();
    },
    snapshot() {
      return { stack: [...stack], visited: [...visited] };
    },
  };
}

// ------------------------------------------------------------------
// Worked example: integrating with the resolver
// ------------------------------------------------------------------
//
// import { resolve } from './resolver';
// import { createCycleDetector, CycleError } from './cycle-detector';
//
// async function safeResolve(rootId: string, getDeps: (id: string) => Promise<string[]>) {
//   const det = createCycleDetector();
//   async function walk(id: string): Promise<unknown> {
//     det.enter(id);
//     try {
//       const deps = await getDeps(id);
//       const out = await Promise.all(deps.map(walk));
//       return { id, deps: out };
//     } finally {
//       det.leave(id);
//     }
//   }
//   try {
//     return await walk(rootId);
//   } catch (e) {
//     if (e instanceof CycleError) {
//       return { ok: false, cycle: e.cycle, trace: det.snapshot() };
//     }
//     throw e;
//   }
// }
//
// Mini test (copy into a .test.ts):
//
// import { createCycleDetector, CycleError } from './cycle-detector';
// const d = createCycleDetector();
// d.enter('a'); d.enter('b'); d.enter('c');
// try { d.enter('a'); } catch (e) { console.log(e instanceof CycleError); } // true
// d.leave('c'); d.leave('b'); d.leave('a');
// d.enter('a'); // safe, fully visited

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
