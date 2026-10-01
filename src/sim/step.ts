import {
  CATCH_RADIUS,
  EVENT_RING,
  FIELD_CELL,
  FIELD_N,
  GRID_CELL,
  GRID_N,
  KIND_HUNTER,
  MAX_AGENTS,
  MAX_REMNANTS,
  N_LINEAGES,
  POP_HIST,
  POP_SAMPLE_EVERY,
  REMNANT_LINK,
  TOUCH_RADIUS,
  WORLD_RADIUS,
} from './constants';
import {
  EV_BIRTH,
  EV_CATCH,
  EV_DEATH,
  EV_GRAZERS_LOST,
  EV_HUNTERS_LOST,
  EV_LINEAGE_LOST,
  EV_STRUCTURE,
  EV_TOUCH,
  type EventSink,
} from './events';
import { TAU, dcos, dsin, hash4, randSigned } from './hash';
import { FIELD_MASK, GENOME_BOUNDS, LINEAGE_HUES, World, agentLife } from './world';

/**
 * One fixed simulation step (1/60 s of world time).
 *
 * The rules, in plain words:
 *  - Light falls on the disk from a slowly wandering sun and a seasonal
 *    cycle; where it falls, a resource field grows.
 *  - Grazers drift up the resource gradient, school with their own lineage,
 *    keep personal space, and flee hunters. They eat what is under them.
 *  - Hunters pursue the nearest grazer, catch it on contact, then rest.
 *  - Everything spends energy to move. Enough energy: divide (with small
 *    mutations). No energy, or too old: die, leaving a luminous remnant.
 *  - Remnants link to nearby remnants, growing structures, and they fertilize
 *    the ground around them — so the dead shape where the living can thrive.
 *
 * Steering is computed from the state at the start of the step for every
 * agent (synchronous update), then applied. Eating, predation and division
 * are resolved in array order. Nothing here depends on wall-clock time,
 * frame rate, or global random state.
 */

const R = WORLD_RADIUS;
let GRAZER_REPRO = 0, HUNTER_REPRO = 0, HUNTER_SATED = 0, HUNTER_REST = 0, EAT_RATE = 0, EAT_HALF = 0;

// Behaviour constants.
const SEP_R2 = 11 * 11;
const HUNTER_SEP_R2 = 46 * 46;

/**
 * Ecological balance. Tuned headlessly (scripts/ensemble.ts) so that most
 * futures stay alive for minutes while a meaningful share collapse, are taken
 * over by one lineage, or swing between booms and busts.
 */
export const ECOLOGY = {
  grazerRepro: 2.48,
  hunterRepro: 5.76,
  hunterSated: 5.06,
  hunterRest: 237,
  eatRate: 0.00763,
  eatHalf: 0.32,
  catchYield: 0.28,
  catchBonus: 0.334,
  hunterMetab: 0.00174,
  hunterMove: 0.0002,
  grazerMetab: 0.000755,
  grazerMove: 0.00063,
  grazerEffCost: 0.0006,
  growth: 0.00156,
  seasonAmp: 0.65,
  seasonPeriod: 5400,
};
const REMNANT_DECAY = 1 / 5400;
const WANDER_KNOT = 48;
const CROWD_R2 = 18 * 18;
const CROWD_LIMIT = 5;
const SHELTER_R2 = 15 * 15;

// Cell centres of the resource field (derived constants).
const CELL_CX = new Float64Array(FIELD_N);
for (let i = 0; i < FIELD_N; i++) CELL_CX[i] = -R + (i + 0.5) * FIELD_CELL;

export function sunPosition(step: number): [number, number] {
  return [
    0.52 * R * dcos((TAU * step) / 3900),
    0.52 * R * dsin((TAU * step) / 2900 + 1),
  ];
}

export function season(step: number): number {
  return 1 + ECOLOGY.seasonAmp * dsin((TAU * step) / ECOLOGY.seasonPeriod);
}

