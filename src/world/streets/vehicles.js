import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { GeoBuilder, M, patchShader, radialTexture, ROAD_Y } from './common.js';
import { loftBody, LOFT_TYPES } from './carbody.js';

// Procedural vehicles. Each type is ONE merged geometry whose vertices carry
// their own material parameters (colour, roughness, metalness, paint mask,
// emissive lamp type) plus a wheel-hub attribute, so every vehicle type —
// body, glass, trim, lamps, rotating wheels — is a single instanced draw call
// with one shared MeshPhysicalMaterial (clear-coated paint, env reflections).
//
// Local frame: +x forward, +y up, +z = right-hand side, origin on the ground
// at the centre of the footprint.

// Material slots. pbr = [roughness, metalness, paintMask, lampType]
// lampType: 1 headlamp · 2 tail/brake · 3 daytime running light · 4 amber · 5 LED sign
const S = {
  paint: { color: [1, 1, 1], pbr: [0.34, 0.5, 1, 0] }, // colour + metalness per instance
  glass: { color: [0.010, 0.012, 0.014], pbr: [0.03, 0, 0, 0] },
  trim: { color: [0.02, 0.02, 0.021], pbr: [0.62, 0, 0, 0] }, // grained black plastic
  gloss: { color: [0.008, 0.008, 0.009], pbr: [0.1, 0, 0, 0] }, // piano-black trim / grille
  liner: { color: [0.012, 0.012, 0.012], pbr: [0.92, 0, 0, 0] },
  tyre: { color: [0.02, 0.02, 0.02], pbr: [0.86, 0, 0, 0] },
  rim: { color: [0.42, 0.43, 0.45], pbr: [0.3, 1, 0, 0] },
  rimDark: { color: [0.05, 0.05, 0.055], pbr: [0.32, 0.9, 0, 0] },
  hub: { color: [0.05, 0.045, 0.04], pbr: [0.7, 0.4, 0, 0] }, // brake disc / wheel well gloom
  chrome: { color: [0.8, 0.8, 0.82], pbr: [0.1, 1, 0, 0] },
  head: { color: [0.55, 0.57, 0.6], pbr: [0.05, 0.8, 0, 1] },
  drl: { color: [0.6, 0.6, 0.6], pbr: [0.2, 0, 0, 3] },
  tail: { color: [0.16, 0.004, 0.004], pbr: [0.12, 0, 0, 2] },
  amber: { color: [0.3, 0.1, 0.0], pbr: [0.15, 0, 0, 4] },
  plate: { color: [0.7, 0.7, 0.68], pbr: [0.4, 0, 0, 0] },
  plateTxt: { color: [0.03, 0.03, 0.035], pbr: [0.5, 0, 0, 0] },
  box: { color: [0.62, 0.62, 0.6], pbr: [0.42, 0, 0, 0] }, // truck box body (GRP panels)
  steel: { color: [0.08, 0.08, 0.085], pbr: [0.55, 0.6, 0, 0] }, // chassis
  sign: { color: [0.02, 0.02, 0.02], pbr: [0.3, 0, 0, 5] },
};

const EXTRA = { color: 3, pbr: 4, wheel: 4 };

// ------------------------------------------------------------------ specs
// Profiles are side views (x from the rear bumper, y up), built with the
// THREE.Path API: [method, ...args].
const PI = Math.PI;
const arch = (x, r, a = 0.08, y = r) => ['absarc', x, y, r, PI - a, a, true];

