import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fluorescent } from './kit.js';

// Site operatives: articulated figures (pelvis, torso, hi-vis vest with
// retro-reflective tape, head, hard hat with brim/peak, two-segment arms
// with gloves, two-segment legs, safety boots) at real proportions for a
// ~1.8 m adult. Every body part is ONE InstancedMesh shared by all workers
// (≈12 draw calls for the whole crew); a tiny forward-kinematics pass per
// frame poses them: walk cycle (hip swing, knee flex in swing phase, arm
// counter-swing, pelvis bob/rotation) and idle poses (standing, bent over
// tying rebar, banksman signalling, on the phone, bricklaying, crouching).

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _l = new THREE.Matrix4();
const ONE = new THREE.Vector3(1, 1, 1);

function jointMat(parent, out, tx, ty, tz, rx = 0, ry = 0, rz = 0, order = 'YXZ') {
  _e.set(rx, ry, rz, order);
  _q.setFromEuler(_e);
  _l.compose(_v.set(tx, ty, tz), _q, ONE);
  return out.multiplyMatrices(parent, _l);
}

// ------------------------------------------------------------------ part geometry (joint at origin)
// Body segments are lathed from measured girth profiles of a ~1.8 m adult
// in work clothes (baggy trousers, jacket), not uniform capsules — the taper
// (thigh → knee → calf → ankle, deltoid → elbow → wrist, chest → waist) is
// what makes a figure read as a person rather than a mannequin at 20-60 m.
const merge = (list) => mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false);
// profile: [[radius, y], …] top → bottom (y descending); closed at both ends
function limb(profile, seg = 10, sx = 1, sz = 1) {
  const pts = [new THREE.Vector2(0.0001, profile[0][1] + profile[0][0] * 0.35)];
  for (const [r, y] of profile) pts.push(new THREE.Vector2(r, y));
  const last = profile[profile.length - 1];
  pts.push(new THREE.Vector2(0.0001, last[1] - last[0] * 0.35));
  pts.reverse(); // LatheGeometry wants bottom → top for outward normals
  const g = new THREE.LatheGeometry(pts, seg);
  g.scale(sx, 1, sz);
  g.computeVertexNormals();
  return g;
}
// torso girth (radius at height above the waist joint), depth ratio 0.62
const TORSO = [[0.07, 0.5], [0.12, 0.47], [0.165, 0.43], [0.178, 0.36], [0.175, 0.26], [0.16, 0.15], [0.15, 0.07], [0.152, 0.0], [0.155, -0.04]];
function torsoR(y) {
  for (let i = 0; i < TORSO.length - 1; i++) {
    const [r0, y0] = TORSO[i], [r1, y1] = TORSO[i + 1];
    if (y <= y0 && y >= y1) return r0 + (r1 - r0) * ((y0 - y) / (y0 - y1));
  }
  return TORSO[TORSO.length - 1][0];
}
function partGeos() {
  const G = {};
  // pelvis / seat of the trousers (wide, shallow) + belt
  const pel = new THREE.CapsuleGeometry(0.11, 0.13, 4, 10);
  pel.rotateZ(Math.PI / 2);
  pel.scale(1, 1.0, 0.95);
  pel.translate(0, -0.03, 0);
  G.pelvis = merge([pel, new THREE.CylinderGeometry(0.162, 0.165, 0.05, 14, 1, true).scale(1, 1, 0.66).translate(0, 0.055, 0)]);
  // torso: chest/back lathe + deltoid caps
  const chest = limb(TORSO, 14, 1, 0.62);
  const delt = (s) => new THREE.SphereGeometry(0.066, 10, 8).scale(1, 0.9, 1).translate(0.19 * s, 0.415, 0);
  G.torso = merge([chest, delt(1), delt(-1)]);
  // hi-vis vest: follows the chest 12 mm proud, open at the shoulders
  const vp = [];
  for (let y = 0.44; y >= -0.08; y -= 0.052) vp.push([torsoR(y) + 0.013, y]);
  const vest = limb(vp, 14, 1, 0.66);
  const strap = (x) => new THREE.BoxGeometry(0.075, 0.035, 0.235).translate(x, 0.455, 0);
  G.vest = merge([vest, strap(0.1), strap(-0.1)]);
  // retro-reflective tape: two hoops + braces over the shoulders
  const band = (y) => new THREE.CylinderGeometry(torsoR(y) + 0.017, torsoR(y - 0.035) + 0.017, 0.045, 14, 1, true).scale(1, 1, 0.665).translate(0, y - 0.0175, 0);
  const brace = (x, z) => new THREE.BoxGeometry(0.045, 0.33, 0.006).translate(x, 0.27, z * ((torsoR(0.3) + 0.017) * 0.665));
  G.tape = merge([band(0.05), band(0.15), brace(0.085, 1), brace(-0.085, 1), brace(0.085, -1), brace(-0.085, -1)]);
  // head (skull + jaw + nose + ears) on a neck
  const neck = new THREE.CylinderGeometry(0.05, 0.058, 0.12, 10).translate(0, 0.05, 0);
  const skull = new THREE.SphereGeometry(0.1, 14, 12).scale(0.9, 1.12, 1.02).translate(0, 0.2, -0.005);
  const jaw = new THREE.SphereGeometry(0.075, 10, 8).scale(1, 0.85, 1.05).translate(0, 0.145, 0.03);
  const nose = new THREE.ConeGeometry(0.016, 0.045, 6).rotateX(Math.PI / 2 + 0.35).translate(0, 0.19, 0.105);
  const ear = (s) => new THREE.SphereGeometry(0.024, 6, 6).scale(0.45, 1, 0.8).translate(0.09 * s, 0.19, -0.005);
  G.head = merge([neck, skull, jaw, nose, ear(1), ear(-1)]);
  // EN 397 helmet: shell, peak, brim, crown ridge
  const dome = new THREE.SphereGeometry(0.128, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.88, 1.13).translate(0, 0.245, 0);
  const brim = new THREE.CylinderGeometry(0.142, 0.148, 0.014, 18).scale(1, 1, 1.16).translate(0, 0.247, 0.012);
  const peak = new THREE.CylinderGeometry(0.1, 0.1, 0.012, 12, 1, false, -Math.PI / 2.4, Math.PI / 1.2).scale(1, 1, 0.9).translate(0, 0.25, 0.1);
  const ridge = new THREE.BoxGeometry(0.03, 0.022, 0.25).translate(0, 0.356, 0);
  G.hat = merge([dome, brim, peak, ridge]);
  // limbs (joint at the top, hanging down −y)
  G.uarm = limb([[0.055, 0.0], [0.054, -0.06], [0.05, -0.15], [0.045, -0.25], [0.043, -0.29]], 10);
  G.farm = limb([[0.045, 0.0], [0.046, -0.06], [0.04, -0.16], [0.036, -0.22], [0.04, -0.245]], 10);
  const palm = new THREE.BoxGeometry(0.085, 0.1, 0.035).translate(0, -0.06, 0.005);
  const fingers = new THREE.CapsuleGeometry(0.02, 0.05, 3, 8).scale(2.0, 1, 0.85).translate(0, -0.13, 0.012);
  const thumb = new THREE.CapsuleGeometry(0.014, 0.035, 3, 6).rotateZ(0.5).translate(-0.045, -0.07, 0.02);
  G.hand = merge([palm, fingers, thumb]);
  G.thigh = limb([[0.092, 0.02], [0.088, -0.05], [0.08, -0.16], [0.07, -0.3], [0.063, -0.41], [0.062, -0.44]], 12);
  G.shin = limb([[0.063, 0.0], [0.066, -0.1], [0.062, -0.2], [0.056, -0.3], [0.058, -0.37], [0.062, -0.405]], 12);
  // safety boot: padded collar, upper, rounded steel toe cap, cleated sole
  const collar = new THREE.CylinderGeometry(0.058, 0.062, 0.12, 10).translate(0, 0.005, -0.005);
  const upper = new THREE.BoxGeometry(0.105, 0.085, 0.2).translate(0, -0.035, 0.03);
  const toe = new THREE.SphereGeometry(0.056, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.95, 1.0, 1.25).translate(0, -0.075, 0.13);
  const heel = new THREE.CylinderGeometry(0.055, 0.055, 0.085, 10, 1, false, Math.PI / 2, Math.PI).scale(1, 1, 0.9).translate(0, -0.035, -0.07);
  const sole = new THREE.BoxGeometry(0.118, 0.03, 0.3).translate(0, -0.088, 0.045);
  G.boot = merge([collar, upper, toe, heel, sole]);
  return G;
}

