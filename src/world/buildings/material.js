import * as THREE from 'three';

// One MeshStandardMaterial (patched via onBeforeCompile) draws every wall,
// roof, trim and rooftop object of the city, so a chunk of city is ONE draw
// call. Per-vertex attributes select the surface layer (texture array) and a
// facade "style"; windows are NOT modelled but shaded procedurally:
//  · punched / ribbon / curtain-wall window grids aligned to real floor heights
//  · window reveals by exact parallax into a box recess (jambs, sill, head),
//    with the recess casting its own sun shadow onto the glass
//  · glass as a real dielectric (Fresnel, env-map reflections, coated/tinted
//    office glass) with slightly non-coplanar panes (broken reflections)
//  · "interior mapping": a ray-traced room behind every window (walls, floor,
//    ceiling, furniture silhouettes), curtains / blinds / nets on the glass
//  · night: per-window lit/unlit, warm/cool, per-floor office occupancy
//  · shopfronts with generic fascia signs, shutters at night, lobby glazing
//  · analytic box-filtered anti-aliasing: sub-pixel windows fade to their
//    statistical average instead of shimmering (moiré) at distance.
//
// Vertex attributes (see geometry.js):
//   uv    facade/surface coordinates in metres (u along wall, v = height)
//   color tint (sRGB-ish, normalised uint8)
//   aMat  (layer, style, seed 0..255, frame + 8*glass)          uint8
//   aGrid (floor height, bay width, ground-floor height, top of windows) cm, uint16
//   aWin  (window width, window height, sill height) cm + ground style | flags<<4

export const STYLE = {
  PLAIN: 0, PUNCHED: 1, CURTAIN: 2, RIBBON: 3, BLANK: 4, AWNING: 5, LOUVRE: 6, FAN: 7, SOLAR: 8, GLASS: 9,
};
export const GROUND = { NONE: 0, SHOP: 1, LOBBY: 2, BASE: 3, PLAIN: 4 };
export const FLAG = { SURROUND: 1, METAL_SPANDREL: 2, FRENCH: 4, OFFICE: 8 };

