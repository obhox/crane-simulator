import * as THREE from 'three';
import { Box } from '../../physics/collide.js';
import { box, cyl, plane, prism, lathe, trs, col, colored, modelInstances, InstBatch } from './kit.js';
import { WOOD, lin } from './materials.js';

// Welfare compound, plant and materials storage round the edges of the
// site. Everything solid gets a collider; nothing tall goes into the open
// yard, lay-down areas, bucket spot, barrel ring or corridor course.

const DARK = col(0x33383d), STEEL_BLUE = col(0x44596b), CABIN_W = col(0xd2d3ce), FRAME = col(0x3b4046);
const UPVC = col(0xe9e9e4), TIMBER = WOOD.weathered, PALLET = WOOD.pallet, YEL = col(0xe0a800);
const WHITE = col(0xeeeeea), RED = col(0xc0281c), CONE = col(0xff5a0a);

export function buildYard(ctx) {
  const { B, M, world, r, q } = ctx;
  const low = q.name === 'low';

  cabins(ctx);
  toilets(ctx);
  skip(ctx, -44, 30, 0, false);
  world.add(new Box(-44, 0.8, 30, 1.8, 0.8, 0.95, 0, 'skip'));
  skip(ctx, -54, 56, 0.25, true);
  world.add(new Box(-54, 0.95, 56, 3.1, 0.95, 1.3, 0.25, 'skip'));

  // ------------------------------------------------------------ pipe stack (original collider)
  {
    const px = -46, pz = 8;
    for (const dx of [-2.3, 0, 2.3]) B.add(M.wood, box(0.12, 0.12, 2.2), trs(px + dx, 0.06, pz + 0.2), TIMBER);
    for (let i = 0; i < 5; i++) {
      const y = 0.12 + 0.3 + (i > 2 ? 0.52 : 0);
      const z = pz - 1.2 + (i % 3) * 0.62 + (i > 2 ? 0.31 : 0) + 0.2;
      const g = cyl(0.3, 0.3, 6, 16);
      g.rotateZ(Math.PI / 2);
      B.add(M.paint, g, trs(px, y, z), col(0x3a3f45));
      for (const e of [-3.005, 3.005]) {
        const cap = new THREE.CircleGeometry(0.26, 14);
        cap.rotateY(e > 0 ? Math.PI / 2 : -Math.PI / 2);
        B.add(M.rubber, cap, trs(px + e, y, z), col(0x0c0c0c));
      }
    }
    world.add(new Box(-46, 0.6, 8.2, 3, 0.6, 1.0, 0, 'stack'));
  }
  // ------------------------------------------------------------ precast manhole rings
  {
    const ring = lathe([[0.63, 0], [0.75, 0], [0.75, 0.98], [0.72, 1.0], [0.66, 1.0], [0.63, 0.98], [0.63, 0]], 20);
    for (const [x, z, n] of [[-56, 0.2, 2], [-56, 3.4, 1], [-52.8, 1.0, 1]]) {
      for (let i = 0; i < n; i++) B.add(M.precast, ring, trs(x, i * 1.0, z, r()));
    }
    world.add(new Box(-55, 0.9, 1.8, 2.1, 0.9, 2.4, 0, 'stack'));
  }
  // ------------------------------------------------------------ timber packs
  {
    for (const [tx, tz] of [[-54.2, 13.8], [-54.2, 15.3]]) {
      for (const dx of [-1.8, 0, 1.8]) B.add(M.wood, box(0.1, 0.1, 1.2), trs(tx + dx, 0.05, tz), TIMBER);
      for (let l = 0; l < 5; l++) for (let k = 0; k < 6; k++) {
        B.add(M.wood, box(4.8 + (r() - 0.5) * 0.2, 0.047, 0.15, r() * 3, 0), trs(tx + (r() - 0.5) * 0.08, 0.125 + l * 0.05, tz - 0.4 + k * 0.16), WOOD.fresh.clone().multiplyScalar(0.9 + r() * 0.2));
      }
      for (const dx of [-1.5, 1.5]) B.add(M.paint, box(0.02, 0.28, 1.0), trs(tx + dx, 0.24, tz), DARK);
    }
    world.add(new Box(-54.2, 0.2, 14.55, 2.55, 0.2, 1.4, 0, 'stack'));
    // plywood / OSB sheets
    B.add(M.wood, box(0.1, 0.1, 1.2), trs(-48.3, 0.05, 16.5), TIMBER);
    B.add(M.wood, box(0.1, 0.1, 1.2), trs(-46.7, 0.05, 16.5), TIMBER);
    B.add(M.ply, box(2.44, 0.45, 1.22), trs(-47.5, 0.33, 16.5), WOOD.ply);
    B.add(M.osb, box(2.44, 0.018, 1.22), trs(-47.5, 0.565, 16.5, 0.03));
    world.add(new Box(-47.5, 0.3, 16.5, 1.25, 0.3, 0.65, 0, 'stack'));
  }
  // ------------------------------------------------------------ concrete block pallets
  for (let i = 0; i < 8; i++) {
    const bx = -57.6 + (i % 4) * 1.45, bz = -17.4 + Math.floor(i / 4) * 1.3;
    pallet(ctx, bx, bz, 0);
    const h = i === 6 ? 0.45 : 0.9;
    B.add(M.block, box(1.15, h, 0.95, bx, 0), trs(bx, 0.15 + h / 2, bz));
    B.add(M.paint, box(1.17, 0.02, 0.97), trs(bx, 0.15 + h - 0.1, bz), col(0x2d5da8));
  }
  world.add(new Box(-55.4, 0.55, -16.75, 2.9, 0.55, 1.35, 0, 'stack'));
  // ------------------------------------------------------------ cement bags on pallets
  {
    const places = [];
    for (const [px, pz] of [[-46.7, -17.2], [-46.7, -14.4]]) {
      pallet(ctx, px, pz, Math.PI / 2);
      for (let l = 0; l < 7; l++) {
        for (let k = 0; k < 2; k++) {
          const rot = l % 2 ? 0 : Math.PI / 2;
          const ox = l % 2 ? (k - 0.5) * 0.47 : 0, oz = l % 2 ? 0 : (k - 0.5) * 0.47;
          places.push(trs(px + ox + (r() - 0.5) * 0.03, 0.15 + l * 0.165, pz + oz + (r() - 0.5) * 0.03, rot + (r() - 0.5) * 0.08));
        }
      }
    }
    if (!low && modelInstances('cement_bag', places, ctx.root).length) { /* CC0 bags */ }
    else for (const p of places) B.add(M.paint, box(0.46, 0.16, 0.7), p.clone().multiply(trs(0, 0.08, 0)), col(0xb7b2a6));
    world.add(new Box(-46.7, 0.7, -15.8, 0.65, 0.7, 2.1, 0, 'stack'));
  }
  // ------------------------------------------------------------ rebar stock on bearers
  {
    for (const z of [-11.5, -8, -4, -0.5]) B.add(M.wood, box(1.8, 0.1, 0.12), trs(-58, 0.05, z), TIMBER);
    for (let b = 0; b < 3; b++) {
      for (let i = 0; i < 16; i++) {
        const x = -58.6 + b * 0.6 + (i % 6) * 0.04 - 0.1, y = 0.13 + Math.floor(i / 6) * 0.035;
        ctx.bar(x, y, -12 + r() * 0.3, x, y, 0 + r() * 0.3, 0.014);
      }
    }
    world.add(new Box(-58, 0.2, -6, 1.0, 0.2, 6.2, 0, 'stack'));
  }
  // ------------------------------------------------------------ formwork panels + prop stillages
  {
    for (const [fx, fz] of [[-51.5, 20.0], [-48.3, 20.0]]) {
      for (let l = 0; l < 7; l++) {
        const y = 0.1 + l * 0.13;
        B.add(M.paint, box(2.7, 0.12, 1.2), trs(fx + (r() - 0.5) * 0.06, y + 0.06, fz + (r() - 0.5) * 0.06, (r() - 0.5) * 0.02), col(0xe3b21a));
        B.add(M.ply, box(2.6, 0.012, 1.1), trs(fx, y + 0.125, fz), WOOD.film);
      }
      for (const dx of [-0.9, 0.9]) B.add(M.wood, box(0.1, 0.1, 1.3), trs(fx + dx, 0.05, fz), TIMBER);
    }
    world.add(new Box(-49.9, 0.5, 20.0, 3.2, 0.5, 0.7, 0, 'stack'));
  }
  // ------------------------------------------------------------ COSHH cage (drums + gas)
  {
    const cx = -59.3, cz = -24.0, W = 1.2, L = 2.4, H = 2.0;
    for (const [ox, oz] of [[-W / 2, -L / 2], [W / 2, -L / 2], [W / 2, L / 2], [-W / 2, L / 2]]) ctx.tube(cx + ox, 0, cz + oz, cx + ox, H, cz + oz, 0.025);
    for (const y of [0.05, H]) {
      ctx.tube(cx - W / 2, y, cz - L / 2, cx + W / 2, y, cz - L / 2, 0.02);
      ctx.tube(cx - W / 2, y, cz + L / 2, cx + W / 2, y, cz + L / 2, 0.02);
      ctx.tube(cx + W / 2, y, cz - L / 2, cx + W / 2, y, cz + L / 2, 0.02);
    }
    B.add(M.mesh, plane(L, H - 0.1), trs(cx + W / 2, H / 2, cz, Math.PI / 2), col(0xb9bcbe));
    B.add(M.mesh, plane(W, H - 0.1), trs(cx, H / 2, cz - L / 2), col(0xb9bcbe));
    B.add(M.mesh, plane(W, H - 0.1), trs(cx, H / 2, cz + L / 2), col(0xb9bcbe));
    B.add(M.paint, box(W + 0.1, 0.04, L + 0.1), trs(cx, H + 0.02, cz), col(0x6f7478));
    B.add(M.steel, box(W, 0.05, L), trs(cx, 0.025, cz), col(0x505358));
    const drums = [trs(cx - 0.25, 0.05, cz - 0.8, r()), trs(cx + 0.25, 0.05, cz - 0.8, r()), trs(cx - 0.25, 0.05, cz - 0.1, r())];
    if (!modelInstances('oil_drum', drums, ctx.root).length) for (const p of drums) B.add(M.paint, cyl(0.29, 0.29, 0.88, 14), p.clone().multiply(trs(0, 0.44, 0)), col(0x1f4f9a));
    const gas = [trs(cx + 0.2, 0.05, cz + 0.45), trs(cx - 0.2, 0.05, cz + 0.55), trs(cx + 0.15, 0.05, cz + 0.95)];
    if (low || !modelInstances('gas_cylinder', gas, ctx.root).length) for (const p of gas) B.add(M.paint, cyl(0.18, 0.18, 0.6, 12), p.clone().multiply(trs(0, 0.3, 0)), col(0xd8d8d0));
    ctx.sign('electric', 0.3, 0.3, cx + W / 2 + 0.03, 1.5, cz - 0.6, Math.PI / 2);
    world.add(new Box(cx, H / 2, cz, W / 2 + 0.05, H / 2, L / 2 + 0.05, 0, 'stack'));
  }
  // ------------------------------------------------------------ brick packs by the scaffold
  {
    for (const [gx0, n] of [[19.0, 4], [31.5, 5]]) {
      for (let i = 0; i < n; i++) {
        const bx = gx0 + i * 1.25, bz = 31.6 + (i % 2) * 0.1;
        pallet(ctx, bx, bz, 0);
        const h = i === n - 1 ? 0.55 : 0.9;
        B.add(M.brick, box(1.05, h, 0.95, bx * 1.3, 0), trs(bx, 0.15 + h / 2, bz, (r() - 0.5) * 0.04));
        B.add(M.paint, box(1.07, 0.015, 0.97), trs(bx, 0.15 + h * 0.3, bz), WHITE);
        B.add(M.paint, box(1.07, 0.015, 0.97), trs(bx, 0.15 + h * 0.75, bz), WHITE);
      }
      world.add(new Box(gx0 + (n - 1) * 0.625, 0.55, 31.65, (n - 1) * 0.625 + 0.6, 0.55, 0.6, 0, 'stack'));
    }
  }
  // ------------------------------------------------------------ scaffold stock east of the hoist
  {
    const sx = 48.2, sz = 25;
    for (const dz of [-2.5, 0, 2.5]) B.add(M.wood, box(1.6, 0.1, 0.12), trs(sx, 0.05, sz + dz), TIMBER);
    for (let i = 0; i < 24; i++) {
      const x = sx - 0.6 + (i % 8) * 0.07, y = 0.14 + Math.floor(i / 8) * 0.05;
      ctx.tube(x, y, sz - 3.2, x, y, sz + 3.2, 0.024);
    }
    for (let l = 0; l < 10; l++) B.add(M.wood, box(0.225 * 3, 0.038, 3.9), trs(sx + 0.55, 0.12 + l * 0.04, sz - 1.0 + (r() - 0.5) * 0.05, (r() - 0.5) * 0.02), WOOD.board);
    // dumpy bags of fittings
    for (const [dx, dz] of [[0.1, 2.3], [0.1, 3.3]]) B.add(M.plastic, box(0.9, 0.7, 0.9), trs(sx + dx, 0.35, sz + dz), col(0xe6e3d8));
    world.add(new Box(sx, 0.4, sz + 0.3, 0.8, 0.4, 3.4, 0, 'stack'));
  }
  // ------------------------------------------------------------ formwork storage (SE)
  {
    const fx = 40, fz = -31;
    for (let i = 0; i < 4; i++) {
      const y = 0.1 + i * 0.42;
      for (const lx of [-0.8, 0.8]) B.add(M.paint, box(0.1, 0.16, 4.2), trs(fx + lx, y + 0.08, fz), col(0xb8bcc0));
      B.add(M.ply, box(2.44, 0.021, 4.22), trs(fx + (r() - 0.5) * 0.05, y + 0.18, fz, (r() - 0.5) * 0.02), WOOD.plyUsed);
      B.add(M.wood, box(2.2, 0.1, 0.1), trs(fx, y - 0.02, fz - 1.5), TIMBER);
      B.add(M.wood, box(2.2, 0.1, 0.1), trs(fx, y - 0.02, fz + 1.5), TIMBER);
    }
    world.add(new Box(fx, 0.9, fz, 1.25, 0.9, 2.15, 0, 'stack'));
  }
  // ------------------------------------------------------------ rebar fabrication (SE)
  {
    const fx = 30, fz = -45;
    B.add(M.paint, box(3.2, 0.06, 1.0), trs(fx, 0.9, fz), col(0x4a5058));
    for (const [ox, oz] of [[-1.5, -0.45], [1.5, -0.45], [1.5, 0.45], [-1.5, 0.45]]) B.add(M.paint, box(0.08, 0.9, 0.08), trs(fx + ox, 0.45, fz + oz), col(0x4a5058));
    B.add(M.paint, box(0.8, 0.5, 0.7), trs(fx - 0.9, 1.18, fz), col(0x2f6ea8));
    B.add(M.steel, cyl(0.12, 0.12, 0.08, 12), trs(fx - 0.9, 1.47, fz), col(0x9a9a9a));
    for (let i = 0; i < 10; i++) ctx.bar(fx - 0.2, 0.95, fz - 0.3 + i * 0.05, fx + 1.5, 0.95, fz - 0.3 + i * 0.05 + (r() - 0.5) * 0.02, 0.01);
    for (const dz of [2.0, 3.0]) {
      for (const dx of [-2.5, 2.5]) B.add(M.wood, box(0.12, 0.1, 0.8), trs(fx + dx, 0.05, fz + dz), TIMBER);
      for (let i = 0; i < 18; i++) {
        const y = 0.13 + Math.floor(i / 6) * 0.03, z = fz + dz - 0.12 + (i % 6) * 0.045;
        ctx.bar(fx - 3, y, z, fx + 3, y, z + (r() - 0.5) * 0.04, 0.012);
      }
    }
    // bent shapes (links) in a pile
    for (let i = 0; i < 20; i++) {
      const lx = fx + 2.3 + r() * 0.8, lz = fz - 0.3 + r() * 0.7, ly = 0.02 + i * 0.012, a = 0.18;
      ctx.bar(lx - a, ly, lz - a, lx + a, ly, lz - a, 0.005);
      ctx.bar(lx + a, ly, lz - a, lx + a, ly, lz + a, 0.005);
      ctx.bar(lx + a, ly, lz + a, lx - a, ly, lz + a, 0.005);
      ctx.bar(lx - a, ly, lz + a, lx - a, ly, lz - a, 0.005);
    }
    world.add(new Box(fx, 0.8, fz, 1.7, 0.8, 0.6, 0, 'stack'));
    world.add(new Box(fx, 0.2, fz + 2.5, 3.1, 0.2, 0.8, 0, 'stack'));
  }
  // ------------------------------------------------------------ canopy generator (original collider) + fuel bowser + distribution
  {
    const gx = -8, gz = -40;
    B.add(M.paint, box(3.2, 0.3, 1.4), trs(gx, 0.15, gz), DARK);
    B.add(M.paint, box(3.1, 1.45, 1.34), trs(gx, 0.3 + 0.725, gz), col(0xd8d5cb));
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) B.add(M.paint, box(0.5, 0.9, 0.02), trs(gx - 0.9 + i * 0.9, 1.0, gz + s * 0.675), col(0xbfbcb2));
      for (let i = 0; i < 8; i++) B.add(M.paint, box(0.5, 0.025, 0.03), trs(gx + 1.2, 0.6 + i * 0.1, gz + s * 0.68), DARK);
    }
    B.add(M.steel, cyl(0.07, 0.07, 0.5, 10), trs(gx - 1.1, 2.0, gz + 0.3), col(0x5a5a5a));
    B.add(M.glass, box(0.3, 0.25, 0.01), trs(gx + 0.9, 1.2, gz - 0.676));
    ctx.sign('electric', 0.25, 0.25, gx - 0.4, 1.3, gz - 0.69, Math.PI);
    world.add(new Box(gx, 0.9, gz, 1.6, 0.9, 0.7, 0, 'generator'));
    // fuel bowser
    const bx = -3.6, bz = -41.2;
    const tank = cyl(0.55, 0.55, 2.0, 18);
    tank.rotateZ(Math.PI / 2);
    B.add(M.paintVeh, tank, trs(bx, 1.1, bz), col(0x3f7a3a));
    B.add(M.paint, box(2.2, 0.12, 1.0), trs(bx, 0.52, bz), DARK);
    for (const s of [-1, 1]) {
      const wgeo = cyl(0.3, 0.3, 0.18, 14);
      wgeo.rotateX(Math.PI / 2);
      B.add(M.rubber, wgeo, trs(bx, 0.3, bz + s * 0.62), col(0x1a1a1a));
    }
    B.add(M.paint, box(1.2, 0.07, 0.07), trs(bx + 1.6, 0.45, bz), DARK);
    B.add(M.plastic, box(0.4, 0.35, 0.35), trs(bx + 0.4, 1.75, bz), col(0x2b2b2b));
    world.add(new Box(bx + 0.3, 0.9, bz, 1.5, 0.9, 0.75, 0, 'plant'));
    // 110 V transformer / distribution unit + cable runs
    B.add(M.paint, box(0.6, 0.55, 0.45), trs(-5.4, 0.28, -43.2), col(0xf0c000));
    const cable = [[-6.4, -40.4], [-6.0, -42.0], [-5.4, -43.0]];
    for (let i = 0; i < cable.length - 1; i++) {
      const [ax, az] = cable[i], [bx2, bz2] = cable[i + 1];
      ctx.brace(ax, 0.03, az, bx2, 0.03, bz2, 0.018, col(0x1b1b1b));
    }
    for (const [x0, z0, x1, z1] of [[-5.4, -43.0, -12, -48], [-12, -48, -38, -47.2]]) ctx.brace(x0, 0.03, z0, x1, 0.03, z1, 0.02, col(0x2255aa));
    const drums = [trs(-5.8, 0, -38.7, r()), trs(-5.1, 0, -38.9, r())];
    if (!modelInstances('oil_drum', drums, ctx.root).length) for (const p of drums) B.add(M.paint, cyl(0.29, 0.29, 0.88, 14), p.clone().multiply(trs(0, 0.44, 0)), col(0x1f4f9a));
    world.add(new Box(-5.45, 0.45, -38.8, 0.75, 0.45, 0.4, 0, 'drum'));
  }
  // ------------------------------------------------------------ wheel wash inside the gate
  // centred on the terrain's wheel-wash apron (x -34..-26, z -58..-50)
  wheelWash(ctx, -30, -53.5);

  // ------------------------------------------------------------ traffic management
  {
    const cones = new InstBatch(coneGeometry(), M.plastic, { name: 'cones' });
    const conePts = [];
    for (let z = -46.5; z <= -38; z += 2.6) conePts.push([-33.4, z], [-26.4, z + 0.8]);
    conePts.push([-12.2, -16.2], [-10.8, -17.4], [-9.4, -18.6], [24.5, -46.2], [25.5, -44.8], [19.6, -50.5]);
    for (const [x, z] of conePts) cones.add(trs(x + (r() - 0.5) * 0.2, 0, z + (r() - 0.5) * 0.2, r() * 6));
    cones.add(trs(25.8, 0.16, -46.6, 0.4, 0, Math.PI / 2 - 0.1)); // knocked over
    cones.build(ctx.root);
    // plastic barriers round an open manhole
    const mx = 22, mz = -48;
    for (const [x, z, yaw] of [[mx, mz - 1.1, 0], [mx + 1.1, mz, Math.PI / 2], [mx, mz + 1.1, 0], [mx - 1.1, mz, Math.PI / 2]]) barrier(ctx, x, z, yaw);
    B.add(M.precast, cyl(0.4, 0.4, 0.06, 16), trs(mx, 0.03, mz));
    B.add(M.rubber, cyl(0.3, 0.3, 0.01, 16), trs(mx, 0.065, mz), col(0x080808));
    modelInstances('manhole_cover', [trs(mx + 0.3, 0, mz + 0.35, 0.3)], ctx.root);
    world.add(new Box(mx, 0.5, mz, 1.25, 0.5, 1.25, 0, 'barrier'));
    // precast barriers protecting the hoarding next to the gate
    const jb = [];
    for (let i = 0; i < 4; i++) jb.push(trs(-23.2 + i * 1.62, 0, -56.9, (r() - 0.5) * 0.04));
    if (low || !modelInstances('jersey_barrier', jb, ctx.root).length) {
      const g = prism([[-0.3, 0], [0.3, 0], [0.3, 0.08], [0.12, 0.3], [0.08, 0.81], [-0.08, 0.81], [-0.12, 0.3], [-0.3, 0.08]], 1.55);
      g.rotateY(Math.PI / 2);
      for (const m of jb) B.add(M.precast, g, m);
    }
    world.add(new Box(-20.8, 0.55, -56.9, 3.3, 0.55, 0.3, 0, 'barrier'));
  }
  // ------------------------------------------------------------ assembly point, fire point, utility pillar
  {
    B.add(M.paint, box(0.06, 2.2, 0.06), trs(-58.5, 1.1, -37), col(0x6f7478));
    ctx.sign('assembly', 0.6, 0.6, -58.5, 2.0, -36.96, 0);
    B.add(M.paint, box(0.9, 1.3, 0.3), trs(-40.8, 0.65, -48.8), col(0xd2d3ce));
    ctx.sign('firepoint', 0.5, 0.5, -40.8, 1.0, -48.64, 0);
    modelInstances('utility_box', [trs(-42.4, 0, -48.8, 0)], ctx.root);
    world.add(new Box(-41.6, 0.65, -48.8, 1.3, 0.65, 0.3, 0, 'sign'));
  }
  // ------------------------------------------------------------ timber dunnage in lay-down A (visual only, flat)
  {
    const pairs = [
      [-29, -8, 0, 6], [-24.5, -8.4, 0.05, 6], [-30, -8, 0, 6], [-20, 1, 0.2, 1.2], [-24.5, 1, 0, 1.2], [-21, 1, 0.2, 1.2],
      [-16, 12, 0.05, 3.6], [-30, 14, 0.1, 3.6], [-35, -2.5, 0.3, 2], [-15.5, -6, -0.2, 2.4],
    ];
    for (const [x, z, yaw, len] of pairs) {
      const off = Math.min(len * 0.33, 1.9);
      for (const s of [-1, 1]) {
        const c = Math.cos(yaw), sn = Math.sin(yaw);
        B.add(M.wood, box(0.1, 0.1, 1.1), trs(x + c * off * s, 0.05, z - sn * off * s, yaw + (r() - 0.5) * 0.08), TIMBER);
      }
    }
  }
}

