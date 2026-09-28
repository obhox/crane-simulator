// GLSL for the street grid: carriageways (ROAD_SURFACE), raised blocks =
// sidewalks + lot finishes (BLOCK_SURFACE) and the far field beyond the
// detailed city (FAR_SURFACE). All three locate themselves in the grid from
// the world position alone (road centre-line uniforms), so markings, kerbs
// and textures agree with grid.js geometry without any per-vertex data.

export function gridGlsl(nx, nz) {
  return /* glsl */ `
#define NRX ${nx}
#define NRZ ${nz}
uniform float uXs[NRX];  // centre x of the roads running along z (sorted)
uniform float uZs[NRZ];  // centre z of the roads running along x (sorted)
uniform vec4 uD;         // detailed region minX, minZ, maxX, maxZ
uniform vec4 uRoad;      // carriageway half width, sidewalk width, kerb radius, lane width
uniform float uNight;

// interval of v between boundaries: (lo, hi, loIsRoad, hiIsRoad)
vec4 g_cellX(float v) {
  vec4 c = vec4(uD.x, uD.z, 0.0, 0.0);
  for (int i = 0; i < NRX; i++) if (v >= uXs[i]) { c.x = uXs[i]; c.z = 1.0; }
  for (int i = NRX - 1; i >= 0; i--) if (v < uXs[i]) { c.y = uXs[i]; c.w = 1.0; }
  return c;
}
vec4 g_cellZ(float v) {
  vec4 c = vec4(uD.y, uD.w, 0.0, 0.0);
  for (int i = 0; i < NRZ; i++) if (v >= uZs[i]) { c.x = uZs[i]; c.z = 1.0; }
  for (int i = NRZ - 1; i >= 0; i--) if (v < uZs[i]) { c.y = uZs[i]; c.w = 1.0; }
  return c;
}
// same, but the lattice continues with 'sp' spacing beyond the listed roads
vec4 g_cellXFar(float v, float sp) {
  if (v < uXs[0]) { float hi = uXs[0] - floor((uXs[0] - v) / sp) * sp; return vec4(hi - sp, hi, 1.0, 1.0); }
  if (v >= uXs[NRX - 1]) { float lo = uXs[NRX - 1] + floor((v - uXs[NRX - 1]) / sp) * sp; return vec4(lo, lo + sp, 1.0, 1.0); }
  return g_cellX(v);
}
vec4 g_cellZFar(float v, float sp) {
  if (v < uZs[0]) { float hi = uZs[0] - floor((uZs[0] - v) / sp) * sp; return vec4(hi - sp, hi, 1.0, 1.0); }
  if (v >= uZs[NRZ - 1]) { float lo = uZs[NRZ - 1] + floor((v - uZs[NRZ - 1]) / sp) * sp; return vec4(lo, lo + sp, 1.0, 1.0); }
  return g_cellZ(v);
}
float g_nearX(float v) { float b = uXs[0]; for (int i = 1; i < NRX; i++) if (abs(v - uXs[i]) < abs(v - b)) b = uXs[i]; return b; }
float g_nearZ(float v) { float b = uZs[0]; for (int i = 1; i < NRZ; i++) if (abs(v - uZs[i]) < abs(v - b)) b = uZs[i]; return b; }
// rounded box with a radius per quadrant: r4 = (+x+z, +x-z, -x+z, -x-z)
float g_sdBlock(vec2 p, vec2 c, vec2 h, vec4 r4) {
  vec2 q = p - c;
  float r = q.x > 0.0 ? (q.y > 0.0 ? r4.x : r4.y) : (q.y > 0.0 ? r4.z : r4.w);
  vec2 d = abs(q) - h + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
void g_block(vec2 p, out vec4 cx, out vec4 cz, out vec2 bc, out vec2 bh, out vec4 r4) {
  cx = g_cellX(p.x);
  cz = g_cellZ(p.y);
  float hw = uRoad.x;
  vec2 bmin = vec2(cx.x + cx.z * hw, cz.x + cz.z * hw);
  vec2 bmax = vec2(cx.y - cx.w * hw, cz.y - cz.w * hw);
  bc = (bmin + bmax) * 0.5;
  bh = (bmax - bmin) * 0.5;
  r4 = uRoad.z * vec4(cx.w * cz.w, cx.w * cz.z, cx.z * cz.w, cx.z * cz.z);
}
`;
}

