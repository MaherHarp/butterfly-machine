/// <reference lib="webworker" />
import {
  World,
  applyIntervention,
  autoIntervention,
  negate,
  seedWorld,
  step,
  type Intervention,
} from '../sim';
import { findFirstDifference, reconstruct, replayInto, resolveIntervention, type PathEntry } from '../sim/replay';
import { PACKET_HEADER, blockWordsFor, newEventCount, writeWorldBlock } from './packet';
import type { ToMain, ToWorker } from './protocol';

/**
 * Simulation worker. Owns a set of worlds (keyed by their place in the
 * branch tree), steps them in lockstep when told to, and answers with one
 * render packet. Knows nothing about rendering or the experience.
 */

interface Slot {
  world: World;
  /** evTotal already reported, so each event is sent once. */
  lastEv: number;
  /** Interventions still to apply as the world reaches their steps (replays only). */
  schedule: PathEntry[];
}

const worlds = new Map<number, Slot>();
const spare: ArrayBuffer[] = [];

const post = (msg: ToMain, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

function stepSlot(slot: Slot, to: number): void {
  const w = slot.world;
  while (w.step < to) {
    if (slot.schedule.length) {
      while (slot.schedule.length && slot.schedule[0].step <= w.step) {
        const e = slot.schedule.shift()!;
        if (e.step === w.step) {
          const iv = resolveIntervention(w, e.iv);
          if (iv) applyIntervention(w, iv);
        }
      }
    }
    step(w);
  }
}

function takeBuffer(bytes: number): ArrayBuffer {
  for (let i = 0; i < spare.length; i++) {
    if (spare[i].byteLength >= bytes && spare[i].byteLength <= bytes * 2) {
      return spare.splice(i, 1)[0];
    }
  }
  return new ArrayBuffer(Math.ceil((bytes * 1.25) / 4096) * 4096);
}

function packet(req: number, lod: Uint8Array, defaultLod: number): void {
  let words = PACKET_HEADER;
  const entries: Array<[number, Slot, number, number]> = [];
  for (const [key, slot] of worlds) {
    const l = key < lod.length ? lod[key] : defaultLod;
    const nEv = newEventCount(slot.world, slot.lastEv, l);
    words += blockWordsFor(slot.world, l, nEv);
    entries.push([key, slot, l, nEv]);
  }
  const buf = takeBuffer(words * 4);
  const f32 = new Float32Array(buf);
  const u32 = new Uint32Array(buf);
  const u8 = new Uint8Array(buf);
  let o = PACKET_HEADER;
  let step = 0;
  for (const [key, slot, l] of entries) {
    o = writeWorldBlock(slot.world, key, l, slot.lastEv, f32, u32, u8, o);
    if (l >= 1) slot.lastEv = slot.world.evTotal;
    step = slot.world.step;
  }
  u32[0] = 0xb7f1;
  u32[1] = entries.length;
  u32[2] = step;
  u32[3] = o;
  post({ t: 'packet', req, buf }, [buf]);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.t) {
    case 'seed': {
      const w = seedWorld(m.seed);
      worlds.set(m.key, { world: w, lastEv: w.evTotal, schedule: [] });
      post({ t: 'done', req: m.req, step: w.step });
      break;
    }
    case 'load': {
      const w = new World(m.buf);
      worlds.set(m.key, { world: w, lastEv: w.evTotal, schedule: [...(m.schedule ?? [])].sort((a, b) => a.step - b.step) });
      post({ t: 'done', req: m.req, step: w.step });
      break;
    }
    case 'snapshot': {
      const slot = worlds.get(m.key);
      const buf = slot ? slot.world.snapshot() : new ArrayBuffer(0);
      post({ t: 'snapshot', req: m.req, buf, step: slot?.world.step ?? -1 }, [buf]);
      break;
    }
    case 'apply': {
      const slot = worlds.get(m.key);
      const ok = slot ? applyIntervention(slot.world, m.iv) : false;
      post({ t: 'done', req: m.req, step: slot?.world.step ?? -1, ok });
      break;
    }
    case 'split': {
      // Each parent becomes child a (in place); a copy becomes child b.
      const results: Array<{ parent: number; ivA: Intervention | null; ivB: Intervention | null; buf?: ArrayBuffer }> = [];
      const transfer: ArrayBuffer[] = [];
      for (const sp of m.splits) {
        const slot = worlds.get(sp.parent);
        if (!slot) continue;
        const w = slot.world;
        let ivA: Intervention | null;
        let ivB: Intervention | null;
        if (sp.mode === 'auto') {
          ivA = autoIntervention(w, sp.parent);
          ivB = ivA ? negate(ivA) : null;
        } else {
          ivA = sp.ivA ?? null;
          ivB = sp.ivB ?? null;
        }
        const b = w.clone();
        if (ivA) applyIntervention(w, ivA);
        if (ivB) applyIntervention(b, ivB);
        worlds.delete(sp.parent);
        worlds.set(sp.a, { world: w, lastEv: slot.lastEv, schedule: [] });
        if (sp.ship) {
          const buf = b.buffer;
          transfer.push(buf);
          results.push({ parent: sp.parent, ivA, ivB, buf });
        } else {
          worlds.set(sp.b, { world: b, lastEv: slot.lastEv, schedule: [] });
          results.push({ parent: sp.parent, ivA, ivB });
        }
      }
      post({ t: 'split', req: m.req, results }, transfer);
      break;
    }
    case 'advance': {
      if (m.recycle) spare.push(m.recycle);
      while (spare.length > 4) spare.shift();
      for (const slot of worlds.values()) stepSlot(slot, m.to);
      packet(m.req, m.lod, m.defaultLod);
      break;
    }
    case 'drop': {
      for (const k of m.keys) worlds.delete(k);
      post({ t: 'done', req: m.req, step: -1 });
      break;
    }
    case 'reset': {
      worlds.clear();
      post({ t: 'done', req: m.req, step: -1 });
      break;
    }
    case 'firstDiff': {
      const r = findFirstDifference(m.request);
      const transfer: ArrayBuffer[] = [];
      if (r.snapX) transfer.push(r.snapX);
      if (r.snapY) transfer.push(r.snapY);
      post({ t: 'firstDiff', req: m.req, result: r }, transfer);
      break;
    }
    case 'reconstruct': {
      const w = m.origin ? reconstruct(m.origin, m.path, m.target) : seedWorld(m.seed ?? 0);
      if (!m.origin) replayInto(w, m.path, m.target);
      post({ t: 'snapshot', req: m.req, buf: w.buffer, step: w.step }, [w.buffer]);
      break;
    }
  }
};