function pallet(ctx, x, z, yaw) {
  const { B, M } = ctx;
  B.within(trs(x, 0, z, yaw), () => {
    for (const dz of [-0.42, 0, 0.42]) B.add(M.wood, box(1.2, 0.1, 0.1), trs(0, 0.05, dz), PALLET);
    B.add(M.wood, box(1.2, 0.022, 1.0), trs(0, 0.11 + 0.011, 0), PALLET);
    B.add(M.wood, box(1.2, 0.022, 0.1), trs(0, 0.011, 0.45), PALLET);
    B.add(M.wood, box(1.2, 0.022, 0.1), trs(0, 0.011, -0.45), PALLET);
  });
}

// Steel-panel welfare cabins, two storeys (original colliders), walkway gantry + stair.
function cabins(ctx) {
  const { B, M, world } = ctx;
  const labels = [['office', 'meeting'], ['canteen', 'office'], ['drying', 'firstaidLbl']];
  for (let i = 0; i < 3; i++) {
    for (let lv = 0; lv < 2; lv++) {
      const x = -52 + i * 3.2, z = -44, y0 = lv * 2.6;
      const c = lv ? CABIN_W : STEEL_BLUE;
      B.add(M.corrugated, box(2.84, 2.44, 5.92, x * 2, y0), trs(x, y0 + 1.3, z), c);
      // frame: corner posts, top & bottom rails, roof
      for (const [ox, oz] of [[-1.39, -2.94], [1.39, -2.94], [1.39, 2.94], [-1.39, 2.94]]) B.add(M.paint, box(0.13, 2.6, 0.13), trs(x + ox, y0 + 1.3, z + oz), FRAME);
      for (const yy of [0.08, 2.52]) {
        B.add(M.paint, box(0.1, 0.16, 5.9), trs(x - 1.4, y0 + yy, z), FRAME);
        B.add(M.paint, box(0.1, 0.16, 5.9), trs(x + 1.4, y0 + yy, z), FRAME);
        B.add(M.paint, box(2.9, 0.16, 0.1), trs(x, y0 + yy, z - 2.95), FRAME);
        B.add(M.paint, box(2.9, 0.16, 0.1), trs(x, y0 + yy, z + 2.95), FRAME);
      }
      B.add(M.paint, box(2.8, 0.04, 5.9), trs(x, y0 + 2.58, z), lv ? col(0x9a9c98) : FRAME);
      // site-facing end (z = -41): door + window
      const ze = z + 2.97;
      door(ctx, x - 0.65, y0, ze, 0, labels[i][lv]);
      win(ctx, x + 0.55, y0 + 1.55, ze, 1.1, 0.95, 0, lv === 0);
      // road end: window
      win(ctx, x, y0 + 1.55, z - 2.97, 1.4, 0.95, Math.PI, lv === 0);
      // outer long sides
      if (i === 0) for (const wz of [-45.8, -42.4]) win(ctx, x - 1.46, y0 + 1.55, wz, 1.4, 0.95, -Math.PI / 2, lv === 0);
      if (i === 2) for (const wz of [-46.2, -44.9]) win(ctx, x + 1.46, y0 + 1.55, wz, 1.0, 0.95, Math.PI / 2, lv === 0);
      // bulkhead lamp over the door
      B.add(M.lamp, box(0.22, 0.1, 0.08), trs(x - 0.65, y0 + 2.28, ze + 0.05));
      if (lv === 0) {
        // steel steps
        for (let s = 0; s < 3; s++) B.add(M.paint, box(1.0, 0.04, 0.26), trs(x - 0.65, 0.07 + s * 0.08, ze + 0.62 - s * 0.24), col(0x6a6e72));
        B.add(M.paint, box(1.0, 0.24, 0.05), trs(x - 0.65, 0.12, ze + 0.75), col(0x6a6e72));
      }
      world.add(new Box(x, 1.3 + lv * 2.6, z, 1.45, 1.3, 3.0, 0, 'cabin'));
    }
  }
  // walkway gantry along the upper doors + stair down on the east side
  const gz0 = -41.0, gz1 = -39.75, gx0 = -53.5, gx1 = -42.85, gy = 2.62;
  B.add(M.paint, box(gx1 - gx0, 0.06, gz1 - gz0), trs((gx0 + gx1) / 2, gy, (gz0 + gz1) / 2), col(0x7c8186));
  for (let x = gx0 + 0.1; x <= gx1; x += 3.5) {
    B.add(M.paint, box(0.1, gy, 0.1), trs(x, gy / 2, gz1 - 0.05), col(0x5b6066));
    ctx.tube(x, gy, gz1 - 0.05, x, gy + 1.1, gz1 - 0.05, 0.024);
  }
  for (const yy of [0.55, 1.1]) ctx.tube(gx0, gy + yy, gz1 - 0.05, gx1, gy + yy, gz1 - 0.05, 0.024);
  B.add(M.paint, box(gx1 - gx0, 0.15, 0.02), trs((gx0 + gx1) / 2, gy + 0.1, gz1 - 0.03), YEL);
  // stair: rises along -z from the ground at z -36.7 to the gantry end
  const sx = -43.4, sza = -36.6, szb = gz1;
  const steps = 13;
  for (let s = 0; s < steps; s++) {
    const t = (s + 0.5) / steps;
    B.add(M.paint, box(0.9, 0.035, 0.26), trs(sx, gy * t, sza + (szb - sza) * t), col(0x7c8186));
  }
  const len = Math.hypot(szb - sza, gy);
  for (const dx of [-0.47, 0.47]) {
    B.add(M.paint, box(0.05, 0.2, len), trs(sx + dx, gy / 2, (sza + szb) / 2, 0, Math.atan2(gy, Math.abs(szb - sza))), col(0x5b6066));
    ctx.tube(sx + dx, 1.0, sza, sx + dx, gy + 1.0, szb, 0.022);
  }
  world.add(new Box((gx0 + gx1) / 2, gy + 0.5, (gz0 + gz1) / 2, (gx1 - gx0) / 2, 0.6, (gz1 - gz0) / 2, 0, 'cabin'));
  world.add(new Box(sx, gy / 2, (sza + szb) / 2, 0.5, gy / 2, Math.abs(szb - sza) / 2, 0, 'cabin'));
  // air-con units on the west wall
  modelInstances('aircon_unit', [trs(-53.62, 1.2, -45.0, -Math.PI / 2), trs(-53.62, 3.8, -43.2, -Math.PI / 2)], ctx.root, { part: 0 });
  ctx.sign('firstaid', 0.3, 0.3, -45.6 + 0.75, 4.75, -41.02 + 0.01, 0);
}

