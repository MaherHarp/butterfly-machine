import { CausalTrace } from './causal';
import { N_NEURONS, STEPS_PER_SECOND } from './constants';
import { divergenceOf } from './divergence';
import { applyIntervention, autoIntervention, rootNeuron, type Intervention } from './interventions';
import { Mind } from './mind';
import { classifyRates, step } from './step';

/**
 * REPLAY
 * ======
 *
 * A mind is never stored; it is *described*:
 *
 *     origin state  +  [(step, intervention), …]
 *
 * and reconstructed by running the deterministic step function forward,
 * applying each intervention at the start of its step. The origin is the
 * snapshot of Mind 0 taken the moment the visitor reached in to change it.
 *
 * An intervention can be concrete, or `auto` — "the change the machine made
 * forking node `parentKey` here" — which is recomputed from the state at that
 * step. That keeps shared links short.
 */
export type PathIntervention = Intervention | { auto: 1; parentKey: number } | null;

export interface PathEntry {
  step: number;
  iv: PathIntervention;
}

export function resolveIntervention(m: Mind, iv: PathIntervention): Intervention | null {
  if (!iv) return null;
  if ('auto' in iv) return autoIntervention(m, iv.parentKey);
  return iv;
}

/** Applies every entry due at the mind's current step; returns the next index. */
export function applyDue(m: Mind, sorted: readonly PathEntry[], k: number, onApply?: (iv: Intervention) => void): number {
  while (k < sorted.length && sorted[k].step <= m.step) {
    if (sorted[k].step === m.step) {
      const iv = resolveIntervention(m, sorted[k].iv);
      if (iv && applyIntervention(m, iv)) onApply?.(iv);
    }
    k++;
  }
  return k;
}

function sortedPath(path: readonly PathEntry[]): PathEntry[] {
  return [...path].sort((a, b) => a.step - b.step);
}

/** Runs `m` forward to `target`, applying path entries on the way. Mutates `m`. */
export function replayInto(m: Mind, path: readonly PathEntry[], target: number, onStep?: (m: Mind) => void): void {
  const sorted = sortedPath(path);
  let k = 0;
  while (k < sorted.length && sorted[k].step < m.step) k++;
  for (;;) {
    k = applyDue(m, sorted, k);
    if (m.step >= target) break;
    step(m);
    onStep?.(m);
  }
}

export function reconstruct(origin: ArrayBuffer, path: readonly PathEntry[], target: number): Mind {
  const m = new Mind(origin.slice(0));
  replayInto(m, path, target);
  return m;
}

// ---------------------------------------------------------------------------
// WHEN DID THESE MINDS DIVERGE?
// ---------------------------------------------------------------------------

export interface DivergenceRequest {
  origin: ArrayBuffer;
  /** Path shared by both minds, up to (not including) the split. */
  common: PathEntry[];
  /** Step at which the two minds' histories part. */
  splitStep: number;
  /** Each mind's own entries from the split onward (the split's own interventions included). */
  pathX: PathEntry[];
  pathY: PathEntry[];
  /** Give up after this many steps past the split. */
  maxSteps: number;
  /** How far before the first divergence the replay snapshots should start. */
  leadSteps: number;
}

/** A point in the cascade: by this step, this many units had changed what they do. */
export interface CascadeMark {
  step: number;
  units: number;
}

export interface FirstDivergence {
  found: boolean;
  splitStep: number;
  /** First step at which the minds' states differ and go on differing (never heal). */
  step: number;
  secondsAfterSplit: number;
  /** The first spike that happened differently: its unit, and when it fired in each mind (−1: not nearby). */
  unit: number;
  stepX: number;
  stepY: number;
  /** Signed timing difference (ms): positive = later in Y. Null if it fired in only one. */
  delayMs: number | null;
  /** True if that unit is the one an intervention at the split touched. */
  traceable: boolean;
  /** The intervention responsible, if traceable. */
  cause: Intervention | null;
  causeIn: 0 | 1;
  /** Units that had changed their behaviour by each milestone (1 → a few → a cluster → the network). */
  cascade: CascadeMark[];
  /** First step at which the assembly-level trajectories separate and stay apart. */
  splitTrajectoryStep: number;
  /** Where each mind ended up (attractor index or UNKNOWN). */
  outcomeX: number;
  outcomeY: number;
  /** Replay starting points for both minds (and their lineage), `leadSteps` before the divergence. */
  replayStep: number;
  snapX: ArrayBuffer | null;
  snapY: ArrayBuffer | null;
  snapTrace: ArrayBuffer | null;
  /** Interventions applied after the split, for marking roots during replay. */
  roots: Array<{ step: number; neuron: number; mind: 0 | 1 }>;
  examined: number;
}

