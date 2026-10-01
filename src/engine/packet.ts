import {
  EVENT_RING,
  FIELD_N,
  KIND_HUNTER,
  MAX_REMNANTS,
  METRIC_COUNT,
  computeMetrics,
  encodeMetrics,
  type World,
} from '../sim';

/**
 * Render packets: what a simulation worker sends the main thread each frame.
 *
 * One ArrayBuffer per worker per frame, read through Float32 / Uint32 views.
 * Everything is 4-byte words. Per world:
 *
 *   header   HEADER_WORDS  key, lod, nAgents, nRemnants, fieldRes, nEvents, blockWords, step
 *   metrics  METRIC_COUNT
 *   agents   nAgents × AGENT_STRIDE   x y vx vy energy hue code flash
 *   ids      nAgents                  (LOD ≥ 2)
 *   remnants nRemnants × REMNANT_STRIDE  x y strength hue linkX linkY
 *   events   nEvents × EVENT_STRIDE      type x y lineage
 *   field    fieldRes² × 2 bytes (resource, fertility), padded to words
 *
 * Agent `code` = kind + 2·lineage; the renderer adds 16·tileIndex. `flash` is
 * 0→1 over an organism's first two seconds of life (grazers) or the share of
 * its rest remaining after a catch (hunters).
 */

export const HEADER_WORDS = 8;
export const AGENT_STRIDE = 8;
export const REMNANT_STRIDE = 6;
export const EVENT_STRIDE = 4;
export const PACKET_HEADER = 4;

/** Level of detail requested for a world. */
export const LOD_NONE = 0; // metrics only (off-screen)
export const LOD_LOW = 1; // agents + 16² field
export const LOD_HIGH = 2; // + ids, remnants, 48² field

export const LOW_FIELD = 16;

function fieldResFor(lod: number): number {
  return lod >= LOD_HIGH ? FIELD_N : lod >= LOD_LOW ? LOW_FIELD : 0;
}

export function blockWordsFor(w: World, lod: number, nEvents: number): number {
  const n = lod >= LOD_LOW ? w.n : 0;
  let words = HEADER_WORDS + METRIC_COUNT + n * AGENT_STRIDE;
  if (lod >= LOD_HIGH) words += n + MAX_REMNANTS * REMNANT_STRIDE;
  words += nEvents * EVENT_STRIDE;
  const fr = fieldResFor(lod);
  words += Math.ceil((fr * fr * 2) / 4);
  return words;
}

export function newEventCount(w: World, lastTotal: number, lod: number): number {
  if (lod < LOD_LOW) return 0;
  return Math.min(EVENT_RING, Math.max(0, w.evTotal - lastTotal));
}

