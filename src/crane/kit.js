import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { textureSet } from '../world/assets.js';
import { noiseField } from '../world/textures.js';
import { rng } from '../util/math.js';

// Shared building kit for the crane and load models:
//  - primitives whose UVs are in METRES, so tiled CC0 PBR sets (tile_m ≈ 1)
//    keep their real-world scale on every member regardless of its length;
//  - Kit: accumulates geometry per material key and merges each bin into one
//    mesh (one draw call per material per moving part);
//  - member(): steel sections (angle, SHS/RHS, tube, I, channel, flat) laid
//    between two points, carrying a per-vertex 'wear' attribute so the paint
//    shader can put grime / rust bleed at the joints where water collects;
//  - weathered(): the paint shader patch; ropeMaterial(): wire-rope strands;
//  - Atlas: canvas decal atlas (stencils, plates, signs).

export const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const XAX = new THREE.Vector3(1, 0, 0);

// ------------------------------------------------------------ primitives
export function mBox(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // BoxGeometry face order: px nx py ny pz nz (4 verts each)
  const sc = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * sc[f][0], uv.getY(i) * sc[f][1]);
    }
  }
  return g;
}

export function mCyl(rt, rb, h, seg = 12, open = false, hseg = 1) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, hseg, open);
  const uv = g.attributes.uv;
  const r = Math.max(rt, rb, 1e-3);
  const nSide = (seg + 1) * (hseg + 1);
  for (let i = 0; i < uv.count; i++) {
    if (i < nSide) uv.setXY(i, uv.getX(i) * TAU * r, uv.getY(i) * h);
    else uv.setXY(i, uv.getX(i) * 2 * r, uv.getY(i) * 2 * r);
  }
  return g;
}

export function mTorus(R, r, radSeg = 6, tubSeg = 16, arc = TAU) {
  const g = new THREE.TorusGeometry(R, r, radSeg, tubSeg, arc);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * R * arc, uv.getY(i) * TAU * r);
  return g;
}

export function mPlane(w, h) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
  return g;
}

// Extruded 2D shape (x,y in metres) along +z by depth; ExtrudeGeometry's cap
// UVs are already the shape coordinates = metres.
export function mExtrude(shape, depth, opts = {}) {
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 8, ...opts });
}

// Hex bolt head (+ washer) with its axis along +y, base at y=0. The faces
// against the plate are never seen, so there are no bottom caps; washer=false
// (18 tris) is for the hundreds of bolts repeated on every mast section.
function cappedTube(r, h, seg) {
  const side = new THREE.CylinderGeometry(r, r, h, seg, 1, true);
  const cap = new THREE.CircleGeometry(r, seg).rotateX(-Math.PI / 2).rotateY(Math.PI / seg * (seg === 6 ? 1 : 0)).translate(0, h / 2, 0);
  return merge([side, cap]);
}
export function boltGeo(d = 0.024, len = 0.018, washer = true) {
  const head = cappedTube(d * 0.95, len, 6).translate(0, len / 2 + 0.003, 0);
  if (!washer) return head;
  return merge([head, cappedTube(d * 1.1, 0.004, 8).translate(0, 0.002, 0)]);
}

// Tube swept along a curve with a varying radius (hook body, cables).
// points: Vector3[]; radius(t) → r; flat: cross-section z/normal ratio.
// planar=true keeps the section frame in the curve's plane (x-y), which is
// what a forged hook is.
export function sweepGeo(points, radius, { steps = 40, seg = 10, flat = 1, planar = false, capEnd = true } = {}) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const frames = planar ? null : curve.computeFrenetFrames(steps, false);
  const pos = [], nor = [], uvs = [], idx = [];
  const P = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    curve.getPointAt(t, P);
    curve.getTangentAt(t, T);
    if (planar) {
      N.set(-T.y, T.x, 0).normalize();
      B.set(0, 0, 1);
    } else {
      N.copy(frames.normals[i]);
      B.copy(frames.binormals[i]);
    }
    const r = radius(t);
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      pos.push(P.x + (N.x * c + B.x * s * flat) * r, P.y + (N.y * c + B.y * s * flat) * r, P.z + (N.z * c + B.z * s * flat) * r);
      const nx = N.x * c * flat + B.x * s, ny = N.y * c * flat + B.y * s, nz = N.z * c * flat + B.z * s;
      const l = Math.hypot(nx, ny, nz) || 1;
      nor.push(nx / l, ny / l, nz / l);
      uvs.push((j / seg) * TAU * r, t * curve.getLength());
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + seg + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  if (!capEnd) return g;
  const end = new THREE.SphereGeometry(radius(1), seg, 6);
  end.scale(1, 1, flat);
  curve.getPointAt(1, P);
  end.translate(P.x, P.y, P.z);
  return merge([g, end]);
}

