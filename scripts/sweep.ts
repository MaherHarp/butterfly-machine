// Grid search for dynamics whose outcomes are decided by the perturbation,
// not by the wiring: from one shared moment, many tiny perturbations should
// reach many different attractors, a second or so later.
//
//   npx rolldown scripts/sweep.ts --platform node -o /tmp/sweep.mjs && node /tmp/sweep.mjs '<json grid>'
import { DYNAMICS, STIM_ON, UNKNOWN, WIRING, applyIntervention, autoIntervention, clearNetworkCache, seedMind, step, classifyRates } from '../src/sim';

const grid: Record<string, number[]> = JSON.parse(process.argv[2] ?? '{"d.stimGain":[0.45]}');
const seeds = (process.env.SEEDS ?? '7,99,2024,31337,5,123').split(',').map(Number);
const copies = Number(process.env.COPIES ?? 8);
const T0 = STIM_ON + Number(process.env.T0 ?? 300);
const END = T0 + 6000;
const keys = Object.keys(grid);
const base = { d: { ...DYNAMICS }, w: { ...WIRING } };
function* combos(i = 0, acc: Record<string, number> = {}): Generator<Record<string, number>> {
  if (i === keys.length) { yield { ...acc }; return; }
  for (const v of grid[keys[i]]) yield* combos(i + 1, { ...acc, [keys[i]]: v });
}
for (const c of combos()) {
  Object.assign(DYNAMICS, base.d);
  Object.assign(WIRING, base.w);
  for (const [k, v] of Object.entries(c)) {
    const [o, f] = k.split('.');
    (o === 'd' ? (DYNAMICS as Record<string, number>) : (WIRING as Record<string, number>))[f] = v;
  }
  clearNetworkCache();
  let pdiff = 0, unk = 0, early = 0, spont = 0, total = 0, switches = 0, distinct = 0, spRate = 0, spN = 0;
  const commits: number[] = [];
  const hists: string[] = [];
  for (const seed of seeds) {
    const m0 = seedMind(seed);
    while (m0.step < T0) {
      step(m0);
      if (m0.settled >= 0) spont++;
      if (m0.step < STIM_ON && m0.step % 10 === 0) { for (let k = 0; k < 6; k++) spRate += m0.rate[k] / 6; spN++; }
    }
    const h = new Array(UNKNOWN + 1).fill(0);
    for (let k = 0; k < copies; k++) {
      const m = m0.clone();
      const iv = autoIntervention(m, 1000 + k);
      if (iv) applyIntervention(m, iv);
      let last = -1, at = -1;
      while (m.step < END) {
        step(m);
        if (m.settled !== last) { if (last >= 0 && m.settled >= 0) switches++; last = m.settled; at = m.step; }
      }
      const o = classifyRates(m.rate);
      h[o]++;
      total++;
      if (o === UNKNOWN) unk++;
      else { commits.push(at - T0); if (at - T0 < 300) early++; }
    }
    let s2 = 0;
    for (const x of h) s2 += (x / copies) ** 2;
    pdiff += 1 - s2;
    distinct += h.filter((x) => x > 0).length;
    hists.push(h.join(''));
  }
  commits.sort((a, b) => a - b);
  const q = (p: number) => commits[Math.floor(commits.length * p)] ?? -1;
  console.log(JSON.stringify(c), `spontE ${(spRate / spN).toFixed(2)}Hz pdiff ${(pdiff / seeds.length).toFixed(2)} distinct ${(distinct / seeds.length).toFixed(1)} unk ${(unk / total).toFixed(2)} early ${early} spont ${spont} sw ${switches} commit p10/50/90 ${q(0.1)}/${q(0.5)}/${q(0.9)} [${hists.join(' ')}]`);
}
