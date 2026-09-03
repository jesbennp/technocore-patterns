// pattern: claim-graph-resolver/policy-evaluator
// purpose: evaluate a resolved ClaimGraph against a declarative Policy and return a Verdict.
// copy-pasteable, self-contained, zero deps. Wire it after resolver.resolve().
//
// A Policy is a set of Rules. Each Rule has:
//   - id: string
//   - anyClaim?: { type: string, issuer?: string }[]   // at least one of these claims must exist (by edge.source->target, edge.claim)
//   - requireAll?: string[]                              // claim ids that MUST be present
//   - requireNone?: string[]                             // claim ids that MUST NOT be present
//   - minTrust?: number (0..1)                           // min trust score on the issuer of matching claims
//
// ClaimGraph shape (matches resolver.ts):
//   { nodes: {id,type}[], edges: [{source,target,claim:{type,issuer?,trust?}}] }

export type ClaimNode = { id: string; type: string };
export type ClaimEdge = {
  source: string;
  target: string;
  claim: { type: string; issuer?: string; trust?: number };
};
export type ClaimGraph = { nodes: ClaimNode[]; edges: ClaimEdge[] };

export type Rule = {
  id: string;
  anyClaim?: { type: string; issuer?: string }[];
  requireAll?: string[]; // claim "type" strings that must each appear at least once
  requireNone?: string[];
  minTrust?: number;
};
export type Policy = { id: string; rules: Rule[] };

export type Verdict =
  | { ok: true; policyId: string; matchedRuleIds: string[] }
  | { ok: false; policyId: string; failedRuleId: string; reason: string };

function edgeMatches(edge: ClaimEdge, c: { type: string; issuer?: string }): boolean {
  if (edge.claim.type !== c.type) return false;
  if (c.issuer && edge.claim.issuer !== c.issuer) return false;
  return true;
}

export function evaluatePolicy(graph: ClaimGraph, policy: Policy): Verdict {
  for (const rule of policy.rules) {
    // 1. anyClaim: at least one edge matches one of the listed claims
    if (rule.anyClaim && rule.anyClaim.length > 0) {
      const hit = rule.anyClaim.some((c) =>
        graph.edges.some((e) => edgeMatches(e, c))
      );
      if (!hit) {
        return { ok: false, policyId: policy.id, failedRuleId: rule.id, reason: "anyClaim not satisfied" };
      }
    }

    // 2. requireAll: every listed claim type must appear
    if (rule.requireAll && rule.requireAll.length > 0) {
      for (const need of rule.requireAll) {
        const present = graph.edges.some((e) => e.claim.type === need);
        if (!present) {
          return { ok: false, policyId: policy.id, failedRuleId: rule.id, reason: `missing required claim: ${need}` };
        }
      }
    }

    // 3. requireNone: no listed claim type may appear
    if (rule.requireNone && rule.requireNone.length > 0) {
      for (const forbid of rule.requireNone) {
        const present = graph.edges.some((e) => e.claim.type === forbid);
        if (present) {
          return { ok: false, policyId: policy.id, failedRuleId: rule.id, reason: `forbidden claim present: ${forbid}` };
        }
      }
    }

    // 4. minTrust: every matching claim must meet the floor
    if (typeof rule.minTrust === "number") {
      const pool = rule.anyClaim
        ? rule.anyClaim.flatMap((c) => graph.edges.filter((e) => edgeMatches(e, c)))
        : graph.edges;
      const weak = pool.find((e) => (e.claim.trust ?? 1) < rule.minTrust!);
      if (weak) {
        return {
          ok: false,
          policyId: policy.id,
          failedRuleId: rule.id,
          reason: `trust too low on ${weak.claim.type} from ${weak.claim.issuer ?? "anon"} (${weak.claim.trust ?? 0} < ${rule.minTrust})`,
        };
      }
    }
  }
  return { ok: true, policyId: policy.id, matchedRuleIds: policy.rules.map((r) => r.id) };
}

// ---- worked example ----
// A relying party wants: "is this principal over 18 AND verified by gov AND not flagged as bot?"
// After resolver.resolve(did) returns a ClaimGraph:
//
//   const policy: Policy = {
//     id: "adult-gov-notbot",
//     rules: [
//       { id: "age", requireAll: ["ageOver18"], minTrust: 0.8 },
//       { id: "gov", anyClaim: [{ type: "govId", issuer: "did:example:gov" }] },
//       { id: "nobot", requireNone: ["botFlag"] },
//     ],
//   };
//   const v = evaluatePolicy(graph, policy);
//   if (!v.ok) return new Response("denied: " + v.reason, { status: 403 });
//
// Composes with claim-graph-resolver/src/resolver.ts:
//   const graph = resolver.resolve(handleId);
//   const verdict = evaluatePolicy(graph, policy);
//   send(verdict);

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
