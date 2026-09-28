// §8.1 road → pad P1 route: ground chevrons + driver guidance.
//
// The route is the path of the steering reference point (ref = slew axis +
// x_ref·fwd, see vehicle.js), built from config ROUTE:
//   0 lane      spawn lane (z −64.25) → far lane / kerb strip (z −69.35) by x −40
//   1 turn ALL  about ICR (−37.08, −62.27) → heading +z at x −30
//   2 straight  through the gate and the wheel wash (x −30)
//   3 turn ALL  about ICR (−22.9, −43.1) → heading +x
//   4 straight  haul road z −36
//   5 turn ROAD about ICR (48.9, −27.9) → heading +z
//   6 straight  x 57 until the SLEW AXIS is on P1 (57, −12)
// Turn radii equal 1/κ_max of the named program (7.08 / 8.09 m), so a
// full-lock turn with the ref point on the chevrons follows the path exactly.
//
// buildRouteMarkers(scene, {terrain}) → {group, setVisible(v), setProgress(sRef), dispose()}
// guidance(pos, yaw, {xRef}) → {distance, text, bearingDeg, leg, s, lateral, onRoute, programHint, atTarget, next}
// routePath() → {x[], z[], s[], hx[], hz[], leg[], legs[], length (to P1), n}
// approachHold(pos, yaw) → gate traffic-hold obstacle while the crane is on the road approach, else null

import * as THREE from 'three';
import { ROUTE, P1, SPAWN, VEHICLE, AT100, CRANE_APPROACH } from './config.js';

const STEP = 0.5; // m between path samples
// S-curve span of leg 0 (into the far lane by x −40, §8.1) [E]. 30 m keeps the
// heading ≤ 15°: the front axle runs 4.3 m ahead of the ROAD ref point, and a
// shorter curve swings the front wheels over the far kerb (z −71).
const LANE_CHANGE = { x0: -72, x1: -42 };
const EXTEND = 15; // m of hidden path beyond P1 (projection when the ref point runs past it)
const ANNOUNCE = 25; // m: announce the next manoeuvre this far ahead
const LOOKAHEAD = 8; // m: bearing target ahead of the projection
const COLORS = { straight: 0x35d8ff, lane: 0x35d8ff, turn: 0xffa51f };

let PATH = null;

function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; }

function buildPath() {
  const X = [], Z = [], S = [], L = [];
  const legs = [];
  const push = (x, z, leg) => {
    const n = X.length;
    if (n) {
      const d = Math.hypot(x - X[n - 1], z - Z[n - 1]);
      if (d < 1e-6) return;
      S.push(S[n - 1] + d);
    } else S.push(0);
    X.push(x); Z.push(z); L.push(leg);
  };
  const line = (ax, az, bx, bz, leg) => {
    const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len / STEP));
    for (let i = 0; i <= n; i++) push(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n, leg);
  };
  ROUTE.legs.forEach((g, k) => {
    const s0 = S.length ? S[S.length - 1] : 0;
    if (g.kind === 'lane') {
      // start: the ROAD ref point of the spawn (slew axis + 1.27 m ahead)
      const xr = VEHICLE.programs.ROAD.xRef;
      const sx = SPAWN.x + xr * Math.cos(SPAWN.yaw), sz = SPAWN.z - xr * Math.sin(SPAWN.yaw);
      const { x0, x1 } = LANE_CHANGE;
      line(sx, sz, x0, sz, k);
      // cosine S-curve: peak curvature Δz·π²/(2·30²) = 1/36 m⁻¹, easy in the ROAD program
      const n = Math.ceil((x1 - x0) / STEP);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        push(x0 + (x1 - x0) * t, sz + (g.to.z - sz) * (1 - Math.cos(Math.PI * t)) / 2, k);
      }
      line(x1, g.to.z, g.to.x, g.to.z, k);
    } else if (g.kind === 'turn') {
      const r = Math.hypot(g.from.x - g.icr.x, g.from.z - g.icr.z);
      const a0 = Math.atan2(g.from.z - g.icr.z, g.from.x - g.icr.x);
      const sweep = wrapPi(Math.atan2(g.to.z - g.icr.z, g.to.x - g.icr.x) - a0);
      const n = Math.max(2, Math.ceil((Math.abs(sweep) * r) / STEP));
      for (let i = 0; i <= n; i++) {
        const a = a0 + (sweep * i) / n;
        push(g.icr.x + r * Math.cos(a), g.icr.z + r * Math.sin(a), k);
      }
    } else {
      line(g.from.x, g.from.z, g.to.x, g.to.z, k);
    }
    legs.push({ index: k, kind: g.kind, text: g.text, program: g.program || null, s0, s1: S[S.length - 1], radius: g.kind === 'turn' ? Math.hypot(g.from.x - g.icr.x, g.from.z - g.icr.z) : null });
  });
  const length = S[S.length - 1];
  // hidden extension past P1 along the last heading (not rendered)
  const n0 = X.length;
  const hx = X[n0 - 1] - X[n0 - 2], hz = Z[n0 - 1] - Z[n0 - 2], hl = Math.hypot(hx, hz);
  for (let i = 1; i <= EXTEND / STEP; i++) push(X[n0 - 1] + (hx / hl) * STEP * i, Z[n0 - 1] + (hz / hl) * STEP * i, legs.length - 1);
  // unit headings per sample
  const HX = [], HZ = [];
  for (let i = 0; i < X.length; i++) {
    const a = Math.max(0, i - 1), b = Math.min(X.length - 1, i + 1);
    const dx = X[b] - X[a], dz = Z[b] - Z[a], d = Math.hypot(dx, dz) || 1;
    HX.push(dx / d); HZ.push(dz / d);
  }
  return { x: X, z: Z, s: S, hx: HX, hz: HZ, leg: L, legs, length, n: X.length, nVisible: n0 };
}