function gridCell(x: number, y: number): number {
  let cx = Math.floor((x + R) / GRID_CELL);
  let cy = Math.floor((y + R) / GRID_CELL);
  if (cx < 0) cx = 0;
  else if (cx >= GRID_N) cx = GRID_N - 1;
  if (cy < 0) cy = 0;
  else if (cy >= GRID_N) cy = GRID_N - 1;
  return cy * GRID_N + cx;
}

function fieldIndex(x: number, y: number): number {
  let i = Math.floor((x + R) / FIELD_CELL);
  let j = Math.floor((y + R) / FIELD_CELL);
  if (i < 0) i = 0;
  else if (i >= FIELD_N) i = FIELD_N - 1;
  if (j < 0) j = 0;
  else if (j >= FIELD_N) j = FIELD_N - 1;
  return j * FIELD_N + i;
}

/** Bilinear sample of the resource field. */
export function sampleField(f: Float32Array, x: number, y: number): number {
  let fx = (x + R) / FIELD_CELL - 0.5;
  let fy = (y + R) / FIELD_CELL - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > FIELD_N - 1.001) fx = FIELD_N - 1.001;
  if (fy < 0) fy = 0;
  else if (fy > FIELD_N - 1.001) fy = FIELD_N - 1.001;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const c = iy * FIELD_N + ix;
  const a = f[c] + (f[c + 1] - f[c]) * tx;
  const b = f[c + FIELD_N] + (f[c + FIELD_N + 1] - f[c + FIELD_N]) * tx;
  return a + (b - a) * ty;
}

function pushRing(w: World, type: number, step: number, x: number, y: number, a: number, lin: number): void {
  const h = w.evHead;
  w.evType[h] = type;
  w.evStep[h] = step;
  w.evX[h] = x;
  w.evY[h] = y;
  w.evA[h] = a;
  w.evLin[h] = lin;
  w.evHead = (h + 1) % EVENT_RING;
  w.evTotal = w.evTotal + 1;
}

