import * as THREE from 'three';
import { textureSet, tileSize, MANIFEST } from '../assets.js';
import { rng } from '../../util/math.js';
import { groundMaterial, albedoTint } from './glsl.js';
import { MaskPainter, offsetPath, packMask } from './masks.js';

// Construction-site ground inside the hoarding: one flat quad at y = 0 (the
// physics ground) shaded by a world-space PBR splat of scanned gravel, dry
// soil, wet mud and floated concrete, driven by hand-placed masks:
//   mask1: R dirt · G mud · B standing water · A concrete
//   mask2: R height (0.5 = datum; ruts/hollows lower) · G tyre tracks · B cement slurry · A oil
// Layout follows how real sites are run: Type-1 crushed-stone haul roads and
// hardstandings (gate → wheel wash → yard / slab / lay-down areas), bare
// excavated soil elsewhere, mud and ponding in the low spots and wheel ruts.

const tintFor = (name, target, hue) => albedoTint(MANIFEST.textures[name], target, hue);

// Haul roads (centre-line waypoints) — shared with the tyre-track painter.
export const HAUL_ROADS = [
  // gate → wheel wash → yard → along the slab's south face → round the east end → north to lay-down B
  [[-30, -60], [-30, -47], [-27.5, -37], [-19, -25], [-5, -15], [10, -5.5], [26, -0.5], [45, 0], [52.5, 7], [54, 30], [46, 34.5], [10, 35], [3, 40], [2, 50]],
  // spur west to lay-down A
  [[-30, -47], [-37, -36], [-43.5, -24], [-44.5, -11]],
  // short spur to the crane base / flatbed stand
  [[-12, -19], [-2, -24], [9, -22.5]],
];

