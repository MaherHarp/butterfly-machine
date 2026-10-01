import { describe, expect, it } from 'vitest';
import {
  EV_BIRTH,
  EV_TOUCH,
  EventRecorder,
  MAX_AGENTS,
  N_LINEAGES,
  World,
  applyIntervention,
  autoIntervention,
  computeMetrics,
  dcos,
  dsin,
  negate,
  seedWorld,
  step,
  worldDivergence,
  type Intervention,
} from '../src/sim';
import { findFirstDifference, reconstruct, replayInto, type PathEntry } from '../src/sim/replay';
import { decodePacket, writeWorldBlock, blockWordsFor, PACKET_HEADER, LOD_HIGH, LOD_LOW, type WorldFrame } from '../src/engine/packet';
import { BranchTree } from '../src/engine/tree';
import { treePosition, LEAF_SPACING } from '../src/experience/layout';
import { decodeShare, encodeShare } from '../src/experience/share';

const SEED = 4242;
const base = seedWorld(SEED);

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function run(w: World, n: number): World {
  for (let i = 0; i < n; i++) step(w);
  return w;
}

function centralGrazer(w: World): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < w.n; i++) {
    if (w.kind[i] !== 0) continue;
    const d = w.x[i] ** 2 + w.y[i] ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

describe('determinism', () => {
  it('same seed produces bit-identical worlds', () => {
    const a = run(seedWorld(SEED), 600);
    const b = run(seedWorld(SEED), 600);
    expect(bytesEqual(a.buffer, b.buffer)).toBe(true);
  });

  it('different seeds produce different worlds', () => {
    const a = seedWorld(1);
    const b = seedWorld(2);
    expect(bytesEqual(a.buffer, b.buffer)).toBe(false);
  });

  it('is independent of how steps are grouped into frames', () => {
    const a = run(base.clone(), 720);
    const b = base.clone();
    const chunks = [1, 7, 3, 60, 2, 120, 33, 494];
    for (const c of chunks) run(b, c);
    expect(b.step).toBe(a.step);
    expect(bytesEqual(a.buffer, b.buffer)).toBe(true);
  });

  it('same seed and same intervention evolve identically', () => {
    const iv: Intervention = { kind: 'nudge', id: base.id[centralGrazer(base)], dx: 0.7, dy: -0.2 };
    const a = base.clone();
    const b = base.clone();
    applyIntervention(a, iv);
    applyIntervention(b, iv);
    run(a, 900);
    run(b, 900);
    expect(bytesEqual(a.buffer, b.buffer)).toBe(true);
  });
});

describe('interventions', () => {
  it('a sub-pixel nudge starts tiny and eventually diverges', () => {
    const a = base.clone();
    const b = base.clone();
    const iv: Intervention = { kind: 'nudge', id: b.id[centralGrazer(b)], dx: 0.5, dy: 0 };
    expect(applyIntervention(b, iv)).toBe(true);
    const d0 = worldDivergence(a, b).score;
    expect(d0).toBeGreaterThan(0);
    expect(d0).toBeLessThan(0.001);
    run(a, 60 * 30);
    run(b, 60 * 30);
    const d1 = worldDivergence(a, b).score;
    expect(d1).toBeGreaterThan(0.3);
  });

  it('divergence grows gradually rather than all at once', () => {
    const a = base.clone();
    const b = base.clone();
    applyIntervention(b, { kind: 'nudge', id: b.id[centralGrazer(b)], dx: 0.7, dy: 0 });
    run(a, 120);
    run(b, 120);
    expect(worldDivergence(a, b).score).toBeLessThan(0.05);
  });

  it('every intervention kind applies and negates', () => {
    const id = base.id[0];
    const ivs: Intervention[] = [
      { kind: 'nudge', id, dx: 0.3, dy: 0.1 },
      { kind: 'turn', id, degrees: 0.2 },
      { kind: 'energy', id, fraction: 0.004 },
    ];
    for (const iv of ivs) {
      const w = base.clone();
      expect(applyIntervention(w, iv)).toBe(true);
      expect(bytesEqual(w.buffer, base.buffer)).toBe(false);
      const n = negate(iv);
      expect(n.kind).toBe(iv.kind);
    }
    expect(applyIntervention(base.clone(), { kind: 'nudge', id: 12345, dx: 1, dy: 1 })).toBe(false);
  });

  it('auto interventions are deterministic and tiny', () => {
    const a = autoIntervention(base, 7)!;
    const b = autoIntervention(base, 7)!;
    expect(a).toEqual(b);
    expect(autoIntervention(base, 8)).not.toEqual(a);
    if (a.kind === 'nudge') expect(Math.hypot(a.dx, a.dy)).toBeLessThanOrEqual(0.5);
  });
});

describe('branches and replay', () => {
  it('replay from a snapshot reaches the same state as uninterrupted execution', () => {
    const live = base.clone();
    run(live, 300);
    const snap = live.snapshot();
    run(live, 400);
    const replayed = run(new World(snap), 400);
    expect(bytesEqual(live.buffer, replayed.buffer)).toBe(true);
  });

  it('children preserve their parent history and are rebuilt exactly from paths', () => {
    // Live: origin → split (A, B=user) at T0 → split again at T1 (auto ±).
    const origin = base.clone();
    const T0 = origin.step;
    const originSnap = origin.snapshot();
    const user: Intervention = { kind: 'nudge', id: origin.id[centralGrazer(origin)], dx: 0.4, dy: 0.3 };
    const A = origin.clone();
    const B = origin.clone();
    applyIntervention(B, user);
    run(A, 240);
    run(B, 240);
    const T1 = B.step;
    // B splits into B1 (+δ) and B2 (−δ), as the worker does.
    const B1 = B;
    const B2 = B.clone();
    const auto = autoIntervention(B1, 3)!;
    applyIntervention(B1, auto);
    applyIntervention(B2, negate(auto));
    run(B1, 300);
    run(B2, 300);
    run(A, 300);

    const pathB2: PathEntry[] = [
      { step: T0, iv: user },
      { step: T1, iv: { auto: -1, parentKey: 3 } },
    ];
    const rebuilt = reconstruct(originSnap, pathB2, B2.step);
    expect(bytesEqual(rebuilt.buffer, B2.buffer)).toBe(true);
    const rebuiltA = reconstruct(originSnap, [{ step: T0, iv: null }], A.step);
    expect(bytesEqual(rebuiltA.buffer, A.buffer)).toBe(true);
    // Parent history: B1 and B2 agree up to T1.
    const b1AtT1 = reconstruct(originSnap, [{ step: T0, iv: user }], T1);
    const b2AtT1 = reconstruct(originSnap, [{ step: T0, iv: user }], T1);
    expect(bytesEqual(b1AtT1.buffer, b2AtT1.buffer)).toBe(true);
  });

  it('the tree describes paths, relations and labels', () => {
    const t = new BranchTree(1, 100);
    t.addLevel(100, [{ a: 2, b: 3, ivA: null, ivB: { kind: 'nudge', id: 1, dx: 1, dy: 0 } }]);
    t.addLevel(200, [
      { a: 4, b: 5, ivA: { kind: 'turn', id: 2, degrees: 0.1 }, ivB: { kind: 'turn', id: 2, degrees: -0.1 } },
      { a: 6, b: 7, ivA: { kind: 'energy', id: 3, fraction: 0.001 }, ivB: { kind: 'energy', id: 3, fraction: -0.001 } },
    ]);
    expect(t.leaves()).toEqual([4, 5, 6, 7]);
    expect(t.path(7).map((e) => e.step)).toEqual([100, 200]);
    expect(t.lca(4, 5)).toBe(2);
    expect(t.lca(5, 6)).toBe(1);
    expect(BranchTree.label(1)).toBe('0');
    expect(BranchTree.label(3)).toBe('B');
    expect(BranchTree.label(6)).toBe('B1');
    expect(BranchTree.label(13)).toBe('B1·2');
  });

  it('H-tree leaves never overlap, even at 1,024 futures', () => {
    const D = 10;
    const pts: Array<[number, number]> = [];
    for (let k = 1 << D; k < 1 << (D + 1); k++) pts.push(treePosition(k, D));
    const set = new Set(pts.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`));
    expect(set.size).toBe(1024);
    let min = Infinity;
    for (let i = 0; i < 64; i++) for (let j = i + 1; j < pts.length; j++) min = Math.min(min, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
    expect(min).toBeGreaterThanOrEqual(LEAF_SPACING - 1e-9);
    expect(min).toBeGreaterThan(2);
  });
});

describe('first difference', () => {
  it('locates the earliest discrete divergence with real history', () => {
    const origin = base.clone();
    const T0 = origin.step;
    const user: Intervention = { kind: 'nudge', id: origin.id[centralGrazer(origin)], dx: 0.7, dy: 0 };
    const r = findFirstDifference({
      origin: origin.snapshot(),
      common: [],
      splitStep: T0,
      pathX: [{ step: T0, iv: null }],
      pathY: [{ step: T0, iv: user }],
      maxSteps: 60 * 40,
      leadSteps: 60,
    });
    expect(r.found).toBe(true);
    expect(r.step).toBeGreaterThanOrEqual(T0);
    expect(r.event).not.toBeNull();
    expect(r.replayStep).toBeLessThanOrEqual(r.step);
    expect(r.snapX).not.toBeNull();

    // Before r.step, both worlds' event histories agree exactly.
    const X = new World(origin.snapshot());
    const Y = new World(origin.snapshot());
    applyIntervention(Y, user);
    const rx = new EventRecorder();
    const ry = new EventRecorder();
    while (X.step < r.step) {
      step(X, rx);
      step(Y, ry);
    }
    const key = (e: { type: number; a: number; b: number; step: number }) => `${e.step}:${e.type}:${e.a}:${e.b}`;
    expect(rx.events.map(key).sort()).toEqual(ry.events.map(key).sort());

    // The replay snapshots really are those worlds at replayStep.
    const atReplayX = new World(origin.snapshot());
    replayInto(atReplayX, [{ step: T0, iv: null }], r.replayStep);
    expect(bytesEqual(atReplayX.buffer, r.snapX!)).toBe(true);
  });

  it('identical futures have no first difference', () => {
    const r = findFirstDifference({
      origin: base.snapshot(),
      common: [],
      splitStep: base.step,
      pathX: [],
      pathY: [],
      maxSteps: 200,
      leadSteps: 30,
    });
    expect(r.found).toBe(false);
  });
});

describe('events', () => {
  it('are ordered by step and reproducible', () => {
    const r1 = new EventRecorder();
    const r2 = new EventRecorder();
    const a = base.clone();
    const b = base.clone();
    for (let i = 0; i < 900; i++) {
      step(a, r1);
      step(b, r2);
    }
    expect(r1.events.length).toBeGreaterThan(0);
    expect(r1.events).toEqual(r2.events);
    for (let i = 1; i < r1.events.length; i++) expect(r1.events[i].step).toBeGreaterThanOrEqual(r1.events[i - 1].step);
    expect(r1.events.some((e) => e.type === EV_TOUCH)).toBe(true);
    for (const e of r1.events) {
      expect(e.frac).toBeGreaterThanOrEqual(0);
      expect(e.frac).toBeLessThanOrEqual(1);
    }
    expect(r1.events.filter((e) => e.type === EV_BIRTH).length).toBeGreaterThanOrEqual(0);
  });

  it('recording events does not change the world', () => {
    const a = base.clone();
    const b = base.clone();
    const rec = new EventRecorder();
    for (let i = 0; i < 400; i++) {
      step(a);
      step(b, rec);
    }
    expect(bytesEqual(a.buffer, b.buffer)).toBe(true);
  });
});

describe('metrics', () => {
  it('stay finite and in range over a long run', () => {
    const w = base.clone();
    for (let k = 0; k < 40; k++) {
      run(w, 90);
      const m = computeMetrics(w);
      for (const [name, v] of Object.entries(m)) {
        if (typeof v === 'number') expect(Number.isFinite(v), name).toBe(true);
      }
      expect(m.dominance).toBeGreaterThanOrEqual(0);
      expect(m.dominance).toBeLessThanOrEqual(1);
      expect(m.diversity).toBeLessThanOrEqual(N_LINEAGES + 1e-9);
      expect(m.resource).toBeGreaterThanOrEqual(0);
      expect(m.resource).toBeLessThanOrEqual(1);
    }
  });
});

describe('edge cases', () => {
  it('a world where everything dies keeps running and reads as collapsed', () => {
    const w = base.clone();
    for (let i = 0; i < w.n; i++) w.e[i] = -1;
    step(w);
    expect(w.n).toBe(0);
    run(w, 600);
    const m = computeMetrics(w);
    expect(m.outcome).toBe('collapsed');
    expect(m.grazers).toBe(0);
    const d = worldDivergence(w, w.clone());
    expect(d.score).toBe(0);
  });

  it('a population explosion is capped', () => {
    const w = base.clone();
    for (let k = 0; k < 30; k++) {
      for (let i = 0; i < w.n; i++) w.e[i] = 9;
      step(w);
      expect(w.n).toBeLessThanOrEqual(MAX_AGENTS);
    }
  });

  it('a lone organism never collides', () => {
    const w = base.clone();
    for (let i = 1; i < w.n; i++) w.e[i] = -1;
    step(w);
    expect(w.n).toBe(1);
    const rec = new EventRecorder();
    for (let i = 0; i < 300; i++) step(w, rec);
    expect(rec.events.filter((e) => e.type === EV_TOUCH).length).toBe(0);
  });

  it('a vanishingly small intervention is still deterministic and finite', () => {
    const a = base.clone();
    applyIntervention(a, { kind: 'nudge', id: a.id[0], dx: 1e-12, dy: 0 });
    const b = a.clone();
    run(a, 600);
    run(b, 600);
    expect(bytesEqual(a.buffer, b.buffer)).toBe(true);
    const d = worldDivergence(a, base.clone());
    expect(Number.isFinite(d.score)).toBe(true);
  });
});

describe('packets', () => {
  it('round-trip a world at every level of detail', () => {
    const w = run(base.clone(), 120);
    for (const lod of [0, LOD_LOW, LOD_HIGH]) {
      const words = PACKET_HEADER + blockWordsFor(w, lod, 0) + 64;
      const buf = new ArrayBuffer(words * 4);
      const f32 = new Float32Array(buf);
      const u32 = new Uint32Array(buf);
      const u8 = new Uint8Array(buf);
      u32[1] = 1;
      u32[2] = w.step;
      writeWorldBlock(w, 7, lod, w.evTotal, f32, u32, u8, PACKET_HEADER);
      const out: WorldFrame[] = [];
      decodePacket(buf, out);
      expect(out).toHaveLength(1);
      const f = out[0];
      expect(f.key).toBe(7);
      expect(f.step).toBe(w.step);
      if (lod === 0) expect(f.n).toBe(0);
      else {
        expect(f.n).toBe(w.n);
        expect(f.agents[0]).toBeCloseTo(w.x[0], 3);
      }
      if (lod === LOD_HIGH) {
        expect(f.ids![0]).toBe(w.id[0]);
        expect(f.fieldRes).toBe(48);
      }
    }
  });
});

describe('deterministic math and sharing', () => {
  it('dsin/dcos track Math.sin/cos', () => {
    for (let x = -50; x < 50; x += 0.137) {
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(1e-6);
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(1e-6);
    }
  });

  it('share links round-trip', () => {
    const spec = { seed: 81723, originStep: 2101, id: 3411234567, dx: 0.7312345678901234, dy: -1e-7, key: 1337, step: 9000, levelSteps: [2101, 3300, 3901, 4500, 5100, 5110, 5121, 5133, 5140, 5150] };
    expect(decodeShare('#f=' + encodeShare(spec))).toEqual(spec);
    expect(decodeShare('#f=garbage')).toBeNull();
  });
});