export const VEHICLE_TYPES = {
  bus: {
    L: 12.0, W: 2.55, r: 0.5, tw: 0.3, axles: [3.35, 9.3], archR: 0.6,
    belt: 1.2, roofY: 3.05, tumble: 0.02, endLen: 0.4, endPinch: 0.04, bevel: 0.14,
    glassRule: (c, n) => (n.x > 0.8 && c.y > 0.95 && c.y < 2.72) || (n.x < -0.8 && c.y > 1.5 && c.y < 2.6),
    body: [
      ['moveTo', 0.0, 0.46], ['lineTo', 0.06, 0.32], ['lineTo', 2.72, 0.32], ['lineTo', 2.74, 0.4],
      arch(3.35, 0.61, 0.05, 0.5), ['lineTo', 3.97, 0.3], ['lineTo', 8.68, 0.3], ['lineTo', 8.7, 0.4],
      arch(9.3, 0.61, 0.05, 0.5), ['lineTo', 9.92, 0.3], ['lineTo', 11.86, 0.32],
      ['quadraticCurveTo', 12.0, 0.35, 12.0, 0.55], ['lineTo', 11.96, 2.8], ['quadraticCurveTo', 11.9, 3.04, 11.6, 3.05],
      ['lineTo', 0.4, 3.05], ['quadraticCurveTo', 0.02, 3.05, 0.0, 2.8],
    ],
    windows: [
      [[1.0, 1.3], [1.0, 2.62], [5.5, 2.62], [5.5, 1.3]],
      [[7.0, 1.3], [7.0, 2.62], [10.05, 2.62], [10.05, 1.3]],
    ],
    windowsLeft: [[[1.0, 1.3], [1.0, 2.62], [11.4, 2.62], [11.6, 1.3]]],
    doorsGlass: [[[10.2, 0.4], [10.2, 2.62], [11.45, 2.62], [11.6, 1.3], [11.6, 0.4]], [[5.62, 0.4], [5.62, 2.62], [6.88, 2.62], [6.88, 0.4]]],
    pillars: [],
    doors: [],
    front: { lampY: 0.7, lampZ: 0.95, grilleY: 0.5, plateY: 0.45, bus: true },
    rear: { lampY: 0.9, lampZ: 1.05, plateY: 0.6, vertical: true },
    mirrorX: 11.7, mirrorY: 2.2,
  },
  truck: {
    L: 7.3, W: 2.4, r: 0.46, tw: 0.26, axles: [2.1, 5.95], archR: 0.55, dual: true,
    belt: 1.55, roofY: 2.82, tumble: 0.03, endLen: 0.3, endPinch: 0.05, bevel: 0.1,
    glassRule: (c, n) => n.x > 0.75 && c.y > 1.6 && c.y < 2.62,
    body: [ // cab only (cab-over); box body and chassis are added separately
      ['moveTo', 5.35, 0.62], ['lineTo', 5.36, 0.62], arch(5.95, 0.56, 0.02, 0.62), ['lineTo', 6.52, 0.62],
      ['lineTo', 7.22, 0.62], ['quadraticCurveTo', 7.3, 0.64, 7.3, 0.8], ['lineTo', 7.28, 1.4],
      ['lineTo', 7.2, 2.6], ['quadraticCurveTo', 7.14, 2.8, 6.9, 2.82], ['lineTo', 5.45, 2.82], ['quadraticCurveTo', 5.35, 2.82, 5.35, 2.7],
    ],
    windows: [[[7.02, 1.62], [6.95, 2.55], [6.2, 2.55], [6.2, 1.62]]],
    pillars: [],
    doors: [6.1],
    front: { lampY: 0.95, lampZ: 0.92, grilleY: 1.25, plateY: 0.75, truck: true },
    rear: { lampY: 0.55, lampZ: 1.0, plateY: 0.45, truck: true },
    mirrorX: 7.05, mirrorY: 2.1,
    boxBody: { x0: 0.0, x1: 5.2, y0: 0.98, y1: 3.45, w: 2.46 },
  },
};
// cars and the van are lofted shells (carbody.js); bus and truck are
// extruded boxes, which is what they are
for (const [k, sp] of Object.entries(LOFT_TYPES)) VEHICLE_TYPES[k] = { ...sp, loft: true, roofY: Math.max(...sp.top.map((p) => p[1])) };
export const TYPE_NAMES = ['sedan', 'hatch', 'suv', 'van', 'bus', 'truck'];

// ------------------------------------------------------------------ builder
function shapeFrom(cmds) {
  const s = new THREE.Shape();
  for (const [m, ...a] of cmds) s[m](...a);
  s.closePath();
  return s;
}

function extrude(shape, width, bevel, lod) {
  if (lod >= 2) bevel = 0;
  const depth = Math.max(0.01, width - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, steps: 1, curveSegments: lod >= 2 ? 1 : lod ? 2 : 6,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: lod ? 1 : 3,
  });
  g.translate(0, 0, -depth / 2);
  return g;
}

