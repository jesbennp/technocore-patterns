/**
 * Policy evaluator for composable claim graphs.
 *
 * Given a resolved claim graph (already cycle-checked, as produced by
 * resolver.ts + cycle-detector.ts) and a top-level Policy node, evaluate
 * whether the policy is satisfied and return a structured trace.
 *
 * Supported policy operators (matching examples/*.json):
 *   - "all-of"   : all child policies must be satisfied
 *   - "any-of"   : at least one child policy must be satisfied
 *   - "not"      : the child policy must NOT be satisfied
 *   - "require"  : a named claim must be present and verifiable
 *   - "delegate" : the child policy is evaluated under a delegated issuer
 *
 * The evaluator is pure: it does not fetch claims or verify signatures.
 * It assumes the graph resolver has already populated the claim cache.
 */

export type Claim = {
  id: string;
  issuer: string;
  subject: string;
  type: string;
  issuedAt: string;
  expiresAt?: string;
  proof?: { type: string; verificationMethod: string; signature: string };
  claims?: Record<string, unknown>;
};

export type Policy =
  | { op: "all-of"; children: Policy[] }
  | { op: "any-of"; children: Policy[] }
  | { op: "not"; child: Policy }
  | { op: "require"; claimType: string; issuer?: string; subject?: string }
  | { op: "delegate"; toIssuer: string; child: Policy };

export type EvaluationTrace = {
  policy: Policy;
  result: boolean;
  reason: string;
  children?: EvaluationTrace[];
};

type Resolver = {
  resolveClaim(query: { type: string; issuer?: string; subject?: string }): Claim | undefined;
  isIssuerTrusted(issuer: string): boolean;
};

const isExpired = (c: Claim, now: Date): boolean =>
  !!c.expiresAt && new Date(c.expiresAt).getTime() <= now.getTime();

export function evaluatePolicy(
  policy: Policy,
  resolver: Resolver,
  now: Date = new Date()
): EvaluationTrace {
  switch (policy.op) {
    case "require": {
      const claim = resolver.resolveClaim({
        type: policy.claimType,
        issuer: policy.issuer,
        subject: policy.subject,
      });
      if (!claim) {
        return { policy, result: false, reason: `no claim matched type=${policy.claimType}` };
      }
      if (isExpired(claim, now)) {
        return { policy, result: false, reason: `claim ${claim.id} expired at ${claim.expiresAt}` };
      }
      if (!resolver.isIssuerTrusted(claim.issuer)) {
        return { policy, result: false, reason: `issuer ${claim.issuer} not trusted` };
      }
      return { policy, result: true, reason: `matched claim ${claim.id} from ${claim.issuer}` };
    }

    case "all-of": {
      const traces = policy.children.map((c) => evaluatePolicy(c, resolver, now));
      const ok = traces.every((t) => t.result);
      return {
        policy,
        result: ok,
        reason: ok ? "all children satisfied" : "at least one child failed",
        children: traces,
      };
    }

    case "any-of": {
      const traces = policy.children.map((c) => evaluatePolicy(c, resolver, now));
      const ok = traces.some((t) => t.result);
      return {
        policy,
        result: ok,
        reason: ok ? "at least one child satisfied" : "no child satisfied",
        children: traces,
      };
    }

    case "not": {
      const trace = evaluatePolicy(policy.child, resolver, now);
      return {
        policy,
        result: !trace.result,
        reason: `negation of child (${trace.result ? "was true" : "was false"})`,
        children: [trace],
      };
    }

    case "delegate": {
      if (!resolver.isIssuerTrusted(policy.toIssuer)) {
        return {
          policy,
          result: false,
          reason: `delegate target ${policy.toIssuer} is not trusted`,
        };
      }
      const trace = evaluatePolicy(policy.child, resolver, now);
      return {
        policy,
        result: trace.result,
        reason: `delegated to ${policy.toIssuer}`,
        children: [trace],
      };
    }
  }
}

// ---------- Example wiring (also useful as a smoke test) ----------

if (require.main === module) {
  const claims: Claim[] = [
    {
      id: "urn:claim:kyc:alice",
      issuer: "did:example:trusted-kyc",
      subject: "did:example:alice",
      type: "KYCVerified",
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2027-01-01T00:00:00Z",
    },
    {
      id: "urn:claim:resident:alice",
      issuer: "did:example:gov",
      subject: "did:example:alice",
      type: "ResidentOf",
      issuedAt: "2026-01-01T00:00:00Z",
      claims: { country: "US" },
    },
  ];

  const resolver: Resolver = {
    resolveClaim({ type, issuer, subject }) {
      return claims.find(
        (c) =>
          c.type === type &&
          (!issuer || c.issuer === issuer) &&
          (!subject || c.subject === subject)
      );
    },
    isIssuerTrusted: () => true,
  };

  const policy: Policy = {
    op: "all-of",
    children: [
      { op: "require", claimType: "KYCVerified", subject: "did:example:alice" },
      { op: "any-of", children: [
        { op: "require", claimType: "ResidentOf", issuer: "did:example:gov" },
        { op: "require", claimType: "CitizenOf", issuer: "did:example:gov" },
      ]},
      { op: "not", child: { op: "require", claimType: "Sanctioned" }},
    ],
  };

  const trace = evaluatePolicy(policy, resolver);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(trace, null, 2));
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
