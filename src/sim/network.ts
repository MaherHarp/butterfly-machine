import {
  ASSEMBLY_SIZE,
  CH_DOOR,
  CH_FIGURE,
  CH_HOUSE,
  CH_RAIN,
  CH_TEXTURE,
  EXC_START,
  INH_START,
  MAX_DELAY,
  N_ASSEMBLIES,
  N_CHANNELS,
  N_EXC,
  N_INH,
  N_NEURONS,
  SENSORY_PER_CHANNEL,
  SENS_START,
  TYPE_EXC,
  TYPE_INH,
  TYPE_SENSORY,
} from './constants';
import { Rng, TAU, dcos, dsin } from './hash';

/**
 * THE ARCHITECTURE
 * ================
 *
 * Everything about a mind that never changes while it runs: who connects to
 * whom, with what weight and delay, and where each unit sits in the picture.
 * It is a pure function of the seed, built once per thread and shared by
 * every mind descended from that seed, so a branch only has to copy dynamic
 * state (see mind.ts).
 *
 *   sensory units   five channels, one per fragment of the stimulus
 *   assemblies      six groups of excitatory units with strong recurrent
 *                   connections among themselves — each group can sustain its
 *                   own activity, which makes it an attractor
 *   inhibitory pool shared, fast inhibition that lets one assembly silence
 *                   the others (competition between interpretations)
 *
 * Positions are for the eye only. Assemblies lie along curving arms, the
 * sensory ring surrounds the stimulus at the centre, interneurons fill the
 * space between. Delays grow with distance, so what looks far takes longer.
 */

/** The interpretation each assembly stands for, in the artwork's own vocabulary. */
export const ATTRACTOR_NAMES = ['home', 'loss', 'fear', 'safety', 'nostalgia', 'distance'] as const;
export const UNKNOWN = N_ASSEMBLIES; // index of the "not settled / mixed" outcome
export const OUTCOME_NAMES = [...ATTRACTOR_NAMES, 'unknown'] as const;
export type OutcomeName = (typeof OUTCOME_NAMES)[number];

/**
 * How strongly each stimulus fragment feeds each assembly:
 * rows = assemblies (home, loss, fear, safety, nostalgia, distance),
 * columns = channels (house, rain, figure, doorway light, texture).
 * Every assembly receives roughly the same total drive: the stimulus is
 * ambiguous by construction, and recurrent competition has to decide.
 */
export const AFFINITY: readonly (readonly number[])[] = (() => {
  const a = [
    // house rain figure door texture
    [1.0, 0.0, 0.3, 1.0, 0.0], // home: a house with a lit doorway
    [0.0, 1.0, 1.0, 0.0, 0.3], // loss: a figure in the rain
    [0.0, 0.3, 1.0, 0.0, 1.0], // fear: a silhouette among broken shapes
    [0.3, 0.0, 1.0, 1.0, 0.0], // safety: a figure in the light of a door
    [1.0, 1.0, 0.0, 0.0, 0.3], // nostalgia: a house in the rain
    [0.3, 1.0, 0.0, 0.0, 1.0], // distance: rain and scattered texture
  ];
  void CH_HOUSE;
  void CH_RAIN;
  void CH_FIGURE;
  void CH_DOOR;
  void CH_TEXTURE;
  return a;
})();

/**
 * Wiring. Every unit of a class receives exactly the same number of inputs
 * from each source class (fixed in-degree), chosen at random from the seed.
 * That keeps the six interpretations on an equal footing: no assembly wins
 * because it happened to be wired more strongly.
 */
