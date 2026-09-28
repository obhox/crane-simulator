import * as THREE from 'three';
import { Box } from '../../physics/collide.js';
import { box, cyl, plane, prism, lathe, trs, seg, col, solid } from './kit.js';
import { makeCanvas, canvasTexture, noiseField } from '../textures.js';
import { WOOD } from './materials.js';

// Site plant: concrete mixer truck, tractor + flatbed trailer (delivery),
// a parked 20 t tracked excavator by its spoil heap and a telehandler.
// Vehicles are built in their own local frame (+x forward) and merged into
// the site batches. Mud comes from the world-space grime shader on the
// vehicle materials (heaviest round the wheels, spatter above).
//
// GAMEPLAY CONTRACT: mixer (-20,0,-30) rot 0.35 and flatbed (6,0,-22)
// rot -0.15 keep their positions and colliders; the trailer bed top is at
// y = 1.34 (loads spawn on it).

const DARK = col(0x2d3135), TYRE = col(0x1c1c1c), RIM = col(0xb9bcbf), CHROME = col(0xd0d4d8);
const LAMP_W = col(0xf2f2ea), LAMP_A = col(0xff9a1a), LAMP_R = col(0xb3140c);

export function buildVehicles(ctx) {
  const truckDrum = mixerTruck(ctx, -20, -30, 0.35);
  ctx.world.add(new Box(-20, 1.6, -30, 4.4, 1.6, 1.3, 0.35, 'truck'));
  flatbed(ctx, 6, -22, -0.15);
  ctx.world.add(new Box(6 - 1.2 * Math.cos(-0.15), 0.67, -22 + 1.2 * Math.sin(-0.15), 6.25, 0.67, 1.25, -0.15, 'truck'));
  ctx.world.add(new Box(6 + 6.2 * Math.cos(-0.15), 1.9, -22 - 6.2 * Math.sin(-0.15), 1.1, 1.9, 1.25, -0.15, 'truck'));
  excavator(ctx, 51.5, 49.0, -0.3, -0.6); // arm swung round to the spoil heap
  spoilHeap(ctx, 58.2, 57.4);
  telehandler(ctx, 58.6, 21.5, -Math.PI / 2);
  return { truckDrum };
}

// ------------------------------------------------------------------ parts
function wheel(ctx, x, y, z, r, w, dual = false, rimCol = RIM) {
  const { B, M } = ctx;
  const tyre = lathe([[r * 0.62, -w / 2], [r * 0.92, -w / 2], [r, -w * 0.38], [r, w * 0.38], [r * 0.92, w / 2], [r * 0.62, w / 2]], 20);
  tyre.rotateX(Math.PI / 2);
  const hub = cyl(r * 0.62, r * 0.62, w * 0.8, 14);
  hub.rotateX(Math.PI / 2);
  const cap = cyl(r * 0.22, r * 0.22, w * 0.84, 10);
  cap.rotateX(Math.PI / 2);
  const offs = dual ? [-w * 0.52, w * 0.52] : [0];
  for (const o of offs) {
    B.add(M.rubber, tyre, trs(x, y, z + o), TYRE);
    B.add(M.paintVeh, hub, trs(x, y, z + o), rimCol);
  }
  B.add(M.steel, cap, trs(x, y, z + (dual ? 0 : 0) + Math.sign(z) * w * 0.05), CHROME);
}