function win(ctx, x, yc, z, w, h, yaw, grille) {
  const { B, M } = ctx;
  B.within(trs(x, yc, z, yaw), () => {
    B.add(M.paint, box(w + 0.1, h + 0.1, 0.05), trs(0, 0, 0.0), UPVC);
    B.add(M.cabinGlass, plane(w - 0.04, h - 0.04), trs(0, 0, 0.03));
    B.add(M.paint, box(0.04, h - 0.04, 0.02), trs(0, 0, 0.04), UPVC);
    if (grille) for (let i = 0; i < 6; i++) B.add(M.steel, box(0.018, h + 0.05, 0.018), trs(-w / 2 + (i + 0.5) * (w / 6), 0, 0.08), col(0x55595e));
  });
}

function door(ctx, x, y0, z, yaw, lbl) {
  const { B, M } = ctx;
  B.within(trs(x, y0, z, yaw), () => {
    B.add(M.paint, box(0.98, 2.06, 0.05), trs(0, 1.08, 0), FRAME);
    B.add(M.paint, box(0.88, 2.0, 0.04), trs(0, 1.07, 0.02), col(0x5d6a75));
    B.add(M.steel, box(0.12, 0.025, 0.05), trs(0.32, 1.05, 0.06), col(0xb5b5b5));
    B.add(M.cabinGlass, plane(0.25, 0.35), trs(0, 1.6, 0.045));
  });
  ctx.sign(lbl, 0.8, 0.2, x, y0 + 2.2, z + 0.04, yaw);
}

