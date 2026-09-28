import * as THREE from 'three';
import { SITE } from '../../config.js';
import { Box } from '../../physics/collide.js';
import { box, cyl, plane, trs, seg, col, colored, InstBatch } from './kit.js';
import { WOOD } from './materials.js';

// The concrete frame under construction: five storeys of flat slab on
// 400 mm columns, a hollow lift/stair core, masonry infill going in on the
// lower floors, the formwork deck + props still under the newest slab and
// back-props one floor down, a rack-and-pinion hoist, the level-6 wall form
// (bucket job) and mesh edge protection round the working deck.
//
// GAMEPLAY CONTRACT: slab / column / core / stub / form colliders and the
// colX / colZ / deckY / formLine values are identical to the original site.

const YELLOW = col(0xe0a800), RED_OXIDE = col(0x7c3b27), ORANGE = col(0xd9530f), GREY = col(0x8d9296);
const DARK = col(0x3b3f44), FORM_YEL = col(0xe3b21a), PLY_FILM = WOOD.film, H20 = WOOD.h20;

export function buildFrame(ctx) {
  const { world, B, M, r, q } = ctx;
  const low = q.name === 'low';
  const b = SITE.building;
  const F = b.floor, T = b.slab;
  const colX = [b.minX + 0.3, b.minX + 6.3, b.minX + 12.3, b.minX + 18.3, b.minX + 24.3, b.maxX - 0.3];
  const colZ = [b.minZ + 0.3, b.minZ + 6.9, b.minZ + 13.5, b.maxZ - 0.3];
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
  const deckY = b.levels * b.floor;
  const core = { x0: b.maxX - 5.7, x1: b.maxX - 0.3, z0: b.minZ + 0.4, z1: b.minZ + 6.0, t: 0.25 };
  const coreTop = deckY + 3.4;

  // ------------------------------------------------------------ slabs & columns
  B.add(M.concSlab, box(w + 1, 0.2, d + 1), trs(cx, 0.1, cz));
  world.add(new Box(cx, 0.1, cz, (w + 1) / 2, 0.1, (d + 1) / 2, 0, 'slab'));
  const slabPiece = (x0, x1, z0, z1, y) => {
    if (x1 - x0 < 0.01 || z1 - z0 < 0.01) return;
    B.add(M.concSlab, box(x1 - x0, T, z1 - z0, x0, z0), trs((x0 + x1) / 2, y - T / 2, (z0 + z1) / 2));
  };
  const EB = 0.25, ED = 0.22; // perimeter downstand (edge beam) makes the slab edges read at distance
  for (let lvl = 1; lvl <= b.levels; lvl++) {
    const y = lvl * F;
    slabPiece(b.minX, core.x0, b.minZ, b.maxZ, y);
    slabPiece(core.x0, core.x1, core.z1, b.maxZ, y);
    slabPiece(core.x0, core.x1, b.minZ, core.z0, y);
    slabPiece(core.x1, b.maxX, b.minZ, b.maxZ, y);
    const ey = y - T - ED / 2;
    B.add(M.concSlab, box(w, ED, EB, b.minX, ey), trs(cx, ey, b.minZ + EB / 2));
    B.add(M.concSlab, box(w, ED, EB, b.minX, ey), trs(cx, ey, b.maxZ - EB / 2));
    B.add(M.concSlab, box(EB, ED, d - 2 * EB, b.minZ, ey), trs(b.minX + EB / 2, ey, cz));
    B.add(M.concSlab, box(EB, ED, d - 2 * EB, b.minZ, ey), trs(b.maxX - EB / 2, ey, cz));
    world.add(new Box(cx, y - T / 2, cz, w / 2, T / 2, d / 2, 0, 'slab'));
    const y0 = (lvl - 1) * F + (lvl === 1 ? 0.2 : 0);
    const h = y - T - y0;
    for (const x of colX) {
      for (const z of colZ) {
        B.add(M.concCol, box(0.4, h, 0.4, r() * 3, y0), trs(x, y0 + h / 2, z));
        world.add(new Box(x, y0 + h / 2, z, 0.2, h / 2, 0.2, 0, 'column'));
      }
    }
  }

  // ------------------------------------------------------------ core (hollow)
  // Collider stays the original solid box; visually the walls are 250 mm
  // with door openings each floor so you can look down the shafts.
  world.add(new Box(b.maxX - 3, coreTop / 2, b.minZ + 3.2, 2.7, coreTop / 2, 2.8, 0, 'core'));
  const ct = core.t, cy0 = 0.2, ch = coreTop - cy0;
  const zm = (core.z0 + core.z1) / 2;
  B.add(M.concCore, box(core.x1 - core.x0, ch, ct, core.x0, cy0), trs((core.x0 + core.x1) / 2, cy0 + ch / 2, core.z0 + ct / 2));
  B.add(M.concCore, box(core.x1 - core.x0, ch, ct, core.x0, cy0), trs((core.x0 + core.x1) / 2, cy0 + ch / 2, core.z1 - ct / 2));
  B.add(M.concCore, box(ct, ch, core.z1 - core.z0 - 2 * ct, core.z0, cy0), trs(core.x1 - ct / 2, cy0 + ch / 2, (core.z0 + core.z1) / 2));
  B.add(M.concCore, box(core.x1 - core.x0 - 2 * ct, ch, 0.2, core.x0, cy0), trs((core.x0 + core.x1) / 2, cy0 + ch / 2, zm));
  for (let s = 0; s <= b.levels; s++) {
    const y0 = s === 0 ? 0.2 : s * F;
    const y1 = s === b.levels ? coreTop : (s + 1) * F;
    wall(B, M.concCore, 'z', core.x0 + ct / 2, core.z0 + ct, core.z1 - ct, y0, y1, ct, [
      { a0: core.z0 + 0.8, a1: core.z0 + 1.9, h0: y0, h1: y0 + 2.1 },
      { a0: zm + 0.75, a1: zm + 1.75, h0: y0, h1: y0 + 2.1 },
    ]);
  }
  // stair flights + landings inside the north half of the core
  const sx0 = core.x0 + ct, sx1 = core.x1 - ct, sz0 = zm + 0.1, sz1 = core.z1 - ct;
  const sw = (sz1 - sz0) / 2;
  for (let s = 0; s < b.levels; s++) {
    const y = s === 0 ? 0.2 : s * F;
    B.add(M.concCore, box(1.25, 0.2, sz1 - sz0), trs(sx0 + 0.625, y - 0.1, (sz0 + sz1) / 2));
    B.add(M.concCore, box(1.25, 0.2, sz1 - sz0), trs(sx1 - 0.625, s * F + 1.6 - 0.1, (sz0 + sz1) / 2));
    const run = sx1 - sx0 - 2.5;
    for (const [z, ya, yb, dir] of [[sz0 + sw / 2, y, s * F + 1.6, 1], [sz1 - sw / 2, s * F + 1.6, (s + 1) * F, -1]]) {
      const len = Math.hypot(run, yb - ya);
      const pitch = Math.atan2(yb - ya, run) * dir;
      B.add(M.concCore, box(len, 0.18, sw - 0.05), trs((sx0 + sx1) / 2, (ya + yb) / 2 - 0.12, z, 0, 0, pitch));
    }
  }
  // handrail round the open core top
  {
    const y = coreTop + 1.0;
    const rails = [[core.x0, core.z0, core.x1, core.z0], [core.x1, core.z0, core.x1, core.z1], [core.x1, core.z1, core.x0, core.z1], [core.x0, core.z1, core.x0, core.z0]];
    for (const [ax, az, bx, bz] of rails) {
      ctx.tube(ax, y, az, bx, y, bz);
      ctx.tube(ax, y - 0.5, az, bx, y - 0.5, bz);
      const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 1.8);
      for (let i = 0; i <= n; i++) ctx.tube(ax + (bx - ax) * i / n, coreTop, az + (bz - az) * i / n, ax + (bx - ax) * i / n, y + 0.05, az + (bz - az) * i / n);
    }
  }

  // ------------------------------------------------------------ masonry infill
  // Blockwork on the south/west faces and facing brick on the north face
  // (behind the scaffold), complete on the lower floors and in progress above.
  const wallTop = (s) => (s + 1) * F - T - ED;
  const floorOf = (s) => (s === 0 ? 0.2 : s * F);
  const bays = (cs) => cs.slice(0, -1).map((c, i) => [c + 0.2, cs[i + 1] - 0.2]);
  const windows = (a0, a1, y0, n = 2) => {
    const L = a1 - a0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = a0 + L * (n === 1 ? 0.5 : 0.27 + i * 0.46);
      out.push({ a0: c - 0.75, a1: c + 0.75, h0: y0 + 0.9, h1: y0 + 2.25 });
    }
    return out;
  };
  // upTo: 0 = storey height, else metres of wall built so far
  const masonry = (mat, axis, fixed, outward, bayList, s, upTo = 0, boarded = 0) => {
    const y0 = floorOf(s), yt = wallTop(s);
    const y1 = upTo > 0 ? Math.min(yt, y0 + upTo) : yt;
    for (const [a0, a1] of bayList) {
      const ops = windows(a0, a1, y0);
      wall(B, mat, axis, fixed, a0, a1, y0, y1, 0.2, ops);
      for (const o of ops) {
        if (y1 < o.h0 + 0.05) continue;
        const wo = o.a1 - o.a0, c = (o.a0 + o.a1) / 2;
        const out = fixed + outward * 0.05;
        // precast cill + lintel
        if (axis === 'x') B.add(M.precast, box(wo + 0.2, 0.07, 0.28), trs(c, o.h0 - 0.035, out));
        else B.add(M.precast, box(0.28, 0.07, wo + 0.2), trs(out, o.h0 - 0.035, c));
        if (y1 >= yt - 0.01) {
          if (axis === 'x') B.add(M.precast, box(wo + 0.3, 0.15, 0.2), trs(c, o.h1 + 0.075, fixed));
          else B.add(M.precast, box(0.2, 0.15, wo + 0.3), trs(fixed, o.h1 + 0.075, c));
        }
        // some lower openings boarded up with OSB against the weather
        if (boarded && r() < boarded) {
          const bf = fixed + outward * 0.08;
          if (axis === 'x') B.add(M.osb, box(wo + 0.06, o.h1 - o.h0 + 0.06, 0.018, o.a0, o.h0), trs(c, (o.h0 + o.h1) / 2, bf));
          else B.add(M.osb, box(0.018, o.h1 - o.h0 + 0.06, wo + 0.06, o.a0, o.h0), trs(bf, (o.h0 + o.h1) / 2, c));
        }
      }
    }
    // collider across the whole run
    const a0 = bayList[0][0], a1 = bayList[bayList.length - 1][1];
    const hy = (y1 - y0) / 2;
    if (axis === 'x') world.add(new Box((a0 + a1) / 2, y0 + hy, fixed, (a1 - a0) / 2, hy, 0.1, 0, 'wall'));
    else world.add(new Box(fixed, y0 + hy, (a0 + a1) / 2, 0.1, hy, (a1 - a0) / 2, 0, 'wall'));
  };
  const southBays = bays(colX).slice(0, 4); // the fifth bay is the core
  const northBays = bays(colX);
  const westBays = bays(colZ);
  masonry(M.block, 'x', b.minZ + 0.1, -1, southBays, 0, 0, 0.35);
  masonry(M.block, 'x', b.minZ + 0.1, -1, southBays.slice(0, 3), 1, 0, 0.15);
  masonry(M.block, 'x', b.minZ + 0.1, -1, southBays.slice(3), 1, 1.2);
  masonry(M.block, 'x', b.minZ + 0.1, -1, southBays.slice(0, 1), 2, 0.9);
  masonry(M.block, 'z', b.minX + 0.1, -1, westBays, 0, 0, 0.3);
  masonry(M.block, 'z', b.minX + 0.1, -1, westBays.slice(0, 1), 1, 0);
  masonry(M.brick, 'x', b.maxZ - 0.1, 1, northBays, 0, 0);
  masonry(M.brick, 'x', b.maxZ - 0.1, 1, northBays, 1, 0);
  masonry(M.brick, 'x', b.maxZ - 0.1, 1, northBays.slice(0, 3), 2, 1.1);
  masonry(M.brick, 'x', b.maxZ - 0.1, 1, northBays.slice(3), 2, 0.45);

  // ------------------------------------------------------------ formwork deck + props under the newest slab
  // Aluminium-headed steel props at 1.5 m on primary + secondary timber
  // beams (H20 profile) carrying the plywood soffit form — the classic
  // "forest of props" you see through the top storey of every frame job.
  const inCore = (x, z, m = 0.15) => x > core.x0 - m && x < core.x1 + m && z > core.z0 - m && z < core.z1 + m;
  {
    const top = deckY - T; // 15.75 soffit
    const bot = (b.levels - 1) * F; // 12.8
    // plywood soffit form
    const plyY = top - 0.012;
    const addPly = (x0, x1, z0, z1) => B.add(M.ply, box(x1 - x0, 0.018, z1 - z0, x0, z0), trs((x0 + x1) / 2, plyY, (z0 + z1) / 2), WOOD.plyUsed);
    addPly(b.minX + EB, core.x0, b.minZ + EB, b.maxZ - EB);
    addPly(core.x0, b.maxX - EB, core.z1, b.maxZ - EB);
    // secondary H20 beams (along z) at 0.5 m
    const secY = plyY - 0.009 - 0.1;
    const secGeo = colored(box(0.08, 0.2, 1));
    const secB = new InstBatch(secGeo, M.wood, { name: 'h20' });
    for (let x = b.minX + 0.6; x < b.maxX - 0.4; x += 0.5) {
      const z0 = x > core.x0 - 0.1 ? core.z1 + 0.1 : b.minZ + 0.35;
      const z1 = b.maxZ - 0.35;
      secB.add(trs(x, secY, (z0 + z1) / 2, 0, 0, 0, 1, 1, z1 - z0), H20);
    }
    // primaries (along x) at 1.5 m, props under them at 1.5 m
    const priY = secY - 0.2;
    const propTop = priY - 0.1;
    const propGeo = propGeometry(propTop - bot);
    const props = new InstBatch(propGeo, M.paint, { name: 'props' });
    for (let z = b.minZ + 1.0; z < b.maxZ - 0.5; z += 1.5) {
      const x0 = b.minX + 0.4;
      const x1 = z < core.z1 + 0.2 ? core.x0 - 0.1 : b.maxX - 0.4;
      secB.add(trs((x0 + x1) / 2, priY, z, Math.PI / 2, 0, 0, 1, 1, x1 - x0), H20);
      for (let x = b.minX + 0.9; x < x1; x += 1.5) {
        if (inCore(x, z)) continue;
        props.add(trs(x + (r() - 0.5) * 0.08, bot, z + (r() - 0.5) * 0.08, r() * 6));
      }
    }
    secB.build(ctx.root);
    props.build(ctx.root);
    world.add(new Box(cx, (bot + top) / 2, cz, w / 2 - 0.35, (top - bot) / 2, d / 2 - 0.35, 0, 'props'));

    // back-props one storey down (wider grid, straight to the soffit)
    if (!low) {
      const top2 = bot - T, bot2 = (b.levels - 2) * F;
      const back = new InstBatch(propGeometry(top2 - bot2), M.paint, { name: 'backprops' });
      for (let z = b.minZ + 1.6; z < b.maxZ - 0.5; z += 2.4) {
        for (let x = b.minX + 1.5; x < b.maxX - 0.5; x += 2.4) {
          if (inCore(x, z, 0.4)) continue;
          back.add(trs(x, bot2, z, r() * 6));
        }
      }
      back.build(ctx.root);
      world.add(new Box(cx, (bot2 + top2) / 2, cz, w / 2 - 0.35, (top2 - bot2) / 2, d / 2 - 0.35, 0, 'props'));
    }
  }

  // ------------------------------------------------------------ level-6 steel stubs (beam job targets)
  const stubZ = colZ[2];
  const stubs = [colX[2], colX[4]];
  for (const x of stubs) {
    const sh = 3.2;
    const y0 = deckY + 0.03, y1 = deckY + sh - 0.02;
    const hh = y1 - y0;
    // HEB 300: 300 x 300, 19 mm flanges, 11 mm web
    B.add(M.paint, box(0.3, hh, 0.019), trs(x, y0 + hh / 2, stubZ - 0.1405), RED_OXIDE);
    B.add(M.paint, box(0.3, hh, 0.019), trs(x, y0 + hh / 2, stubZ + 0.1405), RED_OXIDE);
    B.add(M.paint, box(0.011, hh, 0.262), trs(x, y0 + hh / 2, stubZ), RED_OXIDE);
    B.add(M.paint, box(0.5, 0.03, 0.5), trs(x, deckY + 0.015, stubZ), RED_OXIDE);
    B.add(M.precast, box(0.56, 0.02, 0.56), trs(x, deckY + 0.005, stubZ));
    B.add(M.paint, box(0.45, 0.02, 0.45), trs(x, deckY + sh - 0.01, stubZ), RED_OXIDE);
    for (const [bx, bz] of [[-0.19, -0.19], [0.19, -0.19], [0.19, 0.19], [-0.19, 0.19]]) {
      B.add(M.steel, cyl(0.014, 0.014, 0.09, 6), trs(x + bx, deckY + 0.05, stubZ + bz), DARK);
    }
    world.add(new Box(x, deckY + sh / 2, stubZ, 0.15, sh / 2, 0.15, 0, 'column'));
  }

  // ------------------------------------------------------------ wall formwork (bucket job form line)
  const formLine = { x0: colX[1] + 0.6, x1: colX[3] - 0.6, z: colZ[1] };
  wallForm(ctx, formLine, deckY);
  world.add(new Box((formLine.x0 + formLine.x1) / 2, deckY + 1.4, formLine.z, (formLine.x1 - formLine.x0) / 2, 1.4, 0.25, 0, 'form'));

  // ------------------------------------------------------------ edge protection on the working deck
  {
    const e = 0.05;
    const runs = [
      // [ax, az, bx, bz, gaps[[a,b]] along the run]
      [b.minX + 3.9, b.minZ + e, b.maxX, b.minZ + e, []], // south (stair-tower landing west of x 15.9)
      [b.minX + e, b.minZ, b.minX + e, b.maxZ, []],
      [b.maxX - e, core.z1, b.maxX - e, b.maxZ, [[16.6, 19.8]]], // east, hoist landing gate
      [b.minX, b.maxZ - e, b.maxX, b.maxZ - e, []],
    ];
    for (const [ax, az, bx, bz, gaps] of runs) edgeRun(ctx, deckY, ax, az, bx, bz, gaps);
    // gate panels at the stair tower + hoist landings
    edgePanel(ctx, deckY, b.minX + 0.1, b.minZ + e, b.minX + 1.3, b.minZ + e, true);
    edgePanel(ctx, deckY, b.maxX - e, 16.6, b.maxX - e, 19.8, true, col(0xc9ccce));
  }

  // ------------------------------------------------------------ goods / passenger hoist on the east face
  buildHoist(ctx, deckY);

  return { colX, colZ, deckY, stubs, stubZ, formLine, core, coreTop };
}