// ------------------------------------------------------------------ materials
function partMats() {
  const std = (o) => new THREE.MeshStandardMaterial({ color: 0xffffff, ...o });
  const M = {
    cloth: std({ roughness: 0.9 }),
    hivis: std({ roughness: 0.72 }),
    tape: std({ color: 0xd0d2d4, roughness: 0.3, metalness: 0.35 }),
    skin: std({ roughness: 0.62 }),
    hat: std({ roughness: 0.32 }),
    glove: std({ roughness: 0.85 }),
    boot: std({ roughness: 0.75 }),
  };
  M.fluoro = fluorescent(M.hivis, 0.22);
  return M;
}

// Part table: [name, material key, instances per worker, colour key]
const PARTS = [
  ['pelvis', 'cloth', 1, 'trousers'], ['torso', 'cloth', 1, 'shirt'], ['vest', 'hivis', 1, 'vest'], ['tape', 'tape', 1, null],
  ['head', 'skin', 1, 'skin'], ['hat', 'hat', 1, 'hat'], ['uarm', 'cloth', 2, 'shirt'], ['farm', 'cloth', 2, 'shirt'],
  ['hand', 'glove', 2, 'glove'], ['thigh', 'cloth', 2, 'trousers'], ['shin', 'cloth', 2, 'trousers'], ['boot', 'boot', 2, 'boot'],
];