/** Time (0–1) within a step at which |p(t)| first drops below r, for linear motion p0 → p1. */
function crossingFrac(dx0: number, dy0: number, dx1: number, dy1: number, r: number): number {
  const ex = dx1 - dx0;
  const ey = dy1 - dy0;
  const a = ex * ex + ey * ey;
  if (a < 1e-12) return 0;
  const b = 2 * (dx0 * ex + dy0 * ey);
  const c = dx0 * dx0 + dy0 * dy0 - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return 1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function step(w: World, sink: EventSink | null = null): void {
  const P = ECOLOGY;
  GRAZER_REPRO = P.grazerRepro;
  HUNTER_REPRO = P.hunterRepro;
  HUNTER_SATED = P.hunterSated;
  HUNTER_REST = P.hunterRest;
  EAT_RATE = P.eatRate;
  EAT_HALF = P.eatHalf;
  const s = w.step;
  const seed = w.seed;
  const n0 = w.n;
  const { x, y, vx, vy, e, age, life, cool, kind, lin, id } = w;
  const { gSpeed, gSense, gSocial, gCaution, gEff } = w;
  const { ax, ay, ox, oy, maxs, dead, crowd, gridHead, gridNext } = w;
  const res = w.res;

  // ---- 1. spatial hash -------------------------------------------------
  gridHead.fill(-1);
  for (let i = 0; i < n0; i++) {
    const c = gridCell(x[i], y[i]);
    gridNext[i] = gridHead[c];
    gridHead[c] = i;
  }

  // ---- 2. steering (reads only start-of-step state) --------------------
  for (let i = 0; i < n0; i++) {
    const px = x[i];
    const py = y[i];
    const pvx = vx[i];
    const pvy = vy[i];
    const myId = id[i];
    let fx = 0;
    let fy = 0;

    // Smooth wander: hashed knots, interpolated.
    const tt = s + (myId & 63);
    const knot = Math.floor(tt / WANDER_KNOT);
    let u = (tt - knot * WANDER_KNOT) / WANDER_KNOT;
    u = u * u * (3 - 2 * u);
    const w0x = randSigned(seed, knot, myId, 11);
    const w0y = randSigned(seed, knot, myId, 12);
    const w1x = randSigned(seed, knot + 1, myId, 11);
    const w1y = randSigned(seed, knot + 1, myId, 12);
    const wanderX = w0x + (w1x - w0x) * u;
    const wanderY = w0y + (w1y - w0y) * u;

    const gcx = Math.floor((px + R) / GRID_CELL);
    const gcy = Math.floor((py + R) / GRID_CELL);

    if (kind[i] !== KIND_HUNTER) {
      const sense = gSense[i];
      const sense2 = sense * sense;
      const myLin = lin[i];
      let sepX = 0, sepY = 0, aliX = 0, aliY = 0, cohX = 0, cohY = 0, cnt = 0, near = 0;
      let fleeX = 0, fleeY = 0, threat = 0;
      for (let gy = gcy - 1; gy <= gcy + 1; gy++) {
        if (gy < 0 || gy >= GRID_N) continue;
        for (let gx = gcx - 1; gx <= gcx + 1; gx++) {
          if (gx < 0 || gx >= GRID_N) continue;
          for (let j = gridHead[gy * GRID_N + gx]; j >= 0; j = gridNext[j]) {
            if (j === i) continue;
            const dx = x[j] - px;
            const dy = y[j] - py;
            const d2 = dx * dx + dy * dy;
            if (d2 >= sense2) continue;
            if (kind[j] === KIND_HUNTER) {
              const inv = 1 / (d2 + 1);
              fleeX -= dx * inv;
              fleeY -= dy * inv;
              const t = 1 - Math.sqrt(d2) / sense;
              if (t > threat) threat = t;
            } else {
              if (d2 < CROWD_R2) near++;
              if (d2 < SEP_R2) {
                const inv = 1 / (d2 + 0.6);
                sepX -= dx * inv;
                sepY -= dy * inv;
              }
              if (lin[j] === myLin) {
                aliX += vx[j];
                aliY += vy[j];
                cohX += dx;
                cohY += dy;
                cnt++;
              }
            }
          }
        }
      }

      crowd[i] = near > 255 ? 255 : near;
      const hunger = clampTo(1 - e[i] / GRAZER_REPRO, 0, 1);
      // Resource gradient (central differences on the bilinear field).
      const h = FIELD_CELL;
      const gX = sampleField(res, px + h, py) - sampleField(res, px - h, py);
      const gY = sampleField(res, px, py + h) - sampleField(res, px, py - h);
      const gm = Math.sqrt(gX * gX + gY * gY) + 0.04;
      const gw = 0.035 + 0.07 * hunger;
      fx += (gX / gm) * gw;
      fy += (gY / gm) * gw;

      const social = gSocial[i];
      if (cnt > 0) {
        const ic = 1 / cnt;
        fx += (aliX * ic - pvx) * 0.05 * social + cohX * ic * 0.0011 * social;
        fy += (aliY * ic - pvy) * 0.05 * social + cohY * ic * 0.0011 * social;
      }
      fx += sepX * 0.22;
      fy += sepY * 0.22;
      if (threat > 0) {
        const fm = Math.sqrt(fleeX * fleeX + fleeY * fleeY) + 1e-9;
        const k = 0.16 * (0.35 + gCaution[i]) * threat;
        fx += (fleeX / fm) * k;
        fy += (fleeY / fm) * k;
      }
      fx += wanderX * 0.03;
      fy += wanderY * 0.03;

      const here = sampleField(res, px, py);
      maxs[i] = gSpeed[i] * (0.55 + 0.45 * (1 - here) + 0.3 * threat);
    } else {
      // Hunter.
      const sense = gSense[i];
      let best = -1;
      let bestD2 = sense * sense;
      let sepX = 0, sepY = 0, rivals = 0;
      for (let gy = gcy - 2; gy <= gcy + 2; gy++) {
        if (gy < 0 || gy >= GRID_N) continue;
        for (let gx = gcx - 2; gx <= gcx + 2; gx++) {
          if (gx < 0 || gx >= GRID_N) continue;
          for (let j = gridHead[gy * GRID_N + gx]; j >= 0; j = gridNext[j]) {
            if (j === i) continue;
            const dx = x[j] - px;
            const dy = y[j] - py;
            const d2 = dx * dx + dy * dy;
            if (kind[j] === KIND_HUNTER) {
              if (d2 < HUNTER_SEP_R2) {
                rivals++;
                const inv = 1 / (d2 + 4);
                sepX -= dx * inv;
                sepY -= dy * inv;
              }
            } else if (d2 < bestD2) {
              bestD2 = d2;
              best = j;
            }
          }
        }
      }
      crowd[i] = rivals > 255 ? 255 : rivals;
      const sated = e[i] > HUNTER_SATED;
      const resting = cool[i] > 0;
      let top = gSpeed[i] * 1.5;
      if (best >= 0 && !sated && !resting) {
        const lead = 7;
        const tx = x[best] + vx[best] * lead - px;
        const ty = y[best] + vy[best] * lead - py;
        const tm = Math.sqrt(tx * tx + ty * ty) + 1e-9;
        fx += ((tx / tm) * top - pvx) * 0.055;
        fy += ((ty / tm) * top - pvy) * 0.055;
      } else {
        top *= resting ? 0.42 : 0.62;
        fx += wanderX * 0.045;
        fy += wanderY * 0.045;
      }
      fx += sepX * 0.6;
      fy += sepY * 0.6;
      maxs[i] = top;
    }

    // Soft wall.
    const r2 = px * px + py * py;
    const wall = R - 42;
    if (r2 > wall * wall) {
      const r = Math.sqrt(r2);
      const push = ((r - wall) / 42) * 0.09;
      fx -= (px / r) * push;
      fy -= (py / r) * push;
    }
    ax[i] = fx;
    ay[i] = fy;
  }

  // ---- 3. integrate ------------------------------------------------------
  const wallHard = R - 2;
  for (let i = 0; i < n0; i++) {
    ox[i] = x[i];
    oy[i] = y[i];
    let fx = ax[i];
    let fy = ay[i];
    const amax = kind[i] === KIND_HUNTER ? 0.085 : 0.1 * gSpeed[i];
    const am = Math.sqrt(fx * fx + fy * fy);
    if (am > amax) {
      fx *= amax / am;
      fy *= amax / am;
    }
    let nvx = (vx[i] + fx) * 0.996;
    let nvy = (vy[i] + fy) * 0.996;
    const sp = Math.sqrt(nvx * nvx + nvy * nvy);
    const top = maxs[i];
    if (sp > top) {
      nvx *= top / sp;
      nvy *= top / sp;
    }
    let nx = x[i] + nvx;
    let ny = y[i] + nvy;
    const r2 = nx * nx + ny * ny;
    if (r2 > wallHard * wallHard) {
      const r = Math.sqrt(r2);
      const ux = nx / r;
      const uy = ny / r;
      nx = ux * wallHard;
      ny = uy * wallHard;
      const vn = nvx * ux + nvy * uy;
      if (vn > 0) {
        nvx -= 1.6 * vn * ux;
        nvy -= 1.6 * vn * uy;
      }
    }
    x[i] = nx;
    y[i] = ny;
    vx[i] = nvx;
    vy[i] = nvy;
    dead[i] = 0;
  }

  // ---- 4. touches (only recorded when someone is listening) -------------
  if (sink) {
    const T2 = TOUCH_RADIUS * TOUCH_RADIUS;
    for (let i = 0; i < n0; i++) {
      const c = gridCell(ox[i], oy[i]);
      const gcx = c % GRID_N;
      const gcy = (c - gcx) / GRID_N;
      for (let gy = gcy - 1; gy <= gcy + 1; gy++) {
        if (gy < 0 || gy >= GRID_N) continue;
        for (let gx = gcx - 1; gx <= gcx + 1; gx++) {
          if (gx < 0 || gx >= GRID_N) continue;
          for (let j = gridHead[gy * GRID_N + gx]; j >= 0; j = gridNext[j]) {
            if (j <= i) continue;
            const dx1 = x[j] - x[i];
            const dy1 = y[j] - y[i];
            if (dx1 * dx1 + dy1 * dy1 >= T2) continue;
            const dx0 = ox[j] - ox[i];
            const dy0 = oy[j] - oy[i];
            if (dx0 * dx0 + dy0 * dy0 < T2) continue;
            const frac = crossingFrac(dx0, dy0, dx1, dy1, TOUCH_RADIUS);
            const a = id[i] < id[j] ? id[i] : id[j];
            const b = id[i] < id[j] ? id[j] : id[i];
            sink.push(EV_TOUCH, s, frac, a, b, (x[i] + x[j]) * 0.5, (y[i] + y[j]) * 0.5);
          }
        }
      }
    }
  }

  // ---- 5. grazing --------------------------------------------------------
  for (let i = 0; i < n0; i++) {
    if (kind[i] === KIND_HUNTER) continue;
    const c = fieldIndex(x[i], y[i]);
    const avail = res[c];
    const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
    // Holling type II: the sparser the food, the harder it is to gather.
    const rate = EAT_RATE * (1.25 - (0.5 * sp) / gSpeed[i]) * (avail / (avail + EAT_HALF));
    const take = avail < rate ? avail : rate;
    res[c] = avail - take;
    e[i] += take * gEff[i];
  }

  // ---- 6. predation ------------------------------------------------------
  let catches = w.catches;
  for (let i = 0; i < n0; i++) {
    if (kind[i] !== KIND_HUNTER || cool[i] > 0 || e[i] > HUNTER_SATED) continue;
    const c = gridCell(x[i], y[i]);
    const gcx = c % GRID_N;
    const gcy = (c - gcx) / GRID_N;
    let best = -1;
    let bestD2 = CATCH_RADIUS * CATCH_RADIUS;
    for (let gy = gcy - 1; gy <= gcy + 1; gy++) {
      if (gy < 0 || gy >= GRID_N) continue;
      for (let gx = gcx - 1; gx <= gcx + 1; gx++) {
        if (gx < 0 || gx >= GRID_N) continue;
        for (let j = gridHead[gy * GRID_N + gx]; j >= 0; j = gridNext[j]) {
          if (kind[j] === KIND_HUNTER || dead[j]) continue;
          const dx = x[j] - x[i];
          const dy = y[j] - y[i];
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2 && !sheltered(w, x[j], y[j])) {
            bestD2 = d2;
            best = j;
          }
        }
      }
    }
    if (best >= 0) {
      dead[best] = 2; // caught: no remnant
      e[i] += P.catchYield * e[best] + P.catchBonus;
      cool[i] = HUNTER_REST;
      catches++;
      pushRing(w, EV_CATCH, s, x[best], y[best], id[best], lin[best]);
      if (sink) {
        const frac = crossingFrac(ox[best] - ox[i], oy[best] - oy[i], x[best] - x[i], y[best] - y[i], CATCH_RADIUS);
        sink.push(EV_CATCH, s, frac, id[i], id[best], x[best], y[best]);
      }
    }
  }
  w.catches = catches;

  // ---- 7. metabolism, ageing, death, division -----------------------------
  let n = n0;
  for (let i = 0; i < n0; i++) {
    if (dead[i]) continue;
    const sp2 = vx[i] * vx[i] + vy[i] * vy[i];
    const isHunter = kind[i] === KIND_HUNTER;
    if (isHunter) {
      e[i] -= P.hunterMetab + P.hunterMove * sp2;
      if (cool[i] > 0) cool[i] -= 1;
    } else {
      e[i] -= P.grazerMetab + P.grazerMove * sp2 + P.grazerEffCost * gEff[i] + 0.00001 * gSense[i];
    }
    age[i] += 1;
    if (e[i] <= 0 || age[i] >= life[i]) {
      dead[i] = 1;
      w.deaths = w.deaths + 1;
      pushRing(w, EV_DEATH, s, x[i], y[i], id[i], isHunter ? 255 : lin[i]);
      if (sink) sink.push(EV_DEATH, s, 1, id[i], 0, x[i], y[i]);
      leaveRemnant(w, i, s, sink);
      continue;
    }
    const threshold = isHunter ? HUNTER_REPRO : GRAZER_REPRO;
    // Division needs room: grazers will not divide in a crush, hunters not beside a rival.
    const roomy = isHunter ? crowd[i] === 0 : crowd[i] < CROWD_LIMIT;
    // Grazers leave a little room in the world for hunters to be born.
    const cap = isHunter ? MAX_AGENTS : MAX_AGENTS - 24;
    if (e[i] > threshold && roomy && n < cap) {
      divide(w, i, n, s);
      w.births = w.births + 1;
      pushRing(w, EV_BIRTH, s, x[n], y[n], id[n], isHunter ? 255 : lin[n]);
      if (sink) sink.push(EV_BIRTH, s, 1, id[n], id[i], x[n], y[n]);
      dead[n] = 0;
      n++;
    }
  }

  // ---- 8. stable compaction ------------------------------------------------
  let wr = 0;
  for (let r = 0; r < n; r++) {
    if (dead[r]) continue;
    if (wr !== r) moveAgent(w, r, wr);
    wr++;
  }
  w.n = wr;

  // ---- 9. census & extinction events --------------------------------------
  census(w, s, sink);

  // ---- 10. environment -------------------------------------------------------
  updateField(w, s);
  if (s % 30 === 0) updateFertility(w);
  const rs = w.rs;
  const rAlive = w.rAlive;
  for (let k = 0; k < MAX_REMNANTS; k++) {
    if (!rAlive[k]) continue;
    rs[k] -= REMNANT_DECAY;
    if (rs[k] <= 0) {
      rs[k] = 0;
      rAlive[k] = 0;
    }
  }

  if (s % POP_SAMPLE_EVERY === 0) {
    w.popHist[w.phHead] = w.linCount[N_LINEAGES + 1];
    w.phHead = (w.phHead + 1) % POP_HIST;
    if (w.phLen < POP_HIST) w.phLen = w.phLen + 1;
  }

  w.step = s + 1;
}

