import * as THREE from 'three';
import { GeoBuilder, M, patchShader, worldCylinder } from './common.js';

// Street-furniture geometry. Every prop is one merged geometry carrying
// per-vertex colour + [roughness, metalness, emissive type] so each prop type
// is a single instanced draw call sharing ONE material.
// emissive type: 1 LED street lamp · 2 back-lit advert / shelter light

export const EXTRA = { color: 3, pbr: 3 };
const C = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
export const P = {
  anthracite: { color: C(0x3a3f44), pbr: [0.48, 0.35, 0] }, // RAL 7016 powder coat
  galv: { color: C(0x9ea3a6), pbr: [0.42, 1, 0] }, // hot-dip galvanised
  galvDark: { color: C(0x6f7477), pbr: [0.5, 1, 0] },
  black: { color: C(0x111213), pbr: [0.55, 0.1, 0] },
  blackGloss: { color: C(0x0c0c0d), pbr: [0.25, 0.1, 0] },
  white: { color: C(0xd9dbdb), pbr: [0.45, 0, 0] },
  lampLens: { color: C(0xe8e6e0), pbr: [0.2, 0, 1] },
  binGreen: { color: C(0x23392c), pbr: [0.45, 0.3, 0] },
  binLid: { color: C(0x2a2c2e), pbr: [0.4, 0.6, 0] },
  wood: { color: C(0x7a5236), pbr: [0.72, 0, 0] },
  hydrantRed: { color: C(0xa4161a), pbr: [0.4, 0.15, 0] },
  hydrantCap: { color: C(0xc9c9c2), pbr: [0.45, 0.3, 0] },
  yellow: { color: C(0xe0b21c), pbr: [0.4, 0.1, 0] },
  reflect: { color: C(0xf0f0ea), pbr: [0.25, 0, 0] },
  advert: { color: C(0xf2efe6), pbr: [0.3, 0, 2] },
  soil: { color: C(0x33271d), pbr: [0.95, 0, 0] }, // bark mulch
  grate: { color: C(0x2b2d2f), pbr: [0.55, 0.8, 0] },
  concrete: { color: C(0x9a968c), pbr: [0.85, 0, 0] },
  meter: { color: C(0x6d7479), pbr: [0.42, 0.25, 0] },
  meterBlue: { color: C(0x1d4f9a), pbr: [0.4, 0, 0] },
  meterPanel: { color: C(0xc4c8ca), pbr: [0.35, 0, 0] },
  concreteDark: { color: C(0x55534e), pbr: [0.9, 0, 0] },
  screen: { color: C(0x0a1418), pbr: [0.1, 0, 2] },
};

export function propMaterial() {
  const uniforms = { uNight: { value: 0 } };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
  patchShader(mat, 'props', {
    uniforms,
    vertexPars: 'attribute vec3 pbr; varying vec3 vPbr;',
    vertex: { color_vertex: '$\nvPbr = pbr;' },
    fragmentPars: 'uniform float uNight; varying vec3 vPbr;',
    fragment: {
      roughnessmap_fragment: 'float roughnessFactor = vPbr.x;',
      metalnessmap_fragment: 'float metalnessFactor = vPbr.y;',
      emissivemap_fragment: `$
        if ( vPbr.z > 0.5 && vPbr.z < 1.5 ) totalEmissiveRadiance += vec3( 1.0, 0.9, 0.76 ) * ( uNight * 60.0 );
        else if ( vPbr.z > 1.5 ) totalEmissiveRadiance += vColor.rgb * ( 0.25 + uNight * 2.2 );`,
    },
  });
  mat.userData.uniforms = uniforms;
  return mat;
}

const cyl = (r0, r1, h, seg = 12) => new THREE.CylinderGeometry(r1, r0, h, seg);
const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);

// ------------------------------------------------------------------ street light
// Local frame: base at origin, arm reaching towards +z (the carriageway).
export const LAMP = { height: 8.3, reach: 1.95 };
export function streetLightGeo(lod = 0) {
  const b = new GeoBuilder(EXTRA);
  const seg = lod ? 6 : 12;
  b.add(cyl(0.15, 0.15, 0.05, seg), M(0, 0.025, 0), P.anthracite);
  b.add(cyl(0.105, 0.095, 1.2, seg), M(0, 0.62, 0), P.anthracite); // base section with access door
  if (!lod) b.add(box(0.1, 0.32, 0.02), M(0, 0.7, 0.1), P.anthracite);
  b.add(cyl(0.088, 0.052, 6.6, seg), M(0, 1.2 + 3.3, 0), P.anthracite);
  // upswept arm
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 7.7, 0), new THREE.Vector3(0, 8.3, 0.25), new THREE.Vector3(0, 8.32, LAMP.reach - 0.3));
  b.add(new THREE.TubeGeometry(curve, lod ? 4 : 10, 0.038, lod ? 4 : 7, false), null, P.anthracite);
  // slim LED luminaire, tilted 5° up
  const head = M(0, 8.3, LAMP.reach, -0.09, 0, 0);
  b.add(box(0.3, 0.07, 0.74).applyMatrix4(head), null, P.anthracite);
  b.add(box(0.32, 0.035, 0.7).translate(0, 0.045, 0).applyMatrix4(head), null, P.anthracite);
  b.add(box(0.22, 0.012, 0.5).translate(0, -0.038, 0.04).applyMatrix4(head), null, P.lampLens);
  return b.build();
}