// ------------------------------------------------------------ merging
const KEEP = new Set(['position', 'normal', 'uv', 'wear']);
export function prep(geo, wear = null) {
  const g = geo;
  const n = g.attributes.position.count;
  if (g.index === null) {
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  for (const k of Object.keys(g.attributes)) if (!KEEP.has(k)) g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.attributes.wear) {
    const a = new Float32Array(n * 3);
    if (wear) for (let i = 0; i < n; i++) a.set(wear, i * 3);
    g.setAttribute('wear', new THREE.BufferAttribute(a, 3));
  }
  g.clearGroups();
  return g;
}

export function merge(list) {
  const out = mergeGeometries(list.map((g) => prep(g)), false);
  for (const g of list) g.dispose();
  return out;
}

// wear = [e0, e1, amount]: e = distance to a joint in units of the grime
// falloff (linear along a member, so exact with just the end vertices);
// amount scales the joint grime. [0,0,0] = clean paint.
export const WEAR_NONE = [0, 0, 0];
export const WEAR_JOINT = [0.2, 0.2, 0.9];
export const WEAR_LIGHT = [0.6, 9, 0.5];

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _mm = new THREE.Matrix4();

// Section parts along local +y (0..L). Local x = the 'ref' direction.
//  box  {w (x), d (z)}           SHS/RHS/flat bar, centred
//  tube {r, seg}                 CHS, centred, open ends (hidden in joints)
//  L    {w, th}                  equal angle, heel on the line, legs +x/+z
//  I    {h (x), b (z), tw, tf}   I/H section, centred
//  C    {h (x), b (z), tw, tf}   channel, web on the line, flanges toward +z
function profileParts(p, L) {
  switch (p.k) {
    case 'tube': return [mCyl(p.r, p.r, L, p.seg || 8, !p.caps).translate(0, L / 2, 0)];
    case 'L': return [
      mBox(p.w, L, p.th).translate(p.w / 2, L / 2, p.th / 2),
      mBox(p.th, L, p.w - p.th).translate(p.th / 2, L / 2, p.th + (p.w - p.th) / 2),
    ];
    case 'I': return [
      mBox(p.h - 2 * p.tf, L, p.tw).translate(0, L / 2, 0),
      mBox(p.tf, L, p.b).translate(p.h / 2 - p.tf / 2, L / 2, 0),
      mBox(p.tf, L, p.b).translate(-p.h / 2 + p.tf / 2, L / 2, 0),
    ];
    case 'C': return [
      mBox(p.h, L, p.tw).translate(0, L / 2, p.tw / 2),
      mBox(p.tf, L, p.b - p.tw).translate(p.h / 2 - p.tf / 2, L / 2, p.tw + (p.b - p.tw) / 2),
      mBox(p.tf, L, p.b - p.tw).translate(-p.h / 2 + p.tf / 2, L / 2, p.tw + (p.b - p.tw) / 2),
    ];
    default: return [mBox(p.w, L, p.d ?? p.w).translate(p.ox || 0, L / 2, p.oz || 0)];
  }
}

export class Kit {
  constructor(seed = 1) {
    this.bins = new Map();
    this.rand = rng(seed);
  }