/** The route polyline (ref-point path), built once from config. */
export function routePath() {
  if (!PATH) PATH = buildPath();
  return PATH;
}

// ---------------------------------------------------------------- guidance
let hintS = -1; // continuity hint: last projected s
const OUT = {
  distance: 0, text: '', bearingDeg: 0, leg: 0, s: 0, lateral: 0, onRoute: true, programHint: 'ROAD',
  atTarget: false, next: null, nextDistance: 0, overshoot: false,
};

/** Forget the projection hint (call on reset / teleport). */
export function resetGuidance() { hintS = -1; }

function project(P, x, z, hx, hz, i0, i1) {
  let best = Infinity, bi = -1, bt = 0;
  for (let i = Math.max(0, i0); i < Math.min(P.n - 1, i1); i++) {
    const ax = P.x[i], az = P.z[i], dx = P.x[i + 1] - ax, dz = P.z[i + 1] - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const ex = ax + dx * t - x, ez = az + dz * t - z;
    // distance plus a heading penalty so the start of a leg that doubles back is not chosen
    const hdot = hx * P.hx[i] + hz * P.hz[i];
    const cost = Math.hypot(ex, ez) + 4 * (1 - hdot);
    if (cost < best) { best = cost; bi = i; bt = t; }
  }
  return { i: bi, t: bt, cost: best };
}

/**
 * Driver guidance for the ROAD HUD (§8.8). Returns a SHARED object (copy what you keep).
 * @param {{x:number, z:number}} pos  slew-axis point (world)
 * @param {number} yaw                carrier yaw φ
 * @param {{xRef?:number}} [o]        vehicle.xRef (current steering program), default ROAD 1.27
 * @returns {{distance:number, text:string, bearingDeg:number, leg:number, s:number, lateral:number, onRoute:boolean,
 *   programHint:'ROAD'|'ALL', atTarget:boolean, next:string|null, nextDistance:number, overshoot:boolean}}
 *   distance = metres the slew axis still has to travel along the route to P1; bearingDeg = relative
 *   bearing of the route 8 m ahead (+ = to the right); lateral = ref-point cross-track error (+ = right).
 */