// ------------------------------------------------------------------ signals
// Local frame: vehicle heads face +z (towards approaching traffic, which
// travels -z); the carriageway lies towards -x. Lens positions are exported so
// the lens instances can be placed with the same matrix.
function signalHead(b, x, y, z, ry = 0) {
  const m = M(x, y, z, 0, ry, 0);
  b.add(box(0.62, 1.28, 0.02).translate(0, 0, -0.13), m, P.white); // retro-reflective border
  b.add(box(0.56, 1.22, 0.025).translate(0, 0, -0.12), m, P.black); // backplate
  b.add(box(0.32, 0.96, 0.24), m, P.blackGloss);
  for (const dy of [0.3, 0, -0.3]) {
    b.add(box(0.28, 0.018, 0.2).translate(0, dy + 0.12, 0.2), m, P.black); // visor hood
    b.add(box(0.018, 0.1, 0.2).translate(0.13, dy + 0.07, 0.2), m, P.black);
    b.add(box(0.018, 0.1, 0.2).translate(-0.13, dy + 0.07, 0.2), m, P.black);
  }
}
function pedHead(b, x, y, z, ry) {
  const m = M(x, y, z, 0, ry, 0);
  b.add(box(0.3, 0.58, 0.2), m, P.blackGloss);
  for (const dy of [0.14, -0.14]) b.add(box(0.28, 0.018, 0.14).translate(0, dy + 0.12, 0.14), m, P.black);
}
export const SIG = {
  // vehicle lens centres (red, amber, green) for a head at (x, y, z) facing +z
  lenses: (x, y, z) => [[x, y + 0.3, z + 0.125], [x, y, z + 0.125], [x, y - 0.3, z + 0.125]],
  postHead: [0, 2.9, 0.16],
  mastHead: [-3.7, 5.55, 0.16],
  ped: [-0.2, 2.15, 0], // ped head faces -x (across the approach road)
};
export function signalPostGeo(mast) {
  const b = new GeoBuilder(EXTRA);
  const h = mast ? 6.4 : 3.7;
  b.add(cyl(0.16, 0.16, 0.06, 12), M(0, 0.03, 0), P.galvDark);
  b.add(cyl(mast ? 0.12 : 0.07, mast ? 0.095 : 0.065, h, 12), M(0, h / 2, 0), P.galv);
  b.add(cyl(0.1, 0.06, 0.08, 10), M(0, h + 0.04, 0), P.galv);
  signalHead(b, ...SIG.postHead);
  if (mast) {
    const arm = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 5.9, 0), new THREE.Vector3(-1.6, 6.25, 0), new THREE.Vector3(-4.3, 6.35, 0));
    b.add(new THREE.TubeGeometry(arm, 10, 0.075, 8, false), null, P.galv);
    const tie = new THREE.LineCurve3(new THREE.Vector3(0, 6.3, 0), new THREE.Vector3(-2.6, 6.33, 0));
    b.add(new THREE.TubeGeometry(tie, 2, 0.02, 5, false), null, P.galv);
    b.add(box(0.05, 0.4, 0.05), M(SIG.mastHead[0], 6.15, 0), P.galv);
    signalHead(b, ...SIG.mastHead);
  }
  pedHead(b, SIG.ped[0], SIG.ped[1], SIG.ped[2], -Math.PI / 2);
  b.add(box(0.11, 0.17, 0.09), M(-0.1, 1.1, 0), P.yellow); // push button unit
  b.add(box(0.07, 0.06, 0.02), M(-0.155, 1.13, 0), P.black);
  return b.build();
}

