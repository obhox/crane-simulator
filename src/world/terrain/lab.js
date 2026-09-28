import * as THREE from 'three';
import { SITE, QUALITY } from '../../config.js';
import { loadAssets } from '../assets.js';
import { Environment } from '../environment.js';
import { buildTerrain } from '../terrain.js';
import { createRenderPipeline } from '../postfx.js';

// Dev-only harness for the terrain (src/world/terrain/lab.html). Renders the
// ground with the real environment + post pipeline, but without the rest of
// the game, so it keeps working while other modules are mid-edit.
//   ?full=1      also build site, city, streets and the crane (each optional)
//   ?q=high      quality preset
// window.lab = { view(pos, target, fov), hour(h), stats(), scene, renderer, terrain, env }

const params = new URLSearchParams(location.search);
const Q = QUALITY[params.get('q') || 'high'] || QUALITY.high;
const info = document.getElementById('info');

const renderer = new THREE.WebGLRenderer({ antialias: Q.antialias, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

await loadAssets((f, l) => { info.textContent = `loading ${l || ''} ${Math.round(f * 100)}%`; }, { renderer, quality: Q.name });

const scene = new THREE.Scene();
const env = new Environment(renderer, scene);
env.setShadowMapSize(Q.shadowMap);
const terrain = buildTerrain(scene, SITE, Q);
const extras = {};
if (params.get('full')) {
  const tryBuild = async (name, fn) => {
    try { extras[name] = await fn(); } catch (e) { console.warn('[lab] ' + name + ' failed', e); }
  };
  const { ColliderWorld } = await import('../../physics/collide.js');
  const world = new ColliderWorld();
  await tryBuild('site', async () => (await import('../site.js')).buildSite(scene, world, Q));
  await tryBuild('city', async () => (await import('../city.js')).buildCity(scene, Q.city));
  await tryBuild('streets', async () => (await import('../streets.js')).buildStreets(scene, Q));
  await tryBuild('crane', async () => { const p = (await import('../../crane/model.js')).buildCrane(); scene.add(p.root); return p; });
}
const pipeline = createRenderPipeline(renderer, scene);
pipeline.setQuality(Q);

const cam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 9000);
cam.position.set(-6, 46, -6);
cam.lookAt(-25, 0, -35);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  pipeline.setSize(innerWidth, innerHeight);
  cam.aspect = innerWidth / innerHeight;
  cam.updateProjectionMatrix();
});

let time = 0, last = performance.now(), frames = 0, fps = 0, fpsT = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  time += dt;
  env.update(dt, time);
  terrain.update(dt, env);
  extras.streets?.update?.(dt, env.nightFactor);
  if (Q.post) pipeline.render(cam); else renderer.render(scene, cam);
  frames++; fpsT += dt;
  if (fpsT > 1) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  requestAnimationFrame(frame);
}
// survive the dev server's full reloads (other modules being edited): the
// last view / hour are restored from sessionStorage
const saved = (() => { try { return JSON.parse(sessionStorage.getItem('lab.state') || '{}'); } catch { return {}; } })();
const save = (k, v) => { saved[k] = v; try { sessionStorage.setItem('lab.state', JSON.stringify(saved)); } catch { /* ignore */ } };
env.setTime(saved.hour ?? Number(params.get('hour') || 13));
if (saved.view) { cam.fov = saved.view[2]; cam.updateProjectionMatrix(); cam.position.set(...saved.view[0]); cam.lookAt(...saved.view[1]); }
requestAnimationFrame(frame);
info.textContent = '';

window.lab = {
  scene, renderer, terrain, env, pipeline, cam, extras, THREE,
  view(pos, target, fov = 60) {
    save('view', [pos, target, fov]);
    cam.fov = fov;
    cam.updateProjectionMatrix();
    cam.position.set(...pos);
    cam.lookAt(...target);
  },
  hour(h) { save('hour', h); env.setTime(h); },
  stats() {
    const i = renderer.info.render;
    return { fps: Math.round(fps), calls: i.calls, triangles: i.triangles, programs: renderer.info.programs?.length };
  },
};
