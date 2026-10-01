import { AGENT_STRIDE, LOW_FIELD, REMNANT_STRIDE, type WorldFrame } from '../engine/packet';
import { FIELD_N, WORLD_RADIUS } from '../sim/constants';
import type { View } from './camera';
import { DynBuffer, disposeTarget, ensureF32, program, target, texture, type GL, type Program, type Target } from './gl';
import * as S from './shaders';
import { ShapeBatch, hslToRgb } from './shapes';

export interface TileInput {
  key: number;
  x: number;
  y: number;
  r: number;
  alpha: number;
  frame: WorldFrame | null;
  hover: number;
  select: number;
  tint: [number, number, number];
  tintAmt: number;
  dim: number;
  sun: [number, number];
  /** Per-agent divergence (0–1), drawn as halos. */
  halo?: Float32Array | null;
  /** Display-only displacement of one organism (while it is being moved). */
  override?: { index: number; dx: number; dy: number } | null;
  /** Whether to draw this world's structures. */
  structures?: boolean;
}

export interface PostParams {
  fade: number;
  sat: number;
  bloom: number;
  exposure: number;
  grain: number;
}

export interface SceneInput {
  tiles: TileInput[];
  view: View;
  /** Fraction of a step to extrapolate positions by (smooth slow motion). */
  alpha: number;
  /** Simulation steps that elapsed since the previous frame (drives trail decay). */
  stepsAdvanced: number;
  time: number;
  under: ShapeBatch;
  over: ShapeBatch;
  post: PostParams;
}

const MAX_TILES = 2048;
const LOW_COLS = 64;
const LOW_ROWS = 32;
const HIGH_COLS = 8;
const HIGH_ROWS = 8;

/**
 * The renderer is stateless with respect to the experience: give it tiles,
 * frames and a camera, and it draws. One WebGL2 context, instanced
 * everything, a screen-space trail buffer reprojected through camera motion,
 * and a soft bloom.
 */
export class Renderer {
  readonly gl: GL;
  readonly hdr: boolean;
  private width = 1;
  private height = 1;

  private pBg: Program;
  private pTile: Program;
  private pAgent: Program;
  private pTrailDot: Program;
  private pTrailFade: Program;
  private pCopy: Program;
  private pShape: Program;
  private pDown: Program;
  private pBlur: Program;
  private pComposite: Program;

  private quad: WebGLBuffer;
  private vaoTile: WebGLVertexArrayObject;
  private vaoAgent: WebGLVertexArrayObject;
  private vaoShape: WebGLVertexArrayObject;
  private vaoEmpty: WebGLVertexArrayObject;
  private tileIdxBuf: DynBuffer;
  private instBuf: DynBuffer;
  private instTileBuf: DynBuffer;
  private instHaloBuf: DynBuffer;
  private shapeBuf: DynBuffer;

  private tileTex: WebGLTexture;
  private tileData = new Float32Array(MAX_TILES * 4 * 4);
  private lowTex: WebGLTexture;
  private lowData = new Uint8Array(LOW_COLS * LOW_FIELD * LOW_ROWS * LOW_FIELD * 2);
  private highTex: WebGLTexture;
  private highSlots = new Map<number, { slot: number; frame: WorldFrame | null; used: number }>();
  private frameNo = 0;

  private scene: Target | null = null;
  private trailA: Target | null = null;
  private trailB: Target | null = null;
  private bloomA: Target | null = null;
  private bloomA2: Target | null = null;
  private bloomB: Target | null = null;
  private bloomB2: Target | null = null;

  private inst: Float32Array<ArrayBuffer> = new Float32Array(8192);
  private instTile: Float32Array<ArrayBuffer> = new Float32Array(1024);
  private instHalo: Float32Array<ArrayBuffer> = new Float32Array(1024);
  private tileIdx = new Float32Array(MAX_TILES);
  private prevView: View | null = null;
  readonly structures = new ShapeBatch();

  stats = { tiles: 0, agents: 0, shapes: 0 };

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_float_linear');

