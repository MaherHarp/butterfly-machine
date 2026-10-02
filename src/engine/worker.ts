/// <reference lib="webworker" />
import { CausalTrace, Mind, N_NEURONS, applyIntervention, autoIntervention, rootNeuron, seedMind, step, type Intervention } from '../sim';
import { findFirstDivergence, reconstruct, replayInto, resolveIntervention, type PathEntry } from '../sim/replay';
import { PACKET_HEADER, blockWordsFor, newEventCount, writeMindBlock, type PairInfo } from './packet';
import type { ToMain, ToWorker } from './protocol';

/**
 * Simulation worker. Owns a set of minds (keyed by their place in the branch
 * tree), steps them in lockstep when told to, and answers with one render
 * packet. Two minds can be paired: they are then stepped together and
 * compared after every step, which is how the pink lineage is computed.
 * Knows nothing about rendering or the experience.
 */

interface Slot {
  mind: Mind;
  /** evTotal already reported, so each event is sent once. */
  lastEv: number;
  /** Interventions still to apply as the mind reaches their steps (replays only). */
  schedule: PathEntry[];
}

interface Pair {
  control: number;
  altered: number;
  trace: CausalTrace;
}

const minds = new Map<number, Slot>();
const pairs: Pair[] = [];
const spare: ArrayBuffer[] = [];

