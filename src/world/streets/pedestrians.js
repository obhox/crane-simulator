import * as THREE from 'three';
import { rng } from '../../util/math.js';
import { lots } from '../layout.js';
import { GeoBuilder, M, patchShader, CURB_Y, HALF_ROAD, pick, prepObstacles, obstacleDist } from './common.js';
import { key } from './signals.js';

// Pedestrians: ONE instanced mesh. Each vertex carries a bone id and a part id;
// the vertex shader swings hips / knees / shoulders / elbows around their
// joints (a 9-bone "skinned-lite" rig) from a per-instance gait phase, and
// colours clothes / skin / hair from per-instance colours. Optional parts
// (skirt, long hair, bag) collapse to a point when an instance doesn't use
// them, so two silhouettes share one draw call. The same deformation runs in
// the shadow pass. People walk loops around the blocks near the site, wait
// at junction corners for the green man and cross, queue at bus stops and
// sit on benches.
//
// Obstacles (spec §7.1, the mobile crane crossing the footway at the gate):
// setObstacles(list) with yawed rectangles {x, z, hx, hz, yaw}. People whose
// next stride would bring them within 1.5 m of one (and closer to it) stop
// and wait; anyone the obstacle closes in on (< 0.6 m) steps aside and drifts
// back onto their line once it has gone. No obstacles → unchanged behaviour.

const PART = { skin: 0, top: 1, bottom: 2, shoes: 3, hair: 4, skirt: 5, longHair: 6, bag: 7 };
const BONE = { body: 0, thighL: 1, shinL: 2, thighR: 3, shinR: 4, armL: 5, foreL: 6, armR: 7, foreR: 8 };

// lod 1: same rig and proportions with far fewer segments (~⅓ of the
// triangles) for people beyond the shadow radius
function figureGeometry(lod = 0) {
  const b = new GeoBuilder({ color: 3, bone: 1, part: 1 });
  const add = (g, m, bone, part) => b.add(g, m, { bone, part });
  const k = (n0, n1) => (lod ? n1 : n0);
  const cap = (r, l, seg = 6) => new THREE.CapsuleGeometry(r, l, 1, lod ? 4 : seg);
  // head + hair
  add(new THREE.SphereGeometry(0.1, k(9, 5), k(6, 4)), M(0, 1.63, 0.01, 0, 0, 0, 0.93, 1.13, 1.02), 0, PART.skin);
  add(new THREE.SphereGeometry(0.108, k(9, 5), k(3, 2), 0, Math.PI * 2, 0, Math.PI * 0.56), M(0, 1.655, -0.006, -0.25, 0, 0), 0, PART.hair);
  add(new THREE.CylinderGeometry(0.095, 0.11, 0.3, k(7, 4), 1, true), M(0, 1.52, -0.05), 0, PART.longHair);
  if (!lod) add(new THREE.CylinderGeometry(0.048, 0.052, 0.12, 6, 1, true), M(0, 1.5, 0), 0, PART.skin);
  // torso (shoulder girdle wider than the waist), pelvis
  add(new THREE.CylinderGeometry(0.2, 0.16, 0.5, k(9, 6)), M(0, 1.2, 0, 0, 0, 0, 1, 1, 0.6), 0, PART.top);
  if (!lod) add(new THREE.SphereGeometry(0.2, 9, 2, 0, Math.PI * 2, 0, Math.PI / 2), M(0, 1.445, 0, 0, 0, 0, 1, 0.32, 0.6), 0, PART.top);
  add(new THREE.CylinderGeometry(0.16, 0.155, 0.2, k(9, 6), 1, true), M(0, 0.9, 0, 0, 0, 0, 1, 1, 0.7), 0, PART.bottom);
  add(new THREE.CylinderGeometry(0.17, 0.27, 0.46, k(9, 5), 1, true), M(0, 0.72, 0), 0, PART.skirt);
  add(new THREE.BoxGeometry(0.07, 0.26, 0.3), M(0.245, 1.0, 0), 0, PART.bag);
  if (!lod) add(new THREE.BoxGeometry(0.012, 0.42, 0.012), M(0.2, 1.24, 0, 0, 0, 0.25), 0, PART.bag);
  // legs
  for (const [s, th, sh] of [[1, BONE.thighL, BONE.shinL], [-1, BONE.thighR, BONE.shinR]]) {
    add(cap(0.066, 0.33), M(s * 0.092, 0.71, 0), th, PART.bottom);
    add(cap(0.05, 0.34), M(s * 0.094, 0.29, -0.005), sh, PART.bottom);
    add(new THREE.BoxGeometry(0.09, 0.07, 0.25), M(s * 0.094, 0.035, 0.045), sh, PART.shoes);
  }
  // arms
  for (const [s, ua, fa] of [[1, BONE.armL, BONE.foreL], [-1, BONE.armR, BONE.foreR]]) {
    add(cap(0.045, 0.22), M(s * 0.215, 1.27, 0, 0, 0, s * 0.06), ua, PART.top);
    add(cap(0.037, 0.2), M(s * 0.228, 0.99, 0), fa, PART.top);
    if (!lod) add(new THREE.SphereGeometry(0.043, 5, 3), M(s * 0.23, 0.83, 0.008, 0, 0, 0, 0.7, 1.25, 1), fa, PART.skin);
  }
  return b.build();
}