function toilets(ctx) {
  const { B, M } = ctx;
  const cols = [col(0x2a6fb0), col(0x2a6fb0), col(0x2a9a55)];
  for (let i = 0; i < 3; i++) {
    const x = -56 + i * 1.3, z = -30;
    B.add(M.plastic, box(1.12, 2.1, 1.12), trs(x, 1.05, z), cols[i]);
    for (const s of [-1, 1]) for (let k = 0; k < 3; k++) B.add(M.plastic, box(0.03, 1.9, 0.08), trs(x + s * 0.575, 1.05, z - 0.35 + k * 0.35), cols[i]);
    B.add(M.plastic, lathe([[0, -0.04], [0.64, -0.04], [0.62, 0.0], [0, 0.28]], 4), trs(x, 2.14, z, Math.PI / 4, 0, 0, 1.18, 1, 1.18), WHITE);
    B.add(M.plastic, box(0.9, 1.9, 0.04), trs(x, 1.02, z + 0.575), cols[i].clone().multiplyScalar(0.85));
    B.add(M.plastic, box(0.12, 0.05, 0.03), trs(x + 0.3, 1.2, z + 0.6), i === 1 ? RED : col(0x30b040));
    B.add(M.plastic, cyl(0.05, 0.05, 0.5, 8), trs(x - 0.35, 2.3, z - 0.4), col(0x2b2b2b));
    B.add(M.plastic, box(1.2, 0.1, 1.2), trs(x, 0.05, z), cols[i].clone().multiplyScalar(0.7));
  }
  ctx.sign('toilets', 0.8, 0.2, -54.7, 2.45, -29.38, 0);
  // original collider
  ctx.world.add(new Box(-54.7, 1.15, -30, 1.9, 1.15, 0.6, 0, 'cabin'));
}

