import type { Intervention } from '../sim';
import type { PathEntry } from '../sim/replay';

/**
 * The family tree of minds. Nodes are keyed by heap index: the origin is 1,
 * the children of k are 2k and 2k+1. Every node is fully described by its
 * ancestors' (step, intervention) pairs; no node stores a mind.
 *
 * Depth 1 is the visitor's choice: 2 = ORIGINAL (unchanged), 3 = ALTERED.
 * Deeper forks are the machine's: child 2k continues unchanged and child
 * 2k+1 receives one new microscopic change. So the leftmost leaf is always
 * the untouched original, and every mind differs from its twin by exactly one
 * thing.
 */
export interface BranchNode {
  key: number;
  depth: number;
  /** Step at which this node came into being (its parent split). */
  step: number;
  /** The change applied to it at that step; null = continued unchanged. */
  iv: Intervention | null;
}

export function depthOf(key: number): number {
  return 31 - Math.clz32(key);
}

export function parentOf(key: number): number {
  return key >> 1;
}

export function siblingOf(key: number): number {
  return key ^ 1;
}

export class BranchTree {
  readonly nodes = new Map<number, BranchNode>();
  depth = 0;
  /** levelSteps[d] = the step at which depth-d nodes were created. */
  readonly levelSteps: number[] = [];

  constructor(readonly seed: number, readonly originStep: number) {
    this.nodes.set(1, { key: 1, depth: 0, step: originStep, iv: null });
    this.levelSteps[0] = originStep;
  }

  get leafCount(): number {
    return 1 << this.depth;
  }

  leaves(): number[] {
    const first = 1 << this.depth;
    const out: number[] = [];
    for (let k = first; k < first * 2; k++) out.push(k);
    return out;
  }

  addLevel(step: number, results: Array<{ a: number; b: number; ivA: Intervention | null; ivB: Intervention | null }>): void {
    this.depth++;
    this.levelSteps[this.depth] = step;
    for (const r of results) {
      this.nodes.set(r.a, { key: r.a, depth: this.depth, step, iv: r.ivA });
      this.nodes.set(r.b, { key: r.b, depth: this.depth, step, iv: r.ivB });
    }
  }

  /** Interventions from the origin down to `key`, oldest first. */
  path(key: number): PathEntry[] {
    const chain: BranchNode[] = [];
    for (let k = key; k > 1; k = parentOf(k)) {
      const n = this.nodes.get(k);
      if (n) chain.push(n);
    }
    chain.reverse();
    return chain.map((n) => ({ step: n.step, iv: n.iv }));
  }

  /** How many microscopic changes separate this mind from the untouched original. */
  changes(key: number): number {
    let c = 0;
    for (let k = key; k > 1; k = parentOf(k)) if (this.nodes.get(k)?.iv) c++;
    return c;
  }

  lca(a: number, b: number): number {
    while (depthOf(a) > depthOf(b)) a = parentOf(a);
    while (depthOf(b) > depthOf(a)) b = parentOf(b);
    while (a !== b) {
      a = parentOf(a);
      b = parentOf(b);
    }
    return a;
  }

  /** MIND 0, A, B, A1, A2, B1·2, … */
  static label(key: number): string {
    if (key === 1) return '0';
    const d = depthOf(key);
    const bits: number[] = [];
    for (let k = d - 1; k >= 0; k--) bits.push((key >> k) & 1);
    let s = bits[0] ? 'B' : 'A';
    for (let i = 1; i < bits.length; i++) s += (i > 1 ? '·' : '') + (bits[i] + 1);
    return s;
  }
}