const RIG = /* glsl */`
  attribute float bone;
  attribute float part;
  attribute vec4 iAnim;   // phase, gait (0 stand … 1 walk), pose (0 stand/walk, 1 sit), flags (1 skirt+long hair, 2 bag)
  attribute vec4 iColA;   // top rgb, skin tone
  attribute vec4 iColB;   // bottom rgb, hair tone
  vec3 rotX( vec3 v, vec3 p, float a ) {
    vec3 d = v - p; float c = cos( a ), s = sin( a );
    return p + vec3( d.x, d.y * c - d.z * s, d.y * s + d.z * c );
  }
  vec3 rotXn( vec3 n, float a ) { float c = cos( a ), s = sin( a ); return vec3( n.x, n.y * c - n.z * s, n.y * s + n.z * c ); }
  void rigAngles( out float hip, out float knee, out float sh, out float el, float side ) {
    float ph = iAnim.x + ( side > 0.0 ? 0.0 : 3.14159 );
    float g = iAnim.y;
    // forward swing is a negative rotation about +x (limbs hang along -y, body faces +z)
    hip = -0.42 * sin( ph ) * g;
    knee = g * ( 0.08 + 0.62 * pow( max( 0.0, cos( ph + 0.35 ) ), 1.6 ) );
    sh = 0.32 * sin( ph ) * g + ( 1.0 - g ) * 0.03 * sin( iAnim.x * 0.7 + side );
    el = -( 0.18 + 0.22 * g * max( 0.0, -sin( ph ) ) );
    if ( iAnim.z > 0.5 ) { hip = -1.5; knee = 1.45; sh = -0.35; el = -0.6; } // seated
  }
  vec3 rig( vec3 p, float b, out float ahip, out float aknee, out vec3 pivotA, out vec3 pivotB, out float aA, out float aB ) {
    aA = 0.0; aB = 0.0; pivotA = vec3( 0.0 ); pivotB = vec3( 0.0 );
    float side = ( b == 1.0 || b == 2.0 || b == 5.0 || b == 6.0 ) ? 1.0 : -1.0;
    float hip, knee, sh, el;
    rigAngles( hip, knee, sh, el, side );
    ahip = hip; aknee = knee;
    vec3 q = p;
    if ( b >= 1.0 && b <= 4.0 ) {
      vec3 H = vec3( side * 0.092, 0.9, 0.0 ), K = vec3( side * 0.093, 0.5, 0.0 );
      if ( b == 2.0 || b == 4.0 ) { q = rotX( q, K, knee ); aB = knee; }
      q = rotX( q, H, hip ); aA = hip;
    } else if ( b >= 5.0 ) {
      vec3 S = vec3( side * 0.21, 1.41, 0.0 ), E = vec3( side * 0.225, 1.12, 0.0 );
      if ( b == 6.0 || b == 8.0 ) { q = rotX( q, E, el ); aB = el; }
      q = rotX( q, S, sh ); aA = sh;
    }
    return q;
  }
`;

