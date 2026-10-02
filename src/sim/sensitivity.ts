import { EXC_START, STIM_ON } from './constants';
import { applyIntervention } from './interventions';
import { UNKNOWN } from './network';
import { classifyRates, step } from './step';
import { seedMindFn } from './seedfn';

/**
 * How sensitive is a network's reading of the image to one postponed spike?
 * Runs Mind 0 to the moment of the change, makes `copies` visitor-style
 * changes (postpone the spike of a unit about to fire by 1–10 ms) and
 * compares where each altered mind settles with the untouched original.
 * Used to curate the networks the artwork shows (scripts/curate.ts) and by
 * the tests to check that curated list is still true.
 */
export function measureSensitivity(seed: number, copies = 10): { p: number; outcomes: number[]; control: number; distinct: number; unknown: number } {
  const T0 = STIM_ON + 300;
  const SETTLE = T0 + 2600;
  const m0 = seedMindFn(seed);
  while (m0.step < T0) step(m0);
  const look = m0.clone();
  const soon: number[] = [];
  for (let k = 0; k < 40 && soon.length < copies; k++) {
    step(look);
    for (let f = 0; f < look.firedCount; f++) {
      const i = look.fired[f];
      if (i >= EXC_START && k >= 2 && !soon.includes(i)) soon.push(i);
    }
  }
  const ctl = m0.clone();
  while (ctl.step < SETTLE) step(ctl);
  const control = classifyRates(ctl.rate);
  const outcomes: number[] = [];
  let differ = 0;
  for (let c = 0; c < Math.min(copies, soon.length); c++) {
    const m = m0.clone();
    applyIntervention(m, { kind: 'delay', neuron: soon[c], ms: 1 + ((c * 3) % 10) });
    while (m.step < SETTLE) step(m);
    const o = classifyRates(m.rate);
    outcomes.push(o);
    if (o !== control) differ++;
  }
  const all = [control, ...outcomes];
  return {
    p: differ / Math.max(1, outcomes.length),
    outcomes,
    control,
    distinct: new Set(all.filter((o) => o !== UNKNOWN)).size,
    unknown: all.filter((o) => o === UNKNOWN).length / all.length,
  };
}
