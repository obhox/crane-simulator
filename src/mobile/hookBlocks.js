import * as THREE from 'three';
import { Kit, mCyl, mExtrude, boltGeo, WEAR_JOINT } from '../crane/kit.js';
import { createCraneMaterials } from '../crane/model.js';
import { V, WEAR_PLATE, mobileMaterials, lastMaterialSet, decal, sheaveGeo, hookGeometry, HOOK_SHANK, blockDef, remapBins } from './modelParts.js';

// Hook blocks of the AT-100 5.1 (§1.4): the 8.8 t overhaul ball and the 26 /
// 60 / 90 t sheave blocks (+ the Phase-3 100 t block).
//
//   buildMobileHookBlock(id, mats?) → THREE.Group
//     origin = hook bowl (saddle: where slings bear = hoist.hook), block top
//     (rope entry, blockTop of §3.5) at +HOOK_BLOCKS[id].height on +y.
//     Local +x = along the boom (horizontal), +z = across (parallel to the head
//     sheave axles): orient it like the placeholder / tower block — basis
//     (x = boom direction ⟂ rope, y = rope direction up, z = x × y).
//     userData: { id, height, falls, fallLocal(n) → Vector3[] (local rope entry
//     points of n falls: sheave fronts / backs, becket), def }
//   blockFallPoints(block, out) → world rope entry points (after updateMatrixWorld)
//     — pair them with parts.fallTops(block) of model.js for the falls.
//
// mats: the tower material set (ctx.craneMats); defaults to the set last used
// by buildMobileCrane (or a fresh createCraneMaterials() if none yet).

// per-block proportions [E]: hook scale s (1 = the tower's 8 t hook), sheave outer radius
const BLOCKS = {
  hb26: { s: 1.35, R: 0.24, swl: 'swl26' },
  hb60: { s: 1.7, R: 0.28, swl: 'swl60' },
  hb90: { s: 2.0, R: 0.3, swl: 'swl90' },
  hb100: { s: 2.1, R: 0.32, swl: 'swl100' },
};
const SW = 0.07, PITCH = 0.085, GROOVE = 0.022; // sheave width, pitch, groove depth