export const WIRING = {
  /** Inputs to an excitatory unit: from its own assembly, other assemblies, inhibition. */
  kEEin: 18,
  kEEout: 6,
  kIE: 32,
  /** Inputs to an inhibitory unit: from excitation, from inhibition. */
  kEI: 80,
  kII: 22,
  /** Sensory inputs to an excitatory unit per channel at affinity 1 (affinity 0.3 → 1 input). */
  kSE: 3,
  /** Feedback to a sensory unit from the assemblies that read its channel, and from inhibition. */
  kES: 8,
  kIS: 6,
  wES: 0.06,
  wIS: 0.1,
  wEEin: 0.15,
  wEEout: 0.06,
  wEI: 0.075,
  wIE: 0.15,
  wII: 0.12,
  wSE: 0.11,
  /** Multiplicative weight jitter (uniform ±). */
  jitter: 0.15,
};

export interface Network {
  readonly seed: number;
  readonly n: number;
  /** TYPE_SENSORY / TYPE_EXC / TYPE_INH. */
  readonly type: Uint8Array;
  /** Assembly index for excitatory units, channel for sensory units, 255 for inhibitory. */
  readonly group: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Where the unit would sit on its arm without scatter (for drawing a mind that has "come together"). */
  readonly tidyX: Float32Array;
  readonly tidyY: Float32Array;
  /** A per-unit number in [0, 1) for visual variety. */
  readonly hash: Float32Array;
  /** Outgoing synapses in CSR form: out[outStart[i] .. outStart[i+1]). */
  readonly outStart: Int32Array;
  readonly outTarget: Uint16Array;
  readonly outWeight: Float64Array;
  readonly outDelay: Uint8Array;
  /** Incoming synapses (for tracing causes backwards): source and delay. */
  readonly inStart: Int32Array;
  readonly inSource: Uint16Array;
  readonly inDelay: Uint8Array;
  /** A few outgoing synapses per unit chosen for drawing (indices into out*). */
  readonly drawStart: Int32Array;
  readonly drawSyn: Int32Array;
  readonly synapses: number;
}

const cache = new Map<number, Network>();
let last: Network | null = null;

/** Forget built networks (tuning scripts that change WIRING). */
export function clearNetworkCache(): void {
  cache.clear();
  last = null;
}

/** The network for a seed (built once, then shared). */
export function networkFor(seed: number): Network {
  seed = seed >>> 0;
  if (last && last.seed === seed) return last;
  let net = cache.get(seed);
  if (!net) {
    if (cache.size > 6) cache.clear();
    net = buildNetwork(seed);
    cache.set(seed, net);
  }
  last = net;
  return net;
}