// Cab-over cab from a side profile, plus glazing, grille, lights, mirrors.
function cab(ctx, x0, y0, L, H, W, color, { high = false } = {}) {
  const { B, M } = ctx;
  const prof = [[0, 0], [L, 0], [L, H * 0.46], [L - 0.1, H * 0.88], [L - 0.28, H], [0, H]];
  B.add(M.paintVeh, prism(prof.map(([px, py]) => [x0 + px, y0 + py]), W), null, color);
  // windscreen (raked) + side windows
  const wsH = H * 0.4, wsY = y0 + H * 0.67, rake = Math.atan2(0.1, H * 0.42);
  B.add(M.glass, plane(W - 0.2, wsH), trs(x0 + L - 0.045, wsY, 0, Math.PI / 2, 0, 0).multiply(trs(0, 0, 0, 0, -rake)));
  for (const s of [-1, 1]) {
    B.add(M.glass, plane(0.85, H * 0.34), trs(x0 + L - 0.62, y0 + H * 0.68, s * (W / 2 + 0.005), s > 0 ? 0 : Math.PI));
    // door seam + handle + step
    B.add(M.paintVeh, box(0.02, H * 0.8, 0.01), trs(x0 + L - 1.15, y0 + H * 0.45, s * (W / 2 + 0.006)), DARK);
    B.add(M.steel, box(0.16, 0.03, 0.03), trs(x0 + L - 1.05, y0 + H * 0.5, s * (W / 2 + 0.02)), CHROME);
    for (const sy of [-0.45, -0.1]) B.add(M.paint, box(0.45, 0.05, 0.25), trs(x0 + L - 0.65, y0 + sy, s * (W / 2 - 0.08)), DARK);
    // mirror arm + head
    B.add(M.paint, box(0.05, 0.05, 0.35), trs(x0 + L - 0.2, y0 + H * 0.78, s * (W / 2 + 0.17)), DARK);
    B.add(M.paint, box(0.08, 0.42, 0.22), trs(x0 + L - 0.15, y0 + H * 0.7, s * (W / 2 + 0.36)), DARK);
    B.add(M.plastic, box(0.04, 0.14, 0.3), trs(x0 + L + 0.02, y0 + 0.28, s * (W / 2 - 0.35)), LAMP_W);
    B.add(M.plastic, box(0.04, 0.08, 0.12), trs(x0 + L + 0.02, y0 + 0.28, s * (W / 2 - 0.12)), LAMP_A);
  }
  // grille, bumper, sun visor, roof beacon
  B.add(M.paint, box(0.03, H * 0.3, W * 0.62), trs(x0 + L + 0.01, y0 + H * 0.28, 0), DARK);
  for (let i = 0; i < 5; i++) B.add(M.paint, box(0.02, 0.02, W * 0.6), trs(x0 + L + 0.03, y0 + H * 0.16 + i * 0.07, 0), col(0x55595e));
  B.add(M.paint, box(0.22, 0.32, W + 0.05), trs(x0 + L + 0.05, y0 - 0.05, 0), col(0x46494d));
  B.add(M.paintVeh, box(0.3, 0.05, W - 0.1), trs(x0 + L - 0.02, y0 + H + 0.01, 0, 0, 0, -0.2), color);
  if (high) B.add(M.paintVeh, prism([[0, 0], [1.3, 0], [1.3, 0.1], [0.2, 0.55], [0, 0.55]].map(([px, py]) => [x0 + 0.25 + px, y0 + H + py]), W - 0.3), null, color);
  B.add(M.plastic, cyl(0.08, 0.1, 0.14, 10), trs(x0 + 0.5, y0 + H + (high ? 0.6 : 0.07), 0), LAMP_A);
}

function mudguard(ctx, x, y, z, len, w) {
  ctx.B.add(ctx.M.plastic, box(len, 0.04, w), trs(x, y, z), col(0x161616));
  ctx.B.add(ctx.M.plastic, box(0.04, 0.35, w), trs(x - len / 2, y - 0.17, z), col(0x161616));
}

// ------------------------------------------------------------------ mixer
function drumTexture() {
  const W = 512, H = 256;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#e9e7e1';
  g.fillRect(0, 0, W, H);
  // spiral stripes (read as rotation when the drum turns)
  g.fillStyle = '#d4561c';
  for (let i = -4; i < 8; i++) {
    g.beginPath();
    g.moveTo(i * 128, H); g.lineTo(i * 128 + 64, H); g.lineTo(i * 128 + 64 + 256, 0); g.lineTo(i * 128 + 256, 0);
    g.fill();
  }
  // concrete crust + drips round the charging opening (v ~ 0 = rear)
  const f = noiseField(128, 8, 4, 5151);
  const img = g.getImageData(0, 0, W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const n = f[(y % 128) * 128 + (x % 128)];
      const rear = 1 - y / H; // canvas top = v 1 (front)
      const crust = Math.max(0, (y / H - 0.72) * 3.2) + (n - 0.5) * 0.6;
      const drip = (n > 0.62 ? 0.35 : 0) * (y / H);
      const k = Math.min(1, Math.max(0, crust + drip));
      img.data[i] = img.data[i] * (1 - k) + 150 * k;
      img.data[i + 1] = img.data[i + 1] * (1 - k) + 147 * k;
      img.data[i + 2] = img.data[i + 2] * (1 - k) + 140 * k;
      const dirt = 0.85 + n * 0.2;
      img.data[i] *= dirt; img.data[i + 1] *= dirt; img.data[i + 2] *= dirt;
      void rear;
    }
  }
  g.putImageData(img, 0, 0);
  return canvasTexture(c);
}