/** Grazers resting inside a living structure cannot be caught. */
function sheltered(w: World, px: number, py: number): boolean {
  const { rx, ry, rs, rAlive } = w;
  for (let k = 0; k < MAX_REMNANTS; k++) {
    if (!rAlive[k] || rs[k] < 0.25) continue;
    const dx = rx[k] - px;
    const dy = ry[k] - py;
    if (dx * dx + dy * dy < SHELTER_R2) return true;
  }
  return false;
}

function moveAgent(w: World, from: number, to: number): void {
  w.x[to] = w.x[from];
  w.y[to] = w.y[from];
  w.vx[to] = w.vx[from];
  w.vy[to] = w.vy[from];
  w.e[to] = w.e[from];
  w.age[to] = w.age[from];
  w.life[to] = w.life[from];
  w.cool[to] = w.cool[from];
  w.gSpeed[to] = w.gSpeed[from];
  w.gSense[to] = w.gSense[from];
  w.gSocial[to] = w.gSocial[from];
  w.gCaution[to] = w.gCaution[from];
  w.gEff[to] = w.gEff[from];
  w.gHue[to] = w.gHue[from];
  w.id[to] = w.id[from];
  w.born[to] = w.born[from];
  w.kind[to] = w.kind[from];
  w.lin[to] = w.lin[from];
}