const PAL = {
  vest: [0xd8f000, 0xff6a10, 0xd8f000, 0xd8f000, 0xff6a10],
  shirt: [0x1e2a3c, 0x5f646b, 0x2b2b2b, 0x3a4632, 0x6e6450, 0x3d4f6b, 0x7a2a22],
  trousers: [0x2b3440, 0x323232, 0x4f4a3e, 0x34465e, 0x2a2a2a],
  skin: [0xe2b99b, 0xc9987a, 0x8d5a3b, 0xf0cdb0, 0x6b4630, 0xb07e5e],
  hat: [0xf4f4f2, 0xf2c200, 0xff7a00, 0xf4f4f2, 0x1f5fb0, 0xf2c200],
  glove: [0x8a8a7e, 0xc9b04a, 0x2a2a2a, 0x7a8a9a],
  boot: [0x3b2a1c, 0x1c1c1c, 0x6e5034],
};

// ------------------------------------------------------------------ crew layout
// Static crew (x, y, z, yaw, pose) and walkers (path, y). Paths avoid every
// collider on site and stay out of load-landing spots.
const STATIC = [
  { p: [-9.6, 0, -14.6], yaw: -Math.PI / 2, pose: 'signal', hat: 0xff7a00, vest: 0xff6a10, low: true },
  { p: [18.95, 16, 25.05], yaw: -0.7, pose: 'bend', low: true },
  { p: [35.1, 16, 13.35], yaw: -1.25, pose: 'stand', hat: 0xf4f4f2, low: true },
  { p: [30.6, 16, 11.35], yaw: -Math.PI / 2, pose: 'bend' },
  { p: [22.0, 6.117, 27.3], yaw: Math.PI, pose: 'lay', low: true },
  { p: [33.5, 6.117, 27.75], yaw: Math.PI + 0.5, pose: 'stand' },
  { p: [-37.1, 0, -55.0], yaw: 0.9, pose: 'stand', hat: 0xf4f4f2 },
  { p: [-24.7, 0, -25.9], yaw: 2.96, pose: 'stand', low: true },
  { p: [-45.6, 0, -38.8], yaw: 2.5, pose: 'phone' },
  { p: [48.6, 0, 45.8], yaw: 0.78, pose: 'crouch' },
];
const WALKERS = [
  { path: [[-37.0, -56.8], [-37.0, -48.5], [-40.5, -44.5], [-43.4, -36.2]], y: 0, low: true },
  { path: [[-40.5, -41.0], [-24, -43.5], [-12, -46], [4, -42.5], [17, -26], [17.5, -6], [15.4, 1.9]], y: 0, low: true },
  { path: [[14.5, 29.7], [41.5, 29.7]], y: 0 },
  { path: [[-42.2, -22], [-42.2, 25]], y: 0 },
  { path: [[14.6, 7.4], [14.6, 19.8]], y: 16, low: true },
];

