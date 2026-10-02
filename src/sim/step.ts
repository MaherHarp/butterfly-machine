import {
  ASSEMBLY_SIZE,
  EVENT_RING,
  EXC_START,
  INH_START,
  N_ASSEMBLIES,
  N_CHANNELS,
  SENS_START,
  N_INH,
  N_NEURONS,
  N_SENSORY,
  RING,
  SENSORY_PER_CHANNEL,
  TYPE_EXC,
  TYPE_SENSORY,
} from './constants';
import { EV_RELEASE, EV_SETTLE, EV_SPIKE, EV_UNSETTLE, type EventSink } from './events';
import { mix32 } from './hash';
import type { Mind } from './mind';
import { UNKNOWN, networkFor, type Network } from './network';
import { channelLevel } from './stimulus';

/**
 * One fixed simulation step: one millisecond of network time.
 *
 * The model, in plain words. Every unit is a leaky integrate-and-fire
 * neuron: its potential leaks toward a resting drive, rises with excitatory
 * input and falls with inhibitory input. At threshold it fires, resets, and
 * is briefly refractory. A spike reaches each target after that synapse's
 * delay (1–9 ms), through three kinds of current:
 *
 *    fast excitatory  (τ ≈ 4.5 ms)    the quick flicker of activity
 *    slow excitatory  (τ ≈ 80 ms)     what lets an assembly sustain itself
 *    inhibitory       (τ ≈ 5.5 ms)    what lets one assembly silence another
 *
 * Every unit also receives a small noise current. That noise is a hash of
 * (seed, step, unit), not a random stream, so it is *identical in every
 * branch*. Two minds that differ by one spike therefore receive the same
 * noise forever after: the only way a difference can spread is along real
 * synapses. That is what makes the pink lineage (causal.ts) exact.
 *
 * Nothing here depends on wall-clock time, frame rate, or global random state.
 */

export const DYNAMICS = {
  // Membrane integration factor dt/τ per type.
  kE: 0.05, // τ = 20 ms
  kI: 0.1, // τ = 10 ms
  kS: 0.0667, // τ = 15 ms
  // Resting drive per type (threshold = 1).
  muE: 0.98,
  muI: 1.1,
  muS: 0.74,
  // Noise amplitude per type.
  sigmaE: 0.35,
  sigmaI: 0.3,
  sigmaS: 1.6,
  // How strongly the stimulus drives sensory units.
  stimGain: 0.4,
  // Synaptic decay per step.
  aFast: 0.8,
  aSlow: 0.988,
  aInh: 0.83,
  slowGain: 0.062,
  // Activation trace decay (τ = 50 ms) and rate smoothing (τ = 100 ms).
  aTrace: 0.98,
  aRate: 0.99,
  refrE: 2,
  refrI: 1,
  refrS: 2,
};

/**
 * ATTRACTOR CLASSIFICATION
 *
 * A mind rests in attractor k when assembly k is clearly active and clearly
 * ahead of every other assembly:
 *
 *     rate_k ≥ activeHz   and   rate_k ≥ ratio · (second-highest rate) + marginHz
 *
 * Otherwise its state lies between attractors: UNKNOWN. These thresholds were
 * chosen by running many perturbed minds headless (scripts/tune.ts) and
 * picking values that separate the self-sustaining states cleanly.
 */
export const SETTLE = {
  activeHz: 14,
  ratio: 1.8,
  marginHz: 4,
};

export function classifyRates(rate: ArrayLike<number>): number {
  let best = -1;
  let bestR = -1;
  let second = 0;
  for (let k = 0; k < N_ASSEMBLIES; k++) {
    const r = rate[k];
    if (r > bestR) {
      second = bestR > 0 ? bestR : 0;
      bestR = r;
      best = k;
    } else if (r > second) second = r;
  }
  if (bestR >= SETTLE.activeHz && bestR >= SETTLE.ratio * second + SETTLE.marginHz) return best;
  return UNKNOWN;
}

interface UnitConstants {
  k: Float64Array;
  mu: Float64Array;
  sigma: Float64Array;
  refr: Uint8Array;
  /** Rate slot: assembly, N_ASSEMBLIES (inhibitory) or N_ASSEMBLIES + 1 (sensory). */
  slot: Uint8Array;
  /** The parameter values these were built from (tuning scripts change DYNAMICS). */
  params: number[];
}