// Wall between a0..a1 (along `axis`) at `fixed`, with rectangular openings.
export function wall(B, mat, axis, fixed, a0, a1, y0, y1, t, openings = []) {
  const ops = openings.filter((o) => o.a1 > a0 && o.a0 < a1).sort((p, q) => p.a0 - q.a0);
  const piece = (pa0, pa1, py0, py1) => {
    if (pa1 - pa0 < 0.01 || py1 - py0 < 0.01) return;
    const len = pa1 - pa0, h = py1 - py0;
    if (axis === 'x') B.add(mat, box(len, h, t, pa0, py0), trs((pa0 + pa1) / 2, (py0 + py1) / 2, fixed));
    else B.add(mat, box(t, h, len, pa0, py0), trs(fixed, (py0 + py1) / 2, (pa0 + pa1) / 2));
  };
  let cur = a0;
  for (const o of ops) {
    piece(cur, o.a0, y0, y1);
    piece(o.a0, o.a1, y0, Math.min(o.h0, y1));
    piece(o.a0, o.a1, Math.max(o.h1, y0), y1);
    cur = o.a1;
  }
  piece(cur, a1, y0, y1);
}

// Adjustable steel prop: painted outer tube + collar, galvanised inner, plates.
export function propGeometry(H) {
  const parts = [];
  const add = (g, m, c) => { g.applyMatrix4(m); colored(g, c); parts.push(g.index ? g.toNonIndexed() : g); };
  const out = Math.min(1.6, H * 0.6);
  add(cyl(0.03, 0.03, out, 7), trs(0, out / 2 + 0.01, 0), col(0xc8421c));
  add(cyl(0.045, 0.045, 0.07, 7), trs(0, out, 0), col(0xc8421c));
  add(cyl(0.024, 0.024, H - out, 6), trs(0, out + (H - out) / 2, 0), col(0x9da2a6));
  add(box(0.15, 0.008, 0.15), trs(0, 0.004, 0), col(0x6c6f72));
  add(box(0.16, 0.012, 0.16), trs(0, H - 0.006, 0), col(0x6c6f72));
  return mergeParts(parts);
}

