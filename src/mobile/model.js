import * as THREE from 'three';
import { Kit, mBox, mCyl, mTorus, mExtrude, boltGeo, sweepGeo, WEAR_JOINT, WEAR_LIGHT, TAU } from '../crane/kit.js';
import { AT100, AXLES, FLOATS, BASES, FLOAT_X, CW_SLABS, CW_DECK, VEHICLE } from './config.js';
import {
  V, WEAR_PLATE, mobileMaterials, decal, lamp, sheaveGeo, rbox, kitGeometries, remapBins, ProxyInstancer, LodKit,
  TYRE_R, DATUM, J0, BEAM, BOX_HALF, PAD, CW_U, TAIL_R, RAM_Z, tailShape, cwSlabKit, tyreGeometry, rimKit, beamKit,
  floatKit, carriedMatKit, compositeMatKit, unitRodGeometry, beaconGeometry, buildCraneCab, CAB, addDriverCab, DCAB,
} from './modelParts.js';

// AT-100 5.1 all-terrain crane: procedural model (spec §1, §9.4 "model.js").
// Pure scene graph + pose setters, no physics. Built in the style of
// src/crane/model.js (kit.js section members, CC0 PBR paint, merged per
// material and moving part); ~65 draw calls near, fewer beyond LOD_DIST
// (carrier, superstructure and crane cab switch to a coarse merged LOD).
//
// SCENE GRAPH (three.js space, metres; see spec §0 for the C / S frames)
//   root                       add to the scene; stays at the world origin (instanced parts hang here)
//   ├─ tip                     tip-over transform only (setTip); identity otherwise
//   │  └─ carrier              origin = slew axis at ground level (road stance); +X fwd, +Y up, +Z right (= −y_c)
//   │     │                    rotation order 'YZX': (roll, yaw φ, pitch) exactly as §0 → setCarrierPose
//   │     ├─ wheels[5][2]      [axle][0 = left, 1 = right] steer Group (rotation.y = δ, + = left) with
//   │     │                    .spin (Object3D, rotation.z = −rolled angle): rolling forward = negative
//   │     ├─ beams[4]          FL FR RL RR: position.z = −side·|y_float|; jacks[i] (position.y = −e) →
//   │     │                    floats[i] (pad bottom centre, J0 = 0.90 below the datum when e = 0)
//   │     ├─ deckSlabs         CW slabs lying on the rear deck (.A .B .C proxies)
//   │     ├─ driverCab         steering wheel (.wheel), driver eye mount
//   │     ├─ bumperAnchor      stowed hook bowl point C(7.95, 0, 1.2) (VEHICLE.stowedHook)
//   │     └─ upper             y = slew ring 2.25; rotation.y = ψ (+ = toward the left)
//   │        ├─ craneCab       tilt hinge at its rear-bottom (rotation.z = tilt 0..20°, nose up);
//   │        │                 .leftStick .rightStick (joystick pivots) .screen (CanvasTexture mesh, 512×320)
//   │        ├─ luffCyl        barrel at anchor A (rotation.z aims at B), stages[] + rod (eye at B)
//   │        ├─ cwSlabs.A/B/C  superstructure counterweight (hung under the CW frame)
//   │        └─ boomPivot      at the foot pin P (u −2.00, z 3.71); rotation.z = θ
//   │           └─ sections[6] base, T1..T5: position.x = p_i along the boom (p_0 = 0)
//   │              └─ head     (child of T5) at x = 11.5: its origin IS the kinematic head point
//   │                          (L, 0) of §3.1; .sheave (pack, spins), .anemometer (rotor), .headCamMount
//   └─ mats                    ground mats (matSlots[i], world frame; setMat)
//
// Pose API (all optional; call any subset per frame, then render):
//   setCarrierPose(x, y, z, yaw, pitch, roll)   y = world height of the carrier origin (ground + lift)
//   setSlew(ψ) · setBoom(θ, p[6], dv, dl) · setLuff(θ) · setTele(p[6]) · pFromExt(ext[5]) → p[6]
//   setBeam(i, |y|) · setBeamExt(i, 0..1) · setJack(i, e) · setWheels(steer[5], spin, κ?) · setSteeringWheel(a)
//   setCabTilt(rad) · setSticks({slew, tele, luff, hoist}) · setCounterweight(superIds, deckIds, raise01)
//   setMat(i, 'none'|'carried'|'composite', x, y, z, yaw) · floatWorld(i, out) · setWinch(sPaid)
//   updateAnemometer(dt, windSpeed) · setLights({t, night, beacons, work}) · setTip(Matrix4|null)
//   fallTops(block, out) · ropeLead(out) · headWorld(out)

const C = AT100.carrier;
const HW = C.width / 2; // 1.375
const SLEW_Y = AT100.slewRingZ; // 2.25
export const PIVOT = V(AT100.pivot.u, AT100.pivot.z - SLEW_Y, 0); // foot pin in the upper frame
const CYL_A = V(AT100.luff.cylA.u, AT100.luff.cylA.z - SLEW_Y, 0); // luff cylinder anchor A (upper frame)
const CYL_B = V(AT100.luff.cylB.along, -AT100.luff.cylB.below, 0); // attachment B (boom frame)
export const HEAD_X = AT100.boom.baseLen; // head point in the tip-section frame (L = p_5 + 11.5)
const STROKE = AT100.boom.stroke; // 8.1 m per section
const DECK_Y = 1.70; // carrier side / centre deck top [E]
const DECK_REAR = CW_DECK.topZ; // 1.85 ballast deck
const FRAME = { x0: -3.45, x1: 7.45, y0: 0.80, y1: 1.55, hz: 0.50 }; // chassis box girder [E]
// outrigger boxes: centred on the float lines, clear of the tyres by ≥ 0.09 m
const BOXES = [{ x0: 4.36, x1: 4.80 }, { x0: -3.005, x1: -2.625 }];
const BOX_Y = [0.95, 1.65];
// boom sections (§1.2: base 0.90 × 1.06, 0.07 m smaller per side per section);
// visual front ends staggered 8 cm so the nested collars do not coincide, and
// ~0.6 m shorter than the 11.3 m mass length so the head sheaves (whose front
// tangent is the kinematic head point) clear the collars when retracted
export const SECTION = (i) => {
  const [w, h] = AT100.boom.boxBase, st = 2 * AT100.boom.boxStepPerSide;
  return { w: w - st * i, h: h - st * i, rear: i ? 0.30 : -0.62, front: 10.70 + 0.08 * i };
};
// head sheave pack in the head frame: its front tangent passes through the
// kinematic head point at θ ≈ 45° (≤ 0.2 m off at 0° / 82°)
export const SHEAVE = { x: -0.15, y: 0.17, r: 0.215, rOut: 0.24, n: 5, pitch: 0.09, w: 0.07 };
const TOP_Y = 0.62; // hoist rope height above the boom axis over the base rollers
const CW_TOP = 1.15; // upper-local underside of the counterweight frame (z 3.40)
const WINCH = V(-3.10, 2.00, 0); // hoist drum centre (upper frame), behind the boom foot
const DRUM_R = 0.34; // mean rope-layer radius for the drum spin
const ROD = { x0: 0.30, len: 1.85, r: [0.17, 0.135, 0.105, 0.08] }; // luff ram: barrel + 4 telescopic stages
const ROD_RETRACTED = ROD.x0 + 0.02 * 3 + ROD.len; // pin-to-pin length fully retracted (2.21 < c(−1°) = 2.23)
const FLOOD = { x: 4.2, y: 0.3 }; // boom floodlight on the base section's left side (boom frame)
const CRANE_CAB_POS = V(-0.40, 0.15, -(0.50 + CAB.W / 2)); // hinge (upper frame): cab spans |z| 0.50..1.375

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _c = new THREE.Vector3(), _f = new THREE.Vector3(), _a = new THREE.Vector3();

