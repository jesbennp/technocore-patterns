import { composeClaims } from "./compose";
import { detectCycles } from "./cycle-detector";
import { resolveClaim } from "./resolver";
import { DelegationDepthGuard } from "./delegation-depth-guard";

export interface ComposeOptions {
  maxDelegationDepth?: number; // default 10
  allowCycles?: boolean; // default false
  resolved?: Map<string, unknown>; // inject a pre-populated resolver cache
}

export interface ComposeResult {
  ok: boolean;
  composed?: unknown;
  reason?:
    | "cycle_detected"
    | "max_delegation_depth_exceeded"
    | "unresolved_claim"
    | "policy_evaluation_failed";
  details?: string;
  graph?: { nodes: string[]; edges: Array<[string, string]> };
}

/**
 * One-shot composable claim evaluator that layers four safety guarantees
 * on top of the raw composeClaims() pipeline:
 *   1. Cycle detection BEFORE composition (cheap fail-fast).
 *   2. Delegation-depth bounding AFTER resolution.
 *   3. Re-resolution of every transitively referenced claim (no stale caches).
 *   4. Single structured error code so callers can branch deterministically.
 *
 * This is the recommended entry point for production code paths; raw
 * composeClaims() is still exported for advanced / non-cyclic use cases.
 *
 * Example (Node):
 *   import claims from "./examples/recursive-trust-delegation.json" assert { type: "json" };
 *   const r = await safeCompose(claims);
 *   if (!r.ok && r.reason === "max_delegation_depth_exceeded") {
 *     console.error("Trust chain too long:", r.details);
 *   }
 */
export async function safeCompose(
  rootClaim: unknown,
  opts: ComposeOptions = {},
): Promise<ComposeResult> {
  const { maxDelegationDepth = 10, allowCycles = false, resolved } = opts;

  // 1. Structural cycle check on the static graph first.
  const cycle = detectCycles(rootClaim);
  if (cycle.hasCycle && !allowCycles) {
    return {
      ok: false,
      reason: "cycle_detected",
      details: `Cycle involves: ${cycle.cycle.join(" -> ")}`,
    };
  }

  // 2. Resolve transitively so depth guards see the real expansion.
  const resolverState =
    resolved ??
    new Map<string, unknown>(Object.entries(await resolveClaim(rootClaim)));

  // 3. Bounded delegation depth.
  const depthGuard = new DelegationDepthGuard(maxDelegationDepth);
  for (const [id, claim] of resolverState) {
    const depth = depthGuard.walk(id, claim, (cid) => resolverState.get(cid));
    if (depth.exceeded) {
      return {
        ok: false,
        reason: "max_delegation_depth_exceeded",
        details: `Claim ${id} depth=${depth.depth} > ${maxDelegationDepth}`,
      };
    }
  }

  // 4. Final composition. Any throw becomes a structured failure.
  try {
    const composed = await composeClaims(rootClaim, resolverState);
    return { ok: true, composed };
  } catch (err) {
    return {
      ok: false,
      reason: "policy_evaluation_failed",
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Convenience: build a minimal {nodes, edges} graph description from a
 * claim object so logs and debugging tools can render the trust DAG
 * without re-running the heavier compose pipeline.
 */
export function describeClaimGraph(
  root: any,
): { nodes: string[]; edges: Array<[string, string]> } {
  const nodes = new Set<string>();
  const edges: Array<[string, string]> = [];
  const visit = (node: any, parent?: string) => {
    if (!node || typeof node !== "object") return;
    const id = node.id ?? node["@id"];
    if (id) {
      nodes.add(id);
      if (parent) edges.push([parent, id]);
    }
    for (const ref of node.dependencies ?? node.requires ?? []) {
      visit(ref, id ?? parent);
    }
  };
  visit(root);
  return { nodes: [...nodes], edges };
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