export function buildWorkers(ctx) {
  const { root, q, r } = ctx;
  const low = q.name === 'low';
  const G = partGeos();
  const M = partMats();
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const crew = [];
  const mk = (spec, walker) => {
    const o = new THREE.Object3D(); // transform holder (keeps site.workers[i].position semantics)
    o.name = 'worker';
    const jacket = r() < 0.45; // long-sleeve hi-vis jacket instead of vest over a shirt
    const vest = spec.vest ?? pick(PAL.vest);
    const w = {
      o, walker, pose: spec.pose || 'stand', path: spec.path, y: spec.y ?? spec.p?.[1] ?? 0,
      seg: 0, dir: 1, u: r(), wait: r() * 3, phase: r() * 6.28, t: r() * 100, seed: r() * 10,
      speed: 1.15 + r() * 0.35, scale: 0.94 + r() * 0.09, look: 0,
      colors: {
        vest: new THREE.Color(vest), shirt: new THREE.Color(jacket ? vest : pick(PAL.shirt)),
        trousers: new THREE.Color(pick(PAL.trousers)), skin: new THREE.Color(pick(PAL.skin)),
        hat: new THREE.Color(spec.hat ?? pick(PAL.hat)), glove: new THREE.Color(pick(PAL.glove)), boot: new THREE.Color(pick(PAL.boot)),
      },
    };
    if (walker) {
      const [x, z] = spec.path[0];
      o.position.set(x, w.y, z);
      w.u = r() * 0.8;
    } else {
      o.position.set(...spec.p);
      o.rotation.y = spec.yaw;
    }
    root.add(o);
    crew.push(w);
  };
  for (const s of STATIC) if (!low || s.low) mk(s, false);
  for (const s of WALKERS) if (!low || s.low) mk(s, true);

  // one InstancedMesh per part
  const meshes = {};
  for (const [name, mk2, per, ck] of PARTS) {
    const im = new THREE.InstancedMesh(G[name], M[mk2], crew.length * per);
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    im.name = 'site:worker:' + name;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (ck) crew.forEach((w, i) => { for (let k = 0; k < per; k++) im.setColorAt(i * per + k, w.colors[ck]); });
    root.add(im);
    meshes[name] = im;
  }
  const J = {};
  for (const k of ['root', 'pelvis', 'waist', 'neck', 'sh', 'el', 'wr', 'hip', 'kn', 'an']) J[k] = new THREE.Matrix4();
  const state = { crew, meshes, M, J };
  // place walkers on their paths and pose everyone once
  for (const w of crew) if (w.walker) advanceWalker(w, 0);
  updateWorkers(state, 0, 0);
  return state;
}

