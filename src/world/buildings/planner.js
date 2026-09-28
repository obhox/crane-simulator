import { lots, NEIGHBOUR_EXCLUDE, X_ROADS, Z_ROADS, ROAD, CITY_EXTENT } from '../layout.js';
import { rng } from '../../util/math.js';
import { L as LY } from './surfaces.js';
import { STYLE, FLAG } from './material.js';

// City planner: turns the lot grid of layout.js into building specs.
// Lots become the urban blocks of a contemporary European district:
// perimeter blocks (continuous street walls round a courtyard, parcels of
// different ages and heights with fire walls between them), office blocks,
// podium towers, post-war slab estates (Zeilenbau) and retail/industrial
// sheds. Beyond the lot grid a lower-detail skyline continues the road grid
// to ~1.6 km with a high-rise cluster (the "CBD") to the north-east.

const HALF = ROAD.width / 2 + ROAD.sidewalk;
const pick = (r, a) => a[Math.floor(r() * a.length) % a.length];
const XS = [...Z_ROADS].sort((a, b) => a - b);
const ZS = [...X_ROADS].sort((a, b) => a - b);

// streets with shops on the ground floor (by road centre line)
const MAIN_X = new Set([-66, 104, -286, 324]);
const MAIN_Z = new Set([-100, 110, -320, 330]);

// palettes (linear-ish tints multiplied onto normalised scans)
const PLASTER_CLASSIC = [[0.95, 0.9, 0.78], [0.93, 0.84, 0.66], [0.9, 0.72, 0.5], [0.85, 0.62, 0.46], [0.8, 0.8, 0.76], [0.76, 0.8, 0.74],
  [0.96, 0.94, 0.9], [0.7, 0.66, 0.6], [0.88, 0.78, 0.66], [0.82, 0.74, 0.7], [0.72, 0.76, 0.8], [0.93, 0.88, 0.8]];
const PLASTER_MODERN = [[0.95, 0.95, 0.93], [0.92, 0.91, 0.88], [0.78, 0.79, 0.8], [0.62, 0.63, 0.64], [0.86, 0.8, 0.7], [0.35, 0.36, 0.37], [0.93, 0.9, 0.84]];
const PLASTER_POSTWAR = [[0.82, 0.78, 0.68], [0.7, 0.7, 0.66], [0.78, 0.72, 0.6], [0.72, 0.78, 0.8], [0.85, 0.75, 0.6], [0.66, 0.7, 0.62], [0.9, 0.86, 0.74]];
const BRICK_TINT = [[1, 1, 1], [0.9, 0.85, 0.8], [0.8, 0.72, 0.68], [1, 0.95, 0.85], [0.7, 0.62, 0.6]];
const TILE_COLS = [[0.62, 0.27, 0.16], [0.55, 0.22, 0.13], [0.68, 0.36, 0.22], [0.3, 0.3, 0.32], [0.45, 0.24, 0.18], [0.24, 0.24, 0.26]];
const OFFICE_CLAD = [[0.75, 0.73, 0.68], [0.55, 0.56, 0.57], [0.85, 0.84, 0.8], [0.3, 0.31, 0.33], [0.65, 0.6, 0.52]];

