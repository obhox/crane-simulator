import * as THREE from 'three';
import { intersections } from '../layout.js';
import { cameraProbe } from './common.js';
import { Signals } from './signals.js';
import { buildFurniture } from './furniture.js';
import { buildTrees } from './trees.js';
import { buildTraffic } from './traffic.js';
import { buildPedestrians } from './pedestrians.js';
import { GlowPoints } from './lights.js';

// Street life & furniture orchestrator (see src/world/streets.js for the
// public entry point). Build order matters: furniture lays out the sidewalks
// first and publishes a plan (lamps, trees, bus stops, benches …) that trees
// and pedestrians use.
export function buildStreetLife(scene, quality = { name: 'high', city: 1 }) {
  const root = new THREE.Group();
  root.name = 'streets';
  scene.add(root);
  const probe = cameraProbe(root);
  const signals = new Signals(intersections().filter((n) => Math.abs(n.x) <= 400 && Math.abs(n.z) <= 400));
  const crossings = new Map(); // crosswalk key → pedestrians currently on it
  const plan = { signs: [], busStops: [], idle: [], cabinets: [], planters: [], lamps: [], trees: [] };

  const furniture = buildFurniture(root, quality, signals, plan);
  const trees = buildTrees(root, quality, plan);
  const vehGlow = new GlowPoints(root, 1400, { minPx: 1.8 });
  const traffic = buildTraffic(root, quality, probe, signals, crossings, vehGlow);
  const peds = buildPedestrians(root, quality, signals, crossings, plan);

  let windSet = false;
  return {
    root, signals, traffic, peds, furniture, trees, probe,
    // mobile-crane obstacle feed (spec §7.1): the host calls traffic.setObstacles / peds.setObstacles
    // every frame; this sets both. list = [{x, z, hx, hz, yaw, vx?, vz?}] (kept by reference)
    setObstacles(list) { traffic.setObstacles(list); peds.setObstacles(list); },
    // car OBBs near a point (moving + parked) for the carrier's collision test
    vehicleBoxes(qx, qz, r, out) { return traffic.vehicleBoxes(qx, qz, r, out); },
    // remove moving cars from a rectangle (mobile crane placed on the road at a job / free-play start)
    clearArea(box, pad) { return traffic.clearArea(box, pad); },
    // optional hook: streets.setWind(meanSpeed m/s, direction rad (blowing towards, xz plane))
    setWind(speed, dir) { windSet = true; trees.setWind(speed, dir); },
    update(dt, night = 0) {
      if (!windSet && typeof window !== 'undefined' && window.__sim?.wind) {
        const w = window.__sim.wind; // fall back to the sim's wind until main.js calls setWind
        trees.setWind(w.mean * (w.factor ?? 1), w.dir ?? 0.6);
      }
      signals.update(dt);
      vehGlow.begin();
      traffic.update(dt, night);
      vehGlow.end();
      vehGlow.points.visible = night > 0.05;
      peds.update(dt, probe.pos);
      trees.update(dt);
      furniture.update(dt, night);
      probe.stale = true; // record the next camera that renders
    },
  };
}
