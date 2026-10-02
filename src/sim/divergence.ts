import { N_ASSEMBLIES, N_NEURONS } from './constants';
import type { Mind } from './mind';

/**
 * DIVERGENCE METRIC
 * =================
 *
 * How different are two minds that started as one? Every unit exists in
 * both (same seed, same wiring), so they can be compared unit by unit.
 *
 *   unitTerm      Σᵢ |aᵢᴬ − aᵢᴮ| / Σᵢ (aᵢᴬ + aᵢᴮ)       activation traces (τ = 50 ms)
 *   membraneTerm  meanᵢ min(1, |vᵢᴬ − vᵢᴮ| / 0.25)       sub-threshold state
 *   micro         0.75 · unitTerm + 0.25 · membraneTerm  which units are doing what
 *
 *   assemblyTerm  Σₖ |rₖᴬ − rₖᴮ| / Σₖ (rₖᴬ + rₖᴮ)       population rates of the six assemblies
 *                                                     (where the mind is heading)
 *
 *   divergence = 0.5 · micro + 0.5 · assemblyTerm        ∈ [0, 1]
 *
 * Identical minds score exactly 0. One postponed spike starts near 0.05 %.
 * Two minds whose spikes have decorrelated but which rest in the same
 * attractor score roughly 25–40 %; minds resting in different attractors
 * score 80 % or more. The split between the two halves is what lets the
 * number tell "the same thought, differently" from "a different thought".
 */
export const DIVERGENCE_V0 = 0.25;
export const MICRO_UNIT_WEIGHT = 0.75;
export const MACRO_WEIGHT = 0.5;

export interface DivergenceResult {
  score: number;
  micro: number;
  macro: number;
}

/** Divergence from raw arrays (used on full-precision state and on transferred frames). */
export function divergenceOf(
  traceA: ArrayLike<number>,
  traceB: ArrayLike<number>,
  vA: ArrayLike<number> | null,
  vB: ArrayLike<number> | null,
  ratesA: ArrayLike<number>,
  ratesB: ArrayLike<number>,
  n = N_NEURONS,
): DivergenceResult {
  let diff = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = traceA[i];
    const b = traceB[i];
    diff += a > b ? a - b : b - a;
    sum += a + b;
  }
  const unitTerm = sum > 1e-12 ? diff / sum : diff > 0 ? 1 : 0;
  let memTerm = 0;
  if (vA && vB) {
    let mv = 0;
    for (let i = 0; i < n; i++) {
      const d = vA[i] - vB[i];
      const c = (d < 0 ? -d : d) / DIVERGENCE_V0;
      mv += c > 1 ? 1 : c;
    }
    memTerm = mv / n;
  }
  const micro = vA && vB ? MICRO_UNIT_WEIGHT * unitTerm + (1 - MICRO_UNIT_WEIGHT) * memTerm : unitTerm;
  let rd = 0;
  let rs = 0;
  for (let k = 0; k < N_ASSEMBLIES; k++) {
    const a = ratesA[k];
    const b = ratesB[k];
    rd += a > b ? a - b : b - a;
    rs += a + b;
  }
  const macro = rs > 1e-12 ? rd / rs : rd > 0 ? 1 : 0;
  return { score: (1 - MACRO_WEIGHT) * micro + MACRO_WEIGHT * macro, micro, macro };
}

export function mindDivergence(a: Mind, b: Mind): DivergenceResult {
  return divergenceOf(a.trace, b.trace, a.v, b.v, a.rate, b.rate);
}
