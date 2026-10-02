/**
 * GLSL for the artwork. Plane coordinates: every mind is a disk of radius
 * `tile.z` (normally 1) centred at `tile.xy`; unit positions (in the unit
 * disk) map into it at tile.z. Plane y points down the screen.
 *
 * Colour language: cream, charcoal and grey for ordinary activity; HOT PINK
 * only for the change and the activity it caused.
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

const PALETTE = /* glsl */ `
const vec3 CREAM = vec3(1.0, 0.93, 0.82);
const vec3 BONE = vec3(0.86, 0.85, 0.82);
const vec3 ASH = vec3(0.6, 0.63, 0.68);
const vec3 PINK = vec3(1.0, 0.16, 0.52);
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
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
  vec3 c = mix(vec3(0.016, 0.015, 0.017), vec3(0.004, 0.004, 0.005), smoothstep(0.0, 1.0, r));
  o = vec4(c, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Mind disks: the activity field (cream), the causal field (pink), the mood
// of the interpretation it has settled into, and the rim.
//
// Tile table rows:
//   0  cx cy radius alpha
//   1  highSlot lowSlot hover select
//   2  commitment dominant tintAmt pinkGain
//   3  tint.rgb dim
//   4  warmth coherence erasure agitation
//   5  echo expansion enclosure stimulus
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
  vLocal = aCorner * 1.35;
  gl_Position = vec4(toClip(a.xy + vLocal * a.z), 0.0, 1.0);
  vTile = t;
}
`;

export const TILE_FS = HEADER + PALETTE + /* glsl */ `
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
  vec2 lo = base + vec2(0.5) / size;
  vec2 hi = base + vec2(res - 0.5) / size;
  return 0.25 * (
    texture(tex, clamp(st + vec2(-t.x, -t.y), lo, hi)).rg +
    texture(tex, clamp(st + vec2( t.x, -t.y), lo, hi)).rg +
    texture(tex, clamp(st + vec2(-t.x,  t.y), lo, hi)).rg +
    texture(tex, clamp(st + vec2( t.x,  t.y), lo, hi)).rg);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash11(i.x + i.y * 57.0);
  float b = hash11(i.x + 1.0 + i.y * 57.0);
  float c = hash11(i.x + (i.y + 1.0) * 57.0);
  float d = hash11(i.x + 1.0 + (i.y + 1.0) * 57.0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float tinyRim(float tilePx) { return 1.0 - smoothstep(8.0, 40.0, tilePx); }

void main() {
  vec4 a = texelFetch(uTiles, ivec2(vTile, 0), 0);
  vec4 b = texelFetch(uTiles, ivec2(vTile, 1), 0);
  vec4 c = texelFetch(uTiles, ivec2(vTile, 2), 0);
  vec4 d = texelFetch(uTiles, ivec2(vTile, 3), 0);
  vec4 mA = texelFetch(uTiles, ivec2(vTile, 4), 0);
  vec4 mB = texelFetch(uTiles, ivec2(vTile, 5), 0);
  float commit = c.x;
  float warmth = mA.x;
  float erasure = mA.z;
  float agitation = mA.w;
  float echo = mB.x;
  float expansion = mB.y;
  float enclosure = mB.z;
  float stim = mB.w;

  float r0 = length(vLocal);
  float ang = atan(vLocal.y, vLocal.x);
  // Fear: an unstable boundary. Distance: the disk breathes outward.
  float wob = agitation * 0.022 * sin(ang * 9.0 + uTime * 6.0) * sin(ang * 4.0 - uTime * 3.7);
  float r = r0 / (1.0 + wob + expansion * 0.025 * sin(uTime * 0.6));
  float px = max(fwidth(r0), 1e-5);
  float tilePx = 1.0 / px;
  if (r0 > 1.35) discard;

  vec2 uv = vLocal * 0.5 + 0.5;
  vec2 f = vec2(0.0);
  if (b.x >= 0.0) f = atlas(uHigh, uHighGrid, b.x, uv);
  else if (b.y >= 0.0) f = atlas(uLow, uLowGrid, b.y, uv);
  float act = f.x;
  float pink = f.y * c.w;

  // Loss: parts of the picture are wearing away.
  float wear = 1.0;
  if (erasure > 0.0) {
    float n = vnoise(vLocal * 5.0 + vec2(0.0, uTime * 0.05));
    wear = 1.0 - erasure * smoothstep(0.35, 0.75, n) * 0.85;
  }

  vec3 deep = vec3(0.022, 0.021, 0.024);
  vec3 col = deep * (1.0 + 0.5 * (1.0 - smoothstep(0.0, 0.9, r)));
  vec3 fog = mix(BONE, d.rgb, c.z * 0.75);
  fog = mix(fog, fog * vec3(1.08, 0.98, 0.86), warmth * 0.6);
  col += fog * pow(act, 1.25) * 0.26 * wear;
  // Nostalgia: the same light, echoed in faint rings.
  if (echo > 0.0) {
    float e = sin(r * 34.0 - uTime * 0.9) * 0.5 + 0.5;
    col += fog * echo * 0.035 * e * smoothstep(1.0, 0.25, r);
  }
  // Safety: an enclosing glow just inside the rim.
  col += fog * enclosure * 0.09 * exp(-abs(r - 0.93) * 18.0);
  // The image at the centre, seen through a faint window.
  col += BONE * stim * 0.03 * smoothstep(0.26, 0.1, r);
  // Causal field.
  col += PINK * pink * 0.42;

  col *= mix(1.0, 0.5, smoothstep(0.55, 1.0, r));
  col *= mix(1.0, 0.3, d.w);

  float inside = 1.0 - smoothstep(1.0 - px, 1.0 + px, r);
  float hover = b.z;
  float select = b.w;
  vec3 rimCol = mix(vec3(0.62, 0.6, 0.58), d.rgb, c.z);
  float rimW = px * (1.0 + select * 1.3);
  float rim = exp(-abs(r - 1.0) / rimW) * (0.12 + 0.45 * hover + 0.6 * select + (0.22 + 0.4 * tinyRim(tilePx)) * c.z * commit);
  if (echo > 0.0) rim += exp(-abs(r - 1.06) / rimW) * 0.12 * echo + exp(-abs(r - 1.12) / rimW) * 0.06 * echo;
  float halo = r > 1.0 ? exp(-(r - 1.0) * 10.0) * (0.03 + 0.07 * hover + 0.1 * select + 0.05 * enclosure) : 0.0;
  // Very small minds: let the interpretation's colour carry them.
  float tiny = 1.0 - smoothstep(6.0, 26.0, tilePx);
  col += mix(BONE * 0.05, d.rgb * 0.42, c.z) * tiny * (0.45 + act);

  vec3 outc = col * inside + rimCol * (rim + halo) * (1.0 - d.w * 0.6);
  o = vec4(outc, inside) * a.w;
}
`;

