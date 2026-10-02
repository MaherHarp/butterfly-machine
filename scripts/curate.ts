// Which networks are genuinely undecided about the image? (see src/sim/seeds.ts)
//
//   npx rolldown scripts/curate.ts --platform node -o /tmp/curate.mjs && node /tmp/curate.mjs <from> <to> [copies]
import { measureSensitivity } from '../src/sim';

const from = Number(process.argv[2] ?? 1);
const to = Number(process.argv[3] ?? 100);
const copies = Number(process.argv[4] ?? 10);
const kept: number[] = [];
for (let seed = from; seed <= to; seed++) {
  const r = measureSensitivity(seed, copies);
  const ok = r.p >= 0.6 && r.distinct >= 3 && r.unknown <= 0.2;
  if (ok) kept.push(seed);
  console.log(`${seed}\tp=${r.p.toFixed(2)}\tdistinct=${r.distinct}\tunk=${r.unknown.toFixed(2)}\t${[r.control, ...r.outcomes].join('')}${ok ? '\t*' : ''}`);
}
console.log('KEPT', kept.length, JSON.stringify(kept));
