/**
 * A 2D camera over the plane of possible worlds. Long moves use the
 * van Wijk–Nuij "smooth and efficient" zoom-and-pan path: zoom out while
 * travelling, zoom back in on arrival — the way you move across a map.
 */
export interface View {
  x: number;
  y: number;
  /** Device pixels per plane unit. */
  zoom: number;
}

const RHO = 1.35;

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

interface Flight {
  from: View;
  to: View;
  t0: number;
  dur: number;
  ease: (t: number) => number;
  /** Precomputed van Wijk parameters, in "visible width" space for a unit-width viewport. */
  S: number;
  r0: number;
  u1: number;
  w0: number;
  straight: boolean;
}

export class Camera {
  x = 0;
  y = 0;
  zoom = 300;
  private flight: Flight | null = null;
  /** Gentle inertial drift for drags. */
  private vx = 0;
  private vy = 0;

  get view(): View {
    return { x: this.x, y: this.y, zoom: this.zoom };
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  set(v: View): void {
    this.x = v.x;
    this.y = v.y;
    this.zoom = v.zoom;
    this.flight = null;
    this.vx = this.vy = 0;
  }

  /** `width` is the viewport width in device px (zoom ↔ visible width). */
  flyTo(to: View, durationMs: number, now: number, width: number, ease = easeInOut): void {
    const from = this.view;
    const w0 = width / from.zoom;
    const w1 = width / to.zoom;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const u1 = Math.sqrt(dx * dx + dy * dy);
    let S: number;
    let r0 = 0;
    let straight = false;
    if (u1 < 1e-6 * Math.max(w0, w1)) {
      straight = true;
      S = Math.abs(Math.log(w1 / w0)) / RHO;
    } else {
      const b = (i: number) => {
        const wi = i === 0 ? w0 : w1;
        return (w1 * w1 - w0 * w0 + (i === 0 ? 1 : -1) * RHO ** 4 * u1 * u1) / (2 * wi * RHO * RHO * u1);
      };
      const r = (i: number) => Math.log(-b(i) + Math.sqrt(b(i) * b(i) + 1));
      r0 = r(0);
      S = (r(1) - r0) / RHO;
      if (!Number.isFinite(S)) {
        straight = true;
        S = 1;
      }
    }
    this.flight = { from, to, t0: now, dur: Math.max(1, durationMs), ease, S, r0, u1, w0, straight };
    this.vx = this.vy = 0;
  }

  update(now: number, dt: number): void {
    const f = this.flight;
    if (f) {
      let t = (now - f.t0) / f.dur;
      if (t >= 1) {
        t = 1;
        this.flight = null;
      }
      const e = f.ease(t);
      if (f.straight) {
        this.x = f.from.x + (f.to.x - f.from.x) * e;
        this.y = f.from.y + (f.to.y - f.from.y) * e;
        this.zoom = Math.exp(Math.log(f.from.zoom) + (Math.log(f.to.zoom) - Math.log(f.from.zoom)) * e);
      } else {
        const s = e * f.S;
        const { r0, w0, u1 } = f;
        const u = (w0 / (RHO * RHO)) * (Math.cosh(r0) * Math.tanh(RHO * s + r0) - Math.sinh(r0));
        const w = (w0 * Math.cosh(r0)) / Math.cosh(RHO * s + r0);
        const k = u / u1;
        this.x = f.from.x + (f.to.x - f.from.x) * k;
        this.y = f.from.y + (f.to.y - f.from.y) * k;
        // Recover zoom from visible width (width cancels: zoom ∝ 1 / w).
        this.zoom = (f.from.zoom * w0) / w;
        if (t === 1) {
          this.x = f.to.x;
          this.y = f.to.y;
          this.zoom = f.to.zoom;
        }
      }
      return;
    }
    if (this.vx !== 0 || this.vy !== 0) {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      const k = Math.exp(-dt * 5);
      this.vx *= k;
      this.vy *= k;
      if (Math.abs(this.vx) * this.zoom < 2 && Math.abs(this.vy) * this.zoom < 2) this.vx = this.vy = 0;
    }
  }

  panByPx(dxPx: number, dyPx: number): void {
    this.flight = null;
    this.x -= dxPx / this.zoom;
    this.y -= dyPx / this.zoom;
  }

  fling(vxPx: number, vyPx: number): void {
    this.vx = -vxPx / this.zoom;
    this.vy = -vyPx / this.zoom;
  }

  /** Zoom by `factor` keeping the plane point under (sx, sy) fixed. sx, sy relative to viewport centre, device px. */
  zoomAt(factor: number, sx: number, sy: number, minZoom: number, maxZoom: number): void {
    this.flight = null;
    const nz = Math.min(maxZoom, Math.max(minZoom, this.zoom * factor));
    const px = this.x + sx / this.zoom;
    const py = this.y + sy / this.zoom;
    this.zoom = nz;
    this.x = px - sx / nz;
    this.y = py - sy / nz;
  }

  toPlane(sx: number, sy: number): [number, number] {
    return [this.x + sx / this.zoom, this.y + sy / this.zoom];
  }

  toScreen(px: number, py: number): [number, number] {
    return [(px - this.x) * this.zoom, (py - this.y) * this.zoom];
  }
}
