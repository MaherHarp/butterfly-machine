import { EV_BIRTH, EV_CATCH, EV_DEATH, EV_TOUCH, EventRecorder, eventKey, type SimEvent } from './events';
import { applyIntervention, autoIntervention, negate, type Intervention } from './interventions';
import { STEPS_PER_SECOND } from './constants';
import { step } from './step';
import { World } from './world';

/**
 * REPLAY
 * ======
 *
 * A future is never stored; it is *described*:
 *
 *     origin state  +  [(step, intervention), …]
 *
 * and reconstructed by running the deterministic step function forward,
 * applying each intervention at the start of its step. The origin is the
 * snapshot of World 0 taken the moment the visitor reached out to touch it.
 *
 * An intervention can be concrete, or `auto` — "the change the machine would
 * have made splitting node `parentKey` here" — which is recomputed from the
 * state at that step. That keeps shared links short.
 */
export type PathIntervention = Intervention | { auto: 1 | -1; parentKey: number } | null;

export interface PathEntry {
  step: number;
  iv: PathIntervention;
}

export function resolveIntervention(w: World, iv: PathIntervention): Intervention | null {
  if (!iv) return null;
  if ('auto' in iv) {
    const a = autoIntervention(w, iv.parentKey);
    if (!a) return null;
    return iv.auto > 0 ? a : negate(a);
  }
  return iv;
}

/** Runs `w` forward to `target`, applying path entries on the way. Mutates `w`. */
export function replayInto(w: World, path: readonly PathEntry[], target: number, onStep?: (w: World) => void): void {
  const sorted = [...path].sort((a, b) => a.step - b.step);
  let k = 0;
  while (k < sorted.length && sorted[k].step < w.step) k++;
  for (;;) {
    while (k < sorted.length && sorted[k].step === w.step) {
      const iv = resolveIntervention(w, sorted[k].iv);
      if (iv) applyIntervention(w, iv);
      k++;
    }
    if (w.step >= target) break;
    step(w);
    onStep?.(w);
  }
}

export function reconstruct(origin: ArrayBuffer, path: readonly PathEntry[], target: number): World {
  const w = new World(origin.slice(0));
  replayInto(w, path, target);
  return w;
}

// ---------------------------------------------------------------------------
// FIND THE FIRST DIFFERENCE
// ---------------------------------------------------------------------------

export interface FirstDifferenceRequest {
  origin: ArrayBuffer;
  /** Path shared by both worlds, up to (not including) the split. */
  common: PathEntry[];
  /** Step at which the two worlds' histories part. */
  splitStep: number;
  /** Each world's own entries from the split onward (the split's own interventions included). */
  pathX: PathEntry[];
  pathY: PathEntry[];
  /** Give up after this many steps past the split. */
  maxSteps: number;
  /** How far before the difference the replay snapshots should start. */
  leadSteps: number;
}

export interface FirstDifference {
  found: boolean;
  splitStep: number;
  /** First step at which the two worlds' discrete event histories disagree. */
  step: number;
  secondsAfterSplit: number;
  /** The event that happened in one world and not (at that step) in the other. */
  event: SimEvent | null;
  /** Which world it happened in: 0 = X, 1 = Y. */
  inWorld: 0 | 1;
  /** If the same event happened in the other world at a different moment: signed delay in ms (positive = later there). */
  otherDelayMs: number | null;
  /** Replay starting points for both worlds, `leadSteps` before the difference. */
  replayStep: number;
  snapX: ArrayBuffer | null;
  snapY: ArrayBuffer | null;
  /** Steps simulated to find it (for the curious). */
  examined: number;
}

const PRIORITY: Record<number, number> = { [EV_CATCH]: 0, [EV_BIRTH]: 1, [EV_DEATH]: 2, [EV_TOUCH]: 3 };

function byStep(events: SimEvent[]): Map<number, SimEvent[]> {
  const m = new Map<number, SimEvent[]>();
  for (const e of events) {
    let a = m.get(e.step);
    if (!a) m.set(e.step, (a = []));
    a.push(e);
  }
  return m;
}

function unmatched(a: SimEvent[], b: SimEvent[]): SimEvent[] {
  const counts = new Map<string, number>();
  for (const e of b) counts.set(eventKey(e), (counts.get(eventKey(e)) ?? 0) + 1);
  const out: SimEvent[] = [];
  for (const e of a) {
    const k = eventKey(e);
    const c = counts.get(k) ?? 0;
    if (c > 0) counts.set(k, c - 1);
    else out.push(e);
  }
  return out;
}