// ------------------------------------------------------------------ small props
export function binGeo() {
  const b = new GeoBuilder(EXTRA);
  b.add(cyl(0.2, 0.23, 0.78, 14), M(0, 0.41, 0), P.binGreen);
  b.add(cyl(0.24, 0.24, 0.05, 14), M(0, 0.02, 0), P.binLid);
  b.add(cyl(0.245, 0.235, 0.09, 14), M(0, 0.845, 0), P.binLid);
  b.add(new THREE.SphereGeometry(0.23, 14, 4, 0, Math.PI * 2, 0, Math.PI / 2.4), M(0, 0.88, 0, 0, 0, 0, 1, 0.45, 1), P.binLid);
  b.add(box(0.2, 0.08, 0.04), M(0, 0.8, 0.22), P.black); // slot
  return b.build();
}

export function bollardGeo() {
  const b = new GeoBuilder(EXTRA);
  b.add(new THREE.CylinderGeometry(0.07, 0.075, 0.9, 8, 1, true), M(0, 0.45, 0), P.anthracite);
  b.add(new THREE.CylinderGeometry(0.073, 0.073, 0.05, 8, 1, true), M(0, 0.78, 0), P.reflect);
  b.add(new THREE.SphereGeometry(0.07, 8, 2, 0, Math.PI * 2, 0, Math.PI / 2), M(0, 0.9, 0), P.anthracite);
  return b.build();
}

export function hydrantGeo() {
  const b = new GeoBuilder(EXTRA);
  b.add(cyl(0.15, 0.15, 0.06, 12), M(0, 0.03, 0), P.hydrantRed);
  b.add(cyl(0.1, 0.095, 0.55, 12), M(0, 0.33, 0), P.hydrantRed);
  b.add(cyl(0.115, 0.115, 0.05, 12), M(0, 0.6, 0), P.hydrantRed);
  b.add(new THREE.SphereGeometry(0.11, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2), M(0, 0.62, 0), P.hydrantCap);
  b.add(cyl(0.03, 0.03, 0.06, 6), M(0, 0.74, 0), P.hydrantCap);
  for (const s of [1, -1]) {
    b.add(cyl(0.045, 0.045, 0.12, 10), M(s * 0.14, 0.42, 0, 0, 0, Math.PI / 2), P.hydrantRed);
    b.add(cyl(0.05, 0.05, 0.03, 10), M(s * 0.2, 0.42, 0, 0, 0, Math.PI / 2), P.hydrantCap);
  }
  b.add(cyl(0.055, 0.055, 0.1, 10), M(0, 0.42, 0.13, Math.PI / 2, 0, 0), P.hydrantRed);
  return b.build();
}

// bench facing +z, length along x
export function benchGeo() {
  const b = new GeoBuilder(EXTRA);
  for (const x of [-0.75, 0.75]) {
    b.add(box(0.06, 0.44, 0.5), M(x, 0.22, 0), P.anthracite);
    b.add(box(0.06, 0.5, 0.06), M(x, 0.66, -0.22, -0.2, 0, 0), P.anthracite);
    b.add(box(0.06, 0.04, 0.46), M(x, 0.66, 0.02), P.anthracite); // armrest
  }
  for (let i = 0; i < 4; i++) b.add(box(1.8, 0.035, 0.09), M(0, 0.45, -0.17 + i * 0.115), P.wood);
  for (let i = 0; i < 3; i++) b.add(box(1.8, 0.09, 0.03), M(0, 0.56 + i * 0.12, -0.235 - i * 0.025, -0.2, 0, 0), P.wood);
  return b.build();
}

// bus shelter: length along x, open side facing +z; glass returned separately
export function shelterGeo() {
  const b = new GeoBuilder(EXTRA);
  const g = new GeoBuilder(EXTRA);
  const L = 4.2, D = 1.45, H = 2.45;
  for (const x of [-L / 2, 0, L / 2]) {
    b.add(box(0.07, H, 0.07), M(x, H / 2, -D / 2), P.anthracite);
    if (x !== 0) b.add(box(0.07, H, 0.07), M(x, H / 2, D / 2 - 0.1), P.anthracite);
  }
  b.add(box(L + 0.35, 0.09, D + 0.35), M(0, H + 0.05, 0.05, 0.04, 0, 0), P.anthracite); // roof
  b.add(box(L + 0.37, 0.16, 0.04), M(0, H + 0.02, D / 2 + 0.23), P.anthracite); // fascia
  b.add(box(L, 0.05, 0.05), M(0, 0.12, -D / 2), P.anthracite);
  b.add(box(L, 0.05, 0.05), M(0, H - 0.05, -D / 2), P.anthracite);
  // advert panel (lit) at the -x end
  b.add(box(0.14, 1.85, 1.25), M(-L / 2 - 0.05, 1.2, -0.05), P.anthracite);
  b.add(box(0.15, 1.7, 1.1), M(-L / 2 - 0.05, 1.22, -0.05), P.advert);
  // bench + info screen
  b.add(box(1.9, 0.05, 0.36), M(0.6, 0.47, -D / 2 + 0.25), P.galv);
  for (const x of [-0.2, 1.4]) b.add(box(0.05, 0.45, 0.3), M(x, 0.23, -D / 2 + 0.25), P.anthracite);
  b.add(box(0.5, 0.3, 0.05), M(1.3, 2.1, -D / 2 + 0.06), P.screen);
  b.add(box(0.55, 0.35, 0.04), M(1.3, 2.1, -D / 2 + 0.035), P.black);
  // glass: back wall + one end panel
  g.add(box(L, H - 0.25, 0.012), M(0, H / 2 + 0.02, -D / 2 + 0.01), P.white);
  g.add(box(0.012, H - 0.25, D - 0.15), M(L / 2, H / 2 + 0.02, -0.02), P.white);
  return { frame: b.build(), glass: g.build() };
}

