import {
  EVENT_RING,
  FIELD_CELL,
  FIELD_N,
  GRID_N,
  KIND_GRAZER,
  KIND_HUNTER,
  MAX_AGENTS,
  MAX_REMNANTS,
  N_LINEAGES,
  POP_HIST,
  WARMUP_STEPS,
  WORLD_RADIUS,
} from './constants';
import { Rng, hash4 } from './hash';

/**
 * A world is a struct-of-arrays laid out in ONE ArrayBuffer. That makes a
 * snapshot a single `buffer.slice()`, a branch a copy of that buffer, and
 * shipping a world to another worker a zero-copy transfer. Scratch arrays
 * used during a step are not part of the state and are allocated separately.
 */

type Ctor = Float64ArrayConstructor | Float32ArrayConstructor | Uint32ArrayConstructor | Int32ArrayConstructor | Uint8ArrayConstructor;

const LAYOUT = [
  // Float64 — agents
  ['x', Float64Array, MAX_AGENTS],
  ['y', Float64Array, MAX_AGENTS],
  ['vx', Float64Array, MAX_AGENTS],
  ['vy', Float64Array, MAX_AGENTS],
  ['e', Float64Array, MAX_AGENTS],
  ['age', Float64Array, MAX_AGENTS],
  ['life', Float64Array, MAX_AGENTS],
  ['cool', Float64Array, MAX_AGENTS],
  ['gSpeed', Float64Array, MAX_AGENTS],
  ['gSense', Float64Array, MAX_AGENTS],
  ['gSocial', Float64Array, MAX_AGENTS],
  ['gCaution', Float64Array, MAX_AGENTS],
  ['gEff', Float64Array, MAX_AGENTS],
  ['gHue', Float64Array, MAX_AGENTS],
  // Float64 — remnants (structures left behind by the dead)
  ['rx', Float64Array, MAX_REMNANTS],
  ['ry', Float64Array, MAX_REMNANTS],
  ['rs', Float64Array, MAX_REMNANTS],
  ['rHue', Float64Array, MAX_REMNANTS],
  // Float64 — scalars
  ['sc', Float64Array, 16],
  // Float32 — fields
  ['res', Float32Array, FIELD_N * FIELD_N],
  ['fert', Float32Array, FIELD_N * FIELD_N],
  ['popHist', Float32Array, POP_HIST],
  ['evX', Float32Array, EVENT_RING],
  ['evY', Float32Array, EVENT_RING],
  // 32-bit ints
  ['id', Uint32Array, MAX_AGENTS],
  ['born', Int32Array, MAX_AGENTS],
  ['rId', Uint32Array, MAX_REMNANTS],
  ['rLinkId', Uint32Array, MAX_REMNANTS],
  ['rLink', Int32Array, MAX_REMNANTS],
  ['rBorn', Int32Array, MAX_REMNANTS],
  ['evType', Int32Array, EVENT_RING],
  ['evStep', Int32Array, EVENT_RING],
  ['evA', Uint32Array, EVENT_RING],
  ['linCount', Int32Array, N_LINEAGES + 2],
  // bytes
  ['kind', Uint8Array, MAX_AGENTS],
  ['lin', Uint8Array, MAX_AGENTS],
  ['rAlive', Uint8Array, MAX_REMNANTS],
  ['rLin', Uint8Array, MAX_REMNANTS],
  ['evLin', Uint8Array, EVENT_RING],
] as const satisfies ReadonlyArray<readonly [string, Ctor, number]>;

type LayoutEntry = (typeof LAYOUT)[number];
type FieldName = LayoutEntry[0];
type ArrayOf<C> = C extends Float64ArrayConstructor
  ? Float64Array
  : C extends Float32ArrayConstructor
    ? Float32Array
    : C extends Uint32ArrayConstructor
      ? Uint32Array
      : C extends Int32ArrayConstructor
        ? Int32Array
        : Uint8Array;
type StateArrays = { [E in LayoutEntry as E[0]]: ArrayOf<E[1]> };

const OFFSETS: Record<string, number> = {};
let STATE_BYTES = 0;
for (const [name, ctor, len] of LAYOUT) {
  const align = ctor.BYTES_PER_ELEMENT;
  STATE_BYTES = Math.ceil(STATE_BYTES / align) * align;
  OFFSETS[name] = STATE_BYTES;
  STATE_BYTES += len * align;
}
STATE_BYTES = Math.ceil(STATE_BYTES / 8) * 8;
export { STATE_BYTES };

// Scalar slots in `sc`.
const S_STEP = 0;
const S_N = 1;
const S_SEED = 2;
const S_BIRTHS = 3;
const S_DEATHS = 4;
const S_CATCHES = 5;
const S_RCURSOR = 6;
const S_PH_HEAD = 7;
const S_PH_LEN = 8;
const S_EV_HEAD = 9;
const S_EV_TOTAL = 10;

export interface World extends StateArrays {}

export class World {
  readonly buffer: ArrayBuffer;

