// WP-MODEL regression (copied into the suite by WP0-INT Phase 2): model parts, draw-call budget,
// head point vs boom.headLocal, luff rod eye vs cylB, floats on P1, hook-block falls.
// Node smoke test for src/mobile/model.js + hookBlocks.js (canvas stubbed).
// Run from the repo root: node <this file>
const noop = () => {};
const ctx2d = new Proxy({}, {
  get: (t, k) => {
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: noop });
    if (k === 'getImageData' || k === 'createImageData') return (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    return t[k] ?? noop;
  },
  set: (t, k, v) => { t[k] = v; return true; },
});
globalThis.document = { createElement: () => ({ width: 1, height: 1, getContext: () => ctx2d, style: {} }) };
globalThis.window = globalThis;

const root = process.cwd();
const THREE = await import(root + '/node_modules/three/build/three.module.js');
const { createCraneMaterials } = await import(root + '/src/crane/model.js');
const { buildMobileCrane, SECTION, HEAD_X } = await import(root + '/src/mobile/model.js');
const { buildMobileHookBlock, blockFallPoints } = await import(root + '/src/mobile/hookBlocks.js');
const { headLocal, cylB, cylLen } = await import(root + '/src/mobile/boom.js');
const { AT100, FLOATS, P1, carrierToWorld, HOOK_BLOCKS, VEHICLE } = await import(root + '/src/mobile/config.js');

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const mats = createCraneMaterials();
const t0 = performance.now();
const parts = buildMobileCrane(mats);
console.log(`build ${(performance.now() - t0).toFixed(0)} ms`);

// interface keys (work package)
for (const k of ['root', 'carrier', 'wheels', 'beams', 'jacks', 'floats', 'matSlots', 'upper', 'craneCab', 'driverCab', 'boomPivot', 'sections', 'head', 'luffCyl', 'cwSlabs', 'deckSlabs', 'bumperAnchor', 'lights', 'cameraMounts']) ok(parts[k] !== undefined, `parts.${k}`);
ok(parts.wheels.length === 5 && parts.wheels.every((a) => a.length === 2 && a[0].spin && a[1].steer), 'wheels[5][2] {steer, spin}');
ok(parts.craneCab.leftStick && parts.craneCab.rightStick && parts.craneCab.screen?.material?.map, 'craneCab sticks + screen');
ok(parts.head.sheave && parts.head.anemometer && parts.head.headCamMount, 'head sheave/anemometer/headCamMount');
ok(parts.luffCyl.barrel && parts.luffCyl.rod, 'luffCyl barrel/rod');
ok(['A', 'B', 'C'].every((k) => parts.cwSlabs[k] && parts.deckSlabs[k]), 'cwSlabs/deckSlabs A B C');
ok(parts.cameraMounts.craneEye && parts.cameraMounts.driverEye, 'camera mounts');

// draw calls: visible meshes on the hi LOD level, one per material group
function drawCalls(obj) {
  let n = 0;
  obj.traverse((o) => {
    if (!(o.isMesh)) return;
    for (let p = o; p; p = p.parent) { if (p.isLOD && !(p.levels[0].object === o || isAncestor(p.levels[0].object, o))) return; }
    n += Array.isArray(o.material) ? o.geometry.groups.length : 1;
  });
  return n;
}
function isAncestor(a, o) { for (let p = o; p; p = p.parent) if (p === a) return true; return false; }
const dc = drawCalls(parts.root);
ok(dc <= 70, `draw calls (near) ${dc} <= 70`);
let tris = 0; parts.root.traverse((o) => { if (o.isMesh) { const g = o.geometry; const t = (g.index ? g.index.count : g.attributes.position.count) / 3; tris += o.isInstancedMesh ? t * o.count : t; } });
console.log('triangles (all LOD levels, instanced expanded):', Math.round(tris));

// carrier at P1, set up, and a working pose; check the head point against §3.1
const lift = 0.10;
parts.setCarrierPose(P1.x, lift, P1.z, P1.yaw, 0, 0);
for (const [psiDeg, thDeg, ext, dv, dl] of [[0, 0, [0, 0, 0, 0, 0], 0, 0], [30, 55, [0.46, 0.46, 0.46, 0.46, 0.46], 0, 0], [-120, 70, [1, 1, 1, 1, 1], 1.0, 0.3], [90, -1, [0, 0, 0, 0.92, 1], 0.2, -0.2]]) {
  const psi = psiDeg * Math.PI / 180, th = thDeg * Math.PI / 180;
  const p = parts.pFromExt(ext);
  parts.setSlew(psi);
  parts.setBoom(th, p, dv, dl);
  parts.root.updateMatrixWorld(true);
  const L = HEAD_X + p[5];
  const h = headLocal(L, th, dv, dl, lift);
  const u = h.u;
  const w = carrierToWorld({ x: P1.x, z: P1.z }, P1.yaw, u * Math.cos(psi) - h.y * Math.sin(psi), u * Math.sin(psi) + h.y * Math.cos(psi));
  const hw = parts.headWorld(new THREE.Vector3());
  const err = Math.hypot(hw.x - w.x, hw.y - h.z, hw.z - w.z);
  ok(err < 0.03, `head point ψ ${psiDeg}° θ ${thDeg}° L ${L.toFixed(1)} dv ${dv} dl ${dl}: model vs §3.1 err ${err.toFixed(4)} m`);
  // luff cylinder rod eye on B, length = cylLen(θ)
  const eye = parts.luffCyl.rod.getWorldPosition(new THREE.Vector3());
  const B = cylB(th);
  const bu = B.u;
  const bw = carrierToWorld({ x: P1.x, z: P1.z }, P1.yaw, bu * Math.cos(psi), bu * Math.sin(psi));
  const errB = Math.hypot(eye.x - bw.x, eye.y - (B.z + lift), eye.z - bw.z);
  ok(errB < 0.05 + dv * 0.05, `luff rod eye on B (err ${errB.toFixed(3)} m), c = ${parts.luffCyl.length.toFixed(3)} vs cylLen ${cylLen(th).toFixed(3)}`);
}