/** The state difference must stay above this and never vanish for HOLD steps. */
export const DIVERGE_EPS = 1e-9;
export const DIVERGE_HOLD = 250;
/** Assembly-level separation that counts as "the trajectories split". */
export const TRAJECTORY_SPLIT = 0.3;
export const TRAJECTORY_HOLD = 250;
const CASCADE_MILESTONES = [1, 5, 40, Math.round(N_NEURONS / 2)];

function rawDifference(a: Mind, b: Mind): number {
  let d = 0;
  const n = N_NEURONS;
  for (let i = 0; i < n; i++) {
    const x = a.v[i] - b.v[i];
    const y = a.is[i] - b.is[i];
    const z = a.ie[i] - b.ie[i];
    d += (x < 0 ? -x : x) + (y < 0 ? -y : y) + (z < 0 ? -z : z);
    if (a.holdUntil[i] !== b.holdUntil[i] || a.lastSpike[i] !== b.lastSpike[i]) d += 1;
  }
  return d;
}

/**
 * Replays two related minds side by side from the moment their histories
 * split, comparing their full state after every step, and finds:
 *
 *   1. the first meaningful divergence: the earliest step at which their
 *      states differ and keep differing for DIVERGE_HOLD steps (a difference
 *      that heals completely does not count);
 *   2. the spike behind it: the first spike that happened differently, and
 *      whether that unit was touched by the intervention made at the split;
 *   3. the cascade: how many units had changed their behaviour, over time;
 *   4. the trajectory split: when the assembly-level states parted for good.
 *
 * Nothing is estimated: it is all read off the two replays.
 */
