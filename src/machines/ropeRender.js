import * as THREE from 'three';

// Rope and sling rendering shared by both machines: one instanced open
// cylinder per straight rope run (falls sheave → block, plus any extra runs a
// machine wants such as the tower's trolley rope or a winch lead), and the
// sling legs hook → load sling points, drawn with a parabolic sag when slack.
//
//   const rr = new RopeRenderer(scene, mats.rope);
//   // per frame (after hoist.updateLoadAttitude(dt) when a load hangs):
//   rr.begin();
//   rr.falls(tops, bottoms, 0.011);         // or rr.rope(a, b, r) per run
//   rr.rope(a, b, 0.008);                   // extra runs
//   rr.slings(hoist);                       // bridle legs of hoist.load (if any)
//   rr.end();
// or the one-call form: rr.update(hoist, tops, blockTop, hoist.load, { bottoms, radius, extra })

const _up = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _pt = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _cur = new THREE.Vector3();

let sharedSlingMat = null;
// polyester round-sling blue (both machines share it)
function slingMaterial() {
  if (!sharedSlingMat) sharedSlingMat = new THREE.MeshStandardMaterial({ color: 0x2d6fd0, roughness: 0.6, metalness: 0.2 });
  return sharedSlingMat;
}

// write a unit cylinder instance stretched from a to b (radius r) at index i; returns next index
function seg(mesh, a, b, r, i) {
  if (i >= mesh.instanceMatrix.count) return i;
  _d.subVectors(b, a);
  const len = _d.length();
  if (len < 1e-4) return i;
  _q.setFromUnitVectors(_up, _d.multiplyScalar(1 / len));
  _s.set(r, len, r);
  _mid.addVectors(a, b).multiplyScalar(0.5);
  _m4.compose(_mid, _q, _s);
  mesh.setMatrixAt(i, _m4);
  return i + 1;
}

export class RopeRenderer {
  /**
   * @param {THREE.Object3D} scene     parent for the two instanced meshes
   * @param {THREE.Material} ropeMat   wire rope material (e.g. createCraneMaterials().rope)
   * @param {{maxRope?:number, maxSling?:number, slingMat?:THREE.Material}} [opts]
   */
  constructor(scene, ropeMat, { maxRope = 72, maxSling = 32, slingMat = null } = {}) {
    this.ropeMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true), ropeMat, maxRope);
    this.ropeMesh.frustumCulled = false;
    this.ropeMesh.castShadow = true;
    this.ropeMesh.count = 0;
    scene.add(this.ropeMesh);
    this.slingMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 5, 1, true), slingMat || slingMaterial(), maxSling);
    this.slingMesh.frustumCulled = false;
    this.slingMesh.castShadow = true;
    this.slingMesh.count = 0;
    scene.add(this.slingMesh);
    this.nRope = 0;
    this.nSling = 0;
  }

  begin() { this.nRope = 0; this.nSling = 0; }

  /** one straight rope run a → b (world) */
  rope(a, b, r = 0.011) { this.nRope = seg(this.ropeMesh, a, b, r, this.nRope); }

  /** parallel falls: tops[i] → bottoms[i] (or → the single point `bottoms` if it is a Vector3) */
  falls(tops, bottoms, r = 0.011) {
    for (let i = 0; i < tops.length; i++) this.rope(tops[i], bottoms.isVector3 ? bottoms : bottoms[i], r);
  }

  /**
   * Sling legs from the hook bowl to each sling point of hoist.load. A slack
   * leg sags by half the excess length (parabola, `segments` pieces).
   */
  slings(hoist, r = 0.014, segments = 5) {
    const l = hoist.load;
    if (!l) return;
    const hook = hoist.hook;
    const n = l.def.points.length;
    for (let p = 0; p < n; p++) {
      const pt = l.slingPoint(p, _pt);
      const [px, pz] = l.def.points[p];
      const legLen = Math.hypot(l.def.sling, px, pz);
      const chord = pt.distanceTo(hook);
      const sag = chord < legLen ? Math.sqrt(legLen * legLen - chord * chord) * 0.5 : 0;
      _prev.copy(hook);
      for (let k = 1; k <= segments; k++) {
        const tt = k / segments;
        _cur.lerpVectors(hook, pt, tt);
        _cur.y -= sag * 4 * tt * (1 - tt);
        this.nSling = seg(this.slingMesh, _prev, _cur, r, this.nSling);
        _prev.copy(_cur);
      }
    }
  }

  end() {
    this.ropeMesh.count = this.nRope;
    this.ropeMesh.instanceMatrix.needsUpdate = true;
    this.slingMesh.count = this.nSling;
    this.slingMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * One-call form (spec §9.2): falls from the sheave points to the block, extra
   * runs, then the slings of `load` (must be hoist.load or null).
   * @param {object} hoist                       HoistSystem
   * @param {THREE.Vector3[]} tops               rope exit points at the sheave(s), one per drawn fall
   * @param {THREE.Vector3} blockTop             where the falls enter the block
   * @param {object|null} load
   * @param {{bottoms?:THREE.Vector3[], radius?:number, extra?:Array<[THREE.Vector3, THREE.Vector3, number]>}} [opts]
   */
  update(hoist, tops, blockTop, load, { bottoms = null, radius = 0.011, extra = [] } = {}) {
    this.begin();
    this.falls(tops, bottoms || blockTop, radius);
    for (const [a, b, r] of extra) this.rope(a, b, r);
    if (load) this.slings(hoist);
    this.end();
  }

  setVisible(v) { this.ropeMesh.visible = this.slingMesh.visible = v; }

  dispose() {
    this.ropeMesh.removeFromParent();
    this.slingMesh.removeFromParent();
    this.ropeMesh.geometry.dispose();
    this.slingMesh.geometry.dispose();
  }
}
