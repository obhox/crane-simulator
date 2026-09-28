import { SITE } from '../../config.js';
import { Box } from '../../physics/collide.js';
import { box, plane, trs, seg, col } from './kit.js';
import { WOOD } from './materials.js';

// Site boundary: 2.4 m painted plywood hoarding (painted face to the
// street, raw OSB + timber framing and raking kickers inside), vehicle gate
// with two leaves swung open into the site, pedestrian door, project board /
// graphics / ISO safety signage on the street face, Heras mesh fencing round
// the crane base and between the pedestrian route and the vehicle gate.
//
// GAMEPLAY CONTRACT: the four fence colliders are exactly the original ones
// (continuous, gate included); the gate opening is x -34..-26 on z = -58.

const PAINT = col(0x2e4a3d), PAINT_DK = col(0x243a30), CAP = col(0xd9d6cc), POST = WOOD.post;
const GALV = col(0xa9aeb2), FOOT = col(0x2a2a2a);
export const GATE = [-34, -26];

export function buildPerimeter(ctx) {
  const { B, M, world, r } = ctx;
  const fe = SITE.fence;
  const H = 2.4;
  const door = [-37.6, -36.4];

  // runs: [ax, az, bx, bz, interior normal (nx, nz)]
  const runs = [
    [fe.minX, fe.minZ, door[0], fe.minZ, 0, 1],
    [door[1], fe.minZ, GATE[0], fe.minZ, 0, 1],
    [GATE[1], fe.minZ, fe.maxX, fe.minZ, 0, 1],
    [fe.minX, fe.maxZ, fe.maxX, fe.maxZ, 0, -1],
    [fe.minX, fe.minZ, fe.minX, fe.maxZ, 1, 0],
    [fe.maxX, fe.minZ, fe.maxX, fe.maxZ, -1, 0],
  ];
  for (const [ax, az, bx, bz, nx, nz] of runs) hoardingRun(ctx, ax, az, bx, bz, nx, nz, H);

  // colliders — identical to the original site
  const fz = (fe.minZ + fe.maxZ) / 2, fx = (fe.minX + fe.maxX) / 2;
  world.add(new Box(fx, H / 2, fe.minZ, (fe.maxX - fe.minX) / 2, H / 2, 0.1, 0, 'fence'));
  world.add(new Box(fx, H / 2, fe.maxZ, (fe.maxX - fe.minX) / 2, H / 2, 0.1, 0, 'fence'));
  world.add(new Box(fe.minX, H / 2, fz, 0.1, H / 2, (fe.maxZ - fe.minZ) / 2, 0, 'fence'));
  world.add(new Box(fe.maxX, H / 2, fz, 0.1, H / 2, (fe.maxZ - fe.minZ) / 2, 0, 'fence'));

  // ------------------------------------------------------------ vehicle gate
  for (const [hx, yaw] of [[GATE[0] + 0.12, -80 * Math.PI / 180], [GATE[1] - 0.12, -100 * Math.PI / 180]]) {
    B.add(M.paint, box(0.2, 2.9, 0.2), trs(hx - Math.sign(hx - (GATE[0] + GATE[1]) / 2) * 0.02, 1.45, fe.minZ), PAINT_DK);
    const hz = fe.minZ + 0.12;
    const L = 3.85;
    B.within(trs(hx, 0, hz, yaw), () => {
      // frame + solid painted skin (both faces) + diagonal brace + castor
      B.add(M.paint, box(L, 0.08, 0.06), trs(L / 2, 0.12, 0), PAINT_DK);
      B.add(M.paint, box(L, 0.08, 0.06), trs(L / 2, H + 0.05, 0), PAINT_DK);
      for (const x of [0.04, L - 0.04]) B.add(M.paint, box(0.08, H, 0.06), trs(x, H / 2 + 0.1, 0), PAINT_DK);
      B.add(M.paint, box(L - 0.1, H - 0.1, 0.02), trs(L / 2, H / 2 + 0.1, 0), PAINT);
      B.add(M.paint, box(0.06, Math.hypot(L, H) - 0.2, 0.05), trs(L / 2, H / 2 + 0.1, 0.04, 0, 0, -Math.atan2(L, H)), PAINT_DK);
      B.add(M.rubber, box(0.12, 0.16, 0.12), trs(L - 0.25, 0.08, 0), FOOT);
    });
    const c = Math.cos(yaw), s = Math.sin(yaw);
    world.add(new Box(hx + c * L / 2, H / 2 + 0.1, hz - s * L / 2, L / 2, H / 2 + 0.1, 0.06, yaw, 'gate'));
    // signs on the leaves (visible from the street through the opening)
    const sx = hx + c * L * 0.5, sz = hz - s * L * 0.5;
    const nxL = s, nzL = c; // leaf normal (+local z)
    const side = Math.sign(((GATE[0] + GATE[1]) / 2 - hx) * nxL) || 1; // face the gateway
    ctx.sign('entrance', 1.6, 0.8, sx + nxL * 0.03 * side, 1.7, sz + nzL * 0.03 * side, yaw + (side > 0 ? 0 : Math.PI));
  }
  // pedestrian door + wayfinding
  {
    const dx = (door[0] + door[1]) / 2;
    B.add(M.paint, box(0.1, 2.5, 0.12), trs(door[0] + 0.05, 1.25, fe.minZ), PAINT_DK);
    B.add(M.paint, box(0.1, 2.5, 0.12), trs(door[1] - 0.05, 1.25, fe.minZ), PAINT_DK);
    B.add(M.paint, box(door[1] - door[0], 0.1, 0.12), trs(dx, 2.45, fe.minZ), PAINT_DK);
    B.add(M.paint, box(door[1] - door[0] - 0.2, 2.2, 0.04), trs(dx, 1.12, fe.minZ), col(0x3a5a4a));
    B.add(M.steel, box(0.14, 0.03, 0.05), trs(door[1] - 0.25, 1.05, fe.minZ - 0.04), col(0xb0b0b0));
    ctx.sign('pedestrian', 1.2, 0.3, dx, 2.7, fe.minZ - 0.03, Math.PI);
  }

  // ------------------------------------------------------------ street-face graphics & signage (south)
  const zs = fe.minZ - 0.022;
  ctx.sign('board', 3.6, 1.8, -46.0, 1.35, zs, Math.PI);
  ctx.sign('ppe', 1.3, 1.3, -40.3, 1.45, zs, Math.PI);
  ctx.sign('keepout', 1.0, 0.5, -24.2, 1.6, zs, Math.PI);
  ctx.sign('hardhat', 0.4, 0.4, -22.9, 1.6, zs, Math.PI);
  ctx.sign('hivis', 0.4, 0.4, -22.4, 1.6, zs, Math.PI);
  ctx.sign('boots', 0.4, 0.4, -21.9, 1.6, zs, Math.PI);
  ctx.sign('contact', 2.7, 0.9, -12.0, 1.5, zs, Math.PI);
  for (const x of [5.5, 31.0, 56.5]) ctx.sign('banner', 9.6, 2.3, x, 1.2, zs, Math.PI);
  ctx.sign('banner2', 4.8, 1.2, -55.0, 1.5, zs, Math.PI);
  ctx.sign('crane', 0.6, 0.6, 18.5 + 0.2, 1.7, zs, Math.PI);
  // keep-out signs round the other three sides
  for (let x = -50; x < 66; x += 28) ctx.sign('keepout', 1.0, 0.5, x, 1.6, fe.maxZ + 0.022, 0);
  for (let z = -40; z < 66; z += 28) {
    ctx.sign('keepout', 1.0, 0.5, fe.minX - 0.022, 1.6, z, -Math.PI / 2);
    ctx.sign('keepout', 1.0, 0.5, fe.maxX + 0.022, 1.6, z, Math.PI / 2);
  }
  // inside the gate: traffic signs on posts
  signPost(ctx, 'speed', 0.6, 0.6, -24.6, -52.5, Math.PI * 0.95);
  signPost(ctx, 'turning', 1.0, 0.5, -35.0, -44.8, -Math.PI * 0.1);

  // ------------------------------------------------------------ Heras fencing
  // crane base enclosure (±5.5 m, access gap on the west side)
  const e = 5.5;
  herasRun(ctx, -e, -e, e, -e);
  herasRun(ctx, e, -e, e, e);
  herasRun(ctx, e, e, -e, e);
  herasRun(ctx, -e, e, -e, 1.2);
  herasRun(ctx, -e, -1.2, -e, -e);
  ctx.sign('noentry', 0.45, 0.45, e + 0.04, 1.3, 0, Math.PI / 2);
  ctx.sign('crane', 0.45, 0.45, 0, 1.3, -e - 0.04, Math.PI);
  // pedestrian route segregation next to the vehicle gate
  herasRun(ctx, -35.3, fe.minZ + 0.4, -35.3, -47.6);
  void r;
}

