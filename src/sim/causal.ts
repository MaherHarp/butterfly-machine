import { N_NEURONS } from './constants';
import type { Mind } from './mind';
import { networkFor, type Network } from './network';

/**
 * PINK LINEAGE
 * ============
 *
 * Which units of the altered mind are doing something the control mind is
 * not, and how did that difference reach them? Computed by running the two
 * minds in lockstep and comparing them after every step, in full precision.
 *
 * Because every unit's noise is the same in both minds (step.ts), a unit's
 * state can only differ from its twin's if some input to it differed. And a
 * unit's only output is its spikes. So the difference spreads exactly along
 * spikes that happened differently — a *mismatch*: a spike fired in one mind
 * and not at that moment in the other.
 *
 *   root          the unit an intervention touched (generation 0)
 *   different     the unit's state (potential or currents) differs right now
 *   mismatch      the unit fired in one mind but not the other at this step
 *   generation    for a unit's first mismatch: 1 + the smallest generation
 *                 among its presynaptic units whose own mismatch happened
 *                 early enough to have arrived (synaptic delay included)
 *
 * Pink on screen is these quantities and nothing else:
 *   a recent mismatch flashes at a brightness set by its generation
 *   (root hot pink → first-order bright pink → later paler), units that have
 *   mismatched and still differ keep a pink haze, and units that differ only
 *   below threshold carry a faint one.
 */

export const GEN_NONE = -1;
const HEAT_DECAY = 0.965;

export function generationWeight(gen: number): number {
  if (gen < 0) return 0;
  return Math.max(0.32, 1 - 0.13 * gen);
}

const FIELDS = 5; // firstDiff, firstMismatch, gen, lastMismatch, cause
const HEADER = 8;

export class CausalTrace {
  readonly buffer: ArrayBuffer;
  /** Step at which the unit's state first differed (−1 never). */
  readonly firstDiff: Int32Array;
  /** Step of the unit's first spike mismatch (−1 never). */
  readonly firstMismatch: Int32Array;
  readonly gen: Int32Array;
  readonly lastMismatch: Int32Array;
  /** The presynaptic unit whose changed spike is traced as the cause of this unit's first change (−1 none). */
  readonly cause: Int32Array;
  /** Pink flash, decaying (0 … 1). */
  readonly heat: Float32Array;
  /** 1 if the unit differs right now. */
  readonly differs: Uint8Array;
  private readonly head: Float64Array;

  constructor(buffer?: ArrayBuffer) {
    const n = N_NEURONS;
    const bytes = HEADER * 8 + n * 4 * FIELDS + n * 4 + n;
    this.buffer = buffer ?? new ArrayBuffer(Math.ceil(bytes / 8) * 8);
    this.head = new Float64Array(this.buffer, 0, HEADER);
    let o = HEADER * 8;
    this.firstDiff = new Int32Array(this.buffer, o, n);
    o += n * 4;
    this.firstMismatch = new Int32Array(this.buffer, o, n);
    o += n * 4;
    this.gen = new Int32Array(this.buffer, o, n);
    o += n * 4;
    this.lastMismatch = new Int32Array(this.buffer, o, n);
    o += n * 4;
    this.cause = new Int32Array(this.buffer, o, n);
    o += n * 4;
    this.heat = new Float32Array(this.buffer, o, n);
    o += n * 4;
    this.differs = new Uint8Array(this.buffer, o, n);
    if (!buffer) {
      this.firstDiff.fill(-1);
      this.firstMismatch.fill(-1);
      this.gen.fill(GEN_NONE);
      this.lastMismatch.fill(-1);
      this.cause.fill(-1);
    }
  }

