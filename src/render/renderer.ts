import { HIGH_FIELD, LOW_FIELD, UNIT_STRIDE, type MindFrame } from '../engine/packet';
import { N_NEURONS, TYPE_EXC, TYPE_INH, type Network } from '../sim';
import type { View } from './camera';
import { DynBuffer, disposeTarget, ensureF32, program, target, texture, type GL, type Program, type Target } from './gl';
import * as S from './shaders';
import { ShapeBatch } from './shapes';

export interface Mood {
  warmth: number;
  coherence: number;
  erasure: number;
  agitation: number;
  echo: number;
  expansion: number;
  enclosure: number;
}

export const NO_MOOD: Mood = { warmth: 0, coherence: 0, erasure: 0, agitation: 0, echo: 0, expansion: 0, enclosure: 0 };

export interface TileInput {
  key: number;
  x: number;
  y: number;
  r: number;
  alpha: number;
  frame: MindFrame | null;
  hover: number;
  select: number;
  /** The interpretation's colour, and how much of it to show. */
  tint: [number, number, number];
  tintAmt: number;
  dim: number;
  commitment: number;
  dominant: number;
  mood: Mood;
  /** Multiplier on pink (0 for a control mind). */
  pinkGain: number;
  /** How strongly causal links are drawn (fades as the change saturates the network). */
  linkGain?: number;
  /** Contrast of the stimulus (0–1) shown at the centre. */
  stimulus: number;
  /** Draw filaments (only worth it for large minds). */
  filaments?: boolean;
  /** Draw individual units (default true when the frame carries them). */
  units?: boolean;
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
  /** Simulation steps that elapsed since the previous frame (drives afterglow decay). */
  stepsAdvanced: number;
  time: number;
  under: ShapeBatch;
  over: ShapeBatch;
  post: PostParams;
}

const MAX_TILES = 2048;
const TILE_ROWS = 6;
const LOW_COLS = 64;
const LOW_ROWS = 32;
const HIGH_COLS = 8;
const HIGH_ROWS = 8;

const CREAM: [number, number, number] = [1.0, 0.93, 0.82];
const PINK: [number, number, number] = [1.0, 0.16, 0.52];

/**
 * The renderer is stateless with respect to the experience: give it tiles,
 * frames and a camera, and it draws. One WebGL2 context, instanced
 * everything, an afterglow buffer reprojected through camera motion, and a
 * soft bloom.
 */
export class Renderer {
  readonly gl: GL;
  readonly hdr: boolean;
  private width = 1;
  private height = 1;

  private pBg: Program;
  private pTile: Program;
  private pUnit: Program;
  private pTrailDot: Program;
  private pTrailFade: Program;
  private pCopy: Program;
  private pShape: Program;
  private pDown: Program;
  private pBlur: Program;
  private pComposite: Program;

  private quad: WebGLBuffer;
  private vaoTile: WebGLVertexArrayObject;
  private vaoUnit: WebGLVertexArrayObject;
  private vaoShape: WebGLVertexArrayObject;
  private vaoEmpty: WebGLVertexArrayObject;
  private tileIdxBuf: DynBuffer;
  private instBuf: DynBuffer;
  private instTileBuf: DynBuffer;
  private shapeBuf: DynBuffer;

  private tileTex: WebGLTexture;
  private tileData = new Float32Array(MAX_TILES * 4 * TILE_ROWS);
  private unitTex: WebGLTexture;
  private lowTex: WebGLTexture;
  private lowData = new Uint8Array(LOW_COLS * LOW_FIELD * LOW_ROWS * LOW_FIELD * 2);
  private highTex: WebGLTexture;
  private highSlots = new Map<number, { slot: number; frame: MindFrame | null; used: number }>();
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
  private tileIdx = new Float32Array(MAX_TILES);
  private prevView: View | null = null;
  private net: Network | null = null;
  readonly filaments = new ShapeBatch();

  stats = { tiles: 0, units: 0, shapes: 0 };

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
    this.pUnit = program(gl, S.UNIT_VS, S.UNIT_FS, 'unit');
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
    this.shapeBuf = new DynBuffer(gl);

    this.vaoEmpty = gl.createVertexArray()!;