// ------------------------------------------------------------------ carrier
function buildCarrierKit(k, M, atlas, carrier, chrome) {
  // chassis box girder, decks, deck-edge fascia
  k.box('cabFrame', FRAME.x1 - FRAME.x0, FRAME.y1 - FRAME.y0, 2 * FRAME.hz, (FRAME.x0 + FRAME.x1) / 2, (FRAME.y0 + FRAME.y1) / 2, 0, null, WEAR_LIGHT);
  const deck = (x0, x1, z0, z1, y = DECK_Y) => k.box('galv', x1 - x0, 0.06, z1 - z0, (x0 + x1) / 2, y - 0.03, (z0 + z1) / 2);
  deck(-2.52, DCAB.x0 - 0.02, -HW, -FRAME.hz); // left (up to the driver cab)
  deck(-2.52, 6.35, FRAME.hz, HW); // right (up to the front bonnet)
  deck(1.22, 6.35, -FRAME.hz, FRAME.hz); // centre, in front of the slew ring
  for (const s of [-1, 1]) {
    const x1 = s < 0 ? DCAB.x0 : 6.35;
    k.box('yellow', x1 + 2.52, 0.30, 0.03, (x1 - 2.52) / 2, 1.57, s * (HW - 0.015), null, WEAR_LIGHT);
    decal(k, atlas, 'wordmark', 1.6, 0.224, V(2.1, 1.575, s * (HW + 0.002)), V(0, 0, s));
    decal(k, atlas, 'keepclear', 0.2, 0.176, V(-0.9, 1.57, s * (HW + 0.002)), V(0, 0, s));
    for (const x of [-2.2, 0.49, 2.08]) lamp(k, 'amber', 0.07, 0.045, V(x, 1.47, s * (HW + 0.004)), V(0, 0, s)); // side markers
  }
  // carrier engine hood behind the slew ring (below the superstructure's sweep)
  k.add('cabFrame', rbox(1.2, 0.22, 1.0, 0.05).translate(-1.9, 1.62, 0), null, WEAR_LIGHT);
  decal(k, atlas, 'mesh', 0.8, 0.5, V(-1.9, 1.732, 0), V(0, 1, 0), Math.PI / 2);
  // mudguards over every tyre (upper arc, radius 0.80)
  for (const x of AXLES) {
    for (const s of [-1, 1]) {
      const g = new THREE.CylinderGeometry(0.8, 0.8, 0.4, 18, 1, true, Math.PI / 2 + 0.45, Math.PI - 0.9);
      g.rotateX(Math.PI / 2);
      g.translate(x, TYRE_R, s * 1.17);
      k.add('rubber', g, null, null, false);
    }
  }
  // axles, differentials, drive line, suspension struts, tie rods
  C.axleX.forEach((x, j) => {
    k.cyl('darkSteel', 0.09, 1.9, x, TYRE_R, 0, 'z', 12);
    if (C.drivenAxles.includes(j)) k.add('darkSteel', new THREE.SphereGeometry(0.24, 16, 10).scale(1.1, 0.85, 1).translate(x, 0.7, 0), null, WEAR_JOINT, false);
    for (const s of [-1, 1]) {
      k.cyl('cabFrame', 0.075, 0.44, x, 1.3, s * 0.66, 'y', 12, WEAR_JOINT); // hydro-pneumatic strut barrel
      const rod = new THREE.Object3D();
      rod.position.set(x, 0.93, s * 0.66);
      rod.scale.set(0.045, 0.36, 0.045);
      carrier.add(rod);
      chrome.push(rod);
      k.detail = true;
      k.member('darkSteel', V(x + 0.1, 0.72, s * 0.62), V(x + 0.55, 0.95, s * 0.46), { k: 'box', w: 0.1, d: 0.08 }, null, 0.7);
      k.member('darkSteel', V(x - 0.1, 0.72, s * 0.62), V(x - 0.55, 0.95, s * 0.46), { k: 'box', w: 0.1, d: 0.08 }, null, 0.7);
      k.detail = false;
    }
    k.detail = true;
    k.cyl('darkSteel', 0.03, 1.7, x + 0.26, 0.58, 0, 'z', 8); // steering tie rod
    k.detail = false;
  });
  const shafts = [[2.9, -0.28], [-0.28, -1.85], [-1.85, -2.4]];
  for (const [a, b] of shafts) k.member('darkSteel', V(a, 0.74, 0), V(b, 0.8, 0), { k: 'tube', r: 0.05, seg: 8 }, null, 0.3);
  // outrigger boxes (chassis colour) with yellow end collars and setup work lamps
  BOXES.forEach(({ x0, x1 }) => {
    const xc = (x0 + x1) / 2;
    k.box('cabFrame', x1 - x0, BOX_Y[1] - BOX_Y[0], 2 * BOX_HALF, xc, (BOX_Y[0] + BOX_Y[1]) / 2, 0, null, WEAR_LIGHT);
    for (const s of [-1, 1]) {
      k.box('yellow', x1 - x0 + 0.05, BOX_Y[1] - BOX_Y[0] + 0.05, 0.03, xc, (BOX_Y[0] + BOX_Y[1]) / 2, s * (BOX_HALF - 0.01), null, WEAR_PLATE);
      k.box('darkSteel', 0.1, 0.07, 0.08, xc + (x1 - x0) / 2 + 0.03, BOX_Y[1] - 0.05, s * (BOX_HALF - 0.06));
      lamp(k, 'work', 0.08, 0.05, V(xc + (x1 - x0) / 2 + 0.081, BOX_Y[1] - 0.05, s * (BOX_HALF - 0.06)), V(1, -0.6, s * 0.8));
    }
  });
  // outrigger control panels with bubble levels (both sides, behind the front box)
  for (const s of [-1, 1]) {
    k.box('grey', 0.3, 0.3, 0.06, 3.95, 1.25, s * (HW - 0.03), null, WEAR_LIGHT);
    decal(k, atlas, 'level', 0.12, 0.12, V(3.95, 1.3, s * (HW + 0.001)), V(0, 0, s));
  }
  // slewing ring base, ring gear, bearing
  k.cyl('cabFrame', 1.2, 0.55, 0, 1.825, 0, 'y', 40, WEAR_LIGHT);
  k.cyl('darkSteel', 1.26, 0.12, 0, 2.04, 0, 'y', 48);
  k.cyl('darkSteel', 1.18, 0.15, 0, 2.175, 0, 'y', 40);
  k.detail = true;
  for (let i = 0; i < 96; i++) {
    const a = i / 96 * TAU;
    k.box('darkSteel', 0.03, 0.12, 0.05, Math.cos(a) * 1.275, 2.04, Math.sin(a) * 1.275, [0, -a, 0]);
  }
  k.detail = false;
  // driver cab is added by the caller (addDriverCab); front bonnet, bumper, hook anchor
  k.add('yellow', rbox(7.58 - 6.35, 0.87, 1.46, 0.08).translate((7.58 + 6.35) / 2, 1.515, 0.63), null, WEAR_LIGHT);
  decal(k, atlas, 'louvre', 0.9, 0.42, V(7.583, 1.55, 0.63), V(1, 0, 0));
  k.add('yellow', rbox(0.35, 0.56, 2.6, 0.06).translate(7.575, 0.78, 0), null, WEAR_LIGHT);
  k.box('rubber', 0.05, 0.1, 2.5, 7.765, 0.54, 0);
  for (const s of [-1, 1]) {
    lamp(k, 'white', 0.3, 0.13, V(7.752, 0.87, s * 0.97), V(1, 0, 0));
    lamp(k, 'amber', 0.1, 0.1, V(7.752, 0.87, s * 1.21), V(1, 0, 0));
    lamp(k, 'white', 0.1, 0.1, V(7.752, 0.66, s * 0.72), V(1, 0, 0), true);
    k.add('darkSteel', mTorus(0.05, 0.016, 6, 12).translate(7.78, 0.66, s * 0.42), null, null, false); // tow eyes
  }
  // stowed-hook anchor: arm + pin whose top is the stowed hook saddle C(7.95, 0, 1.2)
  const A = VEHICLE.stowedHook;
  k.member('darkSteel', V(7.62, 1.0, 0), V(A.x + 0.04, A.z - 0.07, 0), { k: 'box', w: 0.1, d: 0.08 }, null, 0.5);
  for (const z of [-0.07, 0.07]) k.box('darkSteel', 0.12, 0.1, 0.02, A.x, A.z - 0.05, z);
  k.cyl('darkSteel', 0.022, 0.18, A.x, A.z - 0.022, 0, 'z', 10);
  // boom rest: A-frame with rubber pads touching the base section's round bottom
  for (const s of [-1, 1]) {
    k.member('yellow', V(5.2, DECK_Y, s * 0.3), V(5.2, 3.02, s * 0.15), { k: 'box', w: 0.1, d: 0.1 }, null, 0.6);
    k.box('rubber', 0.16, 0.11, 0.12, 5.2, 3.175, s * 0.21);
  }
  k.box('yellow', 0.14, 0.1, 0.62, 5.2, 3.07, 0, null, WEAR_PLATE);
  // rear: ballast deck (top 1.85), engine body with radiator, lamps, under-run bar
  k.box('galv', 1.22, 0.05, 2.6, -3.11, DECK_REAR - 0.025, 0);
  for (const s of [-1, 1]) k.box('yellow', 1.22, 0.08, 0.04, -3.11, DECK_REAR - 0.04, s * 1.3, null, WEAR_LIGHT);
  k.add('yellow', rbox(0.69, 1.28, 2.6, 0.06).translate(-3.355, 1.15, 0), null, WEAR_LIGHT);
  decal(k, atlas, 'louvre', 1.3, 0.55, V(-3.702, 1.3, 0), V(-1, 0, 0));
  for (const s of [-1, 1]) {
    decal(k, atlas, 'louvre', 0.45, 0.5, V(-3.35, 1.2, s * 1.302), V(0, 0, s));
    lamp(k, 'red', 0.26, 0.12, V(-3.703, 0.86, s * 1.07), V(-1, 0, 0));
    lamp(k, 'amber', 0.1, 0.12, V(-3.703, 0.86, s * 0.83), V(-1, 0, 0));
    lamp(k, 'white', 0.12, 0.07, V(-3.703, 0.72, s * 1.07), V(-1, 0, 0));
    k.box('black', 0.08, 0.1, 0.16, -3.72, 1.66, s * 0.9);
    lamp(k, 'work', 0.12, 0.07, V(-3.762, 1.66, s * 0.9), V(-1, -0.4, 0));
  }
  k.box('yellow', 0.12, 0.16, 2.4, -3.72, 0.5, 0, null, WEAR_PLATE);
  decal(k, atlas, 'stripes', 2.3, 0.14, V(-3.782, 0.5, 0), V(-1, 0, 0));
  k.box('darkSteel', 0.2, 0.14, 0.2, -3.78, 0.72, 0);
  k.member('black', V(-3.0, 0.44, 0.85), V(-3.78, 0.44, 0.85), { k: 'tube', r: 0.05, seg: 10 }, null, 0);
  // left: access steps to the deck / crane cab; right: fuel tank
  k.detail = true;
  for (const [y, d] of [[0.55, 0.22], [0.95, 0.2], [1.33, 0.18]]) k.box('galv', 0.62, 0.04, d, 3.96, y, -HW + d / 2);
  for (const x of [3.64, 4.28]) k.box('yellow', 0.02, 1.0, 0.2, x, 0.95, -HW + 0.1, null, WEAR_LIGHT);
  for (const x of [3.6, 4.32]) k.member('galv', V(x, 0.9, -HW + 0.02), V(x, 2.6, -HW + 0.02), { k: 'tube', r: 0.016, seg: 8 }, null, 0);
  k.detail = false;
  k.add('galv', rbox(0.62, 0.72, 0.42, 0.06).translate(3.97, 0.98, 1.14), null, WEAR_LIGHT);
  k.cyl('black', 0.05, 0.06, 3.97, 1.37, 1.14, 'y', 12);
  for (const x of [3.78, 4.16]) k.box('black', 0.04, 0.74, 0.44, x, 0.98, 1.14);
  // stored-mat rack (the 4 carried mats are instanced proxies, see buildMobileCrane)
  for (const [x, z] of [[3.87, 0.36], [5.68, 0.36], [3.87, 1.37], [5.68, 1.37]]) k.box('darkSteel', 0.04, 0.56, 0.04, x, DECK_Y + 0.28, z);
}

