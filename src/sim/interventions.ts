import { KIND_HUNTER } from './constants';
import { dcos, dsin, hash4, rand01 } from './hash';
import type { World } from './world';

/**
 * An intervention is the only thing that ever differs between two sibling
 * futures. It names its target by agent id (ids are shared by every world
 * descended from the same origin), so it means the same thing in any world.
 */
export type Intervention =
  | { kind: 'nudge'; id: number; dx: number; dy: number }
  | { kind: 'turn'; id: number; degrees: number }
  | { kind: 'energy'; id: number; fraction: number };

/** Applies an intervention in place. Returns false if the target no longer exists. */
export function applyIntervention(w: World, iv: Intervention): boolean {
  const i = w.indexOfId(iv.id);
  if (i < 0) return false;
  switch (iv.kind) {
    case 'nudge':
      w.x[i] += iv.dx;
      w.y[i] += iv.dy;
      return true;
    case 'turn': {
      const a = (iv.degrees * Math.PI) / 180;
      const c = dcos(a);
      const s = dsin(a);
      const vx = w.vx[i];
      const vy = w.vy[i];
      w.vx[i] = vx * c - vy * s;
      w.vy[i] = vx * s + vy * c;
      return true;
    }
    case 'energy':
      w.e[i] *= 1 + iv.fraction;
      return true;
  }
}

export function negate(iv: Intervention): Intervention {
  switch (iv.kind) {
    case 'nudge':
      return { ...iv, dx: -iv.dx, dy: -iv.dy };
    case 'turn':
      return { ...iv, degrees: -iv.degrees };
    case 'energy':
      return { ...iv, fraction: -iv.fraction };
  }
}

/**
 * The tiny change that splits a world into two siblings when the machine
 * branches on its own. Chosen deterministically from the parent's state, the
 * family seed and the parent's place in the tree; the two children receive
 * +δ and −δ respectively.
 */
export function autoIntervention(w: World, parentKey: number): Intervention | null {
  const n = w.n;
  if (n === 0) return null;
  const seed = w.seed;
  const s = w.step;
  const pick = hash4(seed, parentKey, s, 0x5e1) % n;
  const id = w.id[pick];
  const which = rand01(seed, parentKey, s, 0x5e2);
  const mag = rand01(seed, parentKey, s, 0x5e3);
  if (which < 0.5 || w.kind[pick] === KIND_HUNTER) {
    const ang = rand01(seed, parentKey, s, 0x5e4) * 2 * Math.PI;
    const d = 0.05 + 0.45 * mag; // 0.05 – 0.5 px
    return { kind: 'nudge', id, dx: d * dcos(ang), dy: d * dsin(ang) };
  }
  if (which < 0.8) return { kind: 'turn', id, degrees: 0.02 + 0.3 * mag };
  return { kind: 'energy', id, fraction: 0.0005 + 0.0045 * mag };
}

export function magnitudeOf(iv: Intervention): number {
  switch (iv.kind) {
    case 'nudge':
      return Math.sqrt(iv.dx * iv.dx + iv.dy * iv.dy);
    case 'turn':
      return Math.abs(iv.degrees);
    case 'energy':
      return Math.abs(iv.fraction);
  }
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1) return a.toFixed(1);
  if (a >= 0.1) return a.toFixed(2);
  return a.toPrecision(2);
}

/** Short human description, e.g. "moved 0.31 px", "turned 0.12°". */
export function describeIntervention(iv: Intervention | null): string {
  if (!iv) return 'unchanged';
  switch (iv.kind) {
    case 'nudge':
      return `moved ${fmt(magnitudeOf(iv))} px`;
    case 'turn':
      return `turned ${iv.degrees < 0 ? '−' : '+'}${fmt(iv.degrees)}°`;
    case 'energy':
      return `energy ${iv.fraction < 0 ? '−' : '+'}${fmt(iv.fraction * 100)}%`;
  }
}
