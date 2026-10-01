/**
 * Event history.
 *
 * Every world keeps a small ring of its recent *discrete* events (births,
 * deaths, predation, extinctions, structural growth) inside its state buffer.
 * That ring feeds sound and the light flashes, and it is part of the world's
 * deterministic state.
 *
 * High-volume events — every touch between two organisms, with sub-step
 * timing — are never stored during normal play. When the visitor asks where
 * two futures first became different, both are *replayed* from their common
 * ancestor with a full-resolution `EventSink` attached. Deterministic replay
 * makes that reconstruction exact, so nothing has to be logged in advance.
 */

export const EV_BIRTH = 1;
export const EV_DEATH = 2;
export const EV_CATCH = 3;
export const EV_TOUCH = 4;
export const EV_LINEAGE_LOST = 5;
export const EV_HUNTERS_LOST = 6;
export const EV_GRAZERS_LOST = 7;
export const EV_STRUCTURE = 8;

export const EVENT_NAMES: Record<number, string> = {
  [EV_BIRTH]: 'birth',
  [EV_DEATH]: 'death',
  [EV_CATCH]: 'catch',
  [EV_TOUCH]: 'touch',
  [EV_LINEAGE_LOST]: 'lineage lost',
  [EV_HUNTERS_LOST]: 'hunters lost',
  [EV_GRAZERS_LOST]: 'grazers lost',
  [EV_STRUCTURE]: 'structure',
};

export interface SimEvent {
  type: number;
  step: number;
  /** Fraction of the step (0–1) at which the event happened, when known. */
  frac: number;
  /** Agent ids involved; for touches a < b. 0 when not applicable. */
  a: number;
  b: number;
  x: number;
  y: number;
}

export interface EventSink {
  push(type: number, step: number, frac: number, a: number, b: number, x: number, y: number): void;
}

export class EventRecorder implements EventSink {
  readonly events: SimEvent[] = [];
  push(type: number, step: number, frac: number, a: number, b: number, x: number, y: number): void {
    this.events.push({ type, step, frac, a, b, x, y });
  }
}

/** Canonical identity of an event, independent of timing. */
export function eventKey(e: SimEvent): string {
  return `${e.type}:${e.a}:${e.b}`;
}
