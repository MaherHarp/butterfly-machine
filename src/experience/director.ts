import { Sound, type SoundEvent, type VoiceState } from '../audio/sound';
import { LOD_HIGH, LOD_LOW, LOD_NONE, UNIT_STRIDE, type MindFrame } from '../engine/packet';
import { SimPool } from '../engine/pool';
import { BranchTree, depthOf, parentOf, siblingOf } from '../engine/tree';
import { Camera, easeInOut, easeOut, type View } from '../render/camera';
import { NO_MOOD, Renderer, type TileInput } from '../render/renderer';
import { ShapeBatch } from '../render/shapes';
import {
  EV_RELEASE,
  EV_SETTLE,
  N_ASSEMBLIES,
  N_CHANNELS,
  N_NEURONS,
  STEPS_PER_SECOND,
  STIM_ON,
  TYPE_EXC,
  TYPE_INH,
  UNKNOWN,
  decodeMetrics,
  describeIntervention,
  networkFor,
  rootNeuron,
  stimulusLevel,
  type DecodedMetrics,
  type Intervention,
  type Network,
} from '../sim';
import type { FirstDivergence, PathEntry } from '../sim/replay';
import { UNDECIDED_SEEDS } from '../sim/seeds';
import { Overlay, type Action, type LabelSpec } from '../ui/overlay';
import {
  OUTCOME_COLOR,
  OUTCOME_DESCRIPTION,
  OUTCOME_LABEL,
  PINK,
  cssColor,
  divergenceHeadline,
  divergenceLine,
  pct,
  secs,
  signedSecs,
  tallyOutcomes,
  thousands,
} from './format';
import { MoodFollower, channelActivity, drawStimulus, moodFor } from './interpretation';
import { ANCHORS, landscapeTarget, offsetFor, treeBounds, treePosition } from './layout';
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
  result: FirstDivergence;
  stage: 'rewind' | 'approach' | 'moment' | 'cascade' | 'settle' | 'done';
  stageAt: number;
  nameX: string;
  nameY: string;
  returnPhase: Phase;
  restore: () => void;
  liveStep: number;
  /** Which of x / y carries the change (pink). */
  altered: number;
  ladder: string[];
  staged: Map<number, { x: number; y: number; r: number; a: number }> | null;
}

interface Trail {
  pts: Float32Array;
  n: number;
  head: number;
  sx: number;
  sy: number;
}

