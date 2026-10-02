import {
  EVENT_RING,
  METRIC_COUNT,
  M_PAIR_DIFF,
  M_PAIR_DIV,
  M_PAIR_EVER,
  M_PAIR_GEN,
  M_PAIR_ON,
  N_NEURONS,
  computeMetrics,
  divergenceOf,
  encodeMetrics,
  networkFor,
  type CausalTrace,
  type Mind,
  type Network,
} from '../sim';

/**
 * Render packets: what a simulation worker sends the main thread each frame.
 *
 * One ArrayBuffer per worker per frame, read through Float32 / Uint32 views.
 * Everything is 4-byte words. Per mind:
 *
 *   header   HEADER_WORDS  key, lod, nUnits, fieldRes, nEvents, blockWords, step, flags
 *   metrics  METRIC_COUNT
 *   units    nUnits × UNIT_STRIDE   potential, activation, since, pink, cause   (LOD_HIGH)
 *   events   nEvents × EVENT_STRIDE type, step, a
 *   field    fieldRes² × 2 bytes (activity, pink), padded to words
 *
 * `since` is milliseconds since the unit last fired (capped), or, while a
 * postponed spike is being held back, minus the milliseconds until it is
 * released. `pink` is the unit's causal lineage (0 unless the mind is being
 * compared with a control twin); `cause` is the presynaptic unit its change
 * was traced to (−1 none).
 */

export const HEADER_WORDS = 8;
export const UNIT_STRIDE = 5;
export const EVENT_STRIDE = 3;
export const PACKET_HEADER = 4;
export const SINCE_CAP = 999;

export const FLAG_PAIRED = 1;

/** Level of detail requested for a mind. */
export const LOD_NONE = 0; // metrics only (off-screen)
export const LOD_LOW = 1; // + 16² activity field
export const LOD_HIGH = 2; // + every unit, events, 48² field

export const LOW_FIELD = 16;
export const HIGH_FIELD = 48;

function fieldResFor(lod: number): number {
  return lod >= LOD_HIGH ? HIGH_FIELD : lod >= LOD_LOW ? LOW_FIELD : 0;
}

export function blockWordsFor(lod: number, nEvents: number): number {
  let words = HEADER_WORDS + METRIC_COUNT;
  if (lod >= LOD_HIGH) words += N_NEURONS * UNIT_STRIDE;
  words += nEvents * EVENT_STRIDE;
  const fr = fieldResFor(lod);
  words += Math.ceil((fr * fr * 2) / 4);
  return words;
}

export function newEventCount(m: Mind, lastTotal: number, lod: number): number {
  if (lod < LOD_LOW) return 0;
  return Math.min(EVENT_RING, Math.max(0, m.evTotal - lastTotal));
}

// ---- activity field ----------------------------------------------------------------

interface Splat {
  idx: Int32Array; // 4 per unit
  w: Float32Array; // 4 per unit
}
const splats = new Map<string, Splat>();

function splatFor(net: Network, res: number): Splat {
  const key = `${net.seed}:${res}`;
  let s = splats.get(key);
  if (s) return s;
  if (splats.size > 8) splats.clear();
  const n = net.n;
  s = { idx: new Int32Array(n * 4), w: new Float32Array(n * 4) };
  for (let i = 0; i < n; i++) {
    const fx = ((net.x[i] + 1) / 2) * res - 0.5;
    const fy = ((net.y[i] + 1) / 2) * res - 0.5;
    const ix = Math.max(0, Math.min(res - 2, Math.floor(fx)));
    const iy = Math.max(0, Math.min(res - 2, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - ix));
    const ty = Math.min(1, Math.max(0, fy - iy));
    const c = iy * res + ix;
    s.idx.set([c, c + 1, c + res, c + res + 1], i * 4);
    s.w.set([(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty], i * 4);
  }
  splats.set(key, s);
  return s;
}

let fieldA = new Float32Array(HIGH_FIELD * HIGH_FIELD);
let fieldP = new Float32Array(HIGH_FIELD * HIGH_FIELD);
let tmp = new Float32Array(HIGH_FIELD * HIGH_FIELD);

function blur(f: Float32Array, res: number): void {
  if (tmp.length < f.length) tmp = new Float32Array(f.length);
  for (let j = 0; j < res; j++) {
    const r = j * res;
    for (let i = 0; i < res; i++) {
      const l = i > 0 ? f[r + i - 1] : f[r + i];
      const h = i < res - 1 ? f[r + i + 1] : f[r + i];
      tmp[r + i] = 0.25 * l + 0.5 * f[r + i] + 0.25 * h;
    }
  }
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const c = j * res + i;
      const l = j > 0 ? tmp[c - res] : tmp[c];
      const h = j < res - 1 ? tmp[c + res] : tmp[c];
      f[c] = 0.25 * l + 0.5 * tmp[c] + 0.25 * h;
    }
  }
}

