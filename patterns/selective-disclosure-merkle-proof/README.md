# Selective Disclosure via Merkle Proofs

A composable pattern for revealing only the fields a verifier asks for, anchored to a single signed Merkle root. Useful when a holder has a credential bundle (KYC claims, profile claims, capability claims) and a verifier wants proof of specific facts without learning the rest.

## Why this pattern

- One signature covers many claims; the holder discloses a subset on demand.
- The verifier checks Merkle inclusion against a published root — no issuer round-trip.
- Composes with the `claim-graph-resolver` pattern: disclosed leaves become claim nodes that the resolver can traverse.

## Flow

1. Issuer builds a canonical JSON document of claims, sorts keys, computes `root = sha256(sha256(claim) || sha256(claim) ...)`. Signs `root`.
2. Holder stores `(root, signature, claims[])`. Optionally registers root with an anchor service.
3. Verifier requests specific claim paths, e.g. `["address.country", "age.over_18"]`.
4. Holder returns `{ leaf, proof, signature, root }` for each requested path. Nothing else.
5. Verifier recomputes root from `(leaf, proof)` and checks `signature` over root.

## Worked example (TypeScript)

See `src/merkle-selector.ts` for a self-contained implementation. The core function:

```ts
import { createMerkleSelector } from "./merkle-selector";

const claims = {
  "name": "Ada Lovelace",
  "address": { "country": "UK", "city": "London" },
  "age": { "over_18": true, "dob_year": 1815 }
};

const selector = createMerkleSelector();
const { root, signature } = await selector.issue(claims, issuerKeyPair);

// Later, a verifier asks for only two fields
const disclosure = await selector.disclose(claims, ["address.country", "age.over_18"]);

// Verifier checks
const ok = await selector.verify(disclosure, root, signature, issuerPubKey);
// ok === true; "name", "city", "dob_year" were never sent.
```

## Composition with claim-graph-resolver

Disclosed leaves can be re-keyed into a `ClaimGraph` node. Each leaf hash becomes a node, the Merkle root becomes the graph root, and the disclosed-vs-undisclosed mask drives policy evaluation in `policy-evaluator.ts`.

## Wire format

```json
{
  "root": "<hex>",
  "signature": "<hex>",
  "leaves": [
    { "path": "address.country", "value": "UK", "proof": ["<hex>", "<hex>", ...] }
  ]
}
```

Proofs are sibling-hash arrays from leaf to root, bottom-up. The verifier sorts siblings by index parity before concatenation.

## Security notes

- Always canonicalize JSON before hashing (sorted keys, no whitespace, UTF-8 NFC).
- Domain-separate leaf hashes: `H(0x00 || path || value)`, internal: `H(0x01 || left || right)`.
- Bind the signature to a context string: `sig = sign(root || context || schema_id)`.
- Replay protection: include a verifier-supplied nonce in `context`.

## When not to use

- If the verifier needs to link disclosures across sessions, add an unlinkable pseudonym layer (out of scope here).
- For revocation, anchor root + serial in a revocation registry; this pattern does not handle it.

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
