import * as THREE from 'three';
import { facadeTextures } from './textures.js';
import { rng } from '../util/math.js';
import { buildSurfaces, L as LY } from './buildings/surfaces.js';
import { createCityMaterial, STYLE } from './buildings/material.js';
import { CityGeo } from './buildings/geometry.js';
import { emitBuilding, paint } from './buildings/typologies.js';
import { planCity, planSkyline } from './buildings/planner.js';

// The surrounding city. Lots from layout.js become real urban blocks
// (planner.js), emitted as merged geometry (typologies.js) and drawn with a
// single procedural-facade material (material.js) — one draw call per block,
// each block a THREE.LOD (full detail near, no balconies/clutter/cornices far).
// Beyond the lot grid a simplified skyline runs out to ~1.6 km.
//
// buildCity(scene, density /* QUALITY.city: low 0.45 … ultra 1.25 */) → { group, setNight(n) }
export function buildCity(scene, density = 1) {
  if (typeof location !== 'undefined' && /[?&]oldcity\b/.test(location.search)) return buildLegacyCity(scene, density);
  try {
    return buildModernCity(scene, density);
  } catch (e) {
    console.error('[city] build failed, using the legacy city', e);
    const old = scene.getObjectByName('city');
    if (old) scene.remove(old);
    return buildLegacyCity(scene, density);
  }
}

function buildModernCity(scene, density) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'city';
  scene.add(group);
  const lowQ = density < 0.6;
  const surf = buildSurfaces(density >= 1.2 ? 1024 : 512);
  const mat = createCityMaterial(surf, { lowQuality: lowQ });
  const uniforms = mat.userData.uniforms;
  const clutter = Math.min(1.3, 0.35 + density * 0.7);
  const lodDist = 170 + 190 * density; // high: 360 m

  const lights = [];
  const stats = { buildings: 0, tris: 0, trisFar: 0, verts: 0 };
  for (const lot of planCity()) {
    const g = new CityGeo();
    g.ox = lot.cx; g.oz = lot.cz;
    const r = rng(lot.seed);
    for (const b of lot.buildings) emitBuilding(g, b, lot.buildings, r, clutter, lights);
    stats.buildings += lot.buildings.length;
    stats.verts += g.nv;
    const geo = g.build();
    if (!geo) continue;
    const lod = new THREE.LOD();
    lod.name = `block ${lot.key}`;
    lod.position.set(lot.cx, 0, lot.cz);
    const hi = new THREE.Mesh(geo.hi, mat);
    // Every block casts and receives: the cascaded sun shadows reach 900 m, so
    // at golden hour whole street canyons fall into shade and towers throw
    // long shadows across the roofscape — the strongest depth cue a city has.
    // Chunking per block keeps each caster's bounds tight for cascade culling.
    hi.castShadow = hi.receiveShadow = true;
    lod.addLevel(hi, 0);
    stats.tris += geo.hi.index.count / 3;
    if (geo.lo) {
      const lo = new THREE.Mesh(geo.lo, mat);
      lo.castShadow = lo.receiveShadow = true;
      lod.addLevel(lo, lodDist);
      stats.trisFar += geo.lo.index.count / 3;
    }
    lod.updateMatrix();
    lod.matrixAutoUpdate = false;
    group.add(lod);
  }

  // ---------------------------------------------------------------- skyline
  // Chunked into 12 angular sectors × 2 rings: the inner ring (< 900 m, the
  // far shadow cascade's reach) casts sun shadows on high/ultra, the outer
  // ring never does. Each chunk is one draw call, frustum-culled.
  const sky = planSkyline(Math.min(1.1, 0.55 + density * 0.45));
  const SECT = 12, RING = 900;
  const chunks = Array.from({ length: SECT * 2 }, () => new CityGeo());
  const rs = rng(4711);
  for (const blk of sky) {
    const s = Math.floor(((Math.atan2(blk.cz, blk.cx) + Math.PI) / (2 * Math.PI)) * SECT) % SECT;
    const g = chunks[s + (blk.d < RING ? 0 : SECT)];
    for (const k of blk.blocks) skylineBox(g, k, rs, lights, blk.d);
  }
  stats.trisSkyline = 0;
  chunks.forEach((g, i) => {
    const geo = g.build();
    if (!geo) return;
    const m = new THREE.Mesh(geo.hi, mat);
    m.name = `skyline ${i}`;
    m.matrixAutoUpdate = false;
    m.castShadow = i < SECT && density >= 0.9;
    m.receiveShadow = i < SECT;
    stats.trisSkyline += geo.hi.index.count / 3;
    group.add(m);
  });

  // ---------------------------------------------------------------- aircraft warning lights
  // Low-intensity steady red (ICAO type B) on every building > 45 m; the
  // tallest roofs also carry medium-intensity flashing reds.
  const lampGeo = new THREE.SphereGeometry(0.45, 6, 4);
  const steadyMat = new THREE.MeshBasicMaterial({ color: 0x000000, fog: true });
  const flashMat = new THREE.MeshBasicMaterial({ color: 0x000000, fog: true });
  const steady = lights.filter((p) => p[1] < 100), flash = lights.filter((p) => p[1] >= 100);
  const mk = (list, m) => {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(lampGeo, m, list.length);
    const M = new THREE.Matrix4();
    list.forEach((p, i) => { M.makeTranslation(p[0], p[1], p[2]); im.setMatrixAt(i, M); });
    im.computeBoundingSphere();
    im.frustumCulled = false;
    group.add(im);
    return im;
  };
  mk(steady, steadyMat);
  mk(flash, flashMat);
  const redSteady = new THREE.Color(1, 0.05, 0.02);

  stats.ms = Math.round(performance.now() - t0);
  group.userData.stats = stats;
  console.info('[city]', stats);

  return {
    group,
    setNight(n) {
      uniforms.uNight.value = n;
      // warning lights are always on, but only read against a dark sky
      const vis = 0.6 + n * 14;
      steadyMat.color.copy(redSteady).multiplyScalar(vis);
      const t = performance.now() / 1000;
      const on = (t % 1.5) < 0.35; // 40 flashes / minute
      flashMat.color.copy(redSteady).multiplyScalar(on ? vis * 1.6 : 0.05);
    },
  };
}