function polyPlate(pts, thick) {
  const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  return new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false, curveSegments: 1 });
}

// Tyre (lathe) + alloy rim. Axis along z, outer face towards +z, centred at 0.
function wheelParts(r, tw, lod, dark) {
  const parts = [];
  const seg = lod >= 2 ? 5 : lod ? 7 : 18;
  const h = tw / 2;
  const prof = lod
    ? [[r * 0.66, -h], [r, -h + 0.02], [r, h - 0.02], [r * 0.66, h]]
    : [[r * 0.64, -h], [r * 0.9, -h], [r * 0.985, -h + 0.02], [r, -h + 0.05], [r, h - 0.05], [r * 0.985, h - 0.02], [r * 0.9, h], [r * 0.64, h]];
  const tyre = new THREE.LatheGeometry(prof.map(([a, b]) => new THREE.Vector2(a, b)), seg);
  tyre.rotateX(PI / 2);
  parts.push([tyre, S.tyre]);
  const rimR = r * 0.64;
  const rimMat = dark ? S.rimDark : S.rim;
  if (lod) {
    if (lod < 2) parts.push([new THREE.CircleGeometry(rimR, seg).translate(0, 0, h - 0.03), rimMat]);
    return parts;
  }
  parts.push([new THREE.CircleGeometry(rimR * 0.97, 16).translate(0, 0, h - 0.09), S.hub]); // gloom behind the spokes
  parts.push([new THREE.RingGeometry(rimR * 0.8, rimR, 20, 1).translate(0, 0, h - 0.035), rimMat]);
  const n = 5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * PI * 2;
    const len = rimR * 0.78;
    const g = new THREE.BoxGeometry(len, rimR * 0.2, 0.035);
    g.translate(len / 2 + 0.03, 0, 0);
    g.rotateZ(a);
    g.translate(0, 0, h - 0.045);
    parts.push([g, rimMat]);
  }
  parts.push([new THREE.CylinderGeometry(rimR * 0.2, rimR * 0.24, 0.03, 10).rotateX(PI / 2).translate(0, 0, h - 0.03), rimMat]);
  return parts;
}

