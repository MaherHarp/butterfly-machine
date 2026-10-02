// How far does one postponed spike spread? Runs a control and a perturbed
// copy in lockstep and counts units whose spikes have changed (pink lineage).
//
//   npx rolldown scripts/chaos.ts --platform node -o /tmp/chaos.mjs && node /tmp/chaos.mjs [seeds] [trials] [json overrides]
import { CausalTrace, DYNAMICS, STIM_ON, WIRING, applyIntervention, clearNetworkCache, seedMind, step, N_NEURONS, rootNeuron, type Intervention } from '../src/sim';

const seeds = (process.argv[2] ?? '7,99').split(',').map(Number);
const trials = Number(process.argv[3] ?? 6);
if (process.argv[4]) {
  const o = JSON.parse(process.argv[4]);
  Object.assign(DYNAMICS, o.d ?? {});
  Object.assign(WIRING, o.w ?? {});
  clearNetworkCache();
}
const marks = [20, 50, 100, 200, 400];
for (const at of [STIM_ON - 600, STIM_ON + 350]) {
  const sums = marks.map(() => 0);
  let rate = 0;
  for (const seed of seeds) {
    const base = seedMind(seed);
    while (base.step < at) step(base);
    for (let k = 0; k < trials; k++) {
      const A = base.clone();
      for (let s = 0; s < k * 7; s++) step(A);
      const B = A.clone();
      // Postpone the spike of a unit about to fire.
      let best = -1;
      for (let i = 30; i < N_NEURONS; i++) if (A.refr[i] === 0 && (best < 0 || A.v[i] > A.v[best])) best = i;
      const iv: Intervention = { kind: 'delay', neuron: best, ms: 5 };
      applyIntervention(B, iv);
      const tr = new CausalTrace();
      tr.markRoot(rootNeuron(B, iv), B.step);
      let mi = 0;
      const s0 = A.spikes;
      for (let s = 1; s <= marks[marks.length - 1]; s++) {
        step(A);
        step(B);
        tr.update(A, B);
        if (s === marks[mi]) sums[mi++] += tr.mismatched;
      }
      rate += (A.spikes - s0) / marks[marks.length - 1];
    }
  }
  const n = seeds.length * trials;
  console.log(at < STIM_ON ? 'spontaneous' : 'stimulus   ', marks.map((m, i) => `${m}ms:${(sums[i] / n).toFixed(1)}`).join('  '), ` spikes/ms ${(rate / n).toFixed(1)}`);
}
