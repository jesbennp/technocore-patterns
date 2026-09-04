// Smoke tests for cycle-detector.ts
// Run with: node --experimental-vm-modules --test patterns/claim-graph-resolver/src/cycle-detector.test.ts
// or: npx tsx patterns/claim-graph-resolver/src/cycle-detector.test.ts
//
// The cycle detector operates on a graph of subject -> claim hashes and
// claim hash -> attestation references. We model it as a generic directed
// graph: nodes are strings, edges are (from, to) pairs. A cycle exists if
// any strongly-connected component has size > 1 or contains a self-loop.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findCycles, hasCycle, type Graph } from "./cycle-detector.js";

function makeGraph(edges: Array<[string, string]>): Graph {
  const g: Graph = new Map();
  const add = (u: string, v: string) => {
    if (!g.has(u)) g.set(u, new Set());
    g.get(u)!.add(v);
  };
  for (const [u, v] of edges) add(u, v);
  return g;
}

test("empty graph has no cycle", () => {
  const g = makeGraph([]);
  assert.equal(hasCycle(g), false);
  assert.deepEqual(findCycles(g), []);
});

test("self-loop is a cycle", () => {
  const g = makeGraph([["A", "A"]]);
  assert.equal(hasCycle(g), true);
  const cycles = findCycles(g);
  assert.ok(cycles.some((c) => c.includes("A")));
});

test("linear chain has no cycle", () => {
  const g = makeGraph([
    ["A", "B"],
    ["B", "C"],
    ["C", "D"],
  ]);
  assert.equal(hasCycle(g), false);
  assert.deepEqual(findCycles(g), []);
});

test("simple 3-cycle A->B->C->A", () => {
  const g = makeGraph([
    ["A", "B"],
    ["B", "C"],
    ["C", "A"],
  ]);
  assert.equal(hasCycle(g), true);
  const cycles = findCycles(g);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].length, 3);
  assert.ok(cycles[0].includes("A"));
  assert.ok(cycles[0].includes("B"));
  assert.ok(cycles[0].includes("C"));
});

test("diamond DAG has no cycle", () => {
  const g = makeGraph([
    ["root", "left"],
    ["root", "right"],
    ["left", "merge"],
    ["right", "merge"],
  ]);
  assert.equal(hasCycle(g), false);
});

test("cycle nested in DAG is detected", () => {
  const g = makeGraph([
    ["root", "A"],
    ["A", "B"],
    ["B", "A"], // cycle between A and B
    ["A", "leaf"],
  ]);
  assert.equal(hasCycle(g), true);
  const cycles = findCycles(g);
  assert.ok(cycles.some((c) => c.includes("A") && c.includes("B")));
});

test("disconnected components: one cyclic, one acyclic", () => {
  const g = makeGraph([
    ["X", "Y"],
    ["Y", "X"],
    ["safe", "ok"],
  ]);
  assert.equal(hasCycle(g), true);
  const cycles = findCycles(g);
  assert.ok(cycles.every((c) => !(c.includes("safe") || c.includes("ok"))));
});

test("duplicate edges do not produce duplicate cycles", () => {
  const g = makeGraph([
    ["A", "B"],
    ["B", "C"],
    ["C", "A"],
    ["A", "B"], // duplicate
  ]);
  assert.equal(hasCycle(g), true);
  const cycles = findCycles(g);
  assert.equal(cycles.length, 1, `got ${cycles.length} cycles`);
});

test("performance: 1000-node chain stays fast", () => {
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < 999; i++) edges.push([`n${i}`, `n${i + 1}`]);
  const g = makeGraph(edges);
  const t0 = Date.now();
  assert.equal(hasCycle(g), false);
  assert.ok(Date.now() - t0 < 200, "cycle detection too slow on linear chain");
});

test("performance: cycle in 1000-node mostly-linear graph", () => {
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < 998; i++) edges.push([`n${i}`, `n${i + 1}`]);
  edges.push(["n998", "n500"]); // one back-edge creates a cycle
  const g = makeGraph(edges);
  assert.equal(hasCycle(g), true);
});

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