// ------------------------------------------------------------------ superstructure
function buildUpperKit(k, M, atlas) {
  // turntable, deck plates, cab bracket
  k.cyl('yellow', 1.25, 0.12, 0, 0.06, 0, 'y', 40, WEAR_LIGHT);
  k.box('galv', 1.6, 0.05, 0.93, 0.45, 0.095, 0.905); // right front deck
  k.box('galv', 2.0, 0.05, 0.93, -1.45, 0.095, -0.905); // left rear deck (under the hydraulic tank)
  k.box('darkSteel', 0.14, 0.1, 0.7, CRANE_CAB_POS.x, 0.1, CRANE_CAB_POS.z); // cab tilt hinge block
  const plate = (pts, z0, t = 0.08) => {
    const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    k.add('yellow', mExtrude(sh, t).translate(0, 0, z0), null, WEAR_PLATE);
  };
  // front plates (narrow, |z| 0.36..0.44) carrying the luff cylinder anchor A
  const FP = [[-1.0, 0.12], [1.25, 0.12], [1.3, 0.02], [1.36, -0.3], [1.6, -0.46], [1.84, -0.3], [1.95, 0.05], [1.95, 0.4], [1.4, 0.55], [-1.0, 0.55]];
  plate(FP, 0.36); plate(FP, -0.44);
  for (const s of [-1, 1]) k.cyl('yellow', 0.16, 0.05, CYL_A.x, CYL_A.y, s * 0.465, 'z', 18, WEAR_PLATE);
  k.cyl('darkSteel', 0.07, 1.0, CYL_A.x, CYL_A.y, 0, 'z', 12);
  // rear plates (wide, |z| 0.47..0.55) carrying the boom foot pin P
  const RP = [[-2.55, 0.12], [-0.6, 0.12], [-0.6, 0.55], [-1.3, 1.05], [-1.62, 1.62], [-1.95, 1.76], [-2.35, 1.72], [-2.55, 1.5]];
  plate(RP, 0.47); plate(RP, -0.55);
  for (const s of [-1, 1]) {
    k.box('yellow', 0.08, 0.43, 0.19, -0.8, 0.335, s * 0.455, null, WEAR_PLATE); // narrow → wide transition
    k.cyl('yellow', 0.26, 0.07, PIVOT.x, PIVOT.y, s * 0.585, 'z', 20, WEAR_PLATE);
  }
  k.cyl('darkSteel', 0.12, 1.36, PIVOT.x, PIVOT.y, 0, 'z', 14);
  // tail: girders, top plate, counterweight frame underside (slabs hang below y 1.15)
  for (const s of [-1, 1]) {
    k.box('yellow', 1.2, 0.4, 0.08, -3.15, 1.35, s * 0.51, null, WEAR_PLATE);
    k.box('yellow', 0.9, 0.4, 0.08, -3.0, 1.35, s * 1.24, null, WEAR_PLATE);
    decal(k, atlas, 'keepclear', 0.3, 0.264, V(-3.0, 1.35, s * 1.281), V(0, 0, s));
  }
  k.box('yellow', 0.12, 0.42, 2.56, -2.6, 1.36, 0, null, WEAR_PLATE);
  const top = mExtrude(tailShape(0.63, 1.3, false), 0.05, { curveSegments: 4 });
  top.rotateX(-Math.PI / 2).translate(CW_U, 1.52, 0);
  k.add('yellow', top, null, WEAR_LIGHT);
  const under = mExtrude(tailShape(0.63, 1.3, true), 0.05, { curveSegments: 4 });
  under.rotateX(-Math.PI / 2).translate(CW_U, CW_TOP, 0);
  k.add('cabFrame', under, null, WEAR_LIGHT);
  // ballasting rams (barrels; the chrome rods are proxies)
  for (const s of [-1, 1]) {
    k.cyl('yellow', 0.075, 0.5, CW_U, 1.82, s * RAM_Z, 'y', 14, WEAR_PLATE);
    k.cyl('darkSteel', 0.085, 0.05, CW_U, 2.08, s * RAM_Z, 'y', 14);
  }
  // hoist winch frame, motor and brake (the drum itself turns: buildMobileCrane)
  const WF = [[-3.55, 1.57], [-2.65, 1.57], [-2.82, 2.12], [-3.1, 2.2], [-3.38, 2.12]];
  plate(WF, 0.38, 0.04); plate(WF, -0.42, 0.04);
  k.cyl('darkSteel', 0.12, 0.92, WINCH.x, WINCH.y, 0, 'z', 16);
  k.cyl('darkSteel', 0.15, 0.2, WINCH.x, WINCH.y, 0.53, 'z', 16);
  k.cyl('cabFrame', 0.12, 0.12, WINCH.x, WINCH.y, 0.69, 'z', 16);
  // engine housing (right) with louvres, radiator grille, exhaust, handrail
  k.add('yellow', rbox(2.1, 1.0, 0.75, 0.07, 3).translate(-1.4, 0.62, 0.995), null, WEAR_LIGHT);
  decal(k, atlas, 'louvre', 0.8, 0.35, V(-1.95, 0.72, 1.371), V(0, 0, 1));
  decal(k, atlas, 'louvre', 0.8, 0.35, V(-0.85, 0.72, 1.371), V(0, 0, 1));
  decal(k, atlas, 'wordmark', 1.4, 0.196, V(-1.4, 0.98, 1.371), V(0, 0, 1));
  decal(k, atlas, 'grille', 0.5, 0.5, V(-1.0, 1.121, 0.99), V(0, 1, 0));
  k.member('black', V(-2.1, 1.1, 1.2), V(-2.1, 1.62, 1.2), { k: 'tube', r: 0.05, seg: 10 }, null, 0);
  k.cyl('black', 0.07, 0.02, -2.1, 1.64, 1.2, 'y', 12);
  k.detail = true;
  for (const x of [-2.3, -1.4, -0.5]) k.member('galv', V(x, 1.12, 1.33), V(x, 1.62, 1.33), { k: 'tube', r: 0.018, seg: 8 }, null, 0);
  k.member('galv', V(-2.3, 1.62, 1.33), V(-0.5, 1.62, 1.33), { k: 'tube', r: 0.018, seg: 8 }, null, 0);
  k.detail = false;
  // hydraulic tank (left rear) with filler cap and return filter
  k.add('yellowDark', rbox(1.85, 0.83, 0.7, 0.05).translate(-1.475, 0.535, -0.95), null, WEAR_LIGHT);
  k.cyl('black', 0.06, 0.06, -1.9, 0.98, -0.95, 'y', 12);
  k.cyl('darkSteel', 0.07, 0.25, -1.1, 1.07, -0.8, 'y', 12);
  // slew drive gearboxes engaging the ring gear
  k.detail = true;
  for (const [x, z] of [[0.95, 0.82], [-0.5, 1.15]]) k.cyl('darkSteel', 0.12, 0.5, x, -0.1, z, 'y', 12);
  // hoses: turntable → luff cylinder, and up the rear plates to the boom foot
  for (const s of [-1, 1]) {
    k.add('black', sweepGeo([V(0.7, 0.16, s * 0.2), V(1.15, 0.1, s * 0.26), V(1.45, -0.05, s * 0.28), V(1.62, -0.05, s * 0.3)], () => 0.02, { steps: 12, seg: 6 }), null, null, false);
    k.add('black', sweepGeo([V(-0.62, 0.35, s * 0.6), V(-1.2, 0.95, s * 0.6), V(-1.6, 1.45, s * 0.62), V(-1.85, 1.62, s * 0.64)], () => 0.025, { steps: 14, seg: 6 }), null, null, false);
  }
  k.detail = false;
  // tail beacon base and a rear work lamp
  k.cyl('black', 0.07, 0.04, -3.5, 1.59, -0.95, 'y', 14);
  k.box('black', 0.1, 0.1, 0.16, -3.55, 1.64, 0.95);
  lamp(k, 'work', 0.12, 0.07, V(-3.602, 1.64, 0.95), V(-1, -0.4, 0));
}