function mergeParts(parts) {
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv', 'color']) {
    const size = k === 'uv' ? 2 : 3;
    const a = new Float32Array(n * size);
    let o = 0;
    for (const p of parts) { a.set(p.attributes[k].array, o); o += p.attributes[k].array.length; }
    g.setAttribute(k, new THREE.BufferAttribute(a, size));
  }
  g.computeBoundingSphere();
  return g;
}
export { mergeParts };

// Framed-panel wall formwork: film-faced ply on steel frames, walers, ties,
// push-pull props and a working platform on the south side.
function wallForm(ctx, fl, deckY) {
  const { B, M } = ctx;
  const L = fl.x1 - fl.x0, H = 2.8, xm = (fl.x0 + fl.x1) / 2;
  const nP = 4, pw = L / nP;
  for (const sgn of [-1, 1]) {
    const zf = fl.z + sgn * 0.17;
    B.add(M.ply, box(L, H, 0.021, fl.x0, deckY), trs(xm, deckY + H / 2, zf + sgn * 0.0105), PLY_FILM);
    const zr = zf + sgn * (0.021 + 0.06);
    for (let i = 0; i < nP; i++) {
      const x0 = fl.x0 + i * pw;
      for (const x of [x0 + 0.04, x0 + pw - 0.04]) B.add(M.paint, box(0.07, H, 0.12), trs(x, deckY + H / 2, zr), FORM_YEL);
      for (const y of [0.04, 0.95, 1.85, H - 0.04]) B.add(M.paint, box(pw - 0.14, 0.06, 0.1), trs(x0 + pw / 2, deckY + y, zr), FORM_YEL);
    }
    // walers
    const zw = zr + sgn * 0.13;
    for (const y of [0.55, 2.2]) B.add(M.paint, box(L + 0.3, 0.14, 0.12), trs(xm, deckY + y, zw), DARK);
    // tie rods + wing nuts
    for (let x = fl.x0 + 0.7; x < fl.x1; x += 1.35) {
      for (const y of [0.55, 2.2]) {
        B.add(M.steel, box(0.12, 0.12, 0.03), trs(x, deckY + y, zw + sgn * 0.075), DARK);
        if (sgn < 0) B.add(M.rebar, cyl(0.013, 0.013, 0.95, 5), trs(x, deckY + y, fl.z, 0, Math.PI / 2));
      }
    }
    // push-pull props (braces) to the deck — north face; the south face
    // carries the working platform instead
    if (sgn > 0) for (let x = fl.x0 + 0.7; x < fl.x1; x += 2.7) {
      const zb = fl.z + sgn * 1.5;
      ctx.brace(x, deckY + 2.2, zw + sgn * 0.08, x, deckY + 0.06, zb, 0.03, ORANGE);
      ctx.brace(x, deckY + 0.6, zw + sgn * 0.08, x, deckY + 0.06, zb - sgn * 0.15, 0.025, ORANGE);
      B.add(M.paint, box(0.18, 0.02, 0.26), trs(x, deckY + 0.01, zb), DARK);
    }
    // stop ends
    if (sgn > 0) for (const x of [fl.x0 - 0.02, fl.x1 + 0.02]) B.add(M.ply, box(0.04, H, 0.34), trs(x, deckY + H / 2, fl.z), PLY_FILM);
  }
  // working platform (south face) — kept below the form top so the bucket clears it
  const zp0 = fl.z - 0.17 - 0.3, pw2 = 0.8, py = deckY + 1.55;
  for (let x = fl.x0 + 0.3; x <= fl.x1 - 0.2; x += 2.6) {
    B.add(M.paint, box(0.06, 0.08, pw2 + 0.1), trs(x, py - 0.06, zp0 - pw2 / 2), DARK);
    ctx.brace(x, py - 0.1, zp0 - pw2, x, py - 0.9, zp0 - 0.05, 0.022, DARK);
    ctx.tube(x, py, zp0 - pw2 + 0.03, x, py + 1.1, zp0 - pw2 + 0.03, 0.022);
  }
  for (let i = 0; i < 3; i++) B.add(M.wood, box(L, 0.038, 0.225), trs((fl.x0 + fl.x1) / 2, py, zp0 - 0.14 - i * 0.24), WOOD.board);
  for (const y of [0.55, 1.05]) ctx.tube(fl.x0 + 0.2, py + y, zp0 - pw2 + 0.03, fl.x1 - 0.1, py + y, zp0 - pw2 + 0.03, 0.022);
  B.add(M.wood, box(L, 0.15, 0.03), trs((fl.x0 + fl.x1) / 2, py + 0.09, zp0 - pw2 + 0.06), WOOD.board);
}