  /** Units whose behaviour has ever changed (had a spike mismatch). */
  get mismatched(): number { return this.head[0]; }
  private set mismatched(v: number) { this.head[0] = v; }
  /** Units differing in any way right now. */
  get differing(): number { return this.head[1]; }
  private set differing(v: number) { this.head[1] = v; }
  get maxGen(): number { return this.head[2]; }
  private set maxGen(v: number) { this.head[2] = v; }
  /** Step of the first mismatch anywhere (−1 none). */
  get firstAny(): number { return this.head[3] === 0 ? -1 : this.head[3] - 1; }
  private set firstAny(v: number) { this.head[3] = v + 1; }
  /** Mismatched spikes at the latest step. */
  get mismatchesNow(): number { return this.head[4]; }
  private set mismatchesNow(v: number) { this.head[4] = v; }

  snapshot(): ArrayBuffer {
    return this.buffer.slice(0);
  }

  /** Marks the unit an intervention touched as a root of the lineage. */
  markRoot(neuron: number, step: number): void {
    if (neuron < 0 || neuron >= N_NEURONS) return;
    this.gen[neuron] = 0;
    if (this.firstDiff[neuron] < 0) this.firstDiff[neuron] = step;
  }

  /**
   * Compares the two minds after both have completed the same step `t`
   * (their `step` counters now read t + 1).
   */
  update(a: Mind, b: Mind, net: Network = networkFor(a.seed)): void {
    const t = a.step - 1;
    const n = N_NEURONS;
    const { firstDiff, firstMismatch, gen, lastMismatch, heat, differs, cause } = this;
    const { inStart, inSource, inDelay } = net;
    let differing = 0;
    let mismatchesNow = 0;
    let mismatched = this.mismatched;
    let maxGen = this.maxGen;
    const av = a.v, bv = b.v, aie = a.ie, bie = b.ie, ais = a.is, bis = b.is, aii = a.ii, bii = b.ii;
    const al = a.lastSpike, bl = b.lastSpike;
    const ah = a.holdUntil, bh = b.holdUntil;
    for (let i = 0; i < n; i++) {
      const d = av[i] !== bv[i] || aie[i] !== bie[i] || ais[i] !== bis[i] || aii[i] !== bii[i] || ah[i] !== bh[i];
      heat[i] *= HEAT_DECAY;
      const firedA = al[i] === t;
      const firedB = bl[i] === t;
      if (firedA !== firedB) {
        mismatchesNow++;
        lastMismatch[i] = t;
        if (firstMismatch[i] < 0) {
          firstMismatch[i] = t;
          mismatched++;
          if (this.firstAny < 0) this.firstAny = t;
          if (gen[i] !== 0) {
            // Trace the cause back along real synapses.
            let g = 1 << 30;
            let by = -1;
            for (let k = inStart[i]; k < inStart[i + 1]; k++) {
              const j = inSource[k];
              const gj = gen[j];
              if (gj < 0) continue;
              const fm = firstMismatch[j];
              if (fm >= 0 && fm + inDelay[k] <= t && gj + 1 < g) {
                g = gj + 1;
                by = j;
              }
            }
            if (g === 1 << 30) {
              // Only reachable through a root that has not mismatched yet (e.g. a changed synapse).
              for (let k = inStart[i]; k < inStart[i + 1]; k++) {
                if (gen[inSource[k]] === 0) {
                  g = 1;
                  by = inSource[k];
                }
              }
            }
            cause[i] = by;
            gen[i] = g === 1 << 30 ? maxGen + 1 : g;
          }
          if (gen[i] > maxGen) maxGen = gen[i];
        }
        const w = generationWeight(gen[i]);
        if (heat[i] < w) heat[i] = w;
      }
      if (d || firedA !== firedB) {
        differing++;
        differs[i] = 1;
        if (firstDiff[i] < 0) firstDiff[i] = t;
      } else differs[i] = 0;
    }
    this.differing = differing;
    this.mismatchesNow = mismatchesNow;
    this.mismatched = mismatched;
    this.maxGen = maxGen;
  }

  /** Pink intensity of unit i for display (0 … 1). */
  pink(i: number): number {
    const h = this.heat[i];
    let haze = 0;
    if (this.differs[i]) haze = this.firstMismatch[i] >= 0 ? 0.24 * generationWeight(this.gen[i]) + 0.06 : 0.07;
    return h > haze ? h : haze;
  }
}
