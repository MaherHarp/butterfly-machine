import { OUTCOME_NAMES, UNKNOWN } from '../sim/network';
import type { FirstDivergence } from '../sim/replay';

export function pct(v: number): string {
  const p = Math.max(0, v) * 100;
  if (p === 0) return '0.0%';
  if (p < 0.1) return `${p.toFixed(3)}%`;
  if (p < 1) return `${p.toFixed(2)}%`;
  return `${p.toFixed(1)}%`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Network time, e.g. "1.483 s". */
export function secs(seconds: number, digits = 3): string {
  return `${Math.max(0, seconds).toFixed(digits)} s`;
}

export function signedSecs(seconds: number): string {
  return `+${Math.max(0, seconds).toFixed(2)} s`;
}

export function thousands(n: number): string {
  return n.toLocaleString('en-US');
}

/** The interpretation names as the artwork writes them. */
export const OUTCOME_LABEL: string[] = OUTCOME_NAMES.map((n) => n.toUpperCase());

/** One line on what each region of state space is, for hover titles. */
export const OUTCOME_DESCRIPTION: string[] = [
  'The house-and-doorway assembly holds the network.',
  'The figure-in-the-rain assembly holds the network.',
  'The silhouette-and-fragments assembly holds the network.',
  'The figure-in-the-doorway assembly holds the network.',
  'The house-in-the-rain assembly holds the network.',
  'The rain-and-scattered-texture assembly holds the network.',
  'No assembly holds the network: it has not settled.',
];

/**
 * A restrained colour for each interpretation (never pink: pink is reserved
 * for the change and what it caused).
 */
export const OUTCOME_COLOR: Array<[number, number, number]> = [
  [0.98, 0.8, 0.56], // home: warm lamplight
  [0.58, 0.66, 0.8], // loss: slate
  [0.72, 0.64, 0.9], // fear: cold violet
  [0.72, 0.88, 0.76], // safety: soft sage
  [0.9, 0.74, 0.6], // nostalgia: sepia
  [0.64, 0.84, 0.9], // distance: pale cold blue
  [0.7, 0.7, 0.7], // unknown: grey
];

export const PINK: [number, number, number] = [1.0, 0.16, 0.52];

export function cssColor(c: [number, number, number], a = 1): string {
  const r = Math.round(c[0] * 255);
  const g = Math.round(c[1] * 255);
  const b = Math.round(c[2] * 255);
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Outcome counts and shares for a set of minds — computed, never assumed. */
export function tallyOutcomes(outcomes: ArrayLike<number>): { counts: number[]; shares: number[]; total: number } {
  const counts = new Array(UNKNOWN + 1).fill(0);
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    counts[o >= 0 && o <= UNKNOWN ? o : UNKNOWN]++;
  }
  const total = outcomes.length;
  return { counts, shares: counts.map((c) => (total > 0 ? c / total : 0)), total };
}

function ms(v: number): string {
  const a = Math.abs(v);
  return a < 10 ? a.toFixed(0) : a.toFixed(0);
}

/** Large spaced capitals describing the first divergence, e.g. "ONE SPIKE OCCURRED 4 MS EARLIER". */
export function divergenceHeadline(r: FirstDivergence): string {
  if (!r.found) return 'THESE MINDS NEVER DIVERGED';
  if (r.delayMs !== null && r.delayMs !== 0) {
    return `ONE SPIKE OCCURRED ${ms(r.delayMs)} MS ${r.delayMs > 0 ? 'LATER' : 'EARLIER'}`;
  }
  if (r.cause?.kind === 'nudge') return 'ONE UNIT WAS A LITTLE MORE ACTIVE';
  if (r.cause?.kind === 'weight') return 'ONE CONNECTION WAS A LITTLE DIFFERENT';
  return 'ONE SPIKE HAPPENED IN ONLY ONE MIND';
}

/** The sentence under it. */
export function divergenceLine(r: FirstDivergence, nameX: string, nameY: string): string {
  if (!r.found) return 'Their histories stayed identical.';
  const call = (n: string) => (n === 'ORIGINAL' || n === 'ALTERED' ? `the ${n.toLowerCase()} mind` : `Mind ${n}`);
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const later = r.delayMs !== null && r.delayMs > 0 ? nameY : nameX;
  const traced = r.traceable ? 'It is the change made where they parted.' : 'Everything before it was identical.';
  if (r.delayMs !== null) return `${cap(`in ${call(later)}`)}, one unit fired <em>${ms(r.delayMs)} ms</em> ${r.delayMs > 0 ? 'later' : 'earlier'}. ${traced}`;
  const there = r.stepX >= 0 ? nameX : nameY;
  return `A unit fired in ${call(there)} and not in its twin. ${traced}`;
}

