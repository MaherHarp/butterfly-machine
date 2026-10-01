// Simulates the experience's timeline: T0 at +15 s, splits at T0, +30, +40, +50 (16 worlds),
// then fast doubling to 64 (a sample of the 1024), and reports outcome classes at the end.
import { seedWorld, step, computeMetrics, applyIntervention, autoIntervention, negate, ECOLOGY, OUTCOMES, World } from '../src/sim';

if (process.argv[3]) Object.assign(ECOLOGY, JSON.parse(process.argv[3]));
const seed = Number(process.argv[2] ?? 7);
const w0 = seedWorld(seed);
for (let s = 0; s < 15 * 60; s++) step(w0);
let leaves: World[] = [w0];
const splitTimes = [0, 30, 40, 50, 80, 81, 82, 83]; // seconds after T0 (last 2 of the 6 fast splits skipped: 64 leaves)
const T0 = w0.step;
const report = (label: string) => {
  const h: Record<string, number> = {};
  let G = 0, H = 0;
  for (const l of leaves) { const m = computeMetrics(l); h[m.outcome] = (h[m.outcome] ?? 0) + 1; G += m.grazers; H += m.hunters; }
  console.log(`seed ${seed} ${label} n=${leaves.length} G${(G / leaves.length).toFixed(0)} H${(H / leaves.length).toFixed(1)}`, JSON.stringify(h));
};
let key = 1;
for (let k = 0; k < splitTimes.length; k++) {
  const target = T0 + splitTimes[k] * 60;
  for (const l of leaves) while (l.step < target) step(l);
  if (k === 3) report('16 worlds formed');
  const next: World[] = [];
  for (const l of leaves) {
    const a = l, b = l.clone();
    const iv = autoIntervention(a, key++);
    if (iv) { applyIntervention(a, iv); applyIntervention(b, negate(iv)); }
    next.push(a, b);
  }
  leaves = next;
}
for (const t of [120, 160, 200, 240]) {
  for (const l of leaves) while (l.step < T0 + t * 60) step(l);
  report(`T0+${t}s`);
}
void OUTCOMES;
