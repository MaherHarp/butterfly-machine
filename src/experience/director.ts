import { Sound, type SoundEvent, type VoiceState } from '../audio/sound';
import { AGENT_STRIDE, LOD_HIGH, LOD_LOW, LOD_NONE, type WorldFrame } from '../engine/packet';
import { SimPool } from '../engine/pool';
import { BranchTree, depthOf, parentOf, siblingOf } from '../engine/tree';
import { Camera, easeInOut, easeOut, type View } from '../render/camera';
import { Renderer, type TileInput } from '../render/renderer';
import { ShapeBatch } from '../render/shapes';
import {
  EV_BIRTH,
  EV_CATCH,
  EV_DEATH,
  FIELD_MASK,
  IdIndex,
  MAX_AGENTS,
  N_LINEAGES,
  OUTCOMES,
  STEPS_PER_SECOND,
  WORLD_RADIUS,
  decodeMetrics,
  describeIntervention,
  divergenceOf,
  sunPosition,
  type DecodedMetrics,
  type Intervention,
  type Outcome,
} from '../sim';
import type { FirstDifference, PathEntry } from '../sim/replay';
import { Overlay, type Action, type LabelSpec } from '../ui/overlay';
import {
  OUTCOME_COLOR,
  OUTCOME_DESCRIPTION,
  OUTCOME_LABEL,
  clock,
  cssColor,
  describeFirstDifference,
  pct,
  px,
  signedSeconds,
  thousands,
} from './format';
import { clusterLayout, offsetFor, treeBounds, treePosition } from './layout';
import { decodeShare, encodeShare, type ShareSpec } from './share';

type Phase =
  | 'boot'
  | 'title'
  | 'observe'
  | 'freeze'
  | 'touch'
  | 'confirm'
  | 'two'
  | 'firstdiff'
  | 'branch'
  | 'cascade'
  | 'many'
  | 'return'
  | 'origin'
  | 'shared';

interface TileAnim {
  fx: number;
  fy: number;
  fr: number;
  fa: number;
  tx: number;
  ty: number;
  tr: number;
  ta: number;
  t0: number;
  dur: number;
}

interface Replay {
  x: number;
  y: number;
  result: FirstDifference;
  stage: 'search' | 'rewind' | 'approach' | 'moment' | 'cascade' | 'done';
  stageAt: number;
  nameX: string;
  nameY: string;
  returnPhase: Phase;
  returnActions: () => void;
  liveStep: number;
}

const ORIGIN_KEY = 100001;
const REPLAY_X = 9002;
const REPLAY_Y = 9003;
const ORIGIN_SLOT = 9001;
const LOD_SIZE = 4096;
const OBSERVE_SECONDS = 15;

export interface DirectorOptions {
  workers: number;
  maxDepth: number;
  seed: number;
  debug: boolean;
  small: boolean;
  share: string | null;
}

export class Director {
  private readonly renderer: Renderer;
  private readonly camera = new Camera();
  private readonly ui: Overlay;
  private readonly sound = new Sound();
  private readonly pool: SimPool;
  private readonly analyst: SimPool;

  private phase: Phase = 'boot';
  private phaseAt = 0;
  private now = 0;
  private lastFrame = 0;
  private dpr = 1;
  private reduced = false;
  private debugOn: boolean;

  // Clock
  private sim = 0;
  private scale = 1;
  private scaleTarget = 1;
  private scaleTau = 0.6;
  private source: 'pool' | 'analyst' = 'pool';
  private barrier = false;
  private inflight: Promise<void> | null = null;
  private lodDirty = true;
  private lod = new Uint8Array(LOD_SIZE);
  private lastDrawn = 0;

  // Worlds
  private seed: number;
  private tree: BranchTree | null = null;
  private origin: { buf: ArrayBuffer; step: number } | null = null;
  private userIv: Intervention | null = null;
  private userAgentLineage = 0;
  private readonly tiles = new Map<number, TileAnim>();
  private layoutMode: 'tree' | 'cluster' = 'tree';
  private clusterGroups: Array<{ name: Outcome; keys: number[]; labelX: number; labelY: number }> = [];
  private treeAlpha = 0;
  private treeAlphaTarget = 0;

  // Divergence
  private readonly halos = new Map<number, Float32Array>();
  private readonly sibDiv = new Map<number, number>();
  private readonly index = new IdIndex();
  private divGen = -1;
  private headline = 0;
  private firstResembleLost = -1;

  // Interaction
  private hover = -1;
  private focus = -1;
  private pointer: { x: number; y: number; down: boolean; id: number; sx: number; sy: number; moved: number; t: number } = {
    x: 0,
    y: 0,
    down: false,
    id: -1,
    sx: 0,
    sy: 0,
    moved: 0,
    t: 0,
  };
  private dragPrev: { x: number; y: number; t: number; vx: number; vy: number } | null = null;
  private target: { id: number; index: number; x: number; y: number } | null = null;
  private grab: { id: number; index: number; x0: number; y0: number; dx: number; dy: number; dragging: boolean; keyboard: boolean } | null = null;
  private busyAction = false;
  private idleSince = 0;

  // First difference
  private replay: Replay | null = null;

  // Post
  private post = { fade: 0, sat: 1, bloom: 0.85, exposure: 1.25, grain: 0.018 };
  private postTarget = { fade: 1, sat: 1 };

  // Ending
  private collapse: { level: number; stageAt: number; depth: number } | null = null;
  private originShown = 0;