  // Scratch (not state).
  readonly ax = new Float64Array(MAX_AGENTS);
  readonly ay = new Float64Array(MAX_AGENTS);
  readonly ox = new Float64Array(MAX_AGENTS);
  readonly oy = new Float64Array(MAX_AGENTS);
  readonly maxs = new Float64Array(MAX_AGENTS);
  readonly dead = new Uint8Array(MAX_AGENTS);
  readonly crowd = new Uint8Array(MAX_AGENTS);
  readonly gridHead = new Int32Array(GRID_N * GRID_N);
  readonly gridNext = new Int32Array(MAX_AGENTS);
  readonly tmpField = new Float32Array(FIELD_N * FIELD_N);

  constructor(buffer?: ArrayBuffer) {
    if (buffer && buffer.byteLength !== STATE_BYTES) {
      throw new Error(`World snapshot has ${buffer.byteLength} bytes, expected ${STATE_BYTES}`);
    }
    this.buffer = buffer ?? new ArrayBuffer(STATE_BYTES);
    const self = this as unknown as Record<FieldName, unknown>;
    for (const [name, ctor, len] of LAYOUT) {
      self[name] = new ctor(this.buffer, OFFSETS[name], len);
    }
  }

  get step(): number { return this.sc[S_STEP]; }
  set step(v: number) { this.sc[S_STEP] = v; }
  get n(): number { return this.sc[S_N]; }
  set n(v: number) { this.sc[S_N] = v; }
  get seed(): number { return this.sc[S_SEED]; }
  set seed(v: number) { this.sc[S_SEED] = v; }
  get births(): number { return this.sc[S_BIRTHS]; }
  set births(v: number) { this.sc[S_BIRTHS] = v; }
  get deaths(): number { return this.sc[S_DEATHS]; }
  set deaths(v: number) { this.sc[S_DEATHS] = v; }
  get catches(): number { return this.sc[S_CATCHES]; }
  set catches(v: number) { this.sc[S_CATCHES] = v; }
  get rCursor(): number { return this.sc[S_RCURSOR]; }
  set rCursor(v: number) { this.sc[S_RCURSOR] = v; }
  get phHead(): number { return this.sc[S_PH_HEAD]; }
  set phHead(v: number) { this.sc[S_PH_HEAD] = v; }
  get phLen(): number { return this.sc[S_PH_LEN]; }
  set phLen(v: number) { this.sc[S_PH_LEN] = v; }
  get evHead(): number { return this.sc[S_EV_HEAD]; }
  set evHead(v: number) { this.sc[S_EV_HEAD] = v; }
  /** Total events ever pushed to the ring; lets readers detect what is new. */
  get evTotal(): number { return this.sc[S_EV_TOTAL]; }
  set evTotal(v: number) { this.sc[S_EV_TOTAL] = v; }

  snapshot(): ArrayBuffer {
    return this.buffer.slice(0);
  }

  clone(): World {
    return new World(this.snapshot());
  }

  indexOfId(id: number): number {
    const ids = this.id;
    for (let i = 0, n = this.n; i < n; i++) if (ids[i] === id) return i;
    return -1;
  }
}

/** Fixed hue (0–1) per lineage. Individuals drift slightly around it as they mutate. */
export const LINEAGE_HUES = [0.47, 0.55, 0.63, 0.75, 0.88, 0.32];
export const HUNTER_HUE = 0.07;

export interface Genome {
  speed: number;
  sense: number;
  social: number;
  caution: number;
  eff: number;
}

export const GENOME_BOUNDS = {
  speed: [0.7, 1.6],
  sense: [28, 50],
  social: [0, 1.2],
  caution: [0, 1.2],
  eff: [0.45, 0.95],
} as const;

/** Cells of the field that lie inside the disk. Derived, not state. */
export const FIELD_MASK: Uint8Array = (() => {
  const m = new Uint8Array(FIELD_N * FIELD_N);
  const r2 = (WORLD_RADIUS - FIELD_CELL * 0.25) ** 2;
  for (let j = 0; j < FIELD_N; j++) {
    for (let i = 0; i < FIELD_N; i++) {
      const cx = -WORLD_RADIUS + (i + 0.5) * FIELD_CELL;
      const cy = -WORLD_RADIUS + (j + 0.5) * FIELD_CELL;
      if (cx * cx + cy * cy < r2) m[j * FIELD_N + i] = 1;
    }
  }
  return m;
})();

export function agentLife(seed: number, id: number, kind: number): number {
  const u = hash4(seed, id, 0x11fe, 0) / 4294967296;
  return kind === KIND_HUNTER ? 5400 + u * 3600 : 2700 + u * 2400;
}

function randomPointInDisk(rng: Rng, radius: number): [number, number] {
  for (;;) {
    const x = rng.range(-1, 1);
    const y = rng.range(-1, 1);
    if (x * x + y * y <= 1) return [x * radius, y * radius];
  }
}

/**
 * Seeds a world. The result has already been run for WARMUP_STEPS so that
 * when it is first shown it is a living ecosystem, not a starting grid.
 */
