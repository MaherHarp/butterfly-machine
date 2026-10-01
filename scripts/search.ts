// Random search over ecology parameters; scores coexistence and outcome variety.
import { seedWorld, step, computeMetrics, ECOLOGY } from '../src/sim';

const base = { ...ECOLOGY, grazerRepro: 1.93, hunterRepro: 5.07, hunterSated: 4.61, hunterRest: 302, eatRate: 0.00895, eatHalf: 0.22, catchYield: 0.30, catchBonus: 0.33, hunterMetab: 0.00099, growth: 0.00143 };
const seeds = [7, 99, 2024, 31337];
function evaluate(): { score: number; desc: string } {
  let score = 0;
  let desc = '';
  for (const sd of seeds) {
    const w = seedWorld(sd);
    let alive = 0;
    const gs: number[] = [];
    let swing = 0;
    let prev = -1;
    for (let t = 0; t < 240; t++) {
      for (let k = 0; k < 60; k++) step(w);
      const m = computeMetrics(w);
      if (m.grazers >= 6 && m.hunters >= 1) alive++;
      if (m.grazers > 250) swing += 1;
      if (prev >= 0) swing += Math.abs(m.grazers - prev) / 40;
      prev = m.grazers;
      if (t % 30 === 29) gs.push(m.grazers, m.hunters);
    }
    const fm = computeMetrics(w);
    score += alive - swing;
    desc += ` [${gs.join(',')} L${fm.lineages}]`;
  }
  return { score, desc };
}
const r = (lo: number, hi: number) => lo + (hi - lo) * Math.random();
let best = -1;
const iters = Number(process.argv[2] ?? 30);
for (let it = 0; it < iters; it++) {
  Object.assign(ECOLOGY, base);
  if (it > 0) {
    ECOLOGY.grazerMove = r(0.0003, 0.0009);
    ECOLOGY.grazerMetab = r(0.0005, 0.001);
    ECOLOGY.hunterRest = Math.round(r(180, 420));
    ECOLOGY.catchYield = r(0.25, 0.5);
    ECOLOGY.catchBonus = r(0.2, 0.6);
    ECOLOGY.hunterMetab = r(0.0008, 0.0018);
    ECOLOGY.eatRate = r(0.007, 0.013);
    ECOLOGY.eatHalf = r(0.2, 0.5);
    ECOLOGY.growth = r(0.0008, 0.0016);
    ECOLOGY.grazerRepro = r(1.9, 2.6);
    ECOLOGY.hunterRepro = r(4.8, 6.5);
    ECOLOGY.hunterSated = ECOLOGY.hunterRepro - r(0.2, 0.8);
  }
  const { score, desc } = evaluate();
  if (score >= best || it === 0) {
    best = score;
    console.log(score, JSON.stringify(ECOLOGY), desc);
  }
}
