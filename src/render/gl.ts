/** Minimal WebGL2 helpers. */

export type GL = WebGL2RenderingContext;

export function compile(gl: GL, type: number, src: string, name: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(3)} ${l}`)
      .join('\n');
    throw new Error(`Shader ${name} failed:\n${log}\n${numbered}`);
  }
  return sh;
}

export interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

export function program(gl: GL, vs: string, fs: string, name: string): Program {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, `${name}.vs`));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, `${name}.fs`));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Program ${name} failed to link: ${gl.getProgramInfoLog(p)}`);
  }
  const u: Record<string, WebGLUniformLocation | null> = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    if (!info) continue;
    const base = info.name.replace(/\[0\]$/, '');
    u[base] = gl.getUniformLocation(p, info.name);
  }
  return { prog: p, u };
}

export interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

export function texture(
  gl: GL,
  w: number,
  h: number,
  internal: number,
  format: number,
  type: number,
  filter: number = gl.LINEAR,
  data: ArrayBufferView | null = null,
): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  return t;
}

export function target(gl: GL, w: number, h: number, hdr: boolean): Target {
  const tex = hdr
    ? texture(gl, w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT)
    : texture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fb, tex, w, h };
}

export function disposeTarget(gl: GL, t: Target | null): void {
  if (!t) return;
  gl.deleteFramebuffer(t.fb);
  gl.deleteTexture(t.tex);
}

/** A growable dynamic vertex buffer. */
export class DynBuffer {
  readonly buf: WebGLBuffer;
  private capacity = 0;
  constructor(private readonly gl: GL) {
    this.buf = gl.createBuffer()!;
  }
  upload(data: Float32Array, length: number): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const bytes = length * 4;
    if (bytes > this.capacity) {
      this.capacity = Math.max(bytes, Math.ceil(this.capacity * 1.5), 4096);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
    }
    if (length > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, length);
  }
}

/** Grows a Float32Array, preserving nothing (scratch use). */
export function ensureF32(a: Float32Array<ArrayBuffer>, n: number): Float32Array<ArrayBuffer> {
  if (a.length >= n) return a;
  let len = Math.max(1024, a.length);
  while (len < n) len *= 2;
  return new Float32Array(len);
}
