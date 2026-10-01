/**
 * GLSL for the artwork. Plane coordinates: every world is a disk of radius
 * `tile.z` (normally 1) centred at `tile.xy`; simulation units map into it at
 * tile.z / WORLD_RADIUS. Plane y points down the screen.
 */

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const VIEW = /* glsl */ `
uniform vec4 uCam;       // x, y, zoom (device px per plane unit), unused
uniform vec2 uViewport;  // device px
vec2 toClip(vec2 p) {
  vec2 s = (p - uCam.xy) * uCam.z;
  return vec2(s.x * 2.0 / uViewport.x, -s.y * 2.0 / uViewport.y);
}
`;

const COLOR = /* glsl */ `
vec3 hsl(float h, float s, float l) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return l + s * (k - 0.5) * (1.0 - abs(2.0 * l - 1.0));
}
`;

// ---------------------------------------------------------------------------
// Full-screen triangle
// ---------------------------------------------------------------------------
export const FULLSCREEN_VS = HEADER + /* glsl */ `
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const BACKGROUND_FS = HEADER + /* glsl */ `
in vec2 vUV;
out vec4 o;
uniform vec2 uViewport;
uniform float uTime;
void main() {
  vec2 p = (vUV - 0.5) * vec2(uViewport.x / uViewport.y, 1.0);
  float r = length(p);
  vec3 c = mix(vec3(0.012, 0.014, 0.024), vec3(0.004, 0.005, 0.009), smoothstep(0.0, 1.0, r));
  o = vec4(c, 1.0);
}
`;

// ---------------------------------------------------------------------------
// World disks: the resource landscape, structures' fertile ground, the rim.
// ---------------------------------------------------------------------------
export const TILE_VS = HEADER + VIEW + /* glsl */ `
layout(location = 0) in vec2 aCorner;
layout(location = 1) in float aTile;
uniform sampler2D uTiles;
out vec2 vLocal;
flat out int vTile;
void main() {
  int t = int(aTile);
  vec4 a = texelFetch(uTiles, ivec2(t, 0), 0);
  vLocal = aCorner * 1.3;
  gl_Position = vec4(toClip(a.xy + vLocal * a.z), 0.0, 1.0);
  vTile = t;
}
`;

export const TILE_FS = HEADER + COLOR + /* glsl */ `
in vec2 vLocal;
flat in int vTile;
out vec4 o;
uniform sampler2D uTiles;
uniform sampler2D uLow;
uniform sampler2D uHigh;
uniform float uTime;
uniform vec2 uLowGrid;   // slots per row, texels per slot
uniform vec2 uHighGrid;

vec2 atlas(sampler2D tex, vec2 grid, float slot, vec2 uv) {
  float res = grid.y;
  vec2 cell = vec2(mod(slot, grid.x), floor(slot / grid.x));
  vec2 inner = clamp(uv, vec2(0.5 / res), vec2(1.0 - 0.5 / res));
  vec2 size = vec2(textureSize(tex, 0));
  vec2 base = (cell * res) / size;
  vec2 st = base + inner * res / size;
  vec2 t = 0.5 / size;
  // Four bilinear taps half a texel apart: a cheap, smooth reconstruction.
  vec2 lo = base + vec2(0.5) / size;
  vec2 hi = base + vec2(res - 0.5) / size;
  return 0.25 * (
    texture(tex, clamp(st + vec2(-t.x, -t.y), lo, hi)).rg +
    texture(tex, clamp(st + vec2( t.x, -t.y), lo, hi)).rg +
    texture(tex, clamp(st + vec2(-t.x,  t.y), lo, hi)).rg +
    texture(tex, clamp(st + vec2( t.x,  t.y), lo, hi)).rg);
}