// floats at full base land on the P1 float centres
parts.setSlew(0); parts.setBoom(0, [0, 0, 0, 0, 0, 0], 0, 0);
for (let i = 0; i < 4; i++) { parts.setBeamExt(i, 1); parts.setJack(i, 0.36); }
const fw = new THREE.Vector3();
for (let i = 0; i < 4; i++) {
  parts.floatWorld(i, fw);
  const [x, z] = P1.floats[i];
  const e = Math.hypot(fw.x - x, fw.z - z);
  ok(e < 0.01, `float ${FLOATS[i].id} at (${fw.x.toFixed(2)}, ${fw.z.toFixed(2)}) vs P1 (${x}, ${z}); pad bottom y ${fw.y.toFixed(3)} (expect ${(1.30 + lift - 0.90 - 0.36).toFixed(3)})`);
  ok(near(fw.y, 1.30 + lift - 0.90 - 0.36, 0.005), `float ${FLOATS[i].id} pad height`);
}
// bumper anchor
parts.setCarrierPose(0, 0, 0, 0, 0, 0); parts.root.updateMatrixWorld(true);
const ba = parts.bumperAnchor.getWorldPosition(new THREE.Vector3());
ok(near(ba.x, VEHICLE.stowedHook.x, 1e-6) && near(ba.y, VEHICLE.stowedHook.z, 1e-6), `bumper anchor ${ba.toArray().map((v) => v.toFixed(2))}`);
// driver / crane eyes
const de = parts.cameraMounts.driverEye.getWorldPosition(new THREE.Vector3());
console.log('driver eye (C):', de.toArray().map((v) => v.toFixed(2)).join(', '));
const ce = parts.cameraMounts.craneEye.getWorldPosition(new THREE.Vector3());
console.log('crane eye (C, slew 0):', ce.toArray().map((v) => v.toFixed(2)).join(', '), ' spec S(u 1.00, y_s 1.45, z 3.55)');

// hook blocks
for (const id of ['ball', 'hb26', 'hb60', 'hb90', 'hb100']) {
  const b = buildMobileHookBlock(id, mats);
  const box = new THREE.Box3().setFromObject(b);
  const d = b.userData;
  const pts = blockFallPoints(b);
  b.updateMatrixWorld(true);
  ok(pts.length === d.falls && near(box.max.y, d.height, 0.06), `block ${id}: falls ${pts.length}, top ${box.max.y.toFixed(3)} vs height ${d.height}, bottom ${box.min.y.toFixed(3)}, width ${(box.max.z - box.min.z).toFixed(2)}`);
  const tops = parts.fallTops(b);
  ok(tops.length === d.falls, `fallTops(${id}) → ${tops.length}`);
}
// counterweight + mats + wheels
parts.setCounterweight(['A', 'B'], ['C'], 0.5);
parts.setMat(0, 'carried', 60.5, 0, -7.42, -Math.PI / 2);
parts.setMat(1, 'composite', 53.5, 0, -7.42, -Math.PI / 2);
parts.setWheels([0.3, 0.1, 0.05, -0.05, -0.2], 1.2);
parts.setSticks({ slew: 1, tele: -1, luff: 0.5, hoist: -0.5 });
parts.setCabTilt(0.2);
parts.setLights({ t: 1, night: 1, beacons: true, work: true });
parts.setWinch(40);
parts.updateAnemometer(0.1, 5);
parts.root.updateMatrixWorld(true);
const lead = parts.ropeLead();
ok(lead.length === 4 && lead.every((v) => Number.isFinite(v.x)), 'ropeLead 4 points');
const bb = new THREE.Box3().setFromObject(parts.root);
console.log('bounds', bb.min.toArray().map((v) => v.toFixed(2)), bb.max.toArray().map((v) => v.toFixed(2)));
parts.root.traverse((o) => { if (o.isMesh) { const b = new THREE.Box3().setFromObject(o); if (b.min.y < -0.01) console.log("below ground:", o.name, o.parent?.name, b.min.y.toFixed(3)); } });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