// ------------------------------------------------------------------ boom
function profilePath(p, w, h, r = 0.05) {
  const hw = w / 2, top = h / 2, cy = -h / 2 + hw; // rounded-bottom ("egg") profile of modern AT booms
  p.moveTo(-hw, cy);
  p.lineTo(-hw, top - r);
  p.quadraticCurveTo(-hw, top, -hw + r, top);
  p.lineTo(hw - r, top);
  p.quadraticCurveTo(hw, top, hw, top - r);
  p.lineTo(hw, cy);
  p.absarc(0, cy, hw, 0, -Math.PI, true);
  return p;
}
function extrudeAlongX(shape, x0, x1) {
  const g = mExtrude(shape, x1 - x0, { curveSegments: 12 });
  g.translate(0, 0, x0);
  g.rotateY(Math.PI / 2); // extrusion z → boom +x
  return g;
}
function buildSection(i, M, atlas) {
  const k = new Kit(430 + i);
  const d = SECTION(i);
  k.add('yellow', extrudeAlongX(profilePath(new THREE.Shape(), d.w, d.h), d.rear, d.front - 0.14), null, WEAR_LIGHT);
  if (i < 5) { // front collar around the next section (holds the slide pads)
    const n = SECTION(i + 1);
    const ring = profilePath(new THREE.Shape(), d.w + 0.05, d.h + 0.05);
    ring.holes.push(profilePath(new THREE.Path(), n.w + 0.012, n.h + 0.012));
    k.add('yellow', extrudeAlongX(ring, d.front - 0.14, d.front), null, WEAR_PLATE);
  } else {
    k.add('yellow', extrudeAlongX(profilePath(new THREE.Shape(), d.w + 0.03, d.h + 0.03), d.front - 0.14, d.front), null, WEAR_PLATE);
  }
  if (i === 0) {
    // foot pin through the base, cylinder lug B underneath, rope rollers on top
    for (const s of [-1, 1]) k.cyl('yellow', 0.22, 0.04, 0, 0, s * (d.w / 2 + 0.02), 'z', 20, WEAR_PLATE);
    for (const s of [-1, 1]) k.box('yellow', 0.5, 0.4, 0.04, CYL_B.x, -0.52, s * 0.1, null, WEAR_PLATE);
    k.cyl('darkSteel', 0.075, 0.3, CYL_B.x, CYL_B.y, 0, 'z', 12);
    for (const [x, yTop] of [[-0.35, d.h / 2], [d.front - 0.08, d.h / 2 + 0.025]]) {
      for (const s of [-1, 1]) k.box('yellow', 0.2, TOP_Y - yTop + 0.02, 0.02, x, (TOP_Y + yTop) / 2 - 0.03, s * 0.09, null, WEAR_PLATE);
      k.cyl('darkSteel', 0.05, 0.16, x, TOP_Y - 0.05, 0, 'z', 12);
    }
    // LMI length-cable reel, boom-angle sensor, boom floodlight (left side)
    k.cyl('yellow', 0.3, 0.14, 0.9, 0.05, -(d.w / 2 + 0.09), 'z', 24, WEAR_LIGHT);
    k.box('grey', 0.18, 0.14, 0.08, 1.5, 0.3, d.w / 2 + 0.04);
    // (floodlight ahead of the crane cab's front so the two never meet at low luff)
    k.box('darkSteel', 0.18, 0.16, 0.12, FLOOD.x, FLOOD.y, -(d.w / 2 + 0.07));
    lamp(k, 'work', 0.14, 0.1, V(FLOOD.x + 0.092, FLOOD.y, -(d.w / 2 + 0.07)), V(1, -0.2, 0));
    for (const s of [-1, 1]) decal(k, atlas, 'wordmark', 3.2, 0.448, V(5.6, 0.12, s * (d.w / 2 + 0.002)), V(0, 0, s));
  }
  return k;
}