function hoardingRun(ctx, ax, az, bx, bz, nx, nz, H) {
  const { B, M, r } = ctx;
  const L = Math.hypot(bx - ax, bz - az);
  if (L < 0.05) return;
  const dx = (bx - ax) / L, dz = (bz - az) / L;
  const yaw = Math.atan2(-dz, dx);
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  const off = (k) => [mx + nx * k, mz + nz * k];
  // painted street face, one box per 1.22 m sheet: hoardings get patch-
  // repainted sheet by sheet, so real ones show a faint tonal checkerboard
  // (a single flat colour over 500 m reads as CG)
  const nS = Math.ceil(L / 1.22);
  for (let i = 0; i < nS; i++) {
    const t0 = i * 1.22, t1 = Math.min(L, t0 + 1.22), tm = (t0 + t1) / 2;
    const k = 0.9 + r() * 0.16, warm = (r() - 0.5) * 0.04;
    const c = PAINT.clone().multiplyScalar(k);
    c.r *= 1 + warm; c.b *= 1 - warm;
    const sx = ax + dx * tm - nx * 0.008, sz = az + dz * tm - nz * 0.008;
    B.add(M.paint, box(t1 - t0, H, 0.012, ax * dx + az * dz + t0, 0), trs(sx, H / 2, sz, yaw), c);
  }
  let [px, pz] = off(0.006);
  B.add(M.osb, box(L, H, 0.012, ax * dx + az * dz, 0), trs(px, H / 2, pz, yaw));
  [px, pz] = off(0.0);
  B.add(M.paint, box(L, 0.05, 0.09), trs(px, H + 0.025, pz, yaw), CAP);
  // sheet joints on the street face (1.22 m sheets)
  const n = Math.floor(L / 1.22);
  for (let i = 1; i <= n; i++) {
    const t = i * 1.22;
    if (t > L - 0.05) break;
    const jx = ax + dx * t - nx * 0.016, jz = az + dz * t - nz * 0.016;
    B.add(M.paint, box(0.018, H - 0.02, 0.006), trs(jx, H / 2, jz, yaw), PAINT_DK);
  }
  // timber posts + rails + raking kickers on the site side
  const np = Math.max(1, Math.round(L / 2.44));
  for (let i = 0; i <= np; i++) {
    const t = (i / np) * L;
    const x = ax + dx * t + nx * 0.07, z = az + dz * t + nz * 0.07;
    B.add(M.wood, box(0.1, H + 0.05, 0.1), trs(x, (H + 0.05) / 2, z, yaw), POST);
    if (i % 2 === 0 && i > 0 && i < np) {
      const gx = x + nx * 1.3, gz = z + nz * 1.3;
      B.add(M.wood, box(1, 1, 1), seg(x + nx * 0.05, 1.8, z + nz * 0.05, gx, 0.02, gz, 0.07, 0.045), POST);
      B.add(M.wood, box(0.06, 0.4, 0.06), trs(gx, 0.1, gz, r()), POST);
    }
  }
  for (const y of [0.35, 1.3, 2.2]) {
    const [rx, rz] = off(0.045);
    B.add(M.wood, box(L, 0.1, 0.05), trs(rx, y, rz, yaw), POST);
  }
}