export function buildMobileHookBlock(id = 'ball', mats = null) {
  const set = mats || lastMaterialSet() || createCraneMaterials();
  const M = mobileMaterials(set);
  const atlas = M.mdecal.userData.atlas;
  const def = blockDef(id);
  const H = def.height;
  const g = new THREE.Group();
  g.name = `mobileHook:${def.id}`;
  const k = new Kit(900 + (def.sheaves || 0));
  let fallLocal;
  if (!def.sheaves) {
    // overhaul ball: hook, swivel, weight ball (hazard stripes), wedge socket
    const s = 1;
    k.add('yellowDark', hookGeometry(s), null, [0.3, 9, 0.6], false);
    k.member('galv', V(0.038, 0.19, 0), V(0.084, 0.13, 0), { k: 'box', w: 0.005, d: 0.036 }, V(0, 0, 1), 0); // latch
    k.cyl('darkSteel', 0.045, 0.05, 0, HOOK_SHANK + 0.025, 0, 'y', 6);
    k.cyl('darkSteel', 0.07, 0.1, 0, HOOK_SHANK + 0.1, 0, 'y', 16);
    const rb = 0.22, yc = H * 0.58;
    k.add('hazard', new THREE.SphereGeometry(rb, 24, 16).scale(1, 1.05, 1).translate(0, yc, 0), null, [0.5, 9, 0.6], false);
    k.cyl('darkSteel', 0.06, 0.06, 0, yc - rb * 1.05 - 0.01, 0, 'y', 16);
    k.add('darkSteel', mCyl(0.035, 0.065, H - (yc + rb * 1.05) - 0.01, 12).translate(0, (H + yc + rb * 1.05) / 2 - 0.005, 0), null, WEAR_JOINT, false);
    k.cyl('darkSteel', 0.02, 0.12, 0, H - 0.06, 0, 'z', 8); // socket pin
    fallLocal = (n) => Array.from({ length: n }, () => V(0, H, 0));
  } else {
    const b = BLOCKS[def.id] || BLOCKS.hb26;
    const { s, R } = b, m = def.sheaves;
    const packW = m * SW + (m - 1) * (PITCH - SW);
    const zc = packW / 2 + 0.02; // cheek inner face
    const t = 0.03 * s;
    const shankTop = HOOK_SHANK * s;
    const ys = H - 0.1 - R; // sheave centre height
    const yb = shankTop + 0.1 * s; // cheek bottom (above the crosshead)
    const hwt = R + 0.09, hwb = hwt * 0.72;
    // hook + latch, nut, thrust bearing, crosshead (trunnion)
    k.add('yellowDark', hookGeometry(s), null, [0.3, 9, 0.6], false);
    k.member('galv', V(0.038 * s, 0.19 * s, 0), V(0.084 * s, 0.13 * s, 0), { k: 'box', w: 0.005 * s, d: 0.036 * s }, V(0, 0, 1), 0);
    k.add('darkSteel', mCyl(0.05 * s, 0.05 * s, 0.05 * s, 6).translate(0, shankTop + 0.025 * s, 0), null, null, false);
    k.cyl('rubber', 0.07 * s, 0.03 * s, 0, shankTop + 0.06 * s, 0, 'y', 18);
    k.box('yellowDark', 2 * hwb - 0.02, 0.1 * s, 2 * zc - 0.004, 0, yb - 0.02 * s, 0, null, WEAR_PLATE);
    k.cyl('darkSteel', 0.045 * s, 2 * zc + 2 * t + 0.06, 0, yb - 0.02 * s, 0, 'z', 12);
    // cheek plates: tapered, round top over the sheave pack, hazard striped
    const sh = new THREE.Shape();
    sh.moveTo(-hwb, yb - 0.08 * s);
    sh.lineTo(hwb, yb - 0.08 * s);
    sh.lineTo(hwt, ys);
    sh.absarc(0, ys, hwt, 0, Math.PI, false);
    sh.closePath();
    for (const sd of [-1, 1]) {
      const plate = mExtrude(sh, t, { curveSegments: 12 });
      plate.translate(0, 0, sd > 0 ? zc : -zc - t);
      k.add('hazard', plate, null, [0.5, 9, 0.6], false);
      if (m >= 3) { // bolted-on weight plates on the big blocks
        const wp = mExtrude(sh, 0.03, { curveSegments: 12 });
        wp.scale(0.8, 0.8, 1).translate(0, ys * 0.2, sd > 0 ? zc + t : -zc - t - 0.03);
        k.add('yellowDark', wp, null, WEAR_PLATE, false);
      }
      decal(k, atlas, b.swl, 0.2 * s, 0.09 * s, V(0, yb + 0.12 * s, sd * (zc + t + (m >= 3 ? 0.032 : 0.002))), V(0, 0, sd));
      k.cyl('yellowDark', 0.09 * Math.min(s, 1.6), 0.03, 0, ys, sd * (zc + t + 0.015 + (m >= 3 ? 0.03 : 0)), 'z', 18, WEAR_PLATE);
    }
    // sheaves, axle, tie bolts, rope guards, becket (dead end for odd falls)
    for (let j = 0; j < m; j++) k.add('darkSteel', sheaveGeo(R, SW).translate(0, ys, (j - (m - 1) / 2) * PITCH), null, null, false);
    k.cyl('darkSteel', 0.05, 2 * zc + 2 * t + 0.09, 0, ys, 0, 'z', 12);
    for (const [x, y] of [[-hwb + 0.05, yb], [hwb - 0.05, yb], [-hwt + 0.04, ys], [hwt - 0.04, ys]]) k.cyl('darkSteel', 0.018 * s, 2 * zc + 2 * t + 0.05, x, y, 0, 'z', 8);
    for (const x of [-(R + 0.035), R + 0.035]) k.cyl('darkSteel', 0.016, 2 * zc, x, ys + R * 0.55, 0, 'z', 8);
    k.box('yellowDark', 0.06, 0.07, 0.05, 0, H - 0.045, 0, null, WEAR_PLATE);
    k.cyl('darkSteel', 0.015, 0.09, 0, H - 0.04, 0, 'z', 8);
    for (const [x, y] of [[-hwb * 0.6, yb + 0.05], [hwb * 0.6, yb + 0.05]]) {
      for (const sd of [-1, 1]) k.add('darkSteel', boltGeo(0.024, 0.018, true).rotateX(sd * Math.PI / 2).translate(x, y, sd * (zc + t + (m >= 3 ? 0.03 : 0))), null, null, false);
    }
    // n falls: pairs on the central sheaves (front +x / back −x), the rest on the becket
    const Rg = R - GROOVE;
    fallLocal = (n) => {
      const nS = Math.min(m, Math.floor(n / 2)), off = Math.floor((m - nS) / 2);
      return Array.from({ length: n }, (_, kk) => {
        if (kk >= 2 * nS) return V(0, H - 0.04, 0);
        const i = Math.floor(kk / 2) + off;
        return V(kk % 2 ? -Rg : Rg, ys + Rg * 0.2, (i - (m - 1) / 2) * PITCH);
      });
    };
  }
  remapBins(k, { galv: 'darkSteel', rubber: 'darkSteel' });
  k.build(g, M, { noShadow: ['mdecal'] });
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.userData = { id: def.id, height: H, falls: def.falls, fallLocal, def };
  return g;
}

/** world rope entry points of the block's reeved falls (userData.falls) */
export function blockFallPoints(block, out = []) {
  const loc = block.userData.fallLocal(block.userData.falls);
  for (let i = 0; i < loc.length; i++) (out[i] ||= new THREE.Vector3()).copy(loc[i]).applyMatrix4(block.matrixWorld);
  out.length = loc.length;
  return out;
}

export const MOBILE_HOOK_IDS = ['ball', 'hb26', 'hb60', 'hb90'];
