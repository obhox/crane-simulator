import * as THREE from 'three';
import { Box } from '../../physics/collide.js';
import { box, cyl, trs, col, solid } from './kit.js';
import { makeCanvas, canvasTexture } from '../textures.js';

// Mobile LED lighting towers (trailer + generator canopy, outriggers,
// 8.5 m telescopic mast, four heads). All stand beyond the 60 m jib radius
// or against the hoarding, so they are never in a load path. At night the
// heads glow, a light pool is painted on the ground (additive decal, all
// presets) and, on medium+, two of them carry a real SpotLight.

const BODY = col(0xe2b400), DARK = col(0x2d3135);

export const TOWERS = [
  { x: -42.2, z: -53.4, aim: [-24, -36], spot: false },
  { x: 62.0, z: -44.0, aim: [26, -14], spot: false },
  { x: 61.0, z: 38.0, aim: [30, 16], spot: true },
  { x: -57.0, z: 43.0, aim: [-26, 8], spot: true },
];

export function buildLights(ctx) {
  const { B, M, world, q, root } = ctx;
  const spots = [];
  const pools = [];
  const poolMat = new THREE.MeshBasicMaterial({
    map: poolTexture(), color: 0xfff2dc, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  poolMat.name = 'lightPool';
  for (const t of TOWERS) {
    const dx = t.aim[0] - t.x, dz = t.aim[1] - t.z;
    const yaw = Math.atan2(-dz, dx);
    const H = 8.6;
    B.within(trs(t.x, 0, t.z, yaw + Math.PI), () => {
      // trailer: canopy genset body, axle + wheels, drawbar, outriggers
      B.add(M.paintVeh, box(2.2, 1.15, 1.2), trs(0, 1.05, 0), BODY);
      B.add(M.paint, box(2.3, 0.12, 1.3), trs(0, 0.42, 0), DARK);
      for (let i = 0; i < 6; i++) B.add(M.paint, box(0.02, 0.5, 0.6), trs(-0.6 + i * 0.08, 1.05, 0.61), DARK);
      for (const s of [-1, 1]) {
        const w = cyl(0.3, 0.3, 0.2, 14);
        w.rotateX(Math.PI / 2);
        B.add(M.rubber, w, trs(-0.2, 0.3, s * 0.78), col(0x1a1a1a));
        B.add(M.paint, box(1.4, 0.06, 0.06), trs(0, 0.35, s * 0.95, s * 0.9), DARK);
        B.add(M.paint, box(0.06, 0.4, 0.06), trs(s * 0.55, 0.2, s * 1.55), DARK);
        B.add(M.paint, box(0.25, 0.03, 0.25), trs(s * 0.55, 0.015, s * 1.55), DARK);
      }
      B.add(M.paint, box(1.2, 0.08, 0.08), trs(1.7, 0.45, 0), DARK);
      B.add(M.rubber, cyl(0.08, 0.08, 0.08, 10).rotateX(Math.PI / 2), trs(2.2, 0.1, 0), col(0x1a1a1a));
      // telescopic mast
      const secs = [[1.6, 4.3, 0.085], [4.2, 6.6, 0.065], [6.5, H, 0.05]];
      for (const [a, b, r] of secs) B.add(M.galv, cyl(r, r, b - a, 10), trs(-0.6, (a + b) / 2, 0), col(0xcfd2d4));
      // lamp bar + four heads facing -x (the aim side after the yaw + PI)
      B.add(M.paint, box(0.1, 0.1, 1.9), trs(-0.6, H, 0), DARK);
      for (const s of [-0.7, -0.24, 0.24, 0.7]) {
        B.within(trs(-0.75, H + 0.05, s, 0, 0, 0.45), () => {
          B.add(M.paint, box(0.14, 0.34, 0.42), trs(0, 0, 0), DARK);
          B.add(M.lamp, box(0.02, 0.28, 0.36), trs(-0.075, 0, 0));
        });
      }
    });
    solid(world, t.x, t.z, yaw, 0, 1.0, 0, 1.3, 1.0, 1.0, 'light');
    const mx = t.x + Math.cos(yaw) * 0.6, mz = t.z - Math.sin(yaw) * 0.6;
    world.add(new Box(mx, H / 2, mz, 0.15, H / 2, 0.15, 0, 'light'));

    // light pool decal (ellipse stretched along the aim)
    const d = Math.hypot(dx, dz);
    const pg = new THREE.PlaneGeometry(1, 1);
    pg.rotateX(-Math.PI / 2);
    const pool = new THREE.Mesh(pg, poolMat);
    pool.position.set(t.x + dx * 0.55, 0.06, t.z + dz * 0.55);
    pool.rotation.y = yaw;
    pool.scale.set(d * 1.25, 1, d * 0.8);
    pool.renderOrder = 3;
    root.add(pool);
    pools.push(pool);

    if (t.spot && q.name !== 'low') {
      const sp = new THREE.SpotLight(0xfff4e5, 0, 0, 0.62, 0.55, 2);
      sp.position.set(mx, H + 0.05, mz);
      sp.target.position.set(t.aim[0], 0, t.aim[1]);
      sp.castShadow = false;
      root.add(sp, sp.target);
      spots.push(sp);
    }
  }
  return { spots, poolMat };
}

function poolTexture() {
  const S = 128;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,0.55)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.32)');
  gr.addColorStop(0.7, 'rgba(255,255,255,0.1)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