function rigPatch(material, key) {
  return patchShader(material, key, {
    vertexPars: RIG + 'varying float vPart;',
    vertex: {
      beginnormal_vertex: `vec3 objectNormal = vec3( normal );
        {
          float nh, nk, naA, naB; vec3 npA, npB;
          vec3 nq = rig( position, bone, nh, nk, npA, npB, naA, naB );
          objectNormal = rotXn( rotXn( objectNormal, naB ), naA );
        }`,
      begin_vertex: `float _h, _k, _aA, _aB; vec3 _pA, _pB;
        vec3 transformed = rig( position, bone, _h, _k, _pA, _pB, _aA, _aB );
        // vertical bob (twice per stride) / seated drop is in the instance matrix
        transformed.y += iAnim.y * 0.022 * cos( 2.0 * iAnim.x );
        float flags = iAnim.w;
        bool skirt = mod( flags, 2.0 ) > 0.5, bag = flags > 1.5;
        if ( ( part == 5.0 || part == 6.0 ) && !skirt ) transformed = vec3( 0.0, 1.0, 0.0 );
        if ( part == 7.0 && !bag ) transformed = vec3( 0.0, 1.0, 0.0 );
        vPart = part;`,
    },
  });
}

function pedMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  rigPatch(mat, 'ped');
  patchShader(mat, 'pedCol', {
    vertex: {
      color_vertex: `vColor = vec4( 1.0 );
        vec3 skinC = mix( vec3( 0.8, 0.54, 0.4 ), vec3( 0.13, 0.065, 0.035 ), iColA.w );
        vec3 hairC = mix( vec3( 0.018, 0.012, 0.008 ), vec3( 0.42, 0.3, 0.14 ), iColB.w * iColB.w );
        if ( part == 0.0 ) vColor.rgb = skinC;
        else if ( part == 1.0 ) vColor.rgb = iColA.rgb;
        else if ( part == 2.0 || part == 5.0 ) vColor.rgb = iColB.rgb;
        else if ( part == 3.0 ) vColor.rgb = vec3( 0.02 ) + iColB.rgb * 0.08;
        else if ( part == 4.0 || part == 6.0 ) vColor.rgb = hairC;
        else vColor.rgb = iColB.rgb * 0.5 + vec3( 0.02 );`,
    },
    fragmentPars: 'varying float vPart;',
    fragment: { roughnessmap_fragment: 'float roughnessFactor = vPart == 0.0 ? 0.55 : vPart == 4.0 || vPart == 6.0 ? 0.6 : vPart == 3.0 ? 0.45 : roughness;' },
  });
  return mat;
}

const TOPS = [0x1f2a44, 0x151515, 0xe4e4df, 0x75787b, 0xc2b394, 0x5b6043, 0x6d1f2a, 0x3d5a80, 0xc49a2c, 0x9e2b2b,
  0x2b6e6e, 0x8f6f48, 0x9db8d6, 0xc98f9e, 0x2e2e33, 0x4d3b2d, 0xf06b0a].map((h) => new THREE.Color(h));
const BOTTOMS = [0x1f2a3d, 0x141414, 0x46484b, 0xa89a7b, 0x3f5e86, 0x6d6549, 0x3f2d21, 0x26262a].map((h) => new THREE.Color(h));