function paintMasks(site, N) {
  const fe = site.fence;
  const b = site.building;
  const rect = { minX: fe.minX - 2, minZ: fe.minZ - 2, size: Math.max(fe.maxX - fe.minX, fe.maxZ - fe.minZ) + 4 };
  const P = new MaskPainter(N, rect, 9107);
  const r = rng(4411);
  const blur = Math.max(1, Math.round(N / 512));

  // ---------------------------------------------------------------- dirt (R)
  // 1 = bare soil. Hardstanding (crushed stone) is painted out.
  P.begin(0.92);
  P.mode('source-over');
  const hard = (x0, z0, x1, z1) => {
    // ragged-edged rectangle: core rect + blobs along the rim
    P.rect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, 0.05);
    const per = 2 * ((x1 - x0) + (z1 - z0));
    for (let i = 0; i < per / 3; i++) {
      const t = r();
      const side = Math.floor(r() * 4);
      const x = side < 2 ? x0 + t * (x1 - x0) : side === 2 ? x0 : x1;
      const z = side >= 2 ? z0 + t * (z1 - z0) : side === 0 ? z0 : z1;
      P.blob(x, z, 1.6 + r() * 1.6, 1.4 + r() * 1.4, r() * 3, 0.08 + r() * 0.12, { soft: 0.7 });
    }
  };
  hard(-43, -15, -9, 25); // lay-down A (+ margin)
  hard(-9, 45.5, 17, 65); // lay-down B
  hard(-61, -57, -40, -35); // cabins / welfare compound
  hard(-10, -10, 10, 10); // crane base
  hard(-29, -37, -11, -21); // concrete-truck stand
  hard(-4, -29, 16, -16); // delivery stand
  hard(b.minX - 5, b.minZ - 5, b.maxX + 5, b.maxZ + 5); // working strip round the frame
  for (const road of HAUL_ROADS) {
    P.line(road, 9.5, 0.2, 0.6);
    P.line(road, 7.0, 0.04, 1);
  }
  // soil tracked back onto the stone at the edges, spoil strips along the hoarding
  for (let i = 0; i < 70; i++) P.blob(fe.minX + r() * (fe.maxX - fe.minX), fe.minZ + r() * (fe.maxZ - fe.minZ), 1 + r() * 3, 1 + r() * 2.5, r() * 3, 0.55 + r() * 0.4, { soft: 0.8, alpha: 0.6 });
  const dirt = P.read(blur);

  // ----------------------------------------------------------------- mud (G)
  P.begin(0).mode('lighten');
  const muds = [
    [-30, -52, 7, 4.5, 0], [-28, -43, 4, 3, 0.4], [-23, -30, 3.5, 2.5, 0.8], [8, -6.5, 4, 2.5, 0.3], [50, 4, 4.5, 3, 0.9],
    [54.5, 23, 3, 5, 0], [30, 33.5, 5, 2.5, 0], [57, 53, 10, 8, 0.5], [-57.5, 10, 3.5, 12, 0], [27, b.minZ - 3, 11, 2.2, 0],
    [b.maxX + 3, 16, 2.5, 8, 0], [-8, 30, 6, 4, 1.2], [36, 52, 7, 5, 0.3], [-50, 45, 7, 6, 0.7],
    [44, -30, 5, 6, 1.1], [60, -50, 5, 5, 0],
  ];
  for (const [x, z, rx, rz, rot] of muds) P.blob(x, z, rx, rz, rot, 0.7 + r() * 0.3, { soft: 0.75, rough: 0.35 });
  // ruts hold wet soil
  for (const road of HAUL_ROADS) for (const o of [-1.0, 1.0]) P.line(offsetPath(road, o), 0.9, 0.35, 0.8);
  // faint damp ground where water stood last week
  for (let i = 0; i < 10; i++) P.blob(fe.minX + 6 + r() * (fe.maxX - fe.minX - 12), fe.minZ + 6 + r() * (fe.maxZ - fe.minZ - 12), 3 + r() * 5, 2 + r() * 4, r() * 3, 0.2 + r() * 0.15, { soft: 0.95, rough: 0.45 });
  const mud = P.read(blur);

  // ------------------------------------------------------- standing water (B)
  P.begin(0).mode('lighten');
  const along = (road, i) => Math.atan2(road[i + 1][1] - road[i][1], road[i + 1][0] - road[i][0]);
  const H = HAUL_ROADS[0];
  // a puddle is never an ellipse: chains of overlapping lobes, elongated
  // along whatever made the hollow (ruts, trafficked low spots)
  const puddle = (x, z, len, wid, rot, v = 0.9) => {
    const n = 2 + Math.floor(len / 1.2);
    for (let k = 0; k < n; k++) {
      const t = n > 1 ? k / (n - 1) - 0.5 : 0;
      const o = (r() - 0.5) * wid * 0.8;
      const px = x + Math.cos(rot) * t * len * 1.4 - Math.sin(rot) * o;
      const pz = z + Math.sin(rot) * t * len * 1.4 + Math.cos(rot) * o;
      const s = 1 - Math.abs(t) * 0.9;
      P.blob(px, pz, (0.45 + r() * 0.5) * len * 0.55 * s + 0.3, (0.5 + r() * 0.6) * wid * s + 0.15, rot + (r() - 0.5) * 0.8, v * (0.8 + r() * 0.2), { soft: 0.55, rough: 0.45 });
    }
  };
  const pud = [
    [-31, -53, 3.6, 1.4, 0.2], [-29.2, -49, 1.8, 0.6, Math.PI / 2], [-58, 6, 2.6, 0.9, 1.4], [57.5, 54, 6, 2.6, 0.5],
    [24, b.minZ - 2.6, 3.8, 0.9, 0.05], [-9, 30, 2.8, 1.1, 1], [44, -31, 2.2, 0.9, 1.2],
  ];
  for (const [x, z, len, wid, rot] of pud) puddle(x, z, len, wid, rot);
  // elongated puddles sitting in the wheel ruts
  for (const [i, t, side] of [[2, 0.5, 1], [3, 0.4, -1], [5, 0.6, 1], [7, 0.3, -1], [8, 0.5, 1], [10, 0.4, -1], [11, 0.6, 1], [12, 0.5, -1]]) {
    const a = H[i], c = H[i + 1];
    const x = a[0] + (c[0] - a[0]) * t, z = a[1] + (c[1] - a[1]) * t;
    const ang = along(H, i);
    puddle(x - Math.sin(ang) * side * 1.0, z + Math.cos(ang) * side * 1.0, 2.2 + r() * 2.5, 0.45, ang, 0.8);
  }
  const water = P.read(blur);

  // -------------------------------------------------------------- concrete (A)
  P.begin(0).mode('source-over');
  P.rect(-4, -4, 4, 4, 1); // crane foundation pad
  P.rect(b.minX - 1, b.minZ - 1, b.maxX + 1, b.maxZ + 1, 1); // ground-floor slab
  P.rect(-34, fe.minZ, -26, fe.minZ + 8, 1); // wheel-wash / gate apron
  P.rect(-58.5, -47.5, -41.5, -40.5, 0.9); // cabin plinth
  const conc = P.read(0);

  // ------------------------------------------------------------- height (R2)
  P.begin(0.5).mode('source-over');
  for (const [x, z, len, wid, rot] of pud) P.blob(x, z, len * 0.9 + 1, wid * 1.6 + 0.6, rot, 0.25, { soft: 0.9, alpha: 0.7 });
  for (const road of HAUL_ROADS) {
    for (const o of [-1.0, 1.0]) {
      P.line(offsetPath(road, o), 1.3, 0.62, 0.5); // berm squeezed out beside the rut
      P.line(offsetPath(road, o), 0.55, 0.22, 0.7); // the rut itself
    }
  }
  // spoil heaps / uneven ground at the edges
  for (let i = 0; i < 30; i++) {
    const edge = r() < 0.5;
    const x = edge ? (r() < 0.5 ? fe.minX + 3 : fe.maxX - 3) : fe.minX + r() * (fe.maxX - fe.minX);
    const z = edge ? fe.minZ + 8 + r() * (fe.maxZ - fe.minZ - 8) : fe.minZ + r() * (fe.maxZ - fe.minZ);
    P.blob(x, z, 1.5 + r() * 3, 1.5 + r() * 3, r() * 3, r() < 0.7 ? 0.68 : 0.36, { soft: 0.95, alpha: 0.6 });
  }
  const height = P.read(blur + 1);

  // --------------------------------------------------------- tyre tracks (G2)
  P.begin(0).mode('lighter');
  for (const road of HAUL_ROADS) {
    for (let k = 0; k < 7; k++) {
      const o = (r() - 0.5) * 3.2;
      const gauge = 0.95 + r() * 0.15; // half track width of a truck / dumper
      const a = 0.18 + r() * 0.22;
      P.line(offsetPath(road, o - gauge, 0.25, r), 0.42 + r() * 0.15, 1, a);
      P.line(offsetPath(road, o + gauge, 0.25, r), 0.42 + r() * 0.15, 1, a);
    }
  }
  // tracked plant crossing the soil (excavator / dumper wandering)
  for (let k = 0; k < 9; k++) {
    const x0 = fe.minX + 8 + r() * (fe.maxX - fe.minX - 16), z0 = fe.minZ + 12 + r() * (fe.maxZ - fe.minZ - 16);
    const pts = [[x0, z0]];
    let ang = r() * Math.PI * 2;
    for (let i = 0; i < 5; i++) {
      ang += (r() - 0.5) * 1.2;
      const l = 5 + r() * 7;
      const p = pts[pts.length - 1];
      pts.push([Math.min(fe.maxX - 3, Math.max(fe.minX + 3, p[0] + Math.cos(ang) * l)), Math.min(fe.maxZ - 3, Math.max(fe.minZ + 3, p[1] + Math.sin(ang) * l))]);
    }
    const g = 1.1 + r() * 0.2, a = 0.25 + r() * 0.2;
    P.line(offsetPath(pts, -g), 0.6, 1, a);
    P.line(offsetPath(pts, g), 0.6, 1, a);
  }
  const tracks = P.read(1);

  // ------------------------------------------------ cement slurry / washout (B2)
  P.begin(0).mode('lighten');
  for (const [x, z, rx, rz] of [[-23.4, -28.8, 3.2, 2.2], [-25.5, -27.5, 1.6, 1.2], [3.5, 4.5, 2.2, 1.6], [19, b.minZ - 1.8, 2.5, 1], [31, b.minZ - 1.5, 1.8, 0.9], [b.maxX + 1.6, 20, 1, 2.4], [-38, -50, 3, 2], [-30, -56, 3.5, 1.2]]) {
    P.blob(x, z, rx, rz, r() * 3, 0.6 + r() * 0.4, { soft: 0.6, rough: 0.4 });
  }
  for (let i = 0; i < 40; i++) P.blob(b.minX - 3 + r() * (b.maxX - b.minX + 6), b.minZ - 4 + r() * (b.maxZ - b.minZ + 8), 0.2 + r() * 0.5, 0.2 + r() * 0.4, r() * 3, 0.5 + r() * 0.5, { soft: 0.5 });
  const cement = P.read(blur);

  // ---------------------------------------------------------- oil / diesel (A2)
  P.begin(0).mode('lighten');
  for (const [x, z, rr] of [[-8, -40, 1.6], [-6.5, -40.8, 0.8], [-18.5, -30.5, 1.3], [-21.5, -29, 0.9], [3.8, -21.8, 1.4], [8.5, -22.8, 1.1], [-48, -38.5, 1.2], [-52.5, -38.2, 0.7], [-40.5, -45, 1.5], [0, -5.2, 0.9]]) {
    P.blob(x, z, rr, rr * (0.6 + r() * 0.4), r() * 3, 0.6 + r() * 0.35, { soft: 0.7, rough: 0.35 });
  }
  for (const road of HAUL_ROADS) {
    for (let i = 0; i < 18; i++) {
      const s = Math.floor(r() * (road.length - 1)), t = r();
      const a = road[s], c = road[s + 1];
      P.blob(a[0] + (c[0] - a[0]) * t + (r() - 0.5) * 2.5, a[1] + (c[1] - a[1]) * t + (r() - 0.5) * 2.5, 0.15 + r() * 0.35, 0.15 + r() * 0.3, r() * 3, 0.4 + r() * 0.5, { soft: 0.6 });
    }
  }
  const oil = P.read(blur);

  return {
    rect,
    mask1: packMask(N, [dirt, mud, water, conc], 'site_mask1'),
    mask2: packMask(N, [height, tracks, cement, oil], 'site_mask2'),
  };
}