function mixerTruck(ctx, x, z, yaw) {
  const { B, M, root } = ctx;
  const WHITE = col(0xe9e9e4);
  B.within(trs(x, 0, z, yaw), () => {
    // chassis
    for (const s of [-1, 1]) B.add(M.paint, box(8.2, 0.28, 0.1), trs(-0.1, 0.95, s * 0.45), DARK);
    for (let i = 0; i < 5; i++) B.add(M.paint, box(0.1, 0.2, 0.9), trs(-3.6 + i * 1.8, 0.95, 0), DARK);
    // wheels: steer + rear tandem duals
    for (const s of [-1, 1]) {
      wheel(ctx, 3.2, 0.52, s * 1.02, 0.52, 0.32);
      wheel(ctx, -1.6, 0.52, s * 0.93, 0.52, 0.3, true);
      wheel(ctx, -3.0, 0.52, s * 0.93, 0.52, 0.3, true);
      mudguard(ctx, -2.3, 1.14, s * 0.95, 2.4, 0.66);
      mudguard(ctx, 3.2, 1.14, s * 1.02, 1.1, 0.4);
      // side guard rails, fuel tank, tool box
      for (const yy of [0.62, 0.9]) B.add(M.paint, box(2.2, 0.06, 0.04), trs(1.0, yy, s * 1.18), col(0x8d9296));
    }
    const tank = cyl(0.3, 0.3, 0.9, 14);
    tank.rotateZ(Math.PI / 2);
    B.add(M.steel, tank, trs(1.2, 0.78, -0.95), col(0xa9adb0));
    B.add(M.paint, box(0.7, 0.45, 0.4), trs(1.2, 0.78, 0.95), DARK);
    cab(ctx, 2.25, 1.05, 2.15, 2.05, 2.45, WHITE);
    // exhaust + water tank behind the cab
    B.add(M.steel, cyl(0.07, 0.07, 1.8, 10), trs(2.12, 2.2, 1.05), col(0x6b6b6b));
    const wt = cyl(0.38, 0.38, 1.4, 16);
    wt.rotateX(Math.PI / 2);
    B.add(M.paintVeh, wt, trs(1.75, 1.75, 0), WHITE);
    // drum supports: front pedestal (gearbox) + rear roller frame
    B.add(M.paint, box(0.4, 1.0, 0.8), trs(1.25, 1.6, 0), DARK);
    for (const s of [-1, 1]) B.add(M.paint, box(0.15, 1.6, 0.15), trs(-3.35, 1.8, s * 0.7, 0, 0, 0), DARK);
    B.add(M.paint, box(0.2, 0.15, 1.6), trs(-3.35, 2.55, 0), DARK);
    // hopper + chute + ladder at the rear
    B.add(M.paintVeh, lathe([[0.22, 0], [0.55, 0.55], [0.6, 0.6], [0.52, 0.58], [0.2, 0.05]], 14), trs(-4.05, 3.05, 0), WHITE);
    B.add(M.paintVeh, prism([[0, 0], [0.35, 0], [0.35, 0.08], [0, 0.08]], 0.5), trs(-4.3, 2.55, 0, 0, 0, -0.6), WHITE);
    B.add(M.paint, box(0.9, 0.08, 0.35), trs(-4.2, 2.35, 0, 0.2, 0, -1.0), col(0x8d9296));
    for (const s of [-1, 1]) B.add(M.paint, box(0.05, 2.6, 0.05), trs(-4.35, 1.4, s * 0.25, 0, 0, 0.12), col(0x8d9296));
    for (let i = 0; i < 7; i++) B.add(M.paint, box(0.04, 0.04, 0.5), trs(-4.28 - i * 0.045, 0.4 + i * 0.35, 0), col(0x8d9296));
    // tail lights
    for (const s of [-1, 1]) B.add(M.plastic, box(0.04, 0.12, 0.28), trs(-4.25, 0.95, s * 1.0), LAMP_R);
  });
  // rotating drum (separate mesh): lathe profile along its axis
  // ordered rear → front so LatheGeometry's normals face outwards
  const prof = [[0.36, -2.66], [0.43, -2.7], [0.52, -2.58], [1.12, -0.8], [1.18, -0.35], [1.14, 0.35], [0.62, 2.42], [0.34, 2.68], [0.001, 2.72]];
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 28);
  g.rotateZ(-Math.PI / 2); // axis → +x (front), rear opening at -x
  const mat = new THREE.MeshStandardMaterial({ map: drumTexture(), roughness: 0.55, metalness: 0.25 });
  mat.name = 'drum';
  const drum = new THREE.Mesh(g, mat);
  drum.castShadow = drum.receiveShadow = true;
  const pivot = new THREE.Group();
  pivot.position.set(x, 0, z);
  pivot.rotation.y = yaw;
  const tilt = new THREE.Group();
  tilt.position.set(-1.25, 2.55, 0);
  tilt.rotation.z = -0.2;
  tilt.add(drum);
  // fixed dark opening disc inside the rear cone
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.4, 16), new THREE.MeshStandardMaterial({ color: 0x3a3a38, roughness: 1 }));
  hole.rotation.y = -Math.PI / 2;
  hole.position.x = -2.6;
  tilt.add(hole);
  pivot.add(tilt);
  root.add(pivot);
  return drum;
}

