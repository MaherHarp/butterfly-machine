import { CH_DOOR, CH_FIGURE, CH_HOUSE, CH_RAIN, CH_TEXTURE, N_ASSEMBLIES, N_CHANNELS, SENSORY_PER_CHANNEL } from '../sim/constants';
import { AFFINITY, UNKNOWN } from '../sim/network';
import { Rng } from '../sim/hash';
import { NO_MOOD, type Mood } from '../render/renderer';
import type { ShapeBatch } from '../render/shapes';
import { OUTCOME_COLOR } from './format';

/**
 * HOW AN INTERPRETATION LOOKS
 * ===========================
 *
 * The network decides which attractor a mind falls into. This module only
 * decides how that is *shown*: a fixed, consistent mapping from attractor
 * (and how deeply the mind has committed to it) to a visual mood, and to a
 * re-reading of the same ambiguous image. These are artistic metaphors, not
 * claims about what the network "feels".
 *
 *   home       warm, coherent; the house and its lit door come together
 *   loss       the figure wears away; long afterimages; rain stays
 *   fear       trembling, contracted; the silhouette sharpens and grows
 *   safety     an enclosing glow; the figure stands in the light of the door
 *   nostalgia  echoes and ghosts; the house in the rain, repeated
 *   distance   everything drifts apart, smaller and colder
 *   unknown    nothing resolves
 */
const MOODS: Mood[] = [
  { warmth: 1, coherence: 0.9, erasure: 0, agitation: 0, echo: 0, expansion: 0, enclosure: 0.35 },
  { warmth: 0, coherence: 0.1, erasure: 1, agitation: 0, echo: 0.3, expansion: 0.25, enclosure: 0 },
  { warmth: 0, coherence: 0, erasure: 0.15, agitation: 1, echo: 0, expansion: 0, enclosure: 0 },
  { warmth: 0.55, coherence: 0.6, erasure: 0, agitation: 0, echo: 0, expansion: 0, enclosure: 1 },
  { warmth: 0.6, coherence: 0.35, erasure: 0.1, agitation: 0, echo: 1, expansion: 0, enclosure: 0 },
  { warmth: 0, coherence: 0.15, erasure: 0.3, agitation: 0, echo: 0, expansion: 1, enclosure: 0 },
];

export function moodFor(dominant: number, commitment: number): Mood {
  if (dominant < 0 || dominant >= N_ASSEMBLIES || commitment <= 0) return NO_MOOD;
  const m = MOODS[dominant];
  const c = commitment * commitment * (3 - 2 * commitment);
  return {
    warmth: m.warmth * c,
    coherence: m.coherence * c,
    erasure: m.erasure * c,
    agitation: m.agitation * c,
    echo: m.echo * c,
    expansion: m.expansion * c,
    enclosure: m.enclosure * c,
  };
}

/** Smoothly follows a mind's interpretation so the picture never jumps. */
export class MoodFollower {
  dominant = -1;
  commitment = 0;
  update(dominant: number, commitment: number, outcome: number, dt: number): void {
    const target = outcome === UNKNOWN ? commitment * 0.6 : commitment;
    if (dominant !== this.dominant) {
      // Let the old reading fade before the new one rises.
      this.commitment -= Math.min(this.commitment, dt * 0.9);
      if (this.commitment < 0.02 || this.dominant < 0) this.dominant = dominant;
      return;
    }
    const k = 1 - Math.exp(-dt * (target > this.commitment ? 0.9 : 1.6));
    this.commitment += (target - this.commitment) * k;
  }
}

// ---------------------------------------------------------------------------
// The ambiguous image
// ---------------------------------------------------------------------------

interface Stroke {
  c: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Displacement while the image is unresolved. */
  sx: number;
  sy: number;
  h: number;
}

