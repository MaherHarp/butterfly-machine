import { N_NEURONS, WARMUP_STEPS } from './constants';
import { Rng } from './hash';
import { Mind } from './mind';
import { networkFor } from './network';
import { step } from './step';

/** A newly created mind: wiring from the seed, random initial potentials, no history. */
export function createMind(seed: number): Mind {
  seed = seed >>> 0;
  networkFor(seed);
  const m = new Mind();
  m.seed = seed;
  const rng = new Rng(seed ^ 0x6d696e64);
  for (let i = 0; i < N_NEURONS; i++) {
    m.v[i] = rng.next() * 0.9;
    m.lastSpike[i] = -1000000;
    m.holdUntil[i] = -1;
  }
  m.settled = -1;
  return m;
}

/** A living mind from a seed: created, then run through its warm-up. */
export function seedMindFn(seed: number, warmup = WARMUP_STEPS): Mind {
  const m = createMind(seed);
  for (let s = 0; s < warmup; s++) step(m);
  return m;
}