// Mesh edge-protection run along a deck edge, posts every 2.4 m.
function edgeRun(ctx, deckY, ax, az, bx, bz, gaps) {
  const L = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.round(L / 2.4));
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
    const along = ax === bx ? (z0 + z1) / 2 : (x0 + x1) / 2;
    if (gaps.some(([g0, g1]) => along > g0 - 0.3 && along < g1 + 0.3)) continue;
    edgePanel(ctx, deckY, x0, z0, x1, z1, false);
  }
}

function edgePanel(ctx, deckY, x0, z0, x1, z1, gate, color = YELLOW) {
  const { B, M } = ctx;
  const L = Math.hypot(x1 - x0, z1 - z0) - 0.06;
  const yaw = Math.atan2(-(z1 - z0), x1 - x0);
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const h = gate ? 1.0 : 1.1;
  const y = deckY + 0.12;
  B.add(M.mesh, plane(L, h - 0.16), trs(mx, y + 0.16 + (h - 0.16) / 2, mz, yaw), color);
  const fr = (lx, ly, sx, sy) => B.add(M.paint, box(sx, sy, 0.03), trs(mx + Math.cos(yaw) * lx, y + ly, mz - Math.sin(yaw) * lx, yaw), color);
  fr(0, h, L, 0.035);
  fr(0, 0.08, L, 0.16); // toe plate
  fr(-L / 2, h / 2, 0.035, h);
  fr(L / 2, h / 2, 0.035, h);
  // post + slab-edge clamp
  B.add(M.paint, box(0.05, 1.25, 0.05), trs(x0, deckY + 0.62, z0, yaw), DARK);
  B.add(M.paint, box(0.12, 0.1, 0.12), trs(x0, deckY + 0.05, z0, yaw), DARK);
}

