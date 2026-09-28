// Render pipeline: HDR scene → ambient occlusion → bloom → grade/tone-map → screen.
//
// createRenderPipeline(renderer, scene) → {
//   render(camera)        draw the main view to the screen (full viewport)
//   setSize(w, h)         CSS pixel size (renderer.setSize already called by main)
//   setQuality(q)         q is a QUALITY preset object from config.js (has .name)
//   dispose()
//   grade                 live-tweakable look parameters (GRADE below)
//   debugView             null | 'ao' | 'bloom' | 'depth' (verification aid)
// }
// main.js renders the hook-camera picture-in-picture with a plain
// renderer.render() AFTER pipeline.render(), using scissor — render() leaves
// renderer state (autoClear, clear colour, render target → null) restored.
// Tone mapping + exposure are owned by environment.js via
// renderer.toneMapping / renderer.toneMappingExposure; the final pass reads
// both every frame (three injects the matching toneMapping() function).
//
// Why a hand-rolled chain instead of EffectComposer + stock passes:
//  - the scene is drawn once into a 4× MSAA half-float target whose resolved
//    depth texture feeds AO and the sun-occlusion test, so AO needs no second
//    (normal-override) scene render — that would double the draw calls, re-run
//    the shadow map and turn alpha-tested chain-link/grating into solid walls;
//  - EffectComposer ping-pongs two copies of its target (both MSAA here) and
//    every stock pass is a full-resolution read+write. Here AO resolve, bloom
//    add, lens effects, grading, tone mapping and sRGB output are fused into
//    ONE full-screen pass; AO and bloom run at reduced resolution.
//  - bloom is the Jimenez (CoD: AW, SIGGRAPH 2014) 13-tap downsample / tent
//    upsample chain with a Karis-average prefilter: cheaper than
//    UnrealBloomPass and it does not flicker on sub-pixel sun glints from
//    ropes and lattice members.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOShader } from 'three/addons/shaders/GTAOShader.js';

// Per-preset pipeline features. Fields of the same name on the QUALITY preset
// override these (e.g. QUALITY.ultra.msaa = 8), and q.ao === false disables AO.
const FEATURES = {
  low: { msaa: 0, aoScale: 0, aoSamples: 0, bloomLevels: 5, sharpen: 0, flare: false, shafts: false, ca: false },
  medium: { msaa: 4, aoScale: 0, aoSamples: 0, bloomLevels: 6, sharpen: 0, flare: false, shafts: false, ca: true },
  high: { msaa: 4, aoScale: 0.5, aoSamples: 12, bloomLevels: 6, sharpen: 0.2, flare: false, shafts: true, ca: true },
  // ultra runs at pixel ratio 2: half-res AO is already one sample per CSS pixel
  // (full res measured ~4x the cost for no visible gain after the bilateral upsample)
  ultra: { msaa: 4, aoScale: 0.5, aoSamples: 16, bloomLevels: 7, sharpen: 0.3, flare: true, shafts: true, ca: true },
};

// The look, in one place. Scene-referred values act before tone mapping,
// display-referred ones (lift/gamma/gain, grain) after it.
export const GRADE = {
  exposure: 0, // EV on top of renderer.toneMappingExposure
  contrast: 1.07, // log-space slope around 18% grey (pre tone map)
  saturation: 1.05,
  temperature: 0.05, // + warm / − cool white balance
  tint: 0.0, // + magenta / − green
  // gentle split tone, as in most modern game/film grades: a hint of blue in
  // the blacks, warm highlights by pulling blue (not pushing red, which clips)
  lift: [0.0, 0.002, 0.007],
  gamma: [1, 1, 1],
  gain: [1.0, 0.992, 0.965],
  vignette: 0.1, // cos⁴-style optical fall-off, 0 = off
  grain: 0.02, // film grain amplitude in the mid-tones (display space)
  chromaticAberration: 0.9, // lateral CA in pixels at the frame corners
  sharpen: null, // null → per-preset default
  bloomStrength: 0.3,
  bloomThreshold: 1.3, // exposed luminance (1 ≈ where ACES approaches white); the blue sky sits near 1
  // At night the camera is adapted to a far darker world, so windows, lamps
  // and beacons read as glowing sources: lower threshold, a little more glow.
  // Blended by the sun light's intensity (day → night).
  bloomThresholdNight: 1.0, // lit windows sit at ~0.3-0.7 exposed: they glow only where genuinely bright
  bloomStrengthNight: 0.4,
  bloomKnee: 0.8,
  bloomClamp: 4, // exposed luminance cap per pixel: the sky around the sun must not veil the whole city
  bloomScatter: 0.65, // 0 = tight glow, 1 = wide haze
  bloomScatterNight: 0.75, // night air + a wide-open lens: lamps and headlights get a softer, wider halo
  aoIntensity: 1.0,
  aoRadius: 2.4, // metres — grounds site objects and building bases
  aoThickness: 2.0, // metres — deeper samples are ignored (no halos behind the jib)
  aoDistanceExponent: 1.6,
  aoPower: 1.6, // contrast of the occlusion term (pow)
  aoFade: [110, 320], // metres — depth precision runs out, fog takes over
  aoSunlit: 0.45, // AO kept on brightly sunlit pixels (AO only occludes sky/indirect light)
  flare: 1.0,
  shafts: 0.28, // crepuscular rays through the lattice / between towers when facing the sun
};

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// 5×5 magic square → 25 well-spread GTAO slice rotations (+ radius jitter
// from the transposed square); a symmetric 5×5 bilateral box removes the pattern.
function aoNoiseTexture() {
  const M = [17, 24, 1, 8, 15, 23, 5, 7, 14, 16, 4, 6, 13, 20, 22, 10, 12, 19, 21, 3, 11, 18, 25, 2, 9];
  const data = new Uint8Array(25 * 4);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const i = y * 5 + x;
      const a = (2 * Math.PI * (M[i] - 1)) / 25;
      data[i * 4] = (Math.cos(a) * 0.5 + 0.5) * 255;
      data[i * 4 + 1] = (Math.sin(a) * 0.5 + 0.5) * 255;
      data[i * 4 + 2] = 127;
      data[i * 4 + 3] = ((M[x * 5 + y] - 0.5) / 25) * 255;
    }
  }
  const t = new THREE.DataTexture(data, 5, 5);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------ shaders