function advanceWalker(w, dt) {
  const P = w.path;
  if (w.wait > 0) {
    w.wait -= dt;
    w.moving = false;
    return;
  }
  const a = P[w.seg], b = P[w.seg + w.dir] || P[w.seg];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L = Math.hypot(dx, dz) || 1;
  w.u += (w.speed * dt) / L;
  if (w.u >= 1) {
    w.u = 0;
    w.seg += w.dir;
    if (w.seg + w.dir < 0 || w.seg + w.dir >= P.length) {
      w.dir = -w.dir;
      w.wait = 2 + Math.random() * 5;
    }
  }
  const a2 = P[w.seg], b2 = P[w.seg + w.dir] || a2;
  const x = a2[0] + (b2[0] - a2[0]) * w.u, z = a2[1] + (b2[1] - a2[1]) * w.u;
  w.o.position.set(x, w.y, z);
  const target = Math.atan2(b2[0] - a2[0], b2[1] - a2[1]);
  let d = target - w.o.rotation.y;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  w.o.rotation.y += d * Math.min(1, dt * 5);
  w.moving = true;
}

// Pose parameters → joint matrices → instance matrices.
export function updateWorkers(st, dt, night) {
  const { crew, meshes, J, M } = st;
  M.fluoro.uFluoro.value = 0.22 * (1 - night);
  let i = 0;
  for (const w of crew) {
    w.t += dt;
    if (w.walker) advanceWalker(w, dt);
    const t = w.t, sd = w.seed;
    // pose parameters (radians; "F" = forward swing)
    let pelY = 0.97, pelZ = 0, pelPitch = 0, hipYaw = 0, spine = 0.03, twist = 0, headYaw = 0, headPitch = 0;
    const arm = [0, 0], out = [0.08, 0.08], elbow = [0.2, 0.2], thigh = [0, 0], knee = [0.04, 0.04], foot = [0, 0];
    if (w.walker && w.moving) {
      w.phase += dt * Math.PI * 2 * w.speed / (1.1 + 0.25 * w.speed);
      const p = w.phase, s = Math.sin(p);
      thigh[0] = 0.42 * s; thigh[1] = -0.42 * s;
      knee[0] = 0.08 + 0.9 * Math.max(0, Math.cos(p - 0.5)) ** 2;
      knee[1] = 0.08 + 0.9 * Math.max(0, Math.cos(p + Math.PI - 0.5)) ** 2;
      for (let k = 0; k < 2; k++) foot[k] = -(thigh[k] - knee[k]) * 0.55;
      arm[0] = -0.34 * s; arm[1] = 0.34 * s;
      elbow[0] = 0.25 + 0.2 * Math.max(0, -s); elbow[1] = 0.25 + 0.2 * Math.max(0, s);
      pelY += 0.022 * Math.cos(2 * p);
      hipYaw = 0.08 * s; twist = -0.1 * s; spine = 0.06;
      headYaw = 0.12 * Math.sin(t * 0.4 + sd);
    } else {
      const pose = w.walker ? 'stand' : w.pose;
      const br = Math.sin(t * 1.4 + sd);
      if (pose === 'stand') {
        spine = 0.02 + 0.01 * br;
        headYaw = 0.6 * Math.sin(t * 0.23 + sd) * Math.sin(t * 0.07 + sd * 2);
        headPitch = 0.1 + 0.05 * Math.sin(t * 0.3 + sd);
        out[0] = 0.12; out[1] = 0.12; arm[0] = arm[1] = 0.05; elbow[0] = elbow[1] = 0.25 + 0.05 * br;
        hipYaw = 0.05 * Math.sin(t * 0.2 + sd);
        knee[0] = 0.05 + 0.05 * Math.max(0, Math.sin(t * 0.25 + sd));
      } else if (pose === 'bend') {
        pelPitch = 0.55; spine = 0.55; pelZ = -0.12; pelY = 0.93;
        thigh[0] = thigh[1] = 0.5; knee[0] = knee[1] = 0.28; foot[0] = foot[1] = 0.33;
        arm[0] = 1.25 + 0.08 * Math.sin(t * 5 + sd); arm[1] = 1.3 + 0.08 * Math.sin(t * 5.6 + sd);
        elbow[0] = 0.45 + 0.2 * Math.sin(t * 6 + sd); elbow[1] = 0.5 + 0.2 * Math.cos(t * 6.3 + sd);
        out[0] = out[1] = 0.12;
        headPitch = -0.3;
      } else if (pose === 'signal') {
        // banksman: right hand raised, left arm out and waving the load in
        spine = 0.0;
        arm[1] = 2.85; out[1] = 0.12; elbow[1] = 0.1;
        arm[0] = 0.15; out[0] = 1.25 + 0.3 * Math.sin(t * 2.2); elbow[0] = 0.15 + 0.2 * Math.max(0, Math.sin(t * 2.2));
        headPitch = -0.45; headYaw = 0.2 * Math.sin(t * 0.3);
      } else if (pose === 'phone') {
        arm[1] = 0.55; out[1] = 0.3; elbow[1] = 2.45;
        arm[0] = 0.25; out[0] = 0.1; elbow[0] = 1.3;
        headYaw = 0.3 * Math.sin(t * 0.25 + sd); headPitch = 0.12;
        hipYaw = 0.1 * Math.sin(t * 0.15);
        knee[1] = 0.12;
      } else if (pose === 'lay') {
        // bricklayer: bend at the waist, alternate reaching to the wall
        const c = Math.sin(t * 1.6 + sd);
        pelPitch = 0.2; spine = 0.35 + 0.15 * Math.max(0, c);
        thigh[0] = thigh[1] = 0.2; knee[0] = knee[1] = 0.15; foot[0] = foot[1] = 0.15;
        arm[0] = 1.0 + 0.4 * Math.max(0, c); arm[1] = 0.7 + 0.3 * Math.max(0, -c);
        elbow[0] = 0.5 - 0.3 * Math.max(0, c); elbow[1] = 0.9;
        headPitch = 0.25;
      } else if (pose === 'crouch') {
        pelY = 0.5; pelPitch = 0.1; spine = 0.35;
        thigh[0] = thigh[1] = 1.35; knee[0] = knee[1] = 2.2; foot[0] = foot[1] = 0.85;
        out[0] = out[1] = 0.25;
        arm[0] = arm[1] = 0.55; elbow[0] = elbow[1] = 0.6;
        headPitch = 0.15 + 0.1 * Math.sin(t * 0.3); headYaw = 0.3 * Math.sin(t * 0.2 + sd);
      }
    }
    // ---- forward kinematics
    const o = w.o;
    _q.setFromAxisAngle(_v.set(0, 1, 0), o.rotation.y);
    J.root.compose(o.position, _q, _s.setScalar(w.scale));
    jointMat(J.root, J.pelvis, 0, pelY, pelZ, pelPitch, hipYaw, 0);
    jointMat(J.pelvis, J.waist, 0, 0.05, 0, spine, twist, 0);
    jointMat(J.waist, J.neck, 0, 0.5, 0, headPitch, headYaw, 0);
    meshes.pelvis.setMatrixAt(i, J.pelvis);
    meshes.torso.setMatrixAt(i, J.waist);
    meshes.vest.setMatrixAt(i, J.waist);
    meshes.tape.setMatrixAt(i, J.waist);
    meshes.head.setMatrixAt(i, J.neck);
    meshes.hat.setMatrixAt(i, J.neck);
    for (let k = 0; k < 2; k++) {
      const s = k === 0 ? 1 : -1; // k=0 left (+x), k=1 right (-x)
      jointMat(J.waist, J.sh, 0.205 * s, 0.43, 0, -arm[k], 0, out[k] * s, 'XZY');
      jointMat(J.sh, J.el, 0, -0.29, 0, -elbow[k], 0, 0);
      jointMat(J.el, J.wr, 0, -0.25, 0, 0, 0, 0);
      jointMat(J.pelvis, J.hip, 0.095 * s, -0.03, 0, -thigh[k], 0, 0.03 * s);
      jointMat(J.hip, J.kn, 0, -0.43, 0, knee[k], 0, 0);
      jointMat(J.kn, J.an, 0, -0.41, 0, -foot[k], 0, 0);
      const ii = i * 2 + k;
      meshes.uarm.setMatrixAt(ii, J.sh);
      meshes.farm.setMatrixAt(ii, J.el);
      meshes.hand.setMatrixAt(ii, J.wr);
      meshes.thigh.setMatrixAt(ii, J.hip);
      meshes.shin.setMatrixAt(ii, J.kn);
      meshes.boot.setMatrixAt(ii, J.an);
    }
    i++;
  }
  for (const k in meshes) meshes[k].instanceMatrix.needsUpdate = true;
}