  private readonly under = new ShapeBatch();
  private readonly over = new ShapeBatch();
  private fps = 60;
  private captureScale = 0;
  private share: ShareSpec | null;
  private sharedKey = -1;
  private soundEvents: SoundEvent[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
    private readonly opts: DirectorOptions,
  ) {
    this.renderer = new Renderer(canvas);
    this.ui = new Overlay(uiRoot);
    this.pool = new SimPool(opts.workers);
    this.analyst = new SimPool(1);
    this.seed = opts.seed;
    this.debugOn = opts.debug;
    this.share = opts.share ? decodeShare(opts.share) : null;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduced = mq.matches;
    mq.addEventListener?.('change', (e) => this.setReduced(e.matches));
    if (opts.small) document.body.classList.add('small-screen');
    this.bindControls();
    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      this.sound.suspend(document.hidden);
      this.lastFrame = performance.now();
    });
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start(): Promise<void> {
    this.now = performance.now();
    this.lastFrame = this.now;
    requestAnimationFrame((t) => this.frame(t));
    if (this.share) {
      await this.openShared(this.share);
      return;
    }
    await this.newWorld(true);
  }

  private async newWorld(showTitle: boolean): Promise<void> {
    this.setPhase('boot');
    await this.withBarrier(async () => {
      await this.pool.reset();
      await this.analyst.reset();
    });
    this.tree = null;
    this.origin = null;
    this.userIv = null;
    this.replay = null;
    this.collapse = null;
    this.focus = -1;
    this.hover = -1;
    this.target = null;
    this.grab = null;
    this.layoutMode = 'tree';
    this.treeAlphaTarget = 0;
    this.halos.clear();
    this.sibDiv.clear();
    this.firstResembleLost = -1;
    this.tiles.clear();
    this.source = 'pool';
    this.renderer.clearTrails();
    const step = await this.pool.seed(1, this.seed);
    this.sim = step;
    this.lastDrawn = step;
    this.scale = 1;
    this.scaleTarget = 1;
    this.setTile(1, 0, 0, 1, 1);
    this.camera.set(this.frameWorlds([1], 0.36));
    this.lodDirty = true;
    this.ui.summary(null);
    this.ui.readout(null);
    this.ui.actions(null);
    this.ui.big(null);
    this.ui.line(null);
    this.ui.card(null);
    this.ui.corner(null);
    if (showTitle) {
      this.postTarget.fade = 0.5;
      this.setPhase('title');
      this.ui.showTitle(true, () => this.begin(), this.opts.small ? 'Best experienced on a larger screen.' : undefined);
    } else {
      this.post.fade = 0;
      this.postTarget.fade = 1;
      this.setPhase('observe');
    }
  }

  private begin(): void {
    if (this.phase !== 'title') return;
    this.sound.start();
    this.sound.setMuted(this.sound.isMuted);
    this.ui.showTitle(false);
    this.postTarget.fade = 1;
    this.setPhase('observe');
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseAt = this.now;
    this.idleSince = this.now;
  }

  private get t(): number {
    return (this.now - this.phaseAt) / 1000;
  }

  private dur(ms: number): number {
    return this.reduced ? Math.min(ms, 350) : ms;
  }

  private setReduced(on: boolean): void {
    this.reduced = on;
    document.body.classList.toggle('reduced-motion', on);
    this.ui.motionBtn.textContent = on ? 'Motion: reduced' : 'Motion: full';
  }

  // =========================================================================
  // Clock & simulation
  // =========================================================================

  private src(): SimPool {
    return this.source === 'pool' ? this.pool : this.analyst;
  }

  private async withBarrier<T>(fn: () => Promise<T>): Promise<T> {
    this.barrier = true;
    try {
      while (this.inflight) await this.inflight;
      return await fn();
    } finally {
      this.barrier = false;
      this.lodDirty = true;
    }
  }

  private updateClock(dt: number): void {
    const src = this.src();
    const k = 1 - Math.exp(-dt / Math.max(0.05, this.scaleTau));
    this.scale += (this.scaleTarget - this.scale) * k;
    if (this.scaleTarget === 0 && this.scale < 0.02) {
      if (this.scale !== 0) this.sim = Math.ceil(this.sim - 1e-6);
      this.scale = 0;
    }
    if (this.scale > 0) this.sim += dt * STEPS_PER_SECOND * this.scale;
    const maxLead = 2 + STEPS_PER_SECOND * dt * Math.max(1, this.scale) * 1.5;
    if (this.sim > src.step + maxLead) this.sim = src.step + maxLead;
    if (this.sim < src.step) this.sim = src.step;
    const want = Math.floor(this.sim);
    if (!this.barrier && !this.inflight && src.worldCount > 0 && (want > src.step || this.lodDirty)) {
      this.lodDirty = false;
      const lod = this.source === 'pool' ? this.lod : new Uint8Array(0);
      const p = src.advance(Math.max(want, src.step), lod, this.source === 'pool' ? LOD_NONE : LOD_HIGH);
      this.inflight = p.then(() => {
        this.inflight = null;
      });
    }
  }

  private get alpha(): number {
    const src = this.src();
    return Math.max(0, Math.min(1, this.sim - src.step));
  }

  private frameFor(key: number): WorldFrame | null {
    if (key === ORIGIN_KEY) return this.analyst.frames.get(ORIGIN_SLOT) ?? null;
    const r = this.replay;
    if (r && this.source === 'analyst') {
      if (key === r.x) return this.analyst.frames.get(REPLAY_X) ?? null;
      if (key === r.y) return this.analyst.frames.get(REPLAY_Y) ?? null;
    }
    return this.pool.frames.get(key) ?? null;
  }

  private metricsOf(key: number): DecodedMetrics | null {
    const f = this.frameFor(key);
    return f ? decodeMetrics(f.metrics, 0) : null;
  }

  /** World seconds since the visitor's touch. */
  private sinceTouch(): number {
    if (!this.tree) return 0;
    const step = this.source === 'pool' ? this.pool.step : this.analyst.step;
    return (step - this.tree.originStep) / STEPS_PER_SECOND;
  }

  // =========================================================================
  // Tiles & layout
  // =========================================================================

  private setTile(key: number, x: number, y: number, r: number, a: number): void {
    this.tiles.set(key, { fx: x, fy: y, fr: r, fa: a, tx: x, ty: y, tr: r, ta: a, t0: 0, dur: 0 });
  }

  private tileNow(key: number): { x: number; y: number; r: number; a: number } | null {
    const t = this.tiles.get(key);
    if (!t) return null;
    const u = t.dur > 0 ? Math.min(1, Math.max(0, (this.now - t.t0) / t.dur)) : 1;
    const e = easeInOut(u);
    return {
      x: t.fx + (t.tx - t.fx) * e,
      y: t.fy + (t.ty - t.fy) * e,
      r: t.fr + (t.tr - t.fr) * e,
      a: t.fa + (t.ta - t.fa) * e,
    };
  }

  private tweenTile(key: number, x: number, y: number, r: number, a: number, dur: number, from?: { x: number; y: number; r: number; a: number }): void {
    const cur = from ?? this.tileNow(key) ?? { x, y, r, a: 0 };
    this.tiles.set(key, { fx: cur.x, fy: cur.y, fr: cur.r, fa: cur.a, tx: x, ty: y, tr: r, ta: a, t0: this.now, dur });
  }

  private pruneTiles(): void {
    for (const [k, t] of this.tiles) {
      if (t.ta <= 0 && this.now - t.t0 > t.dur + 50) this.tiles.delete(k);
    }
  }

  private viewSize(): [number, number] {
    return this.renderer.size;
  }

  /** A view that frames the given worlds, leaving room for type above and below. */
  private frameWorlds(keys: number[], radiusFrac?: number, positions?: Map<number, [number, number]>): View {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const k of keys) {
      const p = positions?.get(k) ?? (this.tiles.has(k) ? [this.tiles.get(k)!.tx, this.tiles.get(k)!.ty] : [0, 0]);
      minX = Math.min(minX, p[0] - 1.12);
      maxX = Math.max(maxX, p[0] + 1.12);
      minY = Math.min(minY, p[1] - 1.12);
      maxY = Math.max(maxY, p[1] + 1.12);
    }
    return this.frameBounds(minX, maxX, minY, maxY, radiusFrac);
  }

  private frameBounds(minX: number, maxX: number, minY: number, maxY: number, radiusFrac?: number): View {
    const [W, H] = this.viewSize();
    const usableH = H * (this.opts.small ? 0.64 : 0.7);
    const usableW = W * (this.phase === 'many' || this.phase === 'cascade' ? (this.opts.small ? 0.94 : 0.7) : 0.9);
    let zoom = Math.min(usableW / (maxX - minX), usableH / (maxY - minY));
    if (radiusFrac) zoom = Math.min(zoom, (H * radiusFrac) / 1.0);
    const cx = (minX + maxX) / 2 + (this.phase === 'many' && !this.opts.small ? (W * 0.07) / zoom : 0);
    const cy = (minY + maxY) / 2 + (H * 0.035) / zoom;
    return { x: cx, y: cy, zoom };
  }

  private flyTo(v: View, ms: number, ease = easeInOut): void {
    if (this.reduced) {
      this.camera.flyTo(v, Math.min(ms, 400), this.now, this.viewSize()[0], easeOut);
      return;
    }
    this.camera.flyTo(v, ms, this.now, this.viewSize()[0], ease);
  }

  /** Move every leaf to its H-tree position for the current depth. */
  private layoutTree(dur: number, parentsFrom?: Map<number, { x: number; y: number; r: number; a: number }>): void {
    if (!this.tree) return;
    const D = this.tree.depth;
    for (const k of this.tree.leaves()) {
      const [x, y] = treePosition(k, D);
      const from = parentsFrom?.get(parentOf(k));
      this.tweenTile(k, x, y, 1, 1, dur, from);
    }
  }

  // =========================================================================
  // Act 2: the touch
  // =========================================================================

  private chooseTarget(): void {
    const f = this.frameFor(1);
    if (!f || !f.ids) return;
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < f.n; i++) {
      const o = i * AGENT_STRIDE;
      if (f.agents[o + 6] % 2 >= 1) continue; // hunters excluded as the suggestion
      const x = f.agents[o];
      const y = f.agents[o + 1];
      let near = 0;
      for (let j = 0; j < f.n; j++) {
        if (j === i) continue;
        const dx = f.agents[j * AGENT_STRIDE] - x;
        const dy = f.agents[j * AGENT_STRIDE + 1] - y;
        if (dx * dx + dy * dy < 45 * 45) near++;
      }
      const score = Math.sqrt(x * x + y * y) / WORLD_RADIUS - Math.min(near, 6) * 0.08;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0) {
      this.target = { id: f.ids[best], index: best, x: f.agents[best * AGENT_STRIDE], y: f.agents[best * AGENT_STRIDE + 1] };
    }
  }

  private agentIndexById(f: WorldFrame | null, id: number): number {
    if (!f || !f.ids) return -1;
    for (let i = 0; i < f.n; i++) if (f.ids[i] === id) return i;
    return -1;
  }

  private pickAgent(sx: number, sy: number, key: number, radiusCss: number): number {
    const f = this.frameFor(key);
    const t = this.tileNow(key);
    if (!f || !t || !f.ids) return -1;
    const [px, py] = this.camera.toPlane(sx, sy);
    const scale = t.r / WORLD_RADIUS;
    const ux = (px - t.x) / scale;
    const uy = (py - t.y) / scale;
    const lim = (radiusCss * this.dpr) / (scale * this.camera.zoom);
    let best = -1;
    let bd = lim * lim;
    for (let i = 0; i < f.n; i++) {
      const dx = f.agents[i * AGENT_STRIDE] - ux;
      const dy = f.agents[i * AGENT_STRIDE + 1] - uy;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  private startGrab(index: number, keyboard: boolean): void {
    const f = this.frameFor(1);
    if (!f || !f.ids || index < 0) return;
    const x0 = f.agents[index * AGENT_STRIDE];
    const y0 = f.agents[index * AGENT_STRIDE + 1];
    this.grab = { id: f.ids[index], index, x0, y0, dx: 0, dy: 0, dragging: true, keyboard };
    this.ui.big(null);
    this.ui.line(null);
    // Lean in: at this scale a pixel of the world becomes visible.
    const [, H] = this.viewSize();
    const zoom = Math.min(7 * this.dpr * WORLD_RADIUS, H * 5);
    this.flyTo({ x: x0 / WORLD_RADIUS, y: y0 / WORLD_RADIUS, zoom }, 1100);
    this.canvas.classList.add('grabbing');
  }

  private dragTo(dxCss: number, dyCss: number): void {
    if (!this.grab) return;
    const m = Math.sqrt(dxCss * dxCss + dyCss * dyCss);
    if (m < 1e-6) {
      this.grab.dx = this.grab.dy = 0;
      return;
    }
    // Heavy resistance: a long drag is still a tiny change.
    const mag = 3.0 * (1 - Math.exp(-m / 300));
    this.grab.dx = (dxCss / m) * mag;
    this.grab.dy = (dyCss / m) * mag;
  }

  private async releaseGrab(): Promise<void> {
    const g = this.grab;
    if (!g) return;
    this.canvas.classList.remove('grabbing');
    const mag = Math.sqrt(g.dx * g.dx + g.dy * g.dy);
    if (mag < 0.03) {
      this.grab = null;
      this.flyTo(this.frameWorlds([1], 0.36), 900);
      this.ui.big('Move it.');
      return;
    }
    g.dragging = false;
    this.userIv = { kind: 'nudge', id: g.id, dx: g.dx, dy: g.dy };
    const f = this.frameFor(1);
    if (f) this.userAgentLineage = Math.floor(f.agents[g.index * AGENT_STRIDE + 6] / 2);
    this.setPhase('confirm');
    this.ui.readout(
      `<div class="stat"><div class="num" data-v>${px(mag)} px</div><div class="lab">Difference introduced</div></div>`,
      'confirm',
    );
    this.flyTo(this.frameWorlds([1], 0.36), 1700);
    await this.splitRoot();
  }

  private async splitRoot(): Promise<void> {
    const iv = this.userIv!;
    await this.withBarrier(async () => {
      const snap = await this.pool.snapshot(1);
      if (!snap) return;
      this.origin = { buf: snap.buf, step: snap.step };
      this.tree = new BranchTree(this.seed, snap.step);
      const results = await this.pool.split([{ parent: 1, a: 2, b: 3, mode: 'explicit', ivA: null, ivB: iv }]);
      this.tree.addLevel(snap.step, results);
    });
    this.grab = null;
    await sleep(this.dur(900));
    const from = this.tileNow(1) ?? { x: 0, y: 0, r: 1, a: 1 };
    this.tiles.delete(1);
    const D = 1;
    for (const k of [2, 3]) {
      const [x, y] = treePosition(k, D);
      this.tweenTile(k, x, y, 1, 1, this.dur(2600), from);
    }
    this.treeAlphaTarget = 1;
    this.flyTo(this.frameWorlds([2, 3], 0.36, new Map([[2, treePosition(2, 1)], [3, treePosition(3, 1)]])), this.dur(2600));
    this.ui.readout(null);
    await sleep(this.dur(1800));
    this.scaleTau = 1.4;
    this.scaleTarget = 1;
    this.setPhase('two');
  }

  // =========================================================================
  // Branching
  // =========================================================================

  private async branch(): Promise<void> {
    if (!this.tree || this.busyAction) return;
    if (this.tree.depth >= this.opts.maxDepth) return;
    this.busyAction = true;
    this.focus = -1;
    const parentsFrom = new Map<number, { x: number; y: number; r: number; a: number }>();
    for (const k of this.tree.leaves()) {
      const n = this.tileNow(k);
      if (n) parentsFrom.set(k, n);
    }
    let step = 0;
    await this.withBarrier(async () => {
      step = this.pool.step;
      const reqs = this.tree!.leaves().map((k) => ({ parent: k, a: 2 * k, b: 2 * k + 1, mode: 'auto' as const }));
      const results = await this.pool.split(reqs);
      this.tree!.addLevel(step, results);
    });
    for (const k of parentsFrom.keys()) this.tiles.delete(k);
    this.halos.clear();
    this.sibDiv.clear();
    this.divGen = -1;
    const dur = this.dur(this.phase === 'cascade' ? 1100 : 2400);
    this.layoutTree(dur, parentsFrom);
    if (this.phase !== 'cascade') {
      const b = treeBounds(this.tree.depth);
      this.flyTo(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY, 0.36), dur);
      this.setPhase('branch');
    }
    this.busyAction = false;
  }

  private async runFutures(): Promise<void> {
    if (!this.tree || this.busyAction) return;
    this.setPhase('cascade');
    this.ui.actions(null);
    this.ui.line(null);
    this.focus = -1;
    const target = this.opts.maxDepth;
    const levels = target - this.tree.depth;
    const total = this.dur(levels * 1000 + 1800);
    const b = treeBounds(target);
    this.flyTo(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY), total, easeInOut);
    while (this.tree.depth < target) {
      await this.branch();
      await sleep(this.dur(650));
    }
    this.scaleTau = 2.5;
    this.scaleTarget = 3;
    await sleep(this.dur(1200));
    this.setPhase('many');
  }

  // =========================================================================
  // Find the first difference
  // =========================================================================

  private async findFirstDifference(x: number, y: number): Promise<void> {
    if (!this.tree || !this.origin || this.busyAction) return;
    this.busyAction = true;
    const returnPhase = this.phase;
    const keepFocus = this.focus;
    const nameX = BranchTree.label(x);
    const nameY = BranchTree.label(y);
    this.setPhase('firstdiff');
    this.ui.actions(null);
    this.ui.summary(null);
    this.ui.card(null);
    this.ui.big(null);
    this.ui.line('Searching their shared history…');
    this.scaleTau = 0.25;
    this.scaleTarget = 0;
    // Frame the two worlds side by side.
    if (returnPhase !== 'two') {
      this.flyTo(this.frameWorlds([x, y], 0.3), 1400);
    }
    const tree = this.tree;
    const l = tree.lca(x, y);
    const splitStep = tree.levelSteps[depthOf(l) + 1];
    const common = tree.path(l);
    const pathX = tree.path(x).filter((e) => e.step >= splitStep);
    const pathY = tree.path(y).filter((e) => e.step >= splitStep);
    const liveStep = await this.withBarrier(async () => this.pool.step);
    const t0 = performance.now();
    const result = await this.analyst.firstDifference({
      origin: this.origin.buf.slice(0),
      common,
      splitStep,
      pathX,
      pathY,
      maxSteps: Math.max(1, liveStep - splitStep),
      leadSteps: 84,
    });
    const elapsed = performance.now() - t0;
    if (elapsed < 900) await sleep(900 - elapsed);
    const restore = () => {
      this.focus = keepFocus;
      this.setPhase(returnPhase);
    };
    if (!result.found || !result.snapX || !result.snapY) {
      this.ui.line('Their histories have not yet diverged.');
      await sleep(2600);
      this.ui.line(null);
      this.scaleTarget = 1;
      restore();
      this.busyAction = false;
      return;
    }
    const after = (e: PathEntry) => e.step > result.replayStep;
    await this.analyst.reset();
    await this.analyst.load(REPLAY_X, result.snapX, 0, pathX.filter(after));
    await this.analyst.load(REPLAY_Y, result.snapY, 0, pathY.filter(after));
    this.replay = {
      x,
      y,
      result,
      stage: 'rewind',
      stageAt: this.now,
      nameX,
      nameY,
      returnPhase,
      returnActions: restore,
      liveStep,
    };
    this.ui.line(null);
    this.postTarget.sat = 0.25;
    this.busyAction = false;
  }

  private updateReplay(): void {
    const r = this.replay;
    if (!r) return;
    const st = (this.now - r.stageAt) / 1000;
    const res = r.result;
    const stepNow = this.source === 'analyst' ? this.analyst.step : this.pool.step;
    const sinceSplit = (s: number) => (s - res.splitStep) / STEPS_PER_SECOND;
    const touchWord = this.tree && depthOf(this.tree.lca(r.x, r.y)) === 0 ? 'your touch' : 'they split';
    switch (r.stage) {
      case 'rewind': {
        const d = this.reduced ? 0.4 : 1.6;
        const u = Math.min(1, st / d);
        const shown = r.liveStep + (res.replayStep - r.liveStep) * easeInOut(u);
        this.ui.readout(
          `<div class="stat"><div class="num huge" data-v>${clock(sinceSplit(shown))}</div><div class="lab">Rewinding · after ${touchWord}</div></div>`,
          'rewind',
        );
        if (u >= 1) {
          this.source = 'analyst';
          this.sim = res.replayStep;
          this.lastDrawn = res.replayStep;
          this.renderer.clearTrails();
          this.halos.clear();
          this.divGen = -1;
          this.scaleTau = 0.5;
          this.scaleTarget = this.reduced ? 0.3 : 0.22;
          this.postTarget.sat = 1;
          this.lodDirty = true;
          r.stage = 'approach';
          r.stageAt = this.now;
        }
        break;
      }
      case 'approach': {
        this.ui.readout(
          `<div class="stat"><div class="num huge" data-v>${sinceSplit(stepNow).toFixed(2)} s</div><div class="lab">After ${touchWord} · slow motion</div></div>`,
          'approach',
        );
        if (stepNow >= res.step) {
          r.stage = 'moment';
          r.stageAt = this.now;
          this.scaleTau = 0.2;
          this.scaleTarget = 0.06;
          this.ui.readout(
            `<div class="stat"><div class="num huge" data-v>${res.secondsAfterSplit.toFixed(2)} s</div><div class="lab">After ${touchWord}</div></div>`,
            'moment',
          );
          this.ui.line(describeFirstDifference(res, r.nameX, r.nameY));
          this.ui.big('The first difference');
        }
        break;
      }
      case 'moment': {
        if (st > (this.reduced ? 3 : 5.5)) {
          r.stage = 'cascade';
          r.stageAt = this.now;
          this.scaleTau = 1.2;
          this.scaleTarget = 1;
          this.ui.big(null);
        }
        break;
      }
      case 'cascade': {
        this.ui.readout(
          `<div class="stat"><div class="num" data-v>${sinceSplit(stepNow).toFixed(1)} s</div><div class="lab">After ${touchWord}</div></div>` +
            `<div class="stat"><div class="num" data-v>${pct(this.pairDivergence(r.x, r.y))}</div><div class="lab">Different</div></div>`,
          'cascade',
        );
        if (st > 2.5) this.ui.line('Everything else followed from that.');
        if (st > 4) {
          this.ui.actions([{ label: 'Return to the present', onClick: () => void this.endReplay(), primary: true }]);
        }
        if (st > 14) void this.endReplay();
        break;
      }
      default:
        break;
    }
  }

  private async endReplay(): Promise<void> {
    const r = this.replay;
    if (!r || r.stage === 'done') return;
    r.stage = 'done';
    this.ui.actions(null);
    this.ui.line(null);
    this.ui.big(null);
    this.ui.readout(null);
    await this.withBarrier(async () => {
      this.source = 'pool';
      this.sim = this.pool.step;
      this.lastDrawn = this.pool.step;
    });
    this.renderer.clearTrails();
    this.replay = null;
    this.halos.clear();
    this.divGen = -1;
    await this.analyst.reset();
    this.scaleTau = 1;
    this.scaleTarget = r.returnPhase === 'many' ? 3 : 1;
    r.returnActions();
  }

  // =========================================================================
  // Return to the beginning
  // =========================================================================

  private async returnToBeginning(): Promise<void> {
    if (!this.tree || !this.origin || this.busyAction) return;
    this.busyAction = true;
    this.focus = -1;
    this.ui.actions(null);
    this.ui.summary(null);
    this.ui.card(null);
    this.ui.line(null);
    this.ui.big(null);
    this.scaleTau = 0.5;
    this.scaleTarget = 0;
    this.treeAlphaTarget = 0.6;
    if (this.layoutMode === 'cluster') {
      this.layoutMode = 'tree';
      this.layoutTree(this.dur(1200));
      await sleep(this.dur(1200));
    }
    this.setPhase('return');
    this.collapse = { level: this.tree.depth, stageAt: this.now, depth: this.tree.depth };
    // Load the moment of the touch, ready to be revealed.
    await this.analyst.reset();
    await this.analyst.load(ORIGIN_SLOT, this.origin.buf.slice(0), 0);
    this.busyAction = false;
  }

  private updateCollapse(): void {
    const c = this.collapse;
    if (!c || !this.tree) return;
    const D = c.depth;
    const stageMs = this.dur(D > 6 ? 620 : 900);
    const st = this.now - c.stageAt;
    if (st >= stageMs && c.level > 0) {
      c.level--;
      c.stageAt = this.now;
      const g = c.level;
      for (const k of this.tree.leaves()) {
        const anc = k >> (D - g);
        const [x, y] = treePosition(anc, D);
        const rep = k === anc << (D - g);
        this.tweenTile(k, x, y, 1, rep ? 1 : 0, stageMs);
      }
      const reps: number[] = [];
      const pos = new Map<number, [number, number]>();
      for (let a = 1 << g; a < 1 << (g + 1); a++) {
        const k = a << (D - g);
        reps.push(k);
        pos.set(k, treePosition(a, D));
      }
      this.flyTo(this.frameWorlds(reps, 0.36, pos), stageMs, easeInOut);
      if (g === 0) {
        this.treeAlphaTarget = 0;
        setTimeout(() => this.revealOrigin(), stageMs + 200);
      }
    }
    const visible = 1 << c.level;
    this.ui.readout(
      `<div class="stat"><div class="num huge" data-v>${thousands(visible)}</div><div class="lab">${visible === 1 ? 'world' : 'worlds'}</div></div>`,
      'collapse',
    );
  }

  private revealOrigin(): void {
    if (this.phase !== 'return' || !this.tree) return;
    this.collapse = null;
    this.source = 'analyst';
    this.sim = this.analyst.step;
    this.lodDirty = true;
    for (const k of this.tree.leaves()) {
      const t = this.tileNow(k);
      if (t && t.a > 0) this.tweenTile(k, t.x, t.y, t.r, 0, this.dur(1800));
    }
    this.setTile(ORIGIN_KEY, 0, 0, 1, 0);
    this.tweenTile(ORIGIN_KEY, 0, 0, 1, 1, this.dur(1800));
    this.renderer.clearTrails();
    this.ui.readout(null);
    this.setPhase('origin');
    this.originShown = this.now;
    this.sound.setLevel(0.25);
  }

  private updateOrigin(): void {
    const t = this.t;
    const iv = this.userIv;
    if (!iv || iv.kind !== 'nudge') return;
    if (t > 1.2 && t < 1.4) this.ui.big('All of that came from this.');
    const f = this.frameFor(ORIGIN_KEY);
    const i = this.agentIndexById(f, iv.id);
    if (t > 3.2 && t < 3.4 && f && i >= 0) {
      const ax = f.agents[i * AGENT_STRIDE] / WORLD_RADIUS;
      const ay = f.agents[i * AGENT_STRIDE + 1] / WORLD_RADIUS;
      const [, H] = this.viewSize();
      const zoom = Math.min(15 * this.dpr * WORLD_RADIUS, H * 12);
      this.flyTo({ x: ax + iv.dx / WORLD_RADIUS / 2, y: ay + iv.dy / WORLD_RADIUS / 2 - (H * 0.04) / zoom, zoom }, this.dur(7000), easeInOut);
      this.sound.tone(this.userAgentLineage, 9);
    }
    const m = Math.sqrt(iv.dx * iv.dx + iv.dy * iv.dy);
    if (t > 9 && t < 9.2) this.ui.line(`<em>${px(m)}</em> pixels. One organism, one moment.`);
    if (t > 12 && t < 12.2) {
      this.ui.actions([{ label: 'Begin again', onClick: () => void this.beginAgain(), primary: true, breathe: true }]);
    }
  }

  private async beginAgain(): Promise<void> {
    this.ui.actions(null);
    this.ui.big(null);
    this.ui.line(null);
    this.postTarget.fade = 0;
    this.sound.setLevel(1);
    await sleep(this.dur(1400));
    this.seed = randomSeed();
    history.replaceState(null, '', location.pathname + location.search);
    this.share = null;
    await this.newWorld(false);
  }

  // =========================================================================
  // Outcome arrangement
  // =========================================================================

  private toggleArrangement(): void {
    if (!this.tree) return;
    if (this.layoutMode === 'cluster') {
      this.layoutMode = 'tree';
      this.treeAlphaTarget = 1;
      this.layoutTree(this.dur(2200));
      const b = treeBounds(this.tree.depth);
      this.flyTo(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY), this.dur(2200));
      this.clusterGroups = [];
      return;
    }
    const groups = OUTCOMES.map((o) => ({ name: o, keys: [] as number[] }));
    for (const k of this.tree.leaves()) {
      const m = this.metricsOf(k);
      const o = m?.outcome ?? 'stable';
      groups[OUTCOMES.indexOf(o)].keys.push(k);
    }
    const layout = clusterLayout(groups);
    this.layoutMode = 'cluster';
    this.treeAlphaTarget = 0;
    for (const [k, p] of layout.positions) this.tweenTile(k, p[0], p[1], 1, 1, this.dur(2400));
    this.clusterGroups = layout.groups.map((g) => ({ name: g.name as Outcome, keys: g.keys, labelX: g.labelX, labelY: g.labelY }));
    const w = layout.width / 2 + 1.5;
    const h = layout.height / 2 + 2.5;
    this.flyTo(this.frameBounds(-w, w, -h, h * 0.9), this.dur(2400));
  }

  // =========================================================================
  // Sharing
  // =========================================================================

  private shareFocused(): void {
    const k = this.focus;
    if (!this.tree || !this.userIv || k < 0 || this.userIv.kind !== 'nudge') return;
    const spec: ShareSpec = {
      seed: this.seed,
      originStep: this.tree.originStep,
      id: this.userIv.id,
      dx: this.userIv.dx,
      dy: this.userIv.dy,
      key: k,
      step: this.pool.step,
      levelSteps: this.tree.levelSteps.slice(1, depthOf(k) + 1),
    };
    const url = `${location.origin}${location.pathname}#f=${encodeShare(spec)}`;
    const done = () => {
      this.ui.line('Link copied. Whoever opens it will watch exactly this future unfold.');
      setTimeout(() => this.ui.line(null), 3800);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => window.prompt('Copy this link', url));
    else window.prompt('Copy this link', url);
  }

  private async openShared(spec: ShareSpec): Promise<void> {
    this.setPhase('boot');
    const D = depthOf(spec.key);
    const path: PathEntry[] = [];
    for (let d = 1; d <= D; d++) {
      const k = spec.key >> (D - d);
      const step = spec.levelSteps[d - 1];
      if (d === 1) path.push({ step, iv: k === 3 ? { kind: 'nudge', id: spec.id, dx: spec.dx, dy: spec.dy } : null });
      else path.push({ step, iv: { auto: k & 1 ? -1 : 1, parentKey: k >> 1 } });
    }
    this.ui.line('Reconstructing a shared future…');
    this.ui.captionLow(true);
    const rec = await this.analyst.reconstructFromSeed(spec.seed, path, spec.step);
    await this.pool.load(spec.key, rec.buf, 0);
    this.sharedKey = spec.key;
    this.sim = rec.step;
    this.lastDrawn = rec.step;
    this.setTile(spec.key, 0, 0, 1, 1);
    this.camera.set(this.frameWorlds([spec.key], 0.36));
    this.postTarget.fade = 1;
    this.ui.line(null);
    this.ui.captionLow(false);
    this.setPhase('shared');
    this.ui.big(`A shared future · World ${BranchTree.label(spec.key)}`);
    setTimeout(() => this.ui.big(null), 5000);
    this.ui.actions([
      {
        label: 'Begin your own',
        primary: true,
        onClick: () => {
          history.replaceState(null, '', location.pathname + location.search);
          this.share = null;
          this.seed = randomSeed();
          void this.newWorld(true);
        },
      },
    ]);
  }

  // =========================================================================
  // Frame
  // =========================================================================

  private frame(t: number): void {
    requestAnimationFrame((tt) => this.frame(tt));
    const dt = Math.min(0.1, Math.max(0, (t - this.lastFrame) / 1000));
    this.lastFrame = t;
    this.now = t;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;

    this.camera.update(t, dt);
    this.updateClock(dt);
    this.updatePhase();
    this.updateLod();
    this.updateDivergence();
    this.pruneTiles();
    this.post.fade += (this.postTarget.fade - this.post.fade) * (1 - Math.exp(-dt * 1.6));
    this.post.sat += (this.postTarget.sat - this.post.sat) * (1 - Math.exp(-dt * 2.5));
    this.treeAlpha += (this.treeAlphaTarget - this.treeAlpha) * (1 - Math.exp(-dt * 1.5));

    const tiles = this.buildTiles();
    this.buildShapes();
    const src = this.src();
    const drawn = src.step + this.alpha;
    const steps = Math.max(0, drawn - this.lastDrawn);
    this.lastDrawn = drawn;

    if (this.captureScale) this.capture(tiles, steps);
    else
      this.renderer.render({
        tiles,
        view: this.camera.view,
        alpha: this.alpha,
        stepsAdvanced: steps,
        time: this.reduced ? 0 : t / 1000,
        under: this.under,
        over: this.over,
        post: this.post,
      });

    this.updateLabels();
    this.updateSound();
    this.updateDebug();
  }

  private capture(tiles: TileInput[], steps: number): void {
    const [W, H] = this.viewSize();
    const k = this.captureScale;
    this.captureScale = 0;
    const max = this.renderer.gl.getParameter(this.renderer.gl.MAX_TEXTURE_SIZE) as number;
    const s = Math.max(1, Math.min(k, Math.floor(max / Math.max(W, H))));
    const view = this.camera.view;
    this.renderer.resize(W * s, H * s);
    this.renderer.render({
      tiles,
      view: { ...view, zoom: view.zoom * s },
      alpha: this.alpha,
      stepsAdvanced: steps,
      time: this.now / 1000,
      under: this.scaleShapes(this.under, s),
      over: this.scaleShapes(this.over, s),
      post: { ...this.post, grain: this.post.grain * 0.5 },
    });
    void this.renderer.snapshotPNG().then((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const name = this.focus >= 0 ? `world-${BranchTree.label(this.focus)}` : this.phase;
      a.download = `butterfly-machine-${name}-${this.seed}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    this.renderer.resize(W, H);
  }

  private scaleShapes(b: ShapeBatch, s: number): ShapeBatch {
    const c = new ShapeBatch();
    c.data = b.data.slice(0, b.count * 12);
    c.count = b.count;
    for (let i = 0; i < c.count; i++) {
      c.data[i * 12 + 8] *= s;
      c.data[i * 12 + 11] *= s;
    }
    return c;
  }

  private updatePhase(): void {
    const t = this.t;
    switch (this.phase) {
      case 'title':
        break;
      case 'observe': {
        if (t > 3 && t < 3.2) this.ui.line('Everything here follows the same few rules.');
        if (t > 9 && t < 9.2) this.ui.line(null);
        this.ui.corner(`<span>World 0</span><span class="mono">${clock(t)}</span>`);
        if (t > OBSERVE_SECONDS) {
          this.scaleTau = 0.9;
          this.scaleTarget = 0;
          this.setPhase('freeze');
        }
        break;
      }
      case 'freeze': {
        if (t > 1.6 && t < 1.8) this.ui.big('Change one thing.');
        if (this.scale === 0 && t > 3.6) {
          this.chooseTarget();
          if (this.target) {
            this.setPhase('touch');
            this.ui.announce('Use the arrow keys to move the highlighted organism a tiny distance, then press Enter.');
          }
        }
        break;
      }
      case 'touch': {
        if (!this.grab && t > 0.6 && t < 0.8) this.ui.big('Move it.');
        // Keep the suggestion pinned to the organism if frames refresh.
        if (this.target) {
          const f = this.frameFor(1);
          const i = this.agentIndexById(f, this.target.id);
          if (f && i >= 0) {
            this.target.index = i;
            this.target.x = f.agents[i * AGENT_STRIDE];
            this.target.y = f.agents[i * AGENT_STRIDE + 1];
          }
        }
        break;
      }
      case 'two': {
        const since = this.sinceTouch();
        const d = this.headline;
        this.ui.readout(
          `<div class="stat"><div class="num" data-v>${pct(d)}</div><div class="lab">Different</div></div>` +
            `<div class="stat"><div class="num" data-v>${signedSeconds(since)}</div><div class="lab">Since the change</div></div>`,
          'two',
        );
        if (this.firstResembleLost < 0 && (d > 0.82 || since > 48)) {
          this.firstResembleLost = this.now;
          this.ui.line('These worlds no longer resemble each other.');
          this.ui.captionLow(false);
        }
        if (this.firstResembleLost > 0 && this.now - this.firstResembleLost > 2600) {
          this.ui.actions([
            { label: 'Find the first difference', onClick: () => void this.findFirstDifference(2, 3) },
            { label: 'Branch again', onClick: () => void this.branch(), primary: true },
          ]);
        }
        if (this.firstResembleLost > 0 && this.now - this.firstResembleLost > 9000) this.ui.line(null);
        break;
      }
      case 'branch': {
        this.ui.line(null);
        const n = this.tree?.leafCount ?? 0;
        this.ui.readout(
          `<div class="stat"><div class="num" data-v>${n}</div><div class="lab">Worlds</div></div>` +
            `<div class="stat"><div class="num" data-v>${signedSeconds(this.sinceTouch())}</div><div class="lab">Since your change</div></div>`,
          'branch',
        );
        this.focusActions(() => {
          const acts: Action[] = [];
          if (this.tree && this.tree.depth < 4) acts.push({ label: 'Branch again', onClick: () => void this.branch(), primary: true });
          else acts.push({ label: `Run ${this.opts.maxDepth >= 10 ? '1,000' : thousands(1 << this.opts.maxDepth)} futures`, onClick: () => void this.runFutures(), primary: true, breathe: true });
          return acts;
        });
        break;
      }
      case 'cascade': {
        const n = this.tree?.leafCount ?? 0;
        this.ui.readout(
          `<div class="stat"><div class="num huge" data-v>${thousands(n)}</div><div class="lab">Futures</div></div>`,
          'cascade',
        );
        break;
      }
      case 'many': {
        this.ui.readout(null);
        this.updateSummary();
        this.focusActions(() => [
          { label: this.layoutMode === 'cluster' ? 'Arrange by family' : 'Arrange by outcome', onClick: () => this.toggleArrangement() },
          { label: 'Return to the beginning', onClick: () => void this.returnToBeginning(), primary: true, breathe: t > 40 },
        ]);
        break;
      }
      case 'firstdiff':
        this.updateReplay();
        break;
      case 'return':
        this.updateCollapse();
        break;
      case 'origin':
        this.updateOrigin();
        break;
      case 'shared': {
        const m = this.metricsOf(this.sharedKey);
        if (m) this.ui.corner(`<span>World ${BranchTree.label(this.sharedKey)}</span><span>${OUTCOME_LABEL[m.outcome]}</span>`);
        break;
      }
      default:
        break;
    }
    if (this.phase !== 'observe' && this.phase !== 'shared') {
      if (this.tree && (this.phase === 'branch' || this.phase === 'many' || this.phase === 'two' || this.phase === 'cascade')) {
        const n = this.tree.leafCount;
        this.ui.corner(
          `<span>${thousands(n)} ${n === 1 ? 'world' : 'worlds'}</span><span class="mono">${clock(this.sinceTouch())}</span>` +
            (this.phase === 'many' && this.scale > 1.2 ? `<span class="mono">×${this.scale.toFixed(1)}</span>` : ''),
        );
      } else if (this.phase !== 'firstdiff') this.ui.corner(null);
    }
    // Long idle on the landscape or the ending: make room for the next visitor.
    if ((this.phase === 'many' || this.phase === 'origin') && this.now - this.idleSince > 240000) {
      this.seed = randomSeed();
      void this.newWorld(true);
    }
  }

  /** Actions while browsing, with the focused world's own actions when one is open. */
  private focusActions(base: () => Action[]): void {
    if (this.busyAction) return;
    if (this.focus >= 0 && this.tree) {
      const k = this.focus;
      const m = this.metricsOf(k);
      const name = BranchTree.label(k);
      const sib = siblingOf(k);
      const div = this.sibDiv.get(k);
      const desc = this.tree.nodes.get(k);
      this.ui.readout(
        `<div class="stat focus"><div class="num" data-v>World ${name}</div><div class="lab">${m ? OUTCOME_LABEL[m.outcome] : ''}</div></div>` +
          (m
            ? `<div class="stat"><div class="num" data-v>${m.grazers} · ${m.hunters}</div><div class="lab">Grazers · hunters</div></div>` +
              `<div class="stat"><div class="num" data-v>${m.lineages}</div><div class="lab">Lineages</div></div>`
            : '') +
          (div !== undefined ? `<div class="stat"><div class="num" data-v>${pct(div)}</div><div class="lab">From ${BranchTree.label(sib)}</div></div>` : '') +
          (desc ? `<div class="stat"><div class="num" data-v>${describeIntervention(desc.iv)}</div><div class="lab">At its birth</div></div>` : ''),
        `focus-${k}-${!!m}-${div !== undefined}-${!!desc}`,
      );
      this.ui.actions([
        { label: 'Find the first difference', onClick: () => void this.findFirstDifference(k, sib), primary: true },
        { label: 'Share this future', onClick: () => this.shareFocused() },
        { label: 'Back', onClick: () => this.unfocus() },
      ]);
      return;
    }
    this.ui.actions(base());
  }

  private focusOn(key: number): void {
    if (!this.tree || this.busyAction) return;
    if (this.phase !== 'branch' && this.phase !== 'many') return;
    this.focus = key;
    this.hover = -1;
    this.ui.card(null);
    const t = this.tiles.get(key);
    if (!t) return;
    const [, H] = this.viewSize();
    this.flyTo({ x: t.tx, y: t.ty + (H * 0.05) / (H * 0.32), zoom: H * 0.32 }, this.dur(1600));
  }

  private unfocus(): void {
    if (!this.tree) return;
    const k = this.focus;
    this.focus = -1;
    if (this.layoutMode === 'cluster') {
      this.toggleArrangement();
      this.toggleArrangement();
      return;
    }
    const b = treeBounds(this.tree.depth);
    if (k >= 0 && this.tree.depth > 4) {
      // Up one level of the family: frame the focused world's grandparent's subtree.
      this.upFrom(k);
      return;
    }
    this.flyTo(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY), this.dur(1600));
  }

  /** Frames the family two generations above `key` ("move back up the branch tree"). */
  private upFrom(key: number): void {
    if (!this.tree) return;
    const D = this.tree.depth;
    let anc = key;
    const viewW = this.viewSize()[0] / this.camera.zoom;
    // Climb until the family is noticeably larger than the current view.
    for (let up = 0; up < D; up++) {
      anc = parentOf(anc);
      const leaves = this.descendants(anc);
      const xs = leaves.map((k) => this.tiles.get(k)?.tx ?? 0);
      const w = Math.max(...xs) - Math.min(...xs) + 2.4;
      if (w > viewW * 1.6 || anc === 1) break;
    }
    const leaves = this.descendants(anc);
    if (anc === 1) {
      const b = treeBounds(D);
      this.flyTo(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY), this.dur(1400));
    } else this.flyTo(this.frameWorlds(leaves), this.dur(1400));
  }

  private descendants(key: number): number[] {
    if (!this.tree) return [];
    const D = this.tree.depth;
    const d = depthOf(key);
    const first = key << (D - d);
    const n = 1 << (D - d);
    const out: number[] = [];
    for (let k = first; k < first + n; k++) out.push(k);
    return out;
  }

  private updateSummary(): void {
    if (!this.tree || this.focus >= 0) {
      this.ui.summary(null);
      return;
    }
    const counts: Record<Outcome, number> = { collapsed: 0, dominated: 0, unhunted: 0, diverse: 0, stable: 0 };
    let n = 0;
    for (const k of this.tree.leaves()) {
      const m = this.metricsOf(k);
      if (!m) continue;
      counts[m.outcome]++;
      n++;
    }
    if (n === 0) return;
    const m = Math.sqrt((this.userIv as { dx: number; dy: number }).dx ** 2 + (this.userIv as { dx: number; dy: number }).dy ** 2);
    const order: Outcome[] = ['collapsed', 'dominated', 'unhunted', 'diverse', 'stable'];
    const rows = order
      .map(
        (o) =>
          `<div class="row" title="${OUTCOME_DESCRIPTION[o]}"><span class="sw" style="background:${cssColor(OUTCOME_COLOR[o])};box-shadow:0 0 10px ${cssColor(OUTCOME_COLOR[o])}"></span><span class="c">${counts[o]}</span><span class="l">${OUTCOME_LABEL[o]}</span></div>`,
      )
      .join('');
    this.ui.summary(
      `<h2>Your <em>${px(m)} px</em> change has produced</h2>${rows}<div class="foot">${thousands(n)} futures, judged live, <span class="mono">${clock(this.sinceTouch())}</span> after the change.<br/>Hover a world to look closer; click to enter it.</div>`,
    );
  }

  // =========================================================================
  // Level of detail & divergence
  // =========================================================================

  private updateLod(): void {
    if (this.source !== 'pool') return;
    const [W, H] = this.viewSize();
    const z = this.camera.zoom;
    const cand: Array<[number, number]> = [];
    const next = new Uint8Array(LOD_SIZE);
    for (const key of this.tiles.keys()) {
      if (key >= LOD_SIZE) continue;
      const t = this.tileNow(key)!;
      const [sx, sy] = this.camera.toScreen(t.x, t.y);
      const rp = t.r * z;
      const on = Math.abs(sx) < W / 2 + rp && Math.abs(sy) < H / 2 + rp && t.a > 0.01;
      if (!on) continue;
      next[key] = LOD_LOW;
      cand.push([key, rp / this.dpr]);
    }
    cand.sort((a, b) => b[1] - a[1]);
    let high = 0;
    for (const [key, r] of cand) {
      if (high >= 40) break;
      if (r >= 40 || (this.phase === 'touch' || this.phase === 'freeze' || this.phase === 'confirm')) {
        next[key] = LOD_HIGH;
        high++;
      }
    }
    // Worlds being compared always carry ids.
    if (this.focus >= 0 && this.focus < LOD_SIZE) {
      next[this.focus] = LOD_HIGH;
      next[siblingOf(this.focus)] = Math.max(next[siblingOf(this.focus)], LOD_LOW);
    }
    for (let i = 0; i < LOD_SIZE; i++) {
      if (next[i] !== this.lod[i]) {
        this.lod = next;
        this.lodDirty = true;
        break;
      }
    }
  }

  private pairDivergence(x: number, y: number): number {
    return this.sibDiv.get(x) ?? this.sibDiv.get(y) ?? 0;
  }

  /** Measures each pair of siblings; fills halos and per-world divergence. */
  private updateDivergence(): void {
    const src = this.src();
    if (src.generation === this.divGen || !this.tree) return;
    this.divGen = src.generation;
    const leaves = this.tree.leaves();
    if (leaves.length > 64 && this.focus < 0 && !this.replay) return;
    const pairs: Array<[number, number]> = [];
    if (this.replay) pairs.push([this.replay.x, this.replay.y]);
    else if (leaves.length <= 64) for (let k = leaves[0]; k <= leaves[leaves.length - 1]; k += 2) pairs.push([k, k + 1]);
    else if (this.focus >= 0) pairs.push([this.focus & ~1, this.focus | 1]);
    for (const [a, b] of pairs) {
      const fa = this.frameFor(a);
      const fb = this.frameFor(b);
      if (!fa || !fb || fa.step !== fb.step) continue;
      if (!fa.ids || !fb.ids) continue;
      let ha = this.halos.get(a);
      if (!ha) this.halos.set(a, (ha = new Float32Array(MAX_AGENTS)));
      let hb = this.halos.get(b);
      if (!hb) this.halos.set(b, (hb = new Float32Array(MAX_AGENTS)));
      const sameRes = fa.fieldRes === fb.fieldRes && fa.field && fb.field;
      const res = divergenceOf(
        { n: fa.n, ids: fa.ids, pos: fa.agents, stride: AGENT_STRIDE, offX: 0 },
        { n: fb.n, ids: fb.ids, pos: fb.agents, stride: AGENT_STRIDE, offX: 0 },
        sameRes ? everyOther(fa.field!) : null,
        sameRes ? everyOther(fb.field!) : null,
        sameRes && fa.fieldRes === 48 ? FIELD_MASK : null,
        ha,
        hb,
        this.index,
      );
      this.sibDiv.set(a, res.score);
      this.sibDiv.set(b, res.score);
      if (this.tree.depth === 1 && a === 2) this.headline = res.score;
    }
  }

  // =========================================================================
  // Drawing inputs
  // =========================================================================

  private buildTiles(): TileInput[] {
    const out: TileInput[] = [];
    const sunStep = this.src().step;
    const sun = sunPosition(sunStep);
    const showHalos = this.phase === 'two' || this.phase === 'firstdiff' || (this.tree !== null && this.tree.depth <= 4) || this.focus >= 0;
    for (const [key] of this.tiles) {
      const t = this.tileNow(key)!;
      if (t.a <= 0.002) continue;
      const f = this.frameFor(key);
      let override: TileInput['override'] = null;
      if (this.grab && key === 1) override = { index: this.grab.index, dx: this.grab.dx, dy: this.grab.dy };
      let tint: [number, number, number] = [0.5, 0.6, 0.7];
      let tintAmt = 0;
      const m = f && (this.layoutMode === 'cluster' || this.phase === 'many') ? decodeMetrics(f.metrics, 0) : null;
      if (m && this.layoutMode === 'cluster') {
        tint = OUTCOME_COLOR[m.outcome];
        tintAmt = 0.8;
      }
      let dim = 0;
      if (this.replay && this.source === 'analyst' && key !== this.replay.x && key !== this.replay.y) dim = 0.7;
      if (this.focus >= 0 && key !== this.focus && key !== siblingOf(this.focus)) dim = 0.35;
      out.push({
        key,
        x: t.x,
        y: t.y,
        r: t.r,
        alpha: t.a,
        frame: f,
        hover: key === this.hover ? 1 : 0,
        select: key === this.focus ? 1 : 0,
        tint,
        tintAmt,
        dim,
        sun,
        halo: showHalos ? (this.halos.get(key) ?? null) : null,
        override,
        structures: true,
      });
    }
    return out;
  }

  private buildShapes(): void {
    const under = this.under;
    const over = this.over;
    under.clear();
    over.clear();
    const z = this.camera.zoom;

    // The family tree, as faint luminous lines between siblings.
    if (this.tree && this.treeAlpha > 0.01 && this.tree.depth >= 1) {
      const D = this.tree.depth;
      const pos = new Map<number, [number, number]>();
      for (const k of this.tree.leaves()) {
        const t = this.tileNow(k);
        if (t) pos.set(k, [t.x, t.y]);
      }
      const hoverPath = new Set<number>();
      if (this.hover >= 0 && this.focus < 0) for (let k = this.hover; k >= 1; k = parentOf(k)) hoverPath.add(k);
      for (let d = D; d >= 1; d--) {
        for (let k = 1 << d; k < 1 << (d + 1); k += 2) {
          const a = pos.get(k);
          const b = pos.get(k + 1);
          if (!a || !b) continue;
          pos.set(k >> 1, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
          const lenPx = Math.hypot(a[0] - b[0], a[1] - b[1]) * z;
          if (lenPx < 3) continue;
          const lit = hoverPath.has(k) || hoverPath.has(k + 1);
          const al = this.treeAlpha * (0.16 + 0.14 * (1 - d / Math.max(1, D))) * Math.min(1, lenPx / 40);
          if (lit) under.line(a[0], a[1], b[0], b[1], 1.4, 1.0, 0.85, 0.58, Math.min(1, al * 4 + 0.25), 3);
          else under.line(a[0], a[1], b[0], b[1], 1, 0.62, 0.72, 0.82, al, 0);
        }
      }
      for (let d = 0; d < D; d++) {
        for (let k = 1 << d; k < 1 << (d + 1); k++) {
          const p = pos.get(k);
          if (!p) continue;
          const lit = hoverPath.has(k);
          const span = offsetFor(d + 1, D) * z;
          if (!lit && span < 30) continue;
          under.disc(p[0], p[1], (lit ? 3 : 2) / z, 0.8, 0.86, 0.92, this.treeAlpha * (lit ? 0.9 : 0.35), lit ? 3 : 1.5);
        }
      }
    }

    // Act 2: the suggestion, the ghost, and the displacement.
    if ((this.phase === 'touch' || this.phase === 'confirm' || this.phase === 'freeze') && this.tiles.has(1)) {
      const t = this.tileNow(1)!;
      const s = t.r / WORLD_RADIUS;
      if (this.target && !this.grab && this.phase === 'touch') {
        const pulse = 0.55 + 0.45 * Math.sin(this.now / 420);
        const cx = t.x + this.target.x * s;
        const cy = t.y + this.target.y * s;
        over.ring(cx, cy, 13 * s, 1.2, 1, 0.88, 0.62, 0.55 * pulse * Math.min(1, this.t / 1.2), 4);
        over.ring(cx, cy, (13 + 10 * ((this.now / 1600) % 1)) * s, 1, 1, 0.88, 0.62, 0.25 * (1 - ((this.now / 1600) % 1)), 0);
      }
      const g = this.grab;
      if (g) {
        const ox = t.x + g.x0 * s;
        const oy = t.y + g.y0 * s;
        const nx = ox + g.dx * s;
        const ny = oy + g.dy * s;
        over.ring(ox, oy, 3.2 * s, 1, 0.8, 0.88, 1, 0.55, 0);
        over.disc(ox, oy, 0.12 * s, 0.85, 0.9, 1, 0.6, 0);
        over.line(ox, oy, nx, ny, 1, 1, 0.86, 0.6, 0.75, 2);
        over.ring(nx, ny, 3.2 * s, 1.2, 1, 0.86, 0.6, 0.8, 3);
      }
    }

    // The ending: the original position and the touched one.
    if (this.phase === 'origin' && this.userIv && this.userIv.kind === 'nudge') {
      const f = this.frameFor(ORIGIN_KEY);
      const i = this.agentIndexById(f, this.userIv.id);
      const t = this.tileNow(ORIGIN_KEY);
      if (f && i >= 0 && t) {
        const s = t.r / WORLD_RADIUS;
        const ox = t.x + f.agents[i * AGENT_STRIDE] * s;
        const oy = t.y + f.agents[i * AGENT_STRIDE + 1] * s;
        const nx = ox + this.userIv.dx * s;
        const ny = oy + this.userIv.dy * s;
        const a = Math.min(1, Math.max(0, (this.now - this.originShown) / 1000 - 3.5) / 2);
        over.ring(ox, oy, 2.4 * s, 1, 0.82, 0.9, 1, 0.6 * a, 0);
        over.ring(nx, ny, 2.4 * s, 1.3, 1, 0.86, 0.6, 0.9 * a, 4);
        over.line(ox, oy, nx, ny, 1.2, 1, 0.86, 0.6, 0.9 * a, 3);
        over.disc(ox, oy, 0.1 * s, 0.85, 0.9, 1, 0.8 * a, 0);
        over.disc(nx, ny, 0.1 * s, 1, 0.86, 0.6, 0.9 * a, 2);
      }
    }

    // First difference: the organisms involved, in both worlds.
    const r = this.replay;
    if (r && this.source === 'analyst' && r.result.event) {
      const e = r.result.event;
      const ids = [e.a, e.b].filter((v) => v > 0);
      const stage = r.stage;
      const strength = stage === 'approach' ? 0.55 : stage === 'moment' ? 1 : stage === 'cascade' ? 0.35 : 0;
      for (const key of [r.x, r.y]) {
        const f = this.frameFor(key);
        const t = this.tileNow(key);
        if (!f || !t) continue;
        const s = t.r / WORLD_RADIUS;
        for (const id of ids) {
          const i = this.agentIndexById(f, id);
          if (i < 0) continue;
          const ax = t.x + (f.agents[i * AGENT_STRIDE] + f.agents[i * AGENT_STRIDE + 2] * this.alpha) * s;
          const ay = t.y + (f.agents[i * AGENT_STRIDE + 1] + f.agents[i * AGENT_STRIDE + 3] * this.alpha) * s;
          over.ring(ax, ay, 11 * s, 1.2, 1, 0.9, 0.62, 0.7 * strength, 3);
        }
        if (stage === 'moment' || stage === 'cascade') {
          const here = (r.result.inWorld === 0 ? r.x : r.y) === key;
          if (here) {
            const u = Math.min(1, (this.now - r.stageAt) / 2200);
            const ex = t.x + e.x * s;
            const ey = t.y + e.y * s;
            over.ring(ex, ey, (6 + 60 * easeOut(u)) * s, 1.2, 1, 0.92, 0.7, 0.8 * (1 - u) * (stage === 'moment' ? 1 : 0), 0);
          }
        }
      }
    }
  }

  private updateLabels(): void {
    const specs: LabelSpec[] = [];
    const markers: Array<{ id: string; x: number; y: number; html: string; alpha: number; cls?: string }> = [];
    const [W, H] = this.viewSize();
    const toCss = (x: number, y: number): [number, number] => {
      const [sx, sy] = this.camera.toScreen(x, y);
      return [(sx + W / 2) / this.dpr, (sy + H / 2) / this.dpr];
    };
    const z = this.camera.zoom;
    const showNames = this.phase === 'two' || this.phase === 'branch' || this.phase === 'firstdiff' || this.phase === 'many' || this.phase === 'cascade';
    if (this.tree && showNames && this.layoutMode === 'tree' && this.focus < 0) {
      for (const k of this.tree.leaves()) {
        const t = this.tileNow(k);
        if (!t || t.a < 0.05) continue;
        const rCss = (t.r * z) / this.dpr;
        const minR = this.tree.depth >= 3 ? 95 : 46;
        if (rCss < minR) continue;
        const [cx, cy] = toCss(t.x, t.y + t.r);
        if (cy < -40 || cy > H / this.dpr + 40 || cx < -100 || cx > W / this.dpr + 100) continue;
        let sub: string | undefined;
        let metric: string | undefined;
        if (this.tree.depth === 1) {
          sub = k === 2 ? 'as it was' : this.userIv ? describeIntervention(this.userIv) : '';
        } else {
          const node = this.tree.nodes.get(k);
          sub = rCss > 90 && node ? describeIntervention(node.iv) : undefined;
          const d = this.sibDiv.get(k);
          if (d !== undefined && rCss > 70) metric = `${pct(d)} from ${BranchTree.label(siblingOf(k))}`;
        }
        specs.push({
          id: `w${k}`,
          x: cx,
          y: cy + 14,
          name: `World ${BranchTree.label(k)}`,
          sub,
          metric,
          alpha: Math.min(1, (rCss - minR) / 30) * t.a * (this.phase === 'cascade' ? 0.6 : 1),
          small: rCss < 110,
        });
      }
    }
    // Hover path: the change that gave birth to each ancestor.
    if (this.tree && this.hover >= 0 && this.focus < 0 && this.layoutMode === 'tree' && (this.phase === 'many' || this.phase === 'branch')) {
      const D = this.tree.depth;
      for (let k = this.hover; k > 1; k = parentOf(k)) {
        const node = this.tree.nodes.get(k);
        if (!node) continue;
        const sibT = this.descendants(siblingOf(k)).map((x) => this.tiles.get(x)).filter(Boolean);
        const mine = this.descendants(k).map((x) => this.tiles.get(x)).filter(Boolean);
        if (!sibT.length || !mine.length) continue;
        const mx = mine.reduce((a, b) => a + b!.tx, 0) / mine.length;
        const my = mine.reduce((a, b) => a + b!.ty, 0) / mine.length;
        const lenPx = Math.hypot(mx - sibT.reduce((a, b) => a + b!.tx, 0) / sibT.length, my - sibT.reduce((a, b) => a + b!.ty, 0) / sibT.length) * z / this.dpr;
        if (lenPx < 60 || depthOf(k) === D) continue;
        const [cx, cy] = toCss(mx, my);
        markers.push({ id: `h${k}`, x: cx, y: cy, html: `${BranchTree.label(k)} · ${describeIntervention(node.iv)}`, alpha: 0.9 });
      }
    }
    // Cluster labels.
    if (this.layoutMode === 'cluster' && this.phase === 'many') {
      for (const g of this.clusterGroups) {
        const [cx, cy] = toCss(g.labelX, g.labelY);
        markers.push({
          id: `c${g.name}`,
          x: cx,
          y: cy,
          html: `<div class="n" style="color:${cssColor(OUTCOME_COLOR[g.name])}">${OUTCOME_LABEL[g.name]}</div><div class="c">${g.keys.length}</div>`,
          alpha: 1,
          cls: 'cluster-label',
        });
      }
    }
    // Act 2: the size of the change, next to the organism.
    if (this.grab && this.tiles.has(1)) {
      const t = this.tileNow(1)!;
      const s = t.r / WORLD_RADIUS;
      const [cx, cy] = toCss(t.x + (this.grab.x0 + this.grab.dx) * s, t.y + (this.grab.y0 + this.grab.dy) * s);
      const m = Math.sqrt(this.grab.dx ** 2 + this.grab.dy ** 2);
      markers.push({ id: 'drag', x: cx, y: cy - 48, html: `+${px(m)} px`, alpha: m > 0.005 ? 1 : 0.4 });
    }
    if (this.phase === 'origin' && this.userIv && this.userIv.kind === 'nudge') {
      const f = this.frameFor(ORIGIN_KEY);
      const i = this.agentIndexById(f, this.userIv.id);
      const t = this.tileNow(ORIGIN_KEY);
      const a = Math.min(1, Math.max(0, (this.now - this.originShown) / 1000 - 5) / 2);
      if (f && t && i >= 0 && a > 0) {
        const s = t.r / WORLD_RADIUS;
        const [cx, cy] = toCss(t.x + (f.agents[i * AGENT_STRIDE] + this.userIv.dx) * s, t.y + (f.agents[i * AGENT_STRIDE + 1] + this.userIv.dy) * s);
        const m = Math.sqrt(this.userIv.dx ** 2 + this.userIv.dy ** 2);
        markers.push({ id: 'origin', x: cx, y: cy - 54, html: `${px(m)} px`, alpha: a });
      }
    }
    this.ui.labels(specs);
    this.ui.markers(markers);
  }

  // =========================================================================
  // Sound
  // =========================================================================

  private voiceFor(keys: number[], pan: number, level: number): VoiceState | null {
    const shares = new Array(N_LINEAGES).fill(0);
    let n = 0;
    let vit = 0;
    let hunters = 0;
    let resource = 0;
    let motion = 0;
    for (const k of keys) {
      const m = this.metricsOf(k);
      if (!m) continue;
      n++;
      const g = m.grazers;
      for (let L = 0; L < N_LINEAGES; L++) shares[L] += g > 0 ? m.lineageCounts[L] / g : 0;
      vit += g / 180;
      hunters += m.hunters;
      resource += m.resource;
      motion += m.motion;
    }
    if (n === 0) return null;
    return {
      pan,
      shares: shares.map((s) => s / n),
      vitality: vit / n,
      hunters: hunters / n,
      resource: resource / n,
      motion: motion / n,
      level,
    };
  }

  private updateSound(): void {
    if (!this.sound.started) return;
    const [W] = this.viewSize();
    const events = this.soundEvents;
    events.length = 0;
    const visible: Array<[number, number]> = [];
    for (const key of this.tiles.keys()) {
      const t = this.tileNow(key)!;
      if (t.a < 0.05) continue;
      const [sx] = this.camera.toScreen(t.x, t.y);
      if (Math.abs(sx) > W * 0.7) continue;
      visible.push([key, Math.max(-1, Math.min(1, sx / (W / 2)))]);
    }
    const states: Array<VoiceState | null> = [null, null];
    if (this.phase === 'origin') {
      states[0] = this.voiceFor([ORIGIN_KEY], 0, 0.35);
    } else if (this.phase === 'return') {
      states[0] = this.voiceFor(visible.map((v) => v[0]), 0, 0.5);
    } else if (visible.length <= 1) {
      states[0] = this.voiceFor(visible.map((v) => v[0]), visible[0]?.[1] ?? 0, 1);
    } else {
      const left = visible.filter((v) => v[1] < 0).map((v) => v[0]);
      const right = visible.filter((v) => v[1] >= 0).map((v) => v[0]);
      const level = visible.length > 64 ? 0.75 : 0.9;
      states[0] = this.voiceFor(left, -0.7, level);
      states[1] = this.voiceFor(right, 0.7, level);
    }
    // Events from visible worlds (frames carry each event once).
    if (this.scale > 0) {
      const stride = Math.max(1, Math.floor(visible.length / 24));
      for (let v = 0; v < visible.length; v += stride) {
        const [key, pan] = visible[v];
        const f = this.frameFor(key);
        if (!f || f.nEvents === 0 || (f as WorldFrame & { _heard?: boolean })._heard) continue;
        (f as WorldFrame & { _heard?: boolean })._heard = true;
        for (let k = 0; k < f.nEvents; k++) {
          const type = f.events[k * 4];
          const lin = f.events[k * 4 + 3];
          const gain = visible.length > 64 ? 0.5 : 1;
          if (type === EV_BIRTH) events.push({ type: 'birth', lineage: lin === 255 ? 6 : lin, pan, gain });
          else if (type === EV_CATCH) events.push({ type: 'catch', lineage: lin, pan, gain });
          else if (type === EV_DEATH && events.length < 3) events.push({ type: 'death', lineage: lin === 255 ? 0 : lin, pan, gain: gain * 0.6 });
        }
      }
    }
    this.sound.update(states, events);
  }

  // =========================================================================
  // Debug
  // =========================================================================

  private updateDebug(): void {
    if (!this.debugOn) {
      this.ui.debug(null);
      return;
    }
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const src = this.src();
    const st = this.renderer.stats;
    this.ui.debug(
      [
        `fps        ${this.fps.toFixed(0)}`,
        `phase      ${this.phase}${this.replay ? ` (${this.replay.stage})` : ''}`,
        `seed       ${this.seed}`,
        `step       ${src.step}  (dt 1/${STEPS_PER_SECOND}s, ×${this.scale.toFixed(2)})`,
        `source     ${this.source}`,
        `worlds     ${this.pool.worldCount} in ${this.pool.size} workers`,
        `drawn      ${st.tiles} tiles · ${st.agents} organisms · ${st.shapes} shapes`,
        `advance    ${src.lastAdvanceMs.toFixed(1)} ms`,
        `tree       depth ${this.tree?.depth ?? 0} · ${this.tree?.nodes.size ?? 0} nodes`,
        `snapshots  ${this.origin ? 1 : 0} origin${this.replay ? ' + 2 replay' : ''}`,
        `divergence ${pct(this.headline)}`,
        mem ? `heap       ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  // =========================================================================
  // Input
  // =========================================================================

  private bindControls(): void {
    const ui = this.ui;
    let muted = false;
    try {
      muted = localStorage.getItem('bm-muted') === '1';
    } catch {
      /* storage unavailable */
    }
    this.sound.setMuted(muted);
    ui.muteBtn.textContent = muted ? 'Sound: off' : 'Sound: on';
    ui.muteBtn.onclick = () => this.toggleMute();
    ui.motionBtn.onclick = () => this.setReduced(!this.reduced);
    this.setReduced(this.reduced);
    ui.saveBtn.onclick = () => {
      this.captureScale = 2;
    };
  }

  private toggleMute(): void {
    const m = !this.sound.isMuted;
    this.sound.setMuted(m);
    if (!m) this.sound.start();
    this.ui.muteBtn.textContent = m ? 'Sound: off' : 'Sound: on';
    try {
      localStorage.setItem('bm-muted', m ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(window.innerWidth * this.dpr);
    const h = Math.floor(window.innerHeight * this.dpr);
    this.renderer.resize(w, h);
    // Keep the composition framed after a resize.
    if (this.phase === 'title' || this.phase === 'observe' || this.phase === 'freeze' || (this.phase === 'touch' && !this.grab)) {
      this.camera.set(this.frameWorlds([1], 0.36));
    } else if (this.phase === 'two') {
      this.camera.set(this.frameWorlds([2, 3], 0.36));
    } else if ((this.phase === 'branch' || this.phase === 'many') && this.tree && this.focus < 0 && this.layoutMode === 'tree') {
      const b = treeBounds(this.tree.depth);
      this.camera.set(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY, 0.36));
    } else if (this.phase === 'shared' && this.sharedKey > 0) {
      this.camera.set(this.frameWorlds([this.sharedKey], 0.36));
    }
  }

  private tileAt(sx: number, sy: number): number {
    const [px0, py0] = this.camera.toPlane(sx, sy);
    let best = -1;
    let bd = Infinity;
    for (const [key] of this.tiles) {
      if (key >= LOD_SIZE) continue;
      const t = this.tileNow(key)!;
      if (t.a < 0.3) continue;
      const d = (px0 - t.x) ** 2 + (py0 - t.y) ** 2;
      if (d < t.r * t.r * 1.05 && d < bd) {
        bd = d;
        best = key;
      }
    }
    return best;
  }

  private bindInput(): void {
    const c = this.canvas;
    const local = (e: PointerEvent | WheelEvent | MouseEvent): [number, number] => {
      const [W, H] = this.viewSize();
      return [e.clientX * this.dpr - W / 2, e.clientY * this.dpr - H / 2];
    };
    c.addEventListener('pointerdown', (e) => {
      this.idleSince = this.now;
      const [sx, sy] = local(e);
      this.pointer = { x: e.clientX, y: e.clientY, down: true, id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: 0, t: this.now };
      c.setPointerCapture(e.pointerId);
      if (this.phase === 'touch' && !this.grab) {
        const i = this.pickAgent(sx, sy, 1, 26);
        if (i >= 0) this.startGrab(i, false);
        return;
      }
      if (this.phase === 'title') return;
      this.dragPrev = { x: e.clientX, y: e.clientY, t: this.now, vx: 0, vy: 0 };
    });
    c.addEventListener('pointermove', (e) => {
      const [sx, sy] = local(e);
      const p = this.pointer;
      if (this.grab && this.grab.dragging && !this.grab.keyboard) {
        this.dragTo(e.clientX - p.sx, e.clientY - p.sy);
        return;
      }
      if (p.down && this.dragPrev && this.canNavigate()) {
        const dx = e.clientX - this.dragPrev.x;
        const dy = e.clientY - this.dragPrev.y;
        p.moved += Math.abs(dx) + Math.abs(dy);
        if (p.moved > 4) {
          this.camera.panByPx(dx * this.dpr, dy * this.dpr);
          const dtm = Math.max(1, this.now - this.dragPrev.t) / 1000;
          this.dragPrev = { x: e.clientX, y: e.clientY, t: this.now, vx: (dx * this.dpr) / dtm, vy: (dy * this.dpr) / dtm };
        }
        return;
      }
      if (this.phase === 'touch' && !this.grab) {
        c.classList.toggle('grab', this.pickAgent(sx, sy, 1, 26) >= 0);
      }
      if (this.canNavigate() || this.phase === 'two') {
        const k = this.tileAt(sx, sy);
        this.hover = this.tree && k >= 0 && k !== 1 ? k : -1;
        c.classList.toggle('pointer', this.hover >= 0 && this.canNavigate());
        this.updateCard(e.clientX, e.clientY);
      }
    });
    const up = (e: PointerEvent) => {
      const p = this.pointer;
      if (!p.down) return;
      p.down = false;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      if (this.grab && this.grab.dragging && !this.grab.keyboard) {
        void this.releaseGrab();
        return;
      }
      if (this.canNavigate()) {
        if (p.moved > 6 && this.dragPrev) {
          if (this.now - this.dragPrev.t < 80) this.camera.fling(this.dragPrev.vx, this.dragPrev.vy);
        } else {
          const [sx, sy] = local(e);
          const k = this.tileAt(sx, sy);
          if (k >= 0 && this.tree?.nodes.has(k)) {
            if (k === this.focus) this.unfocus();
            else this.focusOn(k);
          } else if (this.focus >= 0) this.unfocus();
        }
      }
      this.dragPrev = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => {
      if (!this.pointer.down) {
        this.hover = -1;
        this.ui.card(null);
      }
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.idleSince = this.now;
        if (!this.canNavigate()) return;
        const [sx, sy] = local(e);
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
        const [, H] = this.viewSize();
        this.camera.zoomAt(factor, sx, sy, H * 0.012, H * 3);
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  private canNavigate(): boolean {
    return (this.phase === 'branch' || this.phase === 'many') && !this.busyAction;
  }

  private updateCard(clientX: number, clientY: number): void {
    if (this.hover < 0 || !this.tree || this.focus >= 0 || !this.canNavigate()) {
      this.ui.card(null);
      return;
    }
    const k = this.hover;
    const m = this.metricsOf(k);
    if (!m) {
      this.ui.card(null);
      return;
    }
    const node = this.tree.nodes.get(k);
    const lines = [
      `grazers   ${m.grazers}`,
      `hunters   ${m.hunters}`,
      `lineages  ${m.lineages}  (${m.diversity.toFixed(1)} effective)`,
      `food      ${(m.resource * 100).toFixed(0)}%`,
      `born ${m.births} · died ${m.deaths} · caught ${m.catches}`,
    ];
    if (node) lines.push(`born of    ${describeIntervention(node.iv)}`);
    this.ui.card(
      `<div class="n">World ${BranchTree.label(k)}</div><div class="o" style="color:${cssColor(OUTCOME_COLOR[m.outcome])}">${OUTCOME_LABEL[m.outcome]}</div><div class="k">${lines.join('\n')}</div>`,
      clientX,
      clientY,
    );
  }

  private onKey(e: KeyboardEvent): void {
    this.idleSince = this.now;
    const tag = (e.target as HTMLElement)?.tagName;
    if (e.key === '`' || (e.key === 'd' && e.shiftKey && e.altKey)) {
      this.debugOn = !this.debugOn;
      return;
    }
    if (e.key === 'm' || e.key === 'M') {
      this.toggleMute();
      return;
    }
    if (e.key === 'p' || e.key === 'P') {
      this.captureScale = 2;
      return;
    }
    if (this.phase === 'touch') {
      const step = e.shiftKey ? 0.5 : 0.1;
      let dx = 0;
      let dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      if (dx || dy) {
        e.preventDefault();
        if (!this.grab && this.target) this.startGrab(this.target.index, true);
        if (this.grab) {
          this.grab.dx = Math.max(-3, Math.min(3, this.grab.dx + dx));
          this.grab.dy = Math.max(-3, Math.min(3, this.grab.dy + dy));
          this.ui.announce(`Moved ${px(Math.hypot(this.grab.dx, this.grab.dy))} pixels`);
        }
        return;
      }
      if (e.key === 'Enter' && this.grab) {
        e.preventDefault();
        void this.releaseGrab();
        return;
      }
    }
    if (tag === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
    if (this.canNavigate()) {
      const [W, H] = this.viewSize();
      const pan = Math.min(W, H) * 0.12;
      if (e.key === 'ArrowLeft') this.camera.panByPx(pan, 0);
      else if (e.key === 'ArrowRight') this.camera.panByPx(-pan, 0);
      else if (e.key === 'ArrowUp') this.camera.panByPx(0, pan);
      else if (e.key === 'ArrowDown') this.camera.panByPx(0, -pan);
      else if (e.key === '+' || e.key === '=') this.camera.zoomAt(1.25, 0, 0, H * 0.012, H * 3);
      else if (e.key === '-' || e.key === '_') this.camera.zoomAt(0.8, 0, 0, H * 0.012, H * 3);
      else if (e.key === 'Escape' || e.key === 'u' || e.key === 'U') {
        if (this.focus >= 0) this.unfocus();
        else if (this.tree) {
          const b = treeBounds(this.tree.depth);
          this.flyTo(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY), this.dur(1200));
        }
      }
    }
    if (e.key === 'Escape' && this.replay && this.replay.stage !== 'search') void this.endReplay();
  }
}

/** The field is interleaved (resource, fertility); divergence compares resource only. */
function everyOther(f: Uint8Array): Uint8Array {
  const out = new Uint8Array(f.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = f[i * 2];
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % 1000000;
}
