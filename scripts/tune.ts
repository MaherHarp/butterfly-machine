// Headless tuning: from one shared moment shortly after stimulus onset, give
// many copies of a mind one tiny perturbation each and see where they settle.
//
//   npx rolldown scripts/tune.ts --platform node -o /tmp/tune.mjs && node /tmp/tune.mjs [seeds] [copies] [json overrides]
//
// Overrides: {"d": {...DYNAMICS}, "w": {...WIRING}}
import {
  DYNAMICS,
  OUTCOME_NAMES,
  STIM_ON,
  UNKNOWN,
  WIRING,
  applyIntervention,
  autoIntervention,
  clearNetworkCache,
  computeMetrics,
  mindDivergence,
  seedMind,
  step,
} from '../src/sim';

const seeds = (process.argv[2] ?? '7,99,2024').split(',').map(Number);
const copies = Number(process.argv[3] ?? 16);
if (process.argv[4]) {
  const o = JSON.parse(process.argv[4]);
  Object.assign(DYNAMICS, o.d ?? {});
  Object.assign(WIRING, o.w ?? {});
  clearNetworkCache();
}
const T0 = STIM_ON + Number(process.env.T0 ?? 300);
const END = T0 + 7000;
const all: Record<string, number> = {};
const t0 = performance.now();
let steps = 0;
for (const seed of seeds) {
  const base = seedMind(seed);
  let spontMax = 0;
  let early = -1;
  while (base.step < T0) {
    step(base);
    steps++;
    if (base.step < STIM_ON) for (let k = 0; k < 6; k++) spontMax = Math.max(spontMax, base.rate[k]);
    if (early < 0 && base.settled >= 0) early = base.step;
  }
  const hist: Record<string, number> = {};
  const commits: number[] = [];
  const divs: string[] = [];
  let switches = 0;
  for (let c = 0; c < copies; c++) {
    const m = base.clone();
    const iv = autoIntervention(m, 1000 + c);
    if (iv) applyIntervention(m, iv);
    const ctl = c === 0 ? base.clone() : null;
    let lastSettle = -1;
    let lastOut = -1;
    while (m.step < END) {
      step(m);
      if (ctl) step(ctl);
      steps++;
      const o = m.settled;
      if (o !== lastOut) {
        if (lastOut >= 0 && o >= 0) switches++;
        lastOut = o;
        lastSettle = m.step;
      }
      if (ctl && (m.step - T0) % 500 === 0) divs.push(`${((m.step - T0) / 1000).toFixed(1)}s:${(mindDivergence(m, ctl).score * 100).toFixed(1)}`);
    }
    const out = computeMetrics(m).outcome;
    const name = OUTCOME_NAMES[out];
    hist[name] = (hist[name] ?? 0) + 1;
    all[name] = (all[name] ?? 0) + 1;
    if (out !== UNKNOWN) commits.push(lastSettle - T0);
  }
  commits.sort((a, b) => a - b);
  console.log(`seed ${seed} spontMax ${spontMax.toFixed(1)} earlySettle ${early >= 0 ? early - STIM_ON : '-'} | ${JSON.stringify(hist)} | commit ms p10 ${commits[Math.floor(commits.length * 0.1)] ?? '-'} p50 ${commits[Math.floor(commits.length / 2)] ?? '-'} p90 ${commits[Math.floor(commits.length * 0.9)] ?? '-'} | switches ${switches}`);
  console.log('   ctl div', divs.join(' '));
}
console.log('ALL', JSON.stringify(all), 'us/step', (((performance.now() - t0) / steps) * 1000).toFixed(2));
