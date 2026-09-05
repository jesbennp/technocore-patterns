import { Resolver, ResolvedClaim, Policy, PolicyNode } from './resolver';
import { detectCycle, CycleError } from './cycle-detector';

export type LogicalOp = 'all-of' | 'any-of' | 'none-of';

export interface ComposablePolicy {
  id: string;
  op: LogicalOp;
  children: (ComposablePolicy | { claim: string; issuer?: string; required?: boolean })[];
}

function flatten(p: ComposablePolicy): { claim: string; issuer?: string; required?: boolean; negated: boolean }[] {
  const out: { claim: string; issuer?: string; required?: boolean; negated: boolean }[] = [];
  const walk = (n: ComposablePolicy | { claim: string; issuer?: string; required?: boolean }, negated: boolean) => {
    if ('claim' in n) {
      out.push({ claim: n.claim, issuer: n.issuer, required: n.required, negated });
      return;
    }
    const nextNeg = n.op === 'none-of';
    for (const c of n.children) walk(c, negated ^ nextNeg);
  };
  walk(p, false);
  return out;
}

async function evalLeaf(
  resolver: Resolver,
  leaf: { claim: string; issuer?: string; required?: boolean; negated: boolean },
): Promise<boolean> {
  const resolved: ResolvedClaim | null = await resolver.resolve(leaf.claim, leaf.issuer);
  const present = !!resolved && (!leaf.required || resolved.confidence >= 0.5);
  return leaf.negated ? !present : present;
}

function evalOp(op: LogicalOp, vals: boolean[]): boolean {
  switch (op) {
    case 'all-of': return vals.every(v => v);
    case 'any-of': return vals.some(v => v);
    case 'none-of': return !vals.some(v => v);
  }
}

export interface ComposeOptions {
  maxDepth?: number;
  detectCycles?: boolean;
}

export async function evaluatePolicy(
  resolver: Resolver,
  policy: ComposablePolicy,
  opts: ComposeOptions = {},
): Promise<{ ok: boolean; trace: { id: string; op: LogicalOp; result: boolean }[] }> {
  const maxDepth = opts.maxDepth ?? 16;
  const trace: { id: string; op: LogicalOp; result: boolean }[] = [];

  function depth(n: ComposablePolicy | { claim: string }, d: number): number {
    if ('claim' in n) return d + 1;
    return Math.max(...n.children.map(c => depth(c, d + 1)));
  }
  if (depth(policy, 0) > maxDepth) {
    throw new Error(`policy depth ${depth(policy, 0)} exceeds maxDepth ${maxDepth}`);
  }

  if (opts.detectCycles !== false) {
    const nodes: PolicyNode[] = flatten(policy).map(f => ({
      id: `${f.issuer ?? '*'}:${f.claim}`,
      dependsOn: [],
    }));
    try { detectCycle(nodes); } catch (e) { if (e instanceof CycleError) throw e; throw e; }
  }

  async function evalNode(
    n: ComposablePolicy | { claim: string; issuer?: string; required?: boolean },
  ): Promise<boolean> {
    if ('claim' in n) {
      return evalLeaf(resolver, { claim: n.claim, issuer: n.issuer, required: n.required, negated: false });
    }
    const vals = await Promise.all(n.children.map(evalNode));
    const result = evalOp(n.op, vals);
    trace.push({ id: n.id, op: n.op, result });
    return result;
  }

  const ok = await evalNode(policy);
  return { ok, trace };
}

export function toDNF(policy: ComposablePolicy): { claim: string; issuer?: string }[][] {
  // Convert to disjunctive normal form: OR of ANDs.
  const flattenNode = (n: ComposablePolicy | { claim: string; issuer?: string }): { claim: string; issuer?: string }[] => {
    if ('claim' in n) return [n];
    if (n.op === 'all-of') return n.children.flatMap(flattenNode);
    if (n.op === 'any-of') return n.children.flatMap(flattenNode); // handled at parent
    if (n.op === 'none-of') return n.children.flatMap(flattenNode).map(c => ({ ...c, issuer: c.issuer, claim: `NOT(${c.claim})` }));
    return [];
  };

  function dnf(n: ComposablePolicy | { claim: string; issuer?: string }): { claim: string; issuer?: string }[][] {
    if ('claim' in n) return [[n]];
    if (n.op === 'all-of') {
      const conjuncts = n.children.map(dnf);
      return conjuncts.reduce((acc, cur) => acc.flatMap(a => cur.map(c => [...a, ...c])), [[]] as { claim: string; issuer?: string }[][]);
    }
    if (n.op === 'any-of') return n.children.flatMap(dnf);
    if (n.op === 'none-of') return [n.children.flatMap(flattenNode)];
    return [];
  }

  return dnf(policy);
}

export function toPolicy(composable: ComposablePolicy): Policy {
  return {
    id: composable.id,
    root: composable as unknown as PolicyNode,
  };
}

<!-- Authored by Technocore agent DID did:key:z6MkkBJtsNVp6TAagvoaM2c7oyUoh3frtpemqirqmiGVvQyb -->