export function buildPedestrians(root, quality, signals, crossings, plan) {
  const r = rng(2718);
  const N = { low: 50, medium: 130, high: 210, ultra: 300 }[quality.name] ?? 210;
  const bases = [figureGeometry(0), figureGeometry(1)];
  // Two instanced meshes over one shared figure: people near the camera cast
  // shadows, the rest don't (an InstancedMesh is culled as a whole, so one
  // city-wide mesh would be drawn into every shadow cascade). Instances are
  // re-sorted into them each frame; bounding spheres are refreshed so both
  // are frustum-culled per view / cascade.
  const material = pedMaterial();
  const depthMat = rigPatch(new THREE.MeshDepthMaterial(), 'pedDepth');
  const makeMesh = (cast, name, base) => {
    const geo = new THREE.BufferGeometry();
    for (const k of Object.keys(base.attributes)) geo.setAttribute(k, base.attributes[k]); // shared GPU buffers
    geo.boundingSphere = base.boundingSphere.clone();
    geo.boundingBox = base.boundingBox.clone();
    const attr = (usage) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4); a.setUsage(usage); return a; };
    const iAnim = attr(THREE.DynamicDrawUsage), iColA = attr(THREE.DynamicDrawUsage), iColB = attr(THREE.DynamicDrawUsage);
    geo.setAttribute('iAnim', iAnim);
    geo.setAttribute('iColA', iColA);
    geo.setAttribute('iColB', iColB);
    const mesh = new THREE.InstancedMesh(geo, material, N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.customDepthMaterial = depthMat;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.count = 0;
    mesh.name = name;
    root.add(mesh);
    return { mesh, iAnim, iColA, iColB, n: 0 };
  };
  const near = makeMesh(quality.name !== 'low', 'streets.pedestrians.near', bases[0]);
  const far = makeMesh(false, 'streets.pedestrians.far', bases[1]);
  const mesh = near.mesh;
  const NEAR_R = 85, DRAW_R = 330; // shadow casters · beyond this a 1.7 m figure is sub-pixel

  // ---------------------------------------------------------------- walkable block loops
  const blocks = lots().filter((l) => {
    const cx = (l.minX + l.maxX) / 2, cz = (l.minZ + l.maxZ) / 2;
    return Math.hypot(Math.max(Math.abs(cx) - (l.maxX - l.minX) / 2, 0), Math.max(Math.abs(cz) - (l.maxZ - l.minZ) / 2, 0)) < 170;
  });
  // walking line at offset d (from the curb) around a lot: road centre = lot edge ∓ OUTER
  const OUT = HALF_ROAD + 3.5;
  const loopCorners = (b, d) => {
    const o = OUT - HALF_ROAD - d; // how far outside the lot edge the line runs
    return [[b.minX - o, b.minZ - o], [b.maxX + o, b.minZ - o], [b.maxX + o, b.maxZ + o], [b.minX - o, b.maxZ + o]];
  };
  const findBlock = (x, z) => blocks.find((b) => x > b.minX - 5 && x < b.maxX + 5 && z > b.minZ - 5 && z < b.maxZ + 5);

  const peds = [];
  const idleSpots = [];
  for (const s of plan.busStops) {
    for (let k = 0; k < 4; k++) {
      // local shelter frame: +z faces the road; people stand under / beside it or sit on the bench
      const sit = (k === 1 || k === 2) && r() < 0.6;
      const lx = [-1.4, 0.2, 1.05, -0.55][k] + (r() - 0.5) * 0.2, lz = sit ? 0 : 0.05 + (r() - 0.5) * 0.5;
      const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      idleSpots.push({ x: s.x + lx * c + lz * sn, z: s.z - lx * sn + lz * c, yaw: s.yaw + (sit ? 0 : (r() - 0.5) * 0.9), sit, bus: true, seatY: 0.47, seatZ: -0.5 });
    }
  }
  for (const b of plan.idle) if (r() < 0.45) idleSpots.push({ x: b.x, z: b.z, yaw: b.yaw, sit: true, seatY: 0.45, seatZ: -0.05 });

  for (let i = 0; i < N; i++) {
    const top = pick(r, TOPS), bot = pick(r, BOTTOMS);
    const flags = (r() < 0.45 ? 1 : 0) + (r() < 0.3 ? 2 : 0);
    const p = { i: peds.length, flags, phase: r() * 6.28, speed: 1.15 + r() * 0.4, scale: (flags & 1 ? 0.93 : 1.0) * (0.95 + r() * 0.1), yaw: 0, x: 0, z: 0, gait: 0 };
    if (i < idleSpots.length && i < N * 0.2) {
      const s = idleSpots[i];
      Object.assign(p, { state: 'idle', x: s.x, z: s.z, yaw: s.yaw, sit: s.sit, seat: s });
      if (s.sit) {
        // sit on the bench seat: pelvis over the seat, pushed back towards the backrest
        p.x = s.x + s.seatZ * Math.sin(s.yaw); p.z = s.z + s.seatZ * Math.cos(s.yaw);
      }
    } else if (blocks.length) {
      const b = blocks[Math.floor(r() * blocks.length)];
      const d = 2.15 + r() * 0.5; // walking line 2.15–2.65 m from the curb (clear of shelters, trees and the site hoarding)
      Object.assign(p, { state: 'loop', b, d, dir: r() < 0.5 ? 1 : -1, corners: loopCorners(b, d), seg: Math.floor(r() * 4), u: r() });
    } else continue;
    p.colA = [top.r, top.g, top.b, Math.pow(r(), 1.6)];
    p.colB = [bot.r, bot.g, bot.b, r() < 0.2 ? 0.7 + r() * 0.3 : r() * 0.4];
    peds.push(p);
  }
  // shelter / bench people face the road; everyone else walks

  const corner = (p, k) => p.corners[((k % 4) + 4) % 4];
  const segLen = (p) => {
    const a = corner(p, p.seg), c = corner(p, p.seg + p.dir);
    return Math.hypot(c[0] - a[0], c[1] - a[1]);
  };
  // nearest junction of a corner point
  const nodeNear = (x, z) => {
    let best = null, bd = 30;
    for (const n of signals.nodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };

  function arriveCorner(p) {
    const [cx, cz] = corner(p, p.seg);
    const prev = corner(p, p.seg - p.dir);
    const hx = Math.sign(cx - prev[0]), hz = Math.sign(cz - prev[1]);
    if (r() < 0.4) {
      // try to cross straight ahead to the neighbouring block
      const node = nodeNear(cx + hx * 7, cz + hz * 7);
      const w = 2 * (HALF_ROAD + p.d);
      const tx = cx + hx * w, tz = cz + hz * w;
      const nb = findBlock(tx + hx * 3, tz + hz * 3);
      if (node && nb && nb !== p.b) {
        const axis = hx !== 0 ? 'x' : 'z';
        const leg = axis === 'z' ? (cx < node.x ? 'W' : 'E') : (cz < node.z ? 'S' : 'N');
        p.state = 'wait';
        p.cross = { x0: cx, z0: cz, x1: tx, z1: tz, node, axis, key: `${key(node.x, node.z)}:${leg}`, nb, hx, hz, t: 0 };
        p.x = cx; p.z = cz;
        p.targetYaw = Math.atan2(hx, hz);
        return;
      }
    }
    p.u = 0;
  }

  function joinBlock(p, b, x, z, hx, hz) {
    p.b = b;
    p.corners = loopCorners(b, p.d);
    // closest corner, then the direction whose first segment keeps our heading
    let k = 0, bd = Infinity;
    p.corners.forEach(([cx, cz], i) => { const d = Math.hypot(cx - x, cz - z); if (d < bd) { bd = d; k = i; } });
    for (const dir of [1, -1]) {
      const a = p.corners[k], c = p.corners[(k + dir + 4) % 4];
      if (Math.sign(c[0] - a[0]) === hx && Math.sign(c[1] - a[1]) === hz) { p.dir = dir; break; }
    }
    p.seg = k;
    p.u = 0;
    p.state = 'loop';
  }

  // ---------------------------------------------------------------- obstacles (§7.1)
  const STOP_R = 1.5, EVADE_R = 0.6, EVADE_V = 1.4, RETURN_V = 0.5, STRIDE = 0.6;
  const obs = [];
  let nObs = 0, obsList = null;
  const minDist = (x, z) => {
    let d = Infinity;
    for (let k = 0; k < nObs; k++) {
      const o = obs[k];
      if (Math.abs(x - o.x) > o.r + 4 || Math.abs(z - o.z) > o.r + 4) continue;
      d = Math.min(d, obstacleDist(o, x, z));
    }
    return d;
  };
  // walking direction this frame (unit) or null
  const walkDir = (p, out) => {
    let dx = 0, dz = 0;
    if (p.state === 'loop') { const a = corner(p, p.seg), c = corner(p, p.seg + p.dir); dx = c[0] - a[0]; dz = c[1] - a[1]; }
    else if (p.state === 'cross' || p.state === 'wait') { dx = p.cross.x1 - p.cross.x0; dz = p.cross.z1 - p.cross.z0; }
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) return null;
    out[0] = dx / l; out[1] = dz / l;
    return out;
  };
  const wd = [0, 0];
  // true when the next stride would enter the 1.5 m zone of an obstacle (walking away is always allowed)
  const held = (p) => {
    const x = p.x + (p.ox || 0), z = p.z + (p.oz || 0);
    const d0 = minDist(x, z);
    if (d0 > STOP_R + STRIDE + 0.5) return false;
    const w = walkDir(p, wd);
    if (!w) return false;
    const d1 = minDist(x + w[0] * STRIDE, z + w[1] * STRIDE);
    return d1 < STOP_R && d1 < d0;
  };
  // step aside out of an obstacle that is closing in; drift back when clear
  const evade = (p, dt) => {
    const x = p.x + (p.ox || 0), z = p.z + (p.oz || 0);
    let best = null, bd = Infinity;
    for (let k = 0; k < nObs; k++) {
      const o = obs[k];
      if (Math.abs(x - o.x) > o.r + 3 || Math.abs(z - o.z) > o.r + 3) continue;
      const d = obstacleDist(o, x, z);
      if (d < bd) { bd = d; best = o; }
    }
    if (best && bd < EVADE_R) {
      const dx = x - best.x, dz = z - best.z;
      const lx = dx * best.c - dz * best.s, lz = dx * best.s + dz * best.c;
      let ux, uz; // outward direction in the obstacle frame
      if (bd > 0) { ux = lx - Math.max(-best.hx, Math.min(best.hx, lx)); uz = lz - Math.max(-best.hz, Math.min(best.hz, lz)); }
      else if (best.hx - Math.abs(lx) < best.hz - Math.abs(lz)) { ux = Math.sign(lx) || 1; uz = 0; }
      else { ux = 0; uz = Math.sign(lz) || 1; }
      const ul = Math.hypot(ux, uz) || 1;
      ux /= ul; uz /= ul;
      const wx = ux * best.c + uz * best.s, wz = -ux * best.s + uz * best.c; // local → world
      p.ox = (p.ox || 0) + wx * EVADE_V * dt;
      p.oz = (p.oz || 0) + wz * EVADE_V * dt;
      return true;
    }
    if (p.ox || p.oz) {
      const l = Math.hypot(p.ox, p.oz), k = Math.max(0, l - RETURN_V * dt) / l;
      if (minDist(p.x + p.ox * k, p.z + p.oz * k) > EVADE_R + 0.3) { p.ox *= k; p.oz *= k; if (l < 0.01) p.ox = p.oz = 0; }
    }
    return false;
  };

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v3 = new THREE.Vector3(), s3 = new THREE.Vector3();
  let t = 0;
  return {
    mesh, meshes: [near.mesh, far.mesh], peds,
    /** @param {{x:number,z:number,hx:number,hz:number,yaw:number}[]} list  (kept by reference, re-read every frame) */
    setObstacles(list) { obsList = list; },
    update(dt, camPos) {
      t += dt;
      dt = Math.min(dt, 0.1);
      near.n = 0; far.n = 0;
      nObs = prepObstacles(obsList, obs);
      for (const p of peds) {
        let moving = false;
        const hold = nObs > 0 && p.state !== 'idle' && held(p);
        if (hold) {
          // stop and wait for the obstacle to pass
        } else if (p.state === 'loop') {
          const L = segLen(p);
          p.u += (p.speed * dt) / Math.max(L, 0.1);
          while (p.u >= 1 && p.state === 'loop') {
            p.u -= 1;
            p.seg = (p.seg + p.dir + 4) % 4;
            arriveCorner(p);
          }
          if (p.state === 'loop') {
            const a = corner(p, p.seg), c = corner(p, p.seg + p.dir);
            p.x = a[0] + (c[0] - a[0]) * p.u;
            p.z = a[1] + (c[1] - a[1]) * p.u;
            p.targetYaw = Math.atan2(c[0] - a[0], c[1] - a[1]);
            moving = true;
          }
        } else if (p.state === 'wait') {
          const w = signals.walk(p.cross.node, p.cross.axis);
          if (w === 0) { p.state = 'cross'; p.cross.t = 0; crossings.set(p.cross.key, (crossings.get(p.cross.key) || 0) + 1); }
        } else if (p.state === 'cross') {
          const c = p.cross;
          const L = Math.hypot(c.x1 - c.x0, c.z1 - c.z0);
          const hurry = signals.walk(c.node, c.axis) === 0 ? 1 : 1.35;
          c.t += (p.speed * hurry * dt) / L;
          if (c.t >= 1) {
            crossings.set(c.key, Math.max(0, (crossings.get(c.key) || 1) - 1));
            joinBlock(p, c.nb, c.x1, c.z1, c.hx, c.hz);
            p.x = c.x1; p.z = c.z1;
          } else {
            p.x = c.x0 + (c.x1 - c.x0) * c.t;
            p.z = c.z0 + (c.z1 - c.z0) * c.t;
            moving = true;
          }
        }
        if ((nObs || p.ox || p.oz) && evade(p, dt)) moving = true;
        // smooth heading, gait blend
        if (p.targetYaw !== undefined) {
          let dy = p.targetYaw - p.yaw;
          while (dy > Math.PI) dy -= 2 * Math.PI;
          while (dy < -Math.PI) dy += 2 * Math.PI;
          p.yaw += dy * Math.min(1, dt * 7);
        }
        p.gait += ((moving ? 1 : 0) - p.gait) * Math.min(1, dt * 4);
        p.phase += moving ? (p.speed / 1.45) * Math.PI * 2 * dt : dt * 0.9;
        const y = p.sit ? CURB_Y + p.seat.seatY - 0.9 * p.scale + 0.06 : CURB_Y;
        const onRoad = p.state === 'cross' && Math.abs(p.cross.t - 0.5) < 0.5 - p.d / (2 * (HALF_ROAD + p.d));
        const px = p.x + (p.ox || 0), pz = p.z + (p.oz || 0);
        const d = camPos ? Math.hypot(px - camPos.x, pz - camPos.z) : 0;
        if (d > DRAW_R) continue;
        const B = d < NEAR_R ? near : far;
        const n = B.n++;
        q.setFromAxisAngle(up, p.yaw);
        m4.compose(v3.set(px, onRoad ? y - CURB_Y : y, pz), q, s3.set(p.scale, p.scale, p.scale));
        B.mesh.setMatrixAt(n, m4);
        B.iAnim.setXYZW(n, p.phase, p.gait, p.sit ? 1 : 0, p.flags);
        B.iColA.setXYZW(n, p.colA[0], p.colA[1], p.colA[2], p.colA[3]);
        B.iColB.setXYZW(n, p.colB[0], p.colB[1], p.colB[2], p.colB[3]);
      }
      for (const B of [near, far]) {
        B.mesh.count = B.n;
        B.mesh.visible = B.n > 0;
        B.mesh.instanceMatrix.needsUpdate = true;
        B.iAnim.needsUpdate = B.iColA.needsUpdate = B.iColB.needsUpdate = true;
        if (B.n) B.mesh.computeBoundingSphere();
      }
    },
  };
}