// ------------------------------------------------------------------ flatbed
function flatbed(ctx, x, z, yaw) {
  const { B, M } = ctx;
  const BLUE = col(0x1f4e8c), DECKW = WOOD.hardwood, RAIL = col(0x3a3f45);
  B.within(trs(x, 0, z, yaw), () => {
    // trailer: timber deck (top exactly 1.34), side rails, stake pockets
    B.add(M.wood, box(12.5, 0.06, 2.46, -7.45, 0), trs(-1.2, 1.31, 0), DECKW);
    for (const s of [-1, 1]) {
      B.add(M.paint, box(12.5, 0.22, 0.07), trs(-1.2, 1.23, s * 1.215), RAIL);
      for (let px = -7.2; px < 5; px += 1.0) B.add(M.paint, box(0.08, 0.14, 0.05), trs(px, 1.18, s * 1.26), RAIL);
    }
    B.add(M.paint, box(0.08, 1.15, 2.46), trs(5.0, 1.34 + 0.575, 0), RAIL); // headboard
    for (let i = 0; i < 4; i++) B.add(M.paint, box(0.1, 0.05, 2.4), trs(5.0, 1.5 + i * 0.28, 0), col(0x4a5058));
    for (const s of [-1, 1]) B.add(M.paint, box(12.2, 0.4, 0.12), trs(-1.2, 1.0, s * 0.5), RAIL);
    for (let i = 0; i < 8; i++) B.add(M.paint, box(0.08, 0.2, 1.9), trs(-7.1 + i * 1.7, 1.1, 0), RAIL);
    // tri-axle + landing legs + side guards
    for (const ax of [-4.5, -5.8, -7.1]) for (const s of [-1, 1]) wheel(ctx, ax, 0.5, s * 1.0, 0.5, 0.38);
    for (const s of [-1, 1]) {
      B.add(M.plastic, box(3.9, 0.04, 0.5), trs(-5.8, 1.12, s * 1.0), col(0x161616));
      B.add(M.paint, box(0.12, 0.8, 0.12), trs(2.2, 0.75, s * 0.85), RAIL);
      B.add(M.paint, box(0.25, 0.04, 0.25), trs(2.2, 0.33, s * 0.85), RAIL);
      for (const yy of [0.55, 0.85]) B.add(M.paint, box(4.8, 0.05, 0.04), trs(-1.3, yy, s * 1.2), col(0x9aa0a5));
      B.add(M.plastic, box(0.05, 0.14, 0.4), trs(-7.46, 1.02, s * 0.9), LAMP_R);
    }
    B.add(M.paint, box(0.15, 0.15, 2.4), trs(-7.4, 0.62, 0), col(0x9aa0a5));
    // tractor unit
    for (const s of [-1, 1]) B.add(M.paint, box(6.4, 0.26, 0.1), trs(4.1, 0.85, s * 0.45), DARK);
    B.add(M.paint, box(1.1, 0.12, 1.3), trs(3.2, 1.16, 0), DARK); // fifth wheel
    wheel(ctx, 5.6, 0.52, 1.02, 0.52, 0.32, false);
    wheel(ctx, 5.6, 0.52, -1.02, 0.52, 0.32, false);
    wheel(ctx, 3.2, 0.52, 0.93, 0.52, 0.3, true);
    wheel(ctx, 3.2, 0.52, -0.93, 0.52, 0.3, true);
    for (const s of [-1, 1]) {
      mudguard(ctx, 3.2, 1.12, s * 0.95, 1.2, 0.66);
      mudguard(ctx, 5.6, 1.14, s * 1.02, 1.1, 0.4);
    }
    const tank = cyl(0.32, 0.32, 1.2, 14);
    tank.rotateZ(Math.PI / 2);
    B.add(M.steel, tank, trs(4.3, 0.78, -1.0), col(0xb3b7ba));
    B.add(M.paint, box(1.1, 0.5, 0.45), trs(4.3, 0.8, 1.0), DARK);
    cab(ctx, 5.1, 1.1, 2.2, 2.2, 2.48, BLUE, { high: true });
    B.add(M.steel, cyl(0.07, 0.07, 2.0, 10), trs(5.0, 2.3, 1.1), CHROME);
  });
}