  // geo: local geometry (metric UVs); m: Matrix4 placing it; wear: [e0,e1,amt]
  add(key, geo, m = null, wear = null, jitter = true) {
    const g = prep(geo, wear);
    if (jitter) {
      // decorrelate texture phase between identical parts
      const du = Math.floor(this.rand() * 8) + this.rand(), dv = Math.floor(this.rand() * 8) + this.rand();
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + du, uv.getY(i) + dv);
    }
    if (m) g.applyMatrix4(m);
    if (!this.bins.has(key)) this.bins.set(key, []);
    this.bins.get(key).push(g);
    return g;
  }

  // axis-aligned (optionally rotated) box
  box(key, w, h, d, x = 0, y = 0, z = 0, rot = null, wear = null) {
    const m = new THREE.Matrix4();
    if (rot) m.makeRotationFromEuler(rot instanceof THREE.Euler ? rot : new THREE.Euler(...rot));
    m.setPosition(x, y, z);
    return this.add(key, mBox(w, h, d), m, wear);
  }

  cyl(key, r, h, x, y, z, axis = 'y', seg = 12, wear = null, open = false) {
    const g = mCyl(r, r, h, seg, open);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    return this.add(key, g, null, wear);
  }

  // Structural member a→b. ref: direction for the section's local x.
  // grime: joint dirt amount (0 = clean).
  member(key, a, b, prof, ref = null, grime = 1) {
    _y.subVectors(b, a);
    const L = _y.length();
    if (L < 1e-4) return;
    _y.divideScalar(L);
    const r = ref || (Math.abs(_y.y) < 0.95 ? UP : XAX);
    _x.copy(r).addScaledVector(_y, -r.dot(_y));
    if (_x.lengthSq() < 1e-6) {
      const alt = Math.abs(_y.x) < 0.9 ? XAX : UP;
      _x.copy(alt).addScaledVector(_y, -alt.dot(_y));
    }
    _x.normalize();
    _z.crossVectors(_x, _y);
    _mm.makeBasis(_x, _y, _z).setPosition(a);
    // rust bleeds DOWN from the upper joint of a steep member
    const steep = Math.abs(_y.y);
    const long = 0.2 + 0.75 * steep, short = 0.14;
    const f0 = _y.y < 0 ? long : (steep > 0.5 ? short : 0.22);
    const f1 = _y.y > 0 ? long : (steep > 0.5 ? short : 0.22);
    for (const part of profileParts(prof, L)) {
      const g = prep(part);
      const pos = g.attributes.position, wr = g.attributes.wear;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        wr.setXYZ(i, Math.max(0, y) / f0, Math.max(0, L - y) / f1, grime);
      }
      this.add(key, g, _mm);
    }
  }

  // Merge every bin into one mesh per material and add them to parent.
  // instances: optional Matrix4[] → InstancedMesh (e.g. identical mast sections)
  build(parent, mats, { instances = null, colors = null, castShadow = true, receiveShadow = true, noShadow = [] } = {}) {
    const out = {};
    for (const [key, list] of this.bins) {
      const mat = mats[key];
      if (!mat) { console.warn('[crane] no material', key); continue; }
      const geo = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      let mesh;
      if (instances) {
        mesh = new THREE.InstancedMesh(geo, mat, instances.length);
        instances.forEach((m, i) => mesh.setMatrixAt(i, m));
        if (colors) colors.forEach((c, i) => mesh.setColorAt(i, c));
        mesh.computeBoundingSphere();
      } else {
        mesh = new THREE.Mesh(geo, mat);
      }
      mesh.name = key;
      const transparent = mat.transparent && !mat.alphaMap;
      mesh.castShadow = castShadow && !transparent && !noShadow.includes(key);
      mesh.receiveShadow = receiveShadow;
      parent.add(mesh);
      out[key] = mesh;
    }
    this.bins.clear();
    return out;
  }
}

// ------------------------------------------------------------ textures
function dataTex(data, S, srgb = false) {
  const t = new THREE.DataTexture(data, S, S);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

let _noise = null;
// R: fbm (streak source), G: large blotches, B: fine speckle. Contrast-stretched.
export function wearNoise() {
  if (_noise) return _noise;
  const S = 256;
  const a = noiseField(S, 8, 5, 11), b = noiseField(S, 3, 4, 23), c = noiseField(S, 32, 3, 37);
  const k = (v) => Math.max(0, Math.min(255, ((v - 0.5) * 2.4 + 0.5) * 255));
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = k(a[i]);
    data[i * 4 + 1] = k(b[i]);
    data[i * 4 + 2] = k(c[i]);
    data[i * 4 + 3] = 255;
  }
  _noise = dataTex(data, S);
  return _noise;
}

