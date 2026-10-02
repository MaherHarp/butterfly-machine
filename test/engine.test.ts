import { describe, expect, it } from 'vitest';
import {
  CausalTrace,
  EV_SPIKE,
  EventRecorder,
  MAX_WEIGHT_OVERRIDES,
  Mind,
  N_ASSEMBLIES,
  N_NEURONS,
  STIM_ON,
  UNKNOWN,
  applyIntervention,
  autoIntervention,
  classifyRates,
  computeMetrics,
  createMind,
  measureSensitivity,
  dcos,
  dsin,
  mindDivergence,
  networkFor,
  rootNeuron,
  seedMind,
  step,
  type Intervention,
} from '../src/sim';
import { findFirstDivergence, reconstruct, replayInto, type PathEntry } from '../src/sim/replay';
import { decodePacket, writeMindBlock, blockWordsFor, PACKET_HEADER, LOD_HIGH, LOD_LOW, UNIT_STRIDE, type MindFrame } from '../src/engine/packet';
import { BranchTree } from '../src/engine/tree';
import { treePosition, LEAF_SPACING, landscapeTarget } from '../src/experience/layout';
import { decodeShare, encodeShare } from '../src/experience/share';
import { tallyOutcomes } from '../src/experience/format';
import { UNDECIDED_SEEDS } from '../src/sim/seeds';

const SEED = 4242;
/** The moment the visitor changes something: shortly after the image appears. */
const T0 = STIM_ON + 300;
const atT0 = (() => {
  const m = seedMind(SEED);
  while (m.step < T0) step(m);
  return m;
})();

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function run(m: Mind, n: number): Mind {
  for (let i = 0; i < n; i++) step(m);
  return m;
}

/** A unit that fires within the next few steps (found by looking ahead on a copy), and when. */
function nextSpike(m: Mind, from = 30): { unit: number; at: number } {
  const c = m.clone();
  for (let k = 0; k < 40; k++) {
    const s = c.step;
    step(c);
    for (let f = 0; f < c.firedCount; f++) if (c.fired[f] >= from) return { unit: c.fired[f], at: s };
  }
  throw new Error('nothing fires');
}

describe('neural determinism', () => {
  it('the same seed produces bit-identical minds', () => {
    const a = run(seedMind(SEED), 500);
    const b = run(seedMind(SEED), 500);
    expect(bytesEqual(a.buffer, b.buffer)).toBe(true);
    expect(bytesEqual(seedMind(1).buffer, seedMind(2).buffer)).toBe(false);
  });

  it('is independent of how steps are grouped into frames', () => {
    const a = run(atT0.clone(), 700);
    const b = atT0.clone();
    for (const c of [1, 7, 3, 60, 2, 120, 33, 474]) run(b, c);
    expect(b.step).toBe(a.step);
    expect(bytesEqual(a.buffer, b.buffer)).toBe(true);
  });

  it('same seed + same stimulus + same intervention give identical trajectories', () => {
    const { unit } = nextSpike(atT0);
    const iv: Intervention = { kind: 'delay', neuron: unit, ms: 5 };
    const a = atT0.clone();
    const b = atT0.clone();
    applyIntervention(a, iv);
    applyIntervention(b, iv);
    for (let s = 0; s < 1500; s++) {
      step(a);
      step(b);
      if (s % 100 === 0) expect(bytesEqual(a.buffer, b.buffer)).toBe(true);
    }
    expect(bytesEqual(a.buffer, b.buffer)).toBe(true);
  });

  it('the wiring is a pure function of the seed', () => {
    const a = networkFor(77);
    const b = networkFor(78);
    const c = networkFor(77);
    expect(c).toBe(a);
    expect(a.synapses).toBeGreaterThan(10000);
    expect(Array.from(a.outTarget.slice(0, 50))).not.toEqual(Array.from(b.outTarget.slice(0, 50)));
  });
});