function mutate(seed: number, childId: number, salt: number, v: number, sigma: number, lo: number, hi: number): number {
  const m = (randSigned(seed, childId, salt, 1) + randSigned(seed, childId, salt, 2)) * 0.5;
  return clampTo(v + m * sigma, lo, hi);
}

function divide(w: World, p: number, c: number, s: number): void {
  const seed = w.seed;
  const childId = (hash4(w.id[p], s, 0xb1d5, seed) | 1) >>> 0;
  // Direction of the split, from a hashed unit vector.
  let dx = randSigned(seed, childId, 21, 0);
  let dy = randSigned(seed, childId, 22, 0);
  const m = Math.sqrt(dx * dx + dy * dy) + 1e-6;
  dx /= m;
  dy /= m;

  w.id[c] = childId;
  w.kind[c] = w.kind[p];
  w.lin[c] = w.lin[p];
  w.x[c] = w.x[p] + dx * 3;
  w.y[c] = w.y[p] + dy * 3;
  w.x[p] -= dx * 1.5;
  w.y[p] -= dy * 1.5;
  // The child leaves sideways; the parent keeps its course.
  w.vx[c] = w.vx[p] * 0.6 + dx * 0.5;
  w.vy[c] = w.vy[p] * 0.6 + dy * 0.5;
  const half = (w.e[p] - 0.12) * 0.5;
  w.e[p] = half;
  w.e[c] = half;
  w.age[c] = 0;
  w.cool[c] = 0;
  w.born[c] = s;
  w.life[c] = agentLife(seed, childId, w.kind[c]);

  const B = GENOME_BOUNDS;
  if (w.kind[c] === KIND_HUNTER) {
    w.gSpeed[c] = w.gSpeed[p];
    w.gSense[c] = w.gSense[p];
    w.gSocial[c] = 0;
    w.gCaution[c] = 0;
    w.gEff[c] = w.gEff[p];
    w.gHue[c] = w.gHue[p];
  } else {
    w.gSpeed[c] = mutate(seed, childId, 31, w.gSpeed[p], 0.06, B.speed[0], B.speed[1]);
    w.gSense[c] = mutate(seed, childId, 32, w.gSense[p], 1.6, B.sense[0], B.sense[1]);
    w.gSocial[c] = mutate(seed, childId, 33, w.gSocial[p], 0.06, B.social[0], B.social[1]);
    w.gCaution[c] = mutate(seed, childId, 34, w.gCaution[p], 0.06, B.caution[0], B.caution[1]);
    w.gEff[c] = mutate(seed, childId, 35, w.gEff[p], 0.025, B.eff[0], B.eff[1]);
    const base = LINEAGE_HUES[w.lin[c]];
    w.gHue[c] = mutate(seed, childId, 36, w.gHue[p], 0.008, base - 0.05, base + 0.05);
  }
}