/** Strokes of the five fragments in image coordinates ([-1, 1], y down). */
const STROKES: Stroke[] = (() => {
  const rng = new Rng(0x1ea6e);
  const out: Stroke[] = [];
  const seg = (c: number, x0: number, y0: number, x1: number, y1: number, pieces = 2) => {
    for (let k = 0; k < pieces; k++) {
      const a = k / pieces + 0.04;
      const b = (k + 1) / pieces - 0.04;
      out.push({
        c,
        x0: x0 + (x1 - x0) * a,
        y0: y0 + (y1 - y0) * a,
        x1: x0 + (x1 - x0) * b,
        y1: y0 + (y1 - y0) * b,
        sx: rng.range(-0.3, 0.3),
        sy: rng.range(-0.3, 0.3),
        h: rng.next(),
      });
    }
  };
  // House: roof, walls, ground.
  seg(CH_HOUSE, -0.62, -0.02, 0.02, -0.56, 3);
  seg(CH_HOUSE, 0.02, -0.56, 0.62, -0.02, 3);
  seg(CH_HOUSE, -0.5, -0.04, -0.5, 0.56, 3);
  seg(CH_HOUSE, 0.5, -0.04, 0.5, 0.56, 3);
  seg(CH_HOUSE, -0.62, 0.56, 0.66, 0.56, 4);
  seg(CH_HOUSE, -0.3, 0.08, -0.12, 0.08, 1);
  seg(CH_HOUSE, -0.3, 0.08, -0.3, 0.24, 1);
  // Doorway.
  seg(CH_DOOR, 0.08, 0.14, 0.08, 0.56, 2);
  seg(CH_DOOR, 0.32, 0.14, 0.32, 0.56, 2);
  seg(CH_DOOR, 0.08, 0.14, 0.32, 0.14, 1);
  for (let k = 0; k < 5; k++) {
    const a = -0.5 + k * 0.25;
    seg(CH_DOOR, 0.2 + a * 0.18, 0.58, 0.2 + a * 0.62, 0.86, 1);
  }
  // Figure: head (drawn as a ring), shoulders, body.
  seg(CH_FIGURE, -0.2, 0.17, -0.3, 0.27, 1);
  seg(CH_FIGURE, -0.2, 0.17, -0.1, 0.27, 1);
  seg(CH_FIGURE, -0.3, 0.27, -0.27, 0.56, 2);
  seg(CH_FIGURE, -0.1, 0.27, -0.13, 0.56, 2);
  // Rain.
  for (let k = 0; k < 22; k++) {
    const x = rng.range(-0.9, 0.9);
    const y = rng.range(-0.9, 0.9);
    out.push({ c: CH_RAIN, x0: x, y0: y, x1: x - 0.05, y1: y + 0.17, sx: rng.range(-0.2, 0.2), sy: rng.range(-0.2, 0.2), h: rng.next() });
  }
  // Broken texture.
  for (let k = 0; k < 16; k++) {
    const x = rng.range(-0.85, 0.85);
    const y = rng.range(-0.85, 0.85);
    const a = rng.next() * Math.PI;
    const l = rng.range(0.05, 0.14);
    out.push({ c: CH_TEXTURE, x0: x, y0: y, x1: x + Math.cos(a) * l, y1: y + Math.sin(a) * l, sx: rng.range(-0.3, 0.3), sy: rng.range(-0.3, 0.3), h: rng.next() });
  }
  return out;
})();

const HEAD: [number, number, number] = [-0.2, 0.08, 0.075];

export interface StimulusParams {
  x: number;
  y: number;
  /** Tile radius in plane units. */
  r: number;
  alpha: number;
  /** Stimulus contrast (0–1). */
  level: number;
  dominant: number;
  commitment: number;
  /** Network time in seconds (rain falls in network time). */
  time: number;
  /** Recent firing of each sensory channel (0–1). */
  channel: ArrayLike<number>;
  /** Pixels per plane unit. */
  zoom: number;
}

const ECHOES = [
  [0, 0, 1],
  [-0.09, -0.07, 0.34],
  [-0.18, -0.14, 0.14],
];