// ------------------------------------------------------------------ excavator
function trackTexture() {
  const c = makeCanvas(64, 64);
  const g = c.getContext('2d');
  g.fillStyle = '#3a3835'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#23211f'; g.fillRect(0, 0, 10, 64);
  g.fillStyle = '#56524c'; g.fillRect(12, 0, 6, 64);
  const t = canvasTexture(c);
  t.repeat.set(1 / 0.19, 1);
  return t;
}

function stadium(L, H, n = 8) {
  const r = H / 2, pts = [];
  for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI; pts.push([L / 2 - r + Math.cos(a) * r, r + Math.sin(a) * r]); }
  for (let i = 0; i <= n; i++) { const a = Math.PI / 2 + (i / n) * Math.PI; pts.push([-L / 2 + r + Math.cos(a) * r, r + Math.sin(a) * r]); }
  return pts;
}

function excavator(ctx, x, z, yaw, upper) {
  const { B, M, world } = ctx;
  const YEL = col(0xe3a300), CW = col(0x2f3236);
  if (!M.track) {
    M.track = new THREE.MeshStandardMaterial({ map: trackTexture(), roughness: 0.9, metalness: 0.3 });
    M.track.name = 'track';
  }
  B.within(trs(x, 0, z, yaw), () => {
    for (const s of [-1, 1]) {
      B.add(M.track, prism(stadium(4.3, 0.86), 0.6), trs(0, 0, s * 1.1));
      B.add(M.paintWorn, box(3.2, 0.34, 0.2), trs(0, 0.48, s * 0.85), CW);
      for (const px of [-1.2, -0.4, 0.4, 1.2]) {
        const rr = cyl(0.11, 0.11, 0.62, 10);
        rr.rotateX(Math.PI / 2);
        B.add(M.steel, rr, trs(px, 0.15, s * 1.1), col(0x4a4a4a));
      }
    }
    B.add(M.paintWorn, box(2.2, 0.5, 1.6), trs(0, 0.65, 0), CW);
    B.add(M.paintWorn, cyl(0.75, 0.75, 0.25, 18), trs(0, 1.02, 0), CW);
    // upper structure, slewed
    B.within(trs(0, 0, 0, upper), () => {
      B.add(M.paintWorn, box(2.9, 0.95, 2.5), trs(-0.35, 1.62, 0), YEL);
      B.add(M.paintWorn, box(1.6, 0.35, 1.2), trs(-0.9, 2.26, 0.55), YEL);
      const cwGeo = cyl(0.55, 0.55, 2.5, 16, false);
      cwGeo.rotateX(Math.PI / 2);
      B.add(M.paintWorn, cwGeo, trs(-1.8, 1.55, 0, 0, 0, 0, 1, 1, 1), CW);
      B.add(M.paintWorn, box(0.6, 1.1, 2.5), trs(-1.75, 1.55, 0), CW);
      B.add(M.steel, cyl(0.06, 0.06, 0.55, 8), trs(-1.2, 2.55, 0.9), col(0x333333));
      for (const zz of [0.2, 1.1]) ctx.tube(-1.6, 2.5, zz, -0.2, 2.5, zz, 0.018);
      // cab (left side)
      const cx0 = 0.2, cx1 = 1.3, cz0 = -1.25, cz1 = -0.3, cy0 = 1.2, cy1 = 3.05;
      B.add(M.paintWorn, box(cx1 - cx0, cy1 - cy0, cz1 - cz0), trs((cx0 + cx1) / 2, (cy0 + cy1) / 2, (cz0 + cz1) / 2), YEL);
      B.add(M.glass, plane(cz1 - cz0 - 0.12, 1.2), trs(cx1 + 0.006, 2.35, (cz0 + cz1) / 2, Math.PI / 2));
      B.add(M.glass, plane(cx1 - cx0 - 0.2, 1.1), trs((cx0 + cx1) / 2 + 0.05, 2.4, cz0 - 0.006, Math.PI));
      B.add(M.glass, plane(cx1 - cx0 - 0.5, 1.0), trs((cx0 + cx1) / 2 + 0.2, 2.45, cz1 + 0.006));
      B.add(M.paint, box(cx1 - cx0 + 0.06, 0.05, cz1 - cz0 + 0.06), trs((cx0 + cx1) / 2, cy1, (cz0 + cz1) / 2), DARK);
      // boom / stick / bucket (parked: bucket resting on the ground)
      const foot = [1.15, 1.75, 0.15], knee = [3.6, 4.05, 0.15], tip = [5.35, 0.95, 0.15];
      B.add(M.paintWorn, box(1, 1, 1), seg(...foot, ...knee, 0.62, 0.5), YEL);
      B.add(M.paintWorn, box(1, 1, 1), seg(...knee, ...tip, 0.45, 0.4), YEL);
      B.add(M.paintWorn, cyl(0.28, 0.28, 0.52, 12).rotateX(Math.PI / 2), trs(...knee), YEL);
      // hydraulic rams: barrel (painted) + chrome rod
      const ram = (a, b, rb, rr) => {
        const m = [a[0] + (b[0] - a[0]) * 0.55, a[1] + (b[1] - a[1]) * 0.55, a[2] + (b[2] - a[2]) * 0.55];
        B.add(M.paintWorn, cyl(1, 1, 1, 10), seg(...a, ...m, rb), YEL);
        B.add(M.steel, cyl(1, 1, 1, 8), seg(...m, ...b, rr), CHROME);
      };
      ram([1.55, 1.35, -0.12], [2.55, 3.05, -0.12], 0.1, 0.06);
      ram([1.55, 1.35, 0.42], [2.55, 3.05, 0.42], 0.1, 0.06);
      ram([2.7, 3.75, 0.15], [3.95, 4.55, 0.15], 0.1, 0.06);
      ram([3.95, 3.7, 0.15], [5.05, 1.7, 0.15], 0.08, 0.05);
      // bucket
      const bk = [[0, 0.75], [0.1, 0.2], [0.45, 0], [1.0, 0.05], [1.12, 0.3], [0.95, 0.35], [0.5, 0.15], [0.3, 0.3], [0.25, 0.8]];
      B.add(M.paintWorn, prism(bk.map(([px, py]) => [tip[0] - 0.3 + px, py]), 1.05), trs(0, 0, 0.15), CW);
      for (let t = -0.4; t <= 0.41; t += 0.2) B.add(M.steel, box(0.18, 0.05, 0.08), trs(tip[0] + 0.85, 0.05, 0.15 + t), col(0x55595e));
    });
  });
  // colliders: undercarriage + house, and the arm
  solid(world, x, z, yaw, 0, 1.5, 0, 2.4, 1.5, 1.45, 'plant');
  const c = Math.cos(yaw + upper), s = Math.sin(yaw + upper);
  world.add(new Box(x + 3.3 * c, 2.3, z - 3.3 * s, 2.2, 2.3, 0.45, yaw + upper, 'plant'));
}