// ------------------------------------------------------------------ typology presets
function classic(r) {
  const plaster = r() < 0.72;
  const brickL = r() < 0.5 ? LY.brick_old : LY.brick;
  return {
    kind: 'classic', fh: 3.4 + r() * 0.4, gh: 4.2 + r() * 0.6,
    fac: {
      style: STYLE.PUNCHED, layer: plaster ? LY.plaster : brickL, color: plaster ? pick(r, PLASTER_CLASSIC) : pick(r, BRICK_TINT),
      bay: 3.2 + r() * 0.6, ww: 1.15 + r() * 0.2, wh: 2.1 + r() * 0.35, sill: 0.8 + r() * 0.1,
      frame: pick(r, [0, 0, 0, 0, 7, 3, 1, 6]), glass: 0, flags: r() < 0.8 ? FLAG.SURROUND : 0,
    },
    roof: pick(r, ['mansard', 'gable', 'gable', 'hip', 'flat', 'mansard']),
    pitch: 35 + r() * 12, tileColor: pick(r, TILE_COLS), chimneys: true, dormers: r() < 0.65,
    balconies: r() < 0.3 ? 'back' : null, groundStyle: 3, parapet: 1.0,
  };
}
function modern(r) {
  const cl = r();
  const layer = cl < 0.5 ? LY.plaster : cl < 0.68 ? LY.brick : cl < 0.78 ? LY.wood : cl < 0.9 ? LY.panel : LY.concrete;
  const color = layer === LY.plaster ? pick(r, PLASTER_MODERN) : layer === LY.brick ? pick(r, BRICK_TINT)
    : layer === LY.wood ? [0.9, 0.82, 0.72] : layer === LY.panel ? pick(r, [[0.3, 0.31, 0.33], [0.7, 0.7, 0.68], [0.55, 0.5, 0.45]]) : [0.9, 0.9, 0.88];
  const french = r() < 0.55;
  const balconies = pick(r, ['street', 'back', 'back', 'both', null]);
  const fac = {
    style: r() < 0.12 ? STYLE.RIBBON : STYLE.PUNCHED, layer, color,
    bay: 2.7 + r() * 1.1, ww: 1.4 + r() * 1.0, wh: french ? 2.35 : 1.45 + r() * 0.4, sill: french ? 0.1 : 0.9,
    frame: pick(r, [1, 1, 1, 0, 2, 4, 5]), glass: 0, flags: 0,
  };
  const b = {
    kind: 'modern', fh: 3.0 + r() * 0.2, gh: 4.0 + r() * 0.5, fac,
    roof: 'flat', roofLayer: pick(r, [LY.gravel, LY.membrane, LY.sedum, LY.gravel]), roofColor: [0.7, 0.7, 0.7],
    penthouse: r() < 0.45, balconies, groundStyle: 4, parapet: 0.9,
  };
  if (balconies && !french) {
    const fr = { ...fac, wh: 2.35, sill: 0.1, ww: Math.max(fac.ww, 1.6) };
    if (balconies === 'street' || balconies === 'both') b.fac = fr;
    if (balconies === 'back' || balconies === 'both') b.back = fr;
  }
  return b;
}
function postwar(r) {
  const layer = pick(r, [LY.plaster, LY.plaster, LY.concrete, LY.concrete_rough]);
  return {
    kind: 'postwar', fh: 2.85 + r() * 0.1, gh: 2.9,
    fac: {
      style: STYLE.PUNCHED, layer, color: layer === LY.plaster ? pick(r, PLASTER_POSTWAR) : [0.85, 0.84, 0.8],
      bay: 2.9 + r() * 0.8, ww: 1.5 + r() * 0.6, wh: 1.35 + r() * 0.15, sill: 0.9, frame: pick(r, [0, 0, 5, 6]), glass: 0, flags: 0,
    },
    roof: r() < 0.8 ? 'flat' : 'gable', pitch: 22 + r() * 8, tileColor: pick(r, TILE_COLS), roofLayer: LY.membrane,
    roofColor: [0.45, 0.45, 0.45], balconies: pick(r, ['back', 'both', 'back', null]), groundStyle: 4, parapet: 0.6, chimneys: false,
  };
}
function office(r) {
  const t = r();
  const glass = 1 + Math.floor(r() * 3);
  const fac = t < 0.4
    ? { style: STYLE.RIBBON, layer: pick(r, [LY.stone, LY.concrete, LY.panel]), color: pick(r, OFFICE_CLAD), bay: 1.5, ww: 1.5, wh: 1.9 + r() * 0.3, sill: 0.9, frame: pick(r, [5, 1, 2]), glass, flags: FLAG.OFFICE }
    : t < 0.7
      ? { style: STYLE.PUNCHED, layer: pick(r, [LY.stone, LY.stone, LY.concrete]), color: pick(r, OFFICE_CLAD), bay: 1.5 + r() * 0.4, ww: 1.05 + r() * 0.25, wh: 2.3, sill: 0.65, frame: pick(r, [5, 1, 2]), glass: r() < 0.5 ? 0 : glass, flags: FLAG.OFFICE }
      : { style: STYLE.CURTAIN, layer: LY.panel, color: pick(r, [[0.2, 0.22, 0.24], [0.5, 0.52, 0.55], [0.15, 0.2, 0.22], [0.35, 0.3, 0.25]]), bay: 1.5, ww: 1.5, wh: 2.75, sill: 0.1, frame: pick(r, [5, 1, 2]), glass, flags: FLAG.OFFICE | (r() < 0.4 ? FLAG.METAL_SPANDREL : 0) };
  return {
    kind: 'office', fh: 3.8 + r() * 0.3, gh: 5.0 + r() * 0.8, fac, lobby: true, roof: 'flat',
    roofLayer: pick(r, [LY.membrane, LY.gravel]), roofColor: [0.6, 0.6, 0.6], plantScreen: r() < 0.7, parapet: 1.1, noSolar: r() < 0.5,
  };
}
function tower(r, floors) {
  const glass = 1 + Math.floor(r() * 3);
  const resi = r() < 0.3;
  const fac = resi
    ? { style: STYLE.PUNCHED, layer: pick(r, [LY.plaster, LY.concrete, LY.panel]), color: pick(r, PLASTER_MODERN), bay: 3.0, ww: 2.2, wh: 2.35, sill: 0.1, frame: 1, glass: 0, flags: 0 }
    : { style: STYLE.CURTAIN, layer: LY.panel, color: pick(r, [[0.2, 0.22, 0.24], [0.45, 0.47, 0.5], [0.12, 0.16, 0.18], [0.3, 0.27, 0.22]]), bay: 1.5, ww: 1.5, wh: 2.8, sill: 0.1, frame: pick(r, [5, 5, 1, 2]), glass, flags: FLAG.OFFICE | (r() < 0.3 ? FLAG.METAL_SPANDREL : 0) };
  // crown: louvred plant floors, a glass screen parapet hiding the plant,
  // a plain roof with a louvred plant enclosure, or a telecom mast
  const crownType = resi ? pick(r, [null, null, 'mast']) : pick(r, ['louvre', 'louvre', 'screen', 'screen', 'plant', 'mast']);
  return {
    kind: 'tower', fh: resi ? 3.1 : 3.9, gh: 6.5, fac, lobby: true, roof: 'flat', floors,
    roofLayer: LY.membrane, roofColor: [0.55, 0.55, 0.56], parapet: 1.2, noSolar: true, crownType,
    crown: crownType === 'louvre' ? 4 + r() * 4 : crownType === 'screen' ? 3 + r() * 2.5 : 0,
    crownColor: pick(r, [[0.55, 0.56, 0.58], [0.25, 0.26, 0.28]]), balconies: resi ? 'both' : null,
    plantScreen: crownType === 'plant', mast: crownType === 'mast' ? 10 + r() * 14 : 0,
  };
}

