import * as THREE from 'three';
import { QUALITY } from '../config.js';
import { rng } from '../util/math.js';
import { MeshBatch, InstBatch, trs, seg, box, lathe, col, colored } from './site/kit.js';
import { siteMaterials } from './site/materials.js';
import { signAtlas, signGeo } from './site/signs.js';
import { buildFrame } from './site/frame.js';
import { buildDeck } from './site/deck.js';
import { buildScaffold } from './site/scaffold.js';
import { buildPerimeter } from './site/perimeter.js';
import { buildYard } from './site/yard.js';
import { buildVehicles } from './site/vehicles.js';
import { buildLights } from './site/lights.js';
import { buildWorkers, updateWorkers, makeWorker as makeFigure } from './site/workers.js';

// The construction site: a mid-rise concrete frame under construction with
// everything a real site around it has — see src/world/site/*.js. Static
// geometry is merged per material (one draw call per finish) and repeated
// parts are instanced, so the whole site is ~60 draw calls.
//
// buildSite(scene, world, quality?) → { root, workers, truckDrum, deckY,
//   stubs, formLine, colX, colZ }   (gameplay contract — unchanged)
// updateSite(site, dt, night)

export function makeWorker(vestColor) {
  return makeFigure(vestColor);
}

function resolveQuality(q) {
  if (q && typeof q === 'object' && q.name) return q;
  if (typeof q === 'string' && QUALITY[q]) return QUALITY[q];
  try {
    const s = JSON.parse(localStorage.getItem('tcsim.settings') || '{}');
    if (QUALITY[s.quality]) return QUALITY[s.quality];
  } catch { /* no storage */ }
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  return coarse ? QUALITY.low : QUALITY.high;
}

const WHITE = new THREE.Color(1, 1, 1);

export function buildSite(scene, world, quality) {
  const q = resolveQuality(quality);
  const root = new THREE.Group();
  root.name = 'site';
  scene.add(root);
  const r = rng(2024);
  const M = siteMaterials(q);
  const B = new MeshBatch();
  const atlas = signAtlas();

  // instanced part batches (unit geometry scaled per instance)
  const tubes = new InstBatch(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true), M.galvTube, { name: 'tubes' });
  const braces = new InstBatch(colored(new THREE.CylinderGeometry(1, 1, 1, 6, 1, false)), M.paint, { name: 'braces' });
  const bars = new InstBatch(new THREE.CylinderGeometry(1, 1, 1, 5, 1, true), M.rebar, { name: 'rebar' });
  const caps = new InstBatch(colored(lathe([[0.012, 0], [0.02, 0.0], [0.02, 0.025], [0.045, 0.03], [0.045, 0.045], [0.02, 0.06], [0.0, 0.062]], 8), col(0xff7a00)), M.plastic, { name: 'caps' });
  const couplers = new InstBatch(box(0.075, 0.08, 0.09), M.galv, { name: 'couplers' });
  const boards = new InstBatch(colored(box(2.62, 0.038, 0.225)), M.wood, { name: 'boards' });
  const place = (m) => (B.base ? m.premultiply(B.base) : m);

  const ctx = {
    root, world, q, r, M, B,
    tube(ax, ay, az, bx, by, bz, rad = 0.024) { tubes.add(place(seg(ax, ay, az, bx, by, bz, rad))); },
    brace(ax, ay, az, bx, by, bz, rad = 0.03, color = WHITE) { braces.add(place(seg(ax, ay, az, bx, by, bz, rad)), color); },
    bar(ax, ay, az, bx, by, bz, rad = 0.0125) { bars.add(place(seg(ax, ay, az, bx, by, bz, rad))); },
    cap(x, y, z) { caps.add(place(trs(x, y - 0.01, z, r() * 6))); },
    coupler(x, y, z) { couplers.add(place(trs(x, y, z, (r() - 0.5) * 0.4))); },
    // weathered scaffold boards: every board a slightly different grey-brown
    board(m) { const k = 0.78 + r() * 0.4; boards.add(place(m), new THREE.Color(0.25 * k, 0.22 * k, 0.18 * k)); },
    ladder(ax, ay, az, bx, by, bz) {
      const d = new THREE.Vector3(bx - ax, by - ay, bz - az);
      const len = d.length();
      const side = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(0.21);
      for (const s of [-1, 1]) ctx.brace(ax + side.x * s, ay, az + side.z * s, bx + side.x * s, by, bz + side.z * s, 0.022, col(0xc4c8cc));
      for (let t = 0.25; t < len - 0.1; t += 0.3) {
        const f = t / len, px = ax + d.x * f, py = ay + d.y * f, pz = az + d.z * f;
        ctx.brace(px - side.x, py, pz - side.z, px + side.x, py, pz + side.z, 0.014, col(0xc4c8cc));
      }
    },
    // sign from the atlas on a thin backing plate, facing `yaw` (+z at 0)
    sign(key, w, h, x, y, z, yaw) {
      B.add(atlas.mat, signGeo(key, w, h), trs(x, y, z, yaw));
      B.add(M.paint, box(w + 0.04, h + 0.04, 0.012), trs(x - Math.sin(yaw) * 0.008, y, z - Math.cos(yaw) * 0.008, yaw), col(0x9a9ea2));
    },
  };

  const F = buildFrame(ctx);
  buildDeck(ctx, F);
  buildScaffold(ctx, F);
  buildPerimeter(ctx);
  buildYard(ctx);
  const { truckDrum } = buildVehicles(ctx);
  const lights = buildLights(ctx);
  const crew = buildWorkers(ctx);

  B.build(root);
  for (const b of [tubes, braces, bars, caps, couplers, boards]) b.build(root);

  const site = {
    root,
    workers: crew.crew.map((w) => w.o),
    truckDrum,
    deckY: F.deckY,
    stubs: F.stubs.map((x) => new THREE.Vector3(x, F.deckY + 3.2, F.stubZ)),
    formLine: F.formLine,
    colX: F.colX,
    colZ: F.colZ,
    _fx: { M, crew, lights, night: -1 },
  };
  site.update = (dt, night) => updateSite(site, dt, night); // for tooling / QA captures
  return site;
}

export function updateSite(site, dt, night) {
  site.truckDrum.rotation.x += dt * 0.9;
  const fx = site._fx;
  if (!fx) return;
  updateWorkers(fx.crew, dt, night);
  if (fx.M.windU) for (const u of fx.M.windU) u.uTime.value += dt;
  if (Math.abs(night - fx.night) > 0.005) {
    fx.night = night;
    const on = THREE.MathUtils.smoothstep(night, 0.25, 0.6);
    fx.M.lamp.emissiveIntensity = on * 9;
    fx.M.cabinGlass.emissiveIntensity = on * 1.6;
    // festoon lamps strung under every soffit: warm glow inside the frame
    fx.M.interiorU.uIFest.value = on * 0.22;
    // the crane's own jib floods already wash the yard at night; the towers
    // only add local pools so the ground is not blown out at night exposure
    fx.lights.poolMat.opacity = on * 0.4;
    for (const s of fx.lights.spots) s.intensity = on * 15000;
  }
}
