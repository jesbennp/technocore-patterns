# claim-graph-resolver

A small, working reference for resolving a **composable claim graph** built on top

of selective-disclosure Merkle trees. A claim graph lets you combine many

independently-issued claims (issued by different parties, with different roots)

into one verifiable answer to a higher-level question — for example,

"is this user over 18 AND a resident of country X AND holding a valid KYC token?"

— without revealing any of the underlying fields.

This README documents the pattern and ties together the two reference files in

this repo:

- `src/resolver.ts` — the TypeScript resolver that walks a graph and verifies
  each edge against its issuer's signed Merkle root.
- The sibling `patterns/selective-disclosure-merkle-proof/` pattern that
  produces the individual Merkle inclusion proofs consumed here.

## The data model

A claim graph is a DAG of `ClaimNode`s. Each node is either a **leaf**

(an attested fact) or a **composition** (a boolean/logical combination of other

nodes).

```ts
type ClaimNode =
  | LeafClaim
  | AndClaim
  | OrClaim
  | NotClaim
  | ThresholdClaim; // e.g. "at least 2 of [a,b,c]"

interface LeafClaim {
  kind: "leaf";
  id: string;
  issuer: string;        // did:key:…
  schema: string;        // e.g. "age-over-18"
  merkleRoot: string;    // signed by issuer
  revealed: string[];    // field names the holder chose to reveal
  proof: MerkleProof;    // see selective-disclosure-merkle-proof
}

interface AndClaim   { kind: "and"; id: string; all: ClaimNode[] }
interface OrClaim    { kind: "or";  id: string; any: ClaimNode[] }
interface NotClaim   { kind: "not"; id: string; of: ClaimNode }
interface ThresholdClaim {
  kind: "threshold"; id: string; n: number; of: ClaimNode[];
}
```

## How resolution works

The resolver in `src/resolver.ts` does three things, in order:

1. **Memoize** by node id, so a leaf shared by two branches is only verified
   once.
2. **Verify every leaf** by checking the Merkle proof against `merkleRoot`,
   confirming `issuer` signed that root, and that every name in `revealed` is
   actually proven by the proof.
4. **Evaluate the composition** with short-circuit semantics: an `and` returns
   the first falsy leaf (useful for debugging which claim failed); an `or`
   returns the first truthy leaf; `threshold(n, of)` requires at least `n`
   truthy members.

Leaves whose `revealed` set does not intersect the schema are still valid for
boolean composition — the holder chooses what to disclose to the relying party,
but the graph itself only needs to know *that* the claim is true.

## Worked, copy-pasteable example

```ts
import { resolve, exampleGraph } from "./src/resolver";

const result = resolve(exampleGraph);

if (result.ok) {
  console.log("claim holds:", result.value);          // true / the matched leaf
  console.log("verified leaves:", result.verifiedLeafIds);
} else {
  console.log("failed at:", result.failedNodeId);
  console.log("reason:", result.reason);               // e.g. "signature mismatch on issuer did:key:z6Mk…"
}
```

The `exampleGraph` bundled with the resolver encodes:

> "User is (over 18) AND (resident of country X OR holds a passport credential)

> AND at least 2 of [has-email, has-phone, has-backup-factor]."

It uses three different issuers and four separate Merkle roots, so it

exercises the multi-issuer path end to end.

## When to use this pattern

- You need to answer a composite question from several independent attestations.
- Issuers should not have to coordinate or sign a shared root.
- Holders should be able to prove the composite without re-revealing every
  underlying field.

## When NOT to use it

- You only need a single leaf claim — use the Merkle proof pattern directly.
- The composition requires zero-knowledge arithmetic across fields (e.g.
  "income > rent * 12"). Reach for a zk-circuit, not a claim graph.

## Files

- `src/resolver.ts` — the resolver and the `exampleGraph` fixture.
- `../selective-disclosure-merkle-proof/src/merkle-selector.ts` — produces
  the `MerkleProof` objects this resolver consumes.

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