// Simplified skyline building. Towers step back in 1-3 tiers and end in a
// louvred plant floor, a plant enclosure or a mast; about 40 % of the low
// perimeter-block boxes get a tiled gable roof so the roofscape does not turn
// all-flat at the edge of the detailed city.
const SKY_COLORS = [[0.9, 0.86, 0.76], [0.78, 0.78, 0.76], [0.85, 0.72, 0.58], [0.65, 0.66, 0.68], [0.92, 0.92, 0.9], [0.72, 0.64, 0.56]];
const SKY_TILES = [[0.62, 0.27, 0.16], [0.55, 0.22, 0.13], [0.3, 0.3, 0.32], [0.45, 0.24, 0.18], [0.24, 0.24, 0.26]];
const CANYON = 3 << 8; // street facades: reflect the street wall opposite (material.js cityCanyon)
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

function ring(g, x0, z0, x1, z1, y0, y1, p) {
  g.wall(x0, z1, x1, z1, y0, y1, p);
  g.wall(x1, z1, x1, z0, y0, y1, p);
  g.wall(x1, z0, x0, z0, y0, y1, p);
  g.wall(x0, z0, x0, z1, y0, y1, p);
}
const roofAt = (g, x0, z0, x1, z1, y, p) => g.quad(V3(x0, y, z1), V3(x1, y, z1), V3(x1, y, z0), V3(x0, y, z0), p);