// Lofted car / van: body shell + separately modelled bits that stand proud
// of it (mirrors, plates, handles, roof rails, van rear doors) + wheels.
function buildLoftVehicle(typeName, sp, lod) {
  const L = sp.L;
  const b = new GeoBuilder(EXTRA);
  const body = loftBody(sp, lod);
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.BufferAttribute(body.pos, 3));
  shell.translate(-L / 2, 0, 0);
  // creased normals: smooth panels, crisp shoulder / arch lips / cap edges
  b.add(toCreasedNormals(shell, 0.62), null, (c, n, t) => S[body.slot[t]]);
  const cx = (x) => x - L / 2; // spec x (from the rear) → centred
  const part = (g, m, slot) => b.add(g, m, slot);
  const bx = (sx, sy, sz) => new THREE.BoxGeometry(sx, sy, sz);
  if (lod < 2) {
    // door mirrors on stalks at the base of the A-pillar
    const [mx, my] = sp.mirror;
    const ms = body.section(mx);
    const zs = ms.P[6][0];
    const big = !!sp.mirrorBig;
    for (const s of [1, -1]) {
      part(bx(0.08, 0.035, 0.12), M(cx(mx) + 0.02, my + 0.02, s * (zs + 0.05)), S.trim);
      const hs = big ? [0.07, 0.17, 0.11] : [0.065, 0.058, 0.115];
      const housing = lod ? bx(hs[0] * 2, hs[1] * 2, hs[2] * 2) : new THREE.SphereGeometry(1, 10, 7).scale(...hs);
      part(housing, M(cx(mx), my + (big ? 0.12 : 0.06), s * (zs + 0.15), 0, s * 0.12, 0), big ? S.trim : S.paint);
      if (!lod) part(bx(0.012, hs[1] * 1.6, hs[2] * 1.7), M(cx(mx) - hs[0] + 0.004, my + (big ? 0.12 : 0.06), s * (zs + 0.15), 0, s * 0.12, 0), S.glass);
    }
    // number plates (520 × 110 mm) proud of the bumpers
    part(bx(0.02, 0.115, 0.52), M(L / 2 + 0.03, sp.plateF, 0), S.plate);
    part(bx(0.02, 0.115, 0.52), M(-L / 2 - 0.03, sp.plateR, 0), S.plate);
    if (!lod) {
      part(bx(0.022, 0.05, 0.38), M(L / 2 + 0.032, sp.plateF, 0.03), S.plateTxt);
      part(bx(0.022, 0.05, 0.38), M(-L / 2 - 0.032, sp.plateR, -0.03), S.plateTxt);
      // door handles near the rear edge of each side door
      const d = sp.doors || [];
      for (let i = 0; i < d.length - 1; i++) {
        const hx = d[i] + 0.2;
        const hs = body.section(hx);
        for (const s of [1, -1]) part(bx(0.17, 0.028, 0.03), M(cx(hx), hs.beltE - 0.075, s * (hs.P[5][0] + 0.006)), S.trim);
      }
    }
    if (sp.roofRails) {
      for (const s of [1, -1]) {
        const pts = [];
        for (let x = 0.45; x <= 2.55; x += 0.35) {
          const q = body.section(x);
          pts.push(new THREE.Vector3(cx(x), q.P[9][1] + 0.035, s * q.P[9][0] * 0.93));
        }
        part(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), lod ? 4 : 10, 0.017, lod ? 4 : 6, false), null, S.trim);
      }
    }
    if (sp.vanRear) {
      // twin rear doors: split line, windows, vertical lamps, step bumper
      const x0 = -L / 2 - 0.018;
      part(bx(0.01, 1.55, 0.012), M(x0, 1.2, 0), S.liner);
      for (const s of [1, -1]) {
        part(bx(0.012, 0.52, 0.68), M(x0, 1.64, s * 0.42), S.glass);
        part(bx(0.05, 0.62, 0.12), M(x0 + 0.01, 0.9, s * 0.86), S.tail);
      }
      part(bx(0.16, 0.12, sp.W - 0.12), M(-L / 2 + 0.02, 0.5, 0), S.trim);
    }
  }
  // wheels (not part of the shell); hub attribute drives rolling in the shader
  const dark = typeName === 'suv';
  const wparts = wheelParts(sp.r, sp.tw, lod, dark);
  const zc = sp.W / 2 - sp.tw / 2 - 0.028;
  for (const ax of sp.axles) {
    const x = cx(ax);
    for (const s of [1, -1]) {
      const m = M(x, sp.r, s * zc, 0, s > 0 ? 0 : PI, 0);
      for (const [g, slot] of wparts) b.add(g, m, { ...slot, wheel: [x, sp.r, s * zc, sp.r] });
    }
  }
  const geo = b.build();
  geo.userData = { type: typeName, L, W: sp.W, H: sp.roofY };
  return geo;
}

