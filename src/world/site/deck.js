import * as THREE from 'three';
import { Box } from '../../physics/collide.js';
import { box, cyl, prism, lathe, trs, col } from './kit.js';
import { WOOD } from './materials.js';

// Working deck (level 5 slab, y = deckY): column starter bars with
// mushroom caps, full-height column cages, column formwork, stacked table
// forms, a prop stillage, mesh and rebar on bearers, tools and standing
// water. Kept OUT of the job target areas (rebar bay ~(27.3,16.2), shutter
// bay ~(21.3,9.6), beam line z 19.5 between the stubs, the wall form).

const CAP = col(0xff7a00), YEL = col(0xe0a800), ORANGE = col(0xd9530f), DARK = col(0x33383d);
const PLY = WOOD.ply, ALU = col(0xb8bcc0), TIMBER = WOOD.weathered;

export function buildDeck(ctx, F) {
  const { B, M, world, r } = ctx;
  const { colX, colZ, deckY, stubs, stubZ, formLine } = F;
  const y = deckY;

  // ------------------------------------------------------------ columns: bars / cages / forms
  const cages = new Set(['18.3,25.7', '41.7,25.7', '41.7,12.9', '12.3,6.3']);
  const forms = new Set(['12.3,19.5', '12.3,12.9']);
  const skip = (x, z) => (stubs.includes(x) && z === stubZ)
    || (x > formLine.x0 - 0.2 && x < formLine.x1 + 0.2 && Math.abs(z - formLine.z) < 0.5)
    || (x > 36 && z < 12.2); // inside / against the core
  const bars8 = [[-0.14, -0.14], [0.14, -0.14], [0.14, 0.14], [-0.14, 0.14], [0, -0.14], [0.14, 0], [0, 0.14], [-0.14, 0]];
  for (const x of colX) {
    for (const z of colZ) {
      if (skip(x, z)) continue;
      const k = `${x.toFixed(1)},${z.toFixed(1)}`;
      const full = cages.has(k) || forms.has(k);
      const h = full ? 3.1 : 1.15;
      for (const [bx, bz] of bars8) {
        const hh = h + (r() - 0.5) * (full ? 0.05 : 0.14);
        ctx.bar(x + bx, y, z + bz, x + bx + (r() - 0.5) * 0.03, y + hh, z + bz + (r() - 0.5) * 0.03, 0.0125);
        if (!full) ctx.cap(x + bx, y + hh, z + bz);
      }
      // links (stirrups)
      const levels = full ? 14 : 2;
      for (let i = 0; i < levels; i++) {
        const ly = y + 0.1 + i * (full ? 0.21 : 0.22);
        const a = 0.158;
        ctx.bar(x - a, ly, z - a, x + a, ly, z - a, 0.005);
        ctx.bar(x + a, ly, z - a, x + a, ly, z + a, 0.005);
        ctx.bar(x + a, ly, z + a, x - a, ly, z + a, 0.005);
        ctx.bar(x - a, ly, z + a, x - a, ly, z - a, 0.005);
      }
      if (forms.has(k)) {
        columnForm(ctx, x, z, y);
        world.add(new Box(x, y + 1.55, z, 0.36, 1.55, 0.36, 0, 'form'));
      } else if (full) {
        world.add(new Box(x, y + 1.55, z, 0.2, 1.55, 0.2, 0, 'column'));
      }
    }
  }

  // ------------------------------------------------------------ stacked table forms (NW corner)
  {
    const tx = 15.1, tz = 23.0;
    for (let i = 0; i < 3; i++) {
      const by = y + 0.08 + i * 0.44;
      B.add(M.wood, box(0.1, 0.08, 4.0), trs(tx - 0.7, by - 0.04, tz), TIMBER);
      B.add(M.wood, box(0.1, 0.08, 4.0), trs(tx + 0.7, by - 0.04, tz), TIMBER);
      for (const lx of [-0.8, 0.8]) B.add(M.paint, box(0.1, 0.16, 4.2), trs(tx + lx, by + 0.08, tz), ALU);
      for (let jz = -1.9; jz <= 1.95; jz += 0.5) B.add(M.paint, box(2.4, 0.09, 0.07), trs(tx, by + 0.205, tz + jz), ALU);
      B.add(M.ply, box(2.44, 0.021, 4.22, i * 0.7, 0), trs(tx + (r() - 0.5) * 0.05, by + 0.26, tz + (r() - 0.5) * 0.05, (r() - 0.5) * 0.02), PLY);
      for (const lx of [-0.55, 0.55]) ctx.brace(tx + lx, by + 0.04, tz - 1.9, tx + lx, by + 0.04, tz + 1.5, 0.03, ALU);
    }
    world.add(new Box(tx, y + 0.7, tz, 1.25, 0.7, 2.15, 0, 'stack'));
  }

  // ------------------------------------------------------------ prop stillage
  {
    const sx = 33.8, sz = 23.6, L = 2.4, W = 1.2, H = 0.95;
    for (const [ox, oz] of [[-L / 2, -W / 2], [L / 2, -W / 2], [L / 2, W / 2], [-L / 2, W / 2]]) B.add(M.paint, box(0.06, H, 0.06), trs(sx + ox, y + H / 2, sz + oz), DARK);
    for (const yy of [0.08, H - 0.03]) {
      B.add(M.paint, box(L, 0.05, 0.05), trs(sx, y + yy, sz - W / 2), DARK);
      B.add(M.paint, box(L, 0.05, 0.05), trs(sx, y + yy, sz + W / 2), DARK);
      B.add(M.paint, box(0.05, 0.05, W), trs(sx - L / 2, y + yy, sz), DARK);
      B.add(M.paint, box(0.05, 0.05, W), trs(sx + L / 2, y + yy, sz), DARK);
    }
    for (let i = 0; i < 20; i++) {
      const row = i % 7, lay = Math.floor(i / 7);
      const pz = sz - W / 2 + 0.15 + row * 0.15, py = y + 0.14 + lay * 0.07;
      ctx.brace(sx - 1.1, py, pz, sx + 0.35, py, pz, 0.03, ORANGE);
      ctx.tube(sx + 0.3, py, pz, sx + 1.15, py, pz, 0.024);
    }
    world.add(new Box(sx, y + H / 2, sz, L / 2, H / 2, W / 2, 0, 'stack'));
  }

  // ------------------------------------------------------------ mesh sheets on bearers (south strip)
  {
    const mx = 27.2, mz = 7.7;
    for (const bx of [-1.2, 0, 1.2]) B.add(M.wood, box(0.1, 0.08, 2.1), trs(mx + bx, y + 0.04, mz), TIMBER);
    for (let l = 0; l < 4; l++) {
      const ly = y + 0.09 + l * 0.022;
      const ox = (r() - 0.5) * 0.1, oz = (r() - 0.5) * 0.1;
      for (let k = 0; k <= 10; k++) ctx.bar(mx - 1.8 + ox, ly, mz - 1 + k * 0.2 + oz, mx + 1.8 + ox, ly, mz - 1 + k * 0.2 + oz, 0.005);
      for (let k = 0; k <= 18; k++) ctx.bar(mx - 1.8 + k * 0.2 + ox, ly + 0.01, mz - 1 + oz, mx - 1.8 + k * 0.2 + ox, ly + 0.01, mz + 1 + oz, 0.004);
    }
    world.add(new Box(mx, y + 0.1, mz, 1.85, 0.1, 1.05, 0, 'stack'));
  }

  // ------------------------------------------------------------ rebar bundles (north-east, clear of the beam line)
  {
    const rz = [21.25, 21.8], x0 = 32.6, x1 = 36.6;
    for (const bx of [33.4, 35.8]) B.add(M.wood, box(0.1, 0.08, 1.2), trs(bx, y + 0.04, 21.5), TIMBER);
    for (const zc of rz) {
      for (let i = 0; i < 14; i++) {
        const row = i % 5, lay = Math.floor(i / 5);
        const bz = zc - 0.1 + row * 0.05, by = y + 0.1 + lay * 0.045;
        ctx.bar(x0 + r() * 0.1, by, bz, x1 + r() * 0.1, by, bz, 0.016);
      }
      for (const bx of [x0 + 0.6, x1 - 0.6]) ctx.bar(bx, y + 0.08, zc - 0.13, bx, y + 0.08, zc + 0.13, 0.004);
    }
    world.add(new Box((x0 + x1) / 2, y + 0.12, 21.5, 2.05, 0.12, 0.5, 0, 'stack'));
  }

  // ------------------------------------------------------------ tools & clutter
  {
    // gang box
    const gx = 35.4, gz = 14.4;
    B.add(M.paint, box(1.2, 0.72, 0.7), trs(gx, y + 0.36, gz, 0.1), col(0x2c4a6e));
    B.add(M.paint, box(1.24, 0.06, 0.74), trs(gx, y + 0.75, gz, 0.1), col(0x2c4a6e));
    world.add(new Box(gx, y + 0.4, gz, 0.62, 0.4, 0.37, 0.1, 'stack'));
    // wheelbarrow
    wheelbarrow(ctx, 16.8, y, 9.4, 0.6);
    wheelbarrow(ctx, 38.8, y, 14.0, -2.2);
    // mortar tub + buckets
    B.add(M.plastic, lathe([[0, 0], [0.3, 0], [0.36, 0.26], [0.38, 0.27], [0.34, 0.27], [0.28, 0.02], [0, 0.02]], 18), trs(33.2, y, 9.2), col(0x1d1d1d));
    B.add(M.dirt, cyl(0.33, 0.33, 0.01, 14), trs(33.2, y + 0.2, 9.2));
    for (const [bx, bz] of [[34.0, 9.8], [32.5, 10.1]]) B.add(M.plastic, lathe([[0, 0], [0.13, 0], [0.16, 0.3], [0.15, 0.3], [0.12, 0.02], [0, 0.02]], 12), trs(bx, y, bz), col(0x1a1a1a));
    // hose coil and a length of pump line
    const hose = new THREE.TorusGeometry(0.35, 0.03, 6, 20);
    hose.rotateX(Math.PI / 2);
    B.add(M.rubber, hose, trs(40.6, y + 0.03, 23.0), col(0x2a2a2a));
    B.add(M.rubber, new THREE.TorusGeometry(0.3, 0.03, 6, 20), trs(40.6, y + 0.07, 23.1, 0, Math.PI / 2 - 0.05), col(0x2a2a2a));
    // plywood offcuts + timber scraps
    for (let i = 0; i < 7; i++) {
      const px = 13 + r() * 4.2, pz = 7 + r() * 11.5;
      if (Math.abs(px - 13.2) < 0.6) continue; // walkway
      B.add(M.ply, box(0.4 + r() * 0.8, 0.018, 0.3 + r() * 0.6), trs(px, y + 0.009 + i * 0.001, pz, r() * 3), PLY);
    }
    for (let i = 0; i < 6; i++) B.add(M.wood, box(1 + r() * 1.5, 0.05, 0.1), trs(38.5 + r() * 2.5, y + 0.025 + i * 0.05, 8.2 + r() * 0.6, (r() - 0.5) * 0.3), TIMBER);
    world.add(new Box(39.7, y + 0.15, 8.5, 1.6, 0.15, 0.6, 0, 'stack'));
  }

  // ------------------------------------------------------------ standing water on the deck
  // (ponding in the slight falls of a power-floated slab, mostly near the
  // edges and round the column bases where the finish is worst)
  for (const [px, pz, rx, rz] of [[14.4, 14.4, 1.3, 0.7], [38.6, 21.8, 1.5, 0.8], [26.5, 23.6, 1.0, 0.6], [19.8, 7.2, 0.9, 0.5], [13.1, 21.0, 0.5, 0.9]]) {
    const g = new THREE.PlaneGeometry(2, 2);
    g.rotateX(-Math.PI / 2);
    B.add(M.puddle, g, trs(px, y + 0.004, pz, r() * 3, 0, 0, rx, 1, rz));
  }
  r(); r(); r(); // (three puddles removed: keep the shared random sequence for later builders)
}