export function createWorld(seed: number, warmup = WARMUP_STEPS, stepFn?: (w: World) => void): World {
  seed = seed >>> 0;
  const w = new World();
  const rng = new Rng(seed);
  w.seed = seed;

  // Resource landscape: a handful of soft hills.
  const hills: Array<[number, number, number, number]> = [];
  const nh = 6 + rng.int(4);
  for (let k = 0; k < nh; k++) {
    const [hx, hy] = randomPointInDisk(rng, WORLD_RADIUS * 0.85);
    hills.push([hx, hy, rng.range(70, 170), rng.range(0.5, 1)]);
  }
  for (let j = 0; j < FIELD_N; j++) {
    for (let i = 0; i < FIELD_N; i++) {
      const c = j * FIELD_N + i;
      if (!FIELD_MASK[c]) continue;
      const cx = -WORLD_RADIUS + (i + 0.5) * FIELD_CELL;
      const cy = -WORLD_RADIUS + (j + 0.5) * FIELD_CELL;
      let v = 0.12;
      for (const [hx, hy, hr, ha] of hills) {
        const d2 = ((cx - hx) ** 2 + (cy - hy) ** 2) / (hr * hr);
        v += ha / (1 + d2 * d2);
      }
      w.res[c] = Math.min(1, v);
    }
  }

  // Lineages: each founder population has its own temperament.
  const bases: Genome[] = [];
  for (let L = 0; L < N_LINEAGES; L++) {
    bases.push({
      speed: rng.range(0.85, 1.35),
      sense: rng.range(32, 46),
      social: rng.range(0.15, 1.0),
      caution: rng.range(0.25, 1.0),
      eff: rng.range(0.55, 0.85),
    });
  }

  let n = 0;
  const perLineage = 24;
  for (let L = 0; L < N_LINEAGES; L++) {
    const [cx, cy] = randomPointInDisk(rng, WORLD_RADIUS * 0.6);
    for (let k = 0; k < perLineage; k++) {
      const i = n++;
      let px = cx + rng.gauss() * 34;
      let py = cy + rng.gauss() * 34;
      const r = Math.sqrt(px * px + py * py);
      if (r > WORLD_RADIUS - 20) {
        px *= (WORLD_RADIUS - 20) / r;
        py *= (WORLD_RADIUS - 20) / r;
      }
      const b = bases[L];
      initAgent(w, i, seed, KIND_GRAZER, L, px, py, rng, {
        speed: b.speed * rng.range(0.95, 1.05),
        sense: b.sense * rng.range(0.95, 1.05),
        social: b.social,
        caution: b.caution,
        eff: b.eff,
      });
      w.e[i] = rng.range(0.7, 1.6);
    }
  }
  const nHunters = 9;
  for (let k = 0; k < nHunters; k++) {
    const i = n++;
    const [px, py] = randomPointInDisk(rng, WORLD_RADIUS * 0.8);
    initAgent(w, i, seed, KIND_HUNTER, 0, px, py, rng, {
      speed: rng.range(1.0, 1.15),
      sense: rng.range(80, 95),
      social: 0,
      caution: 0,
      eff: 0.65,
    });
    w.e[i] = rng.range(2, 3.2);
  }
  w.n = n;
  w.rCursor = 0;
  for (let i = 0; i < MAX_REMNANTS; i++) w.rLink[i] = -1;

  // Initial lineage census.
  for (let i = 0; i < n; i++) {
    if (w.kind[i] === KIND_HUNTER) w.linCount[N_LINEAGES]++;
    else {
      w.linCount[w.lin[i]]++;
      w.linCount[N_LINEAGES + 1]++;
    }
  }

  if (stepFn) for (let s = 0; s < warmup; s++) stepFn(w);
  return w;
}

function initAgent(
  w: World,
  i: number,
  seed: number,
  kind: number,
  lin: number,
  px: number,
  py: number,
  rng: Rng,
  g: Genome,
): void {
  w.id[i] = (hash4(seed, i, 0x1d, kind) | 1) >>> 0;
  w.kind[i] = kind;
  w.lin[i] = lin;
  w.x[i] = px;
  w.y[i] = py;
  let dx = rng.range(-1, 1);
  let dy = rng.range(-1, 1);
  const m = Math.sqrt(dx * dx + dy * dy) || 1;
  dx /= m;
  dy /= m;
  w.vx[i] = dx * 0.6;
  w.vy[i] = dy * 0.6;
  w.gSpeed[i] = g.speed;
  w.gSense[i] = g.sense;
  w.gSocial[i] = g.social;
  w.gCaution[i] = g.caution;
  w.gEff[i] = g.eff;
  w.gHue[i] = kind === KIND_HUNTER ? HUNTER_HUE : LINEAGE_HUES[lin] + rng.range(-0.015, 0.015);
  w.life[i] = agentLife(seed, w.id[i], kind);
  w.age[i] = rng.next() * w.life[i] * 0.55;
  w.cool[i] = 0;
  w.born[i] = -1;
}