// ---------------------------------------------------------------------------
// Units: points of light. Per instance: potential, activation, ms since the
// unit last fired (negative while a postponed spike is held back), pink.
// Static per unit (texture uUnits): row 0 x y type group, row 1 tidy x y, hash, ring.
// ---------------------------------------------------------------------------
const UNIT_VS_COMMON = /* glsl */ `
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aU;
layout(location = 2) in float aTile;
uniform sampler2D uTiles;
uniform sampler2D uUnits;
uniform int uN;
uniform float uTime;

vec2 unitPos(int u, vec4 mA, vec4 mB, float flash, out vec4 s0, out vec4 s1) {
  s0 = texelFetch(uUnits, ivec2(u, 0), 0);
  s1 = texelFetch(uUnits, ivec2(u, 1), 0);
  vec2 p = mix(s0.xy, s1.xy, mA.y * 0.7);                       // coherence: forms settle into place
  p *= 1.0 + mB.y * 0.06 - mA.w * 0.05;                          // distance expands, fear contracts
  float h = s1.z * 61.0;
  p += mA.w * (0.006 + 0.012 * flash) * vec2(sin(uTime * 23.0 + h), cos(uTime * 19.0 + h * 1.7)); // fear trembles
  p += mB.y * 0.01 * vec2(sin(uTime * 0.3 + h), cos(uTime * 0.27 + h));                      // distance drifts
  return p;
}
`;

export const UNIT_VS = HEADER + VIEW + PALETTE + UNIT_VS_COMMON + /* glsl */ `
out vec2 vQ;
out vec3 vCol;
out float vFlash;
out float vHeld;
out float vPink;
out float vPx;
out float vAlpha;
out float vCore;
void main() {
  int t = int(aTile);
  vec4 tile = texelFetch(uTiles, ivec2(t, 0), 0);
  vec4 tc = texelFetch(uTiles, ivec2(t, 2), 0);
  vec4 td = texelFetch(uTiles, ivec2(t, 3), 0);
  vec4 mA = texelFetch(uTiles, ivec2(t, 4), 0);
  vec4 mB = texelFetch(uTiles, ivec2(t, 5), 0);
  int u = gl_InstanceID % uN;
  float since = aU.z;
  float held = since < 0.0 ? 1.0 : 0.0;
  float flash = since >= 0.0 && since < 14.0 ? exp(-since / 2.6) : 0.0;
  vec4 s0, s1;
  vec2 p = unitPos(u, mA, mB, flash, s0, s1);
  float type = s0.z;
  float group = s0.w;
  float size = type < 0.5 ? 0.0085 : type < 1.5 ? 0.0095 : 0.0068;
  float pxPerUnit = tile.z * uCam.z;
  float hpx = size * 7.0 * pxPerUnit;
  float grow = max(1.0, 3.0 / hpx);
  vec2 world = tile.xy + p * tile.z + aCorner * size * 7.0 * grow * tile.z;
  gl_Position = vec4(toClip(world), 0.0, 1.0);
  vQ = aCorner * 7.0 * grow;
  vPx = hpx * grow;
  vFlash = flash;
  vHeld = held;
  float pink = clamp(aU.w * tc.w, 0.0, 1.0);
  vPink = pink;

  float dominant = tc.y;
  float commit = tc.x;
  bool isDom = type > 0.5 && type < 1.5 && abs(group - dominant) < 0.5;
  vec3 base = type < 0.5 ? vec3(0.96, 0.92, 0.86) : type < 1.5 ? CREAM : ASH;
  float lvl = type > 1.5 ? 0.06 : 0.085;
  lvl += clamp(aU.x, 0.0, 1.0) * clamp(aU.x, 0.0, 1.0) * 0.16;
  lvl += min(aU.y, 3.0) * 0.12;
  if (isDom) {
    lvl *= 1.0 + 0.7 * commit;
    base = mix(base, td.rgb, 0.45 * commit * tc.z);
  }
  // Loss: what is not the thought fades from view.
  float erase = !isDom ? mA.z * (0.4 + 0.6 * s1.z) : 0.0;
  // Warmth tints everything slightly; distance cools and dims.
  base = mix(base, base * vec3(1.06, 0.97, 0.84), mA.x * 0.5);
  base = mix(base, base * vec3(0.86, 0.94, 1.05), mB.y * 0.6);
  vAlpha = tile.w * (1.0 - erase * 0.85) * (1.0 - mB.y * 0.25) * (1.0 - td.w * 0.75);
  vec3 col = mix(base, PINK, pink);
  vCol = col * (lvl + pink * 0.35);
  vCore = flash;
}
`;