describe('interventions', () => {
  it('a delay postpones exactly one spike by exactly that many milliseconds', () => {
    const { unit, at } = nextSpike(atT0);
    for (const ms of [1, 5, 10]) {
      const m = atT0.clone();
      applyIntervention(m, { kind: 'delay', neuron: unit, ms });
      let fired = -1;
      while (m.step <= at + ms + 1) {
        const s = m.step;
        step(m);
        if (m.lastSpike[unit] === s && fired < 0) fired = s;
      }
      expect(fired).toBe(at + ms);
    }
  });

  it('every kind applies, and invalid ones are refused', () => {
    const net = networkFor(SEED);
    const ivs: Intervention[] = [
      { kind: 'delay', neuron: 100, ms: 3 },
      { kind: 'nudge', neuron: 100, dv: 0.004 },
      { kind: 'weight', synapse: net.outStart[100], dw: 0.001 },
    ];
    for (const iv of ivs) {
      const m = atT0.clone();
      expect(applyIntervention(m, iv)).toBe(true);
      expect(m.perturbed).toBe(1);
    }
    expect(applyIntervention(atT0.clone(), { kind: 'delay', neuron: N_NEURONS + 5, ms: 3 })).toBe(false);
    expect(applyIntervention(atT0.clone(), { kind: 'weight', synapse: -1, dw: 1 })).toBe(false);
    const full = atT0.clone();
    for (let k = 0; k < MAX_WEIGHT_OVERRIDES; k++) expect(applyIntervention(full, { kind: 'weight', synapse: k, dw: 0.001 })).toBe(true);
    expect(applyIntervention(full, { kind: 'weight', synapse: 99, dw: 0.001 })).toBe(false);
  });

  it('machine-made changes are deterministic and tiny', () => {
    const a = autoIntervention(atT0, 7)!;
    expect(autoIntervention(atT0, 7)).toEqual(a);
    const kinds = new Set<string>();
    for (let k = 0; k < 60; k++) {
      const iv = autoIntervention(atT0, 100 + k)!;
      kinds.add(iv.kind);
      if (iv.kind === 'delay') {
        expect(iv.ms).toBeGreaterThanOrEqual(1);
        expect(iv.ms).toBeLessThanOrEqual(10);
      }
      if (iv.kind === 'nudge') expect(Math.abs(iv.dv)).toBeLessThan(0.025);
    }
    expect(kinds.has('delay')).toBe(true);
  });
});

describe('perturbation sensitivity', () => {
  it('one spike 5 ms later spreads through the network and the trajectories part', () => {
    const { unit } = nextSpike(atT0);
    const A = atT0.clone();
    const B = atT0.clone();
    const iv: Intervention = { kind: 'delay', neuron: unit, ms: 5 };
    applyIntervention(B, iv);
    const tr = new CausalTrace();
    tr.markRoot(rootNeuron(B, iv), B.step);
    const d0 = mindDivergence(A, B).score;
    expect(d0).toBe(0); // a pending postponement changes nothing until the spike was due
    let early = -1;
    for (let s = 1; s <= 2500; s++) {
      step(A);
      step(B);
      tr.update(A, B);
      if (s === 40) early = mindDivergence(A, B).score;
    }
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.05);
    expect(tr.mismatched).toBeGreaterThan(60);
    expect(mindDivergence(A, B).score).toBeGreaterThan(early * 5);
  });

  it('identical minds measure exactly zero, and the measure stays in range', () => {
    expect(mindDivergence(atT0, atT0.clone()).score).toBe(0);
    const d = mindDivergence(atT0, run(seedMind(9), 2500));
    expect(d.score).toBeGreaterThan(0);
    expect(d.score).toBeLessThanOrEqual(1);
  });
});