function spoilHeap(ctx, x, z) {
  const { B, M, world, r } = ctx;
  // polar grid with a noisy dome
  const rings = 8, segs = 28, pos = [], idx = [];
  pos.push(0, 1.9, 0);
  for (let i = 1; i <= rings; i++) {
    const rr = (i / rings) * 4.6;
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const t = i / rings;
      const h = Math.max(0, 1.9 * (1 - t * t) * (0.85 + r() * 0.3) + (r() - 0.5) * 0.15 * (1 - t));
      pos.push(Math.cos(a) * rr * (0.9 + r() * 0.2), i === rings ? 0.02 : h, Math.sin(a) * rr * (0.85 + r() * 0.2));
    }
  }
  for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 1; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = 1 + (i - 1) * segs + j, b = 1 + (i - 1) * segs + ((j + 1) % segs);
      const c = a + segs, d = b + segs;
      idx.push(a, b, d, a, d, c);
    }
  }
  const heap = new THREE.BufferGeometry();
  heap.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const uv = [];
  for (let i = 0; i < pos.length; i += 3) uv.push(pos[i], pos[i + 2]);
  heap.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  heap.setIndex(idx);
  heap.computeVertexNormals();
  B.add(M.dirt, heap, trs(x, 0, z, 0.4));
  world.add(new Box(x, 0.75, z, 3.0, 0.75, 3.0, 0.4, 'spoil'));
}