    this.vaoTile = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoTile);
    this.bindQuad();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tileIdxBuf.buf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 4, 0);
    gl.vertexAttribDivisor(1, 1);

    this.vaoUnit = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoUnit);
    this.bindQuad();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf.buf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, UNIT_STRIDE * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instTileBuf.buf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 4, 0);
    gl.vertexAttribDivisor(2, 1);

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

    this.tileTex = texture(gl, MAX_TILES, TILE_ROWS, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
    this.unitTex = texture(gl, N_NEURONS, 2, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
    this.lowTex = texture(gl, LOW_COLS * LOW_FIELD, LOW_ROWS * LOW_FIELD, gl.RG8, gl.RG, gl.UNSIGNED_BYTE, gl.LINEAR);
    this.highTex = texture(gl, HIGH_COLS * HIGH_FIELD, HIGH_ROWS * HIGH_FIELD, gl.RG8, gl.RG, gl.UNSIGNED_BYTE, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  /** The wiring all minds share: unit positions and types become a texture. */
  setNetwork(net: Network): void {
    if (this.net === net) return;
    this.net = net;
    const d = new Float32Array(N_NEURONS * 4 * 2);
    for (let i = 0; i < N_NEURONS; i++) {
      d[i * 4] = net.x[i];
      d[i * 4 + 1] = net.y[i];
      d[i * 4 + 2] = net.type[i];
      d[i * 4 + 3] = net.group[i];
      const o = (N_NEURONS + i) * 4;
      d[o] = net.tidyX[i];
      d[o + 1] = net.tidyY[i];
      d[o + 2] = net.hash[i];
      d[o + 3] = Math.sqrt(net.x[i] * net.x[i] + net.y[i] * net.y[i]);
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.unitTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N_NEURONS, 2, gl.RGBA, gl.FLOAT, d);
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

  /** Forget afterglow (e.g. after a hard cut). */
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
      const o = i * 4;
      td[o] = t.x;
      td[o + 1] = t.y;
      td[o + 2] = t.r;
      td[o + 3] = t.alpha;
      let high = -1;
      let low = -1;
      const f = t.frame;
      if (f && f.field) {
        if (f.fieldRes === HIGH_FIELD) high = this.uploadHigh(t.key, f);
        else if (f.fieldRes === LOW_FIELD && i < LOW_COLS * LOW_ROWS) {
          low = i;
          this.copyLow(i, f.field);
          lowDirty = true;
        }
      }
      const m = t.mood;
      const rows = [
        [high, low, t.hover, t.select],
        [t.commitment, t.dominant, t.tintAmt, t.pinkGain],
        [t.tint[0], t.tint[1], t.tint[2], t.dim],
        [m.warmth, m.coherence, m.erasure, m.agitation],
        [m.echo, m.expansion, m.enclosure, t.stimulus],
      ];
      for (let r = 0; r < rows.length; r++) {
        const q = rowStride * (r + 1) + o;
        td[q] = rows[r][0];
        td[q + 1] = rows[r][1];
        td[q + 2] = rows[r][2];
        td[q + 3] = rows[r][3];
      }
      this.tileIdx[i] = i;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_TILES, TILE_ROWS, gl.RGBA, gl.FLOAT, td);
    if (lowDirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.lowTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LOW_COLS * LOW_FIELD, LOW_ROWS * LOW_FIELD, gl.RG, gl.UNSIGNED_BYTE, this.lowData);
    }
    this.tileIdxBuf.upload(this.tileIdx, nTiles);

    // ---- unit instances ------------------------------------------------------
    let total = 0;
    for (let i = 0; i < nTiles; i++) {
      const f = tiles[i].frame;
      if (f && f.n === N_NEURONS && tiles[i].alpha > 0.002 && tiles[i].units !== false) total += N_NEURONS;
    }
    this.inst = ensureF32(this.inst, total * UNIT_STRIDE);
    this.instTile = ensureF32(this.instTile, total);
    let off = 0;
    const fil = this.filaments;
    fil.clear();
    for (let i = 0; i < nTiles; i++) {
      const t = tiles[i];
      const f = t.frame;
      if (!f || f.n !== N_NEURONS || t.alpha <= 0.002 || t.units === false) continue;
      this.inst.set(f.units.subarray(0, N_NEURONS * UNIT_STRIDE), off * UNIT_STRIDE);
      this.instTile.fill(i, off, off + N_NEURONS);
      off += N_NEURONS;
      if (t.filaments && this.net) this.addFilaments(t, f, view.zoom);
    }
    this.stats.tiles = nTiles;
    this.stats.units = off;
    this.instBuf.upload(this.inst, off * UNIT_STRIDE);
    this.instTileBuf.upload(this.instTile, off);

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

    // Minds.
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
    gl.uniform2f(this.pTile.u.uHighGrid, HIGH_COLS, HIGH_FIELD);
    gl.uniform1f(this.pTile.u.uTime, input.time);
    gl.bindVertexArray(this.vaoTile);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nTiles);

    // Afterglow.
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

    // Filaments, units, overlays.
    this.drawShapes(fil, view);
    if (off > 0) {
      gl.useProgram(this.pUnit.prog);
      this.setView(this.pUnit, view);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
      gl.uniform1i(this.pUnit.u.uTiles, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.unitTex);
      gl.uniform1i(this.pUnit.u.uUnits, 1);
      gl.uniform1i(this.pUnit.u.uN, N_NEURONS);
      gl.uniform1f(this.pUnit.u.uTime, input.time);
      gl.bindVertexArray(this.vaoUnit);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, off);
    }
    this.drawShapes(input.over, view);
    this.stats.shapes = input.under.count + fil.count + input.over.count;

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
    // Afterglow ages with network time, not wall time: frozen time freezes it.
    const steps = Math.max(0, Math.min(40, input.stepsAdvanced));
    const zoomChange = Math.abs(Math.log(view.zoom / prev.zoom));
    const decay = Math.pow(0.975, steps) * Math.exp(-zoomChange * 2.5);

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
    gl.uniform1f(pf.u.uSub, this.hdr ? 0.0002 * steps : 0.0025 * Math.min(1, steps));
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
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.unitTex);
      gl.uniform1i(pd.u.uUnits, 1);
      gl.uniform1i(pd.u.uN, N_NEURONS);
      gl.uniform1f(pd.u.uTime, input.time);
      gl.uniform1f(pd.u.uDeposit, Math.min(3, 0.4 + steps * 0.25));
      gl.bindVertexArray(this.vaoUnit);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.activeTexture(gl.TEXTURE0);
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

  private uploadHigh(key: number, f: MindFrame): number {
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
      const sx = (entry.slot % HIGH_COLS) * HIGH_FIELD;
      const sy = Math.floor(entry.slot / HIGH_COLS) * HIGH_FIELD;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, sx, sy, HIGH_FIELD, HIGH_FIELD, gl.RG, gl.UNSIGNED_BYTE, f.field);
      entry.frame = f;
    }
    return entry.slot;
  }

  /**
   * Filaments: each unit's few nearest real synapses, drawn as faint curved
   * fibres. A spike travels along them as a small comet that takes exactly
   * the synapse's delay to arrive — pink if that unit's behaviour is part of
   * the causal lineage.
   */
  private addFilaments(t: TileInput, f: MindFrame, zoom: number): void {
    const net = this.net!;
    const pxPerUnit = t.r * zoom;
    if (pxPerUnit < 90) return;
    const detail = Math.min(1, (pxPerUnit - 90) / 160);
    const a0 = t.alpha * (1 - t.dim * 0.8);
    const lw = Math.min(1.4, Math.max(0.6, pxPerUnit / 520));
    const u = f.units;
    const pg = t.pinkGain;
    const lg = t.linkGain ?? 1;
    const { drawStart, drawSyn, outTarget, outDelay, x, y, type, hash } = net;
    for (let i = 0; i < N_NEURONS; i++) {
      const since = u[i * UNIT_STRIDE + 2];
      const pink = Math.min(1, u[i * UNIT_STRIDE + 3] * pg);
      const xi = t.x + x[i] * t.r;
      const yi = t.y + y[i] * t.r;
      // The causal link: from the unit whose changed spike reached this one.
      const by = u[i * UNIT_STRIDE + 4];
      // Drawn while the unit is flashing (a fresh change), so the lineage reads as lightning, not a web.
      const flashP = pink - 0.32;
      if (pg > 0 && flashP > 0 && by >= 0 && lg > 0.01) {
        const xj = t.x + x[by] * t.r;
        const yj = t.y + y[by] * t.r;
        this.filaments.line(xj, yj, xi, yi, lw * 1.2, PINK[0], PINK[1], PINK[2], a0 * 0.75 * flashP * flashP * lg, 1.5);
      }
      const isI = type[i] === TYPE_INH;
      for (let k = drawStart[i]; k < drawStart[i + 1]; k++) {
        const s = drawSyn[k];
        const j = outTarget[s];
        const xj = t.x + x[j] * t.r;
        const yj = t.y + y[j] * t.r;
        // A gentle bend, always the same for the same fibre.
        const bend = (hash[(i * 7 + j) % N_NEURONS] - 0.5) * 0.35;
        const mx = (xi + xj) / 2 - (yj - yi) * bend;
        const my = (yi + yj) / 2 + (xj - xi) * bend;
        const base = (isI ? 0.018 : 0.03) * detail * a0;
        const cr = CREAM[0] * (1 - pink) + PINK[0] * pink;
        const cg = CREAM[1] * (1 - pink) + PINK[1] * pink;
        const cb = CREAM[2] * (1 - pink) + PINK[2] * pink;
        const glowA = base * (1 + pink * 4);
        this.filaments.line(xi, yi, mx, my, lw, cr, cg, cb, glowA, 0);
        this.filaments.line(mx, my, xj, yj, lw, cr, cg, cb, glowA, 0);
        // A spike in transit.
        const d = outDelay[s];
        if (since >= 0 && since <= d + 1) {
          const p = Math.min(1, (since + 0.5) / d);
          const q = Math.max(0, p - 0.18);
          const at = (v: number): [number, number] => {
            const w = 1 - v;
            return [w * w * xi + 2 * w * v * mx + v * v * xj, w * w * yi + 2 * w * v * my + v * v * yj];
          };
          const [ax, ay] = at(q);
          const [bx, by] = at(p);
          const strength = (isI ? 0.12 : 0.26) * a0 * (1 - Math.max(0, since - d) * 0.5);
          this.filaments.line(ax, ay, bx, by, lw * 1.1, cr, cg, cb, strength * (1 + pink * 1.5), 1.5 + pink * 2);
        }
      }
    }
  }

  /** Reads the current frame back as a PNG (call right after render). */
  snapshotPNG(): Promise<Blob | null> {
    return new Promise((resolve) => this.canvas.toBlob((b) => resolve(b), 'image/png'));
  }
}

export { TYPE_EXC };