    this.pBg = program(gl, S.FULLSCREEN_VS, S.BACKGROUND_FS, 'background');
    this.pTile = program(gl, S.TILE_VS, S.TILE_FS, 'tile');
    this.pAgent = program(gl, S.AGENT_VS, S.AGENT_FS, 'agent');
    this.pTrailDot = program(gl, S.TRAIL_DOT_VS, S.TRAIL_DOT_FS, 'trailDot');
    this.pTrailFade = program(gl, S.FULLSCREEN_VS, S.TRAIL_FADE_FS, 'trailFade');
    this.pCopy = program(gl, S.FULLSCREEN_VS, S.COPY_FS, 'copy');
    this.pShape = program(gl, S.SHAPE_VS, S.SHAPE_FS, 'shape');
    this.pDown = program(gl, S.FULLSCREEN_VS, S.DOWNSAMPLE_FS, 'down');
    this.pBlur = program(gl, S.FULLSCREEN_VS, S.BLUR_FS, 'blur');
    this.pComposite = program(gl, S.FULLSCREEN_VS, S.COMPOSITE_FS, 'composite');

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.tileIdxBuf = new DynBuffer(gl);
    this.instBuf = new DynBuffer(gl);
    this.instTileBuf = new DynBuffer(gl);
    this.instHaloBuf = new DynBuffer(gl);
    this.shapeBuf = new DynBuffer(gl);

    this.vaoEmpty = gl.createVertexArray()!;