/** Draws the image at the centre of a mind, re-read by its interpretation. */
export function drawStimulus(b: ShapeBatch, p: StimulusParams): void {
  if (p.level <= 0.005 || p.alpha <= 0.01) return;
  // What the eye sees appears a little faster than the contrast the network receives.
  const level = Math.sqrt(p.level);
  const R = p.r * 0.205;
  if (R * p.zoom < 14) return;
  const k = p.dominant >= 0 && p.dominant < N_ASSEMBLIES ? p.dominant : -1;
  const c = k >= 0 ? p.commitment * p.commitment * (3 - 2 * p.commitment) : 0;
  const aff = k >= 0 ? AFFINITY[k] : null;
  const tint = k >= 0 ? OUTCOME_COLOR[k] : OUTCOME_COLOR[UNKNOWN];
  const lw = Math.max(0.6, Math.min(1.6, R * p.zoom * 0.012));
  const isFear = k === 2;
  const isSafety = k === 3;
  const isLoss = k === 1;
  const isNostalgia = k === 4;
  const isDistance = k === 5;
  const echoes = isNostalgia ? ECHOES.length : 1;
  const scale = 1 - (isDistance ? 0.38 * c : 0) - (isFear ? 0.08 * c : 0);
  for (let e = 0; e < echoes; e++) {
    const [ex, ey, ea] = ECHOES[e];
    const eA = e === 0 ? 1 : ea * c;
    for (const s of STROKES) {
      const emph = aff ? aff[s.c] : 0.5;
      // Unresolved: fragments scattered. Resolving: what this reading needs comes together, the rest drifts off.
      const together = c * (emph > 0.5 ? 1 : 0);
      const apart = c * (emph > 0.5 ? 0 : 1);
      let amb = 0.55 * (1 - together) + 0.5 * apart;
      if (isDistance) amb += 0.45 * c;
      let ox = s.sx * amb;
      let oy = s.sy * amb;
      if (isFear && s.c !== CH_FIGURE) {
        ox += Math.sin(p.time * 31 + s.h * 40) * 0.025 * c;
        oy += Math.cos(p.time * 27 + s.h * 33) * 0.025 * c;
      }
      let fx = 0;
      let fs = 1;
      if (s.c === CH_FIGURE) {
        if (isSafety) fx = 0.42 * c; // into the light of the door
        if (isFear) fs = 1 + 0.55 * c;
      }
      let rainY = 0;
      if (s.c === CH_RAIN) {
        const speed = isLoss || isNostalgia ? 0.55 : 0.8;
        rainY = ((p.time * speed + s.h) % 1) * 1.8 - 0.9 - s.y0;
      }
      let a = level * (0.32 + 0.4 * (aff ? (emph > 0.5 ? c : -0.6 * c) : 0) + 0.18);
      a *= 0.75 + 0.5 * Math.min(1, p.channel[s.c] ?? 0);
      if (isLoss && s.c === CH_FIGURE) a *= 1 - 0.8 * c;
      if (isLoss && s.c !== CH_RAIN) a *= 1 - 0.55 * c * (s.h > 0.45 ? 1 : 0);
      if (s.c === CH_RAIN && !(isLoss || isNostalgia || isDistance)) a *= 1 - 0.6 * c;
      a = Math.max(0, a) * p.alpha * eA;
      if (a < 0.004) continue;
      const tx = (v: number, y: number): [number, number] => {
        let X = v;
        let Y = y + rainY;
        if (s.c === CH_FIGURE) {
          X = HEAD[0] + (X - HEAD[0]) * fs + fx;
          Y = 0.56 + (Y - 0.56) * fs;
        }
        X = (X + ox) * scale + ex;
        Y = (Y + oy) * scale + ey;
        if (isDistance) {
          X += (X >= 0 ? 1 : -1) * 0.18 * c;
          Y += (Y >= 0 ? 1 : -1) * 0.1 * c;
        }
        return [p.x + X * R, p.y + Y * R];
      };
      const [x0, y0] = tx(s.x0, s.y0);
      const [x1, y1] = tx(s.x1, s.y1);
      const cr = 0.95 + (tint[0] - 0.95) * c * 0.7;
      const cg = 0.92 + (tint[1] - 0.92) * c * 0.7;
      const cb = 0.86 + (tint[2] - 0.86) * c * 0.7;
      b.line(x0, y0, x1, y1, lw * (isFear && s.c === CH_FIGURE ? 1.4 : 1), cr, cg, cb, a, s.c === CH_DOOR ? 1.5 : 0.5);
    }
    // The figure's head and the light of the door.
    const figA = level * p.alpha * eA * (0.5 + (aff ? (aff[CH_FIGURE] > 0.5 ? 0.4 : -0.35) * c : 0)) * (isLoss ? 1 - 0.8 * c : 1);
    const hx = p.x + ((HEAD[0] + (isSafety ? 0.42 * c : 0)) * scale + ex) * R;
    const hy = p.y + ((0.56 + (HEAD[1] - 0.56) * (isFear ? 1 + 0.55 * c : 1)) * scale + ey) * R;
    if (figA > 0.01) b.ring(hx, hy, HEAD[2] * R * (isFear ? 1 + 0.55 * c : 1), lw, 0.95, 0.92, 0.88, figA * 0.8, 0.5);
    const doorLight = level * p.alpha * eA * (0.25 + (aff ? (aff[CH_DOOR] > 0.5 ? 0.6 : -0.2) * c : 0)) * (0.7 + 0.5 * Math.min(1, p.channel[CH_DOOR] ?? 0));
    if (doorLight > 0.01) {
      const dx = p.x + (0.2 * scale + ex) * R;
      const dy = p.y + (0.36 * scale + ey) * R;
      b.disc(dx, dy, R * (0.1 + (isSafety ? 0.12 * c : 0)), 1.0, 0.86, 0.62, doorLight * 0.35, R * p.zoom * 0.08);
    }
  }
}

/** Recent firing of each sensory channel, from a frame's per-unit data (0 … 1). */
export function channelActivity(units: Float32Array | null, out: Float32Array, stride: number): void {
  out.fill(0);
  if (!units || units.length === 0) return;
  for (let c = 0; c < N_CHANNELS; c++) {
    let n = 0;
    for (let j = 0; j < SENSORY_PER_CHANNEL; j++) {
      const since = units[(c * SENSORY_PER_CHANNEL + j) * stride + 2];
      if (since >= 0 && since < 25) n += 1 - since / 25;
    }
    out[c] = Math.min(1, n / 3);
  }
}

export { CH_DOOR, CH_FIGURE, CH_HOUSE, CH_RAIN, CH_TEXTURE };
