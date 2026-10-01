import { FIELD_N, KIND_HUNTER, MAX_REMNANTS, N_LINEAGES, POP_HIST, WORLD_RADIUS } from './constants';
import { FIELD_MASK, type World } from './world';

/**
 * Measurable properties of one future, all computed from its state.
 *
 *  grazers / hunters  living organisms of each kind
 *  lineages           founder lineages that still have living grazers
 *  dominance          share of grazers belonging to the largest lineage (0–1)
 *  diversity          inverse Simpson index over lineages, 1/Σp² — the
 *                     "effective number" of lineages (1 … 6)
 *  resource           mean resource level over the disk (0–1)
 *  biomass            total energy held by the living
 *  spread             RMS distance of organisms from the centre / radius
 *  motion             mean speed of organisms (units per step)
 *  volatility         coefficient of variation of the grazer population over
 *                     the last ~32 s (population history ring)
 *  structures         living remnant nodes
 */
export interface WorldMetrics {
  grazers: number;
  hunters: number;
  lineages: number;
  dominance: number;
  diversity: number;
  resource: number;
  biomass: number;
  spread: number;
  motion: number;
  volatility: number;
  structures: number;
  births: number;
  deaths: number;
  catches: number;
  outcome: Outcome;
}

export const OUTCOMES = ['collapsed', 'dominated', 'unhunted', 'diverse', 'stable'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_INDEX: Record<Outcome, number> = {
  collapsed: 0,
  dominated: 1,
  unhunted: 2,
  diverse: 3,
  stable: 4,
};

/**
 * Outcome classes, checked in order (first match wins):
 *
 *  collapsed  fewer than 6 grazers remain — the food web has failed
 *  dominated  one lineage holds ≥ 75 % of grazers
 *  unhunted   every hunter has died; the grazers live unchecked
 *  diverse    ≥ 2.6 effective lineages coexist
 *  stable     anything else: a steady world with a few lineages
 *
 * (Population volatility is measured and reported, but not used as a class:
 * the shared seasonal cycle makes every world swing together, so it does
 * not distinguish one future from another.)
 *
 * The thresholds were chosen by running many perturbed futures headless and
 * picking values that separate qualitatively different worlds by eye; they are
 * descriptive labels, not claims about real ecosystems.
 */
export const CLASSIFY = {
  collapseBelow: 6,
  dominanceAtLeast: 0.75,
  diversityAtLeast: 2.6,
} as const;

export function classify(m: Omit<WorldMetrics, 'outcome'>): Outcome {
  if (m.grazers < CLASSIFY.collapseBelow) return 'collapsed';
  if (m.dominance >= CLASSIFY.dominanceAtLeast) return 'dominated';
  if (m.hunters === 0) return 'unhunted';
  if (m.diversity >= CLASSIFY.diversityAtLeast) return 'diverse';
  return 'stable';
}

export function computeMetrics(w: World): WorldMetrics {
  const n = w.n;
  const lc = w.linCount;
  const grazers = lc[N_LINEAGES + 1];
  const hunters = lc[N_LINEAGES];
  let lineages = 0;
  let maxL = 0;
  let simpson = 0;
  for (let L = 0; L < N_LINEAGES; L++) {
    const c = lc[L];
    if (c > 0) lineages++;
    if (c > maxL) maxL = c;
    if (grazers > 0) {
      const p = c / grazers;
      simpson += p * p;
    }
  }
  const dominance = grazers > 0 ? maxL / grazers : 0;
  const diversity = simpson > 0 ? 1 / simpson : 0;

  let rsum = 0;
  let rcount = 0;
  const res = w.res;
  for (let c = 0; c < FIELD_N * FIELD_N; c++) {
    if (!FIELD_MASK[c]) continue;
    rsum += res[c];
    rcount++;
  }

  let biomass = 0;
  let r2sum = 0;
  let speed = 0;
  for (let i = 0; i < n; i++) {
    biomass += w.e[i];
    r2sum += w.x[i] * w.x[i] + w.y[i] * w.y[i];
    speed += Math.sqrt(w.vx[i] * w.vx[i] + w.vy[i] * w.vy[i]);
  }

  let structures = 0;
  for (let k = 0; k < MAX_REMNANTS; k++) if (w.rAlive[k]) structures++;

  const m = {
    grazers,
    hunters,
    lineages,
    dominance,
    diversity,
    resource: rcount ? rsum / rcount : 0,
    biomass,
    spread: n ? Math.sqrt(r2sum / n) / WORLD_RADIUS : 0,
    motion: n ? speed / n : 0,
    volatility: volatility(w),
    structures,
    births: w.births,
    deaths: w.deaths,
    catches: w.catches,
  };
  return { ...m, outcome: classify(m) };
}

function volatility(w: World): number {
  const len = w.phLen;
  if (len < 8) return 0;
  const h = w.popHist;
  let sum = 0;
  let sum2 = 0;
  for (let k = 0; k < len; k++) {
    const v = h[(w.phHead - 1 - k + POP_HIST) % POP_HIST];
    sum += v;
    sum2 += v * v;
  }
  const mean = sum / len;
  if (mean <= 0) return 0;
  const variance = Math.max(0, sum2 / len - mean * mean);
  return Math.sqrt(variance) / mean;
}

/** Fixed-order numeric encoding of metrics for transfer between threads. */
export const METRIC_FIELDS = [
  'grazers',
  'hunters',
  'lineages',
  'dominance',
  'diversity',
  'resource',
  'biomass',
  'spread',
  'motion',
  'volatility',
  'structures',
  'births',
  'deaths',
  'catches',
] as const;
export const METRIC_COUNT = METRIC_FIELDS.length + 1 + N_LINEAGES; // + outcome + lineage counts

export function encodeMetrics(w: World, m: WorldMetrics, out: Float32Array, offset: number): void {
  for (let k = 0; k < METRIC_FIELDS.length; k++) out[offset + k] = m[METRIC_FIELDS[k]];
  out[offset + METRIC_FIELDS.length] = OUTCOME_INDEX[m.outcome];
  for (let L = 0; L < N_LINEAGES; L++) out[offset + METRIC_FIELDS.length + 1 + L] = w.linCount[L];
}

export interface DecodedMetrics extends WorldMetrics {
  lineageCounts: number[];
}

export function decodeMetrics(src: Float32Array, offset: number): DecodedMetrics {
  const m: Record<string, number> = {};
  for (let k = 0; k < METRIC_FIELDS.length; k++) m[METRIC_FIELDS[k]] = src[offset + k];
  const lineageCounts: number[] = [];
  for (let L = 0; L < N_LINEAGES; L++) lineageCounts.push(src[offset + METRIC_FIELDS.length + 1 + L]);
  return {
    ...(m as unknown as Omit<WorldMetrics, 'outcome'>),
    outcome: OUTCOMES[src[offset + METRIC_FIELDS.length]] ?? 'stable',
    lineageCounts,
  };
}

export function isHunter(w: World, i: number): boolean {
  return w.kind[i] === KIND_HUNTER;
}