// Paint weathering patch for MeshStandardMaterial:
//  - rust bleed + grime at joints (per-vertex 'wear' attribute, see member());
//    rust comes from the rusty_metal scan, broken up by streaky noise that is
//    stretched along the member (UV v) so it reads as run-down streaks;
//  - large-scale dirt blotches + fine speckle everywhere (no two metres alike);
//  - rusty areas turn rough;
//  - dust/grime film on upward-facing surfaces (world normal), which is what
//    makes a real steel lattice read dirty-on-top, clean-underneath.
// opts: rust (joint rust), dirt (blotches), dust (top film), rustScale (UV scale of the scan)
export function weathered(mat, { rust = 1, dirt = 1, dust = 1, rustScale = 0.45, contrast = 1, mean = 0.6, tag = '' } = {}) {
  const rustTex = textureSet('rusty_metal')?.map || null;
  const noise = wearNoise();
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    sh.uniforms.tWearNoise = { value: noise };
    sh.uniforms.tWearRust = { value: rustTex || noise };
    sh.uniforms.uWear = { value: new THREE.Vector3(rust, dirt, rustScale) };
    sh.uniforms.uPaint = { value: new THREE.Vector3(contrast, mean, dust) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 wear;\nvarying vec3 vWear;\nvarying vec2 vWearUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvWear = wear;\nvWearUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tWearNoise;\nuniform sampler2D tWearRust;\nuniform vec3 uWear;\nuniform vec3 uPaint;\nvarying vec3 vWear;\nvarying vec2 vWearUv;')
      // the paint scan's streaks read as wood grain on narrow members: tame its contrast
      .replace('#include <map_fragment>', `#include <map_fragment>
	#ifdef USE_MAP
		diffuseColor.rgb = mix( diffuse * uPaint.y, diffuseColor.rgb, uPaint.x );
	#endif`)
      .replace('#include <color_fragment>', `#include <color_fragment>
	vec4 wStreak = texture2D( tWearNoise, vWearUv * vec2( 1.3, 0.16 ) );
	vec4 wBlot = texture2D( tWearNoise, vWearUv * 0.09 + vec2( 0.31, 0.57 ) );
	vec4 wFine = texture2D( tWearNoise, vWearUv * 0.7 );
	float wJoint = max( 1.0 - smoothstep( 0.0, 1.0, vWear.x ), 1.0 - smoothstep( 0.0, 1.0, vWear.y ) ) * vWear.z;
	float wearM = clamp( wJoint * ( 0.1 + 1.25 * wStreak.r ) * 1.25 - 0.32, 0.0, 1.0 ) * uWear.x;
	vec3 wRust = texture2D( tWearRust, vWearUv * uWear.z ).rgb * 1.35;
	diffuseColor.rgb *= 1.0 - wJoint * 0.22 * uWear.y; // grime film around joints
	diffuseColor.rgb = mix( diffuseColor.rgb, wRust, wearM );
	diffuseColor.rgb *= 1.0 - uWear.y * ( 0.2 * smoothstep( 0.3, 0.85, wBlot.g ) + 0.1 * wFine.b );
	float wUp = smoothstep( 0.3, 0.95, inverseTransformDirection( normalize( vNormal ), viewMatrix ).y ) * uPaint.z * ( 0.45 + 0.55 * wBlot.g );
	diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.6 + vec3( 0.045, 0.04, 0.032 ), wUp );`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor, 0.93, wearM );\n\troughnessFactor = min( 1.0, roughnessFactor + 0.08 * uWear.y * wBlot.g + 0.35 * wUp );');
  };
  mat.customProgramCacheKey = () => 'crane-weathered' + tag;
  return mat;
}

