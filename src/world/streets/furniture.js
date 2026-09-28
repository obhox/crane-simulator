import * as THREE from 'three';
import { rng } from '../../util/math.js';
import { model, pbrMaterial } from '../assets.js';
import {
  GeoBuilder, M, blockEdges, edgePoint, edgeYaw, blocked, BUS_STOPS, CURB_Y, ROAD_Y, HALF_ROAD, OUTER,
  sortedX, sortedZ, radialTexture, canvasTexture, instancedProps,
} from './common.js';
import * as PR from './props.js';
import { SIGN, signAtlas, plateGeometry } from './signs.js';
import { GlowPoints, LightPools } from './lights.js';

// Street furniture laid out along every block edge (sidewalk) of the road
// grid: LED street lights (≈30 m apart, staggered, 8.3 m mounting height —
// spacing ≈ 3.5 × height as in EN 13201 urban layouts), signal assemblies with
// mast arms at every junction near the site, road signs, bus shelters,
// benches, bins, bollards, hydrants, tree pits, pay stations, planters,
// utility cabinets and manhole covers. Sidewalk zones (from the curb): 0.3–
// 1.9 m furniture strip, 2.0–3.4 m pedestrian through-zone.

const R_LIGHTS = 470; // street lights everywhere (night skyline)
const R_PROPS = 330; // small furniture only near the site
const R_SIGNALS = 360;
const O = (d) => HALF_ROAD + d; // offset from the road centre for a distance d from the curb

