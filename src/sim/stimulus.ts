import { N_CHANNELS, STIM_ON, STIM_RAMP } from './constants';

/**
 * THE AMBIGUOUS STIMULUS
 * ======================
 *
 * Every mind sees exactly the same thing: five fragments, shown at fixed
 * strengths, fading in from STIM_ON. Nothing about it depends on the mind.
 *
 *   house     a few lines of roof and wall
 *   rain      falling strokes
 *   figure    a standing silhouette
 *   doorway   light from an open door
 *   texture   broken, scattered shapes
 *
 * No fragment means anything by itself; which reading wins is decided by the
 * network. The fragments are drawn by the renderer from the same numbers.
 */
export const FRAGMENT_NAMES = ['house', 'rain', 'figure', 'doorway', 'texture'] as const;

/** Contrast of each fragment once fully shown (deliberately close to equal). */
export const FRAGMENT_STRENGTH: readonly number[] = [0.96, 1.0, 0.94, 0.98, 1.0];

/** Overall stimulus contrast at a step (0 before onset, smooth ramp to 1). */
export function stimulusLevel(step: number): number {
  if (step < STIM_ON) return 0;
  const u = (step - STIM_ON) / STIM_RAMP;
  if (u >= 1) return 1;
  return u * u * (3 - 2 * u);
}

/** Contrast of one fragment channel at a step. */
export function channelLevel(step: number, c: number): number {
  return c < N_CHANNELS ? FRAGMENT_STRENGTH[c] * stimulusLevel(step) : 0;
}