// ------------------------------------------------------------------ telehandler
function telehandler(ctx, x, z, yaw) {
  const { B, M } = ctx;
  const BODY = col(0xb3261e), BOOM = col(0xb3261e);
  B.within(trs(x, 0, z, yaw), () => {
    B.add(M.paintVeh, box(4.4, 0.6, 1.3), trs(0, 0.95, 0), DARK);
    for (const px of [-1.45, 1.45]) for (const s of [-1, 1]) {
      wheel(ctx, px, 0.62, s * 0.98, 0.62, 0.46, false, col(0xb3261e));
      B.add(M.paintVeh, box(1.3, 0.06, 0.55), trs(px, 1.3, s * 0.98), BODY);
    }
    // engine cover (right), cab (left)
    B.add(M.paintVeh, box(2.2, 0.75, 0.62), trs(-0.7, 1.62, 0.78), BODY);
    const c0 = -0.55, c1 = 0.85, z0 = -1.2, z1 = -0.35, y0 = 1.3, y1 = 2.55;
    for (const [px, pz] of [[c0, z0], [c1, z0], [c1, z1], [c0, z1]]) B.add(M.paint, box(0.06, y1 - y0, 0.06), trs(px, (y0 + y1) / 2, pz), DARK);
    B.add(M.paintVeh, box(c1 - c0 + 0.1, 0.08, z1 - z0 + 0.1), trs((c0 + c1) / 2, y1, (z0 + z1) / 2), BODY);
    B.add(M.glass, plane(c1 - c0 - 0.08, y1 - y0 - 0.2), trs((c0 + c1) / 2, (y0 + y1) / 2 + 0.05, z0 - 0.005, Math.PI));
    B.add(M.glass, plane(z1 - z0 - 0.08, y1 - y0 - 0.25), trs(c1 + 0.005, (y0 + y1) / 2 + 0.05, (z0 + z1) / 2, Math.PI / 2));
    B.add(M.paintVeh, box(c1 - c0, 0.5, z1 - z0), trs((c0 + c1) / 2, y0 + 0.25, (z0 + z1) / 2), BODY);
    // boom (retracted, forks down) + carriage
    B.add(M.paintVeh, box(1, 1, 1), seg(-1.9, 1.95, 0.12, 2.3, 1.5, 0.12, 0.42, 0.4), BOOM);
    B.add(M.paintVeh, box(1, 1, 1), seg(2.2, 1.51, 0.12, 2.75, 1.45, 0.12, 0.34, 0.32), col(0x2f3236));
    B.add(M.paint, box(0.1, 1.0, 1.2), trs(2.95, 0.75, 0.12), DARK);
    for (const s of [-0.4, 0.4]) {
      B.add(M.steel, box(1.2, 0.05, 0.12), trs(3.6, 0.06, 0.12 + s), col(0x3a3a3a));
      B.add(M.steel, box(0.05, 0.9, 0.12), trs(3.02, 0.5, 0.12 + s), col(0x3a3a3a));
    }
    B.add(M.paintVeh, cyl(1, 1, 1, 10), seg(-0.6, 1.3, 0.12, 0.6, 1.72, 0.12, 0.08), BOOM);
    B.add(M.plastic, cyl(0.07, 0.08, 0.12, 10), trs((c0 + c1) / 2, y1 + 0.1, (z0 + z1) / 2), LAMP_A);
  });
  solid(ctx.world, x, z, yaw, 0.4, 1.3, 0, 2.9, 1.3, 1.3, 'plant');
}
