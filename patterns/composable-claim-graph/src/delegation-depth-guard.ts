// src/delegation-depth-guard.ts
// Pre-execution safety net for the composable-claim-graph resolver.
// Delegation chains can loop or grow without bound. Before calling
// resolver.resolve, callers should consult this guard to fail fast
// and return a structured error instead of blowing the stack or
// spending minutes on a circular graph.
//
// Usage:
//   import { DelegationDepthGuard, DepthLimitExceeded } from "./delegation-depth-guard";
//   const guard = new DelegationDepthGuard({ maxDepth: 16, maxNodes: 1024 });
//   try {
//     for (const step of resolver.traverse(graph, did)) {
//       guard.observe(step.delegator, step.delegate);
//     }
//   } catch (e) {
//     if (e instanceof DepthLimitExceeded) { ... }
//   }

export interface GuardOptions {
  /** Maximum delegation hops to allow from any root. Default 16. */
  maxDepth?: number;
  /** Maximum total distinct (delegator,delegate) edges to visit. Default 1024. */
  maxNodes?: number;
}

export interface ObserveStep {
  /** DID of the entity granting the authority. */
  delegator: string;
  /** DID of the entity receiving the authority. */
  delegate: string;
}

export class DepthLimitExceeded extends Error {
  readonly code = "E_DEPTH_LIMIT";
  readonly path: string[];
  constructor(path: string[], message: string) {
    super(message);
    this.name = "DepthLimitExceeded";
    this.path = path;
  }
}

export class CycleDetected extends Error {
  readonly code = "E_CYCLE";
  readonly edge: { delegator: string; delegate: string };
  constructor(edge: { delegator: string; delegate: string }) {
    super(`Delegation cycle detected via ${edge.delegator} -> ${edge.delegate}`);
    this.name = "CycleDetected";
    this.edge = edge;
  }
}

export class DelegationDepthGuard {
  private readonly maxDepth: number;
  private readonly maxNodes: number;
  private readonly ancestorStack: string[] = [];
  private readonly ancestorSet: Set<string> = new Set();
  private readonly seenEdges: Set<string> = new Set();
  private visitedNodes = 0;

  constructor(opts: GuardOptions = {}) {
    this.maxDepth = opts.maxDepth ?? 16;
    this.maxNodes = opts.maxNodes ?? 1024;
  }

  /** Called once per traversal step. Push when entering an edge, pop when leaving. */
  observe(step: ObserveStep): void {
    this.visitedNodes += 1;
    if (this.visitedNodes > this.maxNodes) {
      throw new DepthLimitExceeded(
        [...this.ancestorStack, step.delegator, step.delegate],
        `Visited ${this.visitedNodes} edges; maxNodes=${this.maxNodes} exceeded`,
      );
    }
    const edgeKey = `${step.delegator}\u0001${step.delegate}`;
    if (this.seenEdges.has(edgeKey)) {
      throw new CycleDetected({ delegator: step.delegator, delegate: step.delegate });
    }
    this.seenEdges.add(edgeKey);

    if (this.ancestorSet.has(step.delegate)) {
      throw new CycleDetected({ delegator: step.delegator, delegate: step.delegate });
    }
    const nextDepth = this.ancestorStack.length + 1;
    if (nextDepth > this.maxDepth) {
      throw new DepthLimitExceeded(
        [...this.ancestorStack, step.delegator, step.delegate],
        `Depth ${nextDepth} exceeded maxDepth=${this.maxDepth}`,
      );
    }
    this.ancestorStack.push(step.delegator);
    this.ancestorSet.add(step.delegator);
  }

  /** Call after the resolver finishes walking children of `delegator`. */
  pop(): void {
    const top = this.ancestorStack.pop();
    if (top !== undefined) this.ancestorSet.delete(top);
  }

  /** Convenience: wrap a generator so guard state is balanced even on throw. */
  *wrap<T extends ObserveStep>(steps: Iterable<T>): Generator<T> {
    const it = (steps as Iterable<T>)[Symbol.iterator]();
    while (true) {
      let next: IteratorResult<T>;
      try {
        next = it.next();
      } catch (e) {
        this.pop();
        throw e;
      }
      if (next.done) {
        this.pop();
        return;
      }
      this.observe(next.value);
      yield next.value;
    }
  }

  /** Inspect current guard state without mutating. */
  stats(): { depth: number; visitedNodes: number; maxDepth: number; maxNodes: number } {
    return {
      depth: this.ancestorStack.length,
      visitedNodes: this.visitedNodes,
      maxDepth: this.maxDepth,
      maxNodes: this.maxNodes,
    };
  }
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
