import { step } from './step';
import type { Mind } from './mind';

export * from './constants';
export * from './events';
export * from './interventions';
export * from './metrics';
export * from './divergence';
export * from './network';
export * from './stimulus';
export { CausalTrace, generationWeight } from './causal';
export { step, classifyRates, DYNAMICS, SETTLE } from './step';
export { Mind, STATE_BYTES, N_RATES } from './mind';
export { dsin, dcos, hash4, rand01, randSigned, Rng } from './hash';
export { createMind, seedMindFn as seedMind } from './seedfn';
export { measureSensitivity } from './sensitivity';

export function runTo(m: Mind, targetStep: number): void {
  while (m.step < targetStep) step(m);
}
