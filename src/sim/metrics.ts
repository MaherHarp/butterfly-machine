import { N_ASSEMBLIES, N_NEURONS, STEPS_PER_SECOND } from './constants';
import type { Mind } from './mind';
import { OUTCOME_NAMES, UNKNOWN, type OutcomeName } from './network';
import { classifyRates } from './step';

/**
 * Measurable properties of one mind, all computed from its state.
 *
 *  rates       smoothed firing rate of each assembly (Hz, τ = 100 ms)
 *  inhRate     inhibitory population rate
 *  sensRate    sensory population rate
 *  dominant    the most active assembly
 *  lead        (r₁ − r₂) / (r₁ + r₂ + 5): how far the leader is ahead (0 … 1)
 *  commitment  how deep the mind is in its attractor (0 … 1); drives how
 *              strongly the interpretation shows
 *  activity    mean activation trace over all units
 *  outcome     attractor index (classifyRates in step.ts), or UNKNOWN
 *  settledFor  seconds since the current attractor was entered (0 if none)
 */
export interface MindMetrics {
  rates: number[];
  inhRate: number;
  sensRate: number;
  dominant: number;
  lead: number;
  commitment: number;
  activity: number;
  outcome: number;
  settledFor: number;
  spikes: number;
  lastSpikes: number;
  perturbed: number;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function leadOf(rates: ArrayLike<number>): { dominant: number; lead: number; r1: number; r2: number } {
  let dominant = 0;
  let r1 = -1;
  let r2 = 0;
  for (let k = 0; k < N_ASSEMBLIES; k++) {
    const r = rates[k];
    if (r > r1) {
      r2 = r1 > 0 ? r1 : 0;
      r1 = r;
      dominant = k;
    } else if (r > r2) r2 = r;
  }
  return { dominant, lead: (r1 - r2) / (r1 + r2 + 5), r1, r2 };
}

export function commitmentOf(rates: ArrayLike<number>): number {
  const { lead, r1 } = leadOf(rates);
  return smooth(0.12, 0.55, lead) * smooth(6, 18, r1);
}

export function computeMetrics(m: Mind): MindMetrics {
  const rates: number[] = [];
  for (let k = 0; k < N_ASSEMBLIES; k++) rates.push(m.rate[k]);
  const { dominant, lead } = leadOf(rates);
  let act = 0;
  for (let i = 0; i < N_NEURONS; i++) act += m.trace[i];
  const outcome = classifyRates(m.rate);
  return {
    rates,
    inhRate: m.rate[N_ASSEMBLIES],
    sensRate: m.rate[N_ASSEMBLIES + 1],
    dominant,
    lead,
    commitment: commitmentOf(rates),
    activity: act / N_NEURONS,
    outcome,
    settledFor: m.settled >= 0 && m.settled === outcome ? (m.step - m.settledAt) / STEPS_PER_SECOND : 0,
    spikes: m.spikes,
    lastSpikes: m.lastSpikes,
    perturbed: m.perturbed,
  };
}

export function outcomeName(o: number): OutcomeName {
  return OUTCOME_NAMES[o] ?? 'unknown';
}

export { UNKNOWN };

// ---- transfer encoding ----------------------------------------------------------

/**
 * Fixed-order numeric encoding for transfer between threads. The pair slots
 * are filled only for a mind that is being compared with a control twin.
 */
export const M_RATES = 0;
export const M_INH = N_ASSEMBLIES;
export const M_SENS = N_ASSEMBLIES + 1;
export const M_DOMINANT = N_ASSEMBLIES + 2;
export const M_LEAD = N_ASSEMBLIES + 3;
export const M_COMMIT = N_ASSEMBLIES + 4;
export const M_ACTIVITY = N_ASSEMBLIES + 5;
export const M_OUTCOME = N_ASSEMBLIES + 6;
export const M_SETTLED_FOR = N_ASSEMBLIES + 7;
export const M_SPIKES = N_ASSEMBLIES + 8;
export const M_LAST_SPIKES = N_ASSEMBLIES + 9;
export const M_PERTURBED = N_ASSEMBLIES + 10;
/** Pair slots: divergence from the twin, units differing now, units ever mismatched, deepest generation. */
export const M_PAIR_DIV = N_ASSEMBLIES + 11;
export const M_PAIR_DIFF = N_ASSEMBLIES + 12;
export const M_PAIR_EVER = N_ASSEMBLIES + 13;
export const M_PAIR_GEN = N_ASSEMBLIES + 14;
export const M_PAIR_ON = N_ASSEMBLIES + 15;
export const METRIC_COUNT = N_ASSEMBLIES + 16;

export function encodeMetrics(m: MindMetrics, out: Float32Array, o: number): void {
  for (let k = 0; k < N_ASSEMBLIES; k++) out[o + M_RATES + k] = m.rates[k];
  out[o + M_INH] = m.inhRate;
  out[o + M_SENS] = m.sensRate;
  out[o + M_DOMINANT] = m.dominant;
  out[o + M_LEAD] = m.lead;
  out[o + M_COMMIT] = m.commitment;
  out[o + M_ACTIVITY] = m.activity;
  out[o + M_OUTCOME] = m.outcome;
  out[o + M_SETTLED_FOR] = m.settledFor;
  out[o + M_SPIKES] = m.spikes;
  out[o + M_LAST_SPIKES] = m.lastSpikes;
  out[o + M_PERTURBED] = m.perturbed;
  for (let k = M_PAIR_DIV; k <= M_PAIR_ON; k++) out[o + k] = 0;
}

export interface DecodedMetrics extends MindMetrics {
  pair: { divergence: number; differing: number; mismatched: number; generation: number } | null;
}

export function decodeMetrics(src: Float32Array, o: number): DecodedMetrics {
  const rates: number[] = [];
  for (let k = 0; k < N_ASSEMBLIES; k++) rates.push(src[o + M_RATES + k]);
  return {
    rates,
    inhRate: src[o + M_INH],
    sensRate: src[o + M_SENS],
    dominant: src[o + M_DOMINANT],
    lead: src[o + M_LEAD],
    commitment: src[o + M_COMMIT],
    activity: src[o + M_ACTIVITY],
    outcome: src[o + M_OUTCOME] < 0 || src[o + M_OUTCOME] > UNKNOWN ? UNKNOWN : src[o + M_OUTCOME],
    settledFor: src[o + M_SETTLED_FOR],
    spikes: src[o + M_SPIKES],
    lastSpikes: src[o + M_LAST_SPIKES],
    perturbed: src[o + M_PERTURBED],
    pair:
      src[o + M_PAIR_ON] > 0
        ? {
            divergence: src[o + M_PAIR_DIV],
            differing: src[o + M_PAIR_DIFF],
            mismatched: src[o + M_PAIR_EVER],
            generation: src[o + M_PAIR_GEN],
          }
        : null,
  };
}