// ------------------------------------------------------------------ spec assembly
let SEED = 1;
function finish(b, r) {
  b.seed = (SEED++ * 37) % 251;
  b.base = b.base ?? 0;
  b.street = b.street || {};
  b.shops = b.shops || {};
  if (b.kind === 'shed') b.gh = 0;
  b.upFloors = Math.max(0, b.floors - 1);
  b.eave = b.base + (b.kind === 'shed' ? b.shedH : b.gh + b.upFloors * b.fh);
  if (b.penthouse) {
    b.upFloors -= 1;
    b.floors -= 1;
    b.eave -= b.fh;
    b.penthouseSide = b.mainSide || 'n';
  }
  b.wallTop = b.roof === 'flat' ? b.eave + (b.parapet ?? 0.9) : b.eave;
  if (b.crown && b.crownType === 'screen') {
    // frit-glass screen standing proud of the roof (plant hidden behind it)
    b.crownPaint = { layer: LY.flat, style: STYLE.GLASS, seed: b.seed, pack: 0, color: [0.3, 0.34, 0.36], grid: [3, 3, 0, 0], win: [0, 0, 0], gw: 0 };
    b.wallTop = b.eave + b.crown;
    b.fac = { ...b.fac, topV: b.eave };
  } else if (b.crown) {
    b.crownPaint = { layer: LY.panel, style: STYLE.LOUVRE, seed: b.seed, pack: 0, color: b.crownColor, grid: [3, 3, 0, 0], win: [0, 0, 0], gw: 0 };
    b.wallTop = b.eave + 0.2;
    b.fac = { ...b.fac, topV: b.wallTop - b.crown }; // windows stop below the louvred plant floors
  }
  if (!b.mainSide) b.mainSide = ['n', 'e', 's', 'w'].find((s) => b.street[s]) || 'n';
  // party walls: plain render / exposed common brick
  const bare = r() < 0.4;
  b.partyLayer = bare ? LY.brick_old : (b.fac.layer === LY.brick || b.fac.layer === LY.brick_old ? b.fac.layer : LY.plaster);
  b.partyColor = bare ? [0.75, 0.66, 0.6] : [0.72, 0.7, 0.66];
  return b;
}

