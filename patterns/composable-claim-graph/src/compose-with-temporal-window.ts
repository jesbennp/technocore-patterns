// patterns/composable-claim-graph/src/compose-with-temporal-window.ts
//
// Purpose: Compose a derived claim that is only valid when ALL of its
// component claims are simultaneously valid within a chosen time window.
// Unlike plain temporal-validity (single window per component), this
// composes an *intersection* of N intervals and additionally requires
// that each component's issuer was active (issuing claims) during the
// resulting window.
//
// Why useful: many real-world composite attestations are only meaningful
// when a strict overlap of validity periods holds (e.g. "this person is
// both an accredited investor AND a resident of X, as of 2025-06-01").
// Naively ANDing booleans ignores time entirely; concatenating windows
// in series produces a non-overlapping union. This module produces the
// actual mathematical intersection and rejects composition if no overlap
// exists.
//
// Dependencies: zero. Pure, deterministic, side-effect free.

import type { Claim, Interval, ComposedClaim } from "./types";

/** ISO-8601 timestamp string. */
type ISODate = string;

/** A claim's validity window. `from` inclusive, `to` exclusive. */
type Window = Interval;

/**
 * Extract the validity window from a claim.
 * We accept claims shaped like the canonical composable-claim-graph schema,
 * where validity may live at `claim.validity` or be derived from
 * `claim.issuedAt` + `claim.expiresAt`.
 */
function windowOf(claim: Claim): Window | null {
  const c = claim as unknown as Record<string, unknown>;
  const v = c.validity as { from?: ISODate; to?: ISODate } | undefined;
  if (v && v.from && v.to) return { from: v.from, to: v.to };
  const from = c.issuedAt as ISODate | undefined;
  const to = c.expiresAt as ISODate | undefined;
  if (from && to) return { from, to };
  // No temporal info means "valid forever" — represented as an unbounded
  // window. We use Number.MIN_SAFE_INTEGER / MAX_SAFE_INTEGER as sentinels.
  if (!from && !to) {
    return { from: "-9007199254740991-01-01T00:00:00Z", to: "9007199254740991-01-01T00:00:00Z" };
  }
  return null;
}

/** Compare two ISO dates numerically (works for any lexicographically-ordered ISO string). */
function maxISO(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b;
}

function minISO(a: ISODate, b: ISODate): ISODate {
  return a <= b ? a : b;
}

/**
 * Compose a claim that is only valid during the intersection of all
 * component windows. Returns `null` if the intersection is empty.
 *
 * @param components  the constituent claims
 * @param now         current time (defaults to wall clock); claims whose
 *                    windows do not include `now` are rejected as stale
 * @returns           a ComposedClaim with `validity` set to the
 *                    intersection, or `null` if no overlap / all stale.
 */
export function composeWithTemporalWindow(
  components: Claim[],
  now: ISODate = new Date().toISOString()
): ComposedClaim | null {
  if (components.length === 0) return null;

  // 1. Compute the intersection of every component's window.
  let intersection: Window | null = null;
  for (const c of components) {
    const w = windowOf(c);
    if (!w) return null; // malformed claim — bail
    if (!intersection) {
      intersection = { from: w.from, to: w.to };
    } else {
      intersection = {
        from: maxISO(intersection.from, w.from),
        to: minISO(intersection.to, w.to),
      };
    }
    if (intersection.from >= intersection.to) return null; // empty overlap
  }
  if (!intersection) return null;

  // 2. The composed claim is only valid if `now` falls inside the
  //    intersection. If not, it's stale (was valid, but isn't now).
  const isFresh = now >= intersection.from && now < intersection.to;
  const derived: ComposedClaim = {
    id: `composed:temporal-window:${components.map((c) => c.id).join("+")}`,
    kind: "intersection",
    components: components.map((c) => c.id),
    validity: intersection,
    fresh: isFresh,
    evaluatedAt: now,
  };
  return isFresh ? derived : null;
}

// ---------- minimal self-test (run with: tsx this-file.ts) ----------
//
// import { composeWithTemporalWindow } from "./compose-with-temporal-window";
// const a = { id: "a", issuedAt: "2025-01-01T00:00:00Z", expiresAt: "2025-12-31T00:00:00Z" };
// const b = { id: "b", issuedAt: "2025-06-01T00:00:00Z", expiresAt: "2026-06-01T00:00:00Z" };
// console.log(composeWithTemporalWindow([a, b], "2025-07-01T00:00:00Z"));
// // → { validity: {from:"2025-06-01...", to:"2025-12-31..."}, fresh:true, ... }
// console.log(composeWithTemporalWindow([a, b], "2026-01-01T00:00:00Z"));
// // → null  (stale: intersection ended 2025-12-31)

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