describe('attractors', () => {
  it('known states classify consistently', () => {
    const r = (v: number[]) => [...v, 12, 6];
    expect(classifyRates(r([40, 3, 2, 4, 1, 2]))).toBe(0);
    expect(classifyRates(r([2, 3, 2, 4, 1, 38]))).toBe(5);
    expect(classifyRates(r([22, 21, 2, 4, 1, 2]))).toBe(UNKNOWN); // two co-active: undecided
    expect(classifyRates(r([3, 2, 2, 4, 1, 2]))).toBe(UNKNOWN); // nothing active: at rest
    expect(classifyRates(r([0, 0, 0, 0, 0, 0]))).toBe(UNKNOWN);
    for (let k = 0; k < N_ASSEMBLIES; k++) {
      const v = [1, 1, 1, 1, 1, 1];
      v[k] = 30;
      expect(classifyRates(r(v))).toBe(k);
    }
  });

  it('a mind at rest is undecided; after the image it settles and stays', () => {
    const rest = seedMind(SEED);
    expect(computeMetrics(rest).outcome).toBe(UNKNOWN);
    const m = atT0.clone();
    run(m, 3500);
    const o = computeMetrics(m).outcome;
    expect(o).not.toBe(UNKNOWN);
    expect(m.settled).toBe(o);
    for (let k = 0; k < 5; k++) {
      run(m, 400);
      expect(computeMetrics(m).outcome).toBe(o);
    }
    const mm = computeMetrics(m);
    expect(mm.commitment).toBeGreaterThan(0.5);
    expect(mm.dominant).toBe(o);
  });
});

