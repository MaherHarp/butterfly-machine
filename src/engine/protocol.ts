import type { Intervention } from '../sim';
import type { DivergenceRequest, FirstDivergence, PathEntry } from '../sim/replay';

export interface SplitOrder {
  parent: number;
  a: number;
  b: number;
  mode: 'auto' | 'explicit';
  ivA?: Intervention | null;
  ivB?: Intervention | null;
  /** Send child b back to the main thread instead of keeping it (load balancing). */
  ship: boolean;
  /** Keep a and b together and compare them every step (b's pink lineage against control a). */
  pair?: boolean;
}

export type ToWorker =
  | { t: 'seed'; req: number; key: number; seed: number }
  | { t: 'load'; req: number; key: number; buf: ArrayBuffer; schedule?: PathEntry[] }
  | { t: 'snapshot'; req: number; key: number }
  | { t: 'apply'; req: number; key: number; iv: Intervention }
  | { t: 'split'; req: number; splits: SplitOrder[] }
  | { t: 'pair'; req: number; control: number; altered: number; trace?: ArrayBuffer; roots?: Array<{ step: number; neuron: number }> }
  | { t: 'peek'; req: number; key: number; horizon: number }
  | { t: 'advance'; req: number; to: number; lod: Uint8Array; defaultLod: number; recycle?: ArrayBuffer }
  | { t: 'drop'; req: number; keys: number[] }
  | { t: 'reset'; req: number }
  | { t: 'firstDiff'; req: number; request: DivergenceRequest }
  | { t: 'reconstruct'; req: number; origin: ArrayBuffer | null; seed?: number; path: PathEntry[]; target: number };

export type ToMain =
  | { t: 'done'; req: number; step: number; ok?: boolean }
  | { t: 'snapshot'; req: number; buf: ArrayBuffer; step: number }
  | { t: 'packet'; req: number; buf: ArrayBuffer }
  | { t: 'peek'; req: number; step: number; next: Int32Array }
  | {
      t: 'split';
      req: number;
      results: Array<{ parent: number; ivA: Intervention | null; ivB: Intervention | null; buf?: ArrayBuffer }>;
    }
  | { t: 'firstDiff'; req: number; result: FirstDivergence };
