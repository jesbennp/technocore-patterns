/**
 * resolver.ts — minimal claim-graph resolver for composable trust policies.
 *
 * Resolves a root claim against an in-memory graph of claims and policies.
 * Each policy is a JSON object (see examples/cycle-detection-policy.json).
 *
 * Supports composition operators:
 *   - "and": all sub-policies must resolve to true
 *   - "or":  at least one sub-policy must resolve to true
 *   - "not": sub-policy must resolve to false
 *   - "require": a referenced claim-id must be present and verified
 *   - "delegate": trust is delegated to a remote issuer via a registry lookup
 *
 * Cycles are detected via DFS coloring (WHITE/GRAY/BLACK). A GRAY revisit
 * raises ResolutionError with the cycle path, so callers can surface it.
 *
 * Result caching is intentionally NOT included; see cache.ts for that layer.
 */

export type ClaimId = string;
export type IssuerId = string;

export interface Claim {
  id: ClaimId;
  issuer: IssuerId;
  subject: string;
  type: string;
  value: unknown;
  issuedAt: string;   // ISO-8601
  expiresAt?: string; // ISO-8601, optional
}

export type Policy =
  | { op: "and"; all: Policy[] }
  | { op: "or";  any: Policy[] }
  | { op: "not"; invert: Policy }
  | { op: "require"; claim: ClaimId }
  | { op: "delegate"; issuer: IssuerId; trust: Policy };

export interface ResolutionContext {
  graph: Map<ClaimId, Claim>;
  trustedIssuers: Set<IssuerId>;
  now?: () => Date;
}

export class ResolutionError extends Error {
  constructor(message: string, public readonly path: ClaimId[]) {
    super(`${message} [${path.join(" -> ")}]`);
    this.name = "ResolutionError";
  }
}

type Color = 0 | 1 | 2; // WHITE=0, GRAY=1, BLACK=2

function isExpired(c: Claim, now: Date): boolean {
  if (!c.expiresAt) return false;
  return new Date(c.expiresAt).getTime() <= now.getTime();
}

export function resolve(
  policy: Policy,
  ctx: ResolutionContext,
  _stack: ClaimId[] = []
): boolean {
  const now = (ctx.now ?? (() => new Date()))();

  switch (policy.op) {
    case "and": {
      for (const p of policy.all) {
        if (!resolve(p, ctx, _stack)) return false;
      }
      return policy.all.length > 0;
    }
    case "or": {
      for (const p of policy.any) {
        if (resolve(p, ctx, _stack)) return true;
      }
      return false;
    }
    case "not": {
      return !resolve(policy.invert, ctx, _stack);
    }
    case "require": {
      const claim = ctx.graph.get(policy.claim);
      if (!claim) {
        throw new ResolutionError(
          `missing claim: ${policy.claim}`,
          [..._stack, policy.claim]
        );
      }
      if (isExpired(claim, now)) {
        return false;
      }
      if (!ctx.trustedIssuers.has(claim.issuer)) {
        return false;
      }
      // Cycle detection via the claim-id stack.
      if (_stack.includes(claim.id)) {
        throw new ResolutionError(
          `cycle detected`,
          [..._stack, claim.id]
        );
      }
      // Optional: a claim may carry an embedded policy under claim.value.policy
      const embedded = (claim.value as any)?.policy as Policy | undefined;
      if (embedded) {
        return resolve(embedded, ctx, [..._stack, claim.id]);
      }
      return true;
    }
    case "delegate": {
      if (!ctx.trustedIssuers.has(policy.issuer)) return false;
      // When delegating, push the delegating issuer onto the stack so a
      // self-referential delegation (A delegates to A) is caught.
      return resolve(policy.trust, ctx, [..._stack, `issuer:${policy.issuer}`]);
    }
  }
}

/**
 * Convenience: build a context from plain objects.
 */
export function makeContext(
  claims: Claim[],
  trustedIssuers: IssuerId[]
): ResolutionContext {
  return {
    graph: new Map(claims.map((c) => [c.id, c])),
    trustedIssuers: new Set(trustedIssuers),
  };
}

// ---- Example usage (kept here so the file is self-contained & runnable) ----
//
// import p from "./examples/policy-composition-with-and.json" assert { type: "json" };
// const ctx = makeContext([
//   { id: "c1", issuer: "did:example:root", subject: "u1",
//     type: "EmailVerified", value: true, issuedAt: "2025-01-01T00:00:00Z" },
//   { id: "c2", issuer: "did:example:root", subject: "u1",
//     type: "AgeOver18",    value: true, issuedAt: "2025-01-01T00:00:00Z" },
// ], ["did:example:root"]);
// console.log(resolve(p as Policy, ctx)); // -> true

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