// ---------------------------------------------------------------- carriageway
export const ROAD_SURFACE = /* glsl */ `
uniform sampler2D tAsphC, tAsphN, tWornC, tWornN, tConcC, tDirtC;
uniform vec4 uTilesR; // asphalt, worn asphalt, concrete, dirt (m per repeat)
uniform vec3 uAsphTint, uWornTint, uConcTint, uDirtTint;
uniform vec4 uGate;   // site crossover rect (minX, minZ, maxX, maxZ)
uniform float uWet;

void groundSurface(vec3 P, vec2 dpx, vec2 dpy, out vec3 albedo, out float rough, out float metal, out vec3 nW, out float ao) {
  vec2 p = P.xz;
  float fw = max(max(abs(dpx.x), abs(dpy.x)), max(abs(dpx.y), abs(dpy.y)));
  float hw = uRoad.x, lane = uRoad.w;
  vec4 cx, cz; vec2 bc, bh; vec4 r4;
  g_block(p, cx, cz, bc, bh, r4);
  float dk = max(g_sdBlock(p, bc, bh, r4), 0.0); // metres from the kerb face
  float xc = g_nearX(p.x), zc = g_nearZ(p.y);
  float ax = p.x - xc, az = p.y - zc;
  bool onX = abs(az) <= hw + 0.001, onZ = abs(ax) <= hw + 0.001;
  bool inter = onX && onZ;
  bool seg = false;
  // segment frame: s along, a across, t = distance to the junction centre,
  // ap > 0 inside the lane approaching that junction (right-hand traffic)
  float s = 0.0, a = 0.0, t = 99.0, ap = 0.0;
  vec2 segId = vec2(xc, zc);
  if (onX && !onZ) { seg = true; s = p.x; a = az; t = abs(ax); ap = -az * sign(ax); segId = vec2(cx.x, zc); }
  else if (onZ && !onX) { seg = true; s = p.y; a = ax; t = abs(az); ap = ax * sign(az); segId = vec2(xc, cz.x) + 1000.0; }

  vec4 nB = g_noise(p * 0.0047), nM = g_noise(p * 0.037), nS = g_noise(p * 0.23), nF = g_noise(p * 1.7);
  HexT hx = g_hexSetup(p / 3.3, 1.0);
  vec2 wuv = vec2(p.x, -p.y), wdx = vec2(dpx.x, -dpx.y), wdy = vec2(dpy.x, -dpy.y);

  // ---- asphalt: each street segment was resurfaced at a different time
  float age = g_hash12(segId * 0.0137 + 3.1);
  vec2 ua = wuv / uTilesR.x;
  vec3 col = g_hexTex(tAsphC, ua, wdx / uTilesR.x, wdy / uTilesR.x, hx).rgb * uAsphTint;
  vec3 nts = g_hexNrm(tAsphN, ua, wdx / uTilesR.x, wdy / uTilesR.x, hx);
  float worn = smoothstep(0.4, 0.7, age * 0.75 + nM.r * 0.55 - 0.1);
  if (worn > 0.01) {
    vec2 uw = wuv / uTilesR.y;
    vec3 cw = g_hexTex(tWornC, uw, wdx / uTilesR.y, wdy / uTilesR.y, hx).rgb * uWornTint;
    vec3 nw = g_hexNrm(tWornN, uw, wdx / uTilesR.y, wdy / uTilesR.y, hx);
    col = mix(col, cw, worn);
    nts = mix(nts, nw, worn);
  }
  col *= 0.86 + 0.26 * fract(age * 13.7);
  col *= 0.86 + 0.28 * nB.r;
  float rgh = 0.9, met = 0.0;

  // ---- traffic wear: polished wheel paths, oil drip line down each lane centre
  float lanePos = abs(a) - lane * 0.5;
  float wheel = seg ? g_band(abs(lanePos) - 0.85, 0.33, fw) : 0.0;
  float drip = seg ? g_band(lanePos, 0.32, fw) : (inter ? 0.6 : 0.0);
  col *= 1.0 - 0.1 * wheel * (0.6 + 0.8 * nS.g);
  col *= 1.0 - 0.18 * drip * smoothstep(0.3, 0.7, nS.b + nF.a * 0.45);
  rgh -= 0.1 * wheel;

  // ---- tar-sealed cracks on older surfaces
  float crack = g_band(nM.g - 0.5, 0.0035, max(fwidth(nM.g), 1e-4)) + g_band(nS.a - 0.5, 0.004, max(fwidth(nS.a), 1e-4)) * 0.6;
  crack *= smoothstep(0.35, 0.8, worn + age * 0.3);
  col = mix(col, vec3(0.012), g_sat(crack) * 0.85);
  rgh = mix(rgh, 0.4, g_sat(crack));

  // ---- utility trench reinstatements & patch repairs (crisp sawn edges, bitumen seal)
  if (seg && t > 16.0) {
    float cell = floor(s / 47.0);
    vec2 hh = g_hash22(vec2(cell, segId.x * 0.013 + segId.y * 0.029));
    float s0 = (cell + 0.12 + 0.55 * hh.x) * 47.0;
    float pd = 1e3;
    if (hh.y < 0.28) {
      float w = 0.7 + hh.x * 1.6;
      float hlf = hh.y < 0.14 ? hw : hw * 0.5;
      float ac = hh.y < 0.14 ? 0.0 : (hh.x < 0.5 ? -hw * 0.5 : hw * 0.5);
      pd = g_sdBox(vec2(s, a), vec2(s0 + w * 0.5, ac), vec2(w * 0.5, hlf));
    } else if (hh.y < 0.46) {
      float L = 8.0 + hh.x * 22.0;
      pd = g_sdBox(vec2(s, a), vec2(s0 + L * 0.5, (hh.x - 0.5) * hw * 1.3), vec2(L * 0.5, 0.35 + hh.y * 0.4));
    } else if (hh.y < 0.6) {
      pd = g_sdBox(vec2(s, a), vec2(s0, (hh.x - 0.5) * hw), vec2(0.9 + hh.x, 0.7 + hh.y));
    }
    float pin = g_fill(pd, fw);
    float seal = g_band(pd, 0.045, fw);
    col = mix(col, col * vec3(0.66, 0.66, 0.69), pin);
    col = mix(col, vec3(0.015), seal * 0.9);
    rgh = mix(rgh, 0.42, seal);
  }

  // ---- road markings (thermoplastic, worn in the wheel paths)
  // Distances from the junction centre match streets/common.js: pedestrians
  // cross 7.15-7.65 m out (zebra 5.9-8.9 m), traffic halts at 9.5 m (stop
  // line just ahead of it). Parked cars occupy 2.9-4.7 m from the centre line,
  // so a thin parking-strip line at 2.85 m separates them from the 1.75 m lanes.
  float paint = 0.0;
  if (seg) {
    float zone = g_fill(9.7 - t, fw);
    float dashed = mix(1.0, g_dash(s + 1.3, 9.0, 3.0, fw), g_fill(32.0 - t, fw));
    paint += g_band(a, 0.06, fw) * zone * dashed;                         // centre line (solid on the approach)
    paint += g_band(abs(a) - 2.85, 0.05, fw) * g_fill(16.0 - t, fw);      // parking-strip edge
    paint += g_band(t - 9.2, 0.15, fw) * g_fill(-ap, fw) * g_fill(ap - (hw - 0.3), fw); // stop line
    paint += g_band(t - 7.4, 1.5, fw) * g_dash(a + 100.25, 1.0, 0.5, fw) * g_fill(abs(a) - (hw - 0.45), fw); // zebra
    // straight-ahead arrow in each approach lane
    float u = t, v = ap - lane * 0.5;
    float head = max(max(13.0 - u, u - 14.4), abs(v) - 0.42 * (u - 13.0) / 1.4);
    float shaft = max(abs(v) - 0.09, max(14.3 - u, u - 18.5));
    paint += g_fill(min(head, shaft), fw) * step(0.0, ap);
  }
  float wearP = smoothstep(0.15, 0.5, nF.g * 0.7 + nS.a * 0.5) * (1.0 - 0.5 * wheel);
  paint = g_sat(paint) * mix(0.3, 1.0, wearP);
  col = mix(col, vec3(0.6, 0.6, 0.58) * (0.9 + 0.2 * nF.b), paint);
  rgh = mix(rgh, 0.55, paint);

  // ---- manhole covers (+ the square reinstatement they sit in)
  vec2 mc = vec2(1e5);
  if (seg && t > 17.0) {
    float cell = floor(s / 29.0);
    vec2 hh = g_hash22(vec2(cell * 1.7, segId.x * 0.011 - segId.y * 0.017));
    if (hh.x < 0.55) {
      float s0 = (cell + 0.2 + 0.6 * hh.y) * 29.0;
      float a0 = (hh.x < 0.27 ? 1.0 : -1.0) * lane * 0.5 + (hh.y - 0.5) * 0.8;
      mc = onX ? vec2(s0, zc + a0) : vec2(xc + a0, s0);
    }
  } else if (inter) mc = vec2(xc + 1.6, zc - 2.2);
  vec2 lp = p - mc;
  float rr = length(lp);
  if (rr < 1.2) {
    float cover = g_fill(rr - 0.3, fw);
    float frame = g_band(rr - 0.335, 0.035, fw);
    float sq = g_fill(g_sdBox(p, mc, vec2(0.6)), fw) * (1.0 - cover - frame);
    col = mix(col, col * 0.72, sq * 0.8);
    col = mix(col, vec3(0.015), g_band(g_sdBox(p, mc, vec2(0.6)), 0.03, fw) * 0.8);
    float grid = 0.5 + 0.5 * sin(lp.x * 75.0) * sin(lp.y * 75.0);
    float det = 1.0 - smoothstep(0.008, 0.03, fw);
    grid = mix(0.5, smoothstep(0.3, 0.7, grid), det);
    vec3 iron = vec3(0.07, 0.066, 0.062) * (0.7 + 0.6 * grid) * (0.85 + 0.3 * nF.r);
    float m = g_sat(cover + frame);
    col = mix(col, iron, m);
    rgh = mix(rgh, 0.5 - 0.2 * grid, m);
    met = mix(met, 0.55, m);
    nts.xy += vec2(cos(lp.x * 75.0) * sin(lp.y * 75.0), sin(lp.x * 75.0) * cos(lp.y * 75.0)) * 0.35 * cover * det;
  }

  // ---- gully grates in the channel along each kerb
  if (seg && dk < 0.8 && t > 16.0) {
    float cell = floor(s / 31.0);
    float h1 = g_hash12(vec2(cell, segId.x * 0.03 + segId.y * 0.07 + sign(a) * 3.0));
    float s0 = (cell + 0.3 + 0.4 * h1) * 31.0;
    float gd = g_sdBox(vec2(s, dk), vec2(s0, 0.27), vec2(0.38, 0.22));
    float g = g_fill(gd, fw);
    float slots = g_dash(s - s0 + 10.0, 0.075, 0.035, fw);
    col = mix(col, mix(vec3(0.07, 0.066, 0.06), vec3(0.006), slots), g);
    rgh = mix(rgh, 0.5, g);
    met = mix(met, 0.5 * (1.0 - slots), g);
  }

  // ---- kerb channel: grit, leaves, damp
  float grime = 1.0 - smoothstep(0.05, 0.5, dk + (nS.r - 0.5) * 0.35);
  col = mix(col, col * vec3(0.6, 0.56, 0.5) + vec3(0.008, 0.006, 0.003), grime * 0.85);
  float deb = grime * smoothstep(0.66, 0.8, nF.b + nS.g * 0.25);
  col = mix(col, vec3(0.05, 0.035, 0.018), deb * 0.7);
  float damp = g_sat(grime * smoothstep(0.55, 0.75, nM.b + nS.r * 0.3) + uWet * 0.3);
  col *= 1.0 - 0.35 * damp;
  rgh = mix(rgh, 0.1, damp * 0.9);

  // ---- site gate: concrete crossover + mud dragged onto the public road
  vec2 gc = (uGate.xy + uGate.zw) * 0.5, gh = (uGate.zw - uGate.xy) * 0.5;
  float apron = g_fill(g_sdBox(p, gc, gh), fw);
  float mudAmt = 0.0;
  if (abs(p.y - (uGate.y - hw)) < hw + 0.5 || apron > 0.0) {
    float fall = exp(-abs(p.x - gc.x) / 24.0);
    float trk = g_band(abs(lanePos) - 0.85, 0.4, fw) * 0.75 + 0.2;
    mudAmt = fall * trk * smoothstep(0.25, 0.7, nS.g + nF.r * 0.45);
    mudAmt += exp(-length((p - vec2(gc.x, uGate.y)) / vec2(10.0, 5.5))) * smoothstep(0.2, 0.6, nS.b + nF.g * 0.3);
    mudAmt = g_sat(mudAmt + apron * 0.35);
  }
  if (apron > 0.001) {
    vec2 uc = wuv / uTilesR.z;
    vec3 cc = g_hexTex(tConcC, uc, wdx / uTilesR.z, wdy / uTilesR.z, hx).rgb * uConcTint;
    col = mix(col, cc, apron);
    rgh = mix(rgh, 0.8, apron);
  }
  if (mudAmt > 0.01) {
    vec2 ud = wuv / uTilesR.w;
    vec3 cd = g_hexTex(tDirtC, ud, wdx / uTilesR.w, wdy / uTilesR.w, hx).rgb * uDirtTint;
    col = mix(col, cd * 0.8, mudAmt);
    rgh = mix(rgh, 0.6, mudAmt);
    nts.xy *= 1.0 - mudAmt * 0.6;
  }

  albedo = col;
  rough = rgh;
  metal = met;
  nW = g_tsToWorld(normalize(vec3(nts.xy * 0.9, max(nts.z, 0.25))));
  ao = 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.35, dk));
}
`;

