/**
 * Claim Graph Resolver
 *
 * Given a root claim (identifier) and a set of signed sub-claims from different
 * issuers, this module walks the dependency graph, verifies each edge, and
 * returns the minimal resolved claim set plus the verification trace.
 *
 * Pattern: composable-claim-graph, but with the resolution algorithm made
 * explicit and copy-pasteable. Works with any verifier that exposes:
 *   verify(jws: string): { payload: unknown; issuer: string } | throws
 *
 * The graph is described by a simple JSON envelope:
 *   {
 *     "root": "<claim-id>",
 *     "edges": [{ "from": "<claim-id>", "to": "<claim-id>", "requires": "<field>" }],
 *     "claims": { "<claim-id>": { "issuer": "did:...", "jws": "<compact-jws>" } }
 *   }
 *
 * Example:
 *   const r = new ClaimGraphResolver(graph, jwsVerify);
 *   const out = r.resolve();
 *   // out = { root: 'c1', resolved: ['c1','c2'], trace: [...] }
 */

export type JwsVerifier = (jws: string) => { payload: any; issuer: string };

export interface ClaimEdge {
  from: string;
  to: string;
  requires: string; // field name on `from.payload` whose value must equal `to`
}

export interface ClaimNode {
  issuer: string;
  jws: string; // compact JWS: header.payload.signature
}

export interface ClaimGraph {
  root: string;
  edges: ClaimEdge[];
  claims: Record<string, ClaimNode>;
}

export interface ResolvedClaim {
  id: string;
  issuer: string;
  payload: any;
}

export interface ResolutionStep {
  claimId: string;
  issuer: string;
  satisfiedBy?: string; // claim id that satisfied the dependency, if any
  field?: string;
}

export interface ResolutionResult {
  root: string;
  resolved: ResolvedClaim[];
  trace: ResolutionStep[];
  missing: string[]; // claim ids referenced but not supplied / unverifiable
}

export class ClaimGraphResolver {
  private verified = new Map<string, ResolvedClaim>();
  private trace: ResolutionStep[] = [];
  private missing: string[] = [];

  constructor(private readonly graph: ClaimGraph, private readonly verify: JwsVerifier) {}

  resolve(): ResolutionResult {
    this.verified.clear();
    this.trace = [];
    this.missing = [];

    if (!this.graph.claims[this.graph.root]) {
      this.missing.push(this.graph.root);
      return this.finish();
    }

    this.walk(this.graph.root);
    return this.finish();
  }

  private walk(id: string): ResolvedClaim | null {
    if (this.verified.has(id)) return this.verified.get(id)!;

    const node = this.graph.claims[id];
    if (!node) {
      if (!this.missing.includes(id)) this.missing.push(id);
      return null;
    }

    let payload: any;
    let issuer: string;
    try {
      const v = this.verify(node.jws);
      payload = v.payload;
      issuer = v.issuer;
    } catch (err) {
      this.missing.push(id);
      return null;
    }

    const resolved: ResolvedClaim = { id, issuer, payload };
    this.verified.set(id, resolved);

    // Recurse into outgoing edges from this node.
    const out = this.graph.edges.filter((e) => e.from === id);
    for (const edge of out) {
      const expected = payload?.[edge.requires];
      const depNode = this.graph.claims[edge.to];
      const depPayload = depNode ? safePayload(depNode, this.verify) : null;

      let depId: string | null = null;
      if (depPayload && expected !== undefined && depMatches(depPayload, expected)) {
        depId = edge.to;
        this.walk(edge.to);
      } else if (!depNode) {
        this.missing.push(edge.to);
      }

      this.trace.push({
        claimId: id,
        issuer,
        satisfiedBy: depId ?? undefined,
        field: edge.requires,
      });
    }

    return resolved;
  }

  private finish(): ResolutionResult {
    return {
      root: this.graph.root,
      resolved: [...this.verified.values()],
      trace: this.trace,
      missing: this.missing,
    };
  }
}

function safePayload(node: ClaimNode, verify: JwsVerifier): any | null {
  try {
    return verify(node.jws).payload;
  } catch {
    return null;
  }
}

/** Match by `id` field, or full structural equality as a fallback. */
function depMatches(payload: any, expected: unknown): boolean {
  if (payload && typeof payload === "object" && "id" in payload) {
    return payload.id === expected;
  }
  return JSON.stringify(payload) === JSON.stringify(expected);
}

// --- Tiny self-test (run with: ts-node resolver.ts) ----------------------------
if (require.main === module) {
  // Fake verifier: trusts everything, decodes base64url middle segment.
  const fakeVerify: JwsVerifier = (jws) => {
    const [, p] = jws.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    return { payload, issuer: payload.iss ?? "did:fake" };
  };

  const b64 = (obj: any) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  const graph: ClaimGraph = {
    root: "c1",
    edges: [{ from: "c1", to: "c2", requires: "parent" }],
    claims: {
      c1: { issuer: "did:issuer-a", jws: `h.${b64({ iss: "did:issuer-a", id: "c1", parent: "c2" })}.s` },
      c2: { issuer: "did:issuer-b", jws: `h.${b64({ iss: "did:issuer-b", id: "c2" })}.s` },
    },
  };

  const out = new ClaimGraphResolver(graph, fakeVerify).resolve();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