/** Writes one world block at word offset `o`; returns the next offset. */
export function writeWorldBlock(
  w: World,
  key: number,
  lod: number,
  lastEvTotal: number,
  f32: Float32Array,
  u32: Uint32Array,
  u8: Uint8Array,
  o: number,
): number {
  const nEvents = newEventCount(w, lastEvTotal, lod);
  const words = blockWordsFor(w, lod, nEvents);
  const n = lod >= LOD_LOW ? w.n : 0;
  const fr = fieldResFor(lod);
  let nRem = 0;

  let p = o + HEADER_WORDS;
  encodeMetrics(w, computeMetrics(w), f32, p);
  p += METRIC_COUNT;

  const s = w.step;
  for (let i = 0; i < n; i++) {
    const k = p + i * AGENT_STRIDE;
    f32[k] = w.x[i];
    f32[k + 1] = w.y[i];
    f32[k + 2] = w.vx[i];
    f32[k + 3] = w.vy[i];
    f32[k + 4] = w.e[i];
    f32[k + 5] = w.gHue[i];
    const hunter = w.kind[i] === KIND_HUNTER;
    f32[k + 6] = w.kind[i] + 2 * w.lin[i];
    if (hunter) f32[k + 7] = w.cool[i] / 300;
    else f32[k + 7] = w.born[i] < 0 ? 1 : Math.min(1, (s - w.born[i]) / 120);
  }
  p += n * AGENT_STRIDE;

  if (lod >= LOD_HIGH) {
    for (let i = 0; i < n; i++) u32[p + i] = w.id[i];
    p += n;
    const remStart = p;
    for (let k = 0; k < MAX_REMNANTS; k++) {
      if (!w.rAlive[k]) continue;
      const q = remStart + nRem * REMNANT_STRIDE;
      f32[q] = w.rx[k];
      f32[q + 1] = w.ry[k];
      f32[q + 2] = w.rs[k];
      f32[q + 3] = w.rHue[k];
      const l = w.rLink[k];
      if (l >= 0 && w.rAlive[l] && w.rId[l] === w.rLinkId[k]) {
        f32[q + 4] = w.rx[l];
        f32[q + 5] = w.ry[l];
      } else {
        f32[q + 4] = NaN;
        f32[q + 5] = NaN;
      }
      nRem++;
    }
    p += MAX_REMNANTS * REMNANT_STRIDE;
  }

  for (let k = 0; k < nEvents; k++) {
    const h = (w.evHead - nEvents + k + EVENT_RING) % EVENT_RING;
    const q = p + k * EVENT_STRIDE;
    f32[q] = w.evType[h];
    f32[q + 1] = w.evX[h];
    f32[q + 2] = w.evY[h];
    f32[q + 3] = w.evLin[h];
  }
  p += nEvents * EVENT_STRIDE;

  if (fr > 0) {
    const b = p * 4;
    if (fr === FIELD_N) {
      for (let c = 0; c < FIELD_N * FIELD_N; c++) {
        const r = w.res[c];
        const fe = w.fert[c];
        u8[b + c * 2] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255 + 0.5) | 0;
        u8[b + c * 2 + 1] = fe <= 0 ? 0 : fe >= 2.5 ? 255 : ((fe / 2.5) * 255 + 0.5) | 0;
      }
    } else {
      const k = FIELD_N / fr;
      const inv = 1 / (k * k);
      for (let j = 0; j < fr; j++) {
        for (let i = 0; i < fr; i++) {
          let r = 0;
          let fe = 0;
          for (let dj = 0; dj < k; dj++) {
            const row = (j * k + dj) * FIELD_N + i * k;
            for (let di = 0; di < k; di++) {
              r += w.res[row + di];
              fe += w.fert[row + di];
            }
          }
          r *= inv;
          fe *= inv;
          const c = j * fr + i;
          u8[b + c * 2] = r >= 1 ? 255 : (r * 255 + 0.5) | 0;
          u8[b + c * 2 + 1] = fe >= 2.5 ? 255 : ((fe / 2.5) * 255 + 0.5) | 0;
        }
      }
    }
  }

  u32[o] = key;
  u32[o + 1] = lod;
  u32[o + 2] = n;
  u32[o + 3] = nRem;
  u32[o + 4] = fr;
  u32[o + 5] = nEvents;
  u32[o + 6] = words;
  u32[o + 7] = s;
  return o + words;
}

/** A decoded view of one world in a packet. All arrays are views into the packet buffer. */
export interface WorldFrame {
  key: number;
  lod: number;
  step: number;
  n: number;
  metrics: Float32Array;
  agents: Float32Array;
  ids: Uint32Array | null;
  nRemnants: number;
  remnants: Float32Array | null;
  nEvents: number;
  events: Float32Array;
  fieldRes: number;
  field: Uint8Array | null;
}

export function decodePacket(buf: ArrayBuffer, out: WorldFrame[]): number {
  const u32 = new Uint32Array(buf);
  const f32 = new Float32Array(buf);
  const count = u32[1];
  const step = u32[2];
  let o = PACKET_HEADER;
  for (let k = 0; k < count; k++) {
    const key = u32[o];
    const lod = u32[o + 1];
    const n = u32[o + 2];
    const nRem = u32[o + 3];
    const fr = u32[o + 4];
    const nEv = u32[o + 5];
    const words = u32[o + 6];
    let p = o + HEADER_WORDS;
    const metrics = f32.subarray(p, p + METRIC_COUNT);
    p += METRIC_COUNT;
    const agents = f32.subarray(p, p + n * AGENT_STRIDE);
    p += n * AGENT_STRIDE;
    let ids: Uint32Array | null = null;
    let remnants: Float32Array | null = null;
    if (lod >= LOD_HIGH) {
      ids = u32.subarray(p, p + n);
      p += n;
      remnants = f32.subarray(p, p + nRem * REMNANT_STRIDE);
      p += MAX_REMNANTS * REMNANT_STRIDE;
    }
    const events = f32.subarray(p, p + nEv * EVENT_STRIDE);
    p += nEv * EVENT_STRIDE;
    const field = fr > 0 ? new Uint8Array(buf, p * 4, fr * fr * 2) : null;
    out.push({
      key,
      lod,
      step: u32[o + 7],
      n,
      metrics,
      agents,
      ids,
      nRemnants: nRem,
      remnants,
      nEvents: nEv,
      events,
      fieldRes: fr,
      field,
    });
    o += words;
  }
  return step;
}