function leaveRemnant(w: World, i: number, s: number, sink: EventSink | null): void {
  const slot = w.rCursor;
  w.rCursor = (slot + 1) % MAX_REMNANTS;
  const px = w.x[i];
  const py = w.y[i];
  w.rx[slot] = px;
  w.ry[slot] = py;
  w.rs[slot] = 1;
  w.rHue[slot] = w.gHue[i];
  w.rLin[slot] = w.kind[i] === KIND_HUNTER ? 255 : w.lin[i];
  w.rId[slot] = (hash4(w.id[i], s, 0x4e17, 0) | 1) >>> 0;
  w.rBorn[slot] = s;
  w.rAlive[slot] = 1;
  // Grow onto the nearest living structure, if one is close enough.
  let best = -1;
  let bestD2 = REMNANT_LINK * REMNANT_LINK;
  for (let k = 0; k < MAX_REMNANTS; k++) {
    if (k === slot || !w.rAlive[k]) continue;
    const dx = w.rx[k] - px;
    const dy = w.ry[k] - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = k;
    }
  }
  w.rLink[slot] = best;
  w.rLinkId[slot] = best >= 0 ? w.rId[best] : 0;
  if (best >= 0) {
    pushRing(w, EV_STRUCTURE, s, px, py, w.rId[slot], w.rLin[slot]);
    if (sink) sink.push(EV_STRUCTURE, s, 1, w.rId[slot], w.rId[best], px, py);
  }
}