// ------------------------------------------------------ sidewalks + lot finishes
export const BLOCK_SURFACE = /* glsl */ `
uniform sampler2D tPaveC, tPaveN, tGrassC, tGrassN, tStoneC, tStoneN, tAsphC, tAsphN, tConcC;
uniform vec4 uTilesB;   // pavers, grass, stone, asphalt
uniform float uTileConc;
uniform vec3 uPaveTint, uGrassTint, uStoneTint, uAsphTint, uConcTint;
uniform vec2 uSiteCell; // (lo x, lo z) of the construction site's block

bool longX(vec2 h) { return h.x >= h.y; }
vec3 g_frameToWorld(vec3 n, vec2 T, vec2 B) { return vec3(T.x, 0.0, T.y) * n.x + vec3(B.x, 0.0, B.y) * n.y + vec3(0.0, n.z, 0.0); }

void groundSurface(vec3 P, vec2 dpx, vec2 dpy, out vec3 albedo, out float rough, out float metal, out vec3 nW, out float ao) {
  vec2 p = P.xz;
  float fw = max(max(abs(dpx.x), abs(dpy.x)), max(abs(dpx.y), abs(dpy.y)));
  vec4 cx, cz; vec2 bc, bh; vec4 r4;
  g_block(p, cx, cz, bc, bh, r4);
  float SW = uRoad.y;
  float dk = -g_sdBlock(p, bc, bh, r4);         // inward distance from the kerb line
  vec2 lh = bh - SW;
  bool hasLot = lh.x > 2.0 && lh.y > 2.0;
  float sdL = hasLot ? g_sdBox(p, bc, lh) : 1e4; // < 0 inside the lot
  float dxE = bh.x - abs(p.x - bc.x), dzE = bh.y - abs(p.y - bc.y);
  vec2 cellId = vec2(cx.x, cz.x);
  bool isSite = distance(cellId, uSiteCell) < 1.0;
  vec4 nB = g_noise(p * 0.0051), nM = g_noise(p * 0.041), nS = g_noise(p * 0.29), nF = g_noise(p * 2.1);
  HexT hg = g_hexSetup(p / 2.4, 0.0);
  HexT hr = g_hexSetup(p / 2.1, 1.0);
  vec2 wuv = vec2(p.x, -p.y), wdx = vec2(dpx.x, -dpx.y), wdy = vec2(dpy.x, -dpy.y);
  vec3 col; vec3 n; float rgh; float met = 0.0; float occ = 1.0;

  if (sdL > 0.0) {
    // ================= sidewalk: 300x600 flags laid parallel to the kerb
    bool alongX = dzE < dxE;
    vec2 T = alongX ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec2 B = alongX ? vec2(0.0, sign(bc.y - p.y)) : vec2(sign(bc.x - p.x), 0.0);
    float su = alongX ? p.x : p.y;
    float sv = alongX ? dzE : dxE;
    vec2 uvP = vec2(su, sv) / uTilesB.x;
    vec2 ddx = vec2(dot(dpx, T), dot(dpx, B)) / uTilesB.x, ddy = vec2(dot(dpy, T), dot(dpy, B)) / uTilesB.x;
    col = g_hexGrid(tPaveC, uvP, ddx, ddy, hg, vec2(3.0)).rgb * uPaveTint;
    vec3 nt = g_hexGridN(tPaveN, uvP, ddx, ddy, hg, vec2(3.0));
    rgh = 0.82;
    // individual flags vary in tone (replaced/stained ones)
    vec2 flag = floor(vec2(su / 0.6 + floor(sv / 0.3) * 0.5, sv / 0.3));
    col *= 0.9 + 0.2 * g_hash12(flag + cellId);
    // kerb stones: 150 mm top, 915 mm units
    float kerb = g_fill(dk - 0.15, fw);
    if (kerb > 0.001) {
      vec2 uc = wuv / uTileConc;
      vec3 kc = g_hexTex(tConcC, uc, wdx / uTileConc, wdy / uTileConc, hr).rgb * uConcTint;
      kc *= 0.9 + 0.2 * g_hash12(vec2(floor(su / 0.915), cellId.x + cellId.y));
      kc = mix(kc, vec3(0.02), g_dash(su + 0.004, 0.915, 0.008, fw) * 0.8);
      col = mix(col, kc, kerb);
      nt = mix(nt, vec3(0.0, 0.0, 1.0), kerb);
      rgh = mix(rgh, 0.75, kerb);
    }
    // tactile blister paving at the pedestrian crossings (buff, 800 mm deep)
    float zr = min(p.y - cz.x, cz.y - p.y), xr = min(p.x - cx.x, cx.y - p.x);
    float zSideRoad = (p.y - cz.x < cz.y - p.y) ? cz.z : cz.w;
    float xSideRoad = (p.x - cx.x < cx.y - p.x) ? cx.z : cx.w;
    float tact = g_fill(dxE - 0.95, fw) * (1.0 - g_fill(dxE - 0.15, fw)) * g_band(zr - 7.4, 1.5, fw) * zSideRoad * xSideRoad;
    tact += g_fill(dzE - 0.95, fw) * (1.0 - g_fill(dzE - 0.15, fw)) * g_band(xr - 7.4, 1.5, fw) * xSideRoad * zSideRoad;
    tact = g_sat(tact);
    if (tact > 0.001) {
      vec2 bl = p / 0.066;
      float det = 1.0 - smoothstep(0.01, 0.03, fw);
      vec2 bn = vec2(cos(bl.x * 6.2832), cos(bl.y * 6.2832)) * 0.35 * det;
      col = mix(col, vec3(0.3, 0.21, 0.085) * (0.9 + 0.2 * nF.r), tact);
      nt = mix(nt, vec3(bn, 1.0), tact);
    }
    // grime: kerb edge, building line, chewing gum, rust drips
    col *= 1.0 - 0.18 * (1.0 - smoothstep(0.15, 0.6, dk));
    col *= 0.85 + 0.3 * nM.r;
    float gum = g_fill(length(fract(p * 1.37) - 0.5) - 0.025, fw) * step(0.85, g_hash12(floor(p * 1.37) + 7.0)) * (1.0 - smoothstep(0.004, 0.012, fw));
    col = mix(col, col * 0.55, gum);
    // small utility covers in the footway
    float cell = floor(su / 17.0);
    float hcv = g_hash12(vec2(cell, cellId.x * 0.1 + cellId.y * 0.3 + (alongX ? 1.0 : 2.0)));
    if (hcv < 0.4 && sdL > 0.3) {
      vec2 cc = vec2((cell + 0.3 + hcv) * 17.0, 1.6 + hcv * 2.0);
      float cd = g_sdBox(vec2(su, sv), cc, vec2(0.3, 0.3));
      float cvr = g_fill(cd, fw);
      col = mix(col, vec3(0.08, 0.075, 0.07), cvr);
      col = mix(col, vec3(0.02), g_band(cd, 0.02, fw));
      met = mix(met, 0.4, cvr);
      rgh = mix(rgh, 0.55, cvr);
    }
    n = g_frameToWorld(normalize(vec3(nt.xy, max(nt.z, 0.3))), T, B);
    occ = mix(0.8, 1.0, smoothstep(0.0, 0.5, sdL));
  } else {
    // ================= lot finish
    // The city is built as European perimeter blocks, so what shows from the
    // cab is the courtyard: a patchwork of back gardens, paved yards, parking
    // and service areas split by garden walls / hedges. Some lots are whole
    // plazas or surface car parks instead.
    float dl = -sdL;
    vec2 lmin = bc - lh;
    vec2 lq = p - lmin;
    float lh0 = g_hash12(cellId * 0.0173 + 5.31);
    float mode = isSite ? 1.0 : (lh0 < 0.72 ? 0.0 : (lh0 < 0.88 ? 2.0 : 3.0)); // 0 courtyards, 1 lawn, 2 plaza, 3 car park
    float fin = mode == 0.0 ? 0.0 : mode == 1.0 ? 0.0 : mode == 2.0 ? 2.0 : 3.0; // 0 lawn 1 pavers 2 stone 3 parking 4 yard
    float wall = 0.0, hedge = 0.0, shed = 0.0, garden = 0.0;
    vec2 pq = lq; // parking frame
    float ph = 0.5;
    vec3 shedCol = vec3(0.1);
    if (mode == 0.0) {
      // Back gardens run from each house's rear wall towards the middle of
      // the block, one narrow plot per house (varied frontages), fenced or
      // hedged, with a shed at the far end; the communal core is a lawn, a
      // residents' car park or a tarmac service yard. The houses themselves
      // (city.js) cover the first ~12-15 m, so the first stretch painted as
      // a patio shows as the paved terrace against the back wall.
      vec2 S2 = lh * 2.0;
      float dW = lq.x, dE = S2.x - lq.x, dS = lq.y, dN = S2.y - lq.y;
      float w = min(min(dW, dE), min(dS, dN));   // depth into the courtyard
      float eid = w == dW ? 0.0 : w == dE ? 1.0 : w == dS ? 2.0 : 3.0;
      float u = eid < 1.5 ? lq.y : lq.x;        // along the building line
      float mi = floor(u / 20.0);
      float sp = 7.0 + 6.0 * g_hash12(vec2(mi, eid) + cellId * 0.071);
      float mu = u - mi * 20.0;
      float sd = step(sp, mu);
      float pu = mu - sd * sp, pw = mix(sp, 20.0 - sp, sd);
      ph = g_hash12(vec2((mi * 2.0 + sd) * 1.37 + eid * 11.0, eid) + cellId * 0.37);
      float G = 22.0 + 12.0 * fract(ph * 5.31);  // garden depth from the lot edge
      if (w < G) {
        garden = 1.0;
        fin = ph < 0.6 ? 0.0 : ph < 0.74 ? 1.0 : ph < 0.8 ? 2.0 : ph < 0.9 ? 4.0 : 0.0;
        if (fract(ph * 2.9) < 0.6 && w < 15.5) fin = 1.0; // terrace
        float k = fract(ph * 7.13);
        float bd = min(min(pu, pw - pu), G - w);
        float b = g_band(bd, k < 0.3 ? 0.35 : 0.05, fw) * step(0.12, k);
        if (k < 0.3) hedge = b; else wall = b * 0.8;
        // garden shed / summer house near the back fence
        if (fract(ph * 3.7) < 0.5) {
          float sdS = g_sdBox(vec2(pu, w), vec2(clamp(pw * fract(ph * 9.1), 1.8, pw - 1.8), G - 2.2), vec2(1.2 + fract(ph * 4.3) * 0.6, 1.0));
          shed = g_fill(sdS, fw);
          wall = max(wall, g_band(sdS, 0.06, fw) * 0.9);
          float kc = fract(ph * 13.1);
          shedCol = kc < 0.4 ? vec3(0.05, 0.05, 0.055) : kc < 0.7 ? vec3(0.1, 0.075, 0.05) : kc < 0.85 ? vec3(0.045, 0.07, 0.05) : vec3(0.2, 0.2, 0.19);
        }
        pq = vec2(min(pu, pw - pu), G - w); // distance to the side / back fence
      } else {
        float cm = fract(lh0 * 13.7);
        fin = cm < 0.6 ? 0.0 : cm < 0.85 ? 3.0 : 4.0;
        wall = g_band(w - G, 0.06, fw) * 0.8;
      }
    }
    vec2 ug = wuv / uTilesB.y;
    if (fin == 0.0) {
      col = g_hexTex(tGrassC, ug, wdx / uTilesB.y, wdy / uTilesB.y, hr).rgb * uGrassTint;
      // the leafy scan is a high-contrast close-up (dark gaps between bright
      // blades); a mown lawn seen from tens of metres is far more even, so pull
      // the texture towards its own mean (top mip) and keep only its structure
      vec3 gMean = textureLod(tGrassC, vec2(0.5), 12.0).rgb * uGrassTint;
      col = mix(gMean, col, 0.42) * (0.9 + 0.2 * nS.r);
      vec3 nt = g_hexNrm(tGrassN, ug, wdx / uTilesB.y, wdy / uTilesB.y, hr);
      float stripe = 0.5 + 0.5 * sin((longX(lh) ? lq.y : lq.x) * 3.14159 / 1.7);
      col *= mix(1.0, 0.93 + 0.14 * stripe, (1.0 - smoothstep(0.1, 0.5, fw)) * (isSite ? 0.0 : mode == 1.0 ? 1.0 : 0.3));
      // dry / yellowed patches, darker shrub beds and moss under trees
      col = mix(col, col * vec3(1.35, 1.15, 0.7), smoothstep(0.55, 0.8, nM.g + nS.r * 0.2) * 0.6);
      if (garden > 0.5) {
        // every garden is kept differently: lush, parched, mossy, neglected
        col *= mix(vec3(0.8, 0.95, 0.78), vec3(1.25, 1.08, 0.72), fract(ph * 17.3));
        float bare = step(0.8, fract(ph * 23.1)) * smoothstep(0.35, 0.65, nS.g + nF.b * 0.4);
        col = mix(col, vec3(0.075, 0.058, 0.04) * (0.8 + 0.4 * nF.r), bare);
        // planting beds along the fences: dark soil with shrubs
        float bed = (1.0 - smoothstep(0.7, 1.3, min(pq.x, pq.y) + (nF.g - 0.5) * 0.8)) * step(0.35, fract(ph * 31.7));
        col = mix(col, mix(vec3(0.045, 0.035, 0.025), vec3(0.02, 0.04, 0.014), smoothstep(0.4, 0.6, nF.a)), bed);
      }
      if (isSite) {
        // rough verge between the hoarding and the neighbours: unmown,
        // tussocky, trampled to bare soil where people cut through
        col *= mix(vec3(1.2, 1.05, 0.7), vec3(0.8, 0.9, 0.75), nS.b);
        float bare = smoothstep(0.55, 0.75, nM.r * 0.6 + nS.g * 0.4 + nF.b * 0.2);
        col = mix(col, vec3(0.085, 0.066, 0.046) * (0.8 + 0.4 * nF.r), bare * 0.85);
        col = mix(col, col * 0.6, smoothstep(0.5, 0.8, nF.g) * 0.5);
      }
      // shrub clumps: 2-4 m bushes (the fine octave only frays their outline;
      // at sub-metre scale it read as camouflage print from the cab)
      float shrub = smoothstep(0.7, 0.74, nS.b * 0.85 + nF.g * 0.15) * (mode == 0.0 ? 1.0 : 0.3);
      col = mix(col, vec3(0.02, 0.035, 0.012) * (0.8 + 0.4 * nF.r), shrub);
      vec2 dir = normalize(lh);
      float dline = abs(dot(p - bc, vec2(-dir.y, dir.x)));
      float path = g_band(dline, 0.35 + nS.b * 0.25, fw) * step(0.5, g_hash12(cellId + 3.0)) * (mode == 1.0 && !isSite ? 1.0 : 0.0);
      col = mix(col, vec3(0.07, 0.055, 0.035), path * 0.8);
      col *= 0.8 + 0.4 * nB.g;
      rgh = 0.95;
      n = g_tsToWorld(normalize(vec3(nt.xy, max(nt.z, 0.3))));
    } else if (fin == 3.0 || fin == 4.0) {
      // surface parking with painted bays / plain tarmac service yard
      vec2 ua = wuv / uTilesB.w;
      col = g_hexTex(tAsphC, ua, wdx / uTilesB.w, wdy / uTilesB.w, hr).rgb * uAsphTint;
      vec3 nt = g_hexNrm(tAsphN, ua, wdx / uTilesB.w, wdy / uTilesB.w, hr);
      col *= 0.85 + 0.3 * nM.r;
      if (fin == 3.0) {
        bool lx = mode == 3.0 ? lh.x >= lh.y : true;
        float lu = lx ? pq.x : pq.y, lv = lx ? pq.y : pq.x;
        float vv = mod(lv - 1.8, 16.0);
        float inBay = g_fill(vv - 5.0, fw) + g_fill(11.0 - vv, fw) * g_fill(vv - 16.0, fw);
        float lines = g_dash(lu + 0.05, 2.5, 0.1, fw) * g_sat(inBay) + g_band(min(vv, 16.0 - vv), 0.05, fw);
        col = mix(col, vec3(0.58), g_sat(lines) * 0.85);
        vec2 bayId = vec2(floor(lu / 2.5), floor((lv - 1.8) / 5.5));
        float dvv = min(abs(vv - 2.3), abs(vv - 13.7));
        float drip = g_fill(length(vec2(lu - (bayId.x + 0.5) * 2.5, dvv) / vec2(0.5, 0.8)) - 1.0, fw) * step(0.4, g_hash12(bayId + cellId));
        col *= 1.0 - 0.35 * drip * g_sat(inBay);
        rgh = mix(0.85, 0.55, drip);
      } else {
        // service yard: patched, stained tarmac, moss creeping in from the edges
        col *= vec3(1.05, 1.03, 1.0) * (0.8 + 0.3 * nS.g);
        col *= 1.0 - 0.3 * smoothstep(0.6, 0.8, nM.b * 0.7 + nF.r * 0.3);
        col = mix(col, vec3(0.04, 0.05, 0.02), smoothstep(0.62, 0.8, nS.a + nF.g * 0.2) * 0.5);
        rgh = 0.85;
      }
      n = g_tsToWorld(normalize(vec3(nt.xy, max(nt.z, 0.3))));
    } else if (fin == 1.0) {
      // paved yard: concrete flags on the world grid
      vec2 up = vec2(p.x, -p.y) / uTilesB.x;
      col = g_hexGrid(tPaveC, up, wdx / uTilesB.x, wdy / uTilesB.x, hg, vec2(3.0)).rgb * uPaveTint * vec3(0.95, 0.95, 0.97);
      vec3 nt = g_hexGridN(tPaveN, up, wdx / uTilesB.x, wdy / uTilesB.x, hg, vec2(3.0));
      col *= 0.8 + 0.35 * nS.a;
      rgh = 0.82;
      n = g_tsToWorld(normalize(vec3(nt.xy, max(nt.z, 0.3))));
    } else {
      // stone plaza: 1 m granite slabs with darker banding every 7.5 m
      vec2 us = vec2(p.x - lmin.x, -(p.y - lmin.y)) / uTilesB.z;
      col = g_hexGrid(tStoneC, us, wdx / uTilesB.z, wdy / uTilesB.z, hg, vec2(3.0)).rgb * uStoneTint;
      vec3 nt = g_hexGridN(tStoneN, us, wdx / uTilesB.z, wdy / uTilesB.z, hg, vec2(3.0));
      col *= 0.9 + 0.2 * g_hash12(floor((p - lmin) / 1.0) + cellId);
      float band = max(g_dash(lq.x + 0.5, 7.5, 1.0, fw), g_dash(lq.y + 0.5, 7.5, 1.0, fw));
      col *= mix(1.0, 0.7, band * (mode == 2.0 ? 1.0 : 0.0));
      col *= 0.85 + 0.3 * nM.b;
      rgh = 0.7;
      n = g_tsToWorld(normalize(vec3(nt.xy, max(nt.z, 0.3))));
    }
    col = mix(col, shedCol * (0.85 + 0.3 * nF.b), shed);
    rgh = mix(rgh, 0.7, shed);
    col = mix(col, vec3(0.02, 0.04, 0.014) * (0.7 + 0.6 * nF.g), hedge);
    col = mix(col, (garden > 0.5 ? vec3(0.09, 0.07, 0.05) : vec3(0.2, 0.19, 0.18)) * (0.85 + 0.3 * nF.b), wall);
    // edging band between footway and lot
    float edge = g_band(dl - 0.12, 0.12, fw);
    col = mix(col, vec3(0.16, 0.155, 0.15) * (0.9 + 0.2 * nF.r), edge);
    occ = mix(0.85, 1.0, smoothstep(0.0, 0.6, dl));
  }
  col *= mix(vec3(1.03, 1.0, 0.97), vec3(0.97, 1.0, 1.03), nB.b);
  albedo = col;
  rough = rgh;
  metal = met;
  nW = n;
  ao = occ;
}
`;

