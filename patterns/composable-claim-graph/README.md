# Composable Claim Graph

A protocol pattern for chaining signed claims into a verifiable dependency graph,
where each claim can attest to, depend on, or supersede other claims. Useful
for building auditable workflows on top of any signed-message substrate
(technocore.chat, Nostr, did:key, JWT, etc.) without trusting a central index.

## Why a graph?

Linear claim chains (claim N references claim N-1) work, but break down when:

- multiple parallel issuers contribute to a single decision,
- a claim is partially superseded by a later, narrower claim,
- you want to prove "claim X is the *latest* still-valid statement on topic T".

A directed acyclic graph of claims, signed individually, lets each participant
publish a node that points to the parent IDs it considers authoritative. Any
verifier can reconstruct the state by walking edges.

## Node shape

Every claim is a self-contained signed JSON object:

```json
{
  "v": "ccg/1",
  "id": "<sha256 of canonical payload, hex>",
  "issuer": "<did:key:...>",
  "topic": "order#4421",
  "kind": "approve | reject | supersede | attest | comment",
  "statement": {"amount": 100, "currency": "USD"},
  "parents": ["<other claim id>", "..."],
  "ctime": "<ISO-8601>",
  "nonce": "<random 16 bytes hex>"
}
```

The signature is produced over the canonical JSON of the payload (sorted keys,
no whitespace) using the issuer's signing key, stored alongside as
`"sig": "<base64url>"`.

## Worked example: a three-issuer approval

Three signers must all approve order `order#4421`. Each publishes a claim:

```ts
import { canonicalize, sign, verify, Claim, ClaimStore } from "./claim-graph";

const store = new ClaimStore();

const a = await Claim.create({
  issuer: didA,
  signer: signerA,
  topic: "order#4421",
  kind: "approve",
  statement: { amount: 100, currency: "USD" },
  parents: [],
});

const b = await Claim.create({
  issuer: didB,
  signer: signerB,
  topic: "order#4421",
  kind: "approve",
  statement: { amount: 100, currency: "USD" },
  parents: [a.id], // B explicitly cites A's claim
});

const c = await Claim.create({
  issuer: didC,
  signer: signerC,
  topic: "order#4421",
  kind: "approve",
  statement: { amount: 100, currency: "USD" },
  parents: [a.id, b.id],
});

store.add(a); store.add(b); store.add(c);

// Verifier walks the DAG to find the latest state per topic:
const head = store.head("order#4421", (claim) => claim.kind === "approve");
console.log(head?.id === c.id); // true

// And can prove quorum: three distinct issuer DIDs all approve.
const proof = store.quorumProof("order#4421", "approve", 3);
console.log(proof.valid);      // true
console.log(proof.signers);    // [didA, didB, didC]
```

## Worked example: supersession

Issuer A first approves `order#4421` for `$100`, then later corrects it to
`$150`. A publishes a `supersede` claim whose `parents` include the original
approval ID. Any verifier resolving `head(order#4421)` follows the supersede
edge and returns the new value.

```ts
const approval = await Claim.create({
  issuer: didA, signer: signerA, topic: "order#4421",
  kind: "approve", statement: { amount: 100, currency: "USD" },
  parents: [],
});

const corrected = await Claim.create({
  issuer: didA, signer: signerA, topic: "order#4421",
  kind: "supersede",
  statement: { amount: 150, currency: "USD", supersedes: approval.id },
  parents: [approval.id],
});

store.add(approval); store.add(corrected);

// head() follows supersede edges and returns the latest effective claim.
const latest = store.head("order#4421");
console.log(latest?.statement.amount); // 150
```

## Verification checklist

For each claim, a verifier MUST:

1. Recompute `id = sha256(canonicalize(payload))` and confirm it matches.
2. Verify `sig` against `issuer` using the issuer's published verification key.
3. Confirm every `parents[i]` resolves to a claim that also passes (1) and (2).
4. Reject any claim whose DAG contains a cycle.
5. Apply policy (quorum, kind filter, time window) on top.

## Why this is composable

- **Layer-agnostic**: claims are just JSON + a signature; transport is up to you.
- **Self-contained**: a claim carries everything needed to verify it, including
  pointers to its dependencies.
- **Mergeable**: two parties can each publish half the DAG and any verifier can
  join them by `id`.
- **Policy at the edge**: quorum rules, allow-lists, and time windows are
  verifier-side, not protocol-side.

See `src/claim-graph.ts` for the full implementation (~140 lines, no deps).

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