describe('branches and replay', () => {
  it('replay from a snapshot reaches the same state as uninterrupted execution', () => {
    const live = atT0.clone();
    run(live, 300);
    const snap = live.snapshot();
    run(live, 600);
    expect(bytesEqual(live.buffer, run(new Mind(snap), 600).buffer)).toBe(true);
  });

  it('branches share identical history before their intervention, and are rebuilt exactly from paths', () => {
    const origin = atT0.clone();
    const originSnap = origin.snapshot();
    const { unit } = nextSpike(origin);
    const user: Intervention = { kind: 'delay', neuron: unit, ms: 5 };
    // Live, as the workers do it: 1 → (2 unchanged, 3 = user) at T0; 3 → (6 unchanged, 7 = auto) at T1.
    const A = origin.clone();
    const B = origin.clone();
    applyIntervention(B, user);
    run(A, 200);
    run(B, 200);
    const T1 = B.step;
    const B6 = B;
    const B7 = B.clone();
    expect(bytesEqual(B6.buffer, B7.buffer)).toBe(true); // identical up to the fork
    const auto = autoIntervention(B7, 3)!;
    applyIntervention(B7, auto);
    run(B6, 400);
    run(B7, 400);
    run(A, 400);

    const path7: PathEntry[] = [
      { step: T0, iv: user },
      { step: T1, iv: { auto: 1, parentKey: 3 } },
    ];
    expect(bytesEqual(reconstruct(originSnap, path7, B7.step).buffer, B7.buffer)).toBe(true);
    expect(bytesEqual(reconstruct(originSnap, [{ step: T0, iv: user }, { step: T1, iv: null }], B6.step).buffer, B6.buffer)).toBe(true);
    expect(bytesEqual(reconstruct(originSnap, [{ step: T0, iv: null }], A.step).buffer, A.buffer)).toBe(true);
    // Siblings agree at every step before their fork (reconstruct applies an entry on reaching its step).
    for (const s of [T0 + 1, T0 + 100, T1 - 1]) {
      const x = reconstruct(originSnap, path7, s);
      const y = reconstruct(originSnap, [{ step: T0, iv: user }], s);
      expect(bytesEqual(x.buffer, y.buffer)).toBe(true);
    }
    expect(bytesEqual(reconstruct(originSnap, path7, T1).buffer, reconstruct(originSnap, [{ step: T0, iv: user }], T1).buffer)).toBe(false);
  });

  it('the tree describes paths, relations, changes and labels', () => {
    const t = new BranchTree(1, 100);
    t.addLevel(100, [{ a: 2, b: 3, ivA: null, ivB: { kind: 'delay', neuron: 1, ms: 5 } }]);
    t.addLevel(120, [
      { a: 4, b: 5, ivA: null, ivB: { kind: 'nudge', neuron: 2, dv: 0.01 } },
      { a: 6, b: 7, ivA: null, ivB: { kind: 'delay', neuron: 3, ms: 2 } },
    ]);
    expect(t.leaves()).toEqual([4, 5, 6, 7]);
    expect(t.path(7).map((e) => e.step)).toEqual([100, 120]);
    expect(t.changes(4)).toBe(0); // the leftmost leaf is the untouched original
    expect(t.changes(6)).toBe(1);
    expect(t.changes(7)).toBe(2);
    expect(t.lca(4, 5)).toBe(2);
    expect(t.lca(5, 6)).toBe(1);
    expect(BranchTree.label(3)).toBe('B');
    expect(BranchTree.label(13)).toBe('B1·2');
  });

  it('H-tree leaves never overlap, even at 1,024 minds', () => {
    const D = 10;
    const pts: Array<[number, number]> = [];
    for (let k = 1 << D; k < 1 << (D + 1); k++) pts.push(treePosition(k, D));
    expect(new Set(pts.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`)).size).toBe(1024);
    let min = Infinity;
    for (let i = 0; i < 64; i++) for (let j = i + 1; j < pts.length; j++) min = Math.min(min, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
    expect(min).toBeGreaterThanOrEqual(LEAF_SPACING - 1e-9);
  });
});

describe('when did these minds diverge?', () => {
  it('finds the postponed spike as the first divergence, with its exact timing', () => {
    const { unit, at } = nextSpike(atT0);
    const user: Intervention = { kind: 'delay', neuron: unit, ms: 4 };
    const r = findFirstDivergence({
      origin: atT0.snapshot(),
      common: [],
      splitStep: T0,
      pathX: [{ step: T0, iv: null }],
      pathY: [{ step: T0, iv: user }],
      maxSteps: 3000,
      leadSteps: 60,
    });
    expect(r.found).toBe(true);
    expect(r.step).toBe(at); // the step the spike was due
    expect(r.unit).toBe(unit);
    expect(r.stepX).toBe(at);
    expect(r.stepY).toBe(at + 4);
    expect(r.delayMs).toBe(4);
    expect(r.traceable).toBe(true);
    expect(r.cause).toEqual(user);
    expect(r.causeIn).toBe(1);
    expect(r.cascade[0]).toEqual({ step: at, units: 1 });
    for (let k = 1; k < r.cascade.length; k++) expect(r.cascade[k].step).toBeGreaterThanOrEqual(r.cascade[k - 1].step);
    expect(r.replayStep).toBeLessThanOrEqual(r.step);

    // Before the divergence, both minds are bit-identical.
    const X = new Mind(atT0.snapshot());
    const Y = new Mind(atT0.snapshot());
    applyIntervention(Y, user);
    while (X.step < at) {
      step(X);
      step(Y);
      expect(mindDivergence(X, Y).score).toBe(0);
    }
    // The replay snapshot really is that mind at replayStep.
    const atReplay = new Mind(atT0.snapshot());
    replayInto(atReplay, [{ step: T0, iv: null }], r.replayStep);
    expect(bytesEqual(atReplay.buffer, r.snapX!)).toBe(true);
  });

  it('identical minds never diverge, and a change that heals does not count', () => {
    const none = findFirstDivergence({ origin: atT0.snapshot(), common: [], splitStep: T0, pathX: [], pathY: [], maxSteps: 400, leadSteps: 30 });
    expect(none.found).toBe(false);
    // Nudging a unit that is refractory: the reset erases the change before it can matter.
    const m = atT0.clone();
    let u = -1;
    for (let i = 30; i < N_NEURONS; i++) if (m.refr[i] > 1) u = i;
    if (u >= 0) {
      const healed = findFirstDivergence({
        origin: atT0.snapshot(),
        common: [],
        splitStep: T0,
        pathX: [],
        pathY: [{ step: T0, iv: { kind: 'nudge', neuron: u, dv: 0.01 } }],
        maxSteps: 400,
        leadSteps: 30,
      });
      expect(healed.found).toBe(false);
    }
  });
});

describe('pink causal lineage', () => {
  it('pink appears exactly where the altered mind really differs, and traces back along synapses', () => {
    const net = networkFor(SEED);
    const { unit } = nextSpike(atT0);
    const A = atT0.clone();
    const B = atT0.clone();
    const iv: Intervention = { kind: 'delay', neuron: unit, ms: 5 };
    applyIntervention(B, iv);
    const tr = new CausalTrace();
    tr.markRoot(rootNeuron(B, iv), B.step);
    for (let s = 0; s < 260; s++) {
      step(A);
      step(B);
      tr.update(A, B);
      for (let i = 0; i < N_NEURONS; i++) {
        const differs =
          A.v[i] !== B.v[i] || A.ie[i] !== B.ie[i] || A.is[i] !== B.is[i] || A.ii[i] !== B.ii[i] || A.holdUntil[i] !== B.holdUntil[i] || A.lastSpike[i] !== B.lastSpike[i];
        if (!differs && tr.heat[i] < 0.01) expect(tr.pink(i)).toBe(0);
        if (tr.pink(i) > 0 && tr.heat[i] < 0.01) expect(differs).toBe(true);
      }
    }
    expect(tr.gen[unit]).toBe(0);
    expect(tr.mismatched).toBeGreaterThan(5);
    // Every unit of generation g ≥ 1 has a presynaptic unit of generation g − 1 whose changed spike could have reached it.
    for (let i = 0; i < N_NEURONS; i++) {
      const g = tr.gen[i];
      if (g < 1 || tr.firstMismatch[i] < 0) continue;
      let ok = false;
      for (let k = net.inStart[i]; k < net.inStart[i + 1]; k++) {
        const j = net.inSource[k];
        if (tr.gen[j] === g - 1 && tr.firstMismatch[j] >= 0 && tr.firstMismatch[j] + net.inDelay[k] <= tr.firstMismatch[i]) ok = true;
      }
      expect(ok).toBe(true);
      // The recorded cause is one such unit, connected by a real synapse.
      const c = tr.cause[i];
      expect(c).toBeGreaterThanOrEqual(0);
      expect(tr.gen[c]).toBe(g - 1);
      let connected = false;
      for (let k = net.outStart[c]; k < net.outStart[c + 1]; k++) if (net.outTarget[k] === i) connected = true;
      expect(connected).toBe(true);
    }
  });

  it('a control mind compared with itself is never pink', () => {
    const A = atT0.clone();
    const B = atT0.clone();
    const tr = new CausalTrace();
    for (let s = 0; s < 200; s++) {
      step(A);
      step(B);
      tr.update(A, B);
    }
    expect(tr.mismatched).toBe(0);
    for (let i = 0; i < N_NEURONS; i++) expect(tr.pink(i)).toBe(0);
  });
});

describe('many minds', () => {
  it('outcome counts come from simulated states, not from a script', () => {
    const outcomes: number[] = [];
    for (let k = 0; k < 6; k++) {
      const m = atT0.clone();
      applyIntervention(m, autoIntervention(m, 500 + k)!);
      run(m, 3200);
      const o = computeMetrics(m).outcome;
      expect(o).toBe(classifyRates(m.rate));
      outcomes.push(o);
    }
    const t = tallyOutcomes(outcomes);
    expect(t.total).toBe(6);
    expect(t.counts.reduce((a, b) => a + b, 0)).toBe(6);
    for (let o = 0; o <= UNKNOWN; o++) expect(t.counts[o]).toBe(outcomes.filter((x) => x === o).length);
    expect(t.shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // A different set of minds gives the tally of that set.
    expect(tallyOutcomes([0, 0, 3]).counts.slice(0, 4)).toEqual([2, 0, 0, 1]);
  });

  it('the landscape places a mind by its own state', () => {
    const a = landscapeTarget([30, 1, 1, 1, 1, 1], 1);
    const b = landscapeTarget([1, 1, 1, 30, 1, 1], 1);
    const u = landscapeTarget([3, 3, 3, 3, 3, 3], 0);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(0.5);
    expect(Math.hypot(u[0], u[1])).toBeLessThan(Math.hypot(a[0], a[1]));
  });
});

describe('curated networks', () => {
  it('the listed seeds are still undecided about the image (regenerate seeds.ts if the dynamics change)', () => {
    expect(new Set(UNDECIDED_SEEDS).size).toBe(UNDECIDED_SEEDS.length);
    for (const seed of UNDECIDED_SEEDS.slice(0, 2)) {
      const r = measureSensitivity(seed, 10);
      expect(r.p).toBeGreaterThanOrEqual(0.6);
      expect(r.distinct).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('events, packets, edge cases', () => {
  it('spike records are reproducible and do not change the mind', () => {
    const a = atT0.clone();
    const b = atT0.clone();
    const rec = new EventRecorder();
    const rec2 = new EventRecorder();
    const c = atT0.clone();
    for (let i = 0; i < 300; i++) {
      step(a);
      step(b, rec);
      step(c, rec2);
    }
    expect(bytesEqual(a.buffer, b.buffer)).toBe(true);
    expect(rec.events.length).toBeGreaterThan(50);
    expect(rec.events).toEqual(rec2.events);
    expect(rec.events.every((e) => e.type !== EV_SPIKE || (e.a >= 0 && e.a < N_NEURONS))).toBe(true);
  });

  it('packets round-trip a mind at every level of detail', () => {
    const m = run(atT0.clone(), 120);
    for (const lod of [0, LOD_LOW, LOD_HIGH]) {
      const words = PACKET_HEADER + blockWordsFor(lod, 0) + 64;
      const buf = new ArrayBuffer(words * 4);
      const f32 = new Float32Array(buf);
      const u32 = new Uint32Array(buf);
      u32[1] = 1;
      writeMindBlock(m, 7, lod, m.evTotal, null, f32, u32, new Uint8Array(buf), PACKET_HEADER);
      const out: MindFrame[] = [];
      decodePacket(buf, out);
      expect(out).toHaveLength(1);
      expect(out[0].key).toBe(7);
      expect(out[0].step).toBe(m.step);
      if (lod === LOD_HIGH) {
        expect(out[0].n).toBe(N_NEURONS);
        expect(out[0].units[UNIT_STRIDE * 40]).toBeCloseTo(m.v[40], 5);
        expect(out[0].fieldRes).toBe(48);
      } else expect(out[0].n).toBe(0);
    }
  });

  it('a silenced mind keeps running and reads as unknown', () => {
    const m = createMind(SEED);
    m.v.fill(-50);
    m.ii.fill(500);
    run(m, 100);
    const mm = computeMetrics(m);
    expect(mm.outcome).toBe(UNKNOWN);
    expect(Number.isFinite(mm.activity)).toBe(true);
  });

  it('dsin/dcos track Math.sin/cos and share links round-trip', () => {
    for (let x = -50; x < 50; x += 0.137) {
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(1e-6);
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(1e-6);
    }
    const spec = { seed: 81723, originStep: 2900, neuron: 211, ms: 5, key: 1337, step: 9000, levelSteps: [2900, 2925, 2950, 2975, 3000, 3025, 3050, 3075, 3100, 3125] };
    expect(decodeShare('#f=' + encodeShare(spec))).toEqual(spec);
    expect(decodeShare('#f=garbage')).toBeNull();
  });
});