function census(w: World, s: number, sink: EventSink | null): void {
  const lc = w.linCount;
  const prevHunters = lc[N_LINEAGES];
  const prevGrazers = lc[N_LINEAGES + 1];
  const prev0 = lc[0], prev1 = lc[1], prev2 = lc[2], prev3 = lc[3], prev4 = lc[4], prev5 = lc[5];
  lc.fill(0);
  const n = w.n;
  for (let i = 0; i < n; i++) {
    if (w.kind[i] === KIND_HUNTER) lc[N_LINEAGES]++;
    else {
      lc[w.lin[i]]++;
      lc[N_LINEAGES + 1]++;
    }
  }
  const prev = [prev0, prev1, prev2, prev3, prev4, prev5];
  for (let L = 0; L < N_LINEAGES; L++) {
    if (prev[L] > 0 && lc[L] === 0) {
      pushRing(w, EV_LINEAGE_LOST, s, 0, 0, L, L);
      if (sink) sink.push(EV_LINEAGE_LOST, s, 1, L + 1, 0, 0, 0);
    }
  }
  if (prevHunters > 0 && lc[N_LINEAGES] === 0) {
    pushRing(w, EV_HUNTERS_LOST, s, 0, 0, 0, 255);
    if (sink) sink.push(EV_HUNTERS_LOST, s, 1, 0, 0, 0, 0);
  }
  if (prevGrazers > 0 && lc[N_LINEAGES + 1] === 0) {
    pushRing(w, EV_GRAZERS_LOST, s, 0, 0, 0, 255);
    if (sink) sink.push(EV_GRAZERS_LOST, s, 1, 0, 0, 0, 0);
  }
}