function skylineBox(g, k, r, lights, d) {
  const seed = Math.floor(r() * 250);
  const H = (k.base ?? 0) + k.h;
  const y0 = k.type === 'tower' && k.base ? k.base : 0;
  const { x0, z0, x1, z1 } = k;
  const roof = paint({ layer: r() < 0.5 ? LY.membrane : LY.gravel, seed, color: [0.6, 0.6, 0.6] });
  const plant = paint({ layer: LY.panel, seed, color: [0.6, 0.6, 0.62] });
  if (k.type === 'tower') {
    const resi = r() < 0.35;
    const p = resi
      ? paint({ layer: r() < 0.5 ? LY.plaster : LY.concrete, style: STYLE.PUNCHED, seed, pack: 1, color: SKY_COLORS[Math.floor(r() * SKY_COLORS.length)], grid: [3.1, 3.0, 4.5, H], win: [2.0, 2.3, 0.1], gw: 4 | CANYON })
      : paint({ layer: LY.panel, style: STYLE.CURTAIN, seed, pack: 5 + 8 * (1 + Math.floor(r() * 3)), color: [0.2, 0.22, 0.25], grid: [3.9, 1.5, 6, H - 4], win: [1.5, 2.8, 0.1], gw: 2 | (8 << 4) | CANYON });
    const nT = k.h > 70 && r() < 0.6 ? (r() < 0.5 ? 2 : 3) : 1;
    let a0 = x0, b0 = z0, a1 = x1, b1 = z1, yb = y0;
    for (let t = 0; t < nT; t++) {
      let last = t === nT - 1, ix = 0, iz = 0;
      if (!last) {
        // a tier too slim to step back again becomes the top one — it must
        // still reach H, or the crown/mast would float above a short shaft
        ix = Math.min(2 + r() * 3, (a1 - a0 - 14) / 2); iz = Math.min(2 + r() * 3, (b1 - b0 - 14) / 2);
        if (ix < 1 || iz < 1) last = true;
      }
      const yt = last ? H : yb + (H - yb) * (0.5 + r() * 0.2);
      ring(g, a0, b0, a1, b1, yb, yt + 0.8, p);
      roofAt(g, a0, b0, a1, b1, yt, roof);
      if (last) break;
      a0 += ix; a1 -= ix; b0 += iz; b1 -= iz; yb = yt;
    }
    const cr = r();
    const top = H + 0.8;
    if (cr < 0.45 && !resi) {
      // louvred plant floor, slightly inset
      const lp = paint({ layer: LY.panel, style: STYLE.LOUVRE, seed, color: [0.5, 0.51, 0.53] });
      g.box(a0 + 1.2, H, b0 + 1.2, a1 - 1.2, H + 4 + r() * 3, b1 - 1.2, lp, roof, 'nestwt');
    } else if (cr < 0.8) {
      const w = Math.min(a1 - a0 - 4, 6 + r() * 8), dd = Math.min(b1 - b0 - 4, 5 + r() * 6);
      const bx = a0 + 2 + r() * (a1 - a0 - w - 4), bz = b0 + 2 + r() * (b1 - b0 - dd - 4);
      g.box(bx, H, bz, bx + w, H + 3 + r() * 2, bz + dd, plant, plant, 'nestwt');
    } else {
      const mx = (a0 + a1) / 2, mz = (b0 + b1) / 2, mh = 12 + r() * 16;
      const st = paint({ layer: LY.zinc, seed, color: [0.7, 0.7, 0.7] });
      g.box(mx - 0.4, H, mz - 0.4, mx + 0.4, H + mh, mz + 0.4, st, st, 'nestw');
      lights.push([mx, H + mh + 0.3, mz]);
    }
    if (H > 45) for (const [x, z] of [[a0, b0], [a1, b1], [a0, b1], [a1, b0]]) lights.push([x, top + 0.2, z]);
    return;
  }
  let p;
  if (k.type === 'podium') {
    p = paint({ layer: LY.stone, style: STYLE.RIBBON, seed, pack: 5 + 8, color: [0.75, 0.73, 0.68], grid: [4.2, 1.5, 5, H], win: [1.5, 2.0, 0.9], gw: 1 | (8 << 4) | CANYON });
  } else {
    const brick = r() < 0.3;
    p = paint({
      layer: brick ? LY.brick : LY.plaster, style: STYLE.PUNCHED, seed, pack: Math.floor(r() * 3),
      color: brick ? [0.9, 0.85, 0.8] : SKY_COLORS[Math.floor(r() * SKY_COLORS.length)],
      grid: [3.2, 3.2, 4.2, H], win: [1.4, 1.7, 0.85], gw: 4 | CANYON,
    });
  }
  const w = x1 - x0, dz = z1 - z0;
  if (k.type === 'block' && H < 30 && r() < 0.4) {
    // gable roof, ridge along the longer side (the street frontage)
    ring(g, x0, z0, x1, z1, 0, H, p);
    const tile = paint({ layer: LY.rooftile, seed, color: SKY_TILES[Math.floor(r() * SKY_TILES.length)] });
    const gable = paint({ layer: p.layer, seed, color: p.color });
    const tp = Math.tan(THREE.MathUtils.degToRad(33 + r() * 12));
    if (w >= dz) {
      const zm = (z0 + z1) / 2, ry = H + (dz / 2) * tp;
      g.quad(V3(x0, H, z1), V3(x1, H, z1), V3(x1, ry, zm), V3(x0, ry, zm), tile);
      g.quad(V3(x1, H, z0), V3(x0, H, z0), V3(x0, ry, zm), V3(x1, ry, zm), tile);
      g.triangle(V3(x1, H, z1), V3(x1, H, z0), V3(x1, ry, zm), gable);
      g.triangle(V3(x0, H, z0), V3(x0, H, z1), V3(x0, ry, zm), gable);
    } else {
      const xm = (x0 + x1) / 2, ry = H + (w / 2) * tp;
      g.quad(V3(x1, H, z1), V3(x1, H, z0), V3(xm, ry, z0), V3(xm, ry, z1), tile);
      g.quad(V3(x0, H, z0), V3(x0, H, z1), V3(xm, ry, z1), V3(xm, ry, z0), tile);
      g.triangle(V3(x0, H, z1), V3(x1, H, z1), V3(xm, ry, z1), gable);
      g.triangle(V3(x1, H, z0), V3(x0, H, z0), V3(xm, ry, z0), gable);
    }
    return;
  }
  const top = H + 0.8;
  ring(g, x0, z0, x1, z1, 0, top, p);
  roofAt(g, x0, z0, x1, z1, H, roof);
  if (d < 1100 && w > 10 && dz > 8) {
    const bw = 3 + r() * 5, bd = 3 + r() * 4;
    const bx = x0 + 2 + r() * (w - bw - 4), bz = z0 + 2 + r() * (dz - bd - 4);
    g.box(bx, H, bz, bx + bw, H + 2 + r() * 2, bz + bd, plant, plant, 'nestwt');
  }
  if (H > 45) for (const [x, z] of [[x0, z0], [x1, z1], [x0, z1], [x1, z0]]) lights.push([x, top + 0.2, z]);
}