// Split [a,b] into parcel frontages; first/last at least minEnd wide.
function split(a, b, r, minW, maxW, minFirst, minLast) {
  const L = b - a;
  if (L <= 3) return [];
  if (L < minFirst + Math.max(minLast, minW)) return [[a, b]];
  const ws = [Math.max(minFirst, minW + r() * (maxW - minW))];
  let rest = L - ws[0];
  const lastMin = Math.max(minLast, minW);
  while (rest > 1e-6) {
    if (rest <= maxW && rest >= lastMin) { ws.push(rest); break; }
    if (rest < lastMin) { ws[ws.length - 1] += rest; break; }
    let w = minW + r() * (maxW - minW);
    if (rest - w < lastMin) w = rest - lastMin;
    if (w < minW * 0.8) { ws[ws.length - 1] += w; rest -= w; continue; }
    ws.push(w);
    rest -= w;
  }
  const out = [];
  let x = a;
  for (const w of ws) { out.push([x, x + w]); x += w; }
  out[out.length - 1][1] = b;
  return out;
}

function roadSide(lot, s) {
  if (s === 'n') return MAIN_X.has(lot.maxZ + HALF);
  if (s === 's') return MAIN_X.has(lot.minZ - HALF);
  if (s === 'e') return MAIN_Z.has(lot.maxX + HALF);
  return MAIN_Z.has(lot.minX - HALF);
}

// Perimeter block: parcels along the chosen sides of rect B with depth per side.
function perimeter(lot, B, sides, character, baseFloors, r, depthMax = {}) {
  const out = [];
  const D = {};
  for (const s of ['n', 'e', 's', 'w']) D[s] = Math.min(depthMax[s] ?? 99, 12 + r() * 4.5);
  const has = (s) => sides.includes(s);
  const typo = () => {
    const t = r();
    if (character === 'historic') return t < 0.78 ? classic(r) : t < 0.9 ? modern(r) : postwar(r);
    if (character === 'contemporary') return t < 0.7 ? modern(r) : t < 0.88 ? postwar(r) : classic(r);
    return t < 0.4 ? classic(r) : t < 0.72 ? modern(r) : postwar(r);
  };
  const addParcel = (x0, z0, x1, z1, streets, main, corner) => {
    if (!corner && r() < 0.05) return; // vacant plot / gateway
    const b = typo();
    let fl = baseFloors + (r() < 0.25 ? -1 : r() < 0.3 ? 1 : 0) + (corner && r() < 0.5 ? 1 : 0);
    if (b.kind === 'postwar') fl += r() < 0.5 ? 1 : 0;
    b.floors = Math.max(3, fl);
    Object.assign(b, { x0, z0, x1, z1, mainSide: main });
    b.street = streets;
    const shops = {};
    for (const s of Object.keys(streets)) {
      if (!streets[s]) continue;
      shops[s] = b.kind !== 'postwar' && (roadSide(lot, s) ? r() < 0.9 : r() < 0.25);
    }
    b.shops = shops;
    if (corner && b.roof !== 'flat') b.roof = r() < 0.5 ? 'hip' : 'mansard';
    out.push(finish(b, r));
  };
  const minW = character === 'contemporary' ? 18 : 13, maxW = character === 'contemporary' ? 34 : 24;
  // N and S run the full width; W and E fit between them
  if (has('n')) {
    const ps = split(B.x0, B.x1, r, minW, maxW, has('w') ? D.w + 5 : minW, has('e') ? D.e + 5 : minW);
    ps.forEach(([a, b], i) => {
      const cw = i === 0 && has('w'), ce = i === ps.length - 1 && has('e');
      const d = cw || ce ? D.n : Math.min(depthMax.n ?? 99, D.n + (r() - 0.5) * 3);
      addParcel(a, B.z1 - d, b, B.z1, { n: true, w: cw, e: ce }, 'n', cw || ce);
    });
  }
  if (has('s')) {
    const ps = split(B.x0, B.x1, r, minW, maxW, has('w') ? D.w + 5 : minW, has('e') ? D.e + 5 : minW);
    ps.forEach(([a, b], i) => {
      const cw = i === 0 && has('w'), ce = i === ps.length - 1 && has('e');
      const d = cw || ce ? D.s : Math.min(depthMax.s ?? 99, D.s + (r() - 0.5) * 3);
      addParcel(a, B.z0, b, B.z0 + d, { s: true, w: cw, e: ce }, 's', cw || ce);
    });
  }
  const zA = has('s') ? B.z0 + D.s : B.z0, zB = has('n') ? B.z1 - D.n : B.z1;
  for (const s of ['w', 'e']) {
    if (!has(s)) continue;
    const ps = split(zA, zB, r, minW, maxW, has('s') ? minW : D.s + 5, has('n') ? minW : D.n + 5);
    ps.forEach(([a, b], i) => {
      const cs = i === 0 && !has('s'), cn = i === ps.length - 1 && !has('n');
      const d = cs || cn ? D[s] : Math.min(depthMax[s] ?? 99, D[s] + (r() - 0.5) * 3);
      const x0 = s === 'w' ? B.x0 : B.x1 - d, x1 = s === 'w' ? B.x0 + d : B.x1;
      addParcel(x0, a, x1, b, { [s]: true, s: cs, n: cn }, s, cs || cn);
    });
  }
  return { parcels: out, D };
}