const SURFACE = /* glsl */ `
uniform sampler2D tGravelC, tGravelN, tDirtC, tDirtN, tMudC, tConcC, tConcN, tMask1, tMask2;
uniform vec4 uMaskRect;   // minX, minZ, 1/size, 1 texel in uv
uniform vec4 uTiles;      // gravel, dirt, mud, concrete (m per repeat)
uniform vec3 uGravelTint, uDirtTint, uMudTint, uConcTint;
uniform vec4 uPaintA, uPaintB, uFence; // rects (minX, minZ, maxX, maxZ)
uniform float uPaintW, uWet, uHeightScale;

float rectOutline(vec2 p, vec4 r, float w, float fw) {
  return g_band(g_sdBox(p, (r.xy + r.zw) * 0.5, (r.zw - r.xy) * 0.5), w * 0.5, fw);
}

void groundSurface(vec3 P, vec2 dpx, vec2 dpy, out vec3 albedo, out float rough, out float metal, out vec3 nW, out float ao) {
  vec2 p = P.xz;
  float fw = max(max(abs(dpx.x), abs(dpy.x)), max(abs(dpx.y), abs(dpy.y)));
  vec2 muv = (p - uMaskRect.xy) * uMaskRect.z;
  vec4 m1 = texture2D(tMask1, muv);
  vec4 m2 = texture2D(tMask2, muv);
  float e = uMaskRect.w;
  // slope of the painted height field (m / m)
  float hgx = (texture2D(tMask2, muv + vec2(e, 0.0)).r - texture2D(tMask2, muv - vec2(e, 0.0)).r);
  float hgz = (texture2D(tMask2, muv + vec2(0.0, e)).r - texture2D(tMask2, muv - vec2(0.0, e)).r);
  float slopeK = uHeightScale / (2.0 * e / uMaskRect.z);
  vec4 nB = g_noise(p * 0.0061);  // ~160 m
  vec4 nM = g_noise(p * 0.043);   // ~23 m
  vec4 nS = g_noise(p * 0.27);    // ~4 m
  vec4 nF = g_noise(p * 1.9);     // ~0.5 m

  HexT hx = g_hexSetup(p / 2.3, 1.0);
  vec2 wuv = vec2(p.x, -p.y), wdx = vec2(dpx.x, -dpx.y), wdy = vec2(dpy.x, -dpy.y);

  // ---- gravel hardstanding (always sampled: it's the base everything sits on)
  vec2 ug = wuv / uTiles.x; vec2 gdx = wdx / uTiles.x, gdy = wdy / uTiles.x;
  vec3 cG = g_hexTex(tGravelC, ug, gdx, gdy, hx).rgb * uGravelTint;
  vec3 nG = g_hexNrm(tGravelN, ug, gdx, gdy, hx);
  float hG = g_lum(cG) / max(g_lum(uGravelTint) * 0.4, 1e-3); // ~1 = mean stone
  // Type-1 is never uniform: fresh lighter loads vs trafficked darker stone,
  // fines washed into low spots, patches of coarser aggregate
  cG *= 0.72 + 0.5 * (nS.r * 0.55 + nF.g * 0.45);
  cG *= mix(vec3(1.05, 1.0, 0.92), vec3(0.92, 0.94, 0.98), nM.g);

  // ---- soil (always sampled too: it is ground into the stone everywhere)
  vec2 ud = wuv / uTiles.y; vec2 ddx = wdx / uTiles.y, ddy = wdy / uTiles.y;
  vec3 cD = g_hexTex(tDirtC, ud, ddx, ddy, hx).rgb * uDirtTint;
  vec3 nD = g_hexNrm(tDirtN, ud, ddx, ddy, hx);
  float hD = g_lum(cD) / max(g_lum(uDirtTint) * 0.12, 1e-3);
  // the scan is an orange garden soil: pull it toward the grey-brown of
  // excavated subsoil, then vary: sun-dried pale crust vs darker damp clay
  cD = mix(vec3(g_lum(cD)), cD, 0.62) * vec3(1.02, 1.0, 0.97);
  cD *= mix(vec3(1.18, 1.14, 1.08), vec3(0.78, 0.76, 0.76), smoothstep(0.25, 0.75, nM.b * 0.7 + nS.a * 0.3));
  cD *= 0.8 + 0.4 * nF.b;
  // dirty gravel: soil ground into the stone between the wheel tracks
  float grit = smoothstep(0.35, 0.85, nS.b * 0.6 + nF.r * 0.4) * 0.45;
  cG = mix(cG, cD * 1.1, grit);

  float dirtA = g_sat(m1.r + (nM.r - 0.5) * 0.5 + (nS.g - 0.5) * 0.45 + (nF.a - 0.5) * 0.25);
  // height blend: stones poke through thin soil, soil fills between stones
  float t = smoothstep(-0.15, 0.15, (dirtA - 0.5) * 1.5 + (hD - hG) * 0.22);
  vec3 col = mix(cG, cD, t);
  vec3 nts = mix(nG, nD, t);
  float rgh = mix(0.86, 0.92, t);
  float h = mix(hG, hD, t) * 0.5;

  // ---- loose stones / clods scattered over the soil: the 5-15 cm detail that
  // survives mip-mapping when seen from the cab, faded to its mean colour
  // once a pixel covers more than a few centimetres
  {
    vec2 sc = p / 0.42;
    vec2 cid = floor(sc);
    vec2 hh = g_hash22(cid + 71.0);
    vec2 off = fract(sc) - 0.2 - 0.6 * hh;
    float rr = (0.05 + 0.1 * hh.y) / 0.42;
    // sparse (~1 in 4 cells) and clustered by noise: an even 1-per-cell
    // scatter read as a polka-dot / pock-marked pattern from 20 m
    float keep = step(0.74 - 0.25 * nS.a, hh.x);
    float stone = g_fill(length(off * vec2(1.0, 0.7 + 0.6 * hh.x)) - rr, fw / 0.42) * keep;
    float fade = 1.0 - smoothstep(0.02, 0.09, fw);
    float amt = stone * fade * mix(0.35, 1.0, t);
    vec3 sCol = mix(vec3(0.2, 0.19, 0.17), vec3(0.11, 0.095, 0.08), hh.y) * (0.8 + 0.4 * nF.g);
    col = mix(col, sCol, amt * 0.6);
    col *= 1.0 + (1.0 - fade) * 0.02 * (1.0 - t); // mean of the specks
    // domed stones (normal tilts away from the centre), not dimples
    nts.xy += vec2(off.x, -off.y) * 2.0 * amt;
  }

  // ---- mud (wet soil) settles into the low parts of the texture
  float mudA = g_sat(m1.g + (nS.b - 0.5) * 0.5 + (nF.r - 0.5) * 0.2);
  float wetMud = smoothstep(0.35, 0.7, mudA + (0.5 - h) * 0.35);
  if (wetMud > 0.001) {
    vec2 um = wuv / uTiles.z;
    vec3 cM = g_hexTex(tMudC, um, wdx / uTiles.z, wdy / uTiles.z, hx).rgb * uMudTint;
    // a mud patch is never one flat dark disc: drier crust and trodden soil
    // show through, wetter where it sits lowest
    cM = mix(cM, cD * 0.85, smoothstep(0.45, 0.75, nF.g * 0.6 + nS.r * 0.4) * 0.55);
    cM *= 0.85 + 0.3 * nS.a;
    col = mix(col, cM, wetMud);
    nts = mix(nts, vec3(nD.xy * 0.45, 1.0), wetMud);
    rgh = mix(rgh, 0.55, wetMud);
  }

  // ---- concrete: pad, slab, wheel wash, cabin plinth
  float concA = m1.a;
  if (concA > 0.01) {
    vec2 uc = wuv / uTiles.w; vec2 cdx = wdx / uTiles.w, cdy = wdy / uTiles.w;
    vec3 cC = g_hexTex(tConcC, uc, cdx, cdy, hx).rgb * uConcTint;
    vec3 nC = g_hexNrm(tConcN, uc, cdx, cdy, hx);
    // muddy boots / tyres: soil smeared over the concrete edges
    float smear = g_sat((nS.r - 0.45) * 2.0 + (1.0 - concA) * 2.0) * 0.7;
    cC = mix(cC, col * 0.9, smear);
    col = mix(col, cC, concA);
    nts = mix(nts, nC, concA);
    rgh = mix(rgh, 0.78, concA);
    wetMud *= 1.0 - concA * 0.7;
  }

  // ---- tyre tracks: compacted, darker, carrying soil onto the stone
  float tr = m2.g * (0.65 + 0.7 * nF.a);
  col = mix(col, col * vec3(0.72, 0.68, 0.64), g_sat(tr * 1.4));
  rgh -= tr * 0.12;

  // ---- stains
  float cem = g_sat(m2.b * (0.4 + 0.9 * nS.a) * (0.6 + 0.6 * nF.g));
  col = mix(col, vec3(0.21, 0.21, 0.2) * (0.85 + 0.3 * nF.g), cem * 0.75);
  rgh = mix(rgh, 0.8, cem);
  float oil = g_sat(m2.a * (0.5 + 0.9 * nF.b));
  col *= 1.0 - oil * 0.65;
  rgh = mix(rgh, 0.3, oil * 0.8);

  // ---- weeds + wind-blown litter along the hoarding line
  vec2 fc = (uFence.xy + uFence.zw) * 0.5, fh = (uFence.zw - uFence.xy) * 0.5;
  float inside = -g_sdBox(p, fc, fh);
  float weeds = (1.0 - smoothstep(0.0, 1.6, inside)) * smoothstep(0.45, 0.7, nS.g + nF.r * 0.3) * (1.0 - concA);
  col = mix(col, vec3(0.045, 0.06, 0.022) * (0.7 + 0.6 * nF.g), weeds * 0.8);

  // ---- painted lay-down outlines (gameplay cue: must read clearly from the cab)
  float paint = max(rectOutline(p, uPaintA, uPaintW, fw), rectOutline(p, uPaintB, uPaintW, fw));
  float wear = smoothstep(0.18, 0.42, nF.g * 0.6 + nS.r * 0.5) * (1.0 - g_sat(tr * 0.9)) * (1.0 - wetMud * 0.5);
  paint *= mix(0.55, 1.0, wear);
  col = mix(col, vec3(0.62, 0.42, 0.015) * (0.85 + 0.2 * nF.b), paint);
  rgh = mix(rgh, 0.6, paint);

  // ---- macro variation (breaks up any remaining repetition, sun-bleached vs damp)
  col *= 0.8 + 0.4 * nB.r;
  col *= mix(vec3(1.03, 1.0, 0.96), vec3(0.96, 0.99, 1.04), nB.g);

  // ---- wetness darkens porous soil and lowers roughness
  float damp = g_sat(wetMud * 0.8 + tr * mudA * 0.4 + uWet * 0.25);
  col *= mix(1.0, 0.68, damp * (1.0 - concA * 0.5));
  rgh = mix(rgh, 0.45, damp * 0.6);

  // ---- normal: layer detail + painted relief
  float hMask = m2.r - 0.5;
  vec3 nd = g_tsToWorld(normalize(vec3(nts.xy * 1.9, max(nts.z, 0.2))));
  vec3 n = normalize(nd + vec3(-hgx * slopeK, 0.0, -hgz * slopeK));

  // ---- standing water: flat, dark, mirror-like; stones poke through the shallow edge
  float wl = m1.b * 1.2 - (h - 0.5) * 0.3 - hMask * 0.3 + (nS.g - 0.5) * 0.22 + (nF.r - 0.5) * 0.12;
  // a water line is sharp: ~2 cm transition, widened only for anti-aliasing
  float wfw = max(fwidth(wl), 1e-4);
  float water = smoothstep(0.39 - wfw - 0.004, 0.39 + wfw + 0.004, wl);
  float depth = smoothstep(0.4, 0.95, wl);
  // silty site water: brown body colour, sky reflection on top (Fresnel)
  vec3 wcol = mix(col * 0.6, vec3(0.075, 0.062, 0.045) * (0.85 + 0.3 * nS.b), 0.35 + depth * 0.6);
  col = mix(col, wcol, water);
  rgh = mix(rgh, 0.03 + 0.08 * nS.g * (1.0 - depth), water);
  // faint wind ripples
  vec2 rp = p * 1.7 + vec2(uTime * 0.21, uTime * 0.13);
  vec2 rip = (g_noise(rp * 0.37).gb - 0.5) * 0.05 + (g_noise(rp * 0.91 - uTime * 0.05).ba - 0.5) * 0.03;
  n = normalize(mix(n, normalize(vec3(rip.x, 1.0, rip.y)), water));
  // wet rim around puddles
  float rim = smoothstep(0.2, 0.36, wl) * (1.0 - water);
  col *= 1.0 - rim * 0.25;
  rgh = mix(rgh, 0.45, rim);

  albedo = col;
  rough = rgh;
  metal = 0.0;
  nW = n;
  ao = mix(1.0, 0.75, g_sat(-hMask * 3.0)) * mix(0.85, 1.0, g_sat(h * 1.6)) * (1.0 - (1.0 - smoothstep(0.0, 0.7, inside)) * 0.25);
}
`;

