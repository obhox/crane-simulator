// Lofted car bodies. A body is swept along x (rear bumper → front bumper)
// through ~50 cross-sections. Each section is an 11-point half profile
// (underbody, sill, bodyside with its widest point low down, shoulder, glass
// with tumblehome, roof rail, roof crown) mirrored to both sides, whose
// heights come from smooth side-view curves (roof / bonnet / boot line,
// sill line, beltline) and whose width follows a plan-view curve with
// rounded corners. Wheel arches lift the lower rows over the tyre, so arch
// openings, lips and the dark wheel tunnel fall out of the same grid.
//
// Stations are forced onto every panel boundary (glass edges, pillars,
// shut lines, lamp edges), so materials are assigned per grid cell and all
// those boundaries are straight and crisp instead of following triangle
// soup. The result: one smooth, correctly proportioned shell per vehicle
// type (~2.4k triangles at LOD0) with real windscreen rake, wrap-around
// lamps, pillars and panel gaps.

// Monotone cubic interpolation (Fritsch–Carlson) through [[x, y], …]:
// smooth like a spline but never overshoots (flat roofs stay flat).
export function monotone(pts) {
  const n = pts.length;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// Section rows used per LOD (indices into the 11-point half profile).
const LOD_ROWS = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [0, 2, 4, 5, 6, 7, 8, 10], [0, 2, 4, 6, 8, 10]];
// Station density per LOD (≈4k / 1.1k / 0.4k shell triangles for a car).
const LOD_PARAMS = [
  { step: 0.1, ends: [0.012, 0.03, 0.06, 0.1, 0.16, 0.25], archN: 10, edges: true },
  { step: 0.42, ends: [0.03, 0.1, 0.22], archN: 4, edges: false },
  { step: 1.0, ends: [0.08], archN: 2, edges: false },
];