// ------------------------------------------------------------------ far field
// The continuing city seen from 45 m up out to the fog: the street lattice
// carries on (110 m blocks), filled with a procedural suburb (gabled roofs
// whose slopes are lit by the real sun, fake cast shadows, garden trees,
// parks, sheds), fading to fields and hedgerows beyond ~1.7 km. Every pattern
// is box-filtered and faded to its mean by pixel footprint, so it doesn't
// crawl at grazing angles.
export const FAR_SURFACE = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uLampCol;

// returns roof coverage; roofCol/roofN filled when covered
float g_house(vec2 p, vec2 bmin, vec2 bs, vec2 cellId, float fw, out vec3 roofCol, out vec3 roofN) {
  vec2 q = p - bmin;
  float dxE = min(q.x, bs.x - q.x), dzE = min(q.y, bs.y - q.y);
  bool alongX = dzE < dxE;
  float de = min(dxE, dzE);
  float along = alongX ? q.x : q.y;
  float sideId = alongX ? (q.y < bs.y * 0.5 ? 1.0 : 2.0) : (q.x < bs.x * 0.5 ? 3.0 : 4.0);
  float pw = 15.0;
  float pi_ = floor(along / pw);
  float pl = along - pi_ * pw;
  float ph = g_hash12(vec2(pi_ * 1.31 + sideId * 17.0, 0.0) + cellId * 0.071);
  float hwid = 8.5 + ph * 4.0, hdep = 8.0 + fract(ph * 7.31) * 3.5;
  vec2 hc = vec2(pw * 0.5 + (fract(ph * 3.7) - 0.5) * 2.0, 6.5 + hdep * 0.5);
  float sd = g_sdBox(vec2(pl, de), hc, vec2(hwid, hdep) * 0.5);
  float cov = g_fill(sd, fw) * step(0.06, ph) * step(pw * 0.5, min(along, (alongX ? bs.x : bs.y) - along) + 4.0);
  // gable ridge parallel to the street: slopes face the street / the garden
  float side = sign(de - hc.y);
  vec2 inward = alongX ? vec2(0.0, q.y < bs.y * 0.5 ? 1.0 : -1.0) : vec2(q.x < bs.x * 0.5 ? 1.0 : -1.0, 0.0);
  vec2 tilt = inward * side * 0.62;
  roofN = normalize(vec3(tilt.x, 1.0, tilt.y));
  float k = fract(ph * 11.3);
  roofCol = k < 0.4 ? vec3(0.19, 0.065, 0.035) : k < 0.7 ? vec3(0.055, 0.055, 0.06) : k < 0.85 ? vec3(0.11, 0.075, 0.055) : vec3(0.2, 0.2, 0.19);
  roofCol *= 0.8 + 0.4 * fract(ph * 5.1);
  return cov;
}