export function buildSiteGround(scene, site, quality) {
  const low = quality?.name === 'low';
  const N = low ? 512 : 1024;
  const { rect, mask1, mask2 } = paintMasks(site, N);
  const fe = site.fence;
  const set = (n) => textureSet(n) || {};
  const gr = set('gravel'), di = set('dirt'), mu = set('mud'), co = set('concrete_slab');
  const u = {
    tGravelC: { value: gr.map }, tGravelN: { value: gr.normalMap },
    tDirtC: { value: di.map }, tDirtN: { value: di.normalMap },
    tMudC: { value: mu.map }, tConcC: { value: co.map }, tConcN: { value: co.normalMap },
    tMask1: { value: mask1 }, tMask2: { value: mask2 },
    uMaskRect: { value: new THREE.Vector4(rect.minX, rect.minZ, 1 / rect.size, 1 / N) },
    uTiles: { value: new THREE.Vector4(tileSize('gravel'), tileSize('dirt'), tileSize('mud'), tileSize('concrete_slab')) },
    uGravelTint: { value: tintFor('gravel', 0.19, [1.0, 0.95, 0.86]) },
    uDirtTint: { value: tintFor('dirt', 0.12, [1, 1, 1]) },
    uMudTint: { value: tintFor('mud', 0.1, [1, 0.97, 0.92]) },
    uConcTint: { value: tintFor('concrete_slab', 0.26, [1, 0.99, 0.96]) },
    uPaintA: { value: new THREE.Vector4(-40, -12, -12, 22) },
    uPaintB: { value: new THREE.Vector4(-6, 48, 14, 62) },
    uPaintW: { value: 0.3 },
    uFence: { value: new THREE.Vector4(fe.minX, fe.minZ, fe.maxX, fe.maxZ) },
    uWet: { value: 0.15 },
    uHeightScale: { value: 0.35 },
  };
  const ok = gr.map && di.map && mu.map && co.map;
  const mat = ok
    ? groundMaterial({ name: 'site_ground', uniforms: u, surface: SURFACE, defines: low ? { TERRAIN_LOW: '' } : {} })
    : new THREE.MeshStandardMaterial({ color: 0x6f6658, roughness: 0.95 });
  const w = fe.maxX - fe.minX, d = fe.maxZ - fe.minZ;
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  geo.translate((fe.minX + fe.maxX) / 2, 0, (fe.minZ + fe.maxZ) / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'site_ground';
  mesh.receiveShadow = true;
  scene.add(mesh);
  return { mesh, material: mat };
}