// Build the shell → { pos: Float32Array (triangle list), slot: [slot name per triangle] }.
export function loftBody(sp, lod = 0) {
  const L = sp.L, hw0 = sp.W / 2;
  const top = monotone(sp.top), sill = monotone(sp.bottom), beltF = monotone(sp.belt);
  const G = sp.glass;

  // ---------------------------------------------------------------- stations
  const xs = [];
  const add = (x) => { if (x >= 0 && x <= L) xs.push(x); };
  const Q = LOD_PARAMS[lod];
  for (let x = 0; x < L; x += Q.step) add(x);
  add(L);
  for (const u of Q.ends) { add(u); add(L - u); }
  // wheel arches: sample the opening (upper arc) densely enough to read round
  const edgeDx = (a) => Math.sqrt(Math.max(0, sp.archR * sp.archR - (sp.r - sill(a)) ** 2));
  for (const a of sp.axles) {
    const e = edgeDx(a);
    for (let k = 0; k <= Q.archN; k++) add(a - e + (2 * e * k) / Q.archN);
    if (Q.edges) { add(a - e - 0.004); add(a + e + 0.004); }
  }
  // panel boundaries (glass always; pillars and lamp edges above LOD2)
  const keys = [G.roofF, G.cowl, G.side[0], ...(G.back || [])];
  if (lod < 2) keys.push(...(G.pillars || []).flat(), sp.head[0], sp.tail[0]);
  for (const k of keys) add(k);
  const gaps = lod === 0 ? [...(sp.doors || []), ...(sp.lids || [])] : [];
  for (const g of gaps) { add(g - 0.005); add(g + 0.005); }
  xs.sort((a, b) => a - b);
  const X = [];
  for (const x of xs) if (!X.length || x - X[X.length - 1] > 0.003) X.push(x);

  // ---------------------------------------------------------------- sections
  const rows = LOD_ROWS[lod];
  const n = rows.length;
  const segs = 2 * n - 2; // ring has 2n−1 points, bottom centre duplicated at both ends
  const archY = (x) => {
    let y = -Infinity;
    for (const a of sp.axles) {
      const dx = x - a, e = edgeDx(a);
      if (Math.abs(dx) <= e + 1e-6) y = Math.max(y, sp.r + Math.sqrt(Math.max(0, sp.archR * sp.archR - dx * dx)));
    }
    return y;
  };
  const planF = (x) => {
    const uf = Math.max(0, (x - (L - sp.nose[0])) / sp.nose[0]);
    const ur = Math.max(0, (sp.tailR[0] - x) / sp.tailR[0]);
    return (1 - sp.nose[1] * Math.pow(uf, 2.2)) * (1 - sp.tailR[1] * Math.pow(ur, 2.2));
  };
  const section = (x) => {
    const yT = top(x), yS = sill(x);
    const beltE = Math.min(beltF(x), yT - 0.035);
    const H = beltE - yS;
    const yA = archY(x);
    const inArch = yA > -Infinity;
    const hw = hw0 * planF(x) * (inArch ? 1 + (sp.flare ?? 0.012) : 1);
    const gF = smooth(0.015, 0.16, yT - beltE);
    const ghB = hw * 0.945, ghT = hw * sp.gh;
    const nom = [yS, yS, yS + 0.035, yS + 0.11, yS + 0.42 * H, yS + 0.74 * H];
    const off = [0, 0, 0.012, 0.03, 0.05, 0.07];
    const y = nom.map((v, k) => (inArch ? Math.max(v, yA + off[k]) : v));
    for (let k = 1; k < 6; k++) y[k] = Math.max(y[k], y[k - 1] + 0.002);
    y[5] = Math.min(y[5], beltE - 0.01);
    const P = [
      [0, y[0]], [hw * 0.8, y[1]], [hw * 0.955, y[2]], [hw * 0.993, y[3]], [hw, y[4]], [hw * 0.992, y[5]], [hw * 0.965, beltE],
      [lerp(hw * 0.925, ghB, gF), lerp(yT - 0.022, beltE + 0.02, gF)],
      [lerp(hw * 0.85, ghT, gF), lerp(yT - 0.01, yT - 0.06, gF)],
      [lerp(hw * 0.68, ghT * 0.9, gF), lerp(yT - 0.003, yT - 0.012, gF)],
      [0, yT],
    ];
    return { P, gF, yT, yS, beltE, hw };
  };
  const S = X.map(section);
  const R = X.map((x, i) => {
    const P = S[i].P, out = [];
    for (let j = 0; j < n; j++) out.push([x, P[rows[j]][1], P[rows[j]][0]]);
    for (let j = n - 2; j >= 0; j--) out.push([x, P[rows[j]][1], -P[rows[j]][0]]);
    return out;
  });

  // ---------------------------------------------------------------- classification
  const inside = (x, a, b) => x > Math.min(a, b) && x < Math.max(a, b);
  const nearGap = (x, list) => list.some((g) => Math.abs(x - g) < 0.0051);
  const [hx0, hy0, hy1, hz0 = 0.3] = sp.head;
  const [tx1, ty0, ty1, tz0 = 0] = sp.tail;
  const classify = (xm, k, s, yc, zc) => {
    const ax = sp.axles.some((a) => Math.abs(xm - a) < edgeDx(a));
    if (k <= 1) return 'liner';
    if (ax && k === 2) return 'liner';
    // lamps: wrap-around bands on the corners, by height / lateral position
    if (xm > hx0 && k >= 4 && yc > hy0 && yc < hy1 && zc > hz0 * s.hw) return 'head';
    if (xm < tx1 && k >= 4 && yc > ty0 && yc < ty1 && zc > tz0 * s.hw) return 'tail';
    if (sp.grille && xm > L - sp.grille[0] && yc > sp.grille[1] && yc < sp.grille[2] && zc < sp.grille[3]) return 'gloss';
    if (lod === 0 && k >= 2 && k <= 6 && nearGap(xm, sp.doors || [])) return 'liner';
    if (lod === 0 && k >= 7 && nearGap(xm, sp.lids || [])) return 'liner';
    if (k === 2 || k === 3) return sp.cladding || (ax && sp.archTrim) ? 'trim' : 'paint';
    // arch moulding: only the band hugging the opening, not the whole panel above it
    if (k === 4 && ax && sp.archTrim && yc < archY(xm) + 0.085) return 'trim';
    const sideGlass = s.gF > 0.3 && inside(xm, G.side[0], G.side[1] ?? G.cowl);
    const pillar = (G.pillars || []).some(([a, b]) => inside(xm, a, b));
    if (k === 6) return sideGlass ? 'trim' : 'paint';
    if (k === 7) return !sideGlass ? 'paint' : pillar ? 'gloss' : 'glass';
    if (k === 8) return sp.blackPillars && s.gF > 0.5 && xm > G.side[0] ? 'gloss' : 'paint';
    // k === 9: top surface (windscreen, roof, rear window, bonnet, boot)
    if (inside(xm, G.roofF, G.cowl)) return 'glass';
    if (G.back && inside(xm, G.back[0], G.back[1])) return 'glass';
    return 'paint';
  };
  // segment between ring rows ja → ja+1 → canonical profile segment k (LODs skip rows)
  const segK = (ja) => (rows[ja + 1] - rows[ja] === 2 ? rows[ja] + 1 : rows[ja]);

  const pos = [];
  const slot = [];
  const tri = (a, b, c, sl) => { pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); slot.push(sl); };
  for (let i = 0; i < X.length - 1; i++) {
    const xm = (X[i] + X[i + 1]) / 2;
    const s = section(xm);
    for (let j = 0; j < segs; j++) {
      const ja = j < n - 1 ? j : 2 * n - 3 - j;
      const A = R[i][j], B = R[i + 1][j], C = R[i + 1][j + 1], D = R[i][j + 1];
      const yc = (A[1] + B[1] + C[1] + D[1]) / 4, zc = Math.abs(A[2] + B[2] + C[2] + D[2]) / 4;
      const sl = classify(xm, segK(ja), s, yc, zc);
      tri(A, B, C, sl); tri(A, C, D, sl);
    }
  }
  // end caps: slightly domed, one intermediate ring then a fan to the centre
  const cap = (i, dir) => {
    const r0 = R[i];
    const cy = r0.reduce((s, p) => s + p[1], 0) / r0.length;
    const x0 = r0[0][0];
    const r1 = r0.map((p) => [x0 + dir * 0.016, cy + (p[1] - cy) * 0.6, p[2] * 0.6]);
    const c = [x0 + dir * 0.022, cy, 0];
    const low = dir > 0 ? sp.capLow[0] : sp.capLow[1];
    const lowSlot = dir > 0 ? sp.frontLower || 'trim' : sp.rearLower || 'trim';
    const emit = (A, B, C, sl) => {
      // orient outwards (+x at the front, −x at the rear)
      const nx = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]);
      if (nx * dir >= 0) tri(A, B, C, sl); else tri(A, C, B, sl);
    };
    for (let j = 0; j < segs; j++) {
      const A = r0[j], D = r0[j + 1];
      if (lod === 2) { emit(A, c, D, (A[1] + D[1]) / 2 < low ? lowSlot : 'paint'); continue; }
      const B = r1[j], C = r1[j + 1];
      const yc = (A[1] + B[1] + C[1] + D[1]) / 4;
      const sl = yc < low ? lowSlot : 'paint';
      emit(A, B, C, sl); emit(A, C, D, sl);
      emit(B, c, C, (B[1] + C[1]) / 2 < low ? lowSlot : 'paint');
    }
  };
  cap(X.length - 1, 1);
  cap(0, -1);

  return { pos: new Float32Array(pos), slot, section, top, sill, beltF, planF };
}