const UNIT_KEYS = ['kE', 'kI', 'kS', 'muE', 'muI', 'muS', 'sigmaE', 'sigmaI', 'sigmaS', 'refrE', 'refrI', 'refrS'] as const;
let unitCache: { net: Network; c: UnitConstants } | null = null;

function unitConstants(net: Network): UnitConstants {
  const P = DYNAMICS;
  if (unitCache && unitCache.net === net) {
    const p = unitCache.c.params;
    let same = true;
    for (let k = 0; k < UNIT_KEYS.length; k++) if (p[k] !== P[UNIT_KEYS[k]]) same = false;
    if (same) return unitCache.c;
  }
  const n = net.n;
  const c: UnitConstants = {
    k: new Float64Array(n),
    mu: new Float64Array(n),
    sigma: new Float64Array(n),
    refr: new Uint8Array(n),
    slot: new Uint8Array(n),
    params: UNIT_KEYS.map((k) => P[k]),
  };
  for (let i = 0; i < n; i++) {
    const t = net.type[i];
    if (t === TYPE_EXC) {
      c.k[i] = P.kE;
      c.mu[i] = P.muE;
      c.sigma[i] = P.sigmaE;
      c.refr[i] = P.refrE;
      c.slot[i] = net.group[i];
    } else if (t === TYPE_SENSORY) {
      c.k[i] = P.kS;
      c.mu[i] = P.muS;
      c.sigma[i] = P.sigmaS;
      c.refr[i] = P.refrS;
      c.slot[i] = N_ASSEMBLIES + 1;
    } else {
      c.k[i] = P.kI;
      c.mu[i] = P.muI;
      c.sigma[i] = P.sigmaI;
      c.refr[i] = P.refrI;
      c.slot[i] = N_ASSEMBLIES;
    }
  }
  unitCache = { net, c };
  return c;
}

const RATE_SCALE = new Float64Array(N_ASSEMBLIES + 2);
for (let k = 0; k < N_ASSEMBLIES; k++) RATE_SCALE[k] = 1000 / ASSEMBLY_SIZE;
RATE_SCALE[N_ASSEMBLIES] = 1000 / N_INH;
RATE_SCALE[N_ASSEMBLIES + 1] = 1000 / N_SENSORY;
const counts = new Float64Array(N_ASSEMBLIES + 2);

export function pushEvent(m: Mind, type: number, step: number, a: number): void {
  const h = m.evHead;
  m.evType[h] = type;
  m.evStep[h] = step;
  m.evA[h] = a;
  m.evHead = (h + 1) % EVENT_RING;
  m.evTotal = m.evTotal + 1;
}

/** Noise in [-1, 1): a pure function of (seed, step, unit). */
function noise(seedMix: number, t: number, i: number): number {
  return mix32((seedMix ^ Math.imul(t, 0x9e3779b1)) + Math.imul(i + 1, 0x85ebca77)) / 2147483648 - 1;
}

const released = new Int32Array(N_NEURONS);
let nReleased = 0;

/**
 * Arrivals and membrane update for units i0 … i1−1, which share constants.
 * Appends the units that fire to `fired` and returns the new count.
 */
function integrate(
  m: Mind,
  i0: number,
  i1: number,
  t: number,
  slot0: number,
  seedMix: number,
  k: number,
  mu: number,
  sigma: number,
  refrSteps: number,
  nf: number,
): number {
  const P = DYNAMICS;
  const aF = P.aFast;
  const aS = P.aSlow;
  const aI = P.aInh;
  const sg = P.slowGain;
  const aT = P.aTrace;
  const { v, ie, is, ii, trace, ringE, ringI, lastSpike, hold, holdUntil, refr, fired } = m;
  for (let i = i0; i < i1; i++) {
    // ---- 1. arrivals -------------------------------------------------------
    const r = slot0 + i;
    const e = ringE[r];
    const inh = ringI[r];
    ringE[r] = 0;
    ringI[r] = 0;
    const fe = ie[i] * aF + e;
    const se = is[i] * aS + e * sg;
    const fi = ii[i] * aI + inh;
    ie[i] = fe;
    is[i] = se;
    ii[i] = fi;

    // ---- 2. membrane -------------------------------------------------------
    const tr = trace[i] * aT;
    const hu = holdUntil[i];
    let fire = false;
    if (hu === t) {
      // A postponed spike is released now, wherever the membrane happens to be.
      fire = true;
      holdUntil[i] = -1;
      released[nReleased++] = i;
    } else if (refr[i] > 0) {
      refr[i]--;
      v[i] = 0;
    } else {
      const drive = mu + fe + se - fi + sigma * noise(seedMix, t, i);
      const v0 = v[i];
      let nv = v0 + k * (drive - v0);
      if (nv >= 1) {
        if (hu > t) nv = 0.999; // already postponed: held at the edge
        else if (hold[i] > 0) {
          holdUntil[i] = t + hold[i];
          hold[i] = 0;
          nv = 0.999;
        } else fire = true;
      }
      v[i] = nv;
    }
    if (fire) {
      v[i] = 0;
      refr[i] = refrSteps;
      lastSpike[i] = t;
      trace[i] = tr + 1;
      fired[nf++] = i;
    } else trace[i] = tr;
  }
  return nf;
}