export function buildFurniture(root, quality, signals, sharedPlan) {
  const r = rng(8080);
  const low = quality.name === 'low';
  const mat = PR.propMaterial();
  const inst = new Map(); // name → { geo, list: [Matrix4] }
  const place = (name, geoFn, x, y, z, yaw = 0, s = 1) => {
    if (!inst.has(name)) inst.set(name, { geoFn, list: [] });
    inst.get(name).list.push(M(x, y, z, 0, yaw, 0, s));
  };

  const plan = sharedPlan; // lamps / trees / idle spots shared with other modules
  const edges = blockEdges(R_LIGHTS);

  // ---------------------------------------------------------------- per-edge occupancy
  const occ = new Map();
  const taken = (e, t, half) => (occ.get(e) || []).some(([u, h]) => Math.abs(u - t) < h + half);
  const take = (e, t, half) => { if (!occ.has(e)) occ.set(e, []); occ.get(e).push([t, half]); };
  const edgeDist = (e) => {
    const t = Math.max(e.a, Math.min(e.b, 0));
    const [x, z] = edgePoint(e, t, O(1));
    return Math.hypot(x, z);
  };
  const isFrontage = (e) => e.axis === 'x' && e.c === -66 && e.side === 1;
  const trafficDir = (e) => (e.axis === 'x' ? e.side : -e.side);

  // ---------------------------------------------------------------- bus stops
  const shelterGeo = PR.shelterGeo();
  const shelters = [];
  for (const bs of BUS_STOPS) {
    const e = edges.find((q) => q.axis === bs.axis && q.c === bs.c && q.side === bs.side && bs.at > q.a && bs.at < q.b);
    if (!e) continue;
    const yaw = edgeYaw(e);
    const [x, z] = edgePoint(e, bs.at, O(0.5 + 0.72)); // open side to the road, back 1.95 m from the curb
    shelters.push(M(x, CURB_Y, z, 0, yaw, 0));
    take(e, bs.at, 2.6);
    const dir = trafficDir(e);
    const [px, pz] = edgePoint(e, bs.at + dir * 4.2, O(0.45));
    place('stopPole', PR.stopPoleGeo, px, CURB_Y, pz, yaw);
    plan.signs.push({ x: px, z: pz, y: CURB_Y + 2.55, yaw, kind: 'square', cell: SIGN.bus, w: 0.45, pole: false });
    take(e, bs.at + dir * 4.2, 0.6);
    const [bx, bz] = edgePoint(e, bs.at - dir * 3.4, O(0.5));
    place('bin', PR.binGeo, bx, CURB_Y, bz, yaw);
    take(e, bs.at - dir * 3.4, 0.5);
    plan.busStops.push({ x, z, yaw, e, t: bs.at });
  }

  // ---------------------------------------------------------------- street lights
  const lamps = [];
  for (const e of edges) {
    const phase = e.side > 0 ? 0 : 15;
    const dist = edgeDist(e);
    for (let t = Math.ceil((e.a + 4 - phase) / 30) * 30 + phase; t < e.b - 4; t += 30) {
      let tt = t;
      if (taken(e, tt, 0.4)) tt += 3.2;
      const [x, z] = edgePoint(e, tt, O(0.55));
      if (blocked(x, z, 0.5) || taken(e, tt, 0.4)) continue;
      take(e, tt, 0.4);
      lamps.push({ x, z, yaw: edgeYaw(e), e, t: tt, near: dist < 260 });
    }
  }
  plan.lamps = lamps;

  // ---------------------------------------------------------------- signal assemblies
  const vehLens = []; // { m: Matrix4, node, axis, idx }
  const pedLens = [];
  const sigNodes = signals.nodes.filter((n) => Math.hypot(n.x, n.z) < R_SIGNALS);
  for (const n of sigNodes) {
    const mast = Math.hypot(n.x, n.z) < 260;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      // approach travelling (dx, dz): post on the right-hand corner before the stop line
      const rx = -dz, rz = dx;
      const x = n.x - dx * 9.35 + rx * O(0.55), z = n.z - dz * 9.35 + rz * O(0.55);
      if (blocked(x, z, 0.5)) continue;
      const yaw = Math.atan2(-dx, -dz); // local +z → towards the approaching traffic
      const m = M(x, CURB_Y, z, 0, yaw, 0);
      const name = mast ? 'signalMast' : 'signalPost';
      if (!inst.has(name)) inst.set(name, { geoFn: () => PR.signalPostGeo(mast), list: [] });
      inst.get(name).list.push(m);
      const axis = dx !== 0 ? 'x' : 'z';
      const heads = [PR.SIG.postHead];
      if (mast) heads.push(PR.SIG.mastHead);
      for (const h of heads) {
        PR.SIG.lenses(...h).forEach((p, idx) => vehLens.push({ m: m.clone().multiply(M(p[0], p[1], p[2])), node: n, axis, idx }));
      }
      const [px, py, pz] = PR.SIG.ped;
      for (const [dy, walk] of [[0.14, false], [-0.14, true]]) {
        pedLens.push({ m: m.clone().multiply(M(px - 0.105, py + dy, pz, 0, -Math.PI / 2, 0)), node: n, axis: axis === 'x' ? 'z' : 'x', walk });
      }
    }
    // street-name signs on two corners
    if (Math.hypot(n.x, n.z) < R_PROPS) {
      for (const [sx, sz] of [[1, 1], [-1, -1]]) {
        const x = n.x + sx * O(3.2), z = n.z + sz * O(3.2);
        if (blocked(x, z, 0.5)) continue;
        place('namePost', () => PR.signPostGeo(2.9), x, CURB_Y, z);
        const iz = sortedZ.indexOf(n.z), ix = sortedX.indexOf(n.x);
        plan.signs.push({ x: x - sx * 0.02, z, y: CURB_Y + 2.75, yaw: 0, kind: 'rect', cell: SIGN.street0 + (Math.abs(iz) % 2), w: 0.95, h: 0.22, pole: false });
        plan.signs.push({ x, z: z - sz * 0.02, y: CURB_Y + 2.5, yaw: Math.PI / 2, kind: 'rect', cell: SIGN.street0 + 2 + (Math.abs(ix) % 2), w: 0.95, h: 0.22, pole: false });
      }
    }
  }

  // ---------------------------------------------------------------- per-edge props
  const trees = [];
  for (const e of edges) {
    const dist = edgeDist(e);
    const yaw = edgeYaw(e);
    const dir = trafficDir(e);
    const front = isFrontage(e);
    const at = (t, d) => edgePoint(e, t, O(d));
    const ok = (t, d, half) => {
      if (t < e.a + half || t > e.b - half) return false;
      const [x, z] = at(t, d);
      return !blocked(x, z, 0.6) && !taken(e, t, half);
    };
    // corner bollards protecting the crossing
    if (dist < R_PROPS && !low) {
      for (const [end, s] of [[e.a, 1], [e.b, -1]]) {
        if ((s > 0 && !e.junctionA) || (s < 0 && !e.junctionB)) continue;
        if (s === -dir) continue; // the approach end carries the signal post
        for (const k of [0.6, 1.9]) {
          const t = end + s * k;
          if (!ok(t, 0.35, 0.1)) continue;
          const [x, z] = at(t, 0.35);
          place('bollard', PR.bollardGeo, x, CURB_Y, z);
        }
      }
    }
    // trees: most streets near the site are tree-lined (not the site frontage)
    const treeLined = !front && (r() < 0.72 || dist < 140) && dist < 430;
    if (treeLined) {
      const spacing = 9 + r() * 3;
      for (let t = e.a + 6 + r() * 3; t < e.b - 5; t += spacing) {
        if (!ok(t, 1.2, 3.2)) continue;
        const [x, z] = at(t, 1.2);
        take(e, t, 1.0);
        trees.push({ x, z, dist: Math.hypot(x, z), e, t });
        if (dist < R_PROPS) place('treePit', PR.treePitGeo, x, CURB_Y, z, yaw);
      }
    }
    if (dist > R_PROPS) continue;
    // hydrant near the start of the block
    if (e.len > 30) {
      for (const t of [e.a + 11, e.a + 15, e.b - 12]) {
        if (!ok(t, 0.45, 0.6)) continue;
        const [x, z] = at(t, 0.45);
        place('hydrant', PR.hydrantGeo, x, CURB_Y, z, yaw + Math.PI / 2);
        take(e, t, 0.6);
        break;
      }
    }
    // bins near both ends
    for (const t of [e.a + 4.2, e.b - 4.2]) {
      if (!ok(t, 0.5, 0.5)) continue;
      const [x, z] = at(t, 0.5);
      place('bin', PR.binGeo, x, CURB_Y, z, yaw);
      take(e, t, 0.5);
    }
    // benches between some trees, facing the building frontages
    if (treeLined && !low) {
      for (let t = e.a + 20; t < e.b - 20; t += 35 + r() * 25) {
        if (!ok(t, 1.2, 1.2)) continue;
        const [x, z] = at(t, 1.25);
        place('bench', PR.benchGeo, x, CURB_Y, z, yaw + Math.PI);
        take(e, t, 1.1);
        plan.idle.push({ x, z, yaw: yaw + Math.PI, kind: 'bench' });
      }
    }
    // pay-and-display machines on parking streets
    if (!front && e.len > 50) {
      for (let t = e.a + 25 + r() * 10; t < e.b - 20; t += 60 + r() * 20) {
        if (!ok(t, 0.45, 0.4)) continue;
        const [x, z] = at(t, 0.45);
        place('payStation', PR.payStationGeo, x, CURB_Y, z, yaw);
        take(e, t, 0.4);
      }
    }
    // utility cabinet at the back of the sidewalk near some corners
    if (e.junctionA && r() < 0.35) {
      const t = e.a + 2.8;
      const [x, z] = at(t, 3.25);
      if (!blocked(x, z, 1)) plan.cabinets.push({ x, z, yaw: yaw + Math.PI });
    }
    // speed limit sign ~14 m after the junction, facing the traffic on this side
    if (r() < 0.55 && e.len > 40) {
      const t = dir > 0 ? e.a + 14 : e.b - 14;
      if (ok(t, 0.35, 0.3)) {
        const [x, z] = at(t, 0.35);
        const art = (e.axis === 'x' && e.c === -66) || (e.axis === 'z' && (e.c === -100 || e.c === 110));
        plan.signs.push({ x, z, y: CURB_Y + 2.3, yaw: faceTraffic(e), kind: 'disc', cell: art ? SIGN.speed50 : SIGN.speed30, w: 0.6, pole: true });
        take(e, t, 0.3);
      }
    }
    // parking sign near the start of some parking edges
    if (!front && r() < 0.3 && e.len > 60) {
      const t = dir > 0 ? e.a + 24 : e.b - 24;
      if (ok(t, 0.35, 0.3)) {
        const [x, z] = at(t, 0.35);
        plan.signs.push({ x, z, y: CURB_Y + 2.2, yaw: faceTraffic(e), kind: 'square', cell: SIGN.parking, w: 0.5, pole: true });
        take(e, t, 0.3);
      }
    }
    // site frontage: no-stopping signs + site entrance warnings (outside the gate apron)
    if (front) {
      for (let t = -56; t < 66; t += 38) {
        if (!ok(t, 0.35, 0.3)) continue;
        const [x, z] = at(t, 0.35);
        plan.signs.push({ x, z, y: CURB_Y + 2.3, yaw: faceTraffic(e), kind: 'disc', cell: SIGN.noStopping, w: 0.6, pole: true });
        take(e, t, 0.3);
      }
      for (const t of [-45, -15]) {
        if (!ok(t, 0.35, 0.3)) continue;
        const [x, z] = at(t, 0.35);
        plan.signs.push({ x, z, y: CURB_Y + 1.9, yaw: faceTraffic(e), kind: 'square', cell: SIGN.siteEntrance, w: 0.7, pole: true });
        take(e, t, 0.3);
      }
    }
    // planters along the boulevard opposite the site
    if (e.axis === 'x' && e.c === -66 && e.side === -1) {
      for (let t = -86; t < 96; t += 17) {
        if (!ok(t, 1.2, 1.1)) continue;
        const [x, z] = at(t, 1.2);
        plan.planters.push({ x, z, yaw });
        take(e, t, 1.0);
      }
    }
  }
  // road-works warnings ahead of the site on the main road
  for (const [x, side, yawDir] of [[-84, 1, 1], [92, -1, -1]]) {
    const z = -66 + side * O(0.35);
    plan.signs.push({ x, z, y: CURB_Y + 2.1, yaw: yawDir > 0 ? -Math.PI / 2 : Math.PI / 2, kind: 'tri', cell: SIGN.roadWorks, w: 0.75, pole: true });
  }
  plan.trees = trees;

  // ---------------------------------------------------------------- instanced props
  const meshes = [];
  // shadow casters only within shadowR of the site, quadrant-chunked (see instancedProps)
  const shadowR = low ? 0 : quality.name === 'medium' ? 110 : 150;
  const addInst = (geo, material, list, { cast = true, name } = {}) => {
    const ms = instancedProps(root, geo, material, list, { name, cast, shadowR });
    meshes.push(...ms);
    return ms;
  };
  // tiny / flat props never cast (sub-texel shadows, pure shadow-pass cost)
  const NO_CAST = ['treePit', 'bollard', 'payStation', 'stopPole', 'namePost'];
  for (const [name, { geoFn, list }] of inst) addInst(geoFn(), mat, list, { name, cast: !NO_CAST.includes(name) });
  // street lights: detailed near, simple far
  const nearL = [], farL = [];
  for (const l of lamps) (l.near ? nearL : farL).push(M(l.x, CURB_Y, l.z, 0, l.yaw, 0));
  addInst(PR.streetLightGeo(0), mat, nearL, { name: 'lampsNear' });
  addInst(PR.streetLightGeo(1), mat, farL, { name: 'lampsFar', cast: false });
  // bus shelters (+ glass)
  addInst(shelterGeo.frame, mat, shelters, { name: 'shelter' });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xa9b8bc, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false, envMapIntensity: 1.4,
  });
  for (const g of addInst(shelterGeo.glass, glassMat, shelters, { name: 'shelterGlass', cast: false })) g.renderOrder = 2;
  // back-lit posters in the advert boxes (generic, fictional)
  let posterMat = null;
  if (shelters.length) {
    const pb = new GeoBuilder({});
    shelters.forEach((m, i) => {
      for (const [side, cell] of [[1, i % 2], [-1, (i + 1) % 2]]) {
        const g = new THREE.PlaneGeometry(1.02, 1.58);
        const uv = g.attributes.uv;
        for (let k = 0; k < uv.count; k++) uv.setX(k, (uv.getX(k) + cell) / 2);
        g.rotateY(side * Math.PI / 2);
        g.translate(-2.15 + side * 0.078, 1.22, -0.05);
        pb.add(g, m);
      }
    });
    posterMat = new THREE.MeshStandardMaterial({ map: posterTexture(), emissiveMap: posterTexture(), emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 0.12 });
    const pm = new THREE.Mesh(pb.build(), posterMat);
    pm.name = 'streets.posters';
    root.add(pm);
  }

  // ---------------------------------------------------------------- signs
  if (plan.signs.length) {
    const b = new GeoBuilder({});
    const posts = [];
    for (const s of plan.signs) {
      const m = M(s.x, s.y, s.z, 0, s.yaw, 0);
      const [f, bk] = plateGeometry(s.kind, s.cell, s.w, s.h ?? s.w);
      const off = M(0, 0, 0.045);
      b.add(f, m.clone().multiply(off));
      b.add(bk, m.clone().multiply(off));
      if (s.pole) posts.push(M(s.x, CURB_Y, s.z));
    }
    const signMat = new THREE.MeshStandardMaterial({ map: signAtlas(), roughness: 0.5, metalness: 0.05, side: THREE.FrontSide });
    const sm = new THREE.Mesh(b.build(), signMat);
    sm.castShadow = true;
    sm.receiveShadow = true;
    sm.name = 'streets.signs';
    root.add(sm);
    addInst(PR.signPostGeo(2.6), mat, posts, { name: 'signPosts' });
  }

  // ---------------------------------------------------------------- CC0 models
  // utility cabinets
  const cab = model('utility_box');
  // the scanned cabinet is 6k triangles: only the ones near the site
  plan.cabinets.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  plan.cabinets.length = Math.min(plan.cabinets.length, low ? 4 : 12);
  if (cab && plan.cabinets.length) {
    cab.traverse((o) => {
      if (!o.isMesh) return;
      o.updateWorldMatrix(true, false);
      addInst(o.geometry.clone().applyMatrix4(o.matrixWorld), o.material, plan.cabinets.map((c) => M(c.x, CURB_Y, c.z, 0, c.yaw, 0)), { name: 'cabinets' });
    });
  }
  // planters with shrubs
  if (plan.planters.length) {
    addInst(PR.planterGeo(), mat, plan.planters.map((p) => M(p.x, CURB_Y, p.z, 0, p.yaw, 0)), { name: 'planters' });
    // mixed planting: one taller shrub in the middle, low leafy perennials
    // around it (a single sparse shrub read as a bare twig from the street)
    const pm = plan.planters.map((p) => M(p.x, CURB_Y, p.z, 0, p.yaw, 0));
    const shrub = model('shrubs_large', { part: 'shrub_02_c' });
    if (shrub) {
      shrub.updateMatrixWorld(true);
      shrub.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        addInst(g, o.material, pm.map((m, i) => m.clone().multiply(M(0.1, 0.62, 0, 0, i * 2.1, 0, 0.72))), { name: 'planterShrubs' });
      });
    }
    // clipped evergreen mound filling the box (lumpy, leaf-textured) — the
    // CC0 shrub alone is too open to read as planting from the street/cab
    const mound = new THREE.IcosahedronGeometry(1, 3);
    const mp = mound.attributes.position;
    for (let i = 0; i < mp.count; i++) {
      const x = mp.getX(i), y = mp.getY(i), z = mp.getZ(i);
      const n = 1 + 0.07 * Math.sin(x * 9.1 + z * 4.3) * Math.sin(y * 7.7 + x * 3.1) + 0.05 * Math.sin(z * 13 + y * 5);
      mp.setXYZ(i, x * n * 0.86, Math.max(0, y) * n * 0.42, z * n * 0.37);
    }
    mound.computeVertexNormals();
    const moundMat = pbrMaterial('grass', { repeat: [5, 2.5], color: 0x7f9a62, normalScale: 1.4, roughness: 1.05 });
    addInst(mound, moundMat, pm.map((m, i) => m.clone().multiply(M(0, 0.6, 0, 0, (i % 2) * Math.PI, 0))), { name: 'planterMounds' });
  }
  // manhole covers on the carriageways near the site (low-poly disc with the scanned cover material)
  const mh = model('manhole_cover');
  if (mh) {
    let coverMat = null;
    mh.traverse((o) => { if (o.isMesh && !coverMat) coverMat = o.material; });
    if (coverMat) {
      const m2 = coverMat.clone();
      m2.polygonOffset = true; m2.polygonOffsetFactor = -2; m2.polygonOffsetUnits = -2;
      const disc = new THREE.CircleGeometry(0.34, 20).rotateX(-Math.PI / 2);
      const uv = disc.attributes.uv; // the cover texture's disc occupies the whole atlas square
      for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5 + (uv.getX(i) - 0.5) * 0.98, 0.5 + (uv.getY(i) - 0.5) * 0.98);
      const list = [];
      for (const c of sortedZ) for (let x = -300; x <= 300; x += 37 + Math.floor(r() * 20)) {
        if (sortedX.some((q) => Math.abs(q - x) < 12)) continue;
        list.push(M(x, ROAD_Y + 0.012, c + (r() < 0.5 ? 1 : -1) * (r() < 0.5 ? 0 : 1.75), 0, r() * 6, 0));
      }
      for (const c of sortedX) for (let z = -300; z <= 300; z += 37 + Math.floor(r() * 20)) {
        if (sortedZ.some((q) => Math.abs(q - z) < 12)) continue;
        list.push(M(c + (r() < 0.5 ? 1 : -1) * (r() < 0.5 ? 0 : 1.75), ROAD_Y + 0.012, z, 0, r() * 6, 0));
      }
      addInst(disc, m2, list, { name: 'manholes', cast: false });
    }
  }

  // ---------------------------------------------------------------- signal lenses
  const lensTex = lensTexture();
  const lensMat = new THREE.MeshBasicMaterial({ map: lensTex, toneMapped: true });
  const lensGeo = new THREE.CircleGeometry(0.1, 16);
  const vehLensMesh = new THREE.InstancedMesh(lensGeo, lensMat, Math.max(1, vehLens.length));
  vehLens.forEach((l, i) => vehLensMesh.setMatrixAt(i, l.m));
  vehLensMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, vehLens.length) * 3), 3);
  vehLensMesh.count = vehLens.length;
  vehLensMesh.computeBoundingSphere();
  vehLensMesh.name = 'streets.signalLenses';
  root.add(vehLensMesh);
  const pedGeo = new THREE.PlaneGeometry(0.2, 0.2);
  const pedMeshes = {};
  for (const walk of [false, true]) {
    const list = pedLens.filter((p) => p.walk === walk);
    const m = new THREE.InstancedMesh(pedGeo, new THREE.MeshBasicMaterial({ map: pedTexture(walk) }), Math.max(1, list.length));
    list.forEach((p, i) => m.setMatrixAt(i, p.m));
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, list.length) * 3), 3);
    m.count = list.length;
    m.computeBoundingSphere();
    m.name = `streets.pedLens${walk ? 'Walk' : 'Stop'}`;
    root.add(m);
    pedMeshes[walk] = { mesh: m, list };
  }
  const sigGlow = new GlowPoints(root, vehLens.length + pedLens.length + 8, { minPx: 1.6 });
  const LIT = [[5.0, 0.16, 0.06], [5.0, 2.0, 0.06], [0.2, 4.2, 2.2]];
  const OFF = [[0.05, 0.008, 0.006], [0.05, 0.03, 0.004], [0.006, 0.04, 0.025]];
  let lastVersion = -1;
  const _p = new THREE.Vector3();
  function paintLenses(night) {
    sigGlow.begin();
    const boost = 1 + night * 0.2;
    vehLens.forEach((l, i) => {
      const st = signals.state(l.node, l.axis); // 0 g, 1 a, 2 r
      const lit = (l.idx === 0 && st === 2) || (l.idx === 1 && st === 1) || (l.idx === 2 && st === 0);
      const c = lit ? LIT[l.idx] : OFF[l.idx];
      vehLensMesh.instanceColor.setXYZ(i, c[0] * boost, c[1] * boost, c[2] * boost);
      if (lit) {
        _p.setFromMatrixPosition(l.m);
        sigGlow.push(_p.x, _p.y, _p.z, c[0] / 5, c[1] / 5, c[2] / 5, 0.9, 1.2 + night * 1.5);
      }
    });
    vehLensMesh.instanceColor.needsUpdate = true;
    for (const walk of [false, true]) {
      const { mesh, list } = pedMeshes[walk];
      list.forEach((p, i) => {
        const w = signals.walk(p.node, p.axis);
        const lit = walk ? (w === 0 || (w === 1 && (Math.floor(signals.t * 2) & 1) === 0)) : w === 2;
        const c = walk ? (lit ? [0.4, 4.0, 2.4] : [0.01, 0.03, 0.02]) : (lit ? [5.0, 0.6, 0.1] : [0.04, 0.01, 0.005]);
        mesh.instanceColor.setXYZ(i, c[0], c[1], c[2]);
      });
      mesh.instanceColor.needsUpdate = true;
    }
    sigGlow.end();
  }

  // ---------------------------------------------------------------- night lighting
  const lampGlow = new GlowPoints(root, lamps.length, { minPx: 2.4, dynamic: false });
  const pools = new LightPools(root, lamps.length * 2);
  const warm = [1.0, 0.86, 0.68], cool = [1.0, 0.93, 0.82];
  for (const l of lamps) {
    const e = l.e;
    const tint = l.near ? cool : (r() < 0.25 ? [1.0, 0.72, 0.42] : warm);
    l.tint = tint;
    // lamp head position (reach towards the road)
    const [hx, hz] = edgePoint(e, l.t, O(0.55) - PR.LAMP.reach);
    lampGlow.push(hx, CURB_Y + PR.LAMP.height - 0.05, hz, tint[0], tint[1], tint[2], 0.9, 2.2);
    const [ax, az] = e.axis === 'x' ? [1, 0] : [0, 1];
    // carriageway part
    const [rx, rz] = edgePoint(e, l.t, 0);
    const [cw, cd] = e.axis === 'x' ? [34, 10.2] : [10.2, 34];
    const road = tint.map((c) => c * 0.06), pave = tint.map((c) => c * 0.15); // × surface albedo
    pools.add(rx, ROAD_Y + 0.02, rz, cw, cd, hx, hz, ax, az, 17, 11, road);
    // sidewalk part on the lamp's side
    const [sx, sz] = edgePoint(e, l.t, O(1.75));
    const [sw, sd] = e.axis === 'x' ? [34, 3.6] : [3.6, 34];
    pools.add(sx, CURB_Y + 0.015, sz, sw, sd, hx, hz, ax, az, 17, 11, pave);
  }
  lampGlow.end();
  pools.finish();

  return {
    meshes, lamps, trees, plan,
    update(dt, night) {
      mat.userData.uniforms.uNight.value = night > 0.15 ? Math.min(1, (night - 0.15) / 0.5) : 0;
      if (signals.version !== lastVersion) { lastVersion = signals.version; paintLenses(night); }
      lampGlow.uniforms.uGain.value = night > 0.15 ? Math.min(1, (night - 0.15) / 0.5) : 0;
      lampGlow.points.visible = night > 0.15;
      pools.setNight(night);
      sigGlow.uniforms.uGain.value = 0.35 + night * 0.9;
      if (posterMat) posterMat.emissiveIntensity = 0.4 + night * 1.6;
    },
  };

  function faceTraffic(e) {
    // plate front (+z local) faces the drivers approaching on this side
    const d = trafficDir(e);
    return e.axis === 'x' ? (d > 0 ? -Math.PI / 2 : Math.PI / 2) : (d > 0 ? Math.PI : 0);
  }
}

