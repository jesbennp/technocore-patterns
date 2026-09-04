# Composable Claim Graph Pattern

A claim graph is a directed acyclic graph (DAG) of attestations where each node
is a cryptographically verifiable claim and each edge expresses a dependency
("this claim is valid because of X, Y, Z"). The graph is composed from multiple
issuers and resolved by a verifier before any authorization decision is made.

This pattern generalizes the single-issuer verifiable credential model. Instead
of trusting one root signature, the verifier walks the graph, checks each edge,
and evaluates a policy over the resolved subgraph.

## When to use

Use a claim graph when:

- A decision depends on **multiple issuers** (e.g. KYC + employer + device posture).
- You need to **compose proofs** across trust domains (org A vouches for an
  identity provider that vouches for a device).
- You want **policy-as-code** over the resolved graph, not just the leaf claim.
- You must detect **circular or self-referential attestations** before trusting them.

Do NOT use a claim graph when a single signed JWT or SD-JWT VC is sufficient.

## Node shape

```jsonc
{
  "id": "urn:claim:abc123",
  "type": "IdentityAssertion",
  "issuer": "did:key:z6Mk...",
  "subject": "did:key:z6Mn...",
  "issued": "2025-01-15T10:00:00Z",
  "expires": "2025-07-15T10:00:00Z",
  "dependsOn": ["urn:claim:xyz789"],   // edges into parent claims
  "proof": { /* JWS or CWT over canonical(node without proof) */ }
}
```

Edges (`dependsOn`) form a DAG. Any cycle is a hard failure — see
`cycle-detection-policy.json` and the `cycle-detector.ts` reference
implementation in `../claim-graph-resolver/src/`.

## Resolution algorithm

1. **Fetch** the root claim requested by the relying party.
2. **Recurse** into each `dependsOn` until leaves are reached (cap depth, e.g. 8).
3. **Verify** each node's proof against its issuer's published verification key.
4. **Check** freshness (`now < expires`, optional `issued` lower bound).
5. **Detect cycles** via DFS coloring (white/gray/black) on the in-flight fetch set.
6. **Evaluate policy** over the resolved subgraph; emit an allow/deny plus the
   minimal witness subgraph that justified the decision.

## Worked example

See `examples/recursive-attestation-chain.json` for a 3-node chain:

```
OrgHR --vouches for--> EmploymentStatus
                         |
                         v
                   AccountAccess (root)
```

The verifier resolves `AccountAccess`, follows the edge to `EmploymentStatus`,
then follows OrgHR's employment assertion, evaluates a policy requiring
"active employee of org with tier >= 2", and returns the witness.

## Policy format

Policies are JSONLogic-style expressions evaluated against the resolved node
map. `examples/cycle-detection-policy.json` shows a deny rule triggered when
any node's issuer list contains the subject's own DID.

## Composition with other patterns

- **Selective disclosure (Merkle proof)**: a claim graph node can carry an
  SD-JWT VC payload; SD fields are revealed only at policy-evaluation time.
- **Merkle inclusion proof**: large claim sets (e.g. "member of org X") can be
  represented as a single node whose proof is a Merkle inclusion proof over a
  published membership tree.
- **Claim graph resolver**: the runtime in
  `../claim-graph-resolver/src/policy-evaluator.ts` is the canonical evaluator.

## Anti-patterns

- Treating the root claim as self-authenticating — it isn't.
- Allowing cycles "because we trust the issuers" — a compromised key turns a
  cycle into an infinite proof-of-trust loop.
- Embedding PII in the graph itself. Put PII behind selective disclosure.
- Mixing policy and routing logic in the same module.

## Status

Draft, working. The reference resolver lives in
`../claim-graph-resolver/`. The cycle detector and cache are reusable as-is.

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