function updateField(w: World, s: number): void {
  const res = w.res;
  const fert = w.fert;
  const sea = season(s);
  const [sx, sy] = sunPosition(s);
  const sunR2 = 230 * 230;
  const g = ECOLOGY.growth * sea;
  for (let j = 0; j < FIELD_N; j++) {
    const cy = CELL_CX[j];
    const dy = cy - sy;
    const row = j * FIELD_N;
    for (let i = 0; i < FIELD_N; i++) {
      const c = row + i;
      if (!FIELD_MASK[c]) continue;
      const dx = CELL_CX[i] - sx;
      const t = 1 - (dx * dx + dy * dy) / sunR2;
      const light = 0.5 + (t > 0 ? 0.95 * t : 0);
      const f = res[c];
      res[c] = f + g * light * (f + 0.15) * (1 - f) * (1 + fert[c]);
    }
  }
  if (s % 4 === 0) {
    const tmp = w.tmpField;
    tmp.set(res);
    const D = 0.12;
    for (let j = 1; j < FIELD_N - 1; j++) {
      for (let i = 1; i < FIELD_N - 1; i++) {
        const c = j * FIELD_N + i;
        if (!FIELD_MASK[c]) continue;
        const f = tmp[c];
        let sum = 0;
        let k = 0;
        if (FIELD_MASK[c - 1]) { sum += tmp[c - 1]; k++; }
        if (FIELD_MASK[c + 1]) { sum += tmp[c + 1]; k++; }
        if (FIELD_MASK[c - FIELD_N]) { sum += tmp[c - FIELD_N]; k++; }
        if (FIELD_MASK[c + FIELD_N]) { sum += tmp[c + FIELD_N]; k++; }
        if (k > 0) res[c] = f + D * (sum / k - f);
      }
    }
  }
}

/** Fertility is recomputed from living structures: the dead feed the ground. */
function updateFertility(w: World): void {
  const fert = w.fert;
  fert.fill(0);
  const rad = 2;
  const rad2 = (rad + 0.5) * (rad + 0.5);
  for (let k = 0; k < MAX_REMNANTS; k++) {
    if (!w.rAlive[k]) continue;
    const ci = Math.floor((w.rx[k] + R) / FIELD_CELL);
    const cj = Math.floor((w.ry[k] + R) / FIELD_CELL);
    const strength = 0.55 * w.rs[k];
    for (let dj = -rad; dj <= rad; dj++) {
      const j = cj + dj;
      if (j < 0 || j >= FIELD_N) continue;
      for (let di = -rad; di <= rad; di++) {
        const i = ci + di;
        if (i < 0 || i >= FIELD_N) continue;
        const d2 = di * di + dj * dj;
        if (d2 > rad2) continue;
        const c = j * FIELD_N + i;
        const v = fert[c] + strength * (1 - d2 / rad2);
        fert[c] = v > 2.5 ? 2.5 : v;
      }
    }
  }
}