// Window glass seen from outside: the see-through part is attenuated by the
// opacity but the Fresnel reflection is not (alpha blending would otherwise
// scale the sky reflection down with the tint, leaving a flat dark box).
export function glassMaterial(params = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: 0x10161a, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.32, depthWrite: false, envMapIntensity: 1.6, ...params,
  });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
	vec3 glassSpec = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
	float glassA = max( diffuseColor.a, 0.05 );
	gl_FragColor = vec4( outgoingLight - glassSpec + glassSpec / glassA, glassA );`);
  };
  m.customProgramCacheKey = () => 'crane-glass';
  return m;
}

// ---- wire rope: 6 strands, ordinary lay (~6.5 d lay length)
function ropeHeight(u, v) {
  // u around (0..1, 6 strands), v along one lay length (0..1)
  const s = (((6 * (u + v)) % 1) + 1) % 1;
  const strand = Math.sqrt(Math.max(0, 1 - (2 * s - 1) ** 2));
  const wv = (((24 * u - 12 * v) % 1) + 1) % 1;
  const wire = Math.sqrt(Math.max(0, 1 - (2 * wv - 1) ** 2));
  return strand * (0.82 + 0.18 * wire);
}

function strandTextures(fn, W, H) {
  const col = new Uint8Array(W * H * 4), nrm = new Uint8Array(W * H * 4);
  const e = 1 / W;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, v = (y + 0.5) / H;
      const h = fn(u, v);
      const dx = (fn(u + e, v) - fn(u - e, v)) * 0.9;
      const dy = (fn(u, v + e) - fn(u, v - e)) * 0.9;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * W + x) * 4;
      nrm[i] = (-dx / l * 0.5 + 0.5) * 255;
      nrm[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
      nrm[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
      const c = 70 + 185 * Math.pow(h, 0.7); // grease + grime in the valleys
      col[i] = c; col[i + 1] = c * 0.98; col[i + 2] = c * 0.95; col[i + 3] = 255;
    }
  }
  const mk = (d, srgb) => {
    const t = new THREE.DataTexture(d, W, H);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(col, true), normalMap: mk(nrm, false) };
}

let _rope = null;
export function ropeTextures() {
  return (_rope ||= strandTextures(ropeHeight, 64, 64));
}

// Rope wound on a drum: turns run around U; V = along the drum axis (1 turn per texel row band)
let _wound = null;
export function woundRopeTextures() {
  return (_wound ||= strandTextures((u, v) => {
    const s = (((v * 4) % 1) + 1) % 1; // 4 turns per tile
    const turn = Math.sqrt(Math.max(0, 1 - (2 * s - 1) ** 2));
    const st = (((u * 16 + v * 4 * 0.5) % 1) + 1) % 1;
    return turn * (0.75 + 0.25 * Math.sqrt(Math.max(0, 1 - (2 * st - 1) ** 2)));
  }, 64, 64));
}

export const ROPE_LAY = 0.143; // m: lay length of a 22 mm rope (6.5 d)

// Steel wire rope for main.js' instanced rope cylinders: UV v (0..1 along each
// unit cylinder) is rescaled by the instance's length so the strands keep a
// constant 143 mm lay however long the segment is.
export function ropeMaterial() {
  const { map, normalMap } = ropeTextures();
  const m = new THREE.MeshStandardMaterial({
    color: 0x9a9ea3, map, normalMap, normalScale: new THREE.Vector2(1.2, 1.2),
    roughness: 0.42, metalness: 0.9, envMapIntensity: 1.1,
  });
  m.name = 'wireRope';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
	#ifdef USE_INSTANCING
		float ropeLen = length( instanceMatrix[ 1 ].xyz );
	#else
		float ropeLen = 1.0;
	#endif
	vec2 ropeUv = vec2( uv.x, uv.y * ropeLen * ${(1 / ROPE_LAY).toFixed(4)} );
	#ifdef USE_MAP
		vMapUv = ropeUv;
	#endif
	#ifdef USE_NORMALMAP
		vNormalMapUv = ropeUv;
	#endif`);
  };
  m.customProgramCacheKey = () => 'crane-rope';
  return m;
}

// ------------------------------------------------------------ canvas decals
export class Atlas {
  constructor(W = 1024, H = 1024) {
    this.W = W; this.H = H;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.rects = {};
    this.x = 0; this.y = 0; this.row = 0;
    this.pad = 6;
  }