function annex(x0, z0, x1, z1, r) {
  const b = postwar(r);
  Object.assign(b, { kind: 'annex', x0, z0, x1, z1, floors: 1 + Math.floor(r() * 2), roof: 'flat', balconies: null, parapet: 0.4, gh: 3.2 });
  b.fac = { ...b.fac, layer: pick(r, [LY.plaster, LY.brick_old, LY.concrete]), ww: 1.4, wh: 1.2, sill: 1.0 };
  b.street = {};
  return finish(b, r);
}

function slabs(lot, r, kind) {
  const out = [];
  const w = lot.maxX - lot.minX, d = lot.maxZ - lot.minZ;
  const n = d > 85 ? 3 : 2;
  const gap = (d - 10 - n * 12) / (n - 1 + 1e-6);
  for (let i = 0; i < n; i++) {
    const b = kind === 'modern' ? modern(r) : postwar(r);
    const len = Math.min(w - 12, 50 + r() * 25);
    const x0 = lot.minX + 6 + r() * (w - 12 - len);
    const z0 = lot.minZ + 5 + i * (12 + gap);
    Object.assign(b, { x0, z0, x1: x0 + len, z1: z0 + 12, floors: 4 + Math.floor(r() * 5), roof: 'flat', mainSide: 's', penthouse: false });
    b.street = { n: true, s: true };
    b.back = kind === 'modern' ? b.back : null;
    b.balconies = 'street';
    b.shops = {};
    out.push(finish(b, r));
  }
  return out;
}

function shedLot(lot, r) {
  const out = [];
  const w = lot.maxX - lot.minX, d = lot.maxZ - lot.minZ;
  const sw = 45 + r() * 25, sd = 32 + r() * 20;
  const x0 = lot.minX + 4 + r() * (w - sw - 8), z0 = lot.minZ + 4 + r() * (d - sd - 8);
  const H = 7 + r() * 4;
  const b = {
    kind: 'shed', x0, z0, x1: x0 + sw, z1: z0 + sd, floors: 1, shedH: H, fh: H, gh: 0,
    fac: { style: STYLE.RIBBON, layer: r() < 0.6 ? LY.corrugated : LY.panel, color: pick(r, [[0.8, 0.8, 0.78], [0.55, 0.6, 0.65], [0.4, 0.45, 0.42], [0.7, 0.66, 0.6]]), bay: 5, ww: 5, wh: 0.9, sill: H - 2.0, frame: 5, glass: 0, flags: 0, topV: H },
    // profiled-sheet roof (seam layer, not mirror-metal zinc: from 47 m a
    // galvanised shed roof reads as flat light grey, not as a white sky mirror)
    roof: 'flat', roofLayer: pick(r, [LY.membrane, LY.seam]), roofColor: pick(r, [[0.62, 0.64, 0.66], [0.5, 0.52, 0.55], [0.7, 0.68, 0.64]]), parapet: 0.5,
    street: { n: true, e: true, s: true, w: true }, shops: {}, groundStyle: 0,
  };
  out.push(finish(b, r));
  // small office front building
  const o = office(r);
  const ow = 16 + r() * 10;
  Object.assign(o, { x0, z0: z0 - 13, x1: x0 + ow, z1: z0, floors: 2 + Math.floor(r() * 2), plantScreen: false, mainSide: 's' });
  if (o.z0 > lot.minZ + 2) { o.street = { s: true, e: true, w: true, n: false }; out.push(finish(o, r)); }
  return out;
}