export function guidance(pos, yaw, o = {}) {
  const P = routePath();
  const xRef = o.xRef ?? VEHICLE.programs.ROAD.xRef;
  const fx = Math.cos(yaw), fz = -Math.sin(yaw);
  const rx = pos.x + xRef * fx, rz = pos.z + xRef * fz;
  // windowed search around the last projection, global when lost
  let pr = null;
  if (hintS >= 0) {
    const i = Math.round(hintS / STEP);
    pr = project(P, rx, rz, fx, fz, i - 40, i + 80);
    if (pr.cost > 6) pr = null;
  }
  if (!pr) pr = project(P, rx, rz, fx, fz, 0, P.n - 1);
  const i = pr.i, s = P.s[i] + (P.s[i + 1] - P.s[i]) * pr.t;
  hintS = s;
  const px = P.x[i] + (P.x[i + 1] - P.x[i]) * pr.t, pz = P.z[i] + (P.z[i + 1] - P.z[i]) * pr.t;
  // lateral: + = right of the path direction; heading (hx, hz) = (cos φ, −sin φ) → right = (−hz, hx)
  const hx = P.hx[i], hz = P.hz[i];
  const lateral = (rz - pz) * hx - (rx - px) * hz;
  const legIdx = P.leg[i];
  const legs = P.legs, leg = legs[legIdx], last = legIdx === legs.length - 1;
  // distance for the slew axis (xRef behind the ref point); exact along the final straight
  let distance;
  if (last) {
    const g = ROUTE.legs[legIdx], dx = g.to.x - g.from.x, dz = g.to.z - g.from.z, dl = Math.hypot(dx, dz);
    distance = ((P1.x - pos.x) * dx + (P1.z - pos.z) * dz) / dl;
  } else distance = P.length - s + xRef;
  const overshoot = distance < -P1.tolPos;
  // bearing to the lookahead point
  const sl = Math.min(s + LOOKAHEAD, P.s[P.n - 1]);
  let j = i;
  while (j < P.n - 2 && P.s[j + 1] < sl) j++;
  const tt = (sl - P.s[j]) / Math.max(1e-6, P.s[j + 1] - P.s[j]);
  const lx = P.x[j] + (P.x[j + 1] - P.x[j]) * tt - rx, lz = P.z[j] + (P.z[j + 1] - P.z[j]) * tt - rz;
  const bearingDeg = (Math.atan2(lx * -fz + lz * fx, lx * fx + lz * fz) * 180) / Math.PI; // right = (−f_z, f_x)
  // target
  const dyaw = Math.abs(wrapPi(yaw - P1.yaw)) * 180 / Math.PI;
  const dpos = Math.hypot(pos.x - P1.x, pos.z - P1.z);
  const atTarget = dpos <= P1.tolPos && dyaw <= P1.tolYawDeg;
  // text: current leg, the next manoeuvre when it is close, stop cue at the end
  const nextLeg = legs[legIdx + 1] || null;
  const nextDistance = nextLeg ? Math.max(0, nextLeg.s0 - s) : 0;
  let text = leg.text, programHint = leg.program || 'ROAD', next = null;
  if (nextLeg && nextDistance < ANNOUNCE) {
    next = nextLeg.text;
    text = `${Math.round(nextDistance)} m: ${nextLeg.text}`;
    if (nextLeg.program) programHint = nextLeg.program;
  }
  if (last) {
    if (atTarget) text = 'On P1: stop, parking brake ON (F), then Enter for SETUP';
    else if (overshoot) text = `Past P1 by ${(-distance).toFixed(1)} m: reverse (X) onto the mark`;
    else if (distance < 6) text = `Slew axis to P1: ${distance.toFixed(1)} m`;
  }
  Object.assign(OUT, {
    distance: Math.max(0, distance), text, bearingDeg, leg: legIdx, s, lateral,
    onRoute: Math.abs(lateral) <= ROUTE.width / 2, programHint, atTarget, next, nextDistance, overshoot,
  });
  return OUT;
}