/** Network milliseconds shown per wall-clock second at normal speed. */
const PLAY = 150;
/** The moment Mind 0 is stopped so the visitor can change it: 300 ms after the image appears. */
const FREEZE_STEP = STIM_ON + 300;
/** Network time between generations when many minds are made. */
const FORK_EVERY = 25;
const TWO_X = 1.62;
const COMPASS_R = 0.5;
const ORIGIN_KEY = 100001;
const REPLAY_X = 9002;
const REPLAY_Y = 9003;
const ORIGIN_SLOT = 9001;
const LOD_SIZE = 4096;
const TRAIL_LEN = 900;

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
  private stopAt: number | null = null;
  private source: 'pool' | 'analyst' = 'pool';
  private barrier = false;
  private inflight: Promise<void> | null = null;
  private lodDirty = true;
  private lod = new Uint8Array(LOD_SIZE);
  private lastDrawn = 0;
  private lastGen = -1;

  // Minds
  private seed: number;
  private net: Network;
  private tree: BranchTree | null = null;
  private origin: { buf: ArrayBuffer; step: number } | null = null;
  private userIv: Extract<Intervention, { kind: 'delay' }> | null = null;
  private readonly tiles = new Map<number, TileAnim>();
  private layoutMode: 'tree' | 'landscape' = 'tree';
  private landscapeAt = 0;
  private landscapeTargets = new Map<number, [number, number]>();
  private clusterLabels: Array<{ o: number; x: number; y: number; n: number; r: number; dx: number; dy: number }> = [];
  private ringRadius = 10;
  private treeAlpha = 0;
  private treeAlphaTarget = 0;
  private readonly moods = new Map<number, MoodFollower>();
  private readonly trails = new Map<number, Trail>();
  private compass = { x: 0, y: 0, r: COMPASS_R, a: 0, ta: 0 };
  private sparks: Array<{ key: number; unit: number; at: number }> = [];
  private readonly chan = new Float32Array(N_CHANNELS);

  // Act 3
  private verdictAt = -1;
  private verdict: 'apart' | 'same' | 'open' | null = null;

  // Act 2
  private peek: { step: number; next: Int32Array } | null = null;
  private peekPending = false;
  private target: { unit: number; at: number } | null = null;
  private delayMs = 5;

  // Interaction
  private hover = -1;
  private focus = -1;
  private compareWith = -1;
  private userMoved = false;
  private pointer = { x: 0, y: 0, down: false, id: -1, sx: 0, sy: 0, moved: 0, t: 0 };
  private dragPrev: { x: number; y: number; t: number; vx: number; vy: number } | null = null;
  private busyAction = false;
  private idleSince = 0;

  // When did these minds diverge?
  private replay: Replay | null = null;
  private savedTrails: Map<number, Trail> | null = null;

  // Post
  private post = { fade: 0, sat: 1, bloom: 0.9, exposure: 1.3, grain: 0.016 };
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
  private heard = new WeakSet<MindFrame>();

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
    this.net = networkFor(this.seed);
    this.renderer.setNetwork(this.net);
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
    await this.newMind(true);
  }

  private get maxMinds(): number {
    return 1 << this.opts.maxDepth;
  }

  private async newMind(showTitle: boolean): Promise<void> {
    this.setPhase('boot');
    await this.withBarrier(async () => {
      await this.pool.reset();
      await this.analyst.reset();
    });
    this.net = networkFor(this.seed);
    this.renderer.setNetwork(this.net);
    this.tree = null;
    this.origin = null;
    this.userIv = null;
    this.replay = null;
    this.collapse = null;
    this.focus = -1;
    this.compareWith = -1;
    this.hover = -1;
    this.target = null;
    this.peek = null;
    this.delayMs = 5;
    this.verdict = null;
    this.verdictAt = -1;
    this.layoutMode = 'tree';
    this.treeAlphaTarget = 0;
    this.compass.ta = 0;
    this.compass.a = 0;
    this.moods.clear();
    this.trails.clear();
    this.sparks = [];
    this.tiles.clear();
    this.source = 'pool';
    this.renderer.clearTrails();
    const step = await this.pool.seed(1, this.seed);
    this.sim = step;
    this.lastDrawn = step;
    this.scale = showTitle ? 0.45 : 1;
    this.scaleTarget = this.scale;
    // Rest until the visitor begins; the image only appears once they are watching.
    this.stopAt = showTitle ? STIM_ON - 800 : FREEZE_STEP;
    this.setTile(1, 0, 0, 1, 1);
    this.camera.set(this.frameWorlds([1], 0.4));
    this.lodDirty = true;
    this.ui.summary(null);
    this.ui.readout(null);
    this.ui.actions(null);
    this.ui.big(null);
    this.ui.line(null);
    this.ui.card(null);
    this.ui.corner(null);
    this.ui.timing(null);
    this.ui.captionHigh(false);
    if (showTitle) {
      this.postTarget.fade = 0.45;
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
    this.stopAt = FREEZE_STEP;
    this.scaleTau = 1.2;
    this.scaleTarget = 1;
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
    if (this.scale > 0) this.sim += dt * PLAY * this.scale;
    if (this.stopAt !== null && this.sim > this.stopAt) this.sim = this.stopAt;
    const maxLead = 2 + PLAY * dt * Math.max(1, this.scale) * 1.5;
    if (this.sim > src.step + maxLead) this.sim = src.step + maxLead;
    if (this.sim < src.step) this.sim = src.step;
    let want = Math.floor(this.sim);
    if (this.stopAt !== null && want > this.stopAt) want = this.stopAt;
    if (!this.barrier && !this.inflight && src.mindCount > 0 && (want > src.step || this.lodDirty)) {
      this.lodDirty = false;
      const lod = this.source === 'pool' ? this.lod : new Uint8Array(0);
      const p = src.advance(Math.max(want, src.step), lod, this.source === 'pool' ? LOD_NONE : LOD_HIGH);
      this.inflight = p.then(() => {
        this.inflight = null;
      });
    }
  }

  private frameFor(key: number): MindFrame | null {
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

  private stepNow(): number {
    return this.src().step;
  }

  /** Network seconds since the visitor's change. */
  private sinceChange(): number {
    if (!this.tree) return 0;
    return (this.stepNow() - this.tree.originStep) / STEPS_PER_SECOND;
  }

  private until(cond: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const check = () => (cond() ? resolve() : setTimeout(check, 16));
      check();
    });
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
    return { x: t.fx + (t.tx - t.fx) * e, y: t.fy + (t.ty - t.fy) * e, r: t.fr + (t.tr - t.fr) * e, a: t.fa + (t.ta - t.fa) * e };
  }

  private tweenTile(key: number, x: number, y: number, r: number, a: number, dur: number, from?: { x: number; y: number; r: number; a: number }): void {
    const cur = from ?? this.tileNow(key) ?? { x, y, r, a: 0 };
    this.tiles.set(key, { fx: cur.x, fy: cur.y, fr: cur.r, fa: cur.a, tx: x, ty: y, tr: r, ta: a, t0: this.now, dur });
  }

  private pruneTiles(): void {
    for (const [k, t] of this.tiles) if (t.ta <= 0 && this.now - t.t0 > t.dur + 50) this.tiles.delete(k);
  }

  private viewSize(): [number, number] {
    return this.renderer.size;
  }

  /** A view that frames the given minds, leaving room for type above and below. */
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
    const usableH = H * (this.opts.small ? 0.62 : 0.68);
    const side = this.phase === 'many' && !this.opts.small && this.focus < 0;
    const usableW = W * (side ? 0.66 : this.opts.small ? 0.94 : 0.88);
    let zoom = Math.min(usableW / (maxX - minX), usableH / (maxY - minY));
    if (radiusFrac) zoom = Math.min(zoom, H * radiusFrac);
    const cx = (minX + maxX) / 2 + (side ? (W * 0.08) / zoom : 0);
    const cy = (minY + maxY) / 2 + (H * 0.03) / zoom;
    return { x: cx, y: cy, zoom };
  }

  private flyTo(v: View, ms: number, ease = easeInOut): void {
    if (this.reduced) {
      this.camera.flyTo(v, Math.min(ms, 400), this.now, this.viewSize()[0], easeOut);
      return;
    }
    this.camera.flyTo(v, ms, this.now, this.viewSize()[0], ease);
  }

  private twoView(): View {
    return this.frameBounds(-TWO_X - 1.15, TWO_X + 1.15, -1.15, 1.15, 0.4);
  }

  /** Move every leaf to its H-tree position for the current depth. */
  private layoutTree(dur: number, parentsFrom?: Map<number, { x: number; y: number; r: number; a: number }>): void {
    if (!this.tree) return;
    const D = this.tree.depth;
    for (const k of this.tree.leaves()) {
      const [x, y] = this.treePos(k, D);
      const from = parentsFrom?.get(parentOf(k));
      this.tweenTile(k, x, y, 1, 1, dur, from);
    }
  }

  /** H-tree position; at depth 1 the two minds sit wider apart, with the compass between them. */
  private treePos(k: number, D: number): [number, number] {
    if (D === 1) return [k === 2 ? -TWO_X : TWO_X, 0];
    return treePosition(k, D);
  }

  // =========================================================================
  // Act 2: change one thing
  // =========================================================================

  private async requestPeek(): Promise<void> {
    if (this.peekPending) return;
    this.peekPending = true;
    const p = await this.withBarrier(() => this.pool.peek(1, 40));
    this.peekPending = false;
    this.peek = p;
  }

  /** Suggest a unit of an assembly that is about to fire, somewhere in the middle of its arm. */
  private chooseTarget(): void {
    const p = this.peek;
    if (!p) return;
    const net = this.net;
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < N_NEURONS; i++) {
      const at = p.next[i];
      if (at < 0) continue;
      const wait = at - p.step;
      if (wait < 2) continue;
      const r = Math.sqrt(net.x[i] ** 2 + net.y[i] ** 2);
      let score = Math.abs(wait - 6) * 0.08 + Math.abs(r - 0.62) * 2;
      if (net.type[i] !== TYPE_EXC) score += 1.5;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0) this.target = { unit: best, at: p.next[best] };
  }

  private enterTouch(): void {
    if (!this.target) return;
    this.setPhase('touch');
    this.ui.line('This unit is about to fire. Delay its spike.');
    this.ui.announce('One unit is about to fire. Use the slider or the arrow keys to delay its spike by 1 to 10 milliseconds, then press Enter.');
    this.leanIn();
  }

  private leanIn(): void {
    if (!this.target) return;
    const [, H] = this.viewSize();
    const zoom = H * 1.35;
    const ux = this.net.x[this.target.unit];
    const uy = this.net.y[this.target.unit];
    this.flyTo({ x: ux, y: uy + (H * 0.06) / zoom, zoom }, this.dur(1800));
  }

  private selectUnit(i: number): void {
    if (!this.peek || i < 0) return;
    const at = this.peek.next[i];
    if (at < 0) {
      this.ui.line('That unit will not fire in the next 40 ms. Choose one that is about to.');
      return;
    }
    this.target = { unit: i, at };
    this.ui.line('This unit is about to fire. Delay its spike.');
    this.leanIn();
  }

  private touchActions(): void {
    this.ui.actions([{ label: `Delay this spike by ${this.delayMs} ms`, onClick: () => void this.confirmChange(), primary: true }]);
  }

  private async confirmChange(): Promise<void> {
    if (this.phase !== 'touch' || !this.target || this.busyAction) return;
    this.busyAction = true;
    this.userIv = { kind: 'delay', neuron: this.target.unit, ms: this.delayMs };
    this.ui.timing(null);
    this.ui.actions(null);
    this.ui.line(null);
    this.ui.big(null);
    this.setPhase('confirm');
    this.flyTo(this.frameWorlds([1], 0.4), this.dur(1700));
    await this.splitRoot();
    this.busyAction = false;
  }

  private async splitRoot(): Promise<void> {
    const iv = this.userIv!;
    await this.withBarrier(async () => {
      const snap = await this.pool.snapshot(1);
      if (!snap) return;
      this.origin = { buf: snap.buf, step: snap.step };
      this.tree = new BranchTree(this.seed, snap.step);
      const results = await this.pool.split([{ parent: 1, a: 2, b: 3, mode: 'explicit', ivA: null, ivB: iv, pair: true }]);
      this.tree.addLevel(snap.step, results);
    });
    await sleep(this.dur(1000));
    const from = this.tileNow(1) ?? { x: 0, y: 0, r: 1, a: 1 };
    this.tiles.delete(1);
    for (const k of [2, 3]) {
      const [x, y] = this.treePos(k, 1);
      this.tweenTile(k, x, y, 1, 1, this.dur(2600), from);
    }
    this.compass = { x: 0, y: 0, r: COMPASS_R, a: 0, ta: 1 };
    this.trails.clear();
    this.flyTo(this.twoView(), this.dur(2600));
    await sleep(this.dur(2200));
    // Slow motion while the difference is still one spike wide.
    this.scaleTau = 0.8;
    this.scaleTarget = 0.035;
    this.stopAt = null;
    this.verdict = null;
    this.verdictAt = -1;
    this.ui.captionHigh(true);
    this.setPhase('two');
  }

  // =========================================================================
  // Act 5: many minds
  // =========================================================================

  private async runMinds(): Promise<void> {
    if (!this.tree || !this.origin || !this.userIv || this.busyAction) return;
    this.busyAction = true;
    this.ui.captionHigh(false);
    this.focus = -1;
    this.ui.actions(null);
    this.ui.summary(null);
    this.ui.big(null);
    this.setPhase('cascade');
    this.ui.line('Back to the moment of the change.');
    // Rewind: the clock runs back to the change.
    const since = this.sinceChange();
    this.scaleTau = 0.3;
    this.scaleTarget = 0;
    const t0 = this.now;
    const rd = this.dur(1600);
    await this.until(() => {
      const u = Math.min(1, (this.now - t0) / rd);
      this.ui.readout(
        `<div class="stat"><div class="num huge" data-v>${secs(since * (1 - easeInOut(u)))}</div><div class="lab">After the change</div></div>`,
        'rewind',
      );
      return u >= 1;
    });
    const D = this.opts.maxDepth;
    const originStep = this.origin.step;
    await this.withBarrier(async () => {
      await this.pool.reset();
      await this.pool.load(1, this.origin!.buf.slice(0), 0);
      const res = await this.pool.split([{ parent: 1, a: 2, b: 3, mode: 'explicit', ivA: null, ivB: this.userIv }]);
      this.tree = new BranchTree(this.seed, originStep);
      this.tree.addLevel(originStep, res);
      this.sim = originStep;
      this.lastDrawn = originStep;
      this.stopAt = originStep + FORK_EVERY;
    });
    this.renderer.clearTrails();
    this.moods.clear();
    this.trails.clear();
    this.compass.ta = 0;
    for (const k of [2, 3]) this.setTile(k, ...this.treePos(k, 1), 1, 1);
    this.ui.readout(null);
    this.ui.line('Every fork: one mind continues, its twin gets one more tiny change.');
    this.treeAlphaTarget = 1;
    this.scaleTau = 0.5;
    this.scaleTarget = 0.32;
    const b = treeBounds(D);
    this.flyTo(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY), this.dur((D - 1) * 600 + 1600));
    for (let d = 2; d <= D; d++) {
      const forkStep = originStep + (d - 1) * FORK_EVERY;
      this.stopAt = forkStep;
      await this.until(() => this.pool.step >= forkStep && !this.inflight);
      await this.forkAll(forkStep, this.dur(d > 6 ? 700 : 1000));
      this.ui.readout(`<div class="stat"><div class="num huge" data-v>${thousands(this.tree.leafCount)}</div><div class="lab">Minds</div></div>`, 'cascade');
    }
    this.stopAt = null;
    this.ui.line(null);
    this.scaleTau = 1.4;
    this.scaleTarget = 2.4;
    await sleep(this.dur(1400));
    this.ui.readout(null);
    this.setPhase('many');
    this.layoutMode = 'landscape';
    this.treeAlphaTarget = 0;
    this.landscapeAt = 0;
    this.userMoved = false;
    this.busyAction = false;
  }

  /** Every leaf forks: child 2k continues unchanged, child 2k+1 receives one machine-made change. */
  private async forkAll(step: number, dur: number): Promise<void> {
    if (!this.tree) return;
    const parentsFrom = new Map<number, { x: number; y: number; r: number; a: number }>();
    for (const k of this.tree.leaves()) {
      const n = this.tileNow(k);
      if (n) parentsFrom.set(k, n);
    }
    await this.withBarrier(async () => {
      const reqs = this.tree!.leaves().map((k) => ({ parent: k, a: 2 * k, b: 2 * k + 1, mode: 'auto' as const }));
      const results = await this.pool.split(reqs);
      this.tree!.addLevel(step, results);
      for (const r of results) if (r.ivB) this.sparks.push({ key: r.b, unit: rootNeuron(this.seed, r.ivB), at: this.now });
    });
    for (const k of parentsFrom.keys()) this.tiles.delete(k);
    this.layoutTree(dur, parentsFrom);
  }

  /**
   * The landscape: minds gather by the attractor they are in, each group a
   * sunflower around its anchor; undecided minds stay at the centre. Groups
   * and positions are recomputed from live state.
   */
  private layoutLandscape(dur: number): void {
    if (!this.tree) return;
    const leaves = this.tree.leaves();
    const groups: number[][] = [];
    for (let o = 0; o <= UNKNOWN; o++) groups.push([]);
    const lean = new Map<number, [number, number]>();
    for (const k of leaves) {
      const m = this.metricsOf(k);
      const o = m ? m.outcome : UNKNOWN;
      groups[o].push(k);
      if (m) lean.set(k, landscapeTarget(m.rates, m.commitment));
    }
    const spacing = 2.3;
    const rad = (n: number) => (n > 0 ? spacing * 0.56 * Math.sqrt(n) + 1.2 : 0);
    let ring = 0.92 * Math.sqrt(leaves.length);
    const ru = rad(groups[UNKNOWN].length);
    for (let k = 0; k < N_ASSEMBLIES; k++) {
      if (!groups[k].length) continue;
      ring = Math.max(ring, ru + rad(groups[k].length) + 2.5);
      for (let j = 0; j < N_ASSEMBLIES; j++) {
        if (j === k || !groups[j].length) continue;
        const dx = ANCHORS[k][0] - ANCHORS[j][0];
        const dy = ANCHORS[k][1] - ANCHORS[j][1];
        const sep = Math.sqrt(dx * dx + dy * dy);
        ring = Math.max(ring, (rad(groups[k].length) + rad(groups[j].length) + 2) / sep);
      }
    }
    this.ringRadius += (ring - this.ringRadius) * (this.landscapeTargets.size ? 0.35 : 1);
    const R = this.ringRadius;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const labels: Array<{ o: number; x: number; y: number; n: number; r: number; dx: number; dy: number }> = [];
    for (let o = 0; o <= UNKNOWN; o++) {
      const g = groups[o];
      if (!g.length) continue;
      const cx = o === UNKNOWN ? 0 : ANCHORS[o][0] * R;
      const cy = o === UNKNOWN ? 0 : ANCHORS[o][1] * R;
      g.forEach((k, i) => {
        const r = spacing * 0.56 * Math.sqrt(i + 0.5);
        const a = i * golden;
        let x = cx + r * Math.cos(a);
        let y = cy + r * Math.sin(a);
        // Undecided minds lean toward where they are heading.
        if (o === UNKNOWN) {
          const l = lean.get(k);
          if (l) {
            x += l[0] * 1.6;
            y += l[1] * 1.6;
          }
        }
        const prev = this.landscapeTargets.get(k);
        if (!prev || Math.abs(prev[0] - x) + Math.abs(prev[1] - y) > 0.4) {
          this.landscapeTargets.set(k, [x, y]);
          this.tweenTile(k, x, y, 1, 1, dur);
        }
      });
      labels.push({ o, x: cx, y: cy, n: g.length, r: rad(g.length) + 0.4, dx: o === UNKNOWN ? 0 : ANCHORS[o][0], dy: o === UNKNOWN ? 1 : ANCHORS[o][1] });
    }
    this.clusterLabels = labels;
  }

  private landscapeView(): View {
    const e = this.ringRadius + 2.3 * 0.56 * Math.sqrt(this.maxMinds * 0.45) + 3;
    return this.frameBounds(-e, e, -e, e);
  }

  private toggleArrangement(): void {
    if (!this.tree) return;
    if (this.layoutMode === 'landscape') {
      this.layoutMode = 'tree';
      this.treeAlphaTarget = 1;
      this.landscapeTargets.clear();
      this.layoutTree(this.dur(2200));
      const b = treeBounds(this.tree.depth);
      this.flyTo(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY), this.dur(2200));
      return;
    }
    this.layoutMode = 'landscape';
    this.treeAlphaTarget = 0;
    this.landscapeTargets.clear();
    this.layoutLandscape(this.dur(2400));
    this.flyTo(this.landscapeView(), this.dur(2400));
  }

  // =========================================================================
  // When did these minds diverge?
  // =========================================================================

  /** The closest relative of `key` that ended in a different interpretation (else its twin). */
  private nearestOther(key: number): number {
    if (!this.tree) return siblingOf(key);
    const mine = this.metricsOf(key)?.outcome ?? UNKNOWN;
    const D = this.tree.depth;
    for (let up = 1; up <= D; up++) {
      const anc = key >> up;
      const other = (key >> (up - 1)) ^ 1;
      const first = other << (up - 1);
      let best = -1;
      let bestC = -1;
      for (let k = first; k < first + (1 << (up - 1)); k++) {
        const m = this.metricsOf(k);
        if (m && m.outcome !== mine && m.outcome !== UNKNOWN && m.commitment > bestC) {
          best = k;
          bestC = m.commitment;
        }
      }
      void anc;
      if (best >= 0) return best;
    }
    return siblingOf(key);
  }

  private async whenDiverged(x: number, y: number): Promise<void> {
    if (!this.tree || !this.origin || this.busyAction) return;
    this.busyAction = true;
    const returnPhase = this.phase;
    const keepFocus = this.focus;
    const nameX = this.mindName(x);
    const nameY = this.mindName(y);
    this.setPhase('firstdiff');
    this.ui.captionHigh(true);
    this.ui.actions(null);
    this.ui.summary(null);
    this.ui.card(null);
    this.ui.line(null);
    this.ui.big('When did these minds diverge?');
    this.scaleTau = 0.25;
    this.scaleTarget = 0;
    // On the landscape, bring the two minds forward, side by side.
    let staged: Replay['staged'] = null;
    if (returnPhase !== 'two') {
      staged = new Map();
      const cx = this.camera.x;
      const cy = this.camera.y;
      for (const [k, sx] of [
        [x, -TWO_X],
        [y, TWO_X],
      ] as const) {
        const cur = this.tileNow(k);
        if (cur) staged.set(k, cur);
        this.tweenTile(k, cx + sx, cy, 1, 1, this.dur(1600));
      }
      this.compass = { x: cx, y: cy, r: COMPASS_R, a: 0, ta: 1 };
      this.flyTo(this.frameBounds(cx - TWO_X - 1.15, cx + TWO_X + 1.15, cy - 1.15, cy + 1.15, 0.4), this.dur(1600));
    }
    const tree = this.tree;
    const l = tree.lca(x, y);
    const splitStep = tree.levelSteps[depthOf(l) + 1];
    const common = tree.path(l);
    const pathX = tree.path(x).filter((e) => e.step >= splitStep);
    const pathY = tree.path(y).filter((e) => e.step >= splitStep);
    const liveStep = await this.withBarrier(async () => this.pool.step);
    const t0 = performance.now();
    const result = await this.analyst.firstDivergence({
      origin: this.origin.buf.slice(0),
      common,
      splitStep,
      pathX,
      pathY,
      maxSteps: Math.max(1, liveStep - splitStep),
      leadSteps: 40,
    });
    const elapsed = performance.now() - t0;
    if (elapsed < 1500) await sleep(1500 - elapsed);
    const restore = () => {
      this.focus = keepFocus;
      this.setPhase(returnPhase);
    };
    if (!result.found || !result.snapX || !result.snapY) {
      this.ui.big(null);
      this.ui.line('These minds never diverged: their histories are identical.');
      await sleep(3200);
      this.ui.line(null);
      this.scaleTarget = 1;
      if (staged) for (const [k, p] of staged) this.tweenTile(k, p.x, p.y, p.r, p.a, this.dur(1400));
      restore();
      this.busyAction = false;
      return;
    }
    const after = (e: PathEntry) => e.step > result.replayStep;
    await this.analyst.reset();
    await this.analyst.load(REPLAY_X, result.snapX, 0, pathX.filter(after));
    await this.analyst.load(REPLAY_Y, result.snapY, 0, pathY.filter(after));
    const alteredIsY = result.causeIn === 1 || (!result.traceable && (result.delayMs ?? 0) > 0);
    await this.analyst.pair(alteredIsY ? REPLAY_X : REPLAY_Y, alteredIsY ? REPLAY_Y : REPLAY_X, result.snapTrace ?? undefined);
    this.savedTrails = new Map(this.trails);
    this.trails.clear();
    // The replayed minds have not decided anything yet.
    this.moods.delete(x);
    this.moods.delete(y);
    this.replay = {
      x,
      y,
      result,
      stage: 'rewind',
      stageAt: this.now,
      nameX,
      nameY,
      returnPhase,
      restore,
      liveStep,
      altered: alteredIsY ? y : x,
      ladder: [],
      staged,
    };
    this.ui.big(null);
    this.postTarget.sat = 0.2;
    this.busyAction = false;
  }

  private mindName(k: number): string {
    if (this.tree && this.tree.depth === 1) return k === 2 ? 'ORIGINAL' : 'ALTERED';
    return BranchTree.label(k);
  }

  private updateReplay(): void {
    const r = this.replay;
    if (!r) return;
    const st = (this.now - r.stageAt) / 1000;
    const res = r.result;
    const stepNow = this.stepNow();
    const imageTime = (s: number) => (s - STIM_ON) / STEPS_PER_SECOND;
    const altered = this.metricsOf(r.altered);
    switch (r.stage) {
      case 'rewind': {
        const d = this.reduced ? 0.4 : 1.8;
        const u = Math.min(1, st / d);
        const shown = r.liveStep + (res.replayStep - r.liveStep) * easeInOut(u);
        this.ui.readout(
          `<div class="stat"><div class="num huge" data-v>${secs(imageTime(shown))}</div><div class="lab">Rewinding · after the image appeared</div></div>`,
          'rewind',
        );
        if (u >= 1) {
          this.source = 'analyst';
          this.sim = res.replayStep;
          this.lastDrawn = res.replayStep;
          this.renderer.clearTrails();
          this.scaleTau = 0.5;
          this.scaleTarget = this.reduced ? 0.2 : 0.07;
          this.postTarget.sat = 1;
          this.lodDirty = true;
          r.stage = 'approach';
          r.stageAt = this.now;
        }
        break;
      }
      case 'approach': {
        this.ui.readout(
          `<div class="stat"><div class="num huge" data-v>${secs(imageTime(stepNow))}</div><div class="lab">After the image appeared · slowed down</div></div>`,
          'approach',
        );
        if (stepNow >= this.momentStep(res) + 1) {
          r.stage = 'moment';
          r.stageAt = this.now;
          this.scaleTau = 0.15;
          this.scaleTarget = 0;
          this.postTarget.sat = 0.35;
          this.ui.readout(
            `<div class="stat"><div class="num huge" data-v>${secs(imageTime(this.momentStep(res)))}</div><div class="lab">After the image appeared</div></div>`,
            'moment',
          );
          this.ui.big(divergenceHeadline(res));
          this.ui.line(divergenceLine(res, r.nameX, r.nameY));
        }
        break;
      }
      case 'moment': {
        if (st > (this.reduced ? 3 : 6)) {
          r.stage = 'cascade';
          r.stageAt = this.now;
          this.scaleTau = 1.5;
          this.scaleTarget = 0.06;
          this.ui.big(null);
          this.ui.line(null);
          r.ladder = ['1 unit'];
        }
        break;
      }
      case 'cascade':
      case 'settle': {
        const changed = altered?.pair?.mismatched ?? 0;
        // Speed up as the change spreads.
        if (r.stage === 'cascade') {
          if (changed >= 5 && this.scaleTarget < 0.12) this.scaleTarget = 0.12;
          if (changed >= 40 && this.scaleTarget < 0.35) {
            this.scaleTau = 2;
            this.scaleTarget = 0.35;
          }
          if (changed >= N_NEURONS / 2 && this.scaleTarget < 1) this.scaleTarget = 1;
        }
        // The ladder: every rung is a measured event of the replay, in the order it happened.
        const rungs: Array<[number, string]> = [];
        const names = ['1 unit', '5 units', 'a cluster', 'the whole network'];
        res.cascade.forEach((c, i) => rungs.push([c.step, names[i] ?? `${c.units} units`]));
        if (res.splitTrajectoryStep >= 0) rungs.push([res.splitTrajectoryStep, 'the trajectories split']);
        rungs.sort((p, q) => p[0] - q[0]);
        const ladder = rungs.filter(([st]) => st <= stepNow).map(([, s]) => s);
        const ox = this.metricsOf(r.x);
        const oy = this.metricsOf(r.y);
        const settled = !!(ox && oy && ox.outcome !== UNKNOWN && oy.outcome !== UNKNOWN && ox.settledFor > 0.15 && oy.settledFor > 0.15);
        if (settled && ladder.length === rungs.length) {
          ladder.push(
            ox!.outcome === oy!.outcome
              ? `<span style="color:${cssColor(OUTCOME_COLOR[ox!.outcome])}">${OUTCOME_LABEL[ox!.outcome]}</span>, both`
              : `<span style="color:${cssColor(OUTCOME_COLOR[ox!.outcome])}">${OUTCOME_LABEL[ox!.outcome]}</span> · <span style="color:${cssColor(OUTCOME_COLOR[oy!.outcome])}">${OUTCOME_LABEL[oy!.outcome]}</span>`,
          );
          if (r.stage === 'cascade') {
            r.stage = 'settle';
            r.stageAt = this.now;
            this.scaleTarget = 1;
          }
        } else if (r.stage === 'cascade' && res.splitTrajectoryStep >= 0 && stepNow >= res.splitTrajectoryStep && changed >= N_NEURONS / 2) {
          this.scaleTarget = 1.4;
        }
        r.ladder = ladder;
        this.ui.line(ladder.map((s, i) => (i === 0 ? s : `<span class="arrow">→</span> ${s}`)).join(' '));
        this.ui.readout(
          `<div class="stat"><div class="num" data-v>${signedSecs((stepNow - res.splitStep) / STEPS_PER_SECOND)}</div><div class="lab">After they parted</div></div>` +
            `<div class="stat pink"><div class="num" data-v>${thousands(changed)}</div><div class="lab">Units changed</div></div>` +
            `<div class="stat"><div class="num" data-v>${pct(altered?.pair?.divergence ?? 0)}</div><div class="lab">Different</div></div>`,
          'cascade',
        );
        // The replay has caught up with the present: hold there.
        if (stepNow >= r.liveStep && this.stopAt === null) {
          this.stopAt = r.liveStep;
          this.scaleTarget = 0;
        }
        if ((r.stage === 'settle' && st > 3) || stepNow >= r.liveStep) {
          this.ui.actions([{ label: 'Return to the present', onClick: () => void this.endReplay(), primary: true }]);
        }
        if (r.stage === 'settle' && st > 24) void this.endReplay();
        break;
      }
      default:
        break;
    }
  }

  /** The moment to stop on: the first spike that happened differently (else the first state difference). */
  private momentStep(res: FirstDivergence): number {
    const c = [res.stepX, res.stepY].filter((v) => v >= 0);
    return c.length ? Math.min(...c) : res.step;
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
      this.stopAt = null;
    });
    this.renderer.clearTrails();
    this.replay = null;
    this.moods.delete(r.x);
    this.moods.delete(r.y);
    this.trails.clear();
    if (this.savedTrails) for (const [k, v] of this.savedTrails) this.trails.set(k, v);
    this.savedTrails = null;
    if (r.staged) {
      for (const [k, p] of r.staged) this.tweenTile(k, p.x, p.y, p.r, p.a, this.dur(1600));
      this.compass.ta = 0;
      this.landscapeTargets.clear();
    }
    await this.analyst.reset();
    this.scaleTau = 1;
    this.scaleTarget = 1;
    this.ui.captionHigh(r.returnPhase === 'two');
    r.restore();
    if (r.returnPhase === 'many' && this.layoutMode === 'landscape') this.flyTo(this.landscapeView(), this.dur(1800));
    if (r.returnPhase === 'two') this.flyTo(this.twoView(), this.dur(1200));
  }

  // =========================================================================
  // Return to the beginning
  // =========================================================================

  private async returnToBeginning(): Promise<void> {
    if (!this.tree || !this.origin || this.busyAction) return;
    this.busyAction = true;
    this.setPhase('return');
    this.focus = -1;
    this.compareWith = -1;
    this.ui.actions(null);
    this.ui.summary(null);
    this.ui.card(null);
    this.ui.line(null);
    this.ui.big(null);
    this.scaleTau = 0.5;
    this.scaleTarget = 0;
    this.treeAlphaTarget = 0.6;
    if (this.layoutMode === 'landscape') {
      this.layoutMode = 'tree';
      this.landscapeTargets.clear();
      this.layoutTree(this.dur(1600));
      const b = treeBounds(this.tree.depth);
      this.flyTo(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY), this.dur(1600));
      await sleep(this.dur(1700));
    }
    this.ui.summary(null);
    this.ui.actions(null);
    this.setPhase('return');
    this.collapse = { level: this.tree.depth, stageAt: this.now, depth: this.tree.depth };
    await this.analyst.reset();
    await this.analyst.load(ORIGIN_SLOT, this.origin.buf.slice(0), 0);
    this.busyAction = false;
  }

  private updateCollapse(): void {
    const c = this.collapse;
    if (!c || !this.tree) return;
    const D = c.depth;
    const stageMs = this.dur(1000);
    const st = this.now - c.stageAt;
    if (st >= stageMs && c.level > 0) {
      // 1,024 → 256 → 64 → 16 → 4 → 2 → 1
      c.level = c.level > 2 ? c.level - 2 : c.level - 1;
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
      this.flyTo(this.frameWorlds(reps, 0.4, pos), stageMs, easeInOut);
      if (g === 0) {
        this.treeAlphaTarget = 0;
        setTimeout(() => this.revealOrigin(), stageMs + 300);
      }
    }
    const visible = 1 << c.level;
    this.ui.readout(
      `<div class="stat"><div class="num huge" data-v>${thousands(visible)}</div><div class="lab">${visible === 1 ? 'mind' : 'minds'}</div></div>`,
      'collapse',
    );
  }

  private revealOrigin(): void {
    if (this.phase !== 'return' || !this.tree) return;
    this.collapse = null;
    this.source = 'analyst';
    this.sim = this.origin?.step ?? this.analyst.step;
    this.stopAt = this.origin?.step ?? this.analyst.step;
    this.lodDirty = true;
    for (const k of this.tree.leaves()) {
      const t = this.tileNow(k);
      if (t && t.a > 0) this.tweenTile(k, t.x, t.y, t.r, 0, this.dur(1800));
    }
    this.setTile(ORIGIN_KEY, 0, 0, 1, 0);
    this.tweenTile(ORIGIN_KEY, 0, 0, 1, 1, this.dur(1800));
    this.renderer.clearTrails();
    this.ui.readout(null);
    this.flyTo(this.frameWorlds([ORIGIN_KEY], 0.4, new Map([[ORIGIN_KEY, [0, 0]]])), this.dur(1800));
    this.setPhase('origin');
    this.originShown = this.now;
    this.sound.setLevel(0.2);
  }

  private updateOrigin(): void {
    const t = this.t;
    const iv = this.userIv;
    if (!iv) return;
    if (t > 2.2 && t < 2.4) this.ui.big('All of that came from this.');
    if (t > 3.6 && t < 3.8) {
      const [, H] = this.viewSize();
      const zoom = H * 2.2;
      this.flyTo({ x: this.net.x[iv.neuron], y: this.net.y[iv.neuron] + (H * 0.04) / zoom, zoom }, this.dur(7000), easeInOut);
      this.sound.release(0, 10);
    }
    if (t > 9 && t < 9.2) this.ui.line(`One spike, <em>${iv.ms} ms</em> late.`);
    if (t > 13 && t < 13.2) {
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
    await this.newMind(false);
  }

  // =========================================================================
  // Sharing
  // =========================================================================

  private shareFocused(): void {
    const k = this.focus;
    if (!this.tree || !this.userIv || k < 0) return;
    const spec: ShareSpec = {
      seed: this.seed,
      originStep: this.tree.originStep,
      neuron: this.userIv.neuron,
      ms: this.userIv.ms,
      key: k,
      step: this.pool.step,
      levelSteps: this.tree.levelSteps.slice(1, depthOf(k) + 1),
    };
    const url = `${location.origin}${location.pathname}#f=${encodeShare(spec)}`;
    const done = () => {
      this.ui.line('Link copied. Whoever opens it will watch exactly this mind unfold.');
      setTimeout(() => this.ui.line(null), 3800);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => window.prompt('Copy this link', url));
    else window.prompt('Copy this link', url);
  }

  private async openShared(spec: ShareSpec): Promise<void> {
    this.setPhase('boot');
    this.seed = spec.seed;
    this.net = networkFor(spec.seed);
    this.renderer.setNetwork(this.net);
    const D = depthOf(spec.key);
    const path: PathEntry[] = [];
    for (let d = 1; d <= D; d++) {
      const k = spec.key >> (D - d);
      const step = spec.levelSteps[d - 1];
      if (d === 1) path.push({ step, iv: k === 3 ? { kind: 'delay', neuron: spec.neuron, ms: spec.ms } : null });
      else path.push({ step, iv: k & 1 ? { auto: 1, parentKey: k >> 1 } : null });
    }
    this.ui.line('Reconstructing a shared mind…');
    this.ui.captionLow(true);
    const rec = await this.analyst.reconstructFromSeed(spec.seed, path, spec.step);
    await this.pool.load(spec.key, rec.buf, 0);
    this.sharedKey = spec.key;
    this.sim = rec.step;
    this.lastDrawn = rec.step;
    this.stopAt = null;
    this.setTile(spec.key, 0, 0, 1, 1);
    this.camera.set(this.frameWorlds([spec.key], 0.4));
    this.postTarget.fade = 1;
    this.ui.line(null);
    this.ui.captionLow(false);
    this.setPhase('shared');
    this.ui.big(`A shared mind · ${BranchTree.label(spec.key)}`);
    setTimeout(() => this.ui.big(null), 5000);
    this.ui.actions([
      {
        label: 'Begin your own',
        primary: true,
        onClick: () => {
          history.replaceState(null, '', location.pathname + location.search);
          this.share = null;
          this.seed = randomSeed();
          void this.newMind(true);
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
    this.updateMoods(dt);
    this.pruneTiles();
    this.post.fade += (this.postTarget.fade - this.post.fade) * (1 - Math.exp(-dt * 1.6));
    this.post.sat += (this.postTarget.sat - this.post.sat) * (1 - Math.exp(-dt * 2.5));
    this.treeAlpha += (this.treeAlphaTarget - this.treeAlpha) * (1 - Math.exp(-dt * 1.5));
    this.compass.a += (this.compass.ta - this.compass.a) * (1 - Math.exp(-dt * 1.4));

    const tiles = this.buildTiles();
    this.buildShapes();
    const drawn = this.stepNow();
    const steps = Math.max(0, drawn - this.lastDrawn);
    this.lastDrawn = drawn;

    if (this.captureScale) this.capture(tiles, steps);
    else
      this.renderer.render({
        tiles,
        view: this.camera.view,
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
      const name = this.focus >= 0 ? `mind-${BranchTree.label(this.focus)}` : this.phase;
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
    const step = this.stepNow();
    switch (this.phase) {
      case 'title':
        break;
      case 'observe': {
        if (t > 1.5 && t < 1.7) this.ui.line('A small neuro-inspired network, at rest.');
        if (step >= STIM_ON - 120 && this.scaleTarget > 0.5) {
          this.ui.line('Now it is shown something it cannot quite name.');
          this.scaleTau = 1.2;
          this.scaleTarget = 0.4;
        }
        if (step >= STIM_ON + 160 && this.scaleTarget > 0.13) {
          this.ui.line(null);
          this.scaleTau = 1.6;
          this.scaleTarget = 0.13;
        }
        this.ui.corner(`<span>Mind 0</span><span class="mono">${secs((step - STIM_ON) / STEPS_PER_SECOND, 2).replace('-', '−')}</span>`);
        if (step >= FREEZE_STEP && !this.inflight) {
          this.scale = 0;
          this.scaleTarget = 0;
          this.setPhase('freeze');
          void this.requestPeek();
        }
        break;
      }
      case 'freeze': {
        if (t > 0.9 && t < 1.1) this.ui.big('Change one thing');
        if (t > 2.6 && this.peek && !this.target) {
          this.chooseTarget();
          if (this.target) this.enterTouch();
        }
        break;
      }
      case 'touch': {
        this.touchActions();
        break;
      }
      case 'two':
        this.updateTwo();
        break;
      case 'cascade':
        break;
      case 'many': {
        if (this.layoutMode === 'landscape' && this.now - this.landscapeAt > 450) {
          const first = this.landscapeTargets.size === 0;
          this.layoutLandscape(this.dur(first ? 2600 : 1500));
          if (first) this.flyTo(this.landscapeView(), this.dur(2600));
          else if (!this.userMoved && this.focus < 0 && !this.camera.flying) {
            const v = this.landscapeView();
            if (Math.abs(v.zoom - this.camera.zoom) / this.camera.zoom > 0.08) this.flyTo(v, this.dur(1800));
          }
          this.landscapeAt = this.now;
        }
        if (this.sinceChange() > 4.5 && this.scaleTarget > 1) {
          this.scaleTau = 2;
          this.scaleTarget = 1;
        }
        this.ui.readout(null);
        this.updateSummary();
        this.focusActions(() => [
          { label: this.layoutMode === 'landscape' ? 'Arrange by family' : 'Arrange by interpretation', onClick: () => this.toggleArrangement() },
          { label: 'Return to the beginning', onClick: () => void this.returnToBeginning(), primary: true, breathe: t > 40 },
        ]);
        break;
      }
      case 'firstdiff':
        this.updateReplay();
        break;
      case 'return':
        this.ui.summary(null);
        this.updateCollapse();
        break;
      case 'origin':
        this.ui.summary(null);
        this.updateOrigin();
        break;
      case 'shared': {
        const m = this.metricsOf(this.sharedKey);
        if (m) this.ui.corner(`<span>Mind ${BranchTree.label(this.sharedKey)}</span><span>${OUTCOME_LABEL[m.outcome]}</span>`);
        break;
      }
      default:
        break;
    }
    if (this.phase !== 'observe' && this.phase !== 'shared') {
      if (this.tree && (this.phase === 'many' || this.phase === 'two' || this.phase === 'cascade')) {
        const n = this.tree.leafCount;
        this.ui.corner(
          `<span>${thousands(n)} ${n === 1 ? 'mind' : 'minds'}</span><span class="mono">${signedSecs(this.sinceChange())}</span>` +
            (this.scale > 1.2 ? `<span class="mono">×${this.scale.toFixed(1)}</span>` : ''),
        );
      } else if (this.phase !== 'firstdiff') this.ui.corner(null);
    }
    if ((this.phase === 'many' || this.phase === 'origin') && this.now - this.idleSince > 240000) {
      this.seed = randomSeed();
      void this.newMind(true);
    }
  }

  private updateTwo(): void {
    const since = this.sinceChange();
    const a = this.metricsOf(3);
    const o = this.metricsOf(2);
    const pair = a?.pair;
    const div = pair?.divergence ?? 0;
    // Slow motion while the difference is a handful of units wide, then back up to speed.
    const ramp: Array<[number, number]> = [
      [0.012, 0.08],
      [0.04, 0.16],
      [0.1, 0.35],
      [0.25, 0.65],
      [0.45, 1],
    ];
    for (const [at, sc] of ramp) {
      if (since > at && this.scaleTarget < sc && this.verdict === null) {
        this.scaleTau = 1.4;
        this.scaleTarget = sc;
      }
    }
    this.ui.readout(
      `<div class="stat"><div class="num" data-v>${pct(div)}</div><div class="lab">Different</div></div>` +
        `<div class="stat"><div class="num" data-v>${signedSecs(since)}</div><div class="lab">After the change</div></div>` +
        `<div class="stat pink"><div class="num" data-v>${thousands(pair?.mismatched ?? 0)}</div><div class="lab">Units changed</div></div>`,
      'two',
    );
    if (this.verdict === null && a && o) {
      const both = a.outcome !== UNKNOWN && o.outcome !== UNKNOWN && a.settledFor > 0.35 && o.settledFor > 0.35;
      if (both) this.verdict = a.outcome !== o.outcome ? 'apart' : 'same';
      else if (since > 5) this.verdict = 'open';
      if (this.verdict) {
        this.verdictAt = this.now;
        if (this.verdict === 'apart') this.ui.big('These minds no longer follow the same trajectory');
        else if (this.verdict === 'same') this.ui.line('Every unit now fires differently, yet both arrived at the same interpretation.');
        else this.ui.line('Their trajectories have parted. Neither has settled yet.');
      }
    }
    if (this.verdict && this.now - this.verdictAt > 5200) this.ui.big(null);
    if (this.verdict && this.now - this.verdictAt > 3200) {
      this.ui.actions([
        { label: 'When did these minds diverge?', onClick: () => void this.whenDiverged(2, 3) },
        { label: `Run ${thousands(this.maxMinds)} minds`, onClick: () => void this.runMinds(), primary: true, breathe: true },
      ]);
    }
    if (this.verdict && this.now - this.verdictAt > 11000) this.ui.line(null);
  }

  /** Actions while browsing, with the focused mind's own actions when one is open. */
  private focusActions(base: () => Action[]): void {
    if (this.busyAction) return;
    if (this.focus >= 0 && this.tree) {
      const k = this.focus;
      const m = this.metricsOf(k);
      const node = this.tree.nodes.get(k);
      const other = this.compareWith >= 0 ? this.compareWith : this.nearestOther(k);
      const om = this.metricsOf(other);
      this.ui.readout(
        `<div class="stat focus"><div class="num" data-v>Mind ${BranchTree.label(k)}</div><div class="lab">${m ? OUTCOME_LABEL[m.outcome] : ''}</div></div>` +
          `<div class="stat"><div class="num" data-v>${this.tree.changes(k)}</div><div class="lab">Changes from the original</div></div>` +
          (node ? `<div class="stat"><div class="num" data-v>${describeIntervention(node.iv, this.seed)}</div><div class="lab">At its fork</div></div>` : ''),
        `focus-${k}-${!!node}`,
      );
      const label =
        this.compareWith >= 0
          ? 'When did these minds diverge?'
          : om && m && om.outcome !== m.outcome
            ? `When did it part from ${OUTCOME_LABEL[om.outcome]}?`
            : 'When did it part from its twin?';
      this.ui.actions([
        { label, onClick: () => void this.whenDiverged(k, other), primary: true },
        { label: 'Share this mind', onClick: () => this.shareFocused() },
        { label: 'Back', onClick: () => this.unfocus() },
      ]);
      return;
    }
    this.ui.actions(base());
  }

  private focusOn(key: number): void {
    if (!this.tree || this.busyAction || this.phase !== 'many') return;
    if (this.focus >= 0 && key !== this.focus) {
      this.compareWith = key === this.compareWith ? -1 : key;
      return;
    }
    this.focus = key;
    this.compareWith = -1;
    this.hover = -1;
    this.ui.card(null);
    this.ui.summary(null);
    const t = this.tiles.get(key);
    if (!t) return;
    const [, H] = this.viewSize();
    const zoom = H * 0.3;
    this.flyTo({ x: t.tx, y: t.ty + (H * 0.05) / zoom, zoom }, this.dur(1600));
  }

  private unfocus(): void {
    if (!this.tree) return;
    this.focus = -1;
    this.compareWith = -1;
    if (this.layoutMode === 'landscape') this.flyTo(this.landscapeView(), this.dur(1600));
    else {
      const b = treeBounds(this.tree.depth);
      this.flyTo(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY), this.dur(1600));
    }
    this.userMoved = false;
  }

  private updateSummary(): void {
    if (!this.tree || this.focus >= 0) {
      this.ui.summary(null);
      return;
    }
    const outs: number[] = [];
    for (const k of this.tree.leaves()) {
      const m = this.metricsOf(k);
      if (m) outs.push(m.outcome);
    }
    if (!outs.length) return;
    const t = tallyOutcomes(outs);
    const order = [...t.counts.keys()].filter((o) => t.counts[o] > 0).sort((a, b) => t.counts[b] - t.counts[a]);
    const rows = order
      .map(
        (o) =>
          `<div class="row" title="${OUTCOME_DESCRIPTION[o]}"><span class="c">${Math.round(t.shares[o] * 100)}%</span><span class="arrow">→</span><span class="l" style="color:${cssColor(OUTCOME_COLOR[o])}">${OUTCOME_LABEL[o]}</span></div>`,
      )
      .join('');
    this.ui.summary(
      `<h2>From the same image, <em>${thousands(t.total)}</em> minds</h2>${rows}<div class="foot">Each is a full simulation, judged live,<br/><span class="mono">${signedSecs(this.sinceChange())}</span> after the change.<br/>Hover a mind to look closer; click to enter it.</div>`,
    );
  }

  // =========================================================================
  // Level of detail & moods
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
    const always = this.phase === 'observe' || this.phase === 'freeze' || this.phase === 'touch' || this.phase === 'confirm' || this.phase === 'two';
    for (const [key, r] of cand) {
      if (high >= 40) break;
      if (r >= 42 || always) {
        next[key] = LOD_HIGH;
        high++;
      }
    }
    if (this.focus >= 0 && this.focus < LOD_SIZE) next[this.focus] = LOD_HIGH;
    for (let i = 0; i < LOD_SIZE; i++) {
      if (next[i] !== this.lod[i]) {
        this.lod = next;
        this.lodDirty = true;
        break;
      }
    }
  }

  private updateMoods(dt: number): void {
    const simDt = this.scale > 0 ? dt * Math.min(2.5, Math.max(0.15, this.scale)) : 0;
    const gen = this.src().generation;
    const newFrames = gen !== this.lastGen;
    this.lastGen = gen;
    for (const key of this.tiles.keys()) {
      const m = this.metricsOf(key);
      if (!m) continue;
      let f = this.moods.get(key);
      if (!f) this.moods.set(key, (f = new MoodFollower()));
      f.update(m.outcome !== UNKNOWN ? m.outcome : m.dominant, m.commitment, m.outcome, simDt || dt * 0.05);
      // State-space trails for the minds being compared.
      if (newFrames && this.compass.ta > 0 && this.isCompared(key)) {
        let tr = this.trails.get(key);
        if (!tr) this.trails.set(key, (tr = { pts: new Float32Array(TRAIL_LEN * 2), n: 0, head: 0, sx: 0, sy: 0 }));
        // Quiet minds sit near the centre; the path is smoothed so it reads as a trajectory, not jitter.
        const p = landscapeTarget(m.rates, m.commitment);
        let sum = 0;
        for (let a = 0; a < N_ASSEMBLIES; a++) sum += m.rates[a];
        const w = Math.min(1, sum / 40);
        tr.sx += (p[0] * w - tr.sx) * 0.12;
        tr.sy += (p[1] * w - tr.sy) * 0.12;
        tr.pts[tr.head * 2] = tr.sx;
        tr.pts[tr.head * 2 + 1] = tr.sy;
        tr.head = (tr.head + 1) % TRAIL_LEN;
        tr.n = Math.min(TRAIL_LEN, tr.n + 1);
      }
    }
  }

  private isCompared(key: number): boolean {
    if (this.replay) return key === this.replay.x || key === this.replay.y;
    return this.phase === 'two' && (key === 2 || key === 3);
  }

  // =========================================================================
  // Drawing inputs
  // =========================================================================

  private buildTiles(): TileInput[] {
    const out: TileInput[] = [];
    const later: TileInput[] = [];
    const step = this.stepNow();
    const level = stimulusLevel(this.phase === 'origin' ? this.origin?.step ?? step : step);
    const [, H] = this.viewSize();
    for (const [key] of this.tiles) {
      const t = this.tileNow(key)!;
      if (t.a <= 0.002) continue;
      const f = this.frameFor(key);
      const mood = this.moods.get(key);
      const dom = mood ? mood.dominant : -1;
      const c = mood ? mood.commitment : 0;
      const m = f ? decodeMetrics(f.metrics, 0) : null;
      let dim = 0;
      const bystander = !!this.replay && key !== this.replay.x && key !== this.replay.y;
      if (bystander) dim = 0.85;
      if (this.focus >= 0 && key !== this.focus && key !== this.compareWith) dim = 0.45;
      if (this.phase === 'origin' && key === ORIGIN_KEY) dim = Math.min(0.82, Math.max(0, (this.now - this.originShown) / 1000 - 1) * 0.4);
      const tintAmt = this.layoutMode === 'tree' && this.phase === 'many' ? 0.9 * c + 0.3 : 0.85 * c;
      const rPx = (t.r * this.camera.zoom) / this.dpr;
      // Pink is strongest while the change is young; later influence is a haze (still only where minds differ).
      let pinkGain = 0;
      let linkGain = 1;
      if (f?.paired && m?.pair) {
        const since = this.replay ? (this.stepNow() - this.replay.result.splitStep) / STEPS_PER_SECOND : this.sinceChange();
        pinkGain = 0.42 + 0.58 * Math.exp(-Math.max(0, since - 0.25) / 0.9);
        linkGain = Math.max(0, Math.min(1, 1 - (m.pair.mismatched - 30) / 220));
      }
      const tile: TileInput = {
        key,
        x: t.x,
        y: t.y,
        r: t.r,
        alpha: bystander && this.replay!.staged ? t.a * 0.18 : t.a,
        frame: f,
        units: !bystander,
        hover: key === this.hover ? 1 : 0,
        select: !this.replay && (key === this.focus || key === this.compareWith) ? 1 : 0,
        tint: dom >= 0 && m ? OUTCOME_COLOR[dom] : OUTCOME_COLOR[UNKNOWN],
        tintAmt,
        dim,
        commitment: c,
        dominant: dom,
        mood: dom >= 0 ? moodFor(dom, c) : NO_MOOD,
        pinkGain,
        linkGain,
        stimulus: level,
        filaments: !bystander && rPx > H * 0.14 / this.dpr && f !== null && f.n === N_NEURONS,
      };
      if (this.replay && (key === this.replay.x || key === this.replay.y)) later.push(tile);
      else out.push(tile);
    }
    return out.concat(later);
  }

  private compassAnchorLabel(k: number): string {
    return OUTCOME_LABEL[k];
  }

  private buildShapes(): void {
    const under = this.under;
    const over = this.over;
    under.clear();
    over.clear();
    const z = this.camera.zoom;
    const tnow = this.now / 1000;

    // The family tree, as faint luminous lines between siblings.
    if (this.tree && this.treeAlpha > 0.01 && this.tree.depth >= 2) {
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
          const al = this.treeAlpha * (0.13 + 0.12 * (1 - d / Math.max(1, D))) * Math.min(1, lenPx / 40);
          if (lit) under.line(a[0], a[1], b[0], b[1], 1.4, 1.0, 0.9, 0.8, Math.min(1, al * 4 + 0.25), 3);
          else under.line(a[0], a[1], b[0], b[1], 1, 0.7, 0.68, 0.66, al, 0);
        }
      }
      for (let d = 0; d < D; d++) {
        for (let k = 1 << d; k < 1 << (d + 1); k++) {
          const p = pos.get(k);
          if (!p) continue;
          const lit = hoverPath.has(k);
          const span = offsetFor(d + 1, D) * z;
          if (!lit && span < 30) continue;
          under.disc(p[0], p[1], (lit ? 3 : 2) / z, 0.9, 0.88, 0.85, this.treeAlpha * (lit ? 0.9 : 0.3), lit ? 3 : 1.5);
        }
      }
    }

    // The compass: the space of interpretations, and where the two minds are heading.
    if (this.compass.a > 0.01) {
      const C = this.compass;
      const a = C.a;
      under.ring(C.x, C.y, C.r, 1, 0.75, 0.73, 0.7, 0.12 * a, 0);
      for (let k = 0; k < N_ASSEMBLIES; k++) {
        const ax = C.x + ANCHORS[k][0] * C.r;
        const ay = C.y + ANCHORS[k][1] * C.r;
        const col = OUTCOME_COLOR[k];
        under.disc(ax, ay, 2.2 / z, col[0], col[1], col[2], 0.5 * a, 3);
        under.line(C.x + ANCHORS[k][0] * C.r * 0.9, C.y + ANCHORS[k][1] * C.r * 0.9, ax, ay, 1, col[0], col[1], col[2], 0.15 * a, 0);
      }
      under.disc(C.x, C.y, 1.6 / z, 0.7, 0.7, 0.7, 0.35 * a, 2);
      for (const [key, tr] of this.trails) {
        if (tr.n < 2) continue;
        const pinkish = this.replay ? key === this.replay.altered : key === 3;
        const col: [number, number, number] = pinkish ? [1.0, 0.45, 0.68] : [1.0, 0.94, 0.86];
        let px = 0;
        let py = 0;
        for (let i = 0; i < tr.n; i++) {
          const idx = (tr.head - tr.n + i + TRAIL_LEN) % TRAIL_LEN;
          const x = C.x + tr.pts[idx * 2] * C.r;
          const y = C.y + tr.pts[idx * 2 + 1] * C.r;
          if (i > 0) {
            const u = i / tr.n;
            under.line(px, py, x, y, 1.3, col[0], col[1], col[2], a * (0.08 + 0.6 * u * u), 1.2);
          }
          px = x;
          py = y;
        }
        under.disc(px, py, 2.4 / z, col[0], col[1], col[2], a, 5);
      }
    }

    // The stimulus at the heart of each large mind, re-read by its interpretation.
    const neuralTime = this.stepNow() / STEPS_PER_SECOND;
    for (const [key] of this.tiles) {
      const t = this.tileNow(key);
      if (!t || t.a < 0.02) continue;
      const rPx = t.r * z;
      if (rPx < 70) continue;
      const f = this.frameFor(key);
      const mood = this.moods.get(key);
      channelActivity(f && f.n === N_NEURONS ? f.units : null, this.chan, UNIT_STRIDE);
      const step = this.phase === 'origin' ? (this.origin?.step ?? this.stepNow()) : this.stepNow();
      let alpha = t.a;
      if (this.replay && key !== this.replay.x && key !== this.replay.y) continue;
      if (this.phase === 'origin') alpha *= Math.max(0.12, 1 - Math.max(0, (this.now - this.originShown) / 1000 - 1) * 0.45);
      drawStimulus(over, {
        x: t.x,
        y: t.y,
        r: t.r,
        alpha,
        level: stimulusLevel(step),
        dominant: mood ? mood.dominant : -1,
        commitment: mood ? mood.commitment : 0,
        time: this.phase === 'origin' ? (this.origin?.step ?? 0) / STEPS_PER_SECOND : neuralTime,
        channel: this.chan,
        zoom: z,
      });
    }

    // Act 2: the spike that is about to happen, and when it will happen instead.
    if ((this.phase === 'touch' || this.phase === 'freeze' || this.phase === 'confirm') && this.tiles.has(1) && this.target && this.peek) {
      const t = this.tileNow(1)!;
      const u = this.target.unit;
      const cx = t.x + this.net.x[u] * t.r;
      const cy = t.y + this.net.y[u] * t.r;
      const pulse = 0.55 + 0.45 * Math.sin(this.now / 380);
      const fade = this.phase === 'confirm' ? Math.max(0, 1 - this.t) : Math.min(1, this.t / 1.2);
      over.ring(cx, cy, 0.03 * t.r, 1.3, 1, 0.93, 0.84, 0.55 * pulse * fade, 4);
      over.ring(cx, cy, (0.03 + 0.03 * ((this.now / 1500) % 1)) * t.r, 1, 1, 0.93, 0.84, 0.25 * (1 - ((this.now / 1500) % 1)) * fade, 0);
      // A tiny timeline: now · when it would fire · when it will fire.
      const L = 0.16 * t.r;
      const y0 = cy + 0.06 * t.r;
      const x0 = cx - L * 0.5;
      const msW = L / 16;
      const wait = this.target.at - this.peek.step;
      over.line(x0, y0, x0 + L, y0, 1, 0.8, 0.78, 0.75, 0.35 * fade, 0);
      over.line(x0, y0 - 0.006 * t.r, x0, y0 + 0.006 * t.r, 1, 0.8, 0.78, 0.75, 0.5 * fade, 0);
      const wx = x0 + wait * msW;
      over.line(wx, y0 - 0.012 * t.r, wx, y0 + 0.012 * t.r, 1.4, 1, 0.94, 0.86, 0.75 * fade, 1);
      const px2 = wx + this.delayMs * msW;
      over.line(wx, y0, px2, y0, 1.4, PINK[0], PINK[1], PINK[2], 0.85 * fade, 2);
      over.disc(px2, y0, 0.0055 * t.r, PINK[0], PINK[1], PINK[2], 0.95 * fade, 6);
    }

    // Forks: each new change is a tiny pink spark in the mind that received it.
    if (this.sparks.length) {
      const keep: typeof this.sparks = [];
      for (const s of this.sparks) {
        const age = (this.now - s.at) / 1000;
        if (age > 2.2) continue;
        keep.push(s);
        const t = this.tileNow(s.key);
        if (!t || t.r * z < 8) continue;
        const a = Math.max(0, 1 - age / 2.2);
        const x = t.x + this.net.x[s.unit] * t.r;
        const y = t.y + this.net.y[s.unit] * t.r;
        over.disc(x, y, 0.02 * t.r, PINK[0], PINK[1], PINK[2], a * 0.9, 4);
        over.ring(x, y, (0.03 + 0.25 * age) * t.r, 1, PINK[0], PINK[1], PINK[2], a * 0.4, 0);
      }
      this.sparks = keep;
    }

    // The ending: one hot pink event in a dimmed mind.
    if (this.phase === 'origin' && this.userIv) {
      const t = this.tileNow(ORIGIN_KEY);
      if (t) {
        const u = this.userIv.neuron;
        const a = Math.min(1, Math.max(0, (this.now - this.originShown) / 1000 - 1.2) / 1.5);
        const x = t.x + this.net.x[u] * t.r;
        const y = t.y + this.net.y[u] * t.r;
        const pulse = 0.75 + 0.25 * Math.sin(tnow * 2.2);
        over.disc(x, y, 0.009 * t.r, PINK[0], PINK[1], PINK[2], a, 10 * pulse);
        over.ring(x, y, 0.022 * t.r, 1.2, PINK[0], PINK[1], PINK[2], 0.6 * a * pulse, 4);
        // Its spike, leaving along its fibres: the one thing still moving.
        const net = this.net;
        const travel = ((this.now - this.originShown) / 1000 - 4) / 3;
        for (let k = net.outStart[u]; k < net.outStart[u + 1]; k++) {
          const j = net.outTarget[k];
          const jx = t.x + net.x[j] * t.r;
          const jy = t.y + net.y[j] * t.r;
          over.line(x, y, jx, jy, 0.8, PINK[0], PINK[1], PINK[2], 0.03 * a, 0);
          if (travel > 0 && travel < 1.4) {
            const p = Math.min(1, travel);
            const q = Math.max(0, p - 0.3);
            over.line(x + (jx - x) * q, y + (jy - y) * q, x + (jx - x) * p, y + (jy - y) * p, 1.2, PINK[0], PINK[1], PINK[2], 0.45 * a * (1.4 - travel), 2);
          }
        }
      }
    }

    // When did these minds diverge: the unit whose spike moved, in both minds.
    const r = this.replay;
    if (r && this.source === 'analyst' && r.result.unit >= 0) {
      const strength = r.stage === 'approach' ? 0.5 : r.stage === 'moment' ? 1 : r.stage === 'cascade' ? 0.45 : 0.2;
      for (const key of [r.x, r.y]) {
        const t = this.tileNow(key);
        if (!t) continue;
        const u = r.result.unit;
        const x = t.x + this.net.x[u] * t.r;
        const y = t.y + this.net.y[u] * t.r;
        const isAlt = key === r.altered;
        const col = isAlt ? PINK : ([1, 0.94, 0.86] as [number, number, number]);
        over.ring(x, y, 0.03 * t.r, 1.3, col[0], col[1], col[2], 0.8 * strength, 3);
        if (r.stage === 'moment') {
          const k = Math.min(1, (this.now - r.stageAt) / 2400);
          over.ring(x, y, (0.03 + 0.4 * easeOut(k)) * t.r, 1.1, col[0], col[1], col[2], 0.6 * (1 - k), 0);
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
    const showNames = this.phase === 'two' || this.phase === 'firstdiff' || this.phase === 'cascade' || this.phase === 'many';
    if (this.tree && showNames && this.focus < 0) {
      const keys = this.replay ? [this.replay.x, this.replay.y] : this.tree.leaves();
      for (const k of keys) {
        const t = this.tileNow(k);
        if (!t || t.a < 0.05) continue;
        const rCss = (t.r * z) / this.dpr;
        const minR = this.tree.depth >= 3 && !this.replay ? 95 : 46;
        if (rCss < minR) continue;
        const [cx, cy] = toCss(t.x, t.y + t.r);
        if (cy < -40 || cy > H / this.dpr + 40 || cx < -100 || cx > W / this.dpr + 100) continue;
        let sub: string | undefined;
        if (this.tree.depth === 1) sub = k === 2 ? 'as it was' : this.userIv ? describeIntervention(this.userIv) : '';
        else {
          const node = this.tree.nodes.get(k);
          sub = rCss > 90 && node ? describeIntervention(node.iv, this.seed) : undefined;
        }
        specs.push({
          id: `w${k}`,
          x: cx,
          y: cy + 14,
          name: this.tree.depth === 1 ? this.mindName(k) : `Mind ${BranchTree.label(k)}`,
          sub,
          alpha: Math.min(1, (rCss - minR) / 30) * t.a * (this.phase === 'cascade' ? 0.6 : 1),
          small: rCss < 110,
        });
        // The interpretation, as it emerges.
        const mood = this.moods.get(k);
        if (mood && mood.dominant >= 0 && mood.commitment > 0.15 && (this.phase === 'two' || this.replay)) {
          const [ix, iy] = toCss(t.x, t.y - t.r);
          markers.push({
            id: `i${k}`,
            x: ix,
            y: iy - 24,
            html: `<span style="color:${cssColor(OUTCOME_COLOR[mood.dominant])}">${OUTCOME_LABEL[mood.dominant]}</span>`,
            alpha: Math.min(1, (mood.commitment - 0.15) * 2),
            cls: 'interp',
          });
        }
      }
    }
    // Compass anchors.
    if (this.compass.a > 0.2 && (this.compass.r * z) / this.dpr > 55) {
      for (let k = 0; k < N_ASSEMBLIES; k++) {
        const [cx, cy] = toCss(this.compass.x + ANCHORS[k][0] * this.compass.r * 1.28, this.compass.y + ANCHORS[k][1] * this.compass.r * 1.2);
        markers.push({ id: `a${k}`, x: cx, y: cy, html: this.compassAnchorLabel(k), alpha: this.compass.a * 0.55, cls: 'anchor' });
      }
    }
    // Hover path: the change that gave birth to each ancestor.
    if (this.tree && this.hover >= 0 && this.focus < 0 && this.layoutMode === 'tree' && this.phase === 'many') {
      const D = this.tree.depth;
      for (let k = this.hover; k > 1; k = parentOf(k)) {
        const node = this.tree.nodes.get(k);
        if (!node || !node.iv) continue;
        const mine = this.descendants(k).map((x) => this.tiles.get(x)).filter(Boolean);
        const sibT = this.descendants(siblingOf(k)).map((x) => this.tiles.get(x)).filter(Boolean);
        if (!sibT.length || !mine.length) continue;
        const mx = mine.reduce((a, b) => a + b!.tx, 0) / mine.length;
        const my = mine.reduce((a, b) => a + b!.ty, 0) / mine.length;
        const lenPx = (Math.hypot(mx - sibT.reduce((a, b) => a + b!.tx, 0) / sibT.length, my - sibT.reduce((a, b) => a + b!.ty, 0) / sibT.length) * z) / this.dpr;
        if (lenPx < 60 || depthOf(k) === D) continue;
        const [cx, cy] = toCss(mx, my);
        markers.push({ id: `h${k}`, x: cx, y: cy, html: `${BranchTree.label(k)} · ${describeIntervention(node.iv, this.seed)}`, alpha: 0.9 });
      }
    }
    // Landscape labels: each interpretation, and how many minds it holds.
    if (this.layoutMode === 'landscape' && this.phase === 'many' && this.tree) {
      const total = this.tree.leafCount;
      for (const g of this.clusterLabels) {
        // Just outside the cluster, in the direction of its anchor, a fixed distance on screen.
        const off = g.r + (46 * this.dpr) / z;
        const [cx, cy] = toCss(g.x + g.dx * off, g.y + g.dy * off * 0.85);
        markers.push({
          id: `c${g.o}`,
          x: cx,
          y: cy,
          html: `<div class="n" style="color:${cssColor(OUTCOME_COLOR[g.o])}">${OUTCOME_LABEL[g.o]}</div><div class="c">${Math.round((g.n / total) * 100)}% · ${thousands(g.n)}</div>`,
          alpha: this.focus >= 0 ? 0.3 : 1,
          cls: 'cluster-label',
        });
      }
      // Your two minds, among all of them.
      const D = this.tree.depth;
      for (const [k, name] of [
        [1 << D, 'ORIGINAL'],
        [3 << (D - 1), 'ALTERED'],
      ] as const) {
        const t = this.tileNow(k);
        if (!t || this.focus >= 0) continue;
        const [cx, cy] = toCss(t.x, t.y - t.r);
        markers.push({ id: `y${k}`, x: cx, y: cy - 12, html: name, alpha: 0.85, cls: k === 1 << D ? 'mine' : 'mine pink' });
      }
    }
    // Act 2: the timing control beneath the spike.
    if (this.phase === 'touch' && this.target && this.tiles.has(1)) {
      const t = this.tileNow(1)!;
      const u = this.target.unit;
      const [cx, cy] = toCss(t.x + this.net.x[u] * t.r, t.y + (this.net.y[u] + 0.06) * t.r);
      this.ui.timing({ x: cx, y: cy + 26, value: this.delayMs }, (v) => (this.delayMs = v), () => void this.confirmChange());
      const [lx, ly] = toCss(t.x + (this.net.x[u] - 0.08) * t.r, t.y + (this.net.y[u] + 0.06) * t.r);
      markers.push({ id: 'now', x: lx, y: ly - 14, html: 'now', alpha: 0.6 });
    }
    if (this.phase === 'origin' && this.userIv) {
      const t = this.tileNow(ORIGIN_KEY);
      const a = Math.min(1, Math.max(0, (this.now - this.originShown) / 1000 - 5.5) / 2);
      if (t && a > 0) {
        const u = this.userIv.neuron;
        const [cx, cy] = toCss(t.x + this.net.x[u] * t.r, t.y + this.net.y[u] * t.r);
        markers.push({ id: 'origin', x: cx, y: cy - 46, html: `${this.userIv.ms} ms`, alpha: a, cls: 'marker pinkmark' });
      }
    }
    this.ui.labels(specs);
    this.ui.markers(markers);
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

  // =========================================================================
  // Sound
  // =========================================================================

  private voiceFor(keys: number[], pan: number, level: number): VoiceState | null {
    const shares = new Array(N_ASSEMBLIES).fill(0);
    let n = 0;
    let activity = 0;
    let inhibition = 0;
    let stability = 0;
    let pink = 0;
    let density = 0;
    for (const k of keys) {
      const m = this.metricsOf(k);
      if (!m) continue;
      n++;
      let sum = 0;
      for (let a = 0; a < N_ASSEMBLIES; a++) sum += m.rates[a];
      for (let a = 0; a < N_ASSEMBLIES; a++) shares[a] += sum > 1e-6 ? m.rates[a] / sum : 0;
      activity += Math.min(1.5, sum / 60);
      inhibition += m.inhRate;
      stability += m.outcome !== UNKNOWN ? m.commitment : 0;
      pink += m.pair ? Math.min(1, m.pair.mismatched / (N_NEURONS * 0.6)) : 0;
      density += m.lastSpikes;
    }
    if (n === 0) return null;
    return {
      pan,
      shares: shares.map((s) => s / n),
      activity: activity / n,
      inhibition: inhibition / n,
      stability: stability / n,
      pink: pink / n,
      density: density / n,
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
    if (this.phase === 'origin') states[0] = this.voiceFor([ORIGIN_KEY], 0, 0.3);
    else if (this.phase === 'return') states[0] = this.voiceFor(visible.map((v) => v[0]), 0, 0.5);
    else if (visible.length <= 1) states[0] = this.voiceFor(visible.map((v) => v[0]), visible[0]?.[1] ?? 0, 1);
    else {
      const left = visible.filter((v) => v[1] < 0).map((v) => v[0]);
      const right = visible.filter((v) => v[1] >= 0).map((v) => v[0]);
      const level = visible.length > 64 ? 0.7 : 0.9;
      states[0] = this.voiceFor(left, -0.75, level);
      states[1] = this.voiceFor(right, 0.75, level);
    }
    if (this.scale > 0) {
      const stride = Math.max(1, Math.floor(visible.length / 24));
      const net = this.net;
      for (let v = 0; v < visible.length; v += stride) {
        const [key, pan] = visible[v];
        const f = this.frameFor(key);
        if (!f || this.heard.has(f)) continue;
        this.heard.add(f);
        const gain = visible.length > 64 ? 0.45 : 1;
        for (let k = 0; k < f.nEvents; k++) {
          const type = f.events[k * 3];
          const a = f.events[k * 3 + 2];
          if (type === EV_SETTLE) events.push({ type: 'settle', voice: a, pan, gain });
          else if (type === EV_RELEASE) events.push({ type: 'release', voice: 0, pan, gain });
        }
        // A few of the spikes that just happened: tiny transients, pink ones in a glassier timbre.
        if (f.n === N_NEURONS) {
          let picked = 0;
          for (let i = (f.step * 7) % 13; i < N_NEURONS && picked < 2; i += 13) {
            const since = f.units[i * UNIT_STRIDE + 2];
            if (since >= 0 && since < 2) {
              const pinkU = f.units[i * UNIT_STRIDE + 3] > 0.4 && f.paired;
              const voice = net.type[i] === TYPE_EXC ? net.group[i] : net.type[i] === TYPE_INH ? N_ASSEMBLIES : N_ASSEMBLIES + 1;
              events.push({ type: pinkU ? 'pinkspike' : 'spike', voice, pan, gain: gain * 0.7 });
              picked++;
            }
          }
        }
      }
    }
    this.sound.update(states, events, this.scale);
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
    const m3 = this.metricsOf(this.tree && this.tree.depth === 1 ? 3 : 1);
    this.ui.debug(
      [
        `fps        ${this.fps.toFixed(0)}`,
        `phase      ${this.phase}${this.replay ? ` (${this.replay.stage})` : ''}`,
        `seed       ${this.seed}`,
        `step       ${src.step}  (dt 1 ms, ${PLAY} ms/s ×${this.scale.toFixed(2)}${this.stopAt !== null ? `, stop ${this.stopAt}` : ''})`,
        `source     ${this.source}`,
        `minds      ${this.pool.mindCount} in ${this.pool.size} workers`,
        `drawn      ${st.tiles} minds · ${st.units} units · ${st.shapes} shapes`,
        `advance    ${src.lastAdvanceMs.toFixed(1)} ms`,
        `tree       depth ${this.tree?.depth ?? 0} · ${this.tree?.nodes.size ?? 0} nodes`,
        `network    ${N_NEURONS} units · ${this.net.synapses} synapses`,
        m3 ? `rates      ${m3.rates.map((r) => r.toFixed(0)).join(' ')}  I ${m3.inhRate.toFixed(0)}` : '',
        m3 ? `outcome    ${OUTCOME_LABEL[m3.outcome]}  commit ${m3.commitment.toFixed(2)}` : '',
        m3?.pair ? `pair       ${pct(m3.pair.divergence)} · ${m3.pair.mismatched} changed · gen ${m3.pair.generation}` : '',
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
    if (this.phase === 'title' || this.phase === 'observe' || this.phase === 'freeze') this.camera.set(this.frameWorlds([1], 0.4));
    else if (this.phase === 'touch') this.leanIn();
    else if (this.phase === 'two') this.camera.set(this.twoView());
    else if (this.phase === 'many' && this.tree && this.focus < 0) {
      if (this.layoutMode === 'landscape') this.camera.set(this.landscapeView());
      else {
        const b = treeBounds(this.tree.depth);
        this.camera.set(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY));
      }
    } else if (this.phase === 'shared' && this.sharedKey > 0) this.camera.set(this.frameWorlds([this.sharedKey], 0.4));
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

  /** The unit of mind 1 nearest a screen point, within `radiusCss`. */
  private unitAt(sx: number, sy: number, radiusCss: number): number {
    const t = this.tileNow(1);
    if (!t) return -1;
    const [px0, py0] = this.camera.toPlane(sx, sy);
    const lim = (radiusCss * this.dpr) / this.camera.zoom;
    let best = -1;
    let bd = lim * lim;
    for (let i = 0; i < N_NEURONS; i++) {
      const dx = t.x + this.net.x[i] * t.r - px0;
      const dy = t.y + this.net.y[i] * t.r - py0;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = i;
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
      this.pointer = { x: e.clientX, y: e.clientY, down: true, id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: 0, t: this.now };
      c.setPointerCapture(e.pointerId);
      if (this.phase === 'title') return;
      this.dragPrev = { x: e.clientX, y: e.clientY, t: this.now, vx: 0, vy: 0 };
    });
    c.addEventListener('pointermove', (e) => {
      const [sx, sy] = local(e);
      const p = this.pointer;
      if (p.down && this.dragPrev && this.canNavigate()) {
        const dx = e.clientX - this.dragPrev.x;
        const dy = e.clientY - this.dragPrev.y;
        p.moved += Math.abs(dx) + Math.abs(dy);
        if (p.moved > 4) {
          this.userMoved = true;
          this.camera.panByPx(dx * this.dpr, dy * this.dpr);
          const dtm = Math.max(1, this.now - this.dragPrev.t) / 1000;
          this.dragPrev = { x: e.clientX, y: e.clientY, t: this.now, vx: (dx * this.dpr) / dtm, vy: (dy * this.dpr) / dtm };
        }
        return;
      }
      if (this.phase === 'touch') {
        const i = this.unitAt(sx, sy, 14);
        c.classList.toggle('pointer', i >= 0 && !!this.peek && this.peek.next[i] >= 0);
      }
      if (this.canNavigate()) {
        const k = this.tileAt(sx, sy);
        this.hover = this.tree && k >= 0 && k !== 1 ? k : -1;
        c.classList.toggle('pointer', this.hover >= 0);
        this.updateCard(e.clientX, e.clientY);
      }
    });
    const up = (e: PointerEvent) => {
      const p = this.pointer;
      if (!p.down) return;
      p.down = false;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      const [sx, sy] = local(e);
      if (this.phase === 'touch' && p.moved < 6) {
        const i = this.unitAt(sx, sy, 14);
        if (i >= 0) this.selectUnit(i);
      }
      if (this.canNavigate()) {
        if (p.moved > 6 && this.dragPrev) {
          if (this.now - this.dragPrev.t < 80) this.camera.fling(this.dragPrev.vx, this.dragPrev.vy);
        } else {
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
        this.userMoved = true;
        const [sx, sy] = local(e);
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
        const [, H] = this.viewSize();
        this.camera.zoomAt(factor, sx, sy, H * 0.006, H * 3);
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  private canNavigate(): boolean {
    return this.phase === 'many' && !this.busyAction;
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
      `settled    ${m.outcome !== UNKNOWN ? `${m.settledFor.toFixed(2)} s` : 'not yet'}`,
      `held by    ${(m.commitment * 100).toFixed(0)}%`,
      `rates      ${m.rates.map((r) => r.toFixed(0)).join(' ')} Hz`,
      `changes    ${this.tree.changes(k)} from the original`,
    ];
    if (node) lines.push(`at its fork ${describeIntervention(node.iv, this.seed)}`);
    this.ui.card(
      `<div class="n">Mind ${BranchTree.label(k)}</div><div class="o" style="color:${cssColor(OUTCOME_COLOR[m.outcome])}">${OUTCOME_LABEL[m.outcome]}</div><div class="k">${lines.join('\n')}</div>`,
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
    if (tag === 'INPUT') {
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
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
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.delayMs = Math.max(1, Math.min(10, this.delayMs + (e.key === 'ArrowRight' ? 1 : -1)));
        this.ui.announce(`Delay ${this.delayMs} milliseconds`);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.confirmChange();
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
      else if (e.key === '+' || e.key === '=') this.camera.zoomAt(1.25, 0, 0, H * 0.006, H * 3);
      else if (e.key === '-' || e.key === '_') this.camera.zoomAt(0.8, 0, 0, H * 0.006, H * 3);
      else if (e.key === 'Escape' || e.key === 'u' || e.key === 'U') {
        if (this.focus >= 0) this.unfocus();
        else if (this.layoutMode === 'landscape') this.flyTo(this.landscapeView(), this.dur(1200));
        else if (this.tree) {
          const b = treeBounds(this.tree.depth);
          this.flyTo(this.frameBounds(b.minX, b.maxX, b.minY, b.maxY), this.dur(1200));
        }
      }
      if (e.key.startsWith('Arrow') || e.key === '+' || e.key === '-') this.userMoved = true;
    }
    if (e.key === 'Escape' && this.replay && this.replay.stage !== 'rewind') void this.endReplay();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A network from the curated list of ones that are undecided about the image (src/sim/seeds.ts). */
export function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return UNDECIDED_SEEDS[a[0] % UNDECIDED_SEEDS.length];
}