// Heras-style temporary fence: 3.5 x 2.0 m welded-mesh panels in rubber feet.
export function herasRun(ctx, ax, az, bx, bz) {
  const { B, M, world } = ctx;
  const L = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.round(L / 3.5));
  const yaw = Math.atan2(-(bz - az), bx - ax);
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
    const pl = Math.hypot(x1 - x0, z1 - z0) - 0.06;
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    B.add(M.mesh, plane(pl - 0.05, 1.85), trs(mx, 1.1, mz, yaw), GALV);
    ctx.tube(x0 + (x1 - x0) * 0.01, 0.12, z0 + (z1 - z0) * 0.01, x0 + (x1 - x0) * 0.01, 2.08, z0 + (z1 - z0) * 0.01, 0.019);
    ctx.tube(x1 - (x1 - x0) * 0.01, 0.12, z1 - (z1 - z0) * 0.01, x1 - (x1 - x0) * 0.01, 2.08, z1 - (z1 - z0) * 0.01, 0.019);
    ctx.tube(x0, 2.05, z0, x1, 2.05, z1, 0.019);
    ctx.tube(x0, 0.16, z0, x1, 0.16, z1, 0.019);
    B.add(M.rubber, box(0.62, 0.14, 0.2), trs(x0, 0.07, z0, yaw + Math.PI / 2), FOOT);
    if (i === n - 1) B.add(M.rubber, box(0.62, 0.14, 0.2), trs(x1, 0.07, z1, yaw + Math.PI / 2), FOOT);
    ctx.coupler(x0, 1.9, z0);
    ctx.coupler(x0, 0.4, z0);
  }
  world.add(new Box((ax + bx) / 2, 1.05, (az + bz) / 2, L / 2, 1.05, 0.08, yaw, 'fence'));
}

function signPost(ctx, key, w, h, x, z, yaw) {
  const { B, M, world } = ctx;
  B.add(M.paint, box(0.06, 2.4, 0.06), trs(x, 1.2, z), col(0x6f7478));
  B.add(M.precast, box(0.5, 0.2, 0.5), trs(x, 0.1, z));
  ctx.sign(key, w, h, x + Math.sin(yaw) * 0.04, 2.4 - h / 2, z + Math.cos(yaw) * 0.04, yaw);
  world.add(new Box(x, 1.2, z, 0.25, 1.2, 0.25, 0, 'sign'));
}
