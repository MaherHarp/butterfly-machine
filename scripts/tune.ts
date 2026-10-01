// Headless exploration of the ecology: population dynamics, divergence growth, outcome spread.
import { seedWorld, step, computeMetrics, worldDivergence, applyIntervention, KIND_HUNTER } from '../src/sim';

const seed = Number(process.argv[2] ?? 7);
const t0 = performance.now();
const w = seedWorld(seed);
console.log('seed', seed, 'warmup ms', (performance.now() - t0).toFixed(1), 'n', w.n);

// Population trace for 180 s.
const trace = w.clone();
let line = '';
for (let s = 0; s < 180 * 60; s++) {
  step(trace);
  if (s % 600 === 0) {
    const m = computeMetrics(trace);
    line += `\n t=${(s / 60).toFixed(0).padStart(3)}s G=${m.grazers} H=${m.hunters} lin=${m.lineages} dom=${m.dominance.toFixed(2)} div=${m.diversity.toFixed(2)} res=${m.resource.toFixed(2)} vol=${m.volatility.toFixed(2)} str=${m.structures} -> ${m.outcome}`;
  }
}
console.log(line);

// Divergence growth from a 0.7 px nudge of a grazer near the centre.
const a = w.clone();
const b = w.clone();
let best = -1, bd = 1e9;
for (let i = 0; i < b.n; i++) { if (b.kind[i] === KIND_HUNTER) continue; const d = b.x[i] ** 2 + b.y[i] ** 2; if (d < bd) { bd = d; best = i; } }
applyIntervention(b, { kind: 'nudge', id: b.id[best], dx: 0.7, dy: 0 });
let dl = '';
for (let s = 1; s <= 60 * 60; s++) {
  step(a); step(b);
  if (s % 120 === 0) { const d = worldDivergence(a, b); dl += ` ${(s / 60).toFixed(0)}s:${(d.score * 100).toFixed(1)}%`; }
}
console.log('divergence', dl);

// Speed.
const bench = w.clone();
const tb = performance.now();
for (let s = 0; s < 3000; s++) step(bench);
console.log('us/step', ((performance.now() - tb) / 3000 * 1000).toFixed(1), 'n', bench.n);