  // draw(ctx, w, h) paints a w×h region; returns the region's UV rect
  add(name, w, h, draw) {
    const p = this.pad;
    if (this.x + w + p * 2 > this.W) { this.x = 0; this.y += this.row; this.row = 0; }
    const x = this.x + p, y = this.y + p;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    draw(ctx, w, h);
    ctx.restore();
    this.x += w + p * 2;
    this.row = Math.max(this.row, h + p * 2);
    const r = [x / this.W, 1 - (y + h) / this.H, (x + w) / this.W, 1 - y / this.H];
    this.rects[name] = r;
    return r;
  }

  texture() {
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  }

  // plane w×h (normal +z) mapped onto a region
  quad(name, w, h) {
    const [u0, v0, u1, v1] = this.rects[name];
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    return g;
  }
}

export function fitText(ctx, str, x, y, maxW, px, font = 'Arial, Helvetica, sans-serif', weight = 'bold') {
  let size = px;
  ctx.font = `${weight} ${size}px ${font}`;
  const w = ctx.measureText(str).width;
  if (w > maxW) { size = Math.floor(px * maxW / w); ctx.font = `${weight} ${size}px ${font}`; }
  ctx.fillText(str, x, y);
}

// Speckle/grunge overlay on a canvas region (paint stencils are never crisp)
export function grunge(ctx, w, h, seed = 3, amount = 0.25, color = 'rgba(60,50,40,') {
  const r = rng(seed);
  const n = Math.floor(w * h / 120 * amount);
  for (let i = 0; i < n; i++) {
    const a = r() * 0.25;
    ctx.fillStyle = `${color}${a.toFixed(3)})`;
    const s = 0.5 + r() * r() * 5;
    ctx.fillRect(r() * w, r() * h, s, s * (0.6 + r()));
  }
}

// Dirty-glass alpha texture (RGBA): dust film heavier at the edges and bottom,
// run-down streaks and droplet spots; wiped=true clears a wiper arc.
export function glassDirtTexture(seed = 5, wiped = false) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const n = noiseField(S, 6, 5, seed), f = noiseField(S, 24, 3, seed + 7);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = 1 - y / S; // v=0 bottom
      const edge = Math.min(u, 1 - u, v * 0.6, 1 - v);
      let a = 0.035 + 0.3 * Math.pow(1 - Math.min(1, edge / 0.14), 2) + 0.1 * Math.max(0, 0.25 - v) * 4;
      a *= 0.55 + 0.9 * n[y * S + x];
      a += 0.05 * Math.max(0, f[y * S + x] - 0.55) * 4;
      if (wiped) {
        // wiper sweep: clean arc, with a dirt ridge left at its outer limit
        const rr = Math.hypot((u - 0.5) * 1.6, v + 0.02);
        if (rr > 0.12 && rr < 0.93) a *= 0.22;
        else if (rr >= 0.93 && rr < 0.97) a *= 1.6;
      }
      const i = (y * S + x) * 4;
      img.data[i] = 150; img.data[i + 1] = 142; img.data[i + 2] = 128;
      img.data[i + 3] = Math.min(255, a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  // droplet spots + streaks
  const r = rng(seed * 13);
  for (let i = 0; i < 260; i++) {
    const x = r() * S, y = r() * S, s = 0.6 + r() * 1.8;
    ctx.fillStyle = `rgba(160,150,135,${(0.08 + r() * 0.18).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(x, y, s, 0, TAU); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(140,130,115,0.07)';
  for (let i = 0; i < 40; i++) {
    const x = r() * S, y0 = r() * S * 0.6;
    ctx.lineWidth = 0.6 + r() * 1.5;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x + (r() - 0.5) * 4, y0 + 30 + r() * 90); ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Yellow/black hazard stripes (painted, a little worn) — tile = 0.4 m diagonal pitch
let _hazard = null;
export function hazardStripes() {
  if (_hazard) return _hazard;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e9a800';
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#141414';
  for (let i = -S; i < S * 2; i += S / 2) {
    ctx.beginPath();
    ctx.moveTo(i, 0); ctx.lineTo(i + S / 4, 0); ctx.lineTo(i + S / 4 + S, S); ctx.lineTo(i + S, S);
    ctx.fill();
  }
  grunge(ctx, S, S, 9, 0.6, 'rgba(90,70,50,');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  _hazard = t;
  return t;
}
