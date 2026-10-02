/**
 * Event history.
 *
 * Every mind keeps a small ring of its recent *discrete, low-volume* events
 * inside its state buffer (settling into an attractor, leaving one, a
 * postponed spike being released). That ring feeds sound and light, and it is
 * part of the mind's deterministic state.
 *
 * Spikes are high-volume and are never stored during normal play. When the
 * visitor asks when two minds diverged, both are *replayed* from their common
 * ancestor with a full-resolution `EventSink` attached. Deterministic replay
 * makes that reconstruction exact, so nothing has to be logged in advance.
 */

export const EV_SPIKE = 1;
export const EV_SETTLE = 2;
export const EV_UNSETTLE = 3;
export const EV_RELEASE = 4;
export const EV_INTERVENTION = 5;

export const EVENT_NAMES: Record<number, string> = {
  [EV_SPIKE]: 'spike',
  [EV_SETTLE]: 'settled',
  [EV_UNSETTLE]: 'unsettled',
  [EV_RELEASE]: 'postponed spike released',
  [EV_INTERVENTION]: 'intervention',
};

export interface SimEvent {
  type: number;
  step: number;
  /** Neuron index (spikes) or attractor index (settling). */
  a: number;
}

export interface EventSink {
  push(type: number, step: number, a: number): void;
}

export class EventRecorder implements EventSink {
  readonly events: SimEvent[] = [];
  push(type: number, step: number, a: number): void {
    this.events.push({ type, step, a });
  }
}
