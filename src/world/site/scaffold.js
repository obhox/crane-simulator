import { SITE } from '../../config.js';
import { Box } from '../../physics/collide.js';
import { box, plane, trs, col } from './kit.js';
import { WOOD } from './materials.js';

// Independent tube-and-coupler scaffold on the north (+z) facade and a
// stair tower on the south face. 48.3 mm galvanised tube, 2.5 m bays,
// 2 m lifts, boarded every other lift with toe boards / double guardrails,
// brick guards at the bricklayers' working lift, façade + ledger bracing,
// ties into the frame, ladder bay, sole boards, and debris netting /
// sheeting over part of the face (flutters in the wind).
//
// GAMEPLAY CONTRACT: the scaffold collider (z ≈ 26.85..28.25, full width,
// up to deckY + 2) is unchanged; the stair tower gets its own collider.

const BOARD = WOOD.board, TOE = WOOD.weathered;

export function buildScaffold(ctx, F) {
  const { B, M, world, r } = ctx;
  const b = SITE.building;
  const { deckY } = F;
  const cx = (b.minX + b.maxX) / 2, w = b.maxX - b.minX;
  const topY = deckY + 2;
  const zi = b.maxZ + 0.95, zo = b.maxZ + 2.15; // inner / outer standard lines
  const xs = [];
  for (let x = b.minX; x <= b.maxX + 0.01; x += 2.5) xs.push(x);
  const lifts = [];
  for (let y = 2; y <= topY + 0.01; y += 2) lifts.push(y);
  const boarded = [2, 6, 10, 14, 18];
  const working = 6;
  const sTop = topY + 1.15;

  // standards, base plates, sole boards
  for (const x of xs) {
    for (const z of [zi, zo]) {
      ctx.tube(x, 0.03, z, x, sTop, z);
      B.add(M.steel, box(0.15, 0.008, 0.15), trs(x, 0.035, z), col(0x7a7d80));
    }
    B.add(M.wood, box(0.225, 0.038, 1.9), trs(x, 0.019, (zi + zo) / 2, (r() - 0.5) * 0.1), BOARD);
  }
  // ledgers + transoms per lift
  for (const y of lifts) {
    ctx.tube(b.minX - 0.1, y, zi, b.maxX + 0.1, y, zi);
    ctx.tube(b.minX - 0.1, y, zo, b.maxX + 0.1, y, zo);
    for (const x of xs) {
      ctx.tube(x + 0.06, y + 0.055, zi - 0.12, x + 0.06, y + 0.055, zo + 0.12);
      ctx.coupler(x, y, zi); ctx.coupler(x, y, zo);
    }
  }
  // ledger (transverse) bracing on alternate standards
  for (let i = 0; i < xs.length; i += 2) {
    for (let k = 0; k < lifts.length - 1; k += 2) {
      ctx.tube(xs[i] - 0.06, lifts[k], zi, xs[i] - 0.06, lifts[k + 1], zo, 0.024);
    }
    ctx.tube(xs[i] - 0.06, 0.2, zo, xs[i] - 0.06, lifts[0], zi, 0.024);
  }
  // façade bracing: zig-zag diagonals up the outer face every 4th bay
  for (const bi of [0, 4, 8]) {
    const x0 = xs[bi], x1 = xs[bi + 1];
    let y = 0.2, k = 0;
    for (const yl of lifts) {
      const [ax, bx] = k % 2 ? [x1, x0] : [x0, x1];
      ctx.tube(ax, y, zo + 0.06, bx, yl, zo + 0.06);
      y = yl; k++;
    }
  }
  // boarded lifts: boards, mid transoms, toe boards, double guardrails
  const boardGeo = box(2.62, 0.038, 0.225);
  for (const y of boarded) {
    const by = y + 0.055 + 0.024 + 0.019;
    for (let i = 0; i < xs.length - 1; i++) {
      const xm = (xs[i] + xs[i + 1]) / 2;
      ctx.tube(xm, y + 0.055, zi - 0.12, xm, y + 0.055, zo + 0.12);
      for (let k = 0; k < 5; k++) {
        const bz = zi + 0.14 + k * 0.23;
        ctx.board(trs(xm + (r() - 0.5) * 0.12, by + (r() - 0.5) * 0.006, bz, (r() - 0.5) * 0.012));
      }
      // toe board + rails (outer)
      B.add(M.wood, box(2.5, 0.15, 0.038), trs(xm, by + 0.09, zo - 0.05), TOE);
    }
    ctx.tube(b.minX - 0.1, y + 0.55, zo, b.maxX + 0.1, y + 0.55, zo);
    ctx.tube(b.minX - 0.1, y + 1.0, zo, b.maxX + 0.1, y + 1.0, zo);
    // end guardrails
    for (const x of [b.minX, b.maxX]) {
      ctx.tube(x, y + 0.55, zi, x, y + 0.55, zo);
      ctx.tube(x, y + 1.0, zi, x, y + 1.0, zo);
    }
    if (y === topY) {
      ctx.tube(b.minX - 0.1, y + 0.55, zi, b.maxX + 0.1, y + 0.55, zi);
      ctx.tube(b.minX - 0.1, y + 1.0, zi, b.maxX + 0.1, y + 1.0, zi);
    }
    // brick guards at the working lift and the top lift
    if (y === working || y === topY) {
      B.add(M.mesh, plane(w, 0.85), trs(cx, by + 0.6, zo + 0.04), col(0xb5babd));
    }
  }
  // hop-up boards inside the working lift (bricklayers stand close to the wall)
  for (let i = 0; i < xs.length - 1; i++) {
    const xm = (xs[i] + xs[i + 1]) / 2;
    for (const bz of [zi - 0.28, zi - 0.52]) ctx.board(trs(xm, working + 0.1, bz, (r() - 0.5) * 0.01));
    B.add(M.paint, box(0.05, 0.05, 0.6), trs(xs[i] + 0.1, working + 0.06, zi - 0.35), col(0x6c7074));
  }
  // ties back into the frame
  for (let i = 0; i < xs.length; i += 2) {
    for (const y of [3.6, 7.6, 11.6, 15.6]) ctx.tube(xs[i] + 0.1, y, zi + 0.05, xs[i] + 0.1, y, b.maxZ + 0.02);
  }
  // ladder bay (east end): aluminium ladders between boarded lifts
  {
    const lx0 = xs[xs.length - 2] + 0.5;
    const levels = [0, ...boarded];
    for (let k = 0; k < levels.length - 1; k++) {
      const y0 = levels[k] + (k ? 0.12 : 0), y1 = levels[k + 1] + 1.05;
      const z = k % 2 ? zi + 0.35 : zo - 0.35;
      const run = (y1 - y0) * 0.27;
      const xa = lx0 + (k % 2 ? 0 : 1.2), xb = xa + (k % 2 ? run : -run);
      ctx.ladder(xa, y0, z, xb, y1, z);
    }
    ctx.sign('tag', 0.3, 0.3, lx0 + 0.6, 1.5, zo + 0.06, 0);
  }
  // netting over the upper lifts, sheeting down the west bays
  for (let i = 2; i < xs.length - 1; i++) {
    for (let y = 8; y < topY + 1; y += 2) {
      B.add(M.net, plane(2.5, 2, 4, 4), trs((xs[i] + xs[i + 1]) / 2, y + 1, zo + 0.09));
    }
  }
  for (let i = 0; i < 2; i++) {
    for (let y = 0; y < topY + 1; y += 2) {
      B.add(M.sheet, plane(2.5, 2, 4, 4), trs((xs[i] + xs[i + 1]) / 2, y + 1, zo + 0.1));
    }
  }
  world.add(new Box(cx, topY / 2, b.maxZ + 1.0 + 0.55, w / 2 + 0.2, topY / 2, 0.7, 0, 'scaffold'));

  stairTower(ctx, deckY);
}