// bus stop pole with flag (sign plate added to the sign atlas mesh)
export function stopPoleGeo() {
  const b = new GeoBuilder(EXTRA);
  b.add(cyl(0.045, 0.045, 3.0, 10), M(0, 1.5, 0), P.galv);
  b.add(box(0.36, 0.6, 0.05), M(0, 1.45, 0), P.white); // timetable case
  return b.build();
}

export function signPostGeo(h = 2.6) {
  const b = new GeoBuilder(EXTRA);
  b.add(cyl(0.032, 0.032, h, 8), M(0, h / 2, 0), P.galv);
  b.add(cyl(0.036, 0.036, 0.03, 8), M(0, h, 0), P.galvDark);
  return b.build();
}

export function treePitGeo() {
  // cast-iron grate: frame + radial slots suggested by a few bars (top faces only matter)
  const b = new GeoBuilder(EXTRA);
  const q = (w, d) => new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
  b.add(q(1.3, 1.3), M(0, 0.006, 0), P.soil);
  for (const [x, z, w, d] of [[0, 0.62, 1.3, 0.06], [0, -0.62, 1.3, 0.06], [0.62, 0, 0.06, 1.3], [-0.62, 0, 0.06, 1.3]]) b.add(q(w, d), M(x, 0.012, z), P.grate);
  for (let i = 0; i < 6; i++) b.add(q(1.1, 0.035), M(0, 0.011, 0, 0, (i / 6) * Math.PI, 0), P.grate);
  return b.build();
}

export function payStationGeo() {
  // pay-and-display machine: powder-coated cabinet (not bare metal — that
  // reads black against the sky reflection), rain hood, lit display, keypad,
  // ticket bay and a light instruction panel
  const b = new GeoBuilder(EXTRA);
  b.add(box(0.3, 0.08, 0.22), M(0, 0.04, 0), P.anthracite); // foot
  b.add(box(0.36, 1.26, 0.26), M(0, 0.71, 0), P.meter);
  b.add(box(0.4, 0.05, 0.34), M(0, 1.37, 0.01, 0.22, 0, 0), P.anthracite); // hood, tilted towards the user
  b.add(box(0.3, 0.07, 0.006), M(0, 1.29, 0.132), P.meterBlue); // header strip
  b.add(box(0.28, 0.5, 0.008), M(0, 0.98, 0.133), P.meterPanel);
  b.add(box(0.15, 0.08, 0.01), M(0, 1.15, 0.137), P.screen);
  b.add(box(0.12, 0.1, 0.02), M(-0.05, 1.0, 0.14), P.blackGloss); // keypad
  b.add(box(0.035, 0.035, 0.016), M(0.08, 1.0, 0.142), P.yellow); // pay button
  b.add(box(0.05, 0.012, 0.012), M(0.08, 1.07, 0.142), P.galv); // coin / card slot
  b.add(box(0.2, 0.08, 0.03), M(0, 0.62, 0.13), P.blackGloss); // ticket bay
  return b.build();
}

export function planterGeo() {
  // precast planter: slightly battered walls, coping lip and a plinth shadow gap
  const b = new GeoBuilder(EXTRA);
  b.add(box(1.8, 0.06, 0.8), M(0, 0.03, 0), P.concreteDark); // recessed plinth
  const shell = new THREE.CylinderGeometry(0.66, 0.62, 0.52, 4, 1).rotateY(Math.PI / 4).scale(1.93, 1, 0.9);
  shell.deleteAttribute('normal'); // flat-shaded faces (GeoBuilder recomputes on the non-indexed copy)
  b.add(shell, M(0, 0.32, 0), P.concrete);
  b.add(box(1.9, 0.07, 0.9), M(0, 0.615, 0), P.concrete); // coping
  b.add(box(1.72, 0.02, 0.72), M(0, 0.64, 0), P.soil);
  return b.build();
}

export { worldCylinder };