export function buildVehicleGeometry(typeName, lod = 0) {
  const sp = VEHICLE_TYPES[typeName];
  if (sp.loft) return buildLoftVehicle(typeName, sp, lod);
  const L = sp.L, W = sp.W, hw = W / 2;
  const b = new GeoBuilder(EXTRA);
  const pieces = []; // [geometry (rear-origin coords), slot|fn, creased]

  // pinch: tumblehome above the beltline and rounded corners in plan view
  const pinch = (g) => {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i);
      let f = 1;
      if (y > sp.belt) f -= sp.tumble * Math.min(1, (y - sp.belt) / (sp.roofY - sp.belt));
      const e = Math.max(0, Math.abs(x) - (L / 2 - sp.endLen)) / sp.endLen;
      f *= 1 - sp.endPinch * e * e * (0.6 + 0.4 * Math.min(1, y / sp.belt));
      p.setZ(i, p.getZ(i) * f);
    }
  };

  const axlesC = sp.axles.map((a) => a - L / 2);
  const bodyRule = (c, n) => {
    if (n.y < -0.6) return S.liner;
    for (const ax of axlesC) {
      const dx = c.x - ax, dy = c.y - sp.r;
      if (dx * dx + dy * dy < (sp.archR + 0.05) ** 2 && Math.abs(n.z) < 0.4) return S.liner;
    }
    if (sp.glassRule && sp.glassRule({ x: c.x + L / 2, y: c.y }, n)) return S.glass;
    if (sp.cladding && c.y < sp.cladding) return S.trim;
    if (sp.front.bus && c.y < 0.38) return S.trim;
    return S.paint;
  };
  const ghRule = (c, n) => {
    if (Math.abs(n.z) < 0.55 && Math.abs(n.x) > 0.22 && n.y > -0.3) return S.glass;
    return S.paint;
  };

  pieces.push([extrude(shapeFrom(sp.body), W, sp.bevel, lod), bodyRule, true]);
  if (sp.gh) pieces.push([extrude(shapeFrom(sp.gh), sp.ghW, lod ? 0.03 : 0.05, lod), ghRule, true]);
  const sideW = sp.gh ? sp.ghW / 2 : hw;

  // side glass (both sides) as thin plates just proud of the greenhouse
  const plate = (pts, slot, z0, thick = 0.012, sides = [1, -1]) => {
    for (const s of sides) {
      const g = polyPlate(pts, thick);
      g.translate(0, 0, s > 0 ? z0 : -z0 - thick);
      pieces.push([g, slot, false]);
    }
  };
  for (const w of sp.windows) plate(w, S.glass, sideW + 0.002, 0.012, sp.windowsLeft ? [1] : [1, -1]);
  if (sp.windowsLeft) for (const w of sp.windowsLeft) plate(w, S.glass, sideW + 0.002, 0.012, [-1]);
  if (sp.doorsGlass) for (const w of sp.doorsGlass) plate(w, S.glass, sideW + 0.004, 0.014, [1]);
  if (!lod) for (const p of sp.pillars) plate(p, S.gloss, sideW + 0.004, 0.012);

  const box = (sx, sy, sz, x, y, z, slot, rz = 0, ry = 0) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.applyMatrix4(M(x, y, z, 0, ry, rz));
    pieces.push([g, slot, false]);
  };
  const F = sp.front, R = sp.rear;

  // lamps, grille, plates
  if (F.bus) {
    box(0.03, 1.85, 2.2, L - 0.02, 1.83, 0, S.glass); // one-piece windscreen
    box(0.03, 0.22, 1.7, L - 0.01, 2.88, 0, S.sign); // destination display
    for (const s of [1, -1]) box(0.06, 0.12, 0.34, L - 0.02, F.lampY, s * F.lampZ, S.head);
    box(0.04, 0.3, 1.2, L - 0.01, 0.5, 0, S.trim);
  } else if (F.truck) {
    for (const s of [1, -1]) box(0.05, 0.14, 0.3, L - 0.01, F.lampY, s * F.lampZ, S.head);
    box(0.05, 0.45, 1.4, L - 0.01, F.grilleY, 0, S.trim);
    box(0.12, 0.3, W - 0.1, L - 0.02, 0.72, 0, S.trim); // bumper
  } else {
    for (const s of [1, -1]) {
      box(0.3, 0.085, 0.44, L - 0.13, F.lampY, s * F.lampZ, S.head, -0.28, s * 0.12);
      if (!lod) box(0.2, 0.018, 0.4, L - 0.1, F.lampY - 0.055, s * F.lampZ, S.drl, -0.2, s * 0.12);
    }
    box(0.06, 0.13, 0.62, L - 0.035, F.grilleY, 0, S.gloss);
    box(0.06, 0.1, W * 0.62, L - 0.03, F.intakeY, 0, S.trim);
  }
  if (!lod && !F.bus) {
    box(0.02, 0.11, 0.52, L + 0.004 - (F.truck ? 0 : 0.02), F.plateY, 0, S.plate);
    box(0.022, 0.05, 0.36, L + 0.006 - (F.truck ? 0 : 0.02), F.plateY, 0, S.plateTxt);
  }
  // rear
  for (const s of [1, -1]) {
    if (R.vertical) box(0.06, 0.34, 0.14, 0.02, R.lampY, s * R.lampZ, S.tail);
    else if (R.truck) box(0.06, 0.12, 0.3, 0.02, R.lampY + 0.4, s * R.lampZ, S.tail);
    else {
      box(0.1, 0.09, 0.42, 0.06, R.lampY, s * R.lampZ, S.tail);
      box(0.3, 0.09, 0.04, 0.18, R.lampY, s * (hw - 0.05), S.tail);
    }
  }
  if (!lod) {
    box(0.02, 0.11, 0.52, -0.004, R.plateY, 0, S.plate);
    box(0.022, 0.05, 0.36, -0.006, R.plateY, 0, S.plateTxt);
    if (R.diffuser) box(0.08, 0.1, W * 0.7, 0.05, 0.3, 0, S.trim);
    if (R.spoiler) box(0.22, 0.04, sp.ghW * 0.8, 0.2, 1.44, 0, S.paint);
    // door shut lines (dark hairlines) + handles
    for (const x of sp.doors) {
      for (const s of [1, -1]) {
        box(0.008, sp.belt - 0.3, 0.006, x, (sp.belt + 0.3) / 2, s * (hw + 0.002), S.liner);
      }
    }
    for (let i = 0; i < sp.doors.length - 1; i++) {
      const x = sp.doors[i] - 0.25;
      for (const s of [1, -1]) box(0.16, 0.025, 0.02, x, sp.belt - 0.12, s * (hw + 0.006), S.trim);
    }
    // mirrors
    for (const s of [1, -1]) {
      box(0.07, 0.035, 0.12, sp.mirrorX + 0.02, sp.mirrorY - 0.02, s * (sideW + 0.05), S.trim); // stalk
      box(0.1, 0.1, 0.17, sp.mirrorX, sp.mirrorY + 0.03, s * (sideW + 0.15), F.bus || F.truck ? S.trim : S.paint, 0, s * 0.15);
    }
    if (sp.roofRails) for (const s of [1, -1]) box(1.9, 0.04, 0.04, 1.6, sp.roofY + 0.02, s * 0.62, S.trim);
  }
  if (sp.boxBody) {
    const bb = sp.boxBody;
    const g = new THREE.BoxGeometry(bb.x1 - bb.x0, bb.y1 - bb.y0, bb.w, 1, 1, 1);
    g.translate((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2, 0);
    pieces.push([g, S.box, false]);
    box(bb.x1 - bb.x0 + 0.02, 0.08, bb.w + 0.02, (bb.x0 + bb.x1) / 2, bb.y0 + 0.04, 0, S.steel); // lower rail
    box(bb.x1 - bb.x0 + 0.02, 0.06, bb.w + 0.02, (bb.x0 + bb.x1) / 2, bb.y1 - 0.03, 0, S.steel); // top rail
    box(0.05, bb.y1 - bb.y0, 0.04, bb.x0 - 0.005, (bb.y0 + bb.y1) / 2, 0, S.steel); // rear door split
    box(6.9, 0.25, 0.9, 3.5, 0.72, 0, S.steel); // chassis rails
    for (const s of [1, -1]) box(1.2, 0.5, 0.04, sp.axles[0], 0.95, s * (bb.w / 2 - 0.1), S.trim); // mud flaps / guards
    box(0.1, 0.12, W - 0.2, 0.1, 0.5, 0, S.steel); // under-run bar
  }

  for (const [g0, slot, creased] of pieces) {
    g0.translate(-L / 2, 0, 0);
    pinch(g0);
    const g = creased ? toCreasedNormals(g0, 0.62) : g0;
    b.add(g, null, typeof slot === 'function' ? slot : slot);
  }

  // wheels (not pinched); hub attribute drives the rolling rotation in the shader
  const dark = typeName === 'suv' || typeName === 'bus' || typeName === 'truck';
  const wparts = wheelParts(sp.r, sp.tw, lod, dark);
  const zOut = hw - sp.tw / 2 - 0.03;
  sp.axles.forEach((ax, ai) => {
    const x = ax - L / 2;
    const zs = sp.dual && ai === 0 ? [zOut, zOut - sp.tw - 0.02] : [zOut];
    for (const zc of zs) {
      for (const s of [1, -1]) {
        const m = M(x, sp.r, s * zc, 0, s > 0 ? 0 : PI, 0);
        for (const [g, slot] of wparts) b.add(g, m, { ...slot, wheel: [x, sp.r, s * zc, sp.r] });
      }
    }
  });
  const geo = b.build();
  geo.userData = { type: typeName, L, W, H: sp.roofY ?? 1.5 };
  return geo;
}