/**
 * Replays two related futures side by side from the moment their histories
 * split, recording every discrete event (including every touch, with
 * sub-step timing), and returns the earliest step at which the two event
 * histories disagree. Continuous differences — positions off by fractions of
 * a pixel — exist from the first step; this finds the first moment one of
 * them crossed a threshold and became a *different thing happening*.
 */
export function findFirstDifference(req: FirstDifferenceRequest): FirstDifference {
  const base = reconstruct(req.origin, req.common, req.splitStep);
  const X = base.clone();
  const Y = base.clone();
  const recX = new EventRecorder();
  const recY = new EventRecorder();

  const pending = (path: PathEntry[]) => [...path].sort((a, b) => a.step - b.step);
  const px = pending(req.pathX);
  const py = pending(req.pathY);
  let kx = 0;
  let ky = 0;
  const applyDue = (w: World, p: PathEntry[], k: number): number => {
    while (k < p.length && p[k].step <= w.step) {
      if (p[k].step === w.step) {
        const iv = resolveIntervention(w, p[k].iv);
        if (iv) applyIntervention(w, iv);
      }
      k++;
    }
    return k;
  };

  // Keep a short ring of snapshots so the replay can start a little before the moment.
  const SNAP_EVERY = 15;
  const ring: Array<{ step: number; x: ArrayBuffer; y: ArrayBuffer }> = [];

  const limit = req.splitStep + req.maxSteps;
  let found = -1;
  while (X.step < limit) {
    kx = applyDue(X, px, kx);
    ky = applyDue(Y, py, ky);
    if ((X.step - req.splitStep) % SNAP_EVERY === 0) {
      ring.push({ step: X.step, x: X.snapshot(), y: Y.snapshot() });
      const keepFrom = X.step - req.leadSteps - SNAP_EVERY * 2;
      while (ring.length > 2 && ring[1].step <= keepFrom) ring.shift();
    }
    const s = X.step;
    const nx = recX.events.length;
    const ny = recY.events.length;
    step(X, recX);
    step(Y, recY);
    const ex = recX.events.slice(nx);
    const ey = recY.events.slice(ny);
    if (unmatched(ex, ey).length || unmatched(ey, ex).length) {
      found = s;
      break;
    }
  }

  if (found < 0) {
    return {
      found: false,
      splitStep: req.splitStep,
      step: -1,
      secondsAfterSplit: 0,
      event: null,
      inWorld: 0,
      otherDelayMs: null,
      replayStep: req.splitStep,
      snapX: null,
      snapY: null,
      examined: X.step - req.splitStep,
    };
  }

  // Look a little further ahead to see whether the "missing" event simply happened later.
  const AHEAD = 90;
  for (let k = 0; k < AHEAD; k++) {
    kx = applyDue(X, px, kx);
    ky = applyDue(Y, py, ky);
    step(X, recX);
    step(Y, recY);
  }

  const mx = byStep(recX.events);
  const my = byStep(recY.events);
  const atX = mx.get(found) ?? [];
  const atY = my.get(found) ?? [];
  const candidates: Array<{ e: SimEvent; w: 0 | 1 }> = [
    ...unmatched(atX, atY).map((e) => ({ e, w: 0 as const })),
    ...unmatched(atY, atX).map((e) => ({ e, w: 1 as const })),
  ];
  candidates.sort((a, b) => a.e.frac - b.e.frac || (PRIORITY[a.e.type] ?? 9) - (PRIORITY[b.e.type] ?? 9));
  const pick = candidates[0];

  let otherDelayMs: number | null = null;
  if (pick) {
    const other = pick.w === 0 ? recY.events : recX.events;
    const key = eventKey(pick.e);
    let best: SimEvent | null = null;
    for (const o of other) {
      if (o.step < found - AHEAD || o.step > found + AHEAD) continue;
      if (eventKey(o) !== key) continue;
      if (!best || Math.abs(o.step - found) < Math.abs(best.step - found)) best = o;
    }
    if (best) {
      otherDelayMs = ((best.step + best.frac - (pick.e.step + pick.e.frac)) / STEPS_PER_SECOND) * 1000;
    }
  }

  const want = Math.max(req.splitStep, found - req.leadSteps);
  let snap = ring[0];
  for (const r of ring) if (r.step <= want) snap = r;

  return {
    found: true,
    splitStep: req.splitStep,
    step: found,
    secondsAfterSplit: (found - req.splitStep) / STEPS_PER_SECOND,
    event: pick?.e ?? null,
    inWorld: pick?.w ?? 0,
    otherDelayMs,
    replayStep: snap ? snap.step : req.splitStep,
    snapX: snap ? snap.x : null,
    snapY: snap ? snap.y : null,
    examined: found - req.splitStep,
  };
}