const PARS = /* glsl */`
uniform highp sampler2DArray uAlbedoArr;
uniform highp sampler2DArray uNormalArr;
uniform sampler2D uSigns;
uniform float uTile[16];
uniform float uMetal[16];
uniform float uNrm[16];
uniform float uNight;
uniform float uLitScale;
varying vec2 vCUv;
flat varying vec4 vCMat;
flat varying vec4 vCGrid;
flat varying vec4 vCWin;
varying vec3 vCWPos;
varying vec3 vCWNrm;

// tangent frame (world) + window recess state, read again by the light loop
vec3 cT; vec3 cB; vec3 cN;
vec2 cRecP; vec4 cRecRect; float cRecDepth = 0.0;
vec2 cDx; vec2 cDy;
float cCanyon = 0.0; // distance to the building opposite this face (m), 0 = open

struct CitySurf { vec3 alb; float rough; float metal; vec3 n; float glass; vec3 f0; vec3 emi; vec3 inter; float ao; };

const vec3 FRAME[8] = vec3[8](
  vec3(0.80, 0.80, 0.78),   // white uPVC / painted timber
  vec3(0.040, 0.046, 0.052),// anthracite grey (the contemporary default)
  vec3(0.012, 0.012, 0.013),// black
  vec3(0.055, 0.032, 0.018),// dark brown timber
  vec3(0.11, 0.075, 0.045), // bronze anodised
  vec3(0.33, 0.34, 0.35),   // natural aluminium
  vec3(0.42, 0.42, 0.40),   // light grey
  vec3(0.025, 0.06, 0.04)); // dark green (heritage)
const vec3 GLASSF0[4] = vec3[4](vec3(0.075), vec3(0.09, 0.15, 0.16), vec3(0.16, 0.12, 0.085), vec3(0.28, 0.30, 0.32));
const vec3 GLASST[4] = vec3[4](vec3(0.80, 0.86, 0.84), vec3(0.42, 0.58, 0.58), vec3(0.50, 0.42, 0.34), vec3(0.22, 0.24, 0.25));

uint cH(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float hash3(vec3 p) {
  uvec3 q = uvec3(ivec3(floor(p)) + 65536);
  return float(cH(q.x ^ cH(q.y ^ cH(q.z)))) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  float a = hash3(vec3(i, 7.0)), b = hash3(vec3(i + vec2(1.0, 0.0), 7.0));
  float c = hash3(vec3(i + vec2(0.0, 1.0), 7.0)), d = hash3(vec3(i + vec2(1.0, 1.0), 7.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}
// box-filtered pulse train (period 1, pulse [a,b]) over a footprint w: exact AA coverage
float pInt(float x, float a, float b) { return floor(x) * (b - a) + clamp(fract(x), a, b) - a; }
float pulseAA(float x, float w, float a, float b) {
  w = max(w, 1e-4);
  return (pInt(x + 0.5 * w, a, b) - pInt(x - 0.5 * w, a, b)) / w;
}
float boxAA(vec2 p, vec4 r, vec2 f) {
  vec2 a = smoothstep(r.xy - f * 0.5, r.xy + f * 0.5, p);
  vec2 b = 1.0 - smoothstep(r.zw - f * 0.5, r.zw + f * 0.5, p);
  return a.x * a.y * b.x * b.y;
}
float lineAA(float d, float halfW, float f) { return 1.0 - smoothstep(halfW - f * 0.5, halfW + f * 0.5, abs(d)); }

// sun/lamp shadow cast by the window recess onto the glass
float cityRecess(vec3 Lv) {
  if (cRecDepth <= 0.0) return 1.0;
  vec3 Lw = (vec4(Lv, 0.0) * viewMatrix).xyz;
  vec3 Lt = vec3(dot(Lw, cT), dot(Lw, cB), dot(Lw, cN));
  if (Lt.z <= 0.02) return 1.0;
  vec2 q = cRecP + Lt.xy * (cRecDepth / Lt.z);
  vec2 e = min(q - cRecRect.xy, cRecRect.zw - q);
  return smoothstep(-0.012, 0.012, min(e.x, e.y));
}

// Urban-canyon reflections. The environment map only holds sky, but a window
// below the roofline across the street mirrors that building (or the street),
// which is why real street-level glazing reads dark and busy, never white.
// The reflected ray is traced to a virtual opposite street wall cCanyon metres
// away (parcels 13-28 m high with a window grid, sun/sky lit, rooms lit at
// night) or to the ground, and that radiance replaces the sky.
vec3 cityCanyon(vec3 rad, vec3 irr, vec3 Nw) {
  if (cCanyon <= 0.0 || abs(cN.y) > 0.5) return rad;
  vec3 Vw = normalize(cameraPosition - vCWPos);
  vec3 R = reflect(-Vw, Nw);
  float ro = dot(R, cN);
  if (ro < 0.01) return rad;
  float t = cCanyon / ro;
  vec3 hit = vCWPos + R * t;
  float along = dot(hit, cT);
  float pid = floor(along / 17.0);
  float hOpp = 13.0 + 15.0 * hash3(vec3(pid, cCanyon, 3.0));
  float tg = R.y < -1e-3 ? vCWPos.y / -R.y : 1e9; // distance to the street surface
  float soft = 0.5 + t * 0.03;                     // blurred roofline
  float occ = 1.0 - smoothstep(hOpp - soft, hOpp + soft, hit.y);
  vec2 wc = vec2(along / 2.9, hit.y / 3.2);
  vec2 fw = fwidth(wc);
  if (occ <= 0.001 && tg > t) return rad;
  vec3 sunE = vec3(0.0);
  float sunY = 0.0;
#if NUM_DIR_LIGHTS > 0
  vec3 Ls = normalize((vec4(directionalLights[0].direction, 0.0) * viewMatrix).xyz);
  sunE = directionalLights[0].color * max(dot(-cN, Ls), 0.0) * 0.55; // part-shaded by us
  sunY = max(Ls.y, 0.0);
#endif
  vec3 c;
  if (tg < t) {
    // asphalt + pavement, patchy sun in the canyon; sodium/LED spill at night
    c = vec3(0.075, 0.074, 0.072) * (irr + sunE * sunY * 0.8) * RECIPROCAL_PI + vec3(1.0, 0.72, 0.45) * 0.035 * uNight;
    occ = 1.0;
  } else {
    float hp = hash3(vec3(pid, cCanyon, 5.0));
    vec3 wallC = mix(vec3(0.5, 0.45, 0.38), vec3(0.3, 0.31, 0.33), hp);
    vec2 wf = fract(wc);
    float win = step(0.26, wf.x) * step(wf.x, 0.74) * step(0.3, wf.y) * step(wf.y, 0.86) * step(3.5, hit.y);
    win = mix(win, 0.19, smoothstep(0.35, 0.9, max(fw.x, fw.y))); // sub-pixel → average
    c = wallC * (irr + sunE) * RECIPROCAL_PI * (1.0 - 0.75 * win) + win * rad * 0.12;
    float lit = step(hash3(vec3(floor(wc), cCanyon + 7.0)), 0.32 * uNight);
    c += win * lit * vec3(1.0, 0.72, 0.42) * 0.9;
  }
  return mix(rad, c, occ);
}

// Ray-traced room behind a window (interior mapping).
// p: point on the glass in cell metres (room spans x 0..w, y 0..h), V: tangent-space view dir.
vec3 cityRoom(vec2 p, vec2 cell, vec3 V, float h, float office, float shop, vec3 lamp, out vec3 night) {
#ifdef CITY_LQ
  // phones: flat interior tone instead of the ray-traced room
  night = lamp * 0.45;
  return mix(vec3(0.3, 0.27, 0.23), vec3(0.45, 0.44, 0.42), fract(h * 3.7));
#endif
  float D =mix(mix(4.0, 7.5, office), 6.0, shop) + h * 1.5;
  vec3 ro = vec3(p, 0.0);
  vec3 rd = -V;
  rd.z = min(rd.z, -0.06);
  rd.x = abs(rd.x) < 1e-4 ? 1e-4 : rd.x;
  rd.y = abs(rd.y) < 1e-4 ? 1e-4 : rd.y;
  float ceilH = cell.y - 0.3;
  vec3 t1 = (vec3(0.0, 0.0, -D) - ro) / rd;
  vec3 t2 = (vec3(cell.x, ceilH, 0.0) - ro) / rd;
  vec3 tf = max(t1, t2);
  float t = min(min(tf.x, tf.y), tf.z);
  vec3 hp = ro + rd * t;
  float depth = clamp(-hp.z / D, 0.0, 1.0);
  vec3 wallC = mix(vec3(0.52, 0.49, 0.44), vec3(0.66, 0.65, 0.62), fract(h * 3.7));
  if (fract(h * 7.3) > 0.8) wallC *= vec3(0.85, 0.95, 1.1);
  if (fract(h * 11.9) > 0.88) wallC *= vec3(1.1, 0.85, 0.7);
  vec3 floorC = mix(vec3(0.14, 0.085, 0.05), vec3(0.28, 0.26, 0.24), fract(h * 5.1));
  vec3 c;
  bool ceil_ = false;
  if (t == tf.z) {
    c = wallC;
    // furniture silhouette against the back wall (sofa / shelves / desk)
    float fx0 = fract(h * 5.7) * cell.x * 0.55;
    float fx1 = fx0 + cell.x * (0.25 + fract(h * 9.1) * 0.4);
    float fh = mix(0.8, 2.0, step(0.6, fract(h * 2.9)));
    if (hp.y < fh && hp.x > fx0 && hp.x < fx1) c = mix(vec3(0.04, 0.035, 0.03), vec3(0.3, 0.24, 0.18), fract(h * 13.7));
    // picture / doorway
    if (fract(h * 4.3) > 0.5 && abs(hp.x - cell.x * 0.7) < 0.35 && abs(hp.y - 1.5) < 0.3) c *= vec3(0.6, 0.7, 0.9);
    if (shop > 0.5) {
      // shelving with merchandise: coloured blocks on shelves, varying per unit
      float shelf = step(0.88, fract(hp.y * 2.2));
      vec3 goods = mix(vec3(0.55, 0.5, 0.42), vec3(hash3(vec3(floor(hp.x * 3.0), floor(hp.y * 2.2), h * 91.0)), hash3(vec3(floor(hp.x * 3.0), floor(hp.y * 2.2), h * 91.0 + 3.0)), 0.5) * 0.7, 0.55);
      c = mix(c, mix(goods, vec3(0.75), shelf), step(hp.y, 2.2) * step(0.35, fract(h * 3.7)));
    }
  } else if (t == tf.y) {
    ceil_ = rd.y > 0.0;
    c = ceil_ ? vec3(0.72) : floorC;
  } else {
    c = wallC * 0.82;
  }
  if (office > 0.5 && !ceil_) {
    // desks + screens + partitions band
    if (hp.y > 0.72 && hp.y < 0.78) c = vec3(0.35, 0.33, 0.3);
    else if (hp.y < 0.72 && hp.y > 0.05) c *= 0.35;
    else if (hp.y > 0.78 && hp.y < 1.15 && fract(hp.x * 0.8 + h) < 0.35) c = vec3(0.02);
  }
  float fall = mix(1.0, 0.25, depth);
  night = c * lamp * mix(1.0, 0.55, depth);
  if (ceil_) {
    // light fittings: office panel grid / domestic pendant
    vec2 q = office > 0.5 ? fract(vec2(hp.x / 1.8, hp.z / 1.8)) - 0.5 : (hp.xz - vec2(cell.x * 0.5, -D * 0.45));
    float spot = office > 0.5 ? step(max(abs(q.x), abs(q.y)), 0.18) : exp(-dot(q, q) * 3.0);
    night += lamp * spot * 2.5;
    c += spot * 0.2 * shop;
  }
  return c * fall;
}

void cityFacade(inout CitySurf s, inout vec3 nt, int style, float seed, int pack, vec2 fuv, vec2 f, vec3 V, float bn) {
  float fh = vCGrid.x, bw = vCGrid.y, gh = vCGrid.z, topV = vCGrid.w;
  float ww = vCWin.x, wh = vCWin.y, sill = vCWin.z;
  int gw = int(vCWin.w + 0.5);
  int gstyle = gw & 15;
  int flags = (gw >> 4) & 15; // bits 8-11 carry the canyon width (cityShade)
  int frameI = pack & 7;
  int glassI = (pack >> 3) & 3;
  bool office = (flags & 8) != 0 || style == 2;
  float u = fuv.x, v = fuv.y;
  float px = max(max(f.x, f.y), 1e-4);
  vec3 wall = s.alb;
  vec3 gF0 = GLASSF0[glassI];
  vec3 gT = GLASST[glassI];
  vec3 frC = FRAME[frameI];
  // weathering: splash zone at the base
  s.alb *= mix(0.7, 1.0, smoothstep(0.0, 1.5, v));
  // night: street-lighting wash on the lower facade
  s.emi += wall * vec3(1.0, 0.72, 0.45) * uNight * 0.05 * (1.0 - smoothstep(2.0, 11.0, v));
  if (style == 4) {
    float st = vnoise(vec2(u * 1.3, 3.0)) * vnoise(vec2(u * 0.3, v * 0.08 + seed));
    s.alb *= 1.0 - 0.3 * st;
    return;
  }
  if (v >= topV) return;
  float bseed = seed * 7.0;
  // late evening: 35-80 % of homes lit, offices mostly emptied (cleaners, late teams)
  float litBase = uNight * uLitScale * (0.35 + 0.45 * fract(seed * 0.618 + 0.3)) * (office ? 0.55 : 1.0);

  // ---------------------------------------------------------------- ground floor
  if (v < gh) {
    if (gstyle == 1) {
      float shopW = max(bw * 2.0, 5.0);
      float si = floor(u / shopW);
      float sx = u - si * shopW;
      float hs = hash3(vec3(si, bseed, 5.0));
      float pil = 0.45;
      float signB = gh - 1.15, signT = gh - 0.3, glTop = gh - 1.3, plinth = 0.35;
      s.alb *= 0.8;
      if (sx < pil || sx > shopW - pil) return; // pilaster
      if (v > signB && v < signT) {
        if (hs < 0.82) {
          float idx = floor(hs / 0.82 * 64.0);
          vec2 cu = vec2((sx - pil) / (shopW - 2.0 * pil), (v - signB) / (signT - signB));
          vec2 auv = (vec2(mod(idx, 4.0), floor(idx / 4.0)) + clamp(cu, 0.01, 0.99)) / vec2(4.0, 16.0);
          vec2 ks = vec2(1.0 / ((shopW - 2.0 * pil) * 4.0), 1.0 / ((signT - signB) * 16.0));
          vec4 sg = textureGrad(uSigns, auv, cDx * ks, cDy * ks);
          s.alb = sg.rgb * 0.8;
          s.rough = 0.45;
          nt = vec3(0.0, 0.0, 1.0);
          s.emi += sg.rgb * sg.a * uNight * 3.0 * step(0.25, fract(hs * 17.0));
        } else {
          s.alb = frC * 0.8 + 0.02; s.rough = 0.5; nt = vec3(0.0, 0.0, 1.0);
        }
        return;
      }
      if (v < plinth) { s.alb = vec3(0.05); s.rough = 0.6; return; }
      if (v > glTop) { s.alb = frC; s.rough = 0.45; nt = vec3(0.0, 0.0, 1.0); return; }
      // shop window (+ door) with a lit interior
      bool shut = uNight > 0.55 && fract(hs * 5.3) < 0.45;
      if (shut) {
        float rib = fract(v / 0.09);
        s.alb = vec3(0.32, 0.33, 0.34) * (0.75 + 0.25 * smoothstep(0.0, 0.3, rib));
        s.metal = 0.6; s.rough = 0.5;
        nt = normalize(vec3(0.0, (rib - 0.5) * 0.8, 1.0));
        return;
      }
      float doorL = fract(hs * 3.3) < 0.5 ? pil + 0.15 : shopW - pil - 1.25;
      float mul = min(lineAA(sx - doorL, 0.05, f.x), 1.0);
      mul = max(mul, lineAA(sx - doorL - 1.1, 0.05, f.x));
      mul = max(mul, lineAA(v - 2.35, 0.05, f.y) * step(doorL, sx) * step(sx, doorL + 1.1));
      float mid = (pil + shopW - pil) * 0.5 + (doorL < shopW * 0.5 ? 0.6 : -0.6);
      mul = max(mul, lineAA(sx - mid, 0.04, f.x) * step(6.5, shopW));
      mul = max(mul, 1.0 - boxAA(vec2(sx, v), vec4(pil + 0.06, plinth + 0.06, shopW - pil - 0.06, glTop - 0.06), f));
      vec3 nr;
      vec3 rc = cityRoom(vec2(sx, v), vec2(shopW, gh - 0.4), V, hs, 0.0, 1.0, vec3(1.0, 0.9, 0.75) * 2.0, nr);
      float g = 1.0 - mul;
      s.alb = mix(s.alb, frC, mul);
      s.rough = mix(0.4, 0.03, g);
      s.metal = 0.0;
      nt = vec3(0.0, 0.0, 1.0);
      s.glass = g; s.f0 = vec3(0.07);
      float T = 1.0 - pow(1.0 - clamp(V.z, 0.0, 1.0), 5.0);
      s.inter = rc * g * T * 0.9;
      s.emi += nr * g * T * (0.06 + 0.94 * uNight); // shops keep their lights on by day
      return;
    }
    if (gstyle == 2) {
      // lobby: storey-height glazing on slim mullions
      float cx = fract(u / 1.5) * 1.5;
      float mul = max(lineAA(cx - 0.75, 0.04, f.x), lineAA(v - gh + 0.35, 0.2, f.y));
      mul = max(mul, 1.0 - smoothstep(0.1, 0.1 + f.y, v));
      vec3 nr;
      vec3 rc = cityRoom(vec2(cx, v), vec2(1.5, gh), V, hash3(vec3(floor(u / 1.5), bseed, 3.0)), 1.0, 1.0, vec3(1.0, 0.95, 0.85) * 1.6, nr);
      float g = 1.0 - mul;
      s.alb = mix(s.alb, frC, mul);
      s.rough = mix(0.4, 0.03, g); s.metal = 0.0;
      nt = vec3(0.0, 0.0, 1.0);
      s.glass = g; s.f0 = vec3(0.07);
      float T = 1.0 - pow(1.0 - clamp(V.z, 0.0, 1.0), 5.0);
      s.inter = rc * g * T * 0.9;
      s.emi += nr * g * T * (0.07 + 0.93 * uNight);
      return;
    }
    if (gstyle == 3 || gstyle == 4) {
      if (gstyle == 3) {
        // rusticated base: channelled joints
        float j = fract(v / 0.45);
        float groove = 1.0 - smoothstep(0.0, 0.06, j);
        s.alb *= 0.92 - 0.35 * groove;
        nt = normalize(nt + vec3(0.0, -0.8 * groove, 0.0));
      }
      // entrance doors: roughly one bay in four
      float bi = floor(u / bw);
      float dx = u - bi * bw;
      if (hash3(vec3(bi, bseed, 4.0)) < 0.22 && abs(dx - bw * 0.5) < 0.75 && v < 2.7) {
        float fr = 1.0 - boxAA(vec2(dx, v), vec4(bw * 0.5 - 0.62, 0.0, bw * 0.5 + 0.62, 2.58), f);
        float edge = 1.0 - boxAA(vec2(dx, v), vec4(bw * 0.5 - 0.75, -1.0, bw * 0.5 + 0.75, 2.7), f);
        float panel = boxAA(vec2(dx, v), vec4(bw * 0.5 - 0.45, 1.0, bw * 0.5 + 0.45, 2.3), f);
        s.alb = mix(frC * 0.9 + 0.01, s.alb, edge);
        s.alb = mix(s.alb, vec3(0.02), panel * 0.9);
        s.rough = mix(0.45, 0.1, panel);
        s.glass = panel * 0.7; s.f0 = vec3(0.06);
        nt = mix(vec3(0.0, 0.0, 1.0), nt, edge + fr * 0.0);
        s.emi += vec3(1.0, 0.8, 0.55) * panel * uNight * 0.6;
        return;
      }
      fh = gh; sill = 1.0; wh = gh - 1.9; topV = gh;
      // fall through to window logic below with a single tall floor
    } else {
      return;
    }
  }

  // ---------------------------------------------------------------- upper floors
  float base = v < gh ? 0.0 : gh;
  vec2 cell = vec2(bw, fh);
  vec2 lp = vec2(u, v - base);
  vec2 cid = floor(lp / cell);
  vec2 cp = lp - cid * cell;
  float cellPx = min(bw, fh) / px;
  bool curtain = style == 2;
  bool ribbon = style == 3;
  vec4 rect = curtain ? vec4(-1e4, sill, 1e4, sill + wh)
            : ribbon ? vec4(-1e4, sill, 1e4, sill + wh)
            : vec4((bw - ww) * 0.5, sill, (bw + ww) * 0.5, sill + wh);
  // night occupancy: offices light floor ZONES (a tenant's open-plan area,
  // ~7 bays), with a few late desks elsewhere; homes light single rooms.
  // Office colour temperature is per building (3000 K / 4000 K / 6500 K fit-outs).
  float hFloor = hash3(vec3(cid.y, floor(cid.x / 7.0), bseed + 9.0));
  float hW = hash3(vec3(cid, bseed + 1.0));
  float hR = hash3(vec3(cid, bseed + 2.0));
  float lit = office ? step(hFloor, litBase * 1.05) * step(0.12, hW) + step(hW, litBase * 0.1)
                     : step(hW, litBase);
  lit = min(lit, 1.0);
  float kb = fract(seed * 0.377 + 0.11);
  vec3 ocol = kb < 0.4 ? vec3(1.0, 0.84, 0.64) : kb < 0.78 ? vec3(1.0, 0.94, 0.84) : vec3(0.84, 0.92, 1.0);
  vec3 lcol = office ? ocol
            : hR < 0.55 ? vec3(1.0, 0.68, 0.38) : hR < 0.85 ? vec3(1.0, 0.82, 0.6) : hR < 0.95 ? vec3(0.8, 0.88, 1.0) : vec3(0.45, 0.6, 1.0);
  float lint = (office ? 1.3 : 1.0) + 1.2 * fract(hR * 13.1);

  if (cellPx < 3.0) {
    // far: coverage-weighted average of wall and glazing (no moiré)
    float cx = curtain || ribbon ? 1.0 : pulseAA(u / bw, f.x / bw, rect.x / bw, rect.z / bw);
    float cy = pulseAA(lp.y / fh, f.y / fh, rect.y / fh, rect.w / fh);
    float cov = cx * cy * 0.85;
    if (curtain) cov = 0.93;
    float litAvg = cellPx > 1.2 ? lit : litBase * (office ? 0.8 : 1.0);
    vec3 lavg = cellPx > 1.2 ? lcol : (office ? ocol : vec3(1.0, 0.76, 0.5));
    if (cellPx <= 1.2) lint = office ? 1.9 : 1.6; // expected value, no per-pixel sparkle
    s.alb = curtain ? mix(vColor.rgb * 0.3, wall, 0.3) : s.alb;
    s.glass = cov;
    s.f0 = gF0;
    s.rough = mix(s.rough, 0.06, cov);
    s.metal *= 1.0 - cov;
    nt = mix(nt, vec3(0.0, 0.0, 1.0), cov);
    s.inter = vec3(0.3) * gT * cx * cy; // × CITY_DAYLIGHT = dark room average
    s.emi += lavg * lint * litAvg * 0.5 * gT * cx * cy;
    return;
  }
  float nearF = smoothstep(3.0, 8.0, cellPx);
  vec2 fe = f;

  if (curtain) {
    // unitised curtain wall: vision glass + spandrel, mullions at every panel joint
    float mullion = max(lineAA(cp.x, 0.045, f.x), lineAA(cp.x - bw, 0.045, f.x));
    float transom = max(lineAA(cp.y - rect.y, 0.035, f.y), lineAA(cp.y - rect.w, 0.035, f.y));
    float frameM = max(mullion, transom) * nearF;
    float vision = step(rect.y, cp.y) * step(cp.y, rect.w);
    vec3 nr = vec3(0.0);
    vec3 rc = vec3(0.0);
    if (vision > 0.5) rc = cityRoom(cp, cell, V, hR, 1.0, 0.0, lcol * lint * lit, nr);
    // roller blinds
    float drop = fract(hR * 3.7);
    drop = drop < 0.68 ? 0.0 : (drop - 0.68) * 2.6; // ~1/3 of panels, lowered 0-80 %
    float blind = step(rect.w - cp.y, drop * (rect.w - rect.y));
    rc = mix(rc, vec3(0.55, 0.54, 0.5) * 1.9, blind); // blinds sit on the glass: ~full daylight
    nr = mix(nr, vec3(0.55, 0.54, 0.5) * lcol * lint * lit * 0.8, blind);
    bool metalSp = (flags & 2) != 0;
    float T = 1.0 - pow(1.0 - clamp(V.z, 0.0, 1.0), 5.0);
    s.alb = mix(vColor.rgb * (metalSp ? 0.9 : 0.25), frC, frameM);
    s.metal = metalSp && vision < 0.5 ? 0.7 : 0.0;
    s.rough = mix(metalSp && vision < 0.5 ? 0.35 : 0.035, 0.35, frameM);
    float g = (1.0 - frameM) * (metalSp ? vision : 1.0);
    s.glass = g;
    s.f0 = gF0;
    nt = vec3(0.0, 0.0, 1.0);
    // panels are never perfectly coplanar → the iconic broken reflections
    vec2 tilt = vec2(hash3(vec3(cid, bseed + 21.0)), hash3(vec3(cid, bseed + 22.0))) - 0.5;
    nt.xy += tilt * 0.03 * nearF * g;
    s.inter = rc * gT * T * vision * (1.0 - frameM);
    s.emi += nr * gT * T * vision * (1.0 - frameM);
    return;
  }

  // punched & ribbon windows ------------------------------------------------
  float inOpen = boxAA(cp, rect, fe);
  bool surround = (flags & 1) != 0;
  if (surround) {
    vec4 sr = rect + vec4(-0.17, -0.1, 0.17, 0.32);
    float band = boxAA(cp, sr, fe) * (1.0 - inOpen);
    vec3 trim = vec3(0.56, 0.53, 0.47) * (0.9 + 0.2 * bn);
    s.alb = mix(s.alb, trim, band);
    // raised architrave: bevel on its outer edge + lintel cornice
    vec2 dOut = min(cp - sr.xy, sr.zw - cp);
    float edge = band * (1.0 - smoothstep(0.0, 0.04, min(dOut.x, dOut.y)));
    vec3 bev = vec3(cp.x < (sr.x + sr.z) * 0.5 ? -0.6 : 0.6, 0.0, 0.8);
    if (dOut.y < dOut.x) bev = vec3(0.0, cp.y < (sr.y + sr.w) * 0.5 ? -0.6 : 0.6, 0.8);
    nt = mix(nt, bev, edge * nearF);
    float cap = boxAA(cp, vec4(sr.x - 0.08, sr.w - 0.1, sr.z + 0.08, sr.w), fe);
    s.alb = mix(s.alb, trim * 1.05, cap);
    nt = mix(nt, vec3(0.0, 0.55, 0.83), cap * nearF);
  }
  if (!ribbon) {
    // projecting sill
    vec4 sl = vec4(rect.x - 0.06, rect.y - 0.06, rect.z + 0.06, rect.y);
    float sm = boxAA(cp, sl, fe);
    s.alb = mix(s.alb, surround ? vec3(0.5, 0.48, 0.43) : mix(frC, vec3(0.3), 0.5), sm);
    nt = mix(nt, vec3(0.0, -0.45, 0.9), sm * nearF);
    // rain streaks from the sill ends
    if (cp.y < rect.y && cp.x > rect.x - 0.1 && cp.x < rect.z + 0.1) {
      float dy = rect.y - cp.y;
      float st = vnoise(vec2((cp.x + cid.x * 3.1) * 7.0, cid.y * 1.7)) * (1.0 - smoothstep(0.0, 1.3, dy));
      s.alb *= 1.0 - 0.28 * st * st;
    }
  }
  if (inOpen <= 0.001) return;

  // ---- inside the opening: exact parallax into the recess
  float d = (surround ? 0.26 : 0.15) * nearF;
  vec3 Vn = V;
  Vn.z = max(Vn.z, 0.08);
  vec2 lg = lp - Vn.xy * (d / Vn.z); // glass point in facade coords
  vec2 gid = floor(lg / cell);
  vec2 pg = lg - gid * cell;
  bool hitGlass = (ribbon || gid.x == cid.x) && gid.y == cid.y && pg.x > rect.x && pg.x < rect.z && pg.y > rect.y && pg.y < rect.w;
  if (!hitGlass && d > 0.0) {
    float sx = ribbon ? 1e4 : (Vn.x > 0.0 ? cp.x - rect.x : rect.z - cp.x) * Vn.z / max(abs(Vn.x), 1e-4);
    float sy = (Vn.y > 0.0 ? cp.y - rect.y : rect.w - cp.y) * Vn.z / max(abs(Vn.y), 1e-4);
    vec3 rn = sx < sy ? vec3(Vn.x > 0.0 ? 1.0 : -1.0, 0.0, 0.0) : vec3(0.0, Vn.y > 0.0 ? 1.0 : -1.0, 0.0);
    vec3 revC = surround ? vec3(0.5, 0.48, 0.43) : wall * 0.92;
    if (rn.y > 0.5) revC = surround ? vec3(0.5, 0.48, 0.43) : mix(frC, vec3(0.3), 0.5); // inner sill
    s.alb = mix(s.alb, revC, inOpen);
    nt = normalize(mix(nt, rn, inOpen));
    s.rough = mix(s.rough, 0.75, inOpen);
    return;
  }
  cRecP = pg; cRecRect = rect; cRecDepth = d;

  // casement frame, mullion, transom
  float fw = 0.06;
  vec4 ir = ribbon ? vec4(-1e4, rect.y + fw, 1e4, rect.w - fw) : rect + vec4(fw, fw, -fw, -fw);
  float frameM = 1.0 - boxAA(pg, ir, fe);
  if (ribbon) frameM = max(frameM, max(lineAA(pg.x, 0.05, f.x), lineAA(pg.x - bw, 0.05, f.x)));
  else if (ww > 1.05) frameM = max(frameM, lineAA(pg.x - (rect.x + rect.z) * 0.5, 0.035, f.x));
  if (wh > 1.9 && !ribbon) frameM = max(frameM, lineAA(pg.y - (rect.y + wh * 0.78), 0.03, f.y));
  frameM = mix(0.15, frameM, nearF);

  // curtains / blinds on the inside of the glass
  float h2 = hash3(vec3(gid, bseed + 11.0));
  vec2 wl = (pg - rect.xy) / max(rect.zw - rect.xy, vec2(1e-3));
  if (ribbon) wl.x = pg.x / bw;
  float cov = 0.0;
  vec3 curC = vec3(0.0);
  float ct = fract(h2 * 7.13);
  if (office) {
    float drop = fract(h2 * 3.7);
    drop = drop < 0.5 ? 0.0 : drop;
    if (1.0 - wl.y < drop) { cov = 1.0; curC = vec3(0.5, 0.5, 0.47); }
  } else if (ct < 0.42) {
    float cw = 0.1 + 0.25 * fract(h2 * 5.1);
    float side = min(wl.x, 1.0 - wl.x);
    if (side < cw) {
      cov = 1.0;
      curC = mix(vec3(0.72, 0.68, 0.6), vec3(0.4, 0.38, 0.36), fract(h2 * 9.3)) * (0.82 + 0.18 * sin(wl.x * 80.0));
    } else if (fract(h2 * 2.3) < 0.4) { cov = 0.6; curC = vec3(0.7, 0.7, 0.68); }
  } else if (ct < 0.68) {
    float drop = 0.12 + 0.7 * fract(h2 * 4.1);
    if (1.0 - wl.y < drop) { cov = 1.0; curC = vec3(0.68, 0.66, 0.62) * (0.8 + 0.2 * step(0.5, fract(pg.y * 22.0))); }
  }
  cov *= nearF;

  vec3 nr;
  vec3 rc = cityRoom(pg, cell, Vn, h2, office ? 1.0 : 0.0, 0.0, lcol * lint * lit, nr);
  vec3 inter = mix(rc, curC * 3.0, cov); // curtains on the glass see ~full daylight
  vec3 nightE = mix(nr, curC * lcol * lint * lit * 0.8, cov);

  float g = inOpen * (1.0 - frameM);
  s.alb = mix(s.alb, frC, inOpen * frameM);
  s.rough = mix(s.rough, mix(0.4, 0.025, 1.0 - frameM), inOpen);
  s.metal *= 1.0 - inOpen;
  s.glass = g;
  s.f0 = gF0;
  nt = normalize(mix(nt, vec3(0.0, 0.0, 1.0), inOpen));
  vec2 tilt = vec2(hash3(vec3(gid, bseed + 21.0)), hash3(vec3(gid, bseed + 22.0))) - 0.5;
  nt.xy += tilt * 0.025 * nearF * g;
  float T = 1.0 - pow(1.0 - clamp(V.z, 0.0, 1.0), 5.0);
  s.inter = inter * gT * T * g;
  s.emi += nightE * gT * T * g;
}

CitySurf cityShade() {
  CitySurf s;
  int layer = int(vCMat.x + 0.5);
  int style = int(vCMat.y + 0.5);
  float seed = vCMat.z;
  int pack = int(vCMat.w + 0.5);
  cCanyon = float((int(vCWin.w + 0.5) >> 8) & 15) * 6.0;
  cN = normalize(vCWNrm);
  cT = abs(cN.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), cN));
  cB = cross(cN, cT);
  vec3 Vw = normalize(cameraPosition - vCWPos);
  vec3 V = vec3(dot(Vw, cT), dot(Vw, cB), dot(Vw, cN));
  vec2 fuv = vCUv;
  cDx = dFdx(fuv); cDy = dFdy(fuv);
  vec2 f = abs(cDx) + abs(cDy);
  float fl = float(layer);
  vec2 tuv = fuv / uTile[layer] + vec2(seed * 0.1373, seed * 0.0711);
  vec4 A = texture(uAlbedoArr, vec3(tuv, fl));
  vec4 Nt = texture(uNormalArr, vec3(tuv, fl));
  s.alb = A.rgb * vColor.rgb;
  s.rough = A.a;
  s.metal = uMetal[layer];
  vec3 nt = Nt.xyz * 2.0 - 1.0;
  nt.xy *= uNrm[layer];
  s.ao = mix(1.0, Nt.a, 0.8);
  s.glass = 0.0; s.f0 = vec3(0.04); s.emi = vec3(0.0); s.inter = vec3(0.0);
  // large-scale tonal breakup (weathering, patch repairs, sun bleaching)
  float bn = vnoise(vCWPos.xz * 0.045 + vec2(vCWPos.y * 0.031, seed));
  s.alb *= 0.86 + 0.26 * bn;
  if (style >= 1 && style <= 4) {
    cityFacade(s, nt, style, seed, pack, fuv, f, V, bn);
  } else if (style == 5) {
    // awning canvas (optionally striped)
    float st = (pack & 1) == 1 ? step(0.5, fract(fuv.x / 0.32)) : 0.0;
    s.alb = mix(vColor.rgb * 0.85, vec3(0.78, 0.76, 0.7), st);
    s.rough = 0.85; s.metal = 0.0;
    nt = vec3(0.0, 0.0, 1.0);
  } else if (style == 6) {
    // louvres: horizontal blades
    float t = fract(fuv.y / 0.12);
    float aa = smoothstep(0.35, 0.8, f.y / 0.12); // blades sub-pixel → average
    s.alb *= mix(mix(0.2, 1.0, smoothstep(0.0, 0.25, t)), 0.7, aa);
    nt = normalize(vec3(0.0, mix(mix(-0.7, 0.2, t), -0.25, aa), 1.0));
  } else if (style == 7) {
    // fan deck on rooftop plant: grilles over axial fans
    vec2 cs = vec2(vCGrid.y);
    vec2 c = mod(fuv, cs) - cs * 0.5;
    float r = length(c), R = vCGrid.x;
    float aa = smoothstep(0.08, 0.25, max(f.x, f.y) / max(R, 0.1));
    if (aa > 0.99) {
      s.alb *= mix(1.0, 0.35, 0.785 * R * R / (cs.x * cs.y) * 4.0);
    } else if (r < R) {
      float a = atan(c.y, c.x);
      float blade = step(0.5, fract(a * 0.95 + r * 2.0));
      s.alb = vec3(0.03) + vec3(0.06) * blade * step(0.15, r / R);
      s.rough = 0.6; s.metal = 0.3;
      float ring = step(0.5, fract(r / 0.05));
      nt = vec3(0.0, 0.0, 1.0);
      s.alb += ring * 0.02;
      s.ao *= 0.6;
    } else if (r < R + 0.05) { s.alb *= 0.6; }
  } else if (style == 8) {
    // PV module: cells under glass, alloy frame
    vec2 pp = fract(fuv / vec2(1.0, 1.65));
    float fr = 1.0 - boxAA(pp, vec4(0.02, 0.012, 0.98, 0.988), f / vec2(1.0, 1.65));
    vec2 cc = fract(fuv / 0.1565);
    float grid = max(lineAA(cc.x, 0.02, f.x / 0.1565), lineAA(cc.y, 0.02, f.y / 0.1565)) * 0.6;
    s.alb = mix(mix(vec3(0.008, 0.012, 0.03), vec3(0.2), grid), vec3(0.4), fr);
    s.rough = mix(0.08, 0.35, fr); s.metal = fr * 0.8;
    s.glass = (1.0 - fr) * 0.9; s.f0 = vec3(0.05);
    s.inter = vec3(0.01, 0.015, 0.04) * (1.0 - fr);
    nt = vec3(0.0, 0.0, 1.0);
  } else if (style == 9) {
    // plain glazing (skylights, glass balustrades, lift-overrun glazing)
    s.glass = 1.0; s.f0 = vec3(0.08); s.rough = 0.05; s.metal = 0.0;
    s.inter = vColor.rgb * 0.4; // what shows through (× the 0.28 room factor)
    nt = vec3(0.0, 0.0, 1.0);
  }
  s.n = normalize(cT * nt.x + cB * nt.y + cN * nt.z);
  return s;
}
`;