// ------------------------------------------------------------------ material
export function vehicleMaterial() {
  const uniforms = { uNight: { value: 0 } };
  const mat = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 1, metalness: 1, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1,
  });
  patchShader(mat, 'vehicle', {
    uniforms,
    vertexPars: 'attribute vec4 pbr; attribute vec4 wheel; attribute vec4 iData; varying vec4 vPbr; varying vec2 vLamp;',
    vertex: {
      beginnormal_vertex: `vec3 objectNormal = vec3( normal );
        float wAng = wheel.w > 0.0 ? -iData.x / wheel.w : 0.0;
        float wc = cos( wAng ), ws = sin( wAng );
        if ( wheel.w > 0.0 ) objectNormal.xy = vec2( wc * objectNormal.x - ws * objectNormal.y, ws * objectNormal.x + wc * objectNormal.y );`,
      begin_vertex: `vec3 transformed = vec3( position );
        if ( wheel.w > 0.0 ) { vec2 d = transformed.xy - wheel.xy; transformed.xy = wheel.xy + vec2( wc * d.x - ws * d.y, ws * d.x + wc * d.y ); }`,
      color_vertex: `vColor = vec4( color, 1.0 );
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb = mix( color, color * instanceColor.rgb, pbr.z );
        #endif
        vPbr = pbr;
        vPbr.y = mix( pbr.y, iData.z, pbr.z );
        vLamp = iData.yw;`,
    },
    fragmentPars: 'uniform float uNight; varying vec4 vPbr; varying vec2 vLamp;',
    fragment: {
      roughnessmap_fragment: 'float roughnessFactor = vPbr.x;',
      metalnessmap_fragment: 'float metalnessFactor = vPbr.y;',
      lights_physical_fragment: '$\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= vPbr.z;\n#endif',
      emissivemap_fragment: `$
        {
          float lt = vPbr.w, on = vLamp.y, brake = vLamp.x;
          vec3 e = vec3( 0.0 );
          if ( lt > 0.5 && lt < 1.5 ) e = vec3( 1.0, 0.93, 0.82 ) * ( on * uNight * 30.0 );
          else if ( lt < 2.5 && lt > 1.5 ) e = vec3( 1.0, 0.03, 0.015 ) * ( on * uNight * 5.0 + brake * 18.0 );
          else if ( lt < 3.5 && lt > 2.5 ) e = vec3( 0.85, 0.92, 1.0 ) * ( on * ( 2.5 + uNight * 3.0 ) );
          else if ( lt < 4.5 && lt > 3.5 ) e = vec3( 1.0, 0.45, 0.05 ) * 0.0;
          else if ( lt > 4.5 ) e = vec3( 1.0, 0.55, 0.12 ) * ( on * 3.0 );
          totalEmissiveRadiance += e;
        }`,
    },
  });
  mat.userData.uniforms = uniforms;
  return mat;
}