const slotBase = new Int32Array(RING);

export function step(m: Mind, sink: EventSink | null = null): void {
  const net = networkFor(m.seed);
  const P = DYNAMICS;
  const U = unitConstants(net);
  const N = N_NEURONS;
  const t = m.step;
  const seedMix = mix32((m.seed ^ 0x5eed) >>> 0);
  const { ringE, ringI, fired } = m;
  const slot0 = (t % RING) * N;
  for (let d = 0; d < RING; d++) slotBase[d] = ((t + d) % RING) * N;

  nReleased = 0;
  let nf = 0;
  for (let c = 0; c < N_CHANNELS; c++) {
    const i0 = SENS_START + c * SENSORY_PER_CHANNEL;
    nf = integrate(m, i0, i0 + SENSORY_PER_CHANNEL, t, slot0, seedMix, P.kS, P.muS + P.stimGain * channelLevel(t, c), P.sigmaS, P.refrS, nf);
  }
  nf = integrate(m, EXC_START, INH_START, t, slot0, seedMix, P.kE, P.muE, P.sigmaE, P.refrE, nf);
  nf = integrate(m, INH_START, N, t, slot0, seedMix, P.kI, P.muI, P.sigmaI, P.refrI, nf);
  for (let r = 0; r < nReleased; r++) {
    pushEvent(m, EV_RELEASE, t, released[r]);
    if (sink) sink.push(EV_RELEASE, t, released[r]);
  }
  // `fired` is in ascending unit order (populations are integrated in index order).

  // ---- 3. deliver ---------------------------------------------------------------
  const { outStart, outTarget, outWeight, outDelay } = net;
  const ov = m.ovCount;
  counts.fill(0);
  for (let f = 0; f < nf; f++) {
    const i = fired[f];
    counts[U.slot[i]]++;
    const s0 = outStart[i];
    const s1 = outStart[i + 1];
    for (let s = s0; s < s1; s++) {
      let w = outWeight[s];
      if (ov > 0) w += weightOverride(m, s, ov);
      const at = slotBase[outDelay[s]] + outTarget[s];
      if (i < INH_START) {
        if (w > 0) ringE[at] += w;
      } else if (w < 0) ringI[at] -= w;
    }
    if (sink) sink.push(EV_SPIKE, t, i);
  }
  m.firedCount = nf;
  m.lastSpikes = nf;
  m.spikes = m.spikes + nf;

  // ---- 4. population rates --------------------------------------------------------
  const rate = m.rate;
  const aR = P.aRate;
  for (let k = 0; k < rate.length; k++) rate[k] = rate[k] * aR + counts[k] * RATE_SCALE[k] * (1 - aR);

  // ---- 5. attractor bookkeeping -----------------------------------------------------
  if (t % 10 === 0) {
    const c = classifyRates(rate);
    const prev = m.settled;
    const now = c === UNKNOWN ? -1 : c;
    if (now !== prev) {
      if (prev >= 0) {
        pushEvent(m, EV_UNSETTLE, t, prev);
        if (sink) sink.push(EV_UNSETTLE, t, prev);
      }
      if (now >= 0) {
        pushEvent(m, EV_SETTLE, t, now);
        if (sink) sink.push(EV_SETTLE, t, now);
      }
      m.settled = now;
      m.settledAt = t;
    }
  }

  m.step = t + 1;
}

function weightOverride(m: Mind, s: number, ov: number): number {
  let dw = 0;
  for (let k = 0; k < ov; k++) if (m.ovSyn[k] === s) dw += m.ovDw[k];
  return dw;
}

export { EXC_START };
