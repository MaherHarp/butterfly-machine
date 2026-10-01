/**
 * Deterministic randomness and math for the simulation core.
 *
 * Two kinds of randomness are used:
 *
 *  1. `Rng` (sfc32) — a classic seeded stream generator, used only while a
 *     world is being *created* from its seed.
 *
 *  2. Counter-based hashing (`hash4`, `rand01`) — every random choice made
 *     while a world is *running* is a pure function of (seed, step, agent id,
 *     purpose). There is no shared random stream that could be advanced by an
 *     unrelated event, so a difference between two worlds can only travel the
 *     way real causes travel: through interactions. This is what makes the
 *     divergence between futures genuine rather than an artifact of a
 *     reshuffled RNG.
 *
 * Only integer ops, + - * /, Math.sqrt and Math.floor are used, all of which
 * are exactly specified by IEEE-754 / ECMAScript, so worlds are reproducible
 * across JS engines (Math.sin & co. are not, hence `dsin`/`dcos`).
 */

/** 32-bit integer finalizer (lowbias32 by Chris Wellons). */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hash4(a: number, b: number, c: number, d: number): number {
  let h = mix32((a ^ 0x9e3779b9) >>> 0);
  h = mix32((h ^ b) >>> 0);
  h = mix32((h + Math.imul(c, 0x85ebca6b)) >>> 0);
  h = mix32((h ^ Math.imul(d, 0xc2b2ae35)) >>> 0);
  return h;
}

/** Uniform in [0, 1). */
export function rand01(a: number, b: number, c: number, d: number): number {
  return hash4(a, b, c, d) / 4294967296;
}

/** Uniform in [-1, 1). */
export function randSigned(a: number, b: number, c: number, d: number): number {
  return (hash4(a, b, c, d) / 2147483648) - 1;
}

/** Seeded stream generator (sfc32). Used only for world creation. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    this.a = mix32(seed ^ 0xa341316c);
    this.b = mix32(seed ^ 0xc8013ea4);
    this.c = mix32(seed ^ 0xad90777d);
    this.d = mix32(seed ^ 0x7e95761e);
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  nextU32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  next(): number {
    return this.nextU32() / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Approximately normal (Irwin–Hall, 4 terms), mean 0, sd ≈ 1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508075688772;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

export const TAU = 6.283185307179586;
const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;

/**
 * Engine-independent sine. Range-reduces to [-π/2, π/2] and evaluates a
 * degree-11 Taylor polynomial (abs error < 6e-8, ample for environmental
 * cycles). Built only from exactly-rounded operations.
 */
export function dsin(x: number): number {
  x = x - TAU * Math.floor((x + PI) / TAU); // [-π, π)
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800))))));
}

export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}