function buildNetwork(seed: number): Network {
  const rng = new Rng(seed ^ 0x6e657431);
  const n = N_NEURONS;
  const type = new Uint8Array(n);
  const group = new Uint8Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const tidyX = new Float32Array(n);
  const tidyY = new Float32Array(n);
  const hash = new Float32Array(n);

  // ---- placement ------------------------------------------------------------
  const spin = rng.next() * TAU;
  const twist = 1.25 + rng.range(-0.25, 0.25);
  const armAngle: number[] = [];
  for (let k = 0; k < N_ASSEMBLIES; k++) armAngle.push(spin + (k * TAU) / N_ASSEMBLIES + rng.range(-0.12, 0.12));

  for (let c = 0; c < N_CHANNELS; c++) {
    const a0 = spin + 0.4 + (c * TAU) / N_CHANNELS;
    for (let j = 0; j < SENSORY_PER_CHANNEL; j++) {
      const i = SENS_START + c * SENSORY_PER_CHANNEL + j;
      type[i] = TYPE_SENSORY;
      group[i] = c;
      const a = a0 + (j - (SENSORY_PER_CHANNEL - 1) / 2) * 0.075 + rng.range(-0.02, 0.02);
      const r = 0.29 + rng.range(-0.016, 0.016) + (j % 3) * 0.02;
      x[i] = r * dcos(a);
      y[i] = r * dsin(a);
      tidyX[i] = 0.3 * dcos(a);
      tidyY[i] = 0.3 * dsin(a);
    }
  }
  for (let k = 0; k < N_ASSEMBLIES; k++) {
    // Each arm has a main stem and two side branches.
    const branchAt = [rng.range(0.5, 0.62), rng.range(0.66, 0.8)];
    const branchDir = [rng.next() < 0.5 ? -1 : 1, 0];
    branchDir[1] = -branchDir[0];
    for (let j = 0; j < ASSEMBLY_SIZE; j++) {
      const i = EXC_START + k * ASSEMBLY_SIZE + j;
      type[i] = TYPE_EXC;
      group[i] = k;
      const u = (j + rng.next()) / ASSEMBLY_SIZE;
      let r = 0.38 + 0.56 * Math.sqrt(u);
      const a0 = armAngle[k] + twist * (r - 0.38);
      let a = a0 + rng.gauss() * 0.045 * (0.6 + r);
      const b = j % 5;
      if (b >= 3) {
        // On a side branch: peel away from the stem.
        const which = b - 3;
        const r0 = branchAt[which];
        if (r > r0) {
          a += branchDir[which] * (r - r0) * 1.5;
          r = r0 + (r - r0) * 0.85;
        }
      }
      r += rng.gauss() * 0.012;
      if (r > 0.955) r = 0.955 - rng.next() * 0.02;
      x[i] = r * dcos(a);
      y[i] = r * dsin(a);
      // Tidy: on the stem itself, evenly spaced.
      const rt = 0.38 + 0.56 * ((j + 0.5) / ASSEMBLY_SIZE);
      const at = armAngle[k] + twist * (rt - 0.38);
      tidyX[i] = rt * dcos(at);
      tidyY[i] = rt * dsin(at);
    }
  }
  for (let j = 0; j < N_INH; j++) {
    const i = INH_START + j;
    type[i] = TYPE_INH;
    group[i] = 255;
    const r = 0.36 + 0.58 * Math.sqrt(rng.next());
    const k = j % N_ASSEMBLIES;
    // Between the arms.
    const a = armAngle[k] + TAU / N_ASSEMBLIES / 2 + twist * (r - 0.38) + rng.gauss() * 0.16;
    x[i] = r * dcos(a);
    y[i] = r * dsin(a);
    tidyX[i] = x[i];
    tidyY[i] = y[i];
  }
  for (let i = 0; i < n; i++) hash[i] = rng.next();

  // ---- wiring ----------------------------------------------------------------
  const W = WIRING;
  const lists: Array<Array<[number, number, number]>> = [];
  for (let i = 0; i < n; i++) lists.push([]);
  const jit = () => 1 + W.jitter * (rng.next() * 2 - 1);
  const delayFor = (i: number, j: number) => {
    const dx = x[i] - x[j];
    const dy = y[i] - y[j];
    const d = Math.sqrt(dx * dx + dy * dy);
    let dl = 1 + Math.floor(d * 5.2 + rng.next() * 2.5);
    if (dl > MAX_DELAY) dl = MAX_DELAY;
    return dl;
  };
  /** Choose `k` distinct sources from `pool` (partial Fisher–Yates) and connect them to `j`. */
  const connect = (j: number, pool: number[], k: number, w: number) => {
    const p = pool.slice();
    const take = Math.min(k, p.length);
    for (let a = 0; a < take; a++) {
      const b = a + rng.int(p.length - a);
      const tmp = p[a];
      p[a] = p[b];
      p[b] = tmp;
      lists[p[a]].push([j, w * jit(), delayFor(p[a], j)]);
    }
  };
  const range = (a: number, b: number, skip = -1) => {
    const out: number[] = [];
    for (let i = a; i < b; i++) if (i !== skip) out.push(i);
    return out;
  };
  const allExc = range(EXC_START, EXC_START + N_EXC);
  for (let j = 0; j < n; j++) {
    if (type[j] === TYPE_EXC) {
      const k = group[j];
      const a0 = EXC_START + k * ASSEMBLY_SIZE;
      connect(j, range(a0, a0 + ASSEMBLY_SIZE, j), W.kEEin, W.wEEin);
      connect(j, allExc.filter((i) => group[i] !== k), W.kEEout, W.wEEout);
      connect(j, range(INH_START, INH_START + N_INH), W.kIE, -W.wIE);
      for (let c = 0; c < N_CHANNELS; c++) {
        const aff = AFFINITY[k][c];
        if (aff <= 0) continue;
        const kk = aff >= 0.75 ? W.kSE : 1;
        const s0 = SENS_START + c * SENSORY_PER_CHANNEL;
        connect(j, range(s0, s0 + SENSORY_PER_CHANNEL), kk, W.wSE * (aff >= 0.75 ? aff : aff * W.kSE));
      }
    } else if (type[j] === TYPE_SENSORY) {
      // Top-down: what the network is leaning toward shapes what it perceives.
      const c = group[j];
      connect(j, allExc.filter((i) => AFFINITY[group[i]][c] >= 0.75), W.kES, W.wES);
      connect(j, range(INH_START, INH_START + N_INH), W.kIS, -W.wIS);
    } else if (type[j] === TYPE_INH) {
      connect(j, allExc, W.kEI, W.wEI);
      connect(j, range(INH_START, INH_START + N_INH, j), W.kII, -W.wII);
    }
  }

  let total = 0;
  for (const l of lists) total += l.length;
  const outStart = new Int32Array(n + 1);
  const outTarget = new Uint16Array(total);
  const outWeight = new Float64Array(total);
  const outDelay = new Uint8Array(total);
  let s = 0;
  for (let i = 0; i < n; i++) {
    outStart[i] = s;
    // Sort by target so iteration order is canonical.
    lists[i].sort((a, b) => a[0] - b[0]);
    for (const [t, w, d] of lists[i]) {
      outTarget[s] = t;
      outWeight[s] = w;
      outDelay[s] = d;
      s++;
    }
  }
  outStart[n] = s;

  // Incoming lists.
  const inCount = new Int32Array(n);
  for (let k = 0; k < total; k++) inCount[outTarget[k]]++;
  const inStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) inStart[i + 1] = inStart[i] + inCount[i];
  const fill = inStart.slice(0, n);
  const inSource = new Uint16Array(total);
  const inDelay = new Uint8Array(total);
  for (let i = 0; i < n; i++) {
    for (let k = outStart[i]; k < outStart[i + 1]; k++) {
      const t = outTarget[k];
      inSource[fill[t]] = i;
      inDelay[fill[t]] = outDelay[k];
      fill[t]++;
    }
  }

  // Filaments to draw: each unit's nearest few real targets (the picture only shows real wiring).
  const drawLists: number[][] = [];
  for (let i = 0; i < n; i++) {
    const cand: Array<[number, number]> = [];
    for (let k = outStart[i]; k < outStart[i + 1]; k++) {
      const t = outTarget[k];
      const dx = x[i] - x[t];
      const dy = y[i] - y[t];
      cand.push([dx * dx + dy * dy, k]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    const keep = type[i] === TYPE_INH ? 2 : type[i] === TYPE_SENSORY ? 4 : 3;
    drawLists.push(cand.slice(0, keep).map((c) => c[1]));
  }
  const drawStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) drawStart[i + 1] = drawStart[i] + drawLists[i].length;
  const drawSyn = new Int32Array(drawStart[n]);
  for (let i = 0; i < n; i++) drawSyn.set(drawLists[i], drawStart[i]);

  return {
    seed,
    n,
    type,
    group,
    x,
    y,
    tidyX,
    tidyY,
    hash,
    outStart,
    outTarget,
    outWeight,
    outDelay,
    inStart,
    inSource,
    inDelay,
    drawStart,
    drawSyn,
    synapses: total,
  };
}

export function assemblyOf(net: Network, i: number): number {
  return net.type[i] === TYPE_EXC ? net.group[i] : -1;
}

export { N_EXC };