// Stand-alone figure (compat with the old makeWorker export).
export function makeWorker(vestColor = 0xff6a10) {
  const G = partGeos();
  const M = partMats();
  const g = new THREE.Group();
  const c = { vest: vestColor, shirt: 0x1e2a3c, trousers: 0x2b3440, skin: 0xc9987a, hat: 0xf2f2f2, glove: 0x8a8a7e, boot: 0x3b2a1c };
  const J = {};
  for (const k of ['root', 'pelvis', 'waist', 'neck', 'sh', 'el', 'wr', 'hip', 'kn', 'an']) J[k] = new THREE.Matrix4();
  const add = (name, mat, ck, m) => {
    const mm = mat.clone();
    if (ck) mm.color.set(c[ck]);
    const mesh = new THREE.Mesh(G[name], mm);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(m);
    mesh.castShadow = true;
    g.add(mesh);
  };
  jointMat(J.root, J.pelvis, 0, 0.97, 0, 0, 0, 0);
  jointMat(J.pelvis, J.waist, 0, 0.05, 0, 0.03, 0, 0);
  jointMat(J.waist, J.neck, 0, 0.5, 0, 0.1, 0, 0);
  for (const [n, mk, ck] of [['pelvis', 'cloth', 'trousers']]) add(n, M[mk], ck, J.pelvis);
  add('torso', M.cloth, 'shirt', J.waist); add('vest', M.hivis, 'vest', J.waist); add('tape', M.tape, null, J.waist);
  add('head', M.skin, 'skin', J.neck); add('hat', M.hat, 'hat', J.neck);
  for (const s of [1, -1]) {
    const sh = jointMat(J.waist, new THREE.Matrix4(), 0.205 * s, 0.43, 0, 0, 0, 0.1 * s, 'XZY');
    const el = jointMat(sh, new THREE.Matrix4(), 0, -0.29, 0, -0.2, 0, 0);
    const wr = jointMat(el, new THREE.Matrix4(), 0, -0.25, 0);
    const hip = jointMat(J.pelvis, new THREE.Matrix4(), 0.095 * s, -0.03, 0);
    const kn = jointMat(hip, new THREE.Matrix4(), 0, -0.43, 0, 0.04);
    const an = jointMat(kn, new THREE.Matrix4(), 0, -0.41, 0);
    add('uarm', M.cloth, 'shirt', sh); add('farm', M.cloth, 'shirt', el); add('hand', M.glove, 'glove', wr);
    add('thigh', M.cloth, 'trousers', hip); add('shin', M.cloth, 'trousers', kn); add('boot', M.boot, 'boot', an);
  }
  g.userData.arm = g.children[6];
  return g;
}
