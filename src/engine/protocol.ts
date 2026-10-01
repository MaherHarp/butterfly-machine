import type { Intervention } from '../sim';
import type { FirstDifference, FirstDifferenceRequest, PathEntry } from '../sim/replay';

export interface SplitOrder {
  parent: number;
  a: number;
  b: number;
  mode: 'auto' | 'explicit';
  ivA?: Intervention | null;
  ivB?: Intervention | null;
  /** Send child b back to the main thread instead of keeping it (load balancing). */
  ship: boolean;
}

export type ToWorker =
  | { t: 'seed'; req: number; key: number; seed: number }
  | { t: 'load'; req: number; key: number; buf: ArrayBuffer; schedule?: PathEntry[] }
  | { t: 'snapshot'; req: number; key: number }
  | { t: 'apply'; req: number; key: number; iv: Intervention }
  | { t: 'split'; req: number; splits: SplitOrder[] }
  | { t: 'advance'; req: number; to: number; lod: Uint8Array; defaultLod: number; recycle?: ArrayBuffer }
  | { t: 'drop'; req: number; keys: number[] }
  | { t: 'reset'; req: number }
  | { t: 'firstDiff'; req: number; request: FirstDifferenceRequest }
  | { t: 'reconstruct'; req: number; origin: ArrayBuffer | null; seed?: number; path: PathEntry[]; target: number };

export type ToMain =
  | { t: 'done'; req: number; step: number; ok?: boolean }
  | { t: 'snapshot'; req: number; buf: ArrayBuffer; step: number }
  | { t: 'packet'; req: number; buf: ArrayBuffer }
  | {
      t: 'split';
      req: number;
      results: Array<{ parent: number; ivA: Intervention | null; ivB: Intervention | null; buf?: ArrayBuffer }>;
    }
  | { t: 'firstDiff'; req: number; result: FirstDifference };