// ------------------------------------------------------------------ specs
// Side-view curves are [x from the rear bumper, height] pairs. glass: back =
// rear-window span on the top surface, roofF/cowl = windscreen top/base,
// side = side-glass span start, pillars = B/C pillar spans inside it.
// doors/lids = side / top shut-line positions. head = [x from, y0, y1, min
// |z| as a fraction of the half width]; tail = [x to, y0, y1, min |z|].
// grille = [depth from the nose, y0, y1, half width]. capLow = heights below
// which the front / rear faces are black bumper trim.
export const LOFT_TYPES = {
  sedan: { // D-segment saloon, 4.78 × 1.84 × 1.45 m, wheelbase 2.85 m
    L: 4.78, W: 1.84, r: 0.33, tw: 0.225, axles: [1.0, 3.85], archR: 0.385, gh: 0.76,
    nose: [0.62, 0.3], tailR: [0.5, 0.24],
    top: [[0, 0.56], [0.03, 0.74], [0.12, 0.92], [0.35, 1.0], [0.9, 1.03], [1.1, 1.06], [1.55, 1.3], [1.95, 1.415], [2.45, 1.45], [2.9, 1.435], [3.2, 1.33], [3.62, 1.03], [4.1, 0.94], [4.5, 0.87], [4.68, 0.79], [4.76, 0.67], [4.78, 0.54]],
    bottom: [[0, 0.4], [0.15, 0.31], [0.6, 0.26], [1.5, 0.215], [3.4, 0.215], [4.3, 0.25], [4.65, 0.3], [4.78, 0.37]],
    belt: [[0, 0.95], [0.9, 1.0], [1.3, 1.0], [3.6, 0.95], [4.1, 0.9], [4.78, 0.84]],
    glass: { back: [1.1, 1.95], roofF: 2.95, cowl: 3.62, side: [1.42], pillars: [[2.33, 2.43]] },
    doors: [1.42, 2.38, 3.43], lids: [1.07, 3.67],
    head: [4.42, 0.66, 0.84, 0.36], tail: [0.36, 0.77, 0.96, 0.3], grille: [0.12, 0.5, 0.72, 0.36],
    capLow: [0.47, 0.5], mirror: [3.52, 1.0], plateF: 0.42, plateR: 0.62,
  },
  hatch: { // C-segment hatchback, 4.2 × 1.8 × 1.46 m, wheelbase 2.62 m
    L: 4.2, W: 1.8, r: 0.315, tw: 0.205, axles: [0.72, 3.34], archR: 0.375, gh: 0.77,
    nose: [0.58, 0.3], tailR: [0.35, 0.2],
    top: [[0, 0.55], [0.02, 0.78], [0.05, 0.99], [0.1, 1.24], [0.2, 1.39], [0.42, 1.455], [1.3, 1.47], [2.3, 1.46], [2.58, 1.37], [3.12, 1.0], [3.55, 0.91], [3.95, 0.84], [4.12, 0.75], [4.18, 0.63], [4.2, 0.5]],
    bottom: [[0, 0.42], [0.2, 0.31], [0.8, 0.22], [3.0, 0.22], [3.9, 0.27], [4.2, 0.36]],
    belt: [[0, 1.0], [1.0, 1.0], [3.1, 0.97], [4.2, 0.88]],
    glass: { back: [0.06, 0.3], roofF: 2.42, cowl: 3.12, side: [0.62], pillars: [[1.62, 1.72]] },
    doors: [1.12, 1.67, 2.93], lids: [3.17],
    head: [3.86, 0.66, 0.84, 0.36], tail: [0.24, 0.8, 1.08, 0.58], grille: [0.1, 0.48, 0.7, 0.34],
    capLow: [0.46, 0.5], mirror: [3.03, 1.02], plateF: 0.4, plateR: 0.66,
  },
  suv: { // compact SUV, 4.7 × 1.9 × 1.71 m, wheelbase 2.8 m
    L: 4.7, W: 1.9, r: 0.37, tw: 0.235, axles: [0.98, 3.78], archR: 0.44, gh: 0.8, flare: 0.02,
    nose: [0.6, 0.26], tailR: [0.4, 0.18],
    top: [[0, 0.7], [0.02, 1.0], [0.06, 1.33], [0.14, 1.6], [0.36, 1.69], [1.5, 1.715], [2.65, 1.705], [2.92, 1.6], [3.45, 1.17], [3.9, 1.09], [4.4, 1.02], [4.62, 0.9], [4.68, 0.78], [4.7, 0.64]],
    bottom: [[0, 0.52], [0.2, 0.42], [0.7, 0.34], [3.2, 0.34], [4.3, 0.4], [4.7, 0.5]],
    belt: [[0, 1.12], [3.4, 1.1], [4.7, 1.02]],
    glass: { back: [0.07, 0.34], roofF: 2.72, cowl: 3.45, side: [0.36], pillars: [[1.17, 1.27], [2.18, 2.28]] },
    doors: [1.25, 2.23, 3.3], lids: [3.5],
    head: [4.36, 0.82, 1.0, 0.36], tail: [0.28, 0.9, 1.22, 0.55], grille: [0.14, 0.58, 0.9, 0.4],
    cladding: true, archTrim: true, frontLower: 'trim', rearLower: 'trim', roofRails: true, blackPillars: true,
    capLow: [0.62, 0.66], mirror: [3.36, 1.16], plateF: 0.52, plateR: 0.78,
  },
  van: { // panel van, 5.3 × 2.0 × 2.25 m, wheelbase 3.3 m
    L: 5.3, W: 2.0, r: 0.35, tw: 0.215, axles: [0.95, 4.25], archR: 0.42, gh: 0.93, flare: 0.015,
    nose: [0.5, 0.26], tailR: [0.12, 0.08],
    top: [[0, 2.08], [0.03, 2.2], [0.3, 2.245], [3.5, 2.245], [3.78, 2.12], [4.45, 1.21], [4.95, 1.03], [5.2, 0.96], [5.28, 0.8], [5.3, 0.62]],
    bottom: [[0, 0.46], [0.25, 0.38], [0.7, 0.32], [3.8, 0.3], [4.9, 0.36], [5.3, 0.44]],
    belt: [[0, 1.2], [5.3, 1.13]],
    glass: { roofF: 3.72, cowl: 4.45, side: [3.55] },
    doors: [1.98, 3.46, 4.2], lids: [4.49],
    head: [4.96, 0.78, 0.98, 0.34], tail: [0, 0, 0, 1], grille: [0.12, 0.55, 0.9, 0.44],
    archTrim: true, frontLower: 'trim', rearLower: 'trim',
    capLow: [0.55, 0.62], mirror: [4.32, 1.34], mirrorBig: true, plateF: 0.45, plateR: 0.5, rearWindows: true, vanRear: true,
  },
};