export function createCityMaterial(surf, { lowQuality = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true });
  mat.name = 'city';
  const uniforms = {
    uAlbedoArr: { value: surf.albedo },
    uNormalArr: { value: surf.normal },
    uSigns: { value: surf.signs },
    uTile: { value: surf.tile },
    uMetal: { value: surf.metal },
    uNrm: { value: surf.nrm },
    uNight: { value: 0 },
    uLitScale: { value: 1 },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aMat;
attribute vec4 aGrid;
attribute vec4 aWin;
varying vec2 vCUv;
flat varying vec4 vCMat;
flat varying vec4 vCGrid;
flat varying vec4 vCWin;
varying vec3 vCWPos;
varying vec3 vCWNrm;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vCUv = uv;
vCMat = aMat;
vCGrid = aGrid * 0.01;
vCWin = vec4(aWin.xyz * 0.01, aWin.w);
vCWPos = (modelMatrix * vec4(position, 1.0)).xyz;
vCWNrm = normalize(mat3(modelMatrix) * normal);`);
    const lightsBegin = THREE.ShaderChunk.lights_fragment_begin
      .replaceAll('RE_Direct( directLight,', 'directLight.color *= cityRecess( directLight.direction );\n\t\tRE_Direct( directLight,');
    shader.fragmentShader = (lowQuality ? '#define CITY_LQ\n' : '') + shader.fragmentShader
      .replace('#include <clipping_planes_pars_fragment>', '#include <clipping_planes_pars_fragment>\n' + PARS)
      .replace('#include <map_fragment>', 'CitySurf cs = cityShade();\ndiffuseColor.rgb = cs.alb;')
      .replace('#include <color_fragment>', '')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = cs.rough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = cs.metal;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( cs.n, 0.0 ) ).xyz );')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += cs.emi;')
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
material.diffuseContribution *= 1.0 - cs.glass;
material.specularColor = mix( material.specularColor, cs.f0, cs.glass );
material.specularColorBlended = mix( material.specularColorBlended, cs.f0, cs.glass );`)
      .replace('#include <lights_fragment_begin>', lightsBegin)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
radiance = cityCanyon( radiance, irradiance + iblIrradiance, cs.n );
#endif`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.indirectDiffuse *= cs.ao;
// daylight reaching the rooms / curtains behind the glass. A room only sees
// the sky through its own window: interior surfaces get ~1/4 of the facade's
// irradiance (daylight factor), so windows read darker than the wall by day.
totalEmissiveRadiance += cs.inter * ( irradiance + iblIrradiance ) * RECIPROCAL_PI * 0.28;`);
  };
  mat.customProgramCacheKey = () => 'city-bldg-v2' + (lowQuality ? '-lq' : '');
  return mat;
}