// Builder's skip (sloped ends) or roll-on/roll-off container, heaped with rubble.
function skip(ctx, x, z, yaw, roro) {
  const { B, M, r } = ctx;
  const c = roro ? col(0x2f5d8a) : col(0xd6a615);
  B.within(trs(x, 0, z, yaw), () => {
    if (!roro) {
      const prof = [[-1.3, 0.05], [1.3, 0.05], [1.8, 1.6], [-1.8, 1.6]];
      for (const s of [-1, 1]) B.add(M.paintWorn, prism(prof, 0.05), trs(0, 0, s * 0.93), c);
      for (const s of [-1, 1]) {
        const L = Math.hypot(0.5, 1.55);
        B.add(M.paintWorn, box(0.05, L, 1.86), trs(s * 1.55, 0.83, 0, 0, 0, s * Math.atan2(0.5, 1.55)), c);
      }
      B.add(M.paintWorn, box(2.6, 0.06, 1.86), trs(0, 0.08, 0), c);
      for (const s of [-1, 1]) for (const k of [-0.6, 0, 0.6]) B.add(M.paintWorn, box(0.1, 1.5, 0.06), trs(k * (1 + 0.2), 0.8, s * 0.98), c);
      for (const s of [-1, 1]) B.add(M.steel, cyl(0.06, 0.06, 0.25, 8), trs(s * 1.1, 1.1, 0, 0, Math.PI / 2), col(0x404040));
      B.add(M.paint, box(2.4, 0.12, 0.12), trs(0, 0.02, -0.7), DARK);
      B.add(M.paint, box(2.4, 0.12, 0.12), trs(0, 0.02, 0.7), DARK);
    } else {
      B.add(M.paintWorn, box(6.0, 1.8, 0.06), trs(0, 0.95, -1.22), c);
      B.add(M.paintWorn, box(6.0, 1.8, 0.06), trs(0, 0.95, 1.22), c);
      B.add(M.paintWorn, box(0.06, 1.8, 2.4), trs(-3.0, 0.95, 0), c);
      B.add(M.paintWorn, box(0.06, 1.8, 2.4), trs(3.0, 0.95, 0), c);
      B.add(M.paintWorn, box(6.0, 0.1, 2.4), trs(0, 0.1, 0), c);
      for (let k = -2.5; k <= 2.5; k += 1.0) for (const s of [-1, 1]) B.add(M.paintWorn, box(0.1, 1.8, 0.08), trs(k, 0.95, s * 1.27), c);
      for (const s of [-1, 1]) B.add(M.paint, box(6.2, 0.15, 0.2), trs(0, 0.05, s * 0.9), DARK);
    }
    // rubble heap: displaced surface + mixed debris
    const W = roro ? 5.8 : 3.3, D = roro ? 2.3 : 1.8, base = roro ? 1.3 : 1.15, hump = roro ? 0.55 : 0.5;
    const g = new THREE.PlaneGeometry(W, D, 14, 7);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / (W / 2), v = p.getZ(i) / (D / 2);
      const edge = Math.max(0, 1 - u * u) * Math.max(0, 1 - v * v);
      p.setY(i, base + hump * edge + (r() - 0.5) * 0.12);
    }
    g.computeVertexNormals();
    B.add(roro ? M.dirt : M.gravel, g);
    const n = roro ? 40 : 26;
    for (let i = 0; i < n; i++) {
      const px = (r() - 0.5) * W * 0.85, pz = (r() - 0.5) * D * 0.8;
      const edge = Math.max(0, 1 - (px / (W / 2)) ** 2) * Math.max(0, 1 - (pz / (D / 2)) ** 2);
      const py = base + hump * edge + 0.05;
      const k = r();
      const rot = trs(px, py, pz, r() * 6, (r() - 0.5) * 1.2, (r() - 0.5) * 1.2);
      if (k < 0.35) B.add(M.wood, box(0.6 + r() * 1.2, 0.05, 0.1), rot, TIMBER);
      else if (k < 0.6) B.add(M.brick, box(0.215, 0.065, 0.1), rot);
      else if (k < 0.75) B.add(M.paint, box(0.5 + r() * 0.5, 0.013, 0.3 + r() * 0.4), rot, col(0xe4e2dc));
      else if (k < 0.87) B.add(M.block, box(0.44, 0.215, 0.2), rot);
      else B.add(M.plastic, box(0.4 + r() * 0.6, 0.01, 0.4 + r() * 0.5), rot, r() < 0.5 ? col(0x2a5fa0) : col(0x1a1a1a));
    }
  });
}