// Plane-aware bilateral: neighbours are compared with the depth EXTRAPOLATED
// along the local surface slope, not with the centre depth. A plain depth test
// rejects the horizontal neighbours on facades seen at a grazing angle, the
// blur degenerates to a vertical one and the 5-px noise period survives as
// vertical stripes all over the distant towers.
const AO_BLUR_FRAG = /* glsl */`
  uniform sampler2D tAO; // r = ao, g = 1/viewZ (0 = sky)
  varying vec2 vUv;
  vec2 fetchAO(ivec2 q) {
    vec2 s = texelFetch(tAO, clamp(q, ivec2(0), textureSize(tAO, 0) - 1), 0).rg;
    return vec2(s.r, s.g > 0.0 ? 1.0 / s.g : 1e6);
  }
  float slope(float z0, float zm, float zp) {
    // one-sided difference on the smoother side, so a silhouette next door does not tilt the plane
    return abs(zp - z0) < abs(z0 - zm) ? zp - z0 : z0 - zm;
  }
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec2 c = texelFetch(tAO, p, 0).rg;
    if (c.g <= 0.0) { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); return; }
    float z0 = 1.0 / c.g;
    vec2 g = vec2(
      slope(z0, fetchAO(p - ivec2(1, 0)).y, fetchAO(p + ivec2(1, 0)).y),
      slope(z0, fetchAO(p - ivec2(0, 1)).y, fetchAO(p + ivec2(0, 1)).y));
    g = clamp(g, vec2(-0.25 * z0), vec2(0.25 * z0));
    float tol = 0.02 * z0 + 0.1;
    float sum = 0.0, wsum = 0.0;
    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        vec2 s = fetchAO(p + ivec2(x, y));
        float w = max(0.0, 1.0 - abs(s.y - (z0 + dot(vec2(x, y), g))) / tol);
        sum += s.x * w; wsum += w;
      }
    }
    gl_FragColor = vec4(sum / wsum, c.g, 0.0, 1.0);
  }`;

