import { depthOf } from '../engine/tree';

import { N_ASSEMBLIES } from '../sim/constants';

/**
 * Where minds live on the plane.
 *
 * The family tree is drawn as an H-tree: each split pushes two children apart
 * along alternating axes, so siblings are neighbours, cousins form 2×2
 * blocks, and at 1,024 minds the leaves tile a 32×32 square. Hierarchy is
 * readable as space: zoom out and nearby minds are close relatives.
 */
export const LEAF_SPACING = 2.36;

export function offsetFor(level: number, depth: number): number {
  return (LEAF_SPACING / 2) * Math.pow(2, Math.floor((depth - level) / 2));
}

/** Position of any node (leaf or internal) in the H-tree of the given total depth. */
export function treePosition(key: number, depth: number): [number, number] {
  const d = depthOf(key);
  let x = 0;
  let y = 0;
  for (let level = 1; level <= d; level++) {
    const bit = (key >> (d - level)) & 1;
    const sign = bit ? 1 : -1;
    const o = offsetFor(level, depth);
    if (level % 2 === 1) x += sign * o;
    else y += sign * o;
  }
  return [x, y];
}

/** Axis-aligned bounds of the leaves of an H-tree of this depth (tile radius 1 included). */
export function treeBounds(depth: number): { minX: number; maxX: number; minY: number; maxY: number } {
  let maxX = 0;
  let maxY = 0;
  for (let level = 1; level <= depth; level++) {
    const o = offsetFor(level, depth);
    if (level % 2 === 1) maxX += o;
    else maxY += o;
  }
  return { minX: -maxX - 1.15, maxX: maxX + 1.15, minY: -maxY - 1.15, maxY: maxY + 1.15 };
}

// ---------------------------------------------------------------------------
// The landscape of interpretations
// ---------------------------------------------------------------------------

/**
 * Where each attractor sits on the landscape (unit circle, y down). They are
 * arranged so that neighbours share a fragment of the stimulus:
 * home–nostalgia (house), nostalgia–distance (rain), distance–loss (rain),
 * loss–fear (figure), fear–safety (figure), safety–home (doorway).
 * UNKNOWN, the undecided state, is the centre.
 */
const ANCHOR_ORDER = [0, 4, 5, 1, 2, 3]; // home, nostalgia, distance, loss, fear, safety (clockwise from the top)
export const ANCHORS: Array<[number, number]> = (() => {
  const out: Array<[number, number]> = new Array(N_ASSEMBLIES);
  ANCHOR_ORDER.forEach((k, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / N_ASSEMBLIES;
    out[k] = [Math.cos(a), Math.sin(a)];
  });
  return out;
})();

/**
 * Projects a mind's state onto the landscape: a RadViz-style projection of
 * its six assembly rates (each assembly pulls toward its anchor in
 * proportion to its share of activity), drawn outward to the dominant
 * anchor as the mind commits to it. Undecided minds sit near the centre.
 */
export function landscapeTarget(rates: ArrayLike<number>, commitment: number): [number, number] {
  let sum = 0;
  let best = 0;
  for (let k = 0; k < N_ASSEMBLIES; k++) {
    sum += Math.max(0, rates[k]);
    if (rates[k] > rates[best]) best = k;
  }
  let x = 0;
  let y = 0;
  if (sum > 1e-9) {
    for (let k = 0; k < N_ASSEMBLIES; k++) {
      const s = Math.max(0, rates[k]) / sum;
      x += s * ANCHORS[k][0];
      y += s * ANCHORS[k][1];
    }
  }
  const c = Math.max(0, Math.min(1, commitment));
  return [x * 0.55 * (1 - c) + ANCHORS[best][0] * c, y * 0.55 * (1 - c) + ANCHORS[best][1] * c];
}

export interface ClusterGroup {
  name: string;
  keys: number[];
  /** Where the label sits (above the block). */
  labelX: number;
  labelY: number;
  width: number;
}

/**
 * Arrange leaves by outcome: one compact block per outcome class, side by
 * side, each block as square as possible. Within a block, worlds keep their
 * family order so relatives stay near each other.
 */
export function clusterLayout(
  groups: Array<{ name: string; keys: number[] }>,
): { positions: Map<number, [number, number]>; groups: ClusterGroup[]; width: number; height: number } {
  const s = LEAF_SPACING;
  const total = groups.reduce((a, g) => a + g.keys.length, 0);
  const rows = Math.max(1, Math.round(Math.sqrt(total / 2.2)));
  const blocks = groups
    .filter((g) => g.keys.length > 0)
    .map((g) => {
      const r = Math.min(rows, Math.max(1, Math.ceil(Math.sqrt(g.keys.length / 1.0))));
      const cols = Math.ceil(g.keys.length / r);
      return { ...g, rows: r, cols };
    });
  const gap = s * 2.2;
  const width = blocks.reduce((a, b) => a + b.cols * s, 0) + gap * Math.max(0, blocks.length - 1);
  const height = Math.max(...blocks.map((b) => b.rows * s), s);
  const positions = new Map<number, [number, number]>();
  const out: ClusterGroup[] = [];
  let x = -width / 2;
  for (const b of blocks) {
    const bh = b.rows * s;
    const y0 = -bh / 2 + s / 2;
    b.keys.forEach((k, i) => {
      const c = Math.floor(i / b.rows);
      const r = i % b.rows;
      positions.set(k, [x + c * s + s / 2, y0 + r * s]);
    });
    out.push({ name: b.name, keys: b.keys, labelX: x + (b.cols * s) / 2, labelY: -bh / 2 - s * 0.55, width: b.cols * s });
    x += b.cols * s + gap;
  }
  return { positions, groups: out, width, height };
}