// Two back-lit poster designs (fictional events; no real brands)
let _poster = null;
function posterTexture() {
  if (_poster) return _poster;
  _poster = canvasTexture(1024, 800, (c) => {
    const font = (w, px) => `${w} ${px}px "Helvetica Neue", Arial, sans-serif`;
    // 1: museum exhibition
    let g = c.createLinearGradient(0, 0, 0, 800);
    g.addColorStop(0, '#12324a'); g.addColorStop(1, '#0a1622');
    c.fillStyle = g; c.fillRect(0, 0, 512, 800);
    c.fillStyle = '#e8a33d'; c.beginPath(); c.arc(256, 300, 170, 0, 7); c.fill();
    c.fillStyle = '#d0452f'; c.fillRect(120, 330, 272, 200);
    c.fillStyle = '#f2ede2'; c.beginPath(); c.moveTo(256, 150); c.lineTo(400, 420); c.lineTo(112, 420); c.closePath(); c.globalAlpha = 0.85; c.fill(); c.globalAlpha = 1;
    c.fillStyle = '#f2ede2'; c.textAlign = 'center';
    c.font = font('bold', 54); c.fillText('FORM & LIGHT', 256, 620);
    c.font = font('normal', 28); c.fillText('MODERN ART EXHIBITION', 256, 668);
    c.font = font('normal', 22); c.fillStyle = '#9fb3c2'; c.fillText('CITY GALLERY  ·  OPEN DAILY', 256, 730);
    // 2: summer concerts
    g = c.createLinearGradient(512, 0, 1024, 800);
    g.addColorStop(0, '#f6c34a'); g.addColorStop(0.55, '#ef6f3c'); g.addColorStop(1, '#7b2a58');
    c.fillStyle = g; c.fillRect(512, 0, 512, 800);
    c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 6;
    for (let i = 0; i < 7; i++) { c.beginPath(); c.arc(768, 330, 60 + i * 30, Math.PI * 1.1, Math.PI * 1.9); c.stroke(); }
    c.fillStyle = '#fff8ea'; c.textAlign = 'center';
    c.font = font('bold', 60); c.fillText('SUMMER', 768, 560);
    c.font = font('bold', 60); c.fillText('SOUNDS', 768, 622);
    c.font = font('normal', 26); c.fillText('FREE CONCERTS IN THE PARK', 768, 680);
    c.font = font('normal', 22); c.fillText('EVERY FRIDAY  ·  8 PM', 768, 730);
  });
  return _poster;
}