function officeLot(lot, r, B) {
  // U / O shaped office block: deeper plan (16-20 m), taller, set back 2 m
  const out = [];
  const floors = 7 + Math.floor(r() * 5);
  const D = 16 + r() * 4;
  const sides = r() < 0.5 ? ['n', 'e', 's', 'w'] : pick(r, [['n', 'e', 'w'], ['s', 'e', 'w'], ['n', 's', 'e'], ['n', 's', 'w']]);
  const sets = [];
  const has = (s) => sides.includes(s);
  if (has('n')) sets.push([B.x0, B.z1 - D, B.x1, B.z1, 'n', { n: true, w: has('w'), e: has('e') }]);
  if (has('s')) sets.push([B.x0, B.z0, B.x1, B.z0 + D, 's', { s: true, w: has('w'), e: has('e') }]);
  const zA = has('s') ? B.z0 + D : B.z0, zB = has('n') ? B.z1 - D : B.z1;
  if (has('w')) sets.push([B.x0, zA, B.x0 + D, zB, 'w', { w: true, s: !has('s'), n: !has('n') }]);
  if (has('e')) sets.push([B.x1 - D, zA, B.x1, zB, 'e', { e: true, s: !has('s'), n: !has('n') }]);
  const base = office(r);
  for (const [x0, z0, x1, z1, ms, st] of sets) {
    const b = { ...base, fac: { ...base.fac }, x0, z0, x1, z1, mainSide: ms, street: st, floors: floors + (r() < 0.3 ? 1 : 0), shops: {} };
    for (const s of Object.keys(st)) if (st[s]) b.shops[s] = roadSide(lot, s) && r() < 0.6;
    b.lobby = true;
    out.push(finish(b, r));
  }
  return out;
}

function towerLot(lot, r, B, floors) {
  const out = [];
  // podium over most of the block (retail + lobbies), tower on top
  const pod = office(r);
  const pf = 2 + Math.floor(r() * 2);
  Object.assign(pod, { kind: 'podium', x0: B.x0 + 2, z0: B.z0 + 2, x1: B.x1 - 2, z1: B.z1 - 2, floors: pf, fh: 4.5, gh: 5.5, plantScreen: false, mainSide: 's', noSolar: true });
  pod.street = { n: true, e: true, s: true, w: true };
  pod.shops = { n: r() < 0.7, e: r() < 0.7, s: r() < 0.7, w: r() < 0.7 };
  finish(pod, r);
  out.push(pod);
  const proto = tower(r, floors);
  const tw = 28 + r() * 14, td = 26 + r() * 16;
  const cx = (pod.x0 + pod.x1) / 2 + (r() - 0.5) * (pod.x1 - pod.x0 - tw - 8);
  const cz = (pod.z0 + pod.z1) / 2 + (r() - 0.5) * (pod.z1 - pod.z0 - td - 8);
  // Massing: a straight shaft, or 2-3 tiers each stepping back 1.5-5 m on
  // every side (zoning setbacks / the slimmer top of a real high-rise).
  const want = r() < 0.4 ? 1 : r() < 0.65 ? 2 : 3;
  const rects = [[cx - tw / 2, cz - td / 2, cx + tw / 2, cz + td / 2]];
  while (rects.length < want) {
    const [a0, b0, a1, b1] = rects[rects.length - 1];
    const ix = Math.min(1.5 + r() * 3.5, (a1 - a0 - 16) / 2), iz = Math.min(1.5 + r() * 3.5, (b1 - b0 - 16) / 2);
    if (ix < 1.2 || iz < 1.2) break;
    rects.push([a0 + ix, b0 + iz, a1 - ix, b1 - iz]);
  }
  const nT = rects.length;
  let base = pod.eave, left = floors, below = pod;
  rects.forEach(([x0, z0, x1, z1], k) => {
    const last = k === nT - 1;
    const fl = last ? left : Math.max(4, Math.round(left * (nT - k === 2 ? 0.6 + r() * 0.2 : 0.45 + r() * 0.15)));
    left -= fl;
    const t = { ...proto, fac: { ...proto.fac }, x0, x1, z0, z1, base, gh: proto.fh, floors: fl, mainSide: 's' };
    t.street = { n: true, e: true, s: true, w: true };
    t.shops = {};
    t.lobby = false;
    t.groundStyle = 0;
    if (!last) Object.assign(t, { crown: 0, crownType: null, mast: 0, plantScreen: false, noLights: true, parapet: 1.1 });
    finish(t, r);
    below.roofHoles = [[x0 - 1, z0 - 1, x1 + 1, z1 + 1]];
    out.push(t);
    base = t.eave;
    below = t;
  });
  return out;
}

