import type { Intervention } from '../sim';
import type { FirstDifference, FirstDifferenceRequest, PathEntry } from '../sim/replay';
import { decodePacket, type WorldFrame } from './packet';
import type { SplitOrder, ToMain, ToWorker } from './protocol';
import SimWorker from './worker?worker';

export interface SplitRequest {
  parent: number;
  a: number;
  b: number;
  mode: 'auto' | 'explicit';
  ivA?: Intervention | null;
  ivB?: Intervention | null;
}

export interface SplitResult {
  parent: number;
  a: number;
  b: number;
  ivA: Intervention | null;
  ivB: Intervention | null;
}

/**
 * A pool of simulation workers holding every living future, stepped in
 * lockstep. The pool never decides *when* to step — the experience's clock
 * does — it only distributes worlds, relays branches, and gathers frames.
 */
export class SimPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, (m: ToMain) => void>();
  private nextReq = 1;
  /** world key → worker index */
  readonly owner = new Map<number, number>();
  /** Latest frame of every world, by key. */
  readonly frames = new Map<number, WorldFrame>();
  /** Step of the latest frames. */
  step = 0;
  /** Set while an advance is in flight. */
  busy = false;
  /** Bumped whenever a new set of frames lands. */
  generation = 0;
  lastAdvanceMs = 0;
  private recycle: Array<ArrayBuffer | undefined> = [];

  constructor(readonly size: number) {
    for (let i = 0; i < size; i++) {
      const w = new SimWorker();
      w.onmessage = (ev: MessageEvent<ToMain>) => {
        const cb = this.pending.get(ev.data.req);
        if (cb) {
          this.pending.delete(ev.data.req);
          cb(ev.data);
        }
      };
      w.onerror = (e) => console.error('sim worker error', e);
      this.workers.push(w);
    }
  }

  get worldCount(): number {
    return this.owner.size;
  }

  keys(): number[] {
    return [...this.owner.keys()];
  }

  private call(wi: number, msg: ToWorker, transfer: Transferable[] = []): Promise<ToMain> {
    return new Promise((resolve) => {
      this.pending.set(msg.req, resolve);
      this.workers[wi].postMessage(msg, transfer);
    });
  }

  private req(): number {
    return this.nextReq++;
  }

  private loads(): number[] {
    const l = new Array(this.size).fill(0);
    for (const wi of this.owner.values()) l[wi]++;
    return l;
  }

  async seed(key: number, seed: number, worker = 0): Promise<number> {
    const r = await this.call(worker, { t: 'seed', req: this.req(), key, seed });
    this.owner.set(key, worker);
    return r.t === 'done' ? r.step : 0;
  }

  async load(key: number, buf: ArrayBuffer, worker?: number, schedule?: PathEntry[]): Promise<void> {
    const wi = worker ?? this.leastLoaded();
    await this.call(wi, { t: 'load', req: this.req(), key, buf, schedule }, [buf]);
    this.owner.set(key, wi);
  }

  async snapshot(key: number): Promise<{ buf: ArrayBuffer; step: number } | null> {
    const wi = this.owner.get(key);
    if (wi === undefined) return null;
    const r = await this.call(wi, { t: 'snapshot', req: this.req(), key });
    return r.t === 'snapshot' && r.buf.byteLength ? { buf: r.buf, step: r.step } : null;
  }

  async apply(key: number, iv: Intervention): Promise<boolean> {
    const wi = this.owner.get(key);
    if (wi === undefined) return false;
    const r = await this.call(wi, { t: 'apply', req: this.req(), key, iv });
    return r.t === 'done' && !!r.ok;
  }

  private leastLoaded(): number {
    const l = this.loads();
    let best = 0;
    for (let i = 1; i < l.length; i++) if (l[i] < l[best]) best = i;
    return best;
  }

  /** Splits worlds: each parent continues as `a` where it lives, `b` goes wherever there is room. */
  async split(requests: SplitRequest[]): Promise<SplitResult[]> {
    const load = this.loads();
    const byWorker = new Map<number, SplitOrder[]>();
    const destination = new Map<number, number>();
    for (const r of requests) {
      const wi = this.owner.get(r.parent);
      if (wi === undefined) continue;
      let target = 0;
      for (let i = 1; i < load.length; i++) if (load[i] < load[target]) target = i;
      // Keep siblings together when the parent's worker is no busier than average.
      if (load[wi] <= load[target]) target = wi;
      load[target]++;
      destination.set(r.b, target);
      const order: SplitOrder = { parent: r.parent, a: r.a, b: r.b, mode: r.mode, ivA: r.ivA, ivB: r.ivB, ship: target !== wi };
      if (!byWorker.has(wi)) byWorker.set(wi, []);
      byWorker.get(wi)!.push(order);
    }
    const out: SplitResult[] = [];
    const loadsInFlight: Array<Promise<void>> = [];
    await Promise.all(
      [...byWorker.entries()].map(async ([wi, orders]) => {
        const r = await this.call(wi, { t: 'split', req: this.req(), splits: orders });
        if (r.t !== 'split') return;
        for (let k = 0; k < r.results.length; k++) {
          const res = r.results[k];
          const order = orders.find((o) => o.parent === res.parent)!;
          this.owner.delete(order.parent);
          this.frames.delete(order.parent);
          this.owner.set(order.a, wi);
          if (res.buf) {
            const dest = destination.get(order.b)!;
            loadsInFlight.push(
              this.call(dest, { t: 'load', req: this.req(), key: order.b, buf: res.buf }, [res.buf]).then(() => {
                this.owner.set(order.b, dest);
              }),
            );
          } else {
            this.owner.set(order.b, wi);
          }
          out.push({ parent: order.parent, a: order.a, b: order.b, ivA: res.ivA, ivB: res.ivB });
        }
      }),
    );
    await Promise.all(loadsInFlight);
    return out;
  }

  /**
   * Steps every world to `to` and collects one frame per world.
   * `lod[key]` selects detail; keys beyond the array use `defaultLod`.
   */
  async advance(to: number, lod: Uint8Array, defaultLod: number): Promise<void> {
    this.busy = true;
    const t0 = performance.now();
    const used = new Set(this.owner.values());
    const results = await Promise.all(
      [...used].map((wi) => {
        const recycle = this.recycle[wi];
        this.recycle[wi] = undefined;
        return this.call(
          wi,
          { t: 'advance', req: this.req(), to, lod, defaultLod, recycle },
          recycle ? [recycle] : [],
        ).then((r) => [wi, r] as const);
      }),
    );
    const frames: WorldFrame[] = [];
    let step = this.step;
    for (const [wi, r] of results) {
      if (r.t !== 'packet') continue;
      frames.length = 0;
      step = decodePacket(r.buf, frames);
      for (const f of frames) if (this.owner.has(f.key)) this.frames.set(f.key, f);
      // The previous buffer for this worker is no longer referenced by any frame once replaced.
      this.recycleLater(wi, r.buf);
    }
    this.step = Math.max(this.step, step);
    this.generation++;
    this.lastAdvanceMs = performance.now() - t0;
    this.busy = false;
  }

  private held: Array<ArrayBuffer | undefined> = [];
  private recycleLater(wi: number, buf: ArrayBuffer): void {
    // Hold the newest buffer (frames reference it); return the previous one to its worker.
    const prev = this.held[wi];
    this.held[wi] = buf;
    if (prev) this.recycle[wi] = prev;
  }

  async drop(keys: number[]): Promise<void> {
    const by = new Map<number, number[]>();
    for (const k of keys) {
      const wi = this.owner.get(k);
      if (wi === undefined) continue;
      if (!by.has(wi)) by.set(wi, []);
      by.get(wi)!.push(k);
      this.owner.delete(k);
      this.frames.delete(k);
    }
    await Promise.all([...by.entries()].map(([wi, ks]) => this.call(wi, { t: 'drop', req: this.req(), keys: ks })));
  }

  async reset(): Promise<void> {
    await Promise.all(this.workers.map((_, wi) => this.call(wi, { t: 'reset', req: this.req() })));
    this.owner.clear();
    this.frames.clear();
    this.step = 0;
    this.held = [];
    this.recycle = [];
  }

  async firstDifference(request: FirstDifferenceRequest): Promise<FirstDifference> {
    const r = await this.call(0, { t: 'firstDiff', req: this.req(), request }, [request.origin]);
    if (r.t !== 'firstDiff') throw new Error('unexpected reply');
    return r.result;
  }

  async reconstruct(origin: ArrayBuffer, path: PathEntry[], target: number): Promise<{ buf: ArrayBuffer; step: number }> {
    const r = await this.call(0, { t: 'reconstruct', req: this.req(), origin, path, target }, [origin]);
    if (r.t !== 'snapshot') throw new Error('unexpected reply');
    return { buf: r.buf, step: r.step };
  }

  async reconstructFromSeed(seed: number, path: PathEntry[], target: number): Promise<{ buf: ArrayBuffer; step: number }> {
    const r = await this.call(0, { t: 'reconstruct', req: this.req(), origin: null, seed, path, target });
    if (r.t !== 'snapshot') throw new Error('unexpected reply');
    return { buf: r.buf, step: r.step };
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
  }
}