void main() {
  vec4 a = texelFetch(uTiles, ivec2(vTile, 0), 0); // cx cy radius alpha
  vec4 b = texelFetch(uTiles, ivec2(vTile, 1), 0); // highSlot lowSlot hover select
  vec4 c = texelFetch(uTiles, ivec2(vTile, 2), 0); // sunX sunY tintAmt life
  vec4 d = texelFetch(uTiles, ivec2(vTile, 3), 0); // tint rgb, dim
  float r = length(vLocal);
  float px = max(fwidth(r), 1e-5);
  float tilePx = 1.0 / px;
  if (r > 1.3) discard;

  vec2 uv = vLocal * 0.5 + 0.5;
  vec2 f = vec2(0.0);
  if (b.x >= 0.0) f = atlas(uHigh, uHighGrid, b.x, uv);
  else if (b.y >= 0.0) f = atlas(uLow, uLowGrid, b.y, uv);
  float res = f.x;
  float fert = f.y;

  vec3 deep = vec3(0.010, 0.016, 0.030);
  vec3 col = deep;
  col += vec3(0.020, 0.095, 0.105) * pow(res, 1.1) * 2.1;
  col += vec3(0.006, 0.018, 0.040) * (1.0 - res) * 0.7;

  // Topographic contours of the resource landscape.
  float lv = res * 7.0;
  float fw = max(fwidth(lv), 1e-4);
  float dd = abs(fract(lv + 0.5) - 0.5);
  float line = 1.0 - smoothstep(0.0, fw * 1.3, dd);
  float detail = smoothstep(40.0, 160.0, tilePx);
  col += vec3(0.06, 0.17, 0.18) * line * 0.5 * smoothstep(0.03, 0.25, res) * detail;

  // The dead feed the ground: warm fertile halos around structures.
  col += vec3(0.13, 0.07, 0.03) * fert * 0.8;

  // The wandering sun.
  vec2 sun = c.xy / 400.0;
  vec2 ds = vLocal - sun;
  col += vec3(0.05, 0.04, 0.03) * exp(-dot(ds, ds) * 3.0) * 0.45;

  // Lens: darken toward the rim.
  col *= mix(1.0, 0.42, smoothstep(0.5, 1.0, r));
  col *= mix(1.0, 0.55, d.w);

  float inside = 1.0 - smoothstep(1.0 - px, 1.0 + px, r);
  float hover = b.z;
  float select = b.w;
  vec3 rimCol = mix(vec3(0.45, 0.55, 0.66), d.rgb, c.z);
  float rimW = px * (1.1 + select * 1.2);
  float rim = exp(-abs(r - 1.0) / rimW) * (0.16 + 0.5 * hover + 0.6 * select + 0.25 * c.z);
  float halo = r > 1.0 ? exp(-(r - 1.0) * 10.0) * (0.035 + 0.08 * hover + 0.1 * select) : 0.0;

  vec3 outc = col * inside + rimCol * (rim + halo);
  o = vec4(outc, inside) * a.w;
}
`;

// ---------------------------------------------------------------------------
// Organisms
// ---------------------------------------------------------------------------
const AGENT_VS_COMMON = /* glsl */ `
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aA;   // x y vx vy (sim units)
layout(location = 2) in vec4 aB;   // energy hue code flash
layout(location = 3) in float aTile;
layout(location = 4) in float aHalo;
uniform sampler2D uTiles;
uniform float uAlpha;
uniform float uTime;
`;

export const AGENT_VS = HEADER + VIEW + COLOR + AGENT_VS_COMMON + /* glsl */ `
out vec2 vQ;
out vec3 vCol;
out float vKind;
out float vFlash;
out float vHalo;
out float vPx;
out float vSpeed;
out float vPhase;
out float vAlpha;
out vec3 vDot;
void main() {
  int t = int(aTile);
  vec4 tile = texelFetch(uTiles, ivec2(t, 0), 0);
  float scale = tile.z / 400.0;
  vec2 sim = aA.xy + aA.zw * uAlpha;
  vec2 p = tile.xy + sim * scale;
  float kind = mod(aB.z, 2.0);
  float e = max(aB.x, 0.0);
  float young = kind < 0.5 ? 1.0 - aB.w : 0.0;
  float body = kind > 0.5 ? 6.2 + 0.7 * sqrt(e) : (3.0 + 1.5 * sqrt(e)) * (1.0 - 0.35 * young);
  float extent = kind > 0.5 ? 3.0 : 3.4;
  float pxPerUnit = scale * uCam.z;
  float hpx = body * extent * pxPerUnit;
  float grow = max(1.0, 2.6 / hpx);
  vec2 v = aA.zw;
  float sp = length(v);
  vec2 dir = sp > 1e-4 ? v / sp : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 off = (dir * aCorner.x + perp * aCorner.y) * body * extent * grow * scale;
  gl_Position = vec4(toClip(p + off), 0.0, 1.0);
  vQ = aCorner * extent * grow;
  vPx = hpx * grow;
  vKind = kind;
  vFlash = aB.w;
  vHalo = aHalo;
  vSpeed = clamp(sp / 1.8, 0.0, 1.0);
  vPhase = fract(aB.y * 91.7 + aB.x * 0.13) * 6.2831;
  vAlpha = tile.w;
  if (kind > 0.5) vCol = hsl(aB.y, 0.85, 0.6);
  else vCol = hsl(aB.y, 0.55, 0.62);
  vDot = kind > 0.5 ? hsl(aB.y, 1.0, 0.55) * 2.2 : hsl(aB.y, 0.8, 0.5) * 1.7;
}
`;

export const AGENT_FS = HEADER + /* glsl */ `
in vec2 vQ;
in vec3 vCol;
in float vKind;
in float vFlash;
in float vHalo;
in float vPx;
in float vSpeed;
in float vPhase;
in float vAlpha;
in vec3 vDot;
out vec4 o;
uniform float uTime;
void main() {
  float r = length(vQ);
  float detail = smoothstep(3.0, 14.0, vPx);
  vec3 c;
  if (vKind < 0.5) {
    float k = 1.0 + 0.55 * vSpeed;
    vec2 q = vec2(vQ.x / k + 0.12 * vSpeed, vQ.y * (1.0 + 0.1 * vSpeed));
    float d = length(q);
    float ang = atan(q.y, q.x);
    float core = exp(-d * d * 2.4);
    vec2 n = q - vec2(0.38, 0.0);
    float nucleus = exp(-dot(n, n) * 10.0);
    float wob = 0.07 * sin(ang * 5.0 + uTime * 2.3 + vPhase);
    float m = (d - 1.08 - wob) / 0.1;
    float membrane = exp(-m * m) * (0.75 + 0.25 * sin(ang * 3.0 - uTime * 1.7 + vPhase));
    float glow = exp(-d * 1.1) * 0.16;
    // Wake: a faint tail behind the body.
    float tail = vQ.x < 0.0 ? exp(-vQ.y * vQ.y * 6.0) * exp(vQ.x * 0.9) * 0.22 * vSpeed : 0.0;
    c = vCol * (core * 0.95 + membrane * 0.6 * detail + glow + tail) + vec3(1.0, 0.97, 0.9) * nucleus * 0.55 * detail;
    float young = 1.0 - vFlash;
    c += vec3(1.0, 0.98, 0.92) * young * young * exp(-d * d * 0.8) * 1.4;
  } else {
    float ang = atan(vQ.y, vQ.x);
    float digest = clamp(vFlash, 0.0, 1.0);
    float gap = mix(0.95, 0.25, digest);
    float m = (r - 0.9) / 0.14;
    float ring = exp(-m * m) * smoothstep(gap - 0.3, gap + 0.15, abs(ang));
    float spines = pow(max(0.0, cos(ang * 7.0 + uTime * 0.6 + vPhase)), 12.0) * exp(-abs(r - 1.35) * 6.0) * 0.5;
    float core = exp(-r * r * 5.0);
    float glow = exp(-r * 0.9) * 0.2;
    float pulse = 0.75 + 0.25 * sin(uTime * 5.0 + vPhase) * digest;
    c = vCol * (ring * 1.25 + spines * detail + glow) + vec3(1.0, 0.86, 0.68) * core * (0.55 + 0.9 * digest) * pulse;
  }
  // Tiny on screen: collapse to a soft point of the same colour.
  float pt = exp(-r * r * 1.2);
  c = mix(vDot * pt, c, detail);

  // Touched by the change: a pale halo whose strength is this organism's divergence.
  if (vHalo > 0.01) {
    float hr = vKind > 0.5 ? 2.05 : 2.35;
    float hm = (r - hr) / 0.09;
    c += vec3(1.0, 0.84, 0.55) * exp(-hm * hm) * smoothstep(0.1, 0.6, vHalo) * 0.22 * max(detail, 0.35);
  }
  o = vec4(c * vAlpha, 0.0);
}
`;

// Soft dots written into the trail buffer.
export const TRAIL_DOT_VS = HEADER + VIEW + COLOR + AGENT_VS_COMMON + /* glsl */ `
out vec2 vQ;
out vec3 vCol;
uniform float uDeposit;
void main() {
  int t = int(aTile);
  vec4 tile = texelFetch(uTiles, ivec2(t, 0), 0);
  float scale = tile.z / 400.0;
  vec2 p = tile.xy + (aA.xy + aA.zw * uAlpha) * scale;
  float kind = mod(aB.z, 2.0);
  float size = kind > 0.5 ? 4.2 : 2.6;
  float pxPerUnit = scale * uCam.z;
  float grow = max(1.0, 1.4 / (size * pxPerUnit));
  gl_Position = vec4(toClip(p + aCorner * size * grow * scale), 0.0, 1.0);
  vQ = aCorner;
  float sp = clamp(length(aA.zw) / 1.6, 0.15, 1.0);
  vec3 col = kind > 0.5 ? hsl(aB.y, 0.9, 0.55) * 0.5 : hsl(aB.y, 0.6, 0.55) * 0.16;
  vCol = col * sp * tile.w * uDeposit / (grow * grow);
}
`;

export const TRAIL_DOT_FS = HEADER + /* glsl */ `
in vec2 vQ;
in vec3 vCol;
out vec4 o;
void main() {
  float g = exp(-dot(vQ, vQ) * 3.0);
  o = vec4(vCol * g, 0.0);
}
`;

export const TRAIL_FADE_FS = HEADER + /* glsl */ `
in vec2 vUV;
out vec4 o;
uniform sampler2D uPrev;
uniform vec4 uCam;
uniform vec4 uPrevCam;
uniform vec2 uViewport;
uniform float uDecay;
uniform float uSub;
void main() {
  vec2 sp = vec2(vUV.x - 0.5, 0.5 - vUV.y) * uViewport;
  vec2 plane = sp / uCam.z + uCam.xy;
  vec2 psp = (plane - uPrevCam.xy) * uPrevCam.z;
  vec2 puv = vec2(psp.x / uViewport.x + 0.5, 0.5 - psp.y / uViewport.y);
  vec4 c = vec4(0.0);
  if (puv.x >= 0.0 && puv.x <= 1.0 && puv.y >= 0.0 && puv.y <= 1.0) c = texture(uPrev, puv);
  o = max(c * uDecay - vec4(uSub), vec4(0.0));
}
`;

export const COPY_FS = HEADER + /* glsl */ `
in vec2 vUV;
out vec4 o;
uniform sampler2D uTex;
uniform float uGain;
void main() { o = texture(uTex, vUV) * uGain; }
`;

// ---------------------------------------------------------------------------
// Shapes: luminous lines, discs and rings in plane coordinates.
// ---------------------------------------------------------------------------
export const SHAPE_VS = HEADER + VIEW + /* glsl */ `
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iP;  // line: x0 y0 x1 y1 · circle: cx cy - -
layout(location = 2) in vec4 iC;  // rgba (additive)
layout(location = 3) in vec4 iS;  // widthPx, kind (0 line, 1 disc, 2 ring), radius (plane), glowPx
out vec2 vL;
flat out vec4 vS;
flat out vec4 vC;
flat out float vLen;
void main() {
  float glow = iS.w;
  float pad = iS.x * 0.5 + 1.5 + glow * 3.0;
  vS = iS;
  vC = iC;
  if (iS.y < 0.5) {
    vec2 a = iP.xy;
    vec2 b = iP.zw;
    vec2 d = b - a;
    float len = length(d);
    vec2 dir = len > 1e-9 ? d / len : vec2(1.0, 0.0);
    vec2 n = vec2(-dir.y, dir.x);
    float t = aCorner.x * 0.5 + 0.5;
    float padPlane = pad / uCam.z;
    vec2 p = mix(a, b, t) + dir * aCorner.x * padPlane + n * aCorner.y * padPlane;
    vLen = len * uCam.z;
    vL = vec2(t * vLen + aCorner.x * pad, aCorner.y * pad);
    gl_Position = vec4(toClip(p), 0.0, 1.0);
  } else {
    float rp = iS.z * uCam.z;
    float ext = rp + pad;
    vec2 p = iP.xy + aCorner * ext / uCam.z;
    vL = aCorner * ext;
    vLen = rp;
    gl_Position = vec4(toClip(p), 0.0, 1.0);
  }
}
`;

export const SHAPE_FS = HEADER + /* glsl */ `
in vec2 vL;
flat in vec4 vS;
flat in vec4 vC;
flat in float vLen;
out vec4 o;
void main() {
  float hw = vS.x * 0.5;
  float dist;
  if (vS.y < 0.5) {
    float along = clamp(vL.x, 0.0, vLen);
    dist = length(vec2(vL.x - along, vL.y));
  } else if (vS.y < 1.5) {
    dist = max(length(vL) - vLen, 0.0);
    hw = max(hw, 0.0);
  } else {
    dist = abs(length(vL) - vLen);
  }
  float a = 1.0 - smoothstep(hw - 0.6, hw + 0.6, dist);
  if (vS.w > 0.0) a += exp(-max(dist - hw, 0.0) / vS.w) * 0.35;
  o = vec4(vC.rgb * vC.a * a, 0.0);
}
`;

// ---------------------------------------------------------------------------
// Post: bloom + tone mapping
// ---------------------------------------------------------------------------
export const DOWNSAMPLE_FS = HEADER + /* glsl */ `
in vec2 vUV;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uKnee;
void main() {
  vec3 c = texture(uTex, vUV + uTexel * vec2(-1.0, -1.0)).rgb
         + texture(uTex, vUV + uTexel * vec2( 1.0, -1.0)).rgb
         + texture(uTex, vUV + uTexel * vec2(-1.0,  1.0)).rgb
         + texture(uTex, vUV + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float w = smoothstep(uKnee * 0.3, uKnee, l);
  o = vec4(c * w, 1.0);
}
`;

export const BLUR_FS = HEADER + /* glsl */ `
in vec2 vUV;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec3 c = texture(uTex, vUV).rgb * 0.227027;
  c += texture(uTex, vUV + uDir * 1.3846154).rgb * 0.3162162;
  c += texture(uTex, vUV - uDir * 1.3846154).rgb * 0.3162162;
  c += texture(uTex, vUV + uDir * 3.2307692).rgb * 0.0702703;
  c += texture(uTex, vUV - uDir * 3.2307692).rgb * 0.0702703;
  o = vec4(c, 1.0);
}
`;

export const COMPOSITE_FS = HEADER + /* glsl */ `
in vec2 vUV;
out vec4 o;
uniform sampler2D uScene;
uniform sampler2D uBloomA;
uniform sampler2D uBloomB;
uniform vec2 uViewport;
uniform float uTime;
uniform float uExposure;
uniform float uBloom;
uniform float uFade;
uniform float uSat;
uniform float uGrain;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = texture(uScene, vUV).rgb;
  vec3 bl = texture(uBloomA, vUV).rgb * 0.6 + texture(uBloomB, vUV).rgb * 0.8;
  c += bl * uBloom;
  c = vec3(1.0) - exp(-c * uExposure);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uSat);
  vec2 p = vUV - 0.5;
  p.x *= uViewport.x / uViewport.y;
  c *= mix(1.0, 0.72, smoothstep(0.35, 1.05, length(p)));
  c *= uFade;
  // Grain doubles as dither for the deep gradients.
  float g = hash(vUV * uViewport + fract(uTime * 0.37) * 31.0) - 0.5;
  c += g * uGrain;
  o = vec4(pow(max(c, 0.0), vec3(0.92)), 1.0);
}
`;