// ------------------------------------------------------------------ plan
// Hand-composed district: lot (i, j) = x column, z row (site at 3,3).
const LOT_TYPE = {
  '2,2': 'historic', '3,2': 'historic', '4,2': 'office', '2,3': 'mixed', '4,3': 'contemporary', '2,4': 'historic', '3,4': 'contemporary', '4,4': 'mixed',
  '1,1': 'slabs', '1,2': 'historic', '1,3': 'historic', '1,4': 'mixed', '1,5': 'contemporary', '2,1': 'contemporary', '3,1': 'shed', '4,1': 'mixed',
  '5,1': 'office', '5,2': 'contemporary', '5,3': 'office', '5,4': 'tower', '2,5': 'historic', '3,5': 'mixed', '4,5': 'office', '5,5': 'tower',
  '0,0': 'slabs', '0,1': 'tower', '0,2': 'historic', '0,3': 'mixed', '0,4': 'historic', '0,5': 'shed', '0,6': 'contemporary',
  '1,0': 'contemporary', '2,0': 'mixed', '3,0': 'slabs', '4,0': 'shed', '5,0': 'contemporary', '6,0': 'slabs',
  '1,6': 'tower', '2,6': 'contemporary', '3,6': 'historic', '4,6': 'office', '5,6': 'tower', '6,6': 'tower',
  '6,1': 'mixed', '6,2': 'office', '6,3': 'tower', '6,4': 'tower', '6,5': 'tower',
};
// Per-lot typology for other modules (terrain can match lot finishes to it):
// key = `${i},${j}` with i = x column, j = z row of layout.lots() (site = 3,3);
// lotType(lot) resolves a lots() rectangle. Unlisted lots are 'mixed'.
export const LOT_TYPES = LOT_TYPE;
export function lotType(lot) {
  const i = XS.findIndex((x) => x > lot.minX) - 1, j = ZS.findIndex((z) => z > lot.minZ) - 1;
  return lot.site ? 'site' : LOT_TYPE[`${i},${j}`] || 'mixed';
}
const TOWER_FLOORS = { '5,4': 22, '5,5': 30, '0,1': 26, '1,6': 20, '5,6': 34, '6,6': 38, '6,3': 24, '6,4': 32, '6,5': 36 };

export function planCity() {
  SEED = 1;
  const out = [];
  const all = lots();
  for (const lot of all) {
    const i = XS.findIndex((x) => x > lot.minX) - 1;
    const j = ZS.findIndex((z) => z > lot.minZ) - 1;
    const key = `${i},${j}`;
    const r = rng(1000 + i * 31 + j * 7);
    const cx = (lot.minX + lot.maxX) / 2, cz = (lot.minZ + lot.maxZ) / 2;
    const dist = Math.hypot(cx, cz);
    const B = { x0: lot.minX + 1, x1: lot.maxX - 1, z0: lot.minZ + 1, z1: lot.maxZ - 1 };
    let buildings = [];
    if (lot.site) {
      // neighbours of the site: perimeter along N, W, E; the site itself is the "courtyard"
      const ex = NEIGHBOUR_EXCLUDE;
      const res = perimeter(lot, B, ['n', 'w', 'e'], 'mixed', 6, r, { n: B.z1 - ex.maxZ - 1, w: ex.minX - B.x0 - 1, e: B.x1 - ex.maxX - 1 });
      buildings = res.parcels;
    } else {
      const type = LOT_TYPE[key] || 'mixed';
      const baseF = dist < 220 ? 5 + Math.floor(r() * 2) : dist < 340 ? 5 + Math.floor(r() * 3) : 6 + Math.floor(r() * 3);
      if (type === 'historic' || type === 'contemporary' || type === 'mixed') {
        const res = perimeter(lot, B, ['n', 'e', 's', 'w'], type, type === 'historic' ? Math.min(baseF, 6) : baseF, r);
        buildings = res.parcels;
        // courtyard outbuildings
        if (r() < 0.45) {
          const ix0 = B.x0 + res.D.w + 6, ix1 = B.x1 - res.D.e - 6, iz0 = B.z0 + res.D.s + 6, iz1 = B.z1 - res.D.n - 6;
          if (ix1 - ix0 > 16 && iz1 - iz0 > 14) {
            const w = 10 + r() * Math.min(20, ix1 - ix0 - 12), d = 8 + r() * Math.min(12, iz1 - iz0 - 10);
            const x0 = ix0 + r() * (ix1 - ix0 - w), z0 = iz0 + r() * (iz1 - iz0 - d);
            buildings.push(annex(x0, z0, x0 + w, z0 + d, r));
          }
        }
      } else if (type === 'office') buildings = officeLot(lot, r, { x0: B.x0 + 1, x1: B.x1 - 1, z0: B.z0 + 1, z1: B.z1 - 1 });
      else if (type === 'tower') buildings = towerLot(lot, r, B, TOWER_FLOORS[key] || 24);
      else if (type === 'slabs') buildings = slabs(lot, r, r() < 0.5 ? 'postwar' : 'modern');
      else if (type === 'shed') buildings = shedLot(lot, r);
    }
    out.push({ key, cx, cz, dist, seed: 5000 + i * 13 + j * 101, buildings });
  }
  return out;
}