// Chapter-8 style interlocking plastic barrier, red/white.
function barrier(ctx, x, z, yaw) {
  const { B, M } = ctx;
  B.within(trs(x, 0, z, yaw), () => {
    B.add(M.plastic, box(2.0, 0.25, 0.05), trs(0, 0.85, 0), RED);
    for (let i = 0; i < 4; i++) B.add(M.plastic, box(0.25, 0.26, 0.055), trs(-0.75 + i * 0.5, 0.85, 0), WHITE);
    B.add(M.plastic, box(2.0, 0.1, 0.05), trs(0, 0.25, 0), RED);
    for (const s of [-1, 1]) {
      B.add(M.plastic, box(0.07, 1.0, 0.07), trs(s * 0.95, 0.5, 0), RED);
      B.add(M.plastic, box(0.15, 0.08, 0.6), trs(s * 0.95, 0.04, 0), RED);
    }
  });
}

function coneGeometry() {
  const parts = [
    [lathe([[0.2, 0], [0.2, 0.04], [0.14, 0.05], [0.13, 0.12], [0, 0.12]], 4).rotateY(Math.PI / 4), col(0x1a1a1a)],
    [lathe([[0.13, 0.05], [0.1, 0.3], [0.098, 0.32]], 12), CONE],
    [lathe([[0.098, 0.32], [0.08, 0.46]], 12), WHITE],
    [lathe([[0.08, 0.46], [0.035, 0.72], [0.0, 0.73]], 12), CONE],
  ];
  const geos = parts.map(([g, c]) => colored(g.index ? g.toNonIndexed() : g, c));
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv', 'color']) {
    const size = k === 'uv' ? 2 : 3;
    const a = new Float32Array(n * size);
    let o = 0;
    for (const g of geos) { a.set(g.attributes[k].array, o); o += g.attributes[k].array.length; }
    out.setAttribute(k, new THREE.BufferAttribute(a, size));
  }
  out.computeBoundingSphere();
  return out;
}