function columnForm(ctx, x, z, y) {
  const { B, M } = ctx;
  const H = 3.0, t = 0.021, o = 0.2 + t / 2;
  const plyC = WOOD.film;
  B.add(M.ply, box(0.44, H, t), trs(x, y + H / 2, z - o), plyC);
  B.add(M.ply, box(0.44, H, t), trs(x, y + H / 2, z + o), plyC);
  B.add(M.ply, box(t, H, 0.4), trs(x - o, y + H / 2, z), plyC);
  B.add(M.ply, box(t, H, 0.4), trs(x + o, y + H / 2, z), plyC);
  for (let yy = 0.3; yy < H; yy += 0.6) {
    B.add(M.paint, box(0.66, 0.06, 0.06), trs(x, y + yy, z - 0.27), YEL);
    B.add(M.paint, box(0.66, 0.06, 0.06), trs(x, y + yy, z + 0.27), YEL);
    B.add(M.paint, box(0.06, 0.06, 0.66), trs(x - 0.27, y + yy + 0.06, z), YEL);
    B.add(M.paint, box(0.06, 0.06, 0.66), trs(x + 0.27, y + yy + 0.06, z), YEL);
  }
  // two push-pull props into the deck (away from the slab edge)
  for (const dz of [-1, 1]) {
    ctx.brace(x + 0.3, y + 2.3, z + dz * 0.1, x + 1.7, y + 0.05, z + dz * 0.9, 0.028, ORANGE);
    B.add(M.paint, box(0.2, 0.02, 0.2), trs(x + 1.7, y + 0.01, z + dz * 0.9), DARK);
  }
}

function wheelbarrow(ctx, x, y, z, yaw) {
  const { B, M } = ctx;
  B.within(trs(x, y, z, yaw), () => {
    B.add(M.paint, prism([[-0.35, 0.28], [0.4, 0.28], [0.55, 0.62], [-0.55, 0.62]], 0.62), null, col(0x2f6b3a));
    B.add(M.paint, box(0.95, 0.02, 0.5), trs(0, 0.6, 0), col(0x2f6b3a));
    const wheel = cyl(0.19, 0.19, 0.08, 14);
    wheel.rotateX(Math.PI / 2);
    B.add(M.rubber, wheel, trs(0.62, 0.19, 0), col(0x1c1c1c));
    for (const s of [-1, 1]) {
      B.add(M.paint, box(1.4, 0.035, 0.035), trs(-0.1, 0.33, s * 0.24, 0, 0, 0.18), DARK);
      B.add(M.paint, box(0.035, 0.3, 0.035), trs(-0.35, 0.15, s * 0.22), DARK);
    }
  });
}