// ------------------------------------------------------------------ skyline
// Blocks beyond the lot grid: simplified perimeter blocks (boxes) + CBD towers.
export function planSkyline(density = 1, rMax = 1650) {
  const r = rng(90210);
  const pitch = 110;
  const out = [];
  const xs = [], zs = [];
  for (let x = XS[0] - pitch * 12; x <= XS[XS.length - 1] + pitch * 12; x += pitch) xs.push(x);
  for (let z = ZS[0] - pitch * 12; z <= ZS[ZS.length - 1] + pitch * 12; z += pitch) zs.push(z);
  const inGrid = (x, z) => x > XS[0] - 5 && x < XS[XS.length - 1] + 5 && z > ZS[0] - 5 && z < ZS[ZS.length - 1] + 5;
  const cbd = { x: 900, z: 820 };
  for (let a = 0; a < xs.length - 1; a++) {
    for (let c = 0; c < zs.length - 1; c++) {
      const x0 = xs[a] + HALF, x1 = xs[a + 1] - HALF, z0 = zs[c] + HALF, z1 = zs[c + 1] - HALF;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      if (inGrid(cx, cz)) continue;
      const d = Math.hypot(cx, cz);
      if (d > rMax) continue;
      const far = (d - CITY_EXTENT) / (rMax - CITY_EXTENT);
      if (r() > density * (1.05 - far * 0.35)) continue;
      const dc = Math.hypot(cx - cbd.x, cz - cbd.z);
      const cbdF = Math.max(0, 1 - dc / 650);
      const blocks = [];
      if (cbdF > 0.15 && r() < 0.35 + cbdF * 0.6) {
        // high-rise: 1-2 towers on a podium
        const n = r() < 0.4 ? 2 : 1;
        blocks.push({ x0: x0 + 2, z0: z0 + 2, x1: x1 - 2, z1: z1 - 2, h: 9 + r() * 6, type: 'podium' });
        for (let k = 0; k < n; k++) {
          const tw = 24 + r() * 16, td = 24 + r() * 16;
          const tx = x0 + 6 + r() * (x1 - x0 - tw - 12), tz = z0 + 6 + r() * (z1 - z0 - td - 12);
          blocks.push({ x0: tx, z0: tz, x1: tx + tw, z1: tz + td, h: 60 + r() * r() * 170 * (0.5 + cbdF), type: 'tower', base: 0 });
        }
      } else if (r() < 0.07 * density) {
        const tw = 22 + r() * 12;
        blocks.push({ x0: cx - tw / 2, z0: cz - tw / 2, x1: cx + tw / 2, z1: cz + tw / 2, h: 45 + r() * 50, type: 'tower' });
      } else {
        // perimeter block of 6-12 boxes of varied height
        const D = 13 + r() * 4;
        const baseH = 15 + r() * 10 + cbdF * 12;
        const edge = (ax0, az0, ax1, az1, alongX) => {
          let p = alongX ? ax0 : az0;
          const end = alongX ? ax1 : az1;
          while (end - p > 6) {
            const w = Math.min(end - p, 14 + r() * 20);
            const h = baseH + (r() - 0.5) * 8;
            if (r() < 0.95) blocks.push(alongX ? { x0: p, z0: az0, x1: p + w, z1: az1, h, type: 'block' } : { x0: ax0, z0: p, x1: ax1, z1: p + w, h, type: 'block' });
            p += w;
          }
        };
        edge(x0 + 1, z1 - 1 - D, x1 - 1, z1 - 1, true);
        edge(x0 + 1, z0 + 1, x1 - 1, z0 + 1 + D, true);
        edge(x0 + 1, z0 + 1 + D, x0 + 1 + D, z1 - 1 - D, false);
        edge(x1 - 1 - D, z0 + 1 + D, x1 - 1, z1 - 1 - D, false);
      }
      out.push({ cx, cz, d, blocks });
    }
  }
  return out;
}
