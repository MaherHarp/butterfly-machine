import { EXC_START, INH_START, N_NEURONS } from './constants';
import { EV_INTERVENTION } from './events';
import { hash4, rand01 } from './hash';
import type { Mind } from './mind';
import { networkFor } from './network';
import { pushEvent } from './step';

/**
 * An intervention is the only thing that ever differs between two sibling
 * minds. It names its target by unit (or synapse) index, which is the same in
 * every mind built from the same seed.
 *
 *   delay   the unit's next spike is postponed by `ms` milliseconds
 *           (the spike still happens, just later; everything downstream
 *           receives it later)
 *   nudge   the unit's membrane potential is shifted by `dv` (threshold = 1)
 *   weight  one synapse's weight is changed by `dw`
 */
export type Intervention =
  | { kind: 'delay'; neuron: number; ms: number }
  | { kind: 'nudge'; neuron: number; dv: number }
  | { kind: 'weight'; synapse: number; dw: number };

export const MIN_DELAY_MS = 1;
export const MAX_DELAY_MS = 10;

/** The unit whose state an intervention changes first (the root of its pink lineage). */
export function rootNeuron(m: Mind | number, iv: Intervention): number {
  switch (iv.kind) {
    case 'delay':
    case 'nudge':
      return iv.neuron;
    case 'weight': {
      const seed = typeof m === 'number' ? m : m.seed;
      return networkFor(seed).outTarget[iv.synapse];
    }
  }
}

/** Applies an intervention in place. Returns false if it cannot apply. */
export function applyIntervention(m: Mind, iv: Intervention): boolean {
  switch (iv.kind) {
    case 'delay': {
      if (iv.neuron < 0 || iv.neuron >= N_NEURONS) return false;
      const ms = Math.round(iv.ms);
      if (ms < 1) return false;
      if (m.holdUntil[iv.neuron] > m.step) m.holdUntil[iv.neuron] += ms;
      else m.hold[iv.neuron] += ms;
      break;
    }
    case 'nudge':
      if (iv.neuron < 0 || iv.neuron >= N_NEURONS) return false;
      m.v[iv.neuron] += iv.dv;
      break;
    case 'weight': {
      const net = networkFor(m.seed);
      if (iv.synapse < 0 || iv.synapse >= net.synapses) return false;
      const k = m.ovCount;
      if (k >= m.ovSyn.length) return false;
      m.ovSyn[k] = iv.synapse;
      m.ovDw[k] = iv.dw;
      m.ovCount = k + 1;
      break;
    }
  }
  m.perturbed = m.perturbed + 1;
  pushEvent(m, EV_INTERVENTION, m.step, rootNeuron(m, iv));
  return true;
}

/**
 * The tiny change the machine makes when it forks a mind on its own. One
 * child continues unchanged; the other receives this. Chosen
 * deterministically from the parent's state, the seed and the parent's place
 * in the tree. Mostly spike timing (the artwork's theme), sometimes a tiny
 * change of activation or of one connection.
 */
export function autoIntervention(m: Mind, parentKey: number): Intervention | null {
  const seed = m.seed;
  const s = m.step;
  const which = rand01(seed, parentKey, s, 0x5e2);
  const mag = rand01(seed, parentKey, s, 0x5e3);
  if (which < 0.7) {
    // A unit close to threshold (it will fire soon): postpone its spike by 1–10 ms.
    const pick = hash4(seed, parentKey, s, 0x5e1);
    const cand: number[] = [];
    let lim = 0.82;
    while (cand.length < 6 && lim > 0.2) {
      cand.length = 0;
      for (let i = EXC_START; i < N_NEURONS; i++) {
        if (m.refr[i] === 0 && m.holdUntil[i] < s && m.hold[i] === 0 && m.v[i] >= lim) cand.push(i);
      }
      lim -= 0.12;
    }
    const neuron = cand.length ? cand[pick % cand.length] : EXC_START + (pick % (N_NEURONS - EXC_START));
    return { kind: 'delay', neuron, ms: MIN_DELAY_MS + Math.floor(mag * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) };
  }
  const sign = rand01(seed, parentKey, s, 0x5e4) < 0.5 ? -1 : 1;
  // Otherwise a unit that has been active in the last 100 ms (a change to a silent one may never matter).
  const active: number[] = [];
  for (let i = EXC_START; i < INH_START; i++) if (m.refr[i] === 0 && s - m.lastSpike[i] < 100) active.push(i);
  const neuron = active.length
    ? active[hash4(seed, parentKey, s, 0x5e5) % active.length]
    : EXC_START + (hash4(seed, parentKey, s, 0x5e5) % (INH_START - EXC_START));
  if (which < 0.9) return { kind: 'nudge', neuron, dv: sign * (0.002 + 0.018 * mag) };
  const net = networkFor(seed);
  const n0 = net.outStart[neuron];
  const synapse = n0 + (hash4(seed, parentKey, s, 0x5e6) % (net.outStart[neuron + 1] - n0));
  return { kind: 'weight', synapse, dw: sign * net.outWeight[synapse] * (0.01 + 0.04 * mag) };
}

export function magnitudeOf(iv: Intervention): number {
  switch (iv.kind) {
    case 'delay':
      return iv.ms;
    case 'nudge':
      return Math.abs(iv.dv);
    case 'weight':
      return Math.abs(iv.dw);
  }
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 10) return a.toFixed(0);
  if (a >= 1) return a.toFixed(1);
  if (a >= 0.1) return a.toFixed(2);
  return a.toPrecision(2);
}

/** Short human description, e.g. "one spike +5 ms", "activation −0.4%". */
export function describeIntervention(iv: Intervention | null, seed?: number): string {
  if (!iv) return 'unchanged';
  switch (iv.kind) {
    case 'delay':
      return `one spike +${iv.ms} ms`;
    case 'nudge':
      return `activation ${iv.dv < 0 ? '−' : '+'}${fmt(iv.dv * 100)}%`;
    case 'weight': {
      const w = seed !== undefined ? Math.abs(networkFor(seed).outWeight[iv.synapse]) : 0;
      return w > 0 ? `one synapse ${iv.dw < 0 ? '−' : '+'}${fmt((Math.abs(iv.dw) / w) * 100)}%` : `one synapse ${iv.dw < 0 ? '−' : '+'}`;
    }
  }
}