export const UNIT_FS = HEADER + PALETTE + /* glsl */ `
in vec2 vQ;
in vec3 vCol;
in float vFlash;
in float vHeld;
in float vPink;
in float vPx;
in float vAlpha;
in float vCore;
out vec4 o;
uniform float uTime;
void main() {
  float r = length(vQ);
  float core = exp(-r * r * 2.2);
  float glow = exp(-r * 0.75) * 0.1;
  vec3 c = vCol * (core * 1.6 + glow * 2.0);
  // A spike: a white-hot burst and a thin expanding ring.
  if (vFlash > 0.01) {
    vec3 fc = mix(vec3(1.0, 0.97, 0.92), PINK, vPink);
    c += fc * vFlash * (core * 2.4 + exp(-r * 0.55) * 0.35);
    float rr = 1.3 + (1.0 - vFlash) * 3.8;
    float ring = exp(-pow((r - rr) / 0.22, 2.0)) * vFlash * 0.35;
    c += fc * ring;
  }
  // A spike held back: a hot pink pulse, waiting.
  if (vHeld > 0.5) {
    float pulse = 0.6 + 0.4 * sin(uTime * 7.0);
    c += PINK * (core * 1.8 + exp(-pow((r - 2.2) / 0.3, 2.0)) * 0.8 * pulse + exp(-r * 0.4) * 0.25);
  }
  o = vec4(c * vAlpha, 0.0);
}
`;

// Soft dots written into the afterglow buffer.
export const TRAIL_DOT_VS = HEADER + VIEW + PALETTE + UNIT_VS_COMMON + /* glsl */ `
out vec2 vQ;
out vec3 vCol;
uniform float uDeposit;
void main() {
  int t = int(aTile);
  vec4 tile = texelFetch(uTiles, ivec2(t, 0), 0);
  vec4 tc = texelFetch(uTiles, ivec2(t, 2), 0);
  vec4 mA = texelFetch(uTiles, ivec2(t, 4), 0);
  vec4 mB = texelFetch(uTiles, ivec2(t, 5), 0);
  int u = gl_InstanceID % uN;
  float since = aU.z;
  float flash = since >= 0.0 && since < 14.0 ? exp(-since / 3.0) : 0.0;
  vec4 s0, s1;
  vec2 p = unitPos(u, mA, mB, flash, s0, s1);
  float size = 0.016;
  float pxPerUnit = tile.z * uCam.z;
  float grow = max(1.0, 1.6 / (size * pxPerUnit));
  gl_Position = vec4(toClip(tile.xy + p * tile.z + aCorner * size * grow * tile.z), 0.0, 1.0);
  vQ = aCorner;
  float pink = clamp(aU.w * tc.w, 0.0, 1.0);
  // Echo (nostalgia) and erasure (loss) leave longer afterimages.
  float keep = 1.0 + mB.x * 1.5 + mA.z * 0.8;
  vec3 col = mix(CREAM * 0.1, PINK * 0.32, pink) * (flash + 0.08 * min(aU.y, 2.0) + pink * 0.2);
  vCol = col * keep * tile.w * uDeposit / (grow * grow);
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
  // Desaturation spares pink: in the replay, the cause stays in colour.
  float pinkness = clamp((c.r - max(c.g, c.b * 0.9)) * 3.0, 0.0, 1.0) * step(c.g, c.b + 0.08);
  c = mix(vec3(l), c, max(uSat, pinkness));
  vec2 p = vUV - 0.5;
  p.x *= uViewport.x / uViewport.y;
  c *= mix(1.0, 0.7, smoothstep(0.35, 1.05, length(p)));
  c *= uFade;
  float g = hash(vUV * uViewport + fract(uTime * 0.37) * 31.0) - 0.5;
  c += g * uGrain;
  o = vec4(pow(max(c, 0.0), vec3(0.92)), 1.0);
}
`;
