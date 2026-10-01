// Run many tiny-perturbation futures of one world and histogram their outcomes.
import { seedWorld, step, computeMetrics, applyIntervention, autoIntervention, OUTCOMES } from '../src/sim';

const seed = Number(process.argv[2] ?? 7);
const N = Number(process.argv[3] ?? 48);
const base = seedWorld(seed);
for (let s = 0; s < 15 * 60; s++) step(base);
const marks = [30, 60, 120, 180];
const hist: Record<number, Record<string, number>> = {};
for (const m of marks) hist[m] = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
let pops = '';
const t0 = performance.now();
let steps = 0;
for (let k = 0; k < N; k++) {
  const w = base.clone();
  const iv = autoIntervention(w, 1000 + k);
  if (iv) applyIntervention(w, iv);
  let mi = 0;
  for (let s = 1; s <= marks[marks.length - 1] * 60; s++) {
    step(w); steps++;
    if (s === marks[mi] * 60) {
      const m = computeMetrics(w);
      hist[marks[mi]][m.outcome]++;
      if (marks[mi] === 120 && k < 16) pops += ` ${m.grazers}/${m.hunters}`;
      mi++;
    }
  }
}
console.log('seed', seed, 'futures', N, 'us/step', ((performance.now() - t0) / steps * 1000).toFixed(1));
for (const m of marks) console.log(` t+${m}s`, JSON.stringify(hist[m]));
console.log(' G/H at 120s:', pops);