void groundSurface(vec3 P, vec2 dpx, vec2 dpy, out vec3 albedo, out float rough, out float metal, out vec3 nW, out float ao) {
  vec2 p = P.xz;
  float fw = max(max(abs(dpx.x), abs(dpy.x)), max(abs(dpx.y), abs(dpy.y)));
  float det = 1.0 - smoothstep(1.2, 4.5, fw);  // fine-detail fade
  float hw = uRoad.x, SW = uRoad.y;
  vec4 nB = g_noise(p * 0.0011), nM = g_noise(p * 0.0093), nS = g_noise(p * 0.061), nF = g_noise(p * 0.33);
  float rad = length(p);
  float rural = smoothstep(1500.0, 2300.0, rad + (nB.r - 0.5) * 900.0);
  vec4 cx = g_cellXFar(p.x, 110.0), cz = g_cellZFar(p.y, 110.0);
  float ax = min(p.x - cx.x, cx.y - p.x), az = min(p.y - cz.x, cz.y - p.y);
  float dR = min(ax, az);
  float rhw = mix(hw, 3.2, rural), rsw = mix(SW, 0.0, rural);
  vec2 cellId = vec2(cx.x, cz.x);
  float bt = g_hash12(cellId * 0.0131 + 1.7);

  vec3 col; vec3 n = vec3(0.0, 1.0, 0.0); float rgh = 0.92; float occ = 1.0;
  // ---- block interior
  vec2 bmin = vec2(cx.x, cz.x) + hw + SW, bmax = vec2(cx.y, cz.y) - hw - SW, bs = bmax - bmin;
  vec3 grassC = vec3(0.055, 0.075, 0.03) * (0.75 + 0.5 * nS.g) * mix(vec3(1.0), vec3(1.4, 1.15, 0.75), nM.r * 0.6);
  // garden / park trees: clumped canopy from noise; fake shadow cast away from the sun
  vec2 sOff = -uSunDir.xz / max(uSunDir.y, 0.25);
  float treeK = mix(0.62, 0.55, bt);
  float canopy = smoothstep(treeK, treeK + 0.05, g_noise(p / 34.0).g * 0.6 + g_noise(p / 9.0).b * 0.4);
  float canS = smoothstep(treeK, treeK + 0.05, g_noise((p - sOff * 7.0) / 34.0).g * 0.6 + g_noise((p - sOff * 7.0) / 9.0).b * 0.4);
  if (rural < 0.99) {
    vec3 roofCol = vec3(0.0), roofN = vec3(0.0, 1.0, 0.0), rc2, rn2;
    float roof = 0.0, shade = 0.0;
    vec3 base = grassC;
    // inside ~1.6 km the city agent's perimeter blocks stand on these cells:
    // courtyards (gardens, yards, parking, annex roofs) are what shows
    float urban = 1.0 - smoothstep(1400.0, 1750.0, rad + (nM.a - 0.5) * 300.0);
    if (urban > 0.5 && bt < 0.6) {
      vec2 lq = p - bmin;
      float ps = 16.0 + floor(bt * 20.0);
      vec2 pc = floor(lq / ps), pf = lq - pc * ps;
      float ph = g_hash12(pc * 1.31 + cellId * 0.37);
      vec3 fcol = ph < 0.4 ? grassC : ph < 0.6 ? vec3(0.17, 0.165, 0.155) : ph < 0.75 ? vec3(0.075, 0.075, 0.08) : vec3(0.15, 0.13, 0.1);
      fcol *= 0.85 + 0.3 * nF.b;
      float edgeD = min(min(pf.x, ps - pf.x), min(pf.y, ps - pf.y));
      fcol = mix(fcol, vec3(0.03, 0.05, 0.02), g_band(edgeD, 0.5, fw) * step(0.4, fract(ph * 7.1)) * det);
      base = fcol;
      // single-storey annexes / garages in some parcels
      float an = g_sdBox(pf, vec2(ps * 0.5), vec2(ps * (0.18 + 0.12 * fract(ph * 3.3))));
      float annex = g_fill(an, fw) * step(0.7, fract(ph * 5.7));
      float annexS = g_fill(g_sdBox(pf - sOff * 3.5, vec2(ps * 0.5), vec2(ps * (0.18 + 0.12 * fract(ph * 3.3)))), fw) * step(0.7, fract(ph * 5.7));
      roof = annex;
      shade = annexS * (1.0 - annex);
      roofCol = mix(vec3(0.12, 0.12, 0.125), vec3(0.2, 0.08, 0.05), step(0.5, fract(ph * 9.1)));
      roofN = vec3(0.0, 1.0, 0.0);
      canopy *= step(ph, 0.45) + 0.3;
      canS *= step(ph, 0.45) + 0.3;
    } else if (urban > 0.5 && bt >= 0.86) {
      // paved square / surface car park
      base = vec3(0.09, 0.09, 0.095) * (0.85 + 0.3 * nS.r);
      float bayRow = 1.0 - g_fill(abs(mod(p.y, 16.0) - 8.0) - 3.0, fw); // aisle in the middle of each 16 m module
      float lines = g_dash(p.x + 0.05, 2.5, 0.1, fw) * bayRow;
      base = mix(base, vec3(0.5), g_sat(lines) * 0.6 * det);
      canopy *= 0.2; canS *= 0.2;
    } else if (bt < 0.62) {
      // houses with gardens; drives + front paths in pale concrete
      roof = g_house(p, bmin, bs, cellId, fw, roofCol, roofN);
      shade = g_house(p - sOff * 5.5, bmin, bs, cellId, fw, rc2, rn2) * (1.0 - roof);
      vec2 q = p - bmin;
      float de = min(min(q.x, bs.x - q.x), min(q.y, bs.y - q.y));
      float along = (min(q.y, bs.y - q.y) < min(q.x, bs.x - q.x)) ? q.x : q.y;
      float drive = g_band(mod(along, 15.0) - 2.2, 1.4, fw) * g_fill(de - 7.0, fw);
      base = mix(base, vec3(0.2, 0.19, 0.17), drive * det);
      canopy *= smoothstep(15.0, 20.0, de);
      canS *= smoothstep(15.0, 20.0, de);
    } else if (bt < 0.74) {
      // park: grass, paths, denser trees
      canopy = max(canopy, smoothstep(0.52, 0.57, g_noise(p / 21.0).g));
      canS = max(canS, smoothstep(0.52, 0.57, g_noise((p - sOff * 8.0) / 21.0).g));
      float path = g_band(p.x - (cx.x + cx.y) * 0.5, 1.2, fw) + g_band(p.y - (cz.x + cz.y) * 0.5, 1.2, fw);
      base = mix(base, vec3(0.2, 0.18, 0.15), path * det);
    } else if (bt < 0.9) {
      // light industry / retail sheds with yards
      float sh = g_sdBox(p, (bmin + bmax) * 0.5 + vec2(0.0, bs.y * 0.08), bs * vec2(0.36, 0.3));
      roof = g_fill(sh, fw);
      shade = g_fill(g_sdBox(p - sOff * 8.0, (bmin + bmax) * 0.5 + vec2(0.0, bs.y * 0.08), bs * vec2(0.36, 0.3)), fw) * (1.0 - roof);
      float ribs = g_dash(p.x, 3.0, 1.5, fw);
      roofCol = mix(vec3(0.24, 0.245, 0.25), vec3(0.15, 0.165, 0.18), g_sat(bt * 6.0 - 4.4)) * (0.92 + 0.12 * ribs * det);
      roofN = vec3(0.0, 1.0, 0.0);
      base = vec3(0.075, 0.075, 0.078) * (0.8 + 0.4 * nS.r);
      canopy *= 0.15; canS *= 0.15;
    } else {
      // apartment slabs (flat roofs with plant rooms)
      vec2 bc = (bmin + bmax) * 0.5;
      float s1 = g_sdBox(p, bc + vec2(0.0, bs.y * 0.25), vec2(bs.x * 0.38, 7.0));
      float s2 = g_sdBox(p, bc - vec2(0.0, bs.y * 0.25), vec2(bs.x * 0.38, 7.0));
      roof = g_fill(min(s1, s2), fw);
      float t1 = g_sdBox(p - sOff * 14.0, bc + vec2(0.0, bs.y * 0.25), vec2(bs.x * 0.38, 7.0));
      float t2 = g_sdBox(p - sOff * 14.0, bc - vec2(0.0, bs.y * 0.25), vec2(bs.x * 0.38, 7.0));
      shade = g_fill(min(t1, t2), fw) * (1.0 - roof);
      roofCol = vec3(0.13, 0.13, 0.135) * (0.8 + 0.4 * nF.r);
      roofN = vec3(0.0, 1.0, 0.0);
      canopy *= 0.6; canS *= 0.6;
    }
    vec3 treeC = vec3(0.025, 0.04, 0.015) * (0.7 + 0.6 * nF.g);
    col = base;
    col = mix(col, col * 0.4, g_sat(shade + canS * (1.0 - canopy)) * 0.8);
    col = mix(col, treeC, canopy);
    col = mix(col, roofCol, roof);
    n = normalize(mix(n, roofN, roof));
    vec2 tb = (g_noise(p / 5.0).gb - 0.5) * 1.6;
    n = normalize(n + vec3(tb.x, 0.0, tb.y) * canopy * (1.0 - roof) * det);
    rgh = mix(0.95, 0.8, roof);
    // fields take over with distance
    if (rural > 0.01) {
      vec2 fid = floor(p / vec2(55.0, 110.0) + nM.gb * 0.3);
      float fh = g_hash12(fid);
      vec3 fc = fh < 0.35 ? vec3(0.06, 0.08, 0.03) : fh < 0.6 ? vec3(0.17, 0.14, 0.07) : fh < 0.8 ? vec3(0.075, 0.055, 0.035) : vec3(0.11, 0.11, 0.05);
      fc *= 0.85 + 0.3 * nS.r;
      fc *= 1.0 - 0.1 * g_dash(p.x + p.y * 0.2, 2.2, 1.1, fw) * det;
      float hedge = 1.0 - smoothstep(1.5, 3.5, min(abs(fract(p.x / 55.0 + nM.g * 0.3) - 0.5) * 55.0 * 2.0, 99.0));
      fc = mix(fc, vec3(0.02, 0.035, 0.012), g_sat(canopy * 0.7 + hedge * 0.0));
      col = mix(col, fc, rural);
    }
  } else {
    vec2 fid = floor(p / vec2(55.0, 110.0) + nM.gb * 0.3);
    float fh = g_hash12(fid);
    col = fh < 0.35 ? vec3(0.06, 0.08, 0.03) : fh < 0.6 ? vec3(0.17, 0.14, 0.07) : fh < 0.8 ? vec3(0.075, 0.055, 0.035) : vec3(0.11, 0.11, 0.05);
    col *= 0.85 + 0.3 * nS.r;
    col = mix(col, vec3(0.02, 0.035, 0.012), canopy * 0.7);
  }
  // ---- streets: sidewalks, carriageway, centre line, street trees, lamps
  float walk = g_fill(dR - (rhw + rsw), fw);
  float road = g_fill(dR - rhw, fw);
  vec3 walkC = vec3(0.19, 0.18, 0.165) * (0.85 + 0.3 * nS.b);
  vec3 roadC = mix(vec3(0.075, 0.075, 0.08), vec3(0.1, 0.095, 0.085), rural) * (0.85 + 0.3 * nM.g);
  float cl = g_band(dR, 0.07, fw) * (1.0 - rural) * g_dash((ax < az ? p.y : p.x) + 1.3, 9.0, 3.0, fw);
  roadC = mix(roadC, vec3(0.55), cl * 0.8);
  col = mix(col, walkC, walk * (1.0 - rural));
  col = mix(col, roadC, road);
  rgh = mix(rgh, 0.88, walk);
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), walk));
  // kerb shadow line
  col *= 1.0 - 0.3 * g_band(dR - rhw, 0.12, fw) * (1.0 - rural);
  // street lamps every 32 m at the kerb, both sides (sodium/LED mix)
  float along = ax < az ? p.y : p.x;
  float lampD = length(vec2(mod(along + 7.0, 32.0) - 16.0, dR - rhw - 0.6));
  float glow = exp(-lampD * lampD / 18.0) * 0.6 + g_fill(lampD - 0.25, fw) * 3.0;
  gEmissive = uLampCol * glow * uNight * (1.0 - rural * 0.7);
  col *= 0.85 + 0.3 * nB.g;
  albedo = col;
  rough = rgh;
  metal = 0.0;
  nW = n;
  ao = occ;
}
`;
