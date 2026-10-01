// Search for an ecology whose futures disagree: from one shared state, tiny
// perturbations should lead to different macro outcomes within ~90 s.
import { seedWorld, step, computeMetrics, applyIntervention, autoIntervention, ECOLOGY, OUTCOMES } from '../src/sim';

const base = { ...ECOLOGY };
const seeds = [7, 99, 2024];
const FUT = 12;
function evaluate(): { score: number; desc: string } {
  let score = 0;
  let desc = '';
  for (const sd of seeds) {
    const w0 = seedWorld(sd);
    for (let s = 0; s < 20 * 60; s++) step(w0);
    const m0 = computeMetrics(w0);
    if (m0.grazers < 20 || m0.hunters < 2) { score -= 3; desc += ' [dead-early]'; continue; }
    const classes: Record<string, number> = {};
    const G: number[] = [], H: number[] = [];
    for (let k = 0; k < FUT; k++) {
      const w = w0.clone();
      const iv = autoIntervention(w, 77 + k);
      if (iv) applyIntervention(w, iv);
      for (let s = 0; s < 90 * 60; s++) step(w);
      const m = computeMetrics(w);
      classes[m.outcome] = (classes[m.outcome] ?? 0) + 1;
      G.push(m.grazers); H.push(m.hunters);
    }
    let ent = 0;
    for (const o of OUTCOMES) { const p = (classes[o] ?? 0) / FUT; if (p > 0) ent -= p * Math.log2(p); }
    const cv = (a: number[]) => { const mu = a.reduce((x, y) => x + y, 0) / a.length; if (mu === 0) return 0; return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / a.length) / mu; };
    const collapsed = (classes.collapsed ?? 0) / FUT;
    score += ent + Math.min(1, cv(G)) + Math.min(1, cv(H)) - (collapsed > 0.7 ? 2 : 0);
    desc += ` [${JSON.stringify(classes)} G${Math.round(G.reduce((a, b) => a + b) / FUT)} H${(H.reduce((a, b) => a + b) / FUT).toFixed(1)}]`;
  }
  return { score, desc };
}
const r = (lo: number, hi: number) => lo + (hi - lo) * Math.random();
let best = -1e9;
const iters = Number(process.argv[2] ?? 10);
for (let it = 0; it < iters; it++) {
  Object.assign(ECOLOGY, base);
  if (it > 0 || process.argv[3] === 'rand') {
    ECOLOGY.hunterRest = Math.round(r(150, 400));
    ECOLOGY.catchYield = r(0.2, 0.5);
    ECOLOGY.catchBonus = r(0.2, 0.6);
    ECOLOGY.hunterMetab = r(0.0008, 0.0022);
    ECOLOGY.eatRate = r(0.006, 0.012);
    ECOLOGY.eatHalf = r(0.2, 0.5);
    ECOLOGY.growth = r(0.0009, 0.0018);
    ECOLOGY.grazerRepro = r(1.7, 2.6);
    ECOLOGY.hunterRepro = r(4.5, 6.5);
    ECOLOGY.hunterSated = ECOLOGY.hunterRepro - r(0.2, 0.8);
    ECOLOGY.grazerMove = r(0.0003, 0.0009);
    ECOLOGY.grazerMetab = r(0.0005, 0.001);
  }
  const { score, desc } = evaluate();
  if (score >= best) { best = score; console.log(score.toFixed(2), JSON.stringify(ECOLOGY), desc); }
}