// LED signal lens: fine dot matrix under a fresnel ring (white; tinted by instance colour)
function lensTexture() {
  return canvasTexture(64, 64, (c, w) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, w);
    const g = c.createRadialGradient(32, 32, 2, 32, 32, 32);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.75, '#d8d8d8'); g.addColorStop(1, '#7a7a7a');
    c.fillStyle = g; c.beginPath(); c.arc(32, 32, 32, 0, 7); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.35)';
    for (let y = 3; y < 64; y += 5) for (let x = 3 + ((y / 5) % 2) * 2.5; x < 64; x += 5) { c.beginPath(); c.arc(x, y, 1.1, 0, 7); c.fill(); }
    c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 1;
    for (let rr = 8; rr < 32; rr += 7) { c.beginPath(); c.arc(32, 32, rr, 0, 7); c.stroke(); }
  });
}

// pedestrian signal symbols (white on black; tinted red / green by instance colour)
function pedTexture(walk) {
  return canvasTexture(64, 64, (c) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#fff'; c.strokeStyle = '#fff'; c.lineCap = 'round';
    c.beginPath(); c.arc(32, 12, 5, 0, 7); c.fill();
    c.lineWidth = 7;
    if (walk) {
      c.beginPath(); c.moveTo(31, 20); c.lineTo(29, 38); c.stroke();
      c.lineWidth = 5;
      c.beginPath(); c.moveTo(29, 38); c.lineTo(21, 56); c.moveTo(29, 38); c.lineTo(39, 55); c.stroke();
      c.beginPath(); c.moveTo(30, 23); c.lineTo(20, 34); c.moveTo(30, 23); c.lineTo(41, 31); c.stroke();
    } else {
      c.beginPath(); c.moveTo(32, 20); c.lineTo(32, 40); c.stroke();
      c.lineWidth = 5;
      c.beginPath(); c.moveTo(29, 40); c.lineTo(29, 58); c.moveTo(35, 40); c.lineTo(35, 58); c.stroke();
      c.beginPath(); c.moveTo(27, 22); c.lineTo(25, 40); c.moveTo(37, 22); c.lineTo(39, 40); c.stroke();
    }
  });
}

export { radialTexture };