function buildHead(M, atlas) {
  const head = new THREE.Group();
  head.name = 'head';
  head.position.x = HEAD_X;
  const k = new Kit(440);
  const t5 = SECTION(5);
  const hz = SHEAVE.n * SHEAVE.w / 2 + (SHEAVE.pitch - SHEAVE.w) * 2 + 0.03; // cheek inner face
  // sleeve over the tip section's end + side plates out to the cheeks
  k.add('yellow', rbox(0.42, t5.h + 0.1, t5.w + 0.1, 0.03).translate(-0.56, 0, 0), null, WEAR_PLATE);
  for (const s of [-1, 1]) k.box('yellow', 0.34, 0.44, hz - (t5.w / 2 + 0.05), -0.55, 0.06, s * (hz + t5.w / 2 + 0.05) / 2, null, WEAR_PLATE);
  // cheek plates enclosing the 5-sheave pack and the front runner sheave
  const HC = [[-0.62, -0.26], [0.25, -0.26], [0.62, -0.12], [0.62, 0.12], [0.3, 0.3], [0.05, 0.47], [-0.32, 0.47], [-0.62, 0.25]];
  const sh = new THREE.Shape(HC.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const s of [-1, 1]) {
    k.add('yellow', mExtrude(sh, 0.03).translate(0, 0, s > 0 ? hz : -hz - 0.03), null, WEAR_PLATE);
    decal(k, atlas, 'stripes', 0.34, 0.2, V(0.42, 0.0, s * (hz + 0.032)), V(0, 0, s));
    k.cyl('darkSteel', 0.075, 0.025, SHEAVE.x, SHEAVE.y, s * (hz + 0.042), 'z', 14);
  }
  k.box('yellow', 0.3, 0.03, 2 * hz, -0.47, 0.455, 0, null, WEAR_PLATE); // rear top plate
  k.box('yellow', 0.18, 0.03, 2 * hz, -0.53, -0.245, 0, null, WEAR_PLATE); // rear bottom plate (falls hang in front)
  k.cyl('darkSteel', 0.05, 2 * hz + 0.1, SHEAVE.x, SHEAVE.y, 0, 'z', 12); // main sheave axle
  k.add('darkSteel', sheaveGeo(0.17, 0.06).translate(0.4, -0.02, 0), null, null, false); // runner (single-line) sheave
  k.cyl('darkSteel', 0.04, 2 * hz + 0.06, 0.4, -0.02, 0, 'z', 10);
  k.cyl('darkSteel', 0.018, 2 * hz, SHEAVE.x + 0.28, SHEAVE.y + 0.1, 0, 'z', 8); // rope guard bars
  k.cyl('darkSteel', 0.018, 2 * hz, SHEAVE.x - 0.02, SHEAVE.y + SHEAVE.rOut + 0.035, 0, 'z', 8);
  k.box('darkSteel', 0.3, 0.06, 0.4, -0.3, -0.29, 0); // hook-block buffer
  // anemometer foot plate, obstruction light, hook-camera bracket
  k.box('darkSteel', 0.12, 0.02, 0.12, -0.4, 0.48, -0.18);
  k.cyl('darkSteel', 0.04, 0.05, 0.0, 0.495, hz + 0.015, 'y', 10); // red obstruction light on the right cheek
  lamp(k, 'red', 0.07, 0.07, V(0.0, 0.522, hz + 0.015), V(0, 1, 0), true);
  k.member('darkSteel', V(0.1, -0.2, hz + 0.03), V(0.12, -0.28, 0.32), { k: 'box', w: 0.04, d: 0.04 }, null, 0);
  remapBins(k, { galv: 'darkSteel', rubber: 'darkSteel', black: 'darkSteel' });
  k.build(head, M);
  // sheave pack (spins with the rope)
  const sheave = new THREE.Group();
  sheave.name = 'headSheaves';
  sheave.position.set(SHEAVE.x, SHEAVE.y, 0);
  const sk = new Kit(441);
  for (let j = 0; j < SHEAVE.n; j++) sk.add('darkSteel', sheaveGeo(SHEAVE.rOut, SHEAVE.w).translate(0, 0, (j - (SHEAVE.n - 1) / 2) * SHEAVE.pitch), null, null, false);
  sk.build(sheave, M);
  head.add(sheave);
  // self-levelling anemometer mast (rotor = mast + cups; the round mast hides the spin)
  const anemoPivot = new THREE.Group();
  anemoPivot.position.set(-0.4, 0.49, -0.18);
  head.add(anemoPivot);
  const rotor = new THREE.Group();
  rotor.name = 'anemometer';
  const ak = new Kit(442);
  ak.cyl('galv', 0.02, 0.75, 0, 0.375, 0, 'y', 8);
  ak.cyl('galv', 0.03, 0.06, 0, 0.78, 0, 'y', 10);
  for (let i = 0; i < 3; i++) {
    const a = i * TAU / 3;
    ak.member('galv', V(0, 0.79, 0), V(Math.cos(a) * 0.17, 0.79, Math.sin(a) * 0.17), { k: 'tube', r: 0.005, seg: 5 }, null, 0);
    ak.add('galv', new THREE.SphereGeometry(0.04, 10, 6, 0, TAU, 0, Math.PI / 2).rotateZ(Math.PI / 2).rotateY(-a + Math.PI / 2).translate(Math.cos(a) * 0.19, 0.79, Math.sin(a) * 0.19), null, null, false);
  }
  ak.build(rotor, M);
  anemoPivot.add(rotor);
  // self-levelling hook camera (looks straight down −Y of headCamMount)
  const camPivot = new THREE.Group();
  camPivot.name = 'headCamMount';
  camPivot.position.set(0.12, -0.3, 0.32);
  head.add(camPivot);
  const ck = new Kit(443);
  ck.add('black', rbox(0.12, 0.1, 0.12, 0.02).translate(0, -0.03, 0), null, null, false);
  ck.cyl('black', 0.03, 0.03, 0, -0.09, 0, 'y', 12);
  ck.build(camPivot, M);
  head.sheave = sheave;
  head.anemometer = rotor;
  head.headCamMount = camPivot;
  head.levelled = [anemoPivot, camPivot];
  return head;
}

// ------------------------------------------------------------------ assembly
/**
 * Build the AT-100 5.1 model.
 * @param {object} mats the tower's createCraneMaterials() set (ctx.craneMats), read-only
 * @returns parts — see the header of this file
 */