function writeField(m: Mind, net: Network, res: number, trace: CausalTrace | null, u8: Uint8Array, byteOffset: number): void {
  const cells = res * res;
  if (fieldA.length < cells) {
    fieldA = new Float32Array(cells);
    fieldP = new Float32Array(cells);
  }
  fieldA.fill(0, 0, cells);
  fieldP.fill(0, 0, cells);
  const sp = splatFor(net, res);
  const n = N_NEURONS;
  const t = m.step;
  for (let i = 0; i < n; i++) {
    // Activation, plus a flash for units that have just fired.
    const since = t - 1 - m.lastSpike[i];
    const a = m.trace[i] * 0.35 + (since < 12 ? (12 - since) / 12 : 0);
    const p = trace ? trace.pink(i) : 0;
    for (let k = 0; k < 4; k++) {
      const c = sp.idx[i * 4 + k];
      const w = sp.w[i * 4 + k];
      fieldA[c] += a * w;
      if (p > 0) fieldP[c] += p * w;
    }
  }
  const fa = fieldA.subarray(0, cells);
  const fp = fieldP.subarray(0, cells);
  blur(fa, res);
  blur(fp, res);
  if (res > LOW_FIELD) {
    blur(fa, res);
    blur(fp, res);
  }
  // Fewer cells collect more units each: scale so both resolutions read alike.
  const ka = (res * res) / (HIGH_FIELD * HIGH_FIELD) * 2.2;
  const kp = (res * res) / (HIGH_FIELD * HIGH_FIELD) * 3.5;
  for (let c = 0; c < cells; c++) {
    const a = fa[c] / ka;
    const p = fp[c] / kp;
    u8[byteOffset + c * 2] = a <= 0 ? 0 : a >= 1 ? 255 : (a * 255 + 0.5) | 0;
    u8[byteOffset + c * 2 + 1] = p <= 0 ? 0 : p >= 1 ? 255 : (p * 255 + 0.5) | 0;
  }
}

/** Optional comparison with a control twin, for minds being watched in pairs. */
export interface PairInfo {
  control: Mind;
  trace: CausalTrace;
}

/** Writes one mind block at word offset `o`; returns the next offset. */
export function writeMindBlock(
  m: Mind,
  key: number,
  lod: number,
  lastEvTotal: number,
  pair: PairInfo | null,
  f32: Float32Array,
  u32: Uint32Array,
  u8: Uint8Array,
  o: number,
): number {
  const nEvents = newEventCount(m, lastEvTotal, lod);
  const words = blockWordsFor(lod, nEvents);
  const fr = fieldResFor(lod);
  const n = lod >= LOD_HIGH ? N_NEURONS : 0;
  const net = networkFor(m.seed);

  let p = o + HEADER_WORDS;
  encodeMetrics(computeMetrics(m), f32, p);
  if (pair) {
    const d = divergenceOf(m.trace, pair.control.trace, m.v, pair.control.v, m.rate, pair.control.rate);
    f32[p + M_PAIR_DIV] = d.score;
    f32[p + M_PAIR_DIFF] = pair.trace.differing;
    f32[p + M_PAIR_EVER] = pair.trace.mismatched;
    f32[p + M_PAIR_GEN] = pair.trace.maxGen;
    f32[p + M_PAIR_ON] = 1;
  }
  p += METRIC_COUNT;

  const t = m.step;
  for (let i = 0; i < n; i++) {
    const k = p + i * UNIT_STRIDE;
    f32[k] = m.v[i];
    f32[k + 1] = m.trace[i];
    const hu = m.holdUntil[i];
    if (hu >= t) f32[k + 2] = -(hu - t + 1);
    else {
      const since = t - 1 - m.lastSpike[i];
      f32[k + 2] = since > SINCE_CAP ? SINCE_CAP : since;
    }
    f32[k + 3] = pair ? pair.trace.pink(i) : 0;
    f32[k + 4] = pair ? pair.trace.cause[i] : -1;
  }
  p += n * UNIT_STRIDE;

  for (let k = 0; k < nEvents; k++) {
    const h = (m.evHead - nEvents + k + EVENT_RING) % EVENT_RING;
    const q = p + k * EVENT_STRIDE;
    f32[q] = m.evType[h];
    f32[q + 1] = m.evStep[h];
    f32[q + 2] = m.evA[h];
  }
  p += nEvents * EVENT_STRIDE;

  if (fr > 0) writeField(m, net, fr, pair ? pair.trace : null, u8, p * 4);

  u32[o] = key;
  u32[o + 1] = lod;
  u32[o + 2] = n;
  u32[o + 3] = fr;
  u32[o + 4] = nEvents;
  u32[o + 5] = words;
  u32[o + 6] = t;
  u32[o + 7] = pair ? FLAG_PAIRED : 0;
  return o + words;
}

/** A decoded view of one mind in a packet. All arrays are views into the packet buffer. */
export interface MindFrame {
  key: number;
  lod: number;
  step: number;
  n: number;
  paired: boolean;
  metrics: Float32Array;
  units: Float32Array;
  nEvents: number;
  events: Float32Array;
  fieldRes: number;
  field: Uint8Array | null;
}

export function decodePacket(buf: ArrayBuffer, out: MindFrame[]): number {
  const u32 = new Uint32Array(buf);
  const f32 = new Float32Array(buf);
  const count = u32[1];
  const step = u32[2];
  let o = PACKET_HEADER;
  for (let k = 0; k < count; k++) {
    const key = u32[o];
    const lod = u32[o + 1];
    const n = u32[o + 2];
    const fr = u32[o + 3];
    const nEv = u32[o + 4];
    const words = u32[o + 5];
    let p = o + HEADER_WORDS;
    const metrics = f32.subarray(p, p + METRIC_COUNT);
    p += METRIC_COUNT;
    const units = f32.subarray(p, p + n * UNIT_STRIDE);
    p += n * UNIT_STRIDE;
    const events = f32.subarray(p, p + nEv * EVENT_STRIDE);
    p += nEv * EVENT_STRIDE;
    const field = fr > 0 ? new Uint8Array(buf, p * 4, fr * fr * 2) : null;
    out.push({
      key,
      lod,
      step: u32[o + 6],
      n,
      paired: (u32[o + 7] & FLAG_PAIRED) !== 0,
      metrics,
      units,
      nEvents: nEv,
      events,
      fieldRes: fr,
      field,
    });
    o += words;
  }
  return step;
}