// ---------------------------------------------------------------- traffic management
// §8.1 "oncoming traffic queues": the crane swings through the far lane from
// x ≈ −72 to the gate, so a banksman at the gate holds the westbound lane just
// east of it while the crane is on the approach. Without the hold, oncoming
// cars queue at the crane's nose in the middle of the lane change and block
// its path; they cannot reverse. The hold is a stopped obstacle across the
// westbound lane (centre z −67.75) at x −24..−20. It is active while the slew
// axis is in the CRANE_APPROACH area and the rear end (x_c −3.70) is still
// over the carriageway (z < −60.5). Cars already between the hold and the
// crane pass it in their own lane before it swings over.
const HOLD = Object.freeze({ x: -22, z: -67.75, hx: 2, hz: 1.75, yaw: 0, vx: 0, vz: 0 });
/**
 * Gate traffic hold for streets.traffic.setObstacles (append it to the vehicle's obstacles).
 * @param {{x:number, z:number}} pos  slew axis
 * @param {number} yaw
 * @returns {object|null}  frozen obstacle rectangle, or null when the crane is clear of the road
 */
export function approachHold(pos, yaw) {
  const a = CRANE_APPROACH;
  if (!(pos.x > a.minX && pos.x < a.maxX && pos.z > a.minZ && pos.z < a.maxZ)) return null;
  const zRear = pos.z - AT100.carrier.rearX * Math.sin(yaw); // pos + rearX·fwd, fwd.z = −sin φ
  return zRear < -60.5 ? HOLD : null;
}

// ---------------------------------------------------------------- markers
/**
 * Ground chevrons along the ref-point route (3.5 m corridor edges dashed), a
 * ring on the P1 slew-axis target and a stop bar where the front bumper
 * (x_c +7.75) ends when the slew axis is on P1. Three draw calls, unlit so
 * they read at night; hidden by default.
 * @param {THREE.Object3D} scene
 * @param {{terrain?:{heightAt(x:number,z:number):number}, spacing?:number}} [o]
 */