export function findFirstDivergence(req: DivergenceRequest): FirstDivergence {
  const base = reconstruct(req.origin, req.common, req.splitStep);
  const X = base.clone();
  const Y = base.clone();
  const trace = new CausalTrace();
  const px = sortedPath(req.pathX);
  const py = sortedPath(req.pathY);
  let kx = 0;
  let ky = 0;
  const roots: FirstDivergence['roots'] = [];
  const causes: Array<{ iv: Intervention; neuron: number; mind: 0 | 1; step: number }> = [];

  const SNAP_EVERY = 25;
  const ring: Array<{ step: number; x: ArrayBuffer; y: ArrayBuffer; t: ArrayBuffer }> = [];
  const limit = req.splitStep + req.maxSteps;

  let candidate = -1;
  let found = -1;
  let firstMismatchUnit = -1;
  let firstMismatchStep = -1;
  let trajCandidate = -1;
  let trajSplit = -1;
  const cascade: CascadeMark[] = [];
  let mi = 0;

  while (X.step < limit) {
    const s = X.step;
    kx = applyDue(X, px, kx, (iv) => {
      const n = rootNeuron(X, iv);
      trace.markRoot(n, s);
      roots.push({ step: s, neuron: n, mind: 0 });
      causes.push({ iv, neuron: n, mind: 0, step: s });
    });
    ky = applyDue(Y, py, ky, (iv) => {
      const n = rootNeuron(Y, iv);
      trace.markRoot(n, s);
      roots.push({ step: s, neuron: n, mind: 1 });
      causes.push({ iv, neuron: n, mind: 1, step: s });
    });
    if ((s - req.splitStep) % SNAP_EVERY === 0) {
      ring.push({ step: s, x: X.snapshot(), y: Y.snapshot(), t: trace.snapshot() });
      const keepFrom = (candidate >= 0 ? candidate : s) - req.leadSteps - SNAP_EVERY * 2;
      while (ring.length > 2 && ring[1].step <= keepFrom) ring.shift();
    }
    step(X);
    step(Y);
    trace.update(X, Y);
    const diff = rawDifference(X, Y);
    if (firstMismatchStep < 0 && trace.mismatchesNow > 0) {
      firstMismatchStep = s;
      for (let i = 0; i < N_NEURONS; i++) {
        if (trace.lastMismatch[i] === s) {
          firstMismatchUnit = i;
          break;
        }
      }
    }
    if (found < 0) {
      if (diff > DIVERGE_EPS) {
        if (candidate < 0) candidate = s;
        if (s - candidate >= DIVERGE_HOLD) found = candidate;
      } else {
        // Healed completely: whatever happened before did not last.
        candidate = -1;
        firstMismatchStep = -1;
        firstMismatchUnit = -1;
      }
    }
    while (mi < CASCADE_MILESTONES.length && trace.mismatched >= CASCADE_MILESTONES[mi]) {
      cascade.push({ step: s, units: CASCADE_MILESTONES[mi] });
      mi++;
    }
    const macro = divergenceOf(X.trace, Y.trace, null, null, X.rate, Y.rate).macro;
    if (trajSplit < 0) {
      if (macro > TRAJECTORY_SPLIT) {
        if (trajCandidate < 0) trajCandidate = s;
        if (s - trajCandidate >= TRAJECTORY_HOLD) trajSplit = trajCandidate;
      } else trajCandidate = -1;
    }
    // Once everything is known, there is no need to replay the rest.
    if (found >= 0 && trajSplit >= 0 && mi >= CASCADE_MILESTONES.length && s - trajSplit > 400) break;
  }
  if (found < 0 && candidate >= 0 && X.step - candidate >= 60) found = candidate;

  const outcomeX = classifyRates(X.rate);
  const outcomeY = classifyRates(Y.rate);
  const empty: FirstDivergence = {
    found: false,
    splitStep: req.splitStep,
    step: -1,
    secondsAfterSplit: 0,
    unit: -1,
    stepX: -1,
    stepY: -1,
    delayMs: null,
    traceable: false,
    cause: null,
    causeIn: 0,
    cascade,
    splitTrajectoryStep: trajSplit,
    outcomeX,
    outcomeY,
    replayStep: req.splitStep,
    snapX: null,
    snapY: null,
    snapTrace: null,
    roots,
    examined: X.step - req.splitStep,
  };
  if (found < 0) return empty;

  // When did the first differing unit fire in each mind? Re-run that short stretch with full spike records.
  const unit = firstMismatchUnit;
  let stepX = -1;
  let stepY = -1;
  if (unit >= 0) {
    const want = Math.max(req.splitStep, firstMismatchStep - 40);
    let start = ring[0];
    for (const r of ring) if (r.step <= want) start = r;
    const sx = new Mind(start.x.slice(0));
    const sy = new Mind(start.y.slice(0));
    // Entries at the snapshot's own step were applied before it was taken.
    let jx = px.findIndex((e) => e.step > start.step);
    let jy = py.findIndex((e) => e.step > start.step);
    if (jx < 0) jx = px.length;
    if (jy < 0) jy = py.length;
    const near = (a: number) => Math.abs(a - firstMismatchStep) <= 40;
    while (sx.step <= firstMismatchStep + 40) {
      jx = applyDue(sx, px, jx);
      jy = applyDue(sy, py, jy);
      const s = sx.step;
      step(sx);
      step(sy);
      if (sx.lastSpike[unit] === s && near(s) && (stepX < 0 || Math.abs(s - firstMismatchStep) < Math.abs(stepX - firstMismatchStep))) stepX = s;
      if (sy.lastSpike[unit] === s && near(s) && (stepY < 0 || Math.abs(s - firstMismatchStep) < Math.abs(stepY - firstMismatchStep))) stepY = s;
    }
    // If both fired at the very same step, that spike was not the difference; keep the nearest unequal pair.
    if (stepX === stepY) stepY = -1;
  }
  const delayMs = stepX >= 0 && stepY >= 0 ? ((stepY - stepX) * 1000) / STEPS_PER_SECOND : null;
  const cause = causes.find((c) => c.neuron === unit && c.step <= (firstMismatchStep < 0 ? found : firstMismatchStep)) ?? null;

  const want = Math.max(req.splitStep, found - req.leadSteps);
  let snap = ring[0];
  for (const r of ring) if (r.step <= want) snap = r;

  return {
    ...empty,
    found: true,
    step: found,
    secondsAfterSplit: (found - req.splitStep) / STEPS_PER_SECOND,
    unit,
    stepX,
    stepY,
    delayMs,
    traceable: cause !== null,
    cause: cause?.iv ?? null,
    causeIn: cause?.mind ?? 0,
    replayStep: snap ? snap.step : req.splitStep,
    snapX: snap ? snap.x : null,
    snapY: snap ? snap.y : null,
    snapTrace: snap ? snap.t : null,
  };
}
