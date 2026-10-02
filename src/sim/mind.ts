import { EVENT_RING, MAX_WEIGHT_OVERRIDES, N_ASSEMBLIES, N_NEURONS, RING } from './constants';

/**
 * A mind's dynamic state is a struct-of-arrays laid out in ONE ArrayBuffer.
 * A snapshot is a single `buffer.slice()`, a branch is a copy of that
 * buffer, and shipping a mind to another worker is a zero-copy transfer.
 * The wiring is not here: it is shared, immutable, and rebuilt from the seed
 * (network.ts).
 *
 *   v         membrane potential (threshold 1, reset 0)
 *   ie / is   fast and slow excitatory synaptic current
 *   ii        inhibitory synaptic current
 *   trace     exponentially filtered spike train (τ = 50 ms), the unit's "activation"
 *   rate      smoothed population rate of each assembly (Hz), then inhibitory, then sensory
 *   ringE/I   delay lines: input that will arrive 1 … MAX_DELAY ms from now
 *   lastSpike step of the unit's most recent spike
 *   hold      pending postponement (ms) of the unit's next spike
 *   holdUntil step at which a postponed spike will be released (−1 = none)
 *   refr      refractory steps remaining
 */

type Ctor = Float64ArrayConstructor | Float32ArrayConstructor | Int32ArrayConstructor | Uint8ArrayConstructor;

export const N_RATES = N_ASSEMBLIES + 2;

const LAYOUT = [
  ['v', Float64Array, N_NEURONS],
  ['ie', Float64Array, N_NEURONS],
  ['is', Float64Array, N_NEURONS],
  ['ii', Float64Array, N_NEURONS],
  ['trace', Float64Array, N_NEURONS],
  ['rate', Float64Array, N_RATES],
  ['sc', Float64Array, 16],
  ['ovDw', Float64Array, MAX_WEIGHT_OVERRIDES],
  ['ringE', Float32Array, RING * N_NEURONS],
  ['ringI', Float32Array, RING * N_NEURONS],
  ['lastSpike', Int32Array, N_NEURONS],
  ['hold', Int32Array, N_NEURONS],
  ['holdUntil', Int32Array, N_NEURONS],
  ['ovSyn', Int32Array, MAX_WEIGHT_OVERRIDES],
  ['evType', Int32Array, EVENT_RING],
  ['evStep', Int32Array, EVENT_RING],
  ['evA', Int32Array, EVENT_RING],
  ['refr', Uint8Array, N_NEURONS],
] as const satisfies ReadonlyArray<readonly [string, Ctor, number]>;

type LayoutEntry = (typeof LAYOUT)[number];
type FieldName = LayoutEntry[0];
type ArrayOf<C> = C extends Float64ArrayConstructor
  ? Float64Array
  : C extends Float32ArrayConstructor
    ? Float32Array
    : C extends Int32ArrayConstructor
      ? Int32Array
      : Uint8Array;
type StateArrays = { [E in LayoutEntry as E[0]]: ArrayOf<E[1]> };

const OFFSETS: Record<string, number> = {};
let STATE_BYTES = 0;
for (const [name, ctor, len] of LAYOUT) {
  const align = ctor.BYTES_PER_ELEMENT;
  STATE_BYTES = Math.ceil(STATE_BYTES / align) * align;
  OFFSETS[name] = STATE_BYTES;
  STATE_BYTES += len * align;
}
STATE_BYTES = Math.ceil(STATE_BYTES / 8) * 8;
export { STATE_BYTES };

// Scalar slots in `sc`.
const S_STEP = 0;
const S_SEED = 1;
const S_SPIKES = 2;
const S_EV_HEAD = 3;
const S_EV_TOTAL = 4;
const S_OV_COUNT = 5;
const S_SETTLED = 6;
const S_SETTLED_AT = 7;
const S_LAST_SPIKES = 8;
const S_PERTURBED = 9;

export interface Mind extends StateArrays {}

export class Mind {
  readonly buffer: ArrayBuffer;
  /** Scratch: units that fired this step (not state). */
  readonly fired = new Int32Array(N_NEURONS);
  firedCount = 0;

  constructor(buffer?: ArrayBuffer) {
    if (buffer && buffer.byteLength !== STATE_BYTES) {
      throw new Error(`Mind snapshot has ${buffer.byteLength} bytes, expected ${STATE_BYTES}`);
    }
    this.buffer = buffer ?? new ArrayBuffer(STATE_BYTES);
    const self = this as unknown as Record<FieldName, unknown>;
    for (const [name, ctor, len] of LAYOUT) {
      self[name] = new ctor(this.buffer, OFFSETS[name], len);
    }
  }

  get step(): number { return this.sc[S_STEP]; }
  set step(v: number) { this.sc[S_STEP] = v; }
  get seed(): number { return this.sc[S_SEED]; }
  set seed(v: number) { this.sc[S_SEED] = v; }
  /** Total spikes ever fired. */
  get spikes(): number { return this.sc[S_SPIKES]; }
  set spikes(v: number) { this.sc[S_SPIKES] = v; }
  get evHead(): number { return this.sc[S_EV_HEAD]; }
  set evHead(v: number) { this.sc[S_EV_HEAD] = v; }
  /** Total events ever pushed to the ring; lets readers detect what is new. */
  get evTotal(): number { return this.sc[S_EV_TOTAL]; }
  set evTotal(v: number) { this.sc[S_EV_TOTAL] = v; }
  get ovCount(): number { return this.sc[S_OV_COUNT]; }
  set ovCount(v: number) { this.sc[S_OV_COUNT] = v; }
  /** Attractor the mind currently rests in (−1 = none). Updated by the step function. */
  get settled(): number { return this.sc[S_SETTLED]; }
  set settled(v: number) { this.sc[S_SETTLED] = v; }
  get settledAt(): number { return this.sc[S_SETTLED_AT]; }
  set settledAt(v: number) { this.sc[S_SETTLED_AT] = v; }
  /** Spikes fired in the most recent step. */
  get lastSpikes(): number { return this.sc[S_LAST_SPIKES]; }
  set lastSpikes(v: number) { this.sc[S_LAST_SPIKES] = v; }
  /** How many interventions this mind has received. */
  get perturbed(): number { return this.sc[S_PERTURBED]; }
  set perturbed(v: number) { this.sc[S_PERTURBED] = v; }

  snapshot(): ArrayBuffer {
    return this.buffer.slice(0);
  }

  clone(): Mind {
    return new Mind(this.snapshot());
  }
}
