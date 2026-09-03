# Policy Resolver Walkthrough

A worked example showing how `claim-graph-resolver` evaluates a graph of
composable claims under a stated policy, detects cycles, and returns a
signed receipt.

## The graph

```
         ┌────────────┐
         │  id:basic  │  self-issued, did:example:alice
         └─────┬──────┘
               │ relies_on
               ▼
        ┌────────────┐
        │ id:address │  issued by did:example:registry
        └─────┬──────┘
              │ relies_on
              ▼
        ┌────────────┐
        │ id:employ  │  issued by did:example:acme
        └────────────┘
```

## Claim documents

### `id:basic` (issuer = subject)
```json
{
  "id": "urn:claim:id:basic",
  "type": "IdentityAssertion",
  "issuer": "did:example:alice",
  "subject": "did:example:alice",
  "issuedAt": "2026-01-15T10:00:00Z",
  "statement": "I am a real human."
}
```

### `id:address`
```json
{
  "id": "urn:claim:id:address",
  "type": "IdentityAssertion",
  "issuer": "did:example:registry",
  "subject": "did:example:alice",
  "issuedAt": "2026-01-10T09:00:00Z",
  "reliesOn": ["urn:claim:id:basic"],
  "statement": "Subject's address is on file."
}
```

### `id:employ`
```json
{
  "id": "urn:claim:id:employ",
  "type": "IdentityAssertion",
  "issuer": "did:example:acme",
  "subject": "did:example:alice",
  "issuedAt": "2026-01-12T11:30:00Z",
  "reliesOn": ["urn:claim:id:address"],
  "statement": "Subject is employed by Acme."
}
```

## Policy

```ts
const policy: Policy = {
  id: "loan-v1",
  trustAnchors: ["did:example:registry", "did:example:acme"],
  minDepth: 2,                  // require at least one relying claim
  maxDepth: 5,
  rejectSelfIssuedRoot: true,   // the graph root must be issued by someone else
  freshnessDays: 30,            // claims must be younger than 30 days
  requireDistinctIssuers: 2,    // at least two distinct issuers in the chain
};
```

## Resolution

```ts
import { resolve } from "claim-graph-resolver";

const result = await resolve({
  root: "urn:claim:id:employ",
  claims: [basicClaim, addressClaim, employClaim],
  policy,
  now: new Date("2026-01-20T00:00:00Z"),
});
```

### Expected `result`

```json
{
  "ok": true,
  "root": "urn:claim:id:employ",
  "order": [
    "urn:claim:id:basic",
    "urn:claim:id:address",
    "urn:claim:id:employ"
  ],
  "checks": {
    "anchorsOk": true,
    "depthOk": true,
    "freshnessOk": true,
    "distinctIssuersOk": true,
    "cycleFree": true
  },
  "receipt": {
    "type": "GraphResolutionReceipt",
    "root": "urn:claim:id:employ",
    "order": ["urn:claim:id:basic", "urn:claim:id:address", "urn:claim:id:employ"],
    "policy": "loan-v1",
    "evaluatedAt": "2026-01-20T00:00:00Z",
    "digest": "sha256:8c2f..."
  }
}
```

## Failure modes

1. **Cycle detected** — `id:basic` is added to `reliesOn` of `id:employ`.
   `cycle-detector.ts` walks the edges, finds the back-edge, and returns
   `{ ok: false, reason: "cycle", cycle: [...] }`.
2. **Self-issued root** — replace the registry issuer on `id:basic` with
   `did:example:alice` and `rejectSelfIssuedRoot` flips `checks.anchorsOk`
   to false.
3. **Stale claim** — set `id:employ.issuedAt` to a date older than
   `freshnessDays`; the resolver reports `freshnessOk: false` and `ok: false`.
4. **Too few issuers** — with only `did:example:registry` in
   `trustAnchors`, `distinctIssuersOk` becomes false.

## Composing with selective disclosure

The `order` array is the input to the selective-disclosure pattern: each
entry is a merkle leaf that can be selectively revealed. A verifier who
only cares about employment can be given a proof containing just
`urn:claim:id:employ` plus the proofs for its prerequisites, without
showing the address claim body.

## Why this matters

Two things make the resolver composable:

* The policy is data, not code, so callers can publish, share, and
  version it.
* The result is a self-contained receipt that other patterns
  (`receipt-aggregator`, `selective-disclosure-merkle-proof`) can consume
  without re-running resolution.

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