function wheelWash(ctx, x, z) {
  const { B, M, world } = ctx;
  const L = 7.2, W = 3.4, h = 0.35;
  const grey = col(0x5d6268), blue = col(0x2b5f9e);
  B.within(trs(x, 0, z), () => {
    // ramps each end + raised roller deck
    const a = Math.atan2(h, 1.4);
    for (const s of [-1, 1]) B.add(M.paintWorn, box(W - 0.4, 0.06, Math.hypot(1.4, h)), trs(0, h / 2, s * (L / 2 - 0.7), 0, s * a), grey);
    B.add(M.paintWorn, box(W - 0.4, h, L - 2.8), trs(0, h / 2, 0), grey);
    for (let k = -1.6; k <= 1.6; k += 0.2) for (const s of [-0.75, 0.75]) B.add(M.steel, cyl(0.06, 0.06, 0.9, 8), trs(s, h + 0.02, k, 0, 0, Math.PI / 2), col(0x3c3f42));
    // side walls with spray bars
    for (const s of [-1, 1]) {
      B.add(M.paintWorn, box(0.12, 0.95, L - 1.0), trs(s * W / 2, 0.475, 0), blue);
      B.add(M.steel, cyl(0.03, 0.03, L - 2.0, 8), trs(s * (W / 2 - 0.1), 0.55, 0, 0, Math.PI / 2), col(0x9a9ea2));
    }
  });
  // recycling tank + pump
  B.add(M.paintWorn, box(1.6, 1.2, 3.0), trs(x + 3.5, 0.6, z + 1.8), blue);
  B.add(M.paint, box(0.5, 0.4, 0.4), trs(x + 3.5, 1.4, z + 1.2), DARK);
  ctx.brace(x + 3.0, 0.05, z + 0.5, x + 1.7, 0.05, z - 0.6, 0.04, col(0x1a1a1a));
  world.add(new Box(x - W / 2, 0.48, z, 0.1, 0.48, (L - 1) / 2, 0, 'washer'));
  world.add(new Box(x + W / 2, 0.48, z, 0.1, 0.48, (L - 1) / 2, 0, 'washer'));
  world.add(new Box(x + 3.5, 0.8, z + 1.8, 0.8, 0.8, 1.5, 0, 'washer'));
  B.add(M.paint, box(0.06, 2.2, 0.06), trs(x - 2.4, 1.1, z + 4.4), col(0x6f7478));
  ctx.sign('wash', 1.0, 0.5, x - 2.4, 1.95, z + 4.44, 0);
  // portable generator by the pump
  modelInstances('generator', [trs(x + 4.9, 0, z + 3.9, -0.6)], ctx.root);
}