// ------------------------------------------------------------------ legacy
// Original box city (kept as a safety fallback; ?oldcity forces it).
function buildLegacyCity(scene, density = 1) {
  const group = new THREE.Group();
  group.name = 'city';
  scene.add(group);
  const r = rng(77);
  const VARIANTS = 6;
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x5d5f62, roughness: 0.9 });
  const facadeMats = [];
  for (let v = 0; v < VARIANTS; v++) {
    const t = facadeTextures(v);
    facadeMats.push(new THREE.MeshStandardMaterial({
      map: t.map, emissiveMap: t.emissive, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.55, metalness: 0.15,
    }));
  }
  const placements = Array.from({ length: VARIANTS }, () => []);
  const block = 46;
  for (let bx = -14; bx <= 14; bx++) {
    for (let bz = -14; bz <= 14; bz++) {
      const x0 = bx * block, z0 = bz * block;
      const dist = Math.hypot(x0, z0);
      if (Math.abs(x0) < 120 && z0 > -95 && z0 < 120) continue;
      if (z0 > -95 && z0 < -40) continue;
      if (r() > density * (dist < 300 ? 0.95 : 0.7)) continue;
      const n = 1 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const w = 12 + r() * 16, d = 12 + r() * 16;
        const tall = dist < 260 ? 1 : 1.6;
        const h = (9 + r() * r() * 55) * tall * (dist > 500 ? 1.4 : 1);
        const x = x0 + (r() - 0.5) * (block - w - 4);
        const z = z0 + (r() - 0.5) * (block - d - 4);
        placements[Math.floor(r() * VARIANTS)].push({ x, z, w, d, h, rot: r() < 0.5 ? 0 : Math.PI / 2 });
      }
    }
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  placements.forEach((list, v) => {
    const classes = [[], [], []];
    list.forEach((p) => classes[p.h < 20 ? 0 : p.h < 45 ? 1 : 2].push(p));
    classes.forEach((cls, ci) => {
      if (!cls.length) return;
      const refH = [15, 32, 70][ci];
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const uv = geo.attributes.uv;
      for (let f = 0; f < 6; f++) {
        for (let k = 0; k < 4; k++) {
          const i = f * 4 + k;
          if (f === 2 || f === 3) uv.setXY(i, 0.02, 0.98);
          else uv.setXY(i, uv.getX(i) * 1.8, uv.getY(i) * (refH / 12));
        }
      }
      const mats = [facadeMats[v], facadeMats[v], roofMat, roofMat, facadeMats[v], facadeMats[v]];
      const im = new THREE.InstancedMesh(geo, mats, cls.length);
      cls.forEach((p, i) => {
        q.setFromAxisAngle(up, p.rot);
        m.compose(new THREE.Vector3(p.x, p.h / 2, p.z), q, new THREE.Vector3(p.w, p.h, p.d));
        im.setMatrixAt(i, m);
      });
      im.castShadow = false;
      im.receiveShadow = false;
      im.computeBoundingSphere();
      group.add(im);
    });
  });
  return {
    group,
    setNight(n) {
      for (const mat of facadeMats) mat.emissiveIntensity = n * 1.6;
    },
  };
}