// GTAO, patched for our half-resolution use:
//  - every AO pixel is snapped to the centre of one full-resolution depth
//    texel. Unsnapped, a half-res pixel centre lies exactly on a texel
//    boundary, the nearest-filtered depth comes from the left or the right
//    texel depending on float rounding, the reconstructed position leaves the
//    surface by half a texel of depth slope and oblique facades break up into
//    vertical columns of false self-occlusion;
//  - early out beyond the AO fade distance: the far city (often half the
//    screen from the cab) costs nothing, and it is where depth precision
//    would turn into noise anyway.
const GTAO_VERT = /* glsl */`
  varying vec2 vUvRaw;
  void main() { vUvRaw = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const GTAO_FRAG = GTAOShader.fragmentShader
  .replace('varying vec2 vUv;', 'varying vec2 vUvRaw;\n\t\tvec2 vUv;\n\t\tuniform float maxDistance;')
  .replace('void main() {', `void main() {
			vec2 depthSize = vec2(textureSize(tDepth, 0));
			vUv = (floor(vUvRaw * depthSize) + 0.5) / depthSize;`)
  .replace('vec3 viewNormal = getViewNormal(vUv);',
    `if (-viewPos.z > maxDistance) { gl_FragColor = vec4(1.0, 1.0 / max(-viewPos.z, 1e-3), 0.0, 1.0); return; }
			vec3 viewNormal = getViewNormal(vUv);`);

// 13-tap "CoD" downsample. PREFILTER: first level, Karis-weighted groups kill
// fireflies, then a soft-knee threshold in exposed units keeps bloom to things
// that are genuinely brighter than paper white.
const BLOOM_DOWN_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 texel;
  uniform float exposure, threshold, knee, clampLum;
  varying vec2 vUv;
  vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * texel).rgb; }
  float lumaOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main() {
    vec3 a = tap(vec2(-2, -2)), b = tap(vec2(0, -2)), c = tap(vec2(2, -2));
    vec3 d = tap(vec2(-1, -1)), e = tap(vec2(1, -1));
    vec3 f = tap(vec2(-2, 0)), g = tap(vec2(0, 0)), h = tap(vec2(2, 0));
    vec3 i = tap(vec2(-1, 1)), j = tap(vec2(1, 1));
    vec3 k = tap(vec2(-2, 2)), l = tap(vec2(0, 2)), m = tap(vec2(2, 2));
  #ifdef PREFILTER
    vec3 g0 = (d + e + i + j) * 0.25, g1 = (a + b + f + g) * 0.25, g2 = (b + c + g + h) * 0.25;
    vec3 g3 = (f + g + k + l) * 0.25, g4 = (g + h + l + m) * 0.25;
    float w0 = 0.5 / (1.0 + lumaOf(g0) * exposure), w1 = 0.125 / (1.0 + lumaOf(g1) * exposure);
    float w2 = 0.125 / (1.0 + lumaOf(g2) * exposure), w3 = 0.125 / (1.0 + lumaOf(g3) * exposure);
    float w4 = 0.125 / (1.0 + lumaOf(g4) * exposure);
    vec3 col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    col = min(max(col, 0.0), vec3(6e4));
    // luminance (not max channel): saturated sunlit paint such as the crane
    // yellow must not glow, while lit windows and lamps of similar radiance do
    float br = lumaOf(col) * exposure;
    float rq = clamp(br - threshold + knee, 0.0, 2.0 * knee);
    rq = rq * rq / (4.0 * knee + 1e-4);
    col *= max(rq, br - threshold) / max(br, 1e-4);
    col *= min(1.0, clampLum / max(br, 1e-4));
  #else
    vec3 col = (d + e + i + j) * 0.125 + (a + c + k + m) * 0.03125 + (b + f + h + l) * 0.0625 + g * 0.125;
  #endif
    gl_FragColor = vec4(col, 1.0);
  }`;

const BLOOM_UP_FRAG = /* glsl */`
  uniform sampler2D tHigh, tLow;
  uniform vec2 lowTexel;
  uniform float scatter;
  varying vec2 vUv;
  void main() {
    vec4 o = vec4(1.0, 1.0, -1.0, 0.0) * lowTexel.xyxy;
    vec3 s = texture2D(tLow, vUv - o.xy).rgb + texture2D(tLow, vUv - o.wy).rgb * 2.0 + texture2D(tLow, vUv - o.zy).rgb
      + texture2D(tLow, vUv + o.zw).rgb * 2.0 + texture2D(tLow, vUv).rgb * 4.0 + texture2D(tLow, vUv + o.xw).rgb * 2.0
      + texture2D(tLow, vUv + o.zy).rgb + texture2D(tLow, vUv + o.wy).rgb * 2.0 + texture2D(tLow, vUv + o.xy).rgb;
    gl_FragColor = vec4(mix(texture2D(tHigh, vUv).rgb, s / 16.0, scatter), 1.0);
  }`;

// Fraction of a small window around the sun that sees sky, eased over frames
// (blended into a 1×1 target) so lattice sliding across the sun doesn't pop.
const SUN_VIS_FRAG = /* glsl */`
  #include <packing>
  uniform highp sampler2D tDepth;
  uniform vec2 sunUv, spread;
  uniform float cameraNear, cameraFar, rate;
  varying vec2 vUv;
  void main() {
    float v = 0.0;
    for (int y = -3; y <= 3; y++) {
      for (int x = -3; x <= 3; x++) {
        vec2 uv = sunUv + vec2(x, y) * spread;
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
        float d = textureLod(tDepth, uv, 0.0).x;
      #ifdef USE_REVERSED_DEPTH_BUFFER
        bool sky = d <= 0.0;
      #else
        bool sky = d >= 1.0;
      #endif
        sky = sky || -perspectiveDepthToViewZ(d, cameraNear, cameraFar) > cameraFar * 0.9;
        v += sky ? 1.0 : 0.0;
      }
    }
    gl_FragColor = vec4(vec3(v / 49.0), rate);
  }`;

// Crepuscular rays (GPU Gems 3, ch. 13) at quarter resolution: march from each
// pixel towards the sun and gather the circumsolar sky that is not blocked by
// geometry (depth = far). Gaps in the jib lattice and between towers turn into
// light shafts; the result is added before tone mapping.
const SHAFTS_FRAG = /* glsl */`
  #include <packing>
  uniform sampler2D tScene;
  uniform highp sampler2D tDepth;
  uniform vec2 sunUv;
  uniform float aspect, exposure, time, cameraNear, cameraFar;
  varying vec2 vUv;
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  void main() {
    const int N = 40;
    vec2 delta = (vUv - sunUv) / float(N) * 0.9;
    vec2 p = vUv - delta * hash12(gl_FragCoord.xy + time * 13.0);
    vec3 acc = vec3(0.0);
    float w = 1.0;
    for (int i = 0; i < N; i++) {
      p -= delta;
      vec2 q = clamp(p, 0.0, 1.0);
      float d = textureLod(tDepth, q, 0.0).x;
    #ifdef USE_REVERSED_DEPTH_BUFFER
      bool sky = d <= 0.0;
    #else
      bool sky = d >= 1.0;
    #endif
      sky = sky || -perspectiveDepthToViewZ(d, cameraNear, cameraFar) > cameraFar * 0.9;
      if (sky) {
        // only the sky close to the sun feeds the rays
        float r = length((q - sunUv) * vec2(aspect, 1.0));
        vec3 c = min(textureLod(tScene, q, 0.0).rgb * exposure, vec3(8.0));
        acc += c * w * exp(-r * 7.0);
      }
      w *= 0.965;
    }
    gl_FragColor = vec4(acc / float(N), 1.0);
  }`;

const FINAL_FRAG = /* glsl */`
  #include <packing>
  uniform sampler2D tScene, tBloom, tAO, tSunVis, tShafts;
  uniform float shafts;
  uniform highp sampler2D tDepth;
  uniform vec2 resolution;
  uniform float aspect, exposure, time;
  uniform float cameraNear, cameraFar;
  uniform float aoScale, aoIntensity, aoSunlit;
  uniform vec2 aoFade;
  uniform int fogMode;
  uniform vec3 fogColor;
  uniform vec2 fogParams;
  uniform float bloomStrength;
  uniform float exposureScale, contrast, saturation;
  uniform vec3 whiteBalance, lift, gammaInv, gain;
  uniform float vignette, grain, caPixels, sharpen;
  uniform vec2 sunUv;
  uniform vec3 sunColor;
  uniform float flare;
  uniform int debugView;
  varying vec2 vUv;

  float lumaOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float viewDistance(float d) {
  #if PERSPECTIVE_CAMERA == 1
    return -perspectiveDepthToViewZ(d, cameraNear, cameraFar);
  #else
    return -orthographicDepthToViewZ(d, cameraNear, cameraFar);
  #endif
  }

  #ifdef USE_AO
  // joint-bilateral upsample: bilinear weights × depth similarity, so
  // half-resolution AO stays crisp along silhouettes (no dark fringes).
  float aoAt(float zc) {
    vec2 q = gl_FragCoord.xy * aoScale - 0.5;
    ivec2 b = ivec2(floor(q));
    vec2 f = q - vec2(b);
    ivec2 mx = textureSize(tAO, 0) - 1;
    vec2 s0 = texelFetch(tAO, clamp(b, ivec2(0), mx), 0).rg;
    vec2 s1 = texelFetch(tAO, clamp(b + ivec2(1, 0), ivec2(0), mx), 0).rg;
    vec2 s2 = texelFetch(tAO, clamp(b + ivec2(0, 1), ivec2(0), mx), 0).rg;
    vec2 s3 = texelFetch(tAO, clamp(b + ivec2(1, 1), ivec2(0), mx), 0).rg;
    vec4 ao = vec4(s0.r, s1.r, s2.r, s3.r);
    vec4 z = 1.0 / max(vec4(s0.g, s1.g, s2.g, s3.g), vec4(1e-6));
    vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
    w *= 1.0 / (vec4(0.02) + abs(z - zc) / (0.04 * zc + 0.1));
    float ws = dot(w, vec4(1.0));
    return ws > 1e-5 ? dot(ao, w) / ws : 1.0;
  }
  #endif

  #ifdef USE_FLARE
  // Sun glare: veiling glare around the disk and a few coated-lens ghosts on
  // the axis through the frame centre. No procedural starburst: the HDRI sky
  // photographs already carry the lens's own diffraction spikes, and a second,
  // differently-bladed star on top reads as fake.
  vec3 sunFlare(vec2 uv, float vis) {
    vec2 asp = vec2(aspect, 1.0);
    float r = length((uv - sunUv) * asp);
    float glare = 0.0012 / (r * r + 0.0012) * 0.22 + 0.03 * exp(-r * 6.0);
    vec3 f = sunColor * glare;
    vec2 axis = vec2(0.5) - sunUv;
    const vec3 tints[5] = vec3[5](vec3(0.25, 0.55, 0.35), vec3(0.6, 0.4, 0.2), vec3(0.3, 0.35, 0.7), vec3(0.55, 0.5, 0.3), vec3(0.4, 0.25, 0.55));
    const float pos[5] = float[5](0.55, 1.25, 1.55, 1.85, 2.35);
    const float size[5] = float[5](0.035, 0.07, 0.025, 0.12, 0.05);
    for (int i = 0; i < 5; i++) {
      float gd = length((uv - (sunUv + axis * pos[i])) * asp);
      float disk = smoothstep(size[i], size[i] * 0.55, gd);
      f += sunColor * tints[i] * disk * 0.022;
    }
    return f * vis * flare;
  }
  #endif

  void main() {
    vec2 uv = vUv;
    vec3 raw = texture2D(tScene, uv).rgb;
    vec3 col = raw;

  #ifdef USE_SHARPEN
    // clamped unsharp mask in a luma-compressed space: crisp edges on the
    // lattice and facades without halos around the bright sky.
    vec2 t = 1.0 / resolution;
    vec3 n = texture2D(tScene, uv + vec2(0.0, t.y)).rgb, s = texture2D(tScene, uv - vec2(0.0, t.y)).rgb;
    vec3 e = texture2D(tScene, uv + vec2(t.x, 0.0)).rgb, w = texture2D(tScene, uv - vec2(t.x, 0.0)).rgb;
    vec3 cc = col / (1.0 + lumaOf(col)), nn = n / (1.0 + lumaOf(n)), ss = s / (1.0 + lumaOf(s));
    vec3 ee = e / (1.0 + lumaOf(e)), ww = w / (1.0 + lumaOf(w));
    vec3 mn = min(cc, min(min(nn, ss), min(ee, ww))), mxv = max(cc, max(max(nn, ss), max(ee, ww)));
    vec3 sh = clamp(cc + sharpen * (cc - (nn + ss + ee + ww) * 0.25), mn, mxv);
    col = sh / max(1.0 - lumaOf(sh), 1e-3);
  #endif

  #ifdef USE_CA
    // lateral chromatic aberration grows with r² towards the corners
    vec2 fc = uv - 0.5;
    vec2 off = fc * dot(fc * vec2(aspect, 1.0), fc * vec2(aspect, 1.0)) * caPixels * 2.0 / resolution.x * vec2(1.0, aspect);
    col.r += texture2D(tScene, uv - off).r - raw.r;
    col.b += texture2D(tScene, uv + off).b - raw.b;
  #endif

    float depth = 1.0;
    float dist = 1e9;
  #ifdef USE_DEPTH
    depth = texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).x;
    #ifdef USE_REVERSED_DEPTH_BUFFER
      bool isSky = depth <= 0.0;
    #else
      bool isSky = depth >= 1.0;
    #endif
    if (!isSky) dist = viewDistance(depth);
  #endif

  #ifdef USE_AO
    float ao = 1.0;
    if (dist < aoFade.y) {
      ao = aoAt(dist);
      float amt = aoIntensity * (1.0 - smoothstep(aoFade.x, aoFade.y, dist));
      amt *= mix(1.0, aoSunlit, smoothstep(0.35, 1.1, lumaOf(col) * exposure));
      ao = mix(1.0, ao, amt);
      // AO darkens the surface, not the fog in front of it
      float fogF = 0.0;
      if (fogMode == 1) fogF = smoothstep(fogParams.x, fogParams.y, dist);
      else if (fogMode == 2) fogF = 1.0 - exp(-fogParams.x * fogParams.x * dist * dist);
      else if (fogMode == 3) fogF = 1.0 - exp(-(fogParams.x + fogParams.y * dist) * dist); // aerial perspective (no mist term)
      col = col * ao + fogColor * fogF * (1.0 - ao);
    }
  #endif

  #ifdef USE_BLOOM
    vec3 bloom = texture2D(tBloom, uv).rgb;
    col += bloom * bloomStrength;
  #endif

  #ifdef USE_SHAFTS
    // exposure-normalised rays → back to scene units
    col += texture2D(tShafts, uv).rgb * shafts / max(exposure, 1e-4);
  #endif

  #ifdef USE_FLARE
    float vis = texture2D(tSunVis, vec2(0.5)).r;
    if (vis > 0.002) col += sunFlare(uv, vis);
  #endif

    // optical vignetting (cos⁴ law), applied to scene light like a real lens
    vec2 vc = (uv - 0.5) * vec2(aspect, 1.0);
    float vr2 = dot(vc, vc) * vignette;
    col *= 1.0 / ((1.0 + vr2) * (1.0 + vr2));

    // scene-referred grade: white balance, saturation, log contrast
    col *= whiteBalance * exposureScale;
    float L = lumaOf(col);
    col = max(mix(vec3(L), col, saturation), 0.0);
    // pivot at EXPOSED mid grey, so the curve does not drift darker/brighter as
    // environment.js moves the exposure between day, dusk and night
    float pivot = 0.18 * exposureScale / max(exposure, 1e-4);
    col = pivot * pow(col / pivot + 1e-6, vec3(contrast));

  #ifdef TONE_MAPPING
    col = toneMapping(col);
  #endif
    vec3 o = linearToOutputTexel(vec4(col, 1.0)).rgb;

    // verification views (display values, bypass the grade)
    if (debugView == 1) {
  #ifdef USE_AO
      gl_FragColor = vec4(vec3(aoAt(dist)), 1.0); return;
  #endif
    } else if (debugView == 2) {
  #ifdef USE_BLOOM
      gl_FragColor = vec4(sqrt(texture2D(tBloom, uv).rgb * exposure), 1.0); return;
  #endif
    } else if (debugView == 3) {
      gl_FragColor = vec4(vec3(fract(log2(max(dist, 1e-3)))), 1.0); return;
    }

    // display-referred lift / gamma / gain
    o = clamp(o, 0.0, 1.0);
    o = gain * (o + lift * (1.0 - o));
    o = pow(max(o, 0.0), gammaInv);

    // film grain (strongest in the mid-tones) + TPDF dither against banding in the sky
    vec2 fp = gl_FragCoord.xy + time * vec2(37.0, 17.0);
    float n1 = hash12(fp), n2 = hash12(fp + 71.3);
    float Lo = lumaOf(o);
    o += (n1 - 0.5) * grain * (0.3 + 2.8 * Lo * (1.0 - Lo));
    o += (n1 + n2 - 1.0) / 255.0;

    gl_FragColor = vec4(o, 1.0);
  }`;

// ------------------------------------------------------------------ pipeline
export function createRenderPipeline(renderer, scene) {
  const quad = new FullScreenQuad(null);
  const reversedDepth = !!renderer.capabilities.reversedDepthBuffer;
  const maxSamples = renderer.capabilities.maxSamples || 4;
  const grade = GRADE;
  const bufSize = new THREE.Vector2();
  const prevClear = new THREE.Color();
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const sunDir = new THREE.Vector3();

  let W = 0, H = 0;
  let cfg = { ...FEATURES.high };
  let sceneRT = null;
  let aoRT = null, aoBlurRT = null;
  let sunRT = null;
  let shaftRT = null;
  let bloomDown = [], bloomUp = [];
  let sunLight = null;
  let sunSearch = 0;
  let frame = 0;
  let enabled = true; // false while the preset bypasses post (q.post === false): no targets held
  const stats = { calls: 0, triangles: 0 };
  let perspective = 1;

  const makeRT = (w, h, opts = {}) => new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, ...opts,
  });

  // --- materials
  const aoMat = new THREE.ShaderMaterial({
    name: 'Crane.GTAO',
    defines: {
      ...GTAOShader.defines, NORMAL_VECTOR_TYPE: 0, DEPTH_SWIZZLING: 'x', SAMPLES: 12,
      // pack AO + inverse view distance (sky stays 0 from the clear) for the bilateral passes
      FRAGMENT_OUTPUT: 'vec4(ao, 1.0 / max(-viewPos.z, 1e-3), 0.0, 1.0)',
    },
    uniforms: { ...THREE.UniformsUtils.clone(GTAOShader.uniforms), maxDistance: { value: 300 } },
    vertexShader: GTAO_VERT,
    fragmentShader: GTAO_FRAG,
    blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  });
  aoMat.uniforms.tNoise.value = aoNoiseTexture();

  const aoBlurMat = new THREE.ShaderMaterial({
    name: 'Crane.AOBlur', uniforms: { tAO: { value: null } },
    vertexShader: QUAD_VERT, fragmentShader: AO_BLUR_FRAG, blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  });

  const downUniforms = () => ({
    tSrc: { value: null }, texel: { value: new THREE.Vector2() },
    exposure: { value: 1 }, threshold: { value: 1 }, knee: { value: 0.5 }, clampLum: { value: 4 },
  });
  const prefilterMat = new THREE.ShaderMaterial({
    name: 'Crane.BloomPrefilter', defines: { PREFILTER: '' }, uniforms: downUniforms(),
    vertexShader: QUAD_VERT, fragmentShader: BLOOM_DOWN_FRAG, blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  });
  const downMat = new THREE.ShaderMaterial({
    name: 'Crane.BloomDown', uniforms: downUniforms(),
    vertexShader: QUAD_VERT, fragmentShader: BLOOM_DOWN_FRAG, blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  });
  const upMat = new THREE.ShaderMaterial({
    name: 'Crane.BloomUp',
    uniforms: { tHigh: { value: null }, tLow: { value: null }, lowTexel: { value: new THREE.Vector2() }, scatter: { value: 0.7 } },
    vertexShader: QUAD_VERT, fragmentShader: BLOOM_UP_FRAG, blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  });

  const shaftMat = new THREE.ShaderMaterial({
    name: 'Crane.LightShafts',
    uniforms: {
      tScene: { value: null }, tDepth: { value: null }, sunUv: { value: new THREE.Vector2() },
      aspect: { value: 1 }, exposure: { value: 1 }, time: { value: 0 }, cameraNear: { value: 0.1 }, cameraFar: { value: 1000 },
    },
    vertexShader: QUAD_VERT, fragmentShader: SHAFTS_FRAG, blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  });

  const sunMat = new THREE.ShaderMaterial({
    name: 'Crane.SunVisibility',
    uniforms: {
      tDepth: { value: null }, sunUv: { value: new THREE.Vector2(-9, -9) }, spread: { value: new THREE.Vector2() },
      cameraNear: { value: 0.1 }, cameraFar: { value: 1000 }, rate: { value: 0.35 },
    },
    vertexShader: QUAD_VERT, fragmentShader: SUN_VIS_FRAG,
    transparent: true, blending: THREE.NormalBlending, depthTest: false, depthWrite: false,
  });

  const finalMat = new THREE.ShaderMaterial({
    name: 'Crane.FinalGrade',
    defines: { PERSPECTIVE_CAMERA: 1 },
    uniforms: {
      tScene: { value: null }, tBloom: { value: null }, tAO: { value: null }, tSunVis: { value: null }, tDepth: { value: null },
      resolution: { value: new THREE.Vector2(1, 1) }, aspect: { value: 1 }, exposure: { value: 1 }, time: { value: 0 },
      cameraNear: { value: 0.1 }, cameraFar: { value: 1000 },
      aoScale: { value: 0.5 }, aoIntensity: { value: 1 }, aoSunlit: { value: 0.5 }, aoFade: { value: new THREE.Vector2(100, 300) },
      fogMode: { value: 0 }, fogColor: { value: new THREE.Color() }, fogParams: { value: new THREE.Vector2() },
      bloomStrength: { value: 0.3 },
      exposureScale: { value: 1 }, contrast: { value: 1 }, saturation: { value: 1 },
      whiteBalance: { value: new THREE.Vector3(1, 1, 1) }, lift: { value: new THREE.Vector3() },
      gammaInv: { value: new THREE.Vector3(1, 1, 1) }, gain: { value: new THREE.Vector3(1, 1, 1) },
      vignette: { value: 0 }, grain: { value: 0 }, caPixels: { value: 0 }, sharpen: { value: 0 },
      sunUv: { value: new THREE.Vector2(-9, -9) }, sunColor: { value: new THREE.Color(0, 0, 0) }, flare: { value: 1 },
      tShafts: { value: null }, shafts: { value: 0 },
      debugView: { value: 0 },
    },
    vertexShader: QUAD_VERT, fragmentShader: FINAL_FRAG,
    blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  });

  // --- targets
  function disposeTargets() {
    for (const rt of [sceneRT, aoRT, aoBlurRT, sunRT, shaftRT, ...bloomDown, ...bloomUp]) if (rt) rt.dispose();
    if (sceneRT && sceneRT.depthTexture) sceneRT.depthTexture.dispose();
    sceneRT = aoRT = aoBlurRT = sunRT = shaftRT = null;
    bloomDown = [];
    bloomUp = [];
  }

  function needsDepth() { return cfg.aoScale > 0 || cfg.flare || cfg.shafts; }

  function build() {
    disposeTargets();
    W = Math.max(1, W);
    H = Math.max(1, H);
    const samples = Math.min(cfg.msaa, maxSamples);
    sceneRT = new THREE.WebGLRenderTarget(W, H, {
      type: THREE.HalfFloatType, samples, depthBuffer: true, stencilBuffer: false,
      magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter,
    });
    sceneRT.texture.name = 'Crane.sceneHDR';
    if (needsDepth()) {
      // 32-bit float depth only pays off with a reversed-Z renderer
      const dt = new THREE.DepthTexture(W, H, reversedDepth ? THREE.FloatType : THREE.UnsignedIntType);
      dt.minFilter = dt.magFilter = THREE.NearestFilter;
      sceneRT.depthTexture = dt;
    }
    if (cfg.aoScale > 0) {
      const aw = Math.max(1, Math.round(W * cfg.aoScale)), ah = Math.max(1, Math.round(H * cfg.aoScale));
      const o = { format: THREE.RGFormat, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter };
      aoRT = makeRT(aw, ah, o);
      aoBlurRT = makeRT(aw, ah, o);
    }
    if (cfg.flare) sunRT = makeRT(1, 1, { magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
    if (cfg.shafts) shaftRT = makeRT(Math.ceil(W / 4), Math.ceil(H / 4));
    let bw = Math.ceil(W / 2), bh = Math.ceil(H / 2);
    for (let i = 0; i < cfg.bloomLevels && Math.min(bw, bh) >= 4; i++) {
      bloomDown.push(makeRT(bw, bh));
      if (i > 0) bloomUp.push(makeRT(bloomDown[i - 1].width, bloomDown[i - 1].height));
      bw = Math.ceil(bw / 2);
      bh = Math.ceil(bh / 2);
    }
    for (let i = 0; i < bloomDown.length; i++) bloomDown[i].texture.name = 'Crane.bloomDown' + i;

    // feature switches compile into the final shader
    const d = finalMat.defines;
    const set = (k, on) => { if (on) d[k] = ''; else delete d[k]; };
    set('USE_DEPTH', needsDepth());
    set('USE_AO', cfg.aoScale > 0);
    set('USE_BLOOM', bloomDown.length > 0);
    set('USE_FLARE', cfg.flare);
    set('USE_SHAFTS', !!cfg.shafts);
    set('USE_CA', cfg.ca);
    set('USE_SHARPEN', cfg.sharpen > 0);
    finalMat.needsUpdate = true;
    if (aoMat.defines.SAMPLES !== cfg.aoSamples && cfg.aoSamples > 0) {
      aoMat.defines.SAMPLES = cfg.aoSamples;
      aoMat.needsUpdate = true;
    }
  }

  function syncSize() {
    renderer.getDrawingBufferSize(bufSize);
    const w = Math.max(1, Math.floor(bufSize.x)), h = Math.max(1, Math.floor(bufSize.y));
    if (w !== W || h !== H || !sceneRT) {
      W = w;
      H = h;
      build();
    }
  }

  function findSun() {
    if (sunLight && sunLight.parent) return sunLight;
    sunLight = null;
    if (sunSearch-- > 0) return null;
    sunSearch = 60;
    // environment.js key light: a SunLight (sun by day, moon by night) or a DirectionalLight
    const isKey = (o) => o.isSunLight || o.isDirectionalLight;
    scene.traverse((o) => { if (!sunLight && isKey(o) && o.castShadow) sunLight = o; });
    if (!sunLight) scene.traverse((o) => { if (!sunLight && isKey(o)) sunLight = o; });
    return sunLight;
  }

  // 0 by day → 1 once the sun is ~7° below the horizon (street lights on, sky
  // dark). Read from the TRUE sun direction that environment.js shares with the
  // fog shaders: the key light's intensity alone cannot tell an overcast noon
  // (sun ≈ 0.1) from a moonlit night (moon ≈ 0.12), and a night-level bloom
  // threshold under a bright overcast sky veils the whole frame.
  function nightFactor() {
    const sd = THREE.UniformsLib.fog.fogSunDir;
    if (sd && sd.value && typeof sd.value.y === 'number') return THREE.MathUtils.smoothstep(-sd.value.y, -0.05, 0.12);
    const sun = findSun();
    return 1 - THREE.MathUtils.smoothstep(sun ? sun.intensity : 1, 0.05, 1.0);
  }

  function setCameraDefines(camera) {
    const p = camera.isPerspectiveCamera ? 1 : 0;
    if (p !== perspective) {
      perspective = p;
      aoMat.defines.PERSPECTIVE_CAMERA = p;
      finalMat.defines.PERSPECTIVE_CAMERA = p;
      aoMat.needsUpdate = finalMat.needsUpdate = true;
    }
  }

  function renderQuad(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    quad.render(renderer);
  }

  // --- optional GPU timing per pass: pipeline.profile = true → pipeline.timings (ms, smoothed)
  const gl = renderer.getContext();
  let timer = null, timerTried = false, curQuery = null;
  const queryPool = [], inflight = [], timings = {};
  function tBegin(name) {
    if (!pipeline.profile) return;
    if (!timerTried) { timerTried = true; timer = gl.getExtension('EXT_disjoint_timer_query_webgl2'); }
    if (!timer || curQuery) return;
    const q = queryPool.pop() || gl.createQuery();
    gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
    curQuery = { name, q };
  }
  function tEnd() {
    if (!curQuery) return;
    gl.endQuery(timer.TIME_ELAPSED_EXT);
    inflight.push(curQuery);
    curQuery = null;
  }
  function tCollect() {
    if (!timer || !inflight.length) return;
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
    while (inflight.length) {
      // null = the query never started (e.g. an outer timer query was active):
      // drop it instead of blocking the queue forever
      const avail = gl.getQueryParameter(inflight[0].q, gl.QUERY_RESULT_AVAILABLE);
      if (avail === false && inflight.length < 32) break;
      const { name, q } = inflight.shift();
      if (avail && !disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        timings[name] = timings[name] === undefined ? ms : timings[name] * 0.9 + ms * 0.1;
      }
      queryPool.push(q);
    }
  }

  function updateSun(camera, u) {
    const light = findSun();
    const intensity = light ? light.intensity : 0;
    let onScreen = false;
    if (light && intensity > 0.01) {
      light.getWorldPosition(sunDir);
      if (light.target) sunDir.sub(light.target.getWorldPosition(tmpV2)); // DirectionalLight: towards the target
      sunDir.normalize();
      camera.getWorldDirection(tmpV2);
      if (sunDir.dot(tmpV2) > 0.05) {
        camera.getWorldPosition(tmpV);
        tmpV.addScaledVector(sunDir, 1000).project(camera);
        u.sunUv.value.set(tmpV.x * 0.5 + 0.5, tmpV.y * 0.5 + 0.5);
        onScreen = true;
      }
      // fade the flare as the sun sinks into the haze near the horizon
      const horizon = THREE.MathUtils.smoothstep(sunDir.y, 0.0, 0.12);
      u.sunColor.value.copy(light.color).multiplyScalar(intensity * horizon);
    } else {
      u.sunColor.value.setRGB(0, 0, 0);
    }
    if (!onScreen) u.sunUv.value.set(-9, -9);
    sunMat.uniforms.sunUv.value.copy(u.sunUv.value);
    return onScreen;
  }

  const pipeline = {
    grade,
    debugView: null,
    profile: false, // true → per-pass GPU times (EXT_disjoint_timer_query_webgl2) in .timings
    timings,
    stats, // main scene pass: draw calls / triangles incl. shadow maps
    get config() { return { ...cfg, enabled, samples: sceneRT ? sceneRT.samples : 0, width: W, height: H }; },
    get sceneTarget() { return sceneRT; }, // resolved HDR frame (debug / capture)

    render(camera) {
      syncSize();
      setCameraDefines(camera);
      frame = (frame + 1) % 100000;
      tCollect();

      const oldAutoClear = renderer.autoClear;
      renderer.getClearColor(prevClear);
      const oldClearAlpha = renderer.getClearAlpha();
      renderer.autoClear = true;

      const expo = renderer.toneMappingExposure * Math.pow(2, grade.exposure);
      const night = nightFactor();

      // 1. HDR scene (MSAA resolves colour + depth on unbind)
      tBegin('scene');
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      tEnd();
      // renderer.info resets on every render() call, so keep the scene pass
      // numbers (shadow maps included) here for the perf overlay / QA
      stats.calls = renderer.info.render.calls;
      stats.triangles = renderer.info.render.triangles;
      // ...and let the post quads ADD to renderer.info instead of resetting it,
      // so tooling reading renderer.info.render.* after a frame sees the scene
      // cost (+ ~15 post draws), not the last full-screen triangle
      const oldAutoReset = renderer.info.autoReset;
      renderer.info.autoReset = false;

      const u = finalMat.uniforms;

      // 2. ambient occlusion at reduced resolution from the resolved depth.
      // It fades out before 24-bit depth stops resolving the AO radius
      // (Δz ≈ z²/(near·2²⁴) ≤ 3.5 cm: ~190 m for the cab camera's 5 cm near plane).
      const zPrec = reversedDepth || !camera.isPerspectiveCamera ? Infinity : Math.sqrt(0.035 * camera.near * 16777216);
      const aoFar = Math.min(grade.aoFade[1], zPrec), aoNear = Math.min(grade.aoFade[0], aoFar * 0.4);
      if (aoRT) {
        const au = aoMat.uniforms;
        au.maxDistance.value = aoFar;
        au.tDepth.value = sceneRT.depthTexture;
        au.resolution.value.set(aoRT.width, aoRT.height);
        au.cameraNear.value = camera.near;
        au.cameraFar.value = camera.far;
        au.cameraProjectionMatrix.value.copy(camera.projectionMatrix);
        au.cameraProjectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
        au.cameraWorldMatrix.value.copy(camera.matrixWorld);
        au.radius.value = grade.aoRadius;
        au.thickness.value = grade.aoThickness;
        au.distanceExponent.value = grade.aoDistanceExponent;
        au.distanceFallOff.value = 1;
        au.scale.value = grade.aoPower;
        tBegin('ao');
        renderer.setClearColor(0xff0000, 1); // ao = 1, 1/z = 0 (sky)
        renderQuad(aoMat, aoRT);
        aoBlurMat.uniforms.tAO.value = aoRT.texture;
        renderQuad(aoBlurMat, aoBlurRT);
        renderer.setClearColor(0x000000, 1);
        tEnd();
        u.tAO.value = aoBlurRT.texture;
        u.aoScale.value = aoRT.width / W;
      }

      // 3. bloom: prefilter + 13-tap downsample chain, tent upsample back up
      if (bloomDown.length) {
        tBegin('bloom');
        let src = sceneRT;
        for (let i = 0; i < bloomDown.length; i++) {
          const m = i === 0 ? prefilterMat : downMat;
          m.uniforms.tSrc.value = src.texture;
          m.uniforms.texel.value.set(1 / src.width, 1 / src.height);
          if (i === 0) {
            m.uniforms.exposure.value = expo;
            m.uniforms.threshold.value = THREE.MathUtils.lerp(grade.bloomThreshold, grade.bloomThresholdNight, night);
            m.uniforms.knee.value = Math.max(1e-3, grade.bloomKnee);
            m.uniforms.clampLum.value = grade.bloomClamp;
          }
          renderQuad(m, bloomDown[i]);
          src = bloomDown[i];
        }
        let low = bloomDown[bloomDown.length - 1];
        for (let i = bloomUp.length - 1; i >= 0; i--) {
          upMat.uniforms.tHigh.value = bloomDown[i].texture;
          upMat.uniforms.tLow.value = low.texture;
          upMat.uniforms.lowTexel.value.set(1 / low.width, 1 / low.height);
          upMat.uniforms.scatter.value = THREE.MathUtils.lerp(grade.bloomScatter, grade.bloomScatterNight ?? grade.bloomScatter, night);
          renderQuad(upMat, bloomUp[i]);
          low = bloomUp[i];
        }
        u.tBloom.value = low.texture;
        tEnd();
      }

      // 4. sun: occlusion for the lens glare (ultra), light shafts (high+)
      const sunInFront = (sunRT || shaftRT) ? updateSun(camera, u) : false;
      u.shafts.value = 0;
      if (shaftRT && sunInFront) {
        // fade out as the sun leaves the frame (rays still stream in from just outside it)
        const su = u.sunUv.value;
        const out = Math.max(-su.x, su.x - 1, -su.y, su.y - 1, 0);
        const fade = 1 - THREE.MathUtils.smoothstep(out, 0, 0.35);
        if (fade > 0.001) {
          const sm = shaftMat.uniforms;
          sm.tScene.value = sceneRT.texture;
          sm.tDepth.value = sceneRT.depthTexture;
          sm.sunUv.value.copy(su);
          sm.aspect.value = W / H;
          sm.exposure.value = expo;
          sm.time.value = frame % 61;
          sm.cameraNear.value = camera.near;
          sm.cameraFar.value = camera.far;
          tBegin('shafts');
          renderQuad(shaftMat, shaftRT);
          tEnd();
          u.tShafts.value = shaftRT.texture;
          u.shafts.value = grade.shafts * fade;
        }
      }
      if (sunRT) {
        const su = sunMat.uniforms;
        su.tDepth.value = sceneRT.depthTexture;
        su.spread.value.set(0.0026 / (W / H), 0.0026);
        su.cameraNear.value = camera.near;
        su.cameraFar.value = camera.far;
        renderer.autoClear = false; // blend into last frame's value (temporal ease)
        renderQuad(sunMat, sunRT);
        renderer.autoClear = true;
        u.tSunVis.value = sunRT.texture;
        u.flare.value = grade.flare;
      }

      // 5. fused AO resolve + bloom + lens + grade + tone map + sRGB → screen
      u.tScene.value = sceneRT.texture;
      u.tDepth.value = sceneRT.depthTexture || null;
      u.resolution.value.set(W, H);
      u.aspect.value = W / H;
      u.exposure.value = expo;
      u.time.value = frame % 997;
      u.cameraNear.value = camera.near;
      u.cameraFar.value = camera.far;
      u.aoIntensity.value = grade.aoIntensity;
      u.aoSunlit.value = grade.aoSunlit;
      u.aoFade.value.set(aoNear, aoFar);
      const fog = scene.fog;
      const atmo = THREE.UniformsLib.fog.fogParams; // present when environment.js patched the fog chunks
      if (fog && fog.isFogExp2 && atmo && atmo.value) {
        u.fogMode.value = 3;
        u.fogParams.value.set(fog.density, atmo.value.x);
        u.fogColor.value.copy(fog.color);
      } else if (fog && fog.isFogExp2) {
        u.fogMode.value = 2;
        u.fogParams.value.set(fog.density, 0);
        u.fogColor.value.copy(fog.color);
      } else if (fog && fog.isFog) {
        u.fogMode.value = 1;
        u.fogParams.value.set(fog.near, fog.far);
        u.fogColor.value.copy(fog.color);
      } else u.fogMode.value = 0;
      u.bloomStrength.value = THREE.MathUtils.lerp(grade.bloomStrength, grade.bloomStrengthNight, night);
      u.exposureScale.value = Math.pow(2, grade.exposure);
      u.contrast.value = grade.contrast;
      u.saturation.value = grade.saturation;
      // white balance as a luminance-neutral RGB gain (warm = more red, less blue)
      const t = grade.temperature, g = grade.tint;
      const wb = u.whiteBalance.value.set(1 + 0.14 * t, 1 - 0.06 * g, 1 - 0.14 * t);
      wb.multiplyScalar(1 / (0.2126 * wb.x + 0.7152 * wb.y + 0.0722 * wb.z));
      u.lift.value.fromArray(grade.lift);
      u.gammaInv.value.set(1 / grade.gamma[0], 1 / grade.gamma[1], 1 / grade.gamma[2]);
      u.gain.value.fromArray(grade.gain);
      u.vignette.value = grade.vignette;
      u.grain.value = grade.grain;
      u.caPixels.value = grade.chromaticAberration * (W / Math.max(1, renderer.domElement.clientWidth || W));
      u.sharpen.value = grade.sharpen ?? cfg.sharpen;
      u.debugView.value = { ao: 1, bloom: 2, depth: 3 }[pipeline.debugView] || 0;
      tBegin('final');
      renderQuad(finalMat, null);
      tEnd();

      // restore state for main.js (hook-camera PiP renders straight after)
      renderer.setClearColor(prevClear, oldClearAlpha);
      renderer.autoClear = oldAutoClear;
      renderer.info.autoReset = oldAutoReset;
      renderer.setRenderTarget(null);
    },

    setSize() {
      // drawing-buffer size (CSS size × renderer pixel ratio) is re-read here and
      // lazily in render(), so a pixel-ratio change alone is also picked up
      if (enabled) syncSize();
    },

    setQuality(q) {
      const base = FEATURES[q && q.name] || FEATURES.high;
      const next = { ...base };
      for (const k of Object.keys(base)) if (q && q[k] !== undefined) next[k] = q[k];
      if (q && q.ao === false) next.aoScale = 0;
      if (next.aoScale > 0 && !next.aoSamples) next.aoSamples = 12;
      cfg = next;
      W = H = 0; // force rebuild on next sync
      // main.js bypasses the pipeline when q.post is false: free the (MSAA, HDR)
      // targets now; render() still rebuilds them lazily if it is called anyway
      enabled = !(q && q.post === false);
      if (enabled) syncSize();
      else disposeTargets();
    },

    dispose() {
      disposeTargets();
      for (const m of [aoMat, aoBlurMat, prefilterMat, downMat, upMat, sunMat, shaftMat, finalMat]) m.dispose();
      aoMat.uniforms.tNoise.value.dispose();
      quad.dispose();
      for (const q of queryPool) gl.deleteQuery(q);
      for (const f of inflight) gl.deleteQuery(f.q);
      queryPool.length = inflight.length = 0;
    },
  };

  syncSize();
  return pipeline;
}