export function buildMobileCrane(mats) {
  const M = mobileMaterials(mats);
  const atlas = M.mdecal.userData.atlas;
  const root = new THREE.Group();
  root.name = 'mobileCrane';
  const inst = new ProxyInstancer(root);
  const tip = new THREE.Group();
  tip.name = 'tip';
  root.add(tip);
  const carrier = new THREE.Group();
  carrier.name = 'carrier';
  carrier.rotation.order = 'YZX'; // R = Ry(φ)·Rz(pitch)·Rx(roll) (§0)
  tip.add(carrier);
  const ground = new THREE.Group();
  ground.name = 'mats';
  root.add(ground);
  const chrome = [];
  const beacons = [];

  // --- carrier (static) + driver cab
  const ck = new LodKit(401);
  buildCarrierKit(ck, M, atlas, carrier, chrome);
  const driverCab = new THREE.Group();
  driverCab.name = 'driverCab';
  carrier.add(driverCab);
  const dc = addDriverCab(ck, M, atlas, driverCab);
  beacons.push(...dc.beacons);
  remapBins(ck, { seat: 'rubber', panel: 'cabBody', grey: 'cabBody' });
  const carrierLod = ck.buildLod(carrier, M, { noShadow: ['glassIn', 'mdecal', 'lamps'] });
  driverCab.wheel = dc.wheel;
  const bumperAnchor = new THREE.Object3D();
  bumperAnchor.name = 'bumperAnchor';
  bumperAnchor.position.set(VEHICLE.stowedHook.x, VEHICLE.stowedHook.z, -VEHICLE.stowedHook.y);
  carrier.add(bumperAnchor);

  // --- wheels: steer group → spin → (right: turned π) geometry proxy
  const wheelGeo = [];
  const wheels = C.axleX.map((x, j) => [0, 1].map((s) => {
    const steer = new THREE.Group();
    steer.name = `wheel${j + 1}${s ? 'R' : 'L'}`;
    steer.position.set(x, TYRE_R, (s ? 1 : -1) * C.tyre.trackY);
    const spin = new THREE.Object3D();
    steer.add(spin);
    const g = new THREE.Object3D();
    if (s) g.rotation.y = Math.PI;
    spin.add(g);
    carrier.add(steer);
    steer.steer = steer;
    steer.spin = spin;
    steer.side = s;
    wheelGeo.push(g);
    return steer;
  }));
  inst.add('tyres', [{ geometry: tyreGeometry(), material: M.tyre }], wheelGeo);
  const rk = new Kit(402);
  rimKit(rk);
  inst.add('rims', kitGeometries(rk, M), wheelGeo);

  // --- outriggers: beam (+ housing) → jack → float
  const beams = [], jacks = [], floats = [];
  const upperBeams = [], lowerBeams = [], floatProxies = [];
  FLOATS.forEach((f, i) => {
    const b = new THREE.Group();
    b.name = `beam${f.id}`;
    b.position.set(f.x, DATUM, -f.side * BASES[0]);
    if (f.side < 0) b.rotation.y = Math.PI; // canonical geometry is a left beam running toward +z
    carrier.add(b);
    const jk = new THREE.Group();
    jk.name = `jack${f.id}`;
    b.add(jk);
    const rod = new THREE.Object3D();
    const r0 = -J0 + PAD.t + PAD.dome - 0.02, r1 = 0.2; // rod from the float socket up into the housing
    rod.position.y = (r0 + r1) / 2;
    rod.scale.set(0.075, r1 - r0, 0.075);
    jk.add(rod);
    chrome.push(rod);
    const fl = new THREE.Group();
    fl.name = `float${f.id}`;
    fl.position.y = -J0;
    jk.add(fl);
    const fp = new THREE.Object3D();
    fl.add(fp);
    floatProxies.push(fp);
    (f.side > 0 ? upperBeams : lowerBeams).push(b);
    beams.push(b); jacks.push(jk); floats.push(fl);
  });
  for (const [list, upper] of [[upperBeams, true], [lowerBeams, false]]) {
    const bk = new Kit(410 + (upper ? 1 : 0));
    beamKit(bk, atlas, upper);
    remapBins(bk, { darkSteel: 'yellow', black: 'yellow' });
    inst.add(upper ? 'beamsL' : 'beamsR', kitGeometries(bk, M), list);
  }
  const fk = new Kit(412);
  floatKit(fk);
  remapBins(fk, { darkSteel: 'cabFrame' });
  inst.add('floats', kitGeometries(fk, M), floatProxies);

  // --- mats: ground slots (world frame) + 4 carried mats in the rack
  const matSlots = FLOATS.map((f) => {
    const slot = new THREE.Group();
    slot.name = `mat${f.id}`;
    ground.add(slot);
    const carried = new THREE.Object3D();
    carried.visible = false;
    const composite = new THREE.Object3D();
    composite.visible = false;
    slot.add(carried, composite);
    const stored = new THREE.Object3D();
    carrier.add(stored);
    Object.assign(slot, { carried, composite, stored, kind: 'none' });
    return slot;
  });
  const mk = new Kit(413);
  carriedMatKit(mk);
  remapBins(mk, { darkSteel: 'galv' });
  inst.add('matsCarried', kitGeometries(mk, M), [...matSlots.map((s) => s.carried), ...matSlots.map((s) => s.stored)]);
  const mk2 = new Kit(414);
  compositeMatKit(mk2);
  remapBins(mk2, { black: 'rubber' });
  inst.add('matsComposite', kitGeometries(mk2, M), matSlots.map((s) => s.composite));

  // --- superstructure
  const upper = new THREE.Group();
  upper.name = 'upper';
  upper.position.y = SLEW_Y;
  carrier.add(upper);
  const uk = new LodKit(403);
  buildUpperKit(uk, M, atlas);
  remapBins(uk, { rubber: 'black', red: 'yellow', grey: 'yellow' });
  const upperLod = uk.buildLod(upper, M, { noShadow: ['mdecal', 'lamps'] });
  const tailBeacon = new THREE.Object3D();
  tailBeacon.position.set(-3.5, 1.61, -0.95);
  upper.add(tailBeacon);
  beacons.push(tailBeacon);
  // hoist drum (turns with the rope)
  const drum = new THREE.Group();
  drum.name = 'winchDrum';
  drum.position.copy(WINCH);
  const wk = new Kit(404);
  wk.cyl('darkSteel', 0.25, 0.66, 0, 0, 0, 'z', 24);
  for (const s of [-1, 1]) wk.cyl('darkSteel', 0.46, 0.03, 0, 0, s * 0.345, 'z', 32);
  wk.add('ropeWound', mCyl(DRUM_R, DRUM_R, 0.63, 32).rotateX(Math.PI / 2), null, null, false);
  wk.build(drum, M);
  upper.add(drum);
  // crane cab (tilting)
  const cab = buildCraneCab(M, atlas);
  const craneCab = cab.group;
  craneCab.position.copy(CRANE_CAB_POS);
  upper.add(craneCab);
  beacons.push(cab.beacon);
  // luffing cylinder: barrel at A aimed at B, four telescopic chrome stages
  const barrel = new THREE.Group();
  barrel.name = 'luffBarrel';
  barrel.position.copy(CYL_A);
  upper.add(barrel);
  const lk = new Kit(405);
  lk.add('yellow', mCyl(0.21, 0.21, 1.88, 20).rotateZ(-Math.PI / 2).translate(1.06, 0, 0), null, WEAR_LIGHT);
  lk.add('yellow', mCyl(0.23, 0.23, 0.1, 20).rotateZ(-Math.PI / 2).translate(1.95, 0, 0), null, WEAR_PLATE); // gland
  lk.add('yellow', mCyl(0.23, 0.23, 0.12, 20).rotateZ(-Math.PI / 2).translate(0.18, 0, 0), null, WEAR_PLATE); // base cap
  lk.cyl('yellow', 0.13, 0.26, 0, 0, 0, 'z', 16, WEAR_PLATE); // rear eye
  lk.member('yellow', V(0.05, 0, 0), V(0.2, 0, 0), { k: 'box', w: 0.2, d: 0.2 }, null, 0.5);
  lk.build(barrel, M);
  const stages = ROD.r.map((r, kk) => {
    const st = new THREE.Group();
    st.name = `luffStage${kk + 1}`;
    barrel.add(st);
    const p = new THREE.Object3D();
    p.rotation.z = -Math.PI / 2; // unit rod axis y → barrel x
    p.scale.set(r, ROD.len, r);
    p.position.x = -ROD.len / 2; // stage origin = its outer (front) end
    st.add(p);
    chrome.push(p);
    return st;
  });
  const rod = stages[3];
  rod.name = 'luffRod';
  const eye = new THREE.Object3D();
  eye.rotation.x = Math.PI / 2;
  eye.scale.set(0.09, 0.2, 0.09);
  rod.add(eye);
  chrome.push(eye);
  const luffCyl = { barrel, rod, stages };
  // counterweight: superstructure slabs + deck slabs (instanced), ram rods
  const cwSlabs = {}, deckSlabs = new THREE.Group();
  deckSlabs.name = 'deckSlabs';
  deckSlabs.position.set(CW_DECK.x, CW_DECK.topZ, 0);
  carrier.add(deckSlabs);
  for (const id of ['A', 'B', 'C']) {
    const p = new THREE.Object3D();
    p.name = `cw${id}`;
    p.visible = false;
    upper.add(p);
    cwSlabs[id] = p;
    const d = new THREE.Object3D();
    d.name = `deck${id}`;
    d.visible = false;
    deckSlabs.add(d);
    deckSlabs[id] = d;
  }
  for (const [ids, label] of [[['A', 'C'], 'cw11.5'], [['B'], 'cw12.0']]) {
    const sk = new Kit(415 + ids.length);
    cwSlabKit(sk, atlas, CW_SLABS[ids[0]].h, label);
    remapBins(sk, { darkSteel: 'yellowDark' });
    inst.add(`cw${ids.join('')}`, kitGeometries(sk, M), [...ids.map((id) => cwSlabs[id]), ...ids.map((id) => deckSlabs[id])]);
  }
  const ramRods = [-1, 1].map((s) => {
    const r = new THREE.Object3D();
    r.position.set(CW_U, CW_TOP, s * RAM_Z);
    r.scale.set(0.045, 0.1, 0.045);
    upper.add(r);
    chrome.push(r);
    return r;
  });

  // --- boom
  const boomPivot = new THREE.Group();
  boomPivot.name = 'boomPivot';
  boomPivot.position.copy(PIVOT);
  upper.add(boomPivot);
  const sections = [];
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Group();
    s.name = i ? `T${i}` : 'base';
    const k = buildSection(i, M, atlas);
    if (i === 0) remapBins(k, { grey: 'darkSteel' });
    k.build(s, M, { noShadow: ['mdecal', 'lamps'] });
    boomPivot.add(s);
    sections.push(s);
  }
  const head = buildHead(M, atlas);
  sections[5].add(head);
  // boom floodlight: lights the ground under the head at night
  const spot = new THREE.SpotLight(0xf4f7ff, 0, 90, 0.42, 0.6, 1.2);
  spot.name = 'boomFlood';
  spot.castShadow = false;
  spot.position.set(FLOOD.x + 0.15, FLOOD.y - 0.02, -(SECTION(0).w / 2 + 0.07));
  sections[0].add(spot);
  const spotTarget = new THREE.Object3D();
  spotTarget.position.set(0, -12, 0);
  head.headCamMount.add(spotTarget);
  spot.target = spotTarget;

  // --- instanced chrome rods and beacons
  inst.add('chrome', [{ geometry: unitRodGeometry(), material: M.chrome }], chrome);
  inst.add('beacons', [{ geometry: beaconGeometry(), material: M.beacon }], beacons);

  // ------------------------------------------------------------------ pose API
  const state = { theta: 0, p: [0, 0, 0, 0, 0, 0], dv: 0, dl: 0, sPaid: 0 };
  const parts = {
    root, tip, carrier, ground, wheels, beams, jacks, floats, matSlots, upper, craneCab, driverCab,
    steeringWheel: dc.wheel, boomPivot, sections, head, luffCyl, winch: { drum }, cwSlabs, deckSlabs, bumperAnchor,
    ramRods,
    lights: { beacons, work: [{ spot, material: M.lamps }], beaconMaterial: M.beacon, lampMaterial: M.lamps },
    cameraMounts: { craneEye: cab.eye, driverEye: dc.eye, hookCam: head.headCamMount },
    lods: [carrierLod.lod, upperLod.lod, cab.lod],
    instancer: inst, materials: M, state,

    setCarrierPose(x, y, z, yaw = 0, pitch = 0, roll = 0) {
      carrier.position.set(x, y, z);
      carrier.rotation.set(roll, yaw, pitch);
    },
    // tip-over: T(p0)·R(e, φ)·T(−p0) about the tipping edge (Stability.rootTransform)
    setTip(m4 = null) {
      if (!m4) { tip.matrixAutoUpdate = true; tip.position.set(0, 0, 0); tip.quaternion.identity(); tip.scale.set(1, 1, 1); return; }
      tip.matrixAutoUpdate = false;
      tip.matrix.copy(m4);
      tip.matrixWorldNeedsUpdate = true;
    },
    setSlew(psi) { upper.rotation.y = psi; },
    /**
     * θ = boom angle to the deck (rad), p = [p_0..p_5] section positions (p_0 = 0,
     * L = p_5 + 11.5), dv/dl = head deflection down / left (m, §3.6). Sections are
     * posed on the cantilever curve f(x) = x²(3L − x)/(2L³), so the head lands on
     * (L, −dv, left dl) like headLocal().
     */
    setBoom(theta, p = state.p, dv = state.dv, dl = state.dl) {
      state.theta = theta;
      if (p !== state.p) for (let i = 0; i < 6; i++) state.p[i] = i ? p[i] || 0 : 0;
      state.dv = dv; state.dl = dl;
      boomPivot.rotation.z = theta;
      const L = HEAD_X + state.p[5];
      const f = (x) => { const t = clamp(x, 0, L); return t * t * (3 * L - t) / (2 * L * L * L); };
      for (let i = 0; i < 6; i++) {
        const xr = state.p[i], xf = xr + HEAD_X;
        const yr = -dv * f(xr), yf = -dv * f(xf), zr = -dl * f(xr), zf = -dl * f(xf);
        const s = sections[i];
        s.position.set(xr, yr, zr);
        s.rotation.set(0, -Math.atan2(zf - zr, HEAD_X), Math.atan2(yf - yr, HEAD_X));
      }
      // levelled head items: counter the head's total pitch / yaw
      const s5 = sections[5];
      for (const lv of head.levelled) lv.rotation.set(0, -s5.rotation.y, -(theta + s5.rotation.z));
      // luffing cylinder: A → B (B on the base, following its small deflection)
      const s0 = sections[0], a0 = theta + s0.rotation.z, c = Math.cos(a0), sn = Math.sin(a0);
      const bx0 = s0.position.x * Math.cos(theta) - s0.position.y * Math.sin(theta);
      const by0 = s0.position.x * Math.sin(theta) + s0.position.y * Math.cos(theta);
      const bx = PIVOT.x + bx0 + CYL_B.x * c - CYL_B.y * sn, by = PIVOT.y + by0 + CYL_B.x * sn + CYL_B.y * c;
      const dx = bx - CYL_A.x, dy = by - CYL_A.y, len = Math.hypot(dx, dy);
      barrel.rotation.z = Math.atan2(dy, dx);
      const d = Math.max(0, (len - ROD_RETRACTED) / 4);
      stages.forEach((st, kk) => { st.position.x = ROD.x0 + 0.02 * kk + ROD.len + (kk + 1) * d; });
      rod.position.x = len; // rod eye exactly on B
      luffCyl.length = len;
    },
    setLuff(theta) { parts.setBoom(theta); },
    setTele(p) { parts.setBoom(state.theta, p); },
    pFromExt(ext, out = [0, 0, 0, 0, 0, 0]) {
      out[0] = 0;
      for (let i = 1; i < 6; i++) out[i] = out[i - 1] + STROKE * (ext[i - 1] || 0);
      return out;
    },
    // outriggers: |y| float centre from the carrier centreline (1.25 … 3.50), e = jack extension (m)
    setBeam(i, yAbs) { beams[i].position.z = -FLOATS[i].side * yAbs; },
    setBeamExt(i, e01) { parts.setBeam(i, BASES[0] + (BASES[100] - BASES[0]) * clamp(e01, 0, 1)); },
    setJack(i, e) { jacks[i].position.y = -Math.max(0, e); },
    /**
     * steer[5]: centreline wheel angles (rad, + = left, Vehicle.wheelSteer); spin: rolled
     * angle (rad, + forward); kappa: path curvature (1/m, + left) for per-side Ackermann —
     * estimated from the axle angles (tan δ = (x − x_ref)·κ) when omitted.
     */
    setWheels(steer, spin = 0, kappa = null) {
      let k = kappa;
      if (k === null) {
        let sx = 0, st = 0, sxx = 0, sxt = 0;
        for (let j = 0; j < 5; j++) { const x = C.axleX[j], t = Math.tan(steer[j] || 0); sx += x; st += t; sxx += x * x; sxt += x * t; }
        k = (5 * sxt - sx * st) / (5 * sxx - sx * sx); // slope of tan δ over x = κ
      }
      for (let j = 0; j < 5; j++) {
        const t = Math.tan(steer[j] || 0);
        for (let s = 0; s < 2; s++) {
          const y = s ? -C.tyre.trackY : C.tyre.trackY; // y_c of this wheel (left +)
          const w = wheels[j][s];
          w.rotation.y = Math.abs(k) > 1e-6 ? Math.atan(t / (1 - k * y)) : Math.atan(t);
          w.spin.rotation.z = -spin;
        }
      }
    },
    setSteeringWheel(a) { dc.wheel.rotation.y = -a; },
    setCabTilt(a) { craneCab.rotation.z = clamp(a, 0, AT100.craneCab.tiltMaxDeg * Math.PI / 180); },
    // levers (ISO 7752-2 cross-shift, §6.2): left = slew (x) / tele (away = out); right = luff (left = up) / hoist (back = up)
    setSticks(lv = {}) {
      const kk = 0.35;
      craneCab.leftStick.rotation.set((lv.slew || 0) * kk, 0, -(lv.tele || 0) * kk);
      craneCab.rightStick.rotation.set(-(lv.luff || 0) * kk, 0, (lv.hoist || 0) * kk);
    },
    /**
     * superIds: slabs on the superstructure, top first (e.g. ['A', 'B']); deckIds: slabs on
     * the rear deck, bottom first; raise 0..1 lifts the deck stack to the frame (slew 0).
     */
    setCounterweight(superIds = [], deckIds = [], raise = 0) {
      for (const id of ['A', 'B', 'C']) { cwSlabs[id].visible = false; deckSlabs[id].visible = false; }
      let y = CW_TOP;
      for (const id of superIds) { const h = CW_SLABS[id].h; y -= h; cwSlabs[id].position.set(CW_U, y, 0); cwSlabs[id].visible = true; }
      const superBottom = y; // upper-local
      let hDeck = 0;
      for (const id of deckIds) hDeck += CW_SLABS[id].h;
      const travel = Math.max(0, SLEW_Y + superBottom - (CW_DECK.topZ + hDeck));
      const lift = clamp(raise, 0, 1) * travel;
      let yd = lift;
      for (const id of deckIds) { deckSlabs[id].position.set(0, yd, 0); deckSlabs[id].visible = true; yd += CW_SLABS[id].h; }
      // rams reach the bottom of whatever hangs (or is being raised) — otherwise a short stub
      let bottom = superIds.length ? superBottom : CW_TOP - 0.06;
      if (deckIds.length && raise > 0) bottom = CW_DECK.topZ + lift - SLEW_Y;
      const top = 1.75;
      for (const r of ramRods) { r.scale.y = top - bottom; r.position.y = (top + bottom) / 2; }
    },
    /** kind 'none' | 'carried' | 'composite'; (x, y, z) = world position of the mat's bottom centre */
    setMat(i, kind, x, y, z, yaw = carrier.rotation.y) {
      const s = matSlots[i];
      s.kind = kind;
      s.carried.visible = kind === 'carried';
      s.composite.visible = kind === 'composite';
      if (x !== undefined) { s.position.set(x, y, z); s.rotation.y = yaw; }
      let n = 0;
      for (const m of matSlots) {
        m.stored.visible = m.kind !== 'carried';
        if (m.stored.visible) m.stored.position.set(4.775, DECK_Y + 0.121 * n++, 0.87);
      }
    },
    /** world position of float i's pad bottom centre (updates matrices) */
    floatWorld(i, out = new THREE.Vector3()) {
      root.updateMatrixWorld();
      return floats[i].getWorldPosition(out);
    },
    /** sPaid: rope paid out from the drum (m, §3.5) — turns the drum and the head sheaves */
    setWinch(sPaid) {
      state.sPaid = sPaid;
      drum.rotation.z = -sPaid / DRUM_R;
      head.sheave.rotation.z = -sPaid / SHEAVE.r;
    },
    updateAnemometer(dt, speed) { head.anemometer.rotation.y += speed * dt * 1.8; },
    /** beacons: rotating-beacon flashes; work: lamps (head / tail / work LEDs) + boom flood at night */
    setLights({ t = 0, night = 0, beacons: on = false, work = false } = {}) {
      const flash = Math.pow(Math.max(0, Math.cos(t * TAU * 1.3)), 6);
      M.beacon.emissiveIntensity = on ? 0.4 + 7 * flash : 0.03;
      M.lamps.emissiveIntensity = work ? 2.5 + 4 * night : 0;
      spot.intensity = work && night > 0.3 ? 2600 * night : 0;
    },
    /**
     * Rope exit points on the head sheaves for the falls of `block` (a
     * buildMobileHookBlock group; its userData.fallLocal(n) gives the matching
     * points on the block). Falls hang vertically: each top is on the front
     * (+x of the block) or back of a head sheave at the fall's lateral offset.
     * Call after root.updateMatrixWorld(). out: Vector3[] (grown as needed).
     */
    fallTops(block, out = []) {
      const n = block?.userData?.falls ?? 1;
      const loc = block?.userData?.fallLocal ? block.userData.fallLocal(n) : null;
      head.sheave.getWorldPosition(_c);
      _f.setFromMatrixColumn(upper.matrixWorld, 0).setY(0).normalize(); // boom direction, horizontal
      _a.setFromMatrixColumn(upper.matrixWorld, 2).setY(0).normalize(); // across (= block z)
      for (let kk = 0; kk < n; kk++) {
        const p = loc ? loc[kk] : null;
        const side = p ? (p.x > 1e-4 ? 1 : -1) : 1;
        const z = p ? clamp(p.z, -SHEAVE.pitch * 2, SHEAVE.pitch * 2) : 0;
        (out[kk] ||= new THREE.Vector3()).copy(_c).addScaledVector(_f, side * SHEAVE.r).addScaledVector(_a, z);
      }
      out.length = n;
      return out;
    },
    /** hoist rope from the drum to the head: [drum, base rear roller, base front roller, head sheave top] */
    ropeLead(out = []) {
      for (let i = 0; i < 4; i++) out[i] ||= new THREE.Vector3();
      sections[0].localToWorld(out[1].set(-0.35, TOP_Y, 0));
      sections[0].localToWorld(out[2].set(SECTION(0).front - 0.08, TOP_Y, 0));
      head.localToWorld(out[3].set(SHEAVE.x, SHEAVE.y + SHEAVE.r, 0));
      drum.getWorldPosition(_v);
      _w.subVectors(out[1], _v).normalize();
      out[0].copy(_v).addScaledVector(_w, DRUM_R);
      out.length = 4;
      return out;
    },
    /** kinematic head point (§3.1 (u_h, z_h) incl. the posed deflection), world */
    headWorld(out = new THREE.Vector3()) { return head.getWorldPosition(out); },
  };
  // initial pose: road trim
  parts.setBoom(0, [0, 0, 0, 0, 0, 0], 0, 0);
  for (let i = 0; i < 4; i++) { parts.setBeam(i, BASES[0]); parts.setJack(i, 0); parts.setMat(i, 'none'); }
  parts.setCounterweight([], [], 0);
  parts.setWheels([0, 0, 0, 0, 0], 0, 0);
  return parts;
}