// ------------------------------------------------------------------ renderer
// Instanced renderer with two LODs per type and a soft contact shadow under
// every vehicle (keeps them grounded at night and beyond the sun shadow map).
const LOD_DIST = [40, 120]; // metres: full detail · simplified · silhouette
export class VehicleRenderer {
  constructor(root, capacity /* {type: n} */, { shadows = true } = {}) {
    this.material = vehicleMaterial();
    this.types = {};
    let total = 0;
    for (const t of TYPE_NAMES) {
      const n = capacity[t] || 0;
      if (!n) continue;
      total += n;
      const lods = [0, 1, 2].map((lod) => {
        const geo = buildVehicleGeometry(t, lod);
        const data = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
        data.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('iData', data);
        const mesh = new THREE.InstancedMesh(geo, this.material, n);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        // bounding sphere refreshed every frame in end() so each LOD mesh is
        // culled per view AND per shadow cascade (else drawn whole into all 3)
        mesh.castShadow = shadows && lod < 2;
        mesh.receiveShadow = true;
        mesh.name = `vehicles.${t}.lod${lod}`;
        root.add(mesh);
        return { mesh, data };
      });
      this.types[t] = { lods, spec: VEHICLE_TYPES[t] };
    }
    // contact shadows
    const sg = new THREE.PlaneGeometry(1, 1).rotateX(-PI / 2);
    this.shadowMat = new THREE.MeshBasicMaterial({
      map: contactTexture(), transparent: true, depthWrite: false, color: 0x000000, opacity: 0.85,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.shadow = new THREE.InstancedMesh(sg, this.shadowMat, total);
    this.shadow.count = 0;
    this.shadow.frustumCulled = false;
    this.shadow.renderOrder = 1;
    this.shadow.name = 'vehicles.contactShadow';
    root.add(this.shadow);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
  }

  begin() {
    for (const t in this.types) for (const l of this.types[t].lods) l.mesh.count = 0;
    this.shadow.count = 0;
  }

  // yaw: heading angle (0 = +x, positive towards -z, i.e. rotation about +y)
  push(type, x, z, yaw, color, metal, odo, brake, lights, dist, y = ROAD_Y) {
    const T = this.types[type];
    if (!T) return;
    const l = T.lods[dist < LOD_DIST[0] ? 0 : dist < LOD_DIST[1] ? 1 : 2];
    const i = l.mesh.count++;
    this._q.setFromAxisAngle(this._up, yaw);
    this._m.compose(this._p.set(x, y, z), this._q, this._s.set(1, 1, 1));
    l.mesh.setMatrixAt(i, this._m);
    l.mesh.instanceColor.setXYZ(i, color.r, color.g, color.b);
    l.data.setXYZW(i, odo, brake, metal, lights);
    if (dist < 400) {
      const j = this.shadow.count++;
      this._m.compose(this._p.set(x, y + 0.01, z), this._q, this._s.set(T.spec.L + 0.5, 1, T.spec.W + 0.45));
      this.shadow.setMatrixAt(j, this._m);
    }
  }

  end() {
    for (const t in this.types) {
      for (const l of this.types[t].lods) {
        l.mesh.visible = l.mesh.count > 0; // no empty instanced draws
        if (l.mesh.count) l.mesh.computeBoundingSphere();
        l.mesh.instanceMatrix.needsUpdate = true;
        l.mesh.instanceColor.needsUpdate = true;
        l.data.needsUpdate = true;
      }
    }
    this.shadow.instanceMatrix.needsUpdate = true;
    this.shadow.visible = this.shadow.count > 0;
  }

  setNight(n) {
    this.material.userData.uniforms.uNight.value = n;
    this.shadowMat.opacity = 0.75 + 0.2 * n;
  }
}

// Rounded-rectangle soft shadow (ambient occlusion under the body).
let _contact = null;
function contactTexture() {
  if (_contact) return _contact;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(128, 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 128; x++) {
      const u = Math.abs((x + 0.5) / 128 * 2 - 1), v = Math.abs((y + 0.5) / 64 * 2 - 1);
      const du = Math.max(0, (u - 0.72) / 0.28), dv = Math.max(0, (v - 0.55) / 0.45);
      const d = Math.min(1, Math.hypot(du, dv));
      const a = Math.pow(1 - d, 1.8) * 0.9;
      const k = (y * 128 + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 0;
      img.data[k + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  _contact = new THREE.CanvasTexture(c);
  return _contact;
}

// Paint palette (linear colour, metalness, weight) following typical fleet
// colour statistics: white/black/grey/silver dominate, a few saturated colours.
export const PAINTS = [
  [0xe9ebec, 0.0, 16], [0xd7d9d6, 0.35, 8], [0x0b0c0e, 0.55, 14], [0x2b2e33, 0.7, 10], [0x585d63, 0.75, 9],
  [0x9ea3a8, 0.85, 12], [0x1a2740, 0.65, 6], [0x2f4f7f, 0.55, 3], [0x7e1111, 0.35, 4], [0xb01d1d, 0.1, 3],
  [0x4a1418, 0.6, 2], [0x6a6048, 0.6, 2], [0x24382a, 0.6, 2], [0xc0561a, 0.2, 1], [0x3b3b3d, 0.5, 4],
].map(([hex, metal, w]) => ({ color: new THREE.Color(hex), metal, w }));
export const BUS_PAINTS = [0xb3261e, 0x1d5fa8, 0xe8e8e2, 0x2f7d3a].map((h) => new THREE.Color(h));

export { radialTexture };