const post = (msg: ToMain, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

function applySchedule(slot: Slot, onApply?: (iv: Intervention) => void): void {
  const m = slot.mind;
  while (slot.schedule.length && slot.schedule[0].step <= m.step) {
    const e = slot.schedule.shift()!;
    if (e.step === m.step) {
      const iv = resolveIntervention(m, e.iv);
      if (iv && applyIntervention(m, iv)) onApply?.(iv);
    }
  }
}

function stepSlot(slot: Slot, to: number): void {
  const m = slot.mind;
  while (m.step < to) {
    if (slot.schedule.length) applySchedule(slot);
    step(m);
  }
}

function stepPair(p: Pair, to: number): void {
  const a = minds.get(p.control);
  const b = minds.get(p.altered);
  if (!a || !b) return;
  while (a.mind.step < to) {
    const s = a.mind.step;
    const mark = (m: Mind) => (iv: Intervention) => p.trace.markRoot(rootNeuron(m, iv), s);
    if (a.schedule.length) applySchedule(a, mark(a.mind));
    if (b.schedule.length) applySchedule(b, mark(b.mind));
    step(a.mind);
    step(b.mind);
    p.trace.update(a.mind, b.mind);
  }
}

function pairOf(key: number): Pair | undefined {
  return pairs.find((p) => p.altered === key);
}

function inPair(key: number): boolean {
  return pairs.some((p) => p.altered === key || p.control === key);
}

function unpair(key: number): void {
  for (let i = pairs.length - 1; i >= 0; i--) if (pairs[i].altered === key || pairs[i].control === key) pairs.splice(i, 1);
}

function takeBuffer(bytes: number): ArrayBuffer {
  for (let i = 0; i < spare.length; i++) {
    if (spare[i].byteLength >= bytes && spare[i].byteLength <= bytes * 2) return spare.splice(i, 1)[0];
  }
  return new ArrayBuffer(Math.ceil((bytes * 1.25) / 4096) * 4096);
}

function packet(req: number, lod: Uint8Array, defaultLod: number): void {
  let words = PACKET_HEADER;
  const entries: Array<[number, Slot, number, PairInfo | null]> = [];
  for (const [key, slot] of minds) {
    const l = key < lod.length ? lod[key] : defaultLod;
    const nEv = newEventCount(slot.mind, slot.lastEv, l);
    words += blockWordsFor(l, nEv);
    const p = pairOf(key);
    const ctl = p ? minds.get(p.control) : undefined;
    entries.push([key, slot, l, p && ctl ? { control: ctl.mind, trace: p.trace } : null]);
  }
  const buf = takeBuffer(words * 4);
  const f32 = new Float32Array(buf);
  const u32 = new Uint32Array(buf);
  const u8 = new Uint8Array(buf);
  let o = PACKET_HEADER;
  let st = 0;
  for (const [key, slot, l, pair] of entries) {
    o = writeMindBlock(slot.mind, key, l, slot.lastEv, pair, f32, u32, u8, o);
    if (l >= 1) slot.lastEv = slot.mind.evTotal;
    st = slot.mind.step;
  }
  u32[0] = 0xb7f1;
  u32[1] = entries.length;
  u32[2] = st;
  u32[3] = o;
  post({ t: 'packet', req, buf }, [buf]);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.t) {
    case 'seed': {
      const w = seedMind(m.seed);
      minds.set(m.key, { mind: w, lastEv: w.evTotal, schedule: [] });
      post({ t: 'done', req: m.req, step: w.step });
      break;
    }
    case 'load': {
      const w = new Mind(m.buf);
      minds.set(m.key, { mind: w, lastEv: w.evTotal, schedule: [...(m.schedule ?? [])].sort((a, b) => a.step - b.step) });
      post({ t: 'done', req: m.req, step: w.step });
      break;
    }
    case 'snapshot': {
      const slot = minds.get(m.key);
      const buf = slot ? slot.mind.snapshot() : new ArrayBuffer(0);
      post({ t: 'snapshot', req: m.req, buf, step: slot?.mind.step ?? -1 }, [buf]);
      break;
    }
    case 'apply': {
      const slot = minds.get(m.key);
      const ok = slot ? applyIntervention(slot.mind, m.iv) : false;
      if (ok && slot) for (const p of pairs) if (p.altered === m.key || p.control === m.key) p.trace.markRoot(rootNeuron(slot.mind, m.iv), slot.mind.step);
      post({ t: 'done', req: m.req, step: slot?.mind.step ?? -1, ok });
      break;
    }
    case 'split': {
      // Each parent continues as child a (in place, unchanged unless told otherwise); a copy becomes child b.
      const results: Array<{ parent: number; ivA: Intervention | null; ivB: Intervention | null; buf?: ArrayBuffer }> = [];
      const transfer: ArrayBuffer[] = [];
      for (const sp of m.splits) {
        const slot = minds.get(sp.parent);
        if (!slot) continue;
        const w = slot.mind;
        let ivA: Intervention | null;
        let ivB: Intervention | null;
        if (sp.mode === 'auto') {
          ivA = null;
          ivB = autoIntervention(w, sp.parent);
        } else {
          ivA = sp.ivA ?? null;
          ivB = sp.ivB ?? null;
        }
        const b = w.clone();
        if (ivA && !applyIntervention(w, ivA)) ivA = null;
        if (ivB && !applyIntervention(b, ivB)) ivB = null;
        if (inPair(sp.parent)) unpair(sp.parent);
        minds.delete(sp.parent);
        minds.set(sp.a, { mind: w, lastEv: slot.lastEv, schedule: [] });
        if (sp.ship && !sp.pair) {
          const buf = b.buffer;
          transfer.push(buf);
          results.push({ parent: sp.parent, ivA, ivB, buf });
        } else {
          minds.set(sp.b, { mind: b, lastEv: slot.lastEv, schedule: [] });
          results.push({ parent: sp.parent, ivA, ivB });
          if (sp.pair) {
            const trace = new CausalTrace();
            if (ivB) trace.markRoot(rootNeuron(b, ivB), b.step);
            if (ivA) trace.markRoot(rootNeuron(w, ivA), w.step);
            pairs.push({ control: sp.a, altered: sp.b, trace });
          }
        }
      }
      post({ t: 'split', req: m.req, results }, transfer);
      break;
    }
    case 'pair': {
      unpair(m.altered);
      const trace = m.trace ? new CausalTrace(m.trace) : new CausalTrace();
      for (const r of m.roots ?? []) trace.markRoot(r.neuron, r.step);
      pairs.push({ control: m.control, altered: m.altered, trace });
      post({ t: 'done', req: m.req, step: minds.get(m.altered)?.mind.step ?? -1 });
      break;
    }
    case 'peek': {
      // When will each unit next fire, if nothing is changed? (Used to offer a spike to postpone.)
      const slot = minds.get(m.key);
      const next = new Int32Array(N_NEURONS).fill(-1);
      if (slot) {
        const c = slot.mind.clone();
        const s0 = c.step;
        for (let k = 0; k < m.horizon; k++) {
          const s = c.step;
          step(c);
          for (let f = 0; f < c.firedCount; f++) {
            const i = c.fired[f];
            if (next[i] < 0) next[i] = s;
          }
        }
        post({ t: 'peek', req: m.req, step: s0, next }, [next.buffer]);
      } else post({ t: 'peek', req: m.req, step: -1, next }, [next.buffer]);
      break;
    }
    case 'advance': {
      if (m.recycle) spare.push(m.recycle);
      while (spare.length > 4) spare.shift();
      for (const p of pairs) stepPair(p, m.to);
      for (const [key, slot] of minds) if (!inPair(key)) stepSlot(slot, m.to);
      packet(m.req, m.lod, m.defaultLod);
      break;
    }
    case 'drop': {
      for (const k of m.keys) {
        unpair(k);
        minds.delete(k);
      }
      post({ t: 'done', req: m.req, step: -1 });
      break;
    }
    case 'reset': {
      minds.clear();
      pairs.length = 0;
      post({ t: 'done', req: m.req, step: -1 });
      break;
    }
    case 'firstDiff': {
      const r = findFirstDivergence(m.request);
      const transfer: ArrayBuffer[] = [];
      if (r.snapX) transfer.push(r.snapX);
      if (r.snapY) transfer.push(r.snapY);
      if (r.snapTrace) transfer.push(r.snapTrace);
      post({ t: 'firstDiff', req: m.req, result: r }, transfer);
      break;
    }
    case 'reconstruct': {
      const w = m.origin ? reconstruct(m.origin, m.path, m.target) : seedMind(m.seed ?? 0);
      if (!m.origin) replayInto(w, m.path, m.target);
      post({ t: 'snapshot', req: m.req, buf: w.buffer, step: w.step }, [w.buffer]);
      break;
    }
  }
};
