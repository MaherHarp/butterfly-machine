import { FIELD_N, MAX_AGENTS } from './constants';
import { FIELD_MASK, type World } from './world';

/**
 * DIVERGENCE METRIC
 * =================
 *
 * How different are two futures of the same world? Organisms carry ids that
 * are shared by every world descended from the same origin (a child's id is a
 * hash of its parent's id and the step it was born), so we can ask, organism
 * by organism, "where is this one in the other world?".
 *
 *   For every id in either world:
 *     present in both  →  c = min(1, distance / D0)      (D0 = 36 units)
 *     present in one   →  c = 1                          (born or died only there)
 *   agentTerm = mean of c over the union of ids
 *
 *   fieldTerm = min(1, Σ|fA − fB| / (κ · Σ (fA + fB)/2))   over cells inside the disk,
 *               κ = 0.3, i.e. saturates when the landscapes differ by 30 % of their mean.
 *
 *   divergence = 0.85 · agentTerm + 0.15 · fieldTerm        ∈ [0, 1]
 *
 * Read as: the share of the world that is no longer where it would have been.
 * Identical worlds score exactly 0. Two unrelated worlds score ≈ 1. Moving one
 * organism of ~200 by 0.7 units scores ≈ 0.0001.
 *
 * The per-organism c values are also what the renderer uses to draw the faint
 * halo of "touched by the change" — so the spreading halo and the number are
 * the same measurement.
 */
export const DIVERGENCE_D0 = 36;
export const DIVERGENCE_KAPPA = 0.3;
export const DIVERGENCE_AGENT_WEIGHT = 0.85;

/** Open-addressing id → index table; reused to avoid allocation per frame. */
export class IdIndex {
  private readonly keys: Uint32Array;
  private readonly vals: Int32Array;
  private readonly mask: number;

  constructor(capacity = MAX_AGENTS * 4) {
    let size = 1;
    while (size < capacity * 2) size <<= 1;
    this.keys = new Uint32Array(size);
    this.vals = new Int32Array(size);
    this.mask = size - 1;
  }

  build(ids: ArrayLike<number>, n: number): void {
    this.keys.fill(0);
    for (let i = 0; i < n; i++) {
      const k = ids[i];
      let h = Math.imul(k, 0x9e3779b1) >>> 0;
      for (;;) {
        const slot = h & this.mask;
        if (this.keys[slot] === 0) {
          this.keys[slot] = k;
          this.vals[slot] = i;
          break;
        }
        h++;
      }
    }
  }

  get(k: number): number {
    let h = Math.imul(k, 0x9e3779b1) >>> 0;
    for (;;) {
      const slot = h & this.mask;
      const v = this.keys[slot];
      if (v === k) return this.vals[slot];
      if (v === 0) return -1;
      h++;
    }
  }
}

export interface AgentSet {
  n: number;
  ids: ArrayLike<number>;
  /** Positions, read as pos[i * stride + offX], pos[i * stride + offX + 1]. */
  pos: ArrayLike<number>;
  stride: number;
  offX: number;
}

export interface DivergenceResult {
  score: number;
  agentTerm: number;
  fieldTerm: number;
}

const scratchIndex = new IdIndex();

/**
 * @param cA,cB optional outputs: per-organism c in [0,1] for halos.
 */
export function divergenceOf(
  a: AgentSet,
  b: AgentSet,
  fieldA: ArrayLike<number> | null,
  fieldB: ArrayLike<number> | null,
  fieldMask: ArrayLike<number> | null,
  cA?: Float32Array,
  cB?: Float32Array,
  index: IdIndex = scratchIndex,
): DivergenceResult {
  index.build(b.ids, b.n);
  let sum = 0;
  let matched = 0;
  if (cB) cB.fill(1, 0, b.n);
  const invD0 = 1 / DIVERGENCE_D0;
  for (let i = 0; i < a.n; i++) {
    const j = index.get(a.ids[i]);
    if (j < 0) {
      sum += 1;
      if (cA) cA[i] = 1;
      continue;
    }
    matched++;
    const ia = i * a.stride + a.offX;
    const ib = j * b.stride + b.offX;
    const dx = a.pos[ia] - b.pos[ib];
    const dy = a.pos[ia + 1] - b.pos[ib + 1];
    let c = Math.sqrt(dx * dx + dy * dy) * invD0;
    if (c > 1) c = 1;
    sum += c;
    if (cA) cA[i] = c;
    if (cB) cB[j] = c;
  }
  const unmatchedB = b.n - matched;
  sum += unmatchedB;
  const union = a.n + unmatchedB;
  const agentTerm = union > 0 ? sum / union : 0;

  let fieldTerm = 0;
  if (fieldA && fieldB) {
    let diff = 0;
    let mean = 0;
    const len = fieldA.length;
    for (let c = 0; c < len; c++) {
      if (fieldMask && !fieldMask[c]) continue;
      const fa = fieldA[c];
      const fb = fieldB[c];
      diff += fa > fb ? fa - fb : fb - fa;
      mean += (fa + fb) * 0.5;
    }
    fieldTerm = mean > 1e-9 ? Math.min(1, diff / (DIVERGENCE_KAPPA * mean)) : diff > 0 ? 1 : 0;
  }
  const w = fieldA && fieldB ? DIVERGENCE_AGENT_WEIGHT : 1;
  return { score: w * agentTerm + (1 - w) * fieldTerm, agentTerm, fieldTerm };
}

/** Convenience: divergence between two full world states. */
export function worldDivergence(a: World, b: World): DivergenceResult {
  return divergenceOf(
    { n: a.n, ids: a.id, pos: interleave(a), stride: 2, offX: 0 },
    { n: b.n, ids: b.id, pos: interleave(b), stride: 2, offX: 0 },
    a.res,
    b.res,
    FIELD_MASK,
  );
}

function interleave(w: World): Float64Array {
  const out = new Float64Array(w.n * 2);
  for (let i = 0; i < w.n; i++) {
    out[i * 2] = w.x[i];
    out[i * 2 + 1] = w.y[i];
  }
  return out;
}

export const FIELD_CELLS = FIELD_N * FIELD_N;