// Switch-back stair tower against the south face, bridged to every floor.
function stairTower(ctx, deckY) {
  const { B, M, world } = ctx;
  const x0 = 13.5, x1 = 16.5, xm = 15.0, z0 = 3.1, z1 = 5.4, zmid = (z0 + z1) / 2;
  const rise = 1.6, n = Math.round(deckY / rise);
  const top = deckY + 1.15;
  for (const x of [x0, xm, x1]) for (const z of [z0, z1]) {
    ctx.tube(x, 0.03, z, x, top, z);
    B.add(M.steel, box(0.15, 0.008, 0.15), trs(x, 0.035, z), col(0x7a7d80));
  }
  const la = 0.7; // landing depth each end
  for (let k = 0; k <= n; k++) {
    const y = k * rise;
    if (k > 0) {
      ctx.tube(x0 - 0.1, y, z0, x1 + 0.1, y, z0);
      ctx.tube(x0 - 0.1, y, z1, x1 + 0.1, y, z1);
      for (const x of [x0, x1]) ctx.tube(x, y + 0.05, z0 - 0.1, x, y + 0.05, z1 + 0.1);
      for (const x of [x0, xm, x1]) { ctx.coupler(x, y, z0); ctx.coupler(x, y, z1); }
      // landings (steel decks)
      B.add(M.paint, box(la, 0.05, z1 - z0), trs(x0 + la / 2, y + 0.08, zmid), col(0x8e9398));
      B.add(M.paint, box(la, 0.05, z1 - z0), trs(x1 - la / 2, y + 0.08, zmid), col(0x8e9398));
      // guardrails on the outside faces
      for (const g of [0.5, 1.0]) {
        ctx.tube(x0 - 0.1, y + g, z0 - 0.05, x1 + 0.1, y + g, z0 - 0.05, 0.022);
        ctx.tube(x0 - 0.05, y + g, z0, x0 - 0.05, y + g, z1, 0.022);
        ctx.tube(x1 + 0.05, y + g, z0, x1 + 0.05, y + g, z1, 0.022);
      }
    }
    if (k === n) break;
    // flight k: south half climbs east, north half climbs west
    const east = k % 2 === 0;
    const zc = east ? z0 + 0.6 : z1 - 0.6;
    const xa = east ? x0 + la : x1 - la, xb = east ? x1 - la : x0 + la;
    const ya = y + 0.1, yb = y + rise + 0.1;
    for (const dz of [-0.5, 0.5]) ctx.brace(xa, ya - 0.05, zc + dz, xb, yb - 0.05, zc + dz, 0.035, col(0x8e9398));
    const steps = 8;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      B.add(M.paint, box(0.24, 0.03, 1.0), trs(xa + (xb - xa) * t, ya + (yb - ya) * t, zc), col(0x9aa0a5));
    }
    ctx.tube(xa, ya + 0.95, zc + 0.52, xb, yb + 0.95, zc + 0.52, 0.022);
    ctx.tube(xa, ya + 0.95, zc - 0.52, xb, yb + 0.95, zc - 0.52, 0.022);
  }
  // bridges onto each slab
  for (let lvl = 1; lvl * 3.2 <= deckY + 0.01; lvl++) {
    const y = lvl * 3.2;
    const kk = Math.round(y / rise);
    const bx = kk % 2 === 0 ? x0 + la / 2 + 0.1 : x1 - la / 2 - 0.1;
    B.add(M.wood, box(0.9, 0.05, 0.75), trs(bx, y + 0.03, z1 + 0.33), BOARD);
    ctx.tube(bx - 0.45, y + 1.0, z1, bx - 0.45, y + 1.0, 6.0, 0.022);
    ctx.tube(bx + 0.45, y + 1.0, z1, bx + 0.45, y + 1.0, 6.0, 0.022);
  }
  // mesh cladding on the street-facing side
  B.add(M.mesh, plane(x1 - x0, top - 0.3), trs((x0 + x1) / 2, (top + 0.3) / 2, z0 - 0.09), col(0xa9aeb2));
  world.add(new Box((x0 + x1) / 2, top / 2, zmid, (x1 - x0) / 2 + 0.1, top / 2, (z1 - z0) / 2 + 0.1, 0, 'scaffold'));
}
