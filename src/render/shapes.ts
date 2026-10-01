/**
 * Batched luminous primitives in plane coordinates (additively blended).
 * Instance layout (12 floats): x0 y0 x1 y1 | r g b a | widthPx kind radius glowPx
 */
export class ShapeBatch {
  data = new Float32Array(12 * 512);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  private push(): number {
    if ((this.count + 1) * 12 > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    return this.count++ * 12;
  }

  line(x0: number, y0: number, x1: number, y1: number, widthPx: number, r: number, g: number, b: number, a: number, glowPx = 0): void {
    const o = this.push();
    const d = this.data;
    d[o] = x0;
    d[o + 1] = y0;
    d[o + 2] = x1;
    d[o + 3] = y1;
    d[o + 4] = r;
    d[o + 5] = g;
    d[o + 6] = b;
    d[o + 7] = a;
    d[o + 8] = widthPx;
    d[o + 9] = 0;
    d[o + 10] = 0;
    d[o + 11] = glowPx;
  }

  disc(x: number, y: number, radius: number, r: number, g: number, b: number, a: number, glowPx = 0): void {
    this.circle(1, x, y, radius, 0, r, g, b, a, glowPx);
  }

  ring(x: number, y: number, radius: number, widthPx: number, r: number, g: number, b: number, a: number, glowPx = 0): void {
    this.circle(2, x, y, radius, widthPx, r, g, b, a, glowPx);
  }

  private circle(kind: number, x: number, y: number, radius: number, widthPx: number, r: number, g: number, b: number, a: number, glowPx: number): void {
    const o = this.push();
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = 0;
    d[o + 3] = 0;
    d[o + 4] = r;
    d[o + 5] = g;
    d[o + 6] = b;
    d[o + 7] = a;
    d[o + 8] = widthPx;
    d[o + 9] = kind;
    d[o + 10] = radius;
    d[o + 11] = glowPx;
  }
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