export function buildRouteMarkers(scene, o = {}) {
  const P = routePath();
  const hAt = (x, z) => (o.terrain?.heightAt ? o.terrain.heightAt(x, z) : 0) + 0.035;
  const group = new THREE.Group();
  group.name = 'mobileRoute';
  group.visible = false;
  const matOpts = { transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 };

  // chevrons ">" (local +x = direction of travel), 1.1 m wide
  const shape = new THREE.Shape();
  shape.moveTo(0.42, 0); shape.lineTo(-0.2, 0.55); shape.lineTo(-0.5, 0.55);
  shape.lineTo(0.12, 0); shape.lineTo(-0.5, -0.55); shape.lineTo(-0.2, -0.55); shape.closePath();
  const chevGeo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
  const spacing = o.spacing ?? 3.0;
  const marks = [];
  for (let s = 1.5; s < P.length - 0.5; s += spacing) {
    let i = Math.min(P.nVisible - 2, Math.floor(s / STEP));
    while (i < P.nVisible - 2 && P.s[i + 1] < s) i++;
    const t = (s - P.s[i]) / Math.max(1e-6, P.s[i + 1] - P.s[i]);
    const x = P.x[i] + (P.x[i + 1] - P.x[i]) * t, z = P.z[i] + (P.z[i + 1] - P.z[i]) * t;
    marks.push({ s, x, z, yaw: Math.atan2(-P.hz[i], P.hx[i]), kind: P.legs[P.leg[i]].kind });
  }
  const chev = new THREE.InstancedMesh(chevGeo, new THREE.MeshBasicMaterial({ ...matOpts, color: 0xffffff, opacity: 0.85, side: THREE.DoubleSide }), marks.length);
  chev.name = 'mobileRoute.chevrons';
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const col = new THREE.Color();
  const base = marks.map((mk, k) => {
    q.setFromAxisAngle(up, mk.yaw);
    const m = new THREE.Matrix4().compose(v.set(mk.x, hAt(mk.x, mk.z), mk.z), q, one);
    chev.setMatrixAt(k, m);
    chev.setColorAt(k, col.setHex(COLORS[mk.kind] ?? COLORS.straight));
    return m;
  });
  chev.instanceMatrix.needsUpdate = true;
  if (chev.instanceColor) chev.instanceColor.needsUpdate = true;
  chev.frustumCulled = false; // ~190 m long: one bounding sphere would be culled wrongly at the ends
  chev.renderOrder = 2;
  group.add(chev);

  // dashed corridor edges (±width/2 of the ref-point corridor)
  const hw = ROUTE.width / 2, DASH = 1.2, GAP = 1.0, W = 0.1;
  const pos = [];
  const quad = (ax, az, bx, bz, nx, nz) => {
    const y0 = hAt(ax, az), y1 = hAt(bx, bz);
    const a0 = [ax - nx * W, y0, az - nz * W], a1 = [ax + nx * W, y0, az + nz * W];
    const b0 = [bx - nx * W, y1, bz - nz * W], b1 = [bx + nx * W, y1, bz + nz * W];
    pos.push(...a0, ...b1, ...b0, ...a0, ...a1, ...b1);
  };
  for (const side of [1, -1]) {
    for (let s = 0; s < P.length; s += DASH + GAP) {
      let prev = null;
      for (let u = s; u <= Math.min(s + DASH, P.length); u += 0.4) {
        let i = Math.min(P.nVisible - 2, Math.floor(u / STEP));
        while (i < P.nVisible - 2 && P.s[i + 1] < u) i++;
        const t = (u - P.s[i]) / Math.max(1e-6, P.s[i + 1] - P.s[i]);
        const nx = -P.hz[i], nz = P.hx[i]; // right-hand normal
        const x = P.x[i] + (P.x[i + 1] - P.x[i]) * t + nx * hw * side, z = P.z[i] + (P.z[i + 1] - P.z[i]) * t + nz * hw * side;
        if (prev) quad(prev[0], prev[1], x, z, nx, nz);
        prev = [x, z];
      }
    }
  }
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const edges = new THREE.Mesh(edgeGeo, new THREE.MeshBasicMaterial({ ...matOpts, color: 0xf2f2f2, opacity: 0.55, side: THREE.DoubleSide }));
  edges.name = 'mobileRoute.edges';
  edges.frustumCulled = false;
  edges.renderOrder = 2;
  group.add(edges);

  // P1: slew-axis ring + cross, and the front-bumper stop bar (x_c +7.75 ahead on the P1 heading)
  const tgt = [];
  const ring = new THREE.RingGeometry(0.5, 0.66, 40).rotateX(-Math.PI / 2).translate(P1.x, hAt(P1.x, P1.z), P1.z);
  tgt.push(ring);
  for (const a of [0, Math.PI / 2]) tgt.push(new THREE.PlaneGeometry(1.8, 0.1).rotateX(-Math.PI / 2).rotateY(a + Math.PI / 4).translate(P1.x, hAt(P1.x, P1.z), P1.z));
  const bump = 7.75; // front bumper x_c (§1.1)
  const bx = P1.x + bump * Math.cos(P1.yaw), bz = P1.z - bump * Math.sin(P1.yaw);
  tgt.push(new THREE.PlaneGeometry(ROUTE.width, 0.3).rotateX(-Math.PI / 2).rotateY(P1.yaw + Math.PI / 2).translate(bx, hAt(bx, bz), bz));
  const tgtGeo = mergeFlat(tgt);
  const target = new THREE.Mesh(tgtGeo, new THREE.MeshBasicMaterial({ ...matOpts, color: 0xff4a3a, opacity: 0.9, side: THREE.DoubleSide }));
  target.name = 'mobileRoute.target';
  target.renderOrder = 2;
  group.add(target);

  scene.add(group);
  let lastK = -1;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  return {
    group,
    setVisible(vis) { group.visible = !!vis; },
    /** hide the chevrons the ref point has passed (sRef from guidance().s) */
    setProgress(sRef) {
      const k = Math.max(0, Math.floor((sRef - 1.5) / spacing));
      if (k === lastK) return;
      lastK = k;
      base.forEach((m, n) => chev.setMatrixAt(n, n < k ? zero : m));
      chev.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      scene.remove(group);
      for (const m of [chev, edges, target]) { m.geometry.dispose(); m.material.dispose(); }
    },
  };
}

// merge non-indexed position-only geometries (small, build time only)
function mergeFlat(geos) {
  const pos = [];
  for (const g of geos) {
    const gg = g.index ? g.toNonIndexed() : g;
    pos.push(...gg.attributes.position.array);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return out;
}