// Rack-and-pinion hoist: lattice mast tied to each slab, cage parked at the
// bottom inside a mesh base enclosure, landing gates at every floor.
function buildHoist(ctx, deckY) {
  const { B, M, world } = ctx;
  const mx = 44.6, mz = 18.2, top = deckY + 4.6, hm = 0.325;
  const corners = [[-hm, -hm], [hm, -hm], [hm, hm], [-hm, hm]];
  for (const [ox, oz] of corners) ctx.tube(mx + ox, 0.2, mz + oz, mx + ox, top, mz + oz, 0.038, true);
  // zig-zag lacing on each face
  for (let y = 0.3; y < top - 0.5; y += 0.75) {
    for (let f = 0; f < 4; f++) {
      const [ax, az] = corners[f], [bx, bz] = corners[(f + 1) % 4];
      ctx.tube(mx + ax, y, mz + az, mx + bx, y + 0.75, mz + bz, 0.014, true);
    }
  }
  B.add(M.steel, box(0.06, top - 0.3, 0.08), trs(mx - hm - 0.04, 0.2 + (top - 0.3) / 2, mz), col(0x3a3a3a));
  B.add(M.paint, box(1.0, 0.3, 1.0), trs(mx, 0.15, mz), DARK);
  // ties to each slab edge
  for (let lvl = 1; lvl <= 5; lvl++) {
    const y = lvl * 3.2 - 0.45;
    ctx.tube(mx - hm, y, mz - 0.25, 42.0, y, mz - 0.9, 0.024, true);
    ctx.tube(mx - hm, y, mz + 0.25, 42.0, y, mz + 0.9, 0.024, true);
    // landing gate
    if (lvl < 5) {
      B.add(M.mesh, plane(3.0, 1.0), trs(41.96, lvl * 3.2 + 0.65, 18.2, Math.PI / 2), col(0xc9ccce));
      B.add(M.paint, box(0.04, 0.04, 3.0), trs(41.96, lvl * 3.2 + 1.15, 18.2), YELLOW);
    }
  }
  // cage (parked at ground level)
  const c0 = 42.45, c1 = 44.2, z0 = 16.6, z1 = 19.8, y0 = 0.4, y1 = 2.95;
  const ccx = (c0 + c1) / 2, ccz = (z0 + z1) / 2;
  B.add(M.paint, box(c1 - c0, 0.12, z1 - z0), trs(ccx, y0, ccz), GREY);
  B.add(M.paint, box(c1 - c0 + 0.06, 0.1, z1 - z0 + 0.06), trs(ccx, y1, ccz), col(0xd0cfc8));
  for (const [x, z] of [[c0, z0], [c1, z0], [c1, z1], [c0, z1]]) B.add(M.paint, box(0.07, y1 - y0, 0.07), trs(x, (y0 + y1) / 2, z), YELLOW);
  for (const [px, pz, len, yaw] of [[ccx, z0, c1 - c0, 0], [ccx, z1, c1 - c0, 0], [c0, ccz, z1 - z0, Math.PI / 2]]) {
    B.add(M.paint, box(len, 1.0, 0.03), trs(px, y0 + 0.55, pz, yaw), col(0xd0cfc8));
    B.add(M.mesh, plane(len, y1 - y0 - 1.1), trs(px, y0 + 1.05 + (y1 - y0 - 1.1) / 2, pz, yaw), col(0xb9bcbe));
  }
  B.add(M.paint, box(0.9, 0.7, 1.4), trs(c1 + 0.05, y1 + 0.35, ccz), col(0x6e7378));
  // base enclosure
  const e0 = 42.2, e1 = 46.1, ez0 = 15.7, ez1 = 20.7;
  for (const [ax, az, bx, bz] of [[e0, ez0, e1, ez0], [e1, ez0, e1, ez1], [e0, ez1, e1, ez1]]) {
    const L = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(-(bz - az), bx - ax);
    B.add(M.mesh, plane(L, 1.9), trs((ax + bx) / 2, 1.05, (az + bz) / 2, yaw), col(0xb9bcbe));
    B.add(M.paint, box(L, 0.05, 0.05), trs((ax + bx) / 2, 2.0, (az + bz) / 2, yaw), YELLOW);
  }
  world.add(new Box((e0 + e1) / 2, 1.5, (ez0 + ez1) / 2, (e1 - e0) / 2, 1.5, (ez1 - ez0) / 2, 0, 'hoist'));
  world.add(new Box(mx, top / 2, mz, 0.4, top / 2, 0.4, 0, 'hoist'));
  ctx.sign('hoist', 1.0, 0.5, (e0 + e1) / 2, 1.4, ez0 - 0.03, Math.PI);
}
