import { WARMUP_STEPS } from './constants';
import { step } from './step';
import { World, createWorld } from './world';

export * from './constants';
export * from './events';
export * from './interventions';
export * from './metrics';
export * from './divergence';
export { step, sampleField, sunPosition, season, ECOLOGY } from './step';
export { World, createWorld, FIELD_MASK, LINEAGE_HUES, HUNTER_HUE, STATE_BYTES } from './world';

/** A living world from a seed: created, then run through its warm-up. */
export function seedWorld(seed: number, warmup = WARMUP_STEPS): World {
  return createWorld(seed, warmup, (w) => step(w));
}

export function runTo(w: World, targetStep: number): void {
  while (w.step < targetStep) step(w);
}
export { dsin, dcos, hash4, rand01, randSigned, Rng } from './hash';