    this.vaoTile = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoTile);
    this.bindQuad();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tileIdxBuf.buf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 4, 0);
    gl.vertexAttribDivisor(1, 1);

    this.vaoAgent = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoAgent);
    this.bindQuad();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf.buf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, AGENT_STRIDE * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, AGENT_STRIDE * 4, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instTileBuf.buf);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 4, 0);
    gl.vertexAttribDivisor(3, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instHaloBuf.buf);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 4, 0);
    gl.vertexAttribDivisor(4, 1);

    this.vaoShape = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoShape);
    this.bindQuad();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shapeBuf.buf);
    for (let k = 0; k < 3; k++) {
      gl.enableVertexAttribArray(1 + k);
      gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, 48, k * 16);
      gl.vertexAttribDivisor(1 + k, 1);
    }
    gl.bindVertexArray(null);

    this.tileTex = texture(gl, MAX_TILES, 4, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
    this.lowTex = texture(gl, LOW_COLS * LOW_FIELD, LOW_ROWS * LOW_FIELD, gl.RG8, gl.RG, gl.UNSIGNED_BYTE, gl.LINEAR);
    this.highTex = texture(gl, HIGH_COLS * FIELD_N, HIGH_ROWS * FIELD_N, gl.RG8, gl.RG, gl.UNSIGNED_BYTE, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private bindQuad(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
  }

  resize(width: number, height: number): void {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height && this.scene) return;
    const gl = this.gl;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    for (const t of [this.scene, this.trailA, this.trailB, this.bloomA, this.bloomA2, this.bloomB, this.bloomB2]) disposeTarget(gl, t);
    this.scene = target(gl, width, height, this.hdr);
    const tw = Math.max(1, Math.floor(width / 2));
    const th = Math.max(1, Math.floor(height / 2));
    this.trailA = target(gl, tw, th, this.hdr);
    this.trailB = target(gl, tw, th, this.hdr);
    const qw = Math.max(1, Math.floor(width / 4));
    const qh = Math.max(1, Math.floor(height / 4));
    this.bloomA = target(gl, qw, qh, this.hdr);
    this.bloomA2 = target(gl, qw, qh, this.hdr);
    const ew = Math.max(1, Math.floor(width / 12));
    const eh = Math.max(1, Math.floor(height / 12));
    this.bloomB = target(gl, ew, eh, this.hdr);
    this.bloomB2 = target(gl, ew, eh, this.hdr);
    this.prevView = null;
  }

  get size(): [number, number] {
    return [this.width, this.height];
  }

  /** Forget trails (e.g. after a hard cut). */
  clearTrails(): void {
    const gl = this.gl;
    for (const t of [this.trailA, this.trailB]) {
      if (!t) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  private setView(p: Program, v: View, w = this.width, h = this.height): void {
    const gl = this.gl;
    gl.uniform4f(p.u.uCam, v.x, v.y, v.zoom, 0);
    gl.uniform2f(p.u.uViewport, w, h);
  }

  render(input: SceneInput): void {
    const gl = this.gl;
    if (!this.scene) return;
    this.frameNo++;
    const { tiles, view } = input;
    const W = this.width;
    const H = this.height;

    // ---- tile table, fields ----------------------------------------------
    const nTiles = Math.min(tiles.length, MAX_TILES);
    const td = this.tileData;
    let lowDirty = false;
    const rowStride = MAX_TILES * 4;
    for (let i = 0; i < nTiles; i++) {
      const t = tiles[i];
      const o0 = i * 4;
      td[o0] = t.x;
      td[o0 + 1] = t.y;
      td[o0 + 2] = t.r;
      td[o0 + 3] = t.alpha;
      let high = -1;
      let low = -1;
      const f = t.frame;
      if (f && f.field) {
        if (f.fieldRes === FIELD_N) high = this.uploadHigh(t.key, f);
        else if (f.fieldRes === LOW_FIELD && i < LOW_COLS * LOW_ROWS) {
          low = i;
          this.copyLow(i, f.field);
          lowDirty = true;
        }
      }
      const o1 = rowStride + o0;
      td[o1] = high;
      td[o1 + 1] = low;
      td[o1 + 2] = t.hover;
      td[o1 + 3] = t.select;
      const o2 = rowStride * 2 + o0;
      td[o2] = t.sun[0];
      td[o2 + 1] = t.sun[1];
      td[o2 + 2] = t.tintAmt;
      td[o2 + 3] = 1;
      const o3 = rowStride * 3 + o0;
      td[o3] = t.tint[0];
      td[o3 + 1] = t.tint[1];
      td[o3 + 2] = t.tint[2];
      td[o3 + 3] = t.dim;
      this.tileIdx[i] = i;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_TILES, 4, gl.RGBA, gl.FLOAT, td);
    if (lowDirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.lowTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LOW_COLS * LOW_FIELD, LOW_ROWS * LOW_FIELD, gl.RG, gl.UNSIGNED_BYTE, this.lowData);
    }
    this.tileIdxBuf.upload(this.tileIdx, nTiles);

    // ---- organism instances ------------------------------------------------
    let total = 0;
    for (let i = 0; i < nTiles; i++) {
      const f = tiles[i].frame;
      if (f && tiles[i].alpha > 0.002) total += f.n;
    }
    this.inst = ensureF32(this.inst, total * AGENT_STRIDE);
    this.instTile = ensureF32(this.instTile, total);
    this.instHalo = ensureF32(this.instHalo, total);
    let off = 0;
    const structures = this.structures;
    structures.clear();
    for (let i = 0; i < nTiles; i++) {
      const t = tiles[i];
      const f = t.frame;
      if (!f || t.alpha <= 0.002) continue;
      const n = f.n;
      if (n > 0) {
        this.inst.set(f.agents.subarray(0, n * AGENT_STRIDE), off * AGENT_STRIDE);
        this.instTile.fill(i, off, off + n);
        if (t.halo) this.instHalo.set(t.halo.subarray(0, n), off);
        else this.instHalo.fill(0, off, off + n);
        if (t.override && t.override.index >= 0 && t.override.index < n) {
          const k = (off + t.override.index) * AGENT_STRIDE;
          this.inst[k] += t.override.dx;
          this.inst[k + 1] += t.override.dy;
        }
        off += n;
      }
      if (t.structures !== false && f.remnants && f.nRemnants > 0) this.addStructures(t, f, view.zoom);
    }
    this.stats.tiles = nTiles;
    this.stats.agents = off;
    this.instBuf.upload(this.inst, off * AGENT_STRIDE);
    this.instTileBuf.upload(this.instTile, off);
    this.instHaloBuf.upload(this.instHalo, off);

    // ---- scene ---------------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fb);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vaoEmpty);
    gl.useProgram(this.pBg.prog);
    gl.uniform2f(this.pBg.u.uViewport, W, H);
    gl.uniform1f(this.pBg.u.uTime, input.time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawShapes(input.under, view);

    // Worlds.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.pTile.prog);
    this.setView(this.pTile, view);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
    gl.uniform1i(this.pTile.u.uTiles, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lowTex);
    gl.uniform1i(this.pTile.u.uLow, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.highTex);
    gl.uniform1i(this.pTile.u.uHigh, 2);
    gl.uniform2f(this.pTile.u.uLowGrid, LOW_COLS, LOW_FIELD);
    gl.uniform2f(this.pTile.u.uHighGrid, HIGH_COLS, FIELD_N);
    gl.uniform1f(this.pTile.u.uTime, input.time);
    gl.bindVertexArray(this.vaoTile);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nTiles);

    // Trails.
    this.updateTrails(input, off);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fb);
    gl.viewport(0, 0, W, H);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vaoEmpty);
    gl.useProgram(this.pCopy.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.trailA!.tex);
    gl.uniform1i(this.pCopy.u.uTex, 0);
    gl.uniform1f(this.pCopy.u.uGain, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Structures, organisms, overlays.
    this.drawShapes(structures, view);
    if (off > 0) {
      gl.useProgram(this.pAgent.prog);
      this.setView(this.pAgent, view);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
      gl.uniform1i(this.pAgent.u.uTiles, 0);
      gl.uniform1f(this.pAgent.u.uAlpha, input.alpha);
      gl.uniform1f(this.pAgent.u.uTime, input.time);
      gl.bindVertexArray(this.vaoAgent);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, off);
    }
    this.drawShapes(input.over, view);
    this.stats.shapes = input.under.count + structures.count + input.over.count;

    // ---- post ------------------------------------------------------------------
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vaoEmpty);
    this.downsample(this.scene, this.bloomA!, 1.0);
    this.blur(this.bloomA!, this.bloomA2!);
    this.downsample(this.bloomA!, this.bloomB!, 0.0001);
    this.blur(this.bloomB!, this.bloomB2!);
    this.blur(this.bloomB!, this.bloomB2!);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const pc = this.pComposite;
    gl.useProgram(pc.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(pc.u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomA!.tex);
    gl.uniform1i(pc.u.uBloomA, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomB!.tex);
    gl.uniform1i(pc.u.uBloomB, 2);
    gl.uniform2f(pc.u.uViewport, W, H);
    gl.uniform1f(pc.u.uTime, input.time);
    gl.uniform1f(pc.u.uExposure, input.post.exposure);
    gl.uniform1f(pc.u.uBloom, input.post.bloom);
    gl.uniform1f(pc.u.uFade, input.post.fade);
    gl.uniform1f(pc.u.uSat, input.post.sat);
    gl.uniform1f(pc.u.uGrain, input.post.grain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);

    this.prevView = { ...view };
  }

  private updateTrails(input: SceneInput, count: number): void {
    const gl = this.gl;
    const A = this.trailA!;
    const B = this.trailB!;
    const view = input.view;
    const prev = this.prevView ?? view;
    // Trails age with simulation time, not wall time: frozen time freezes them.
    const steps = Math.max(0, Math.min(8, input.stepsAdvanced));
    const zoomChange = Math.abs(Math.log(view.zoom / prev.zoom));
    const decay = Math.pow(0.955, steps) * Math.exp(-zoomChange * 2.5);

    gl.bindFramebuffer(gl.FRAMEBUFFER, B.fb);
    gl.viewport(0, 0, B.w, B.h);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vaoEmpty);
    const pf = this.pTrailFade;
    gl.useProgram(pf.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, A.tex);
    gl.uniform1i(pf.u.uPrev, 0);
    gl.uniform4f(pf.u.uCam, view.x, view.y, view.zoom, 0);
    gl.uniform4f(pf.u.uPrevCam, prev.x, prev.y, prev.zoom, 0);
    gl.uniform2f(pf.u.uViewport, this.width, this.height);
    gl.uniform1f(pf.u.uDecay, decay);
    gl.uniform1f(pf.u.uSub, this.hdr ? 0.0004 * steps : 0.0025 * Math.min(1, steps));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (count > 0 && steps > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      const pd = this.pTrailDot;
      gl.useProgram(pd.prog);
      this.setView(pd, view);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
      gl.uniform1i(pd.u.uTiles, 0);
      gl.uniform1f(pd.u.uAlpha, input.alpha);
      gl.uniform1f(pd.u.uDeposit, Math.min(2, steps));
      gl.bindVertexArray(this.vaoAgent);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    }
    this.trailA = B;
    this.trailB = A;
  }

  private downsample(src: Target, dst: Target, knee: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, dst.w, dst.h);
    const p = this.pDown;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform2f(p.u.uTexel, 0.5 / dst.w, 0.5 / dst.h);
    gl.uniform1f(p.u.uKnee, knee);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private blur(a: Target, tmp: Target): void {
    const gl = this.gl;
    const p = this.pBlur;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(p.u.uTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.fb);
    gl.viewport(0, 0, tmp.w, tmp.h);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.uniform2f(p.u.uDir, 1 / a.w, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
    gl.viewport(0, 0, a.w, a.h);
    gl.bindTexture(gl.TEXTURE_2D, tmp.tex);
    gl.uniform2f(p.u.uDir, 0, 1 / a.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawShapes(batch: ShapeBatch, view: View): void {
    if (batch.count === 0) return;
    const gl = this.gl;
    this.shapeBuf.upload(batch.data, batch.count * 12);
    gl.useProgram(this.pShape.prog);
    this.setView(this.pShape, view);
    gl.bindVertexArray(this.vaoShape);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
  }

  private copyLow(slot: number, field: Uint8Array): void {
    const cx = slot % LOW_COLS;
    const cy = Math.floor(slot / LOW_COLS);
    const rowBytes = LOW_COLS * LOW_FIELD * 2;
    const res = LOW_FIELD;
    for (let j = 0; j < res; j++) {
      const dst = (cy * res + j) * rowBytes + cx * res * 2;
      this.lowData.set(field.subarray(j * res * 2, (j + 1) * res * 2), dst);
    }
  }

  private uploadHigh(key: number, f: WorldFrame): number {
    let entry = this.highSlots.get(key);
    if (!entry) {
      let slot = -1;
      if (this.highSlots.size < HIGH_COLS * HIGH_ROWS) {
        const used = new Set([...this.highSlots.values()].map((e) => e.slot));
        for (let s = 0; s < HIGH_COLS * HIGH_ROWS; s++) {
          if (!used.has(s)) {
            slot = s;
            break;
          }
        }
      } else {
        let oldestKey = -1;
        let oldest = Infinity;
        for (const [k, e] of this.highSlots) {
          if (e.used < oldest) {
            oldest = e.used;
            oldestKey = k;
          }
        }
        slot = this.highSlots.get(oldestKey)!.slot;
        this.highSlots.delete(oldestKey);
      }
      entry = { slot, frame: null, used: this.frameNo };
      this.highSlots.set(key, entry);
    }
    entry.used = this.frameNo;
    if (entry.frame !== f && f.field) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.highTex);
      const sx = (entry.slot % HIGH_COLS) * FIELD_N;
      const sy = Math.floor(entry.slot / HIGH_COLS) * FIELD_N;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, sx, sy, FIELD_N, FIELD_N, gl.RG, gl.UNSIGNED_BYTE, f.field);
      entry.frame = f;
    }
    return entry.slot;
  }

  /** Remnant structures: luminous nodes and the filaments that join them. */
  private addStructures(t: TileInput, f: WorldFrame, zoom: number): void {
    const rem = f.remnants!;
    const scale = t.r / WORLD_RADIUS;
    const pxPerUnit = scale * zoom;
    if (pxPerUnit < 0.25) return;
    const detail = Math.min(1, (pxPerUnit - 0.25) / 0.5);
    const a = t.alpha * detail;
    const lineW = Math.min(2.2, Math.max(0.6, 0.55 * pxPerUnit));
    for (let k = 0; k < f.nRemnants; k++) {
      const q = k * REMNANT_STRIDE;
      const s = rem[q + 2];
      if (s <= 0.01) continue;
      const [r, g, b] = hslToRgb(rem[q + 3], 0.35, 0.72);
      const px = t.x + rem[q] * scale;
      const py = t.y + rem[q + 1] * scale;
      const lx = rem[q + 4];
      const fade = Math.min(1, s * 1.6);
      if (Number.isFinite(lx)) {
        const ly = rem[q + 5];
        this.structures.line(px, py, t.x + lx * scale, t.y + ly * scale, lineW, r * 0.8, g * 0.75, b * 0.7, 0.32 * fade * a, 1.5);
      }
      this.structures.disc(px, py, (1.1 + 1.2 * s) * scale, r, g * 0.92, b * 0.85, 0.55 * fade * a, 2.5);
    }
  }

  /** Reads the current frame back as a PNG (call right after render). */
  snapshotPNG(): Promise<Blob | null> {
    return new Promise((resolve) => this.canvas.toBlob((b) => resolve(b), 'image/png'));
  }
}
