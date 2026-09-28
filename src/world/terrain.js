import * as THREE from 'three';
import { QUALITY } from '../config.js';
import { ROAD } from './layout.js';
import { textureSet, tileSize, pbrMaterial, MANIFEST } from './assets.js';
import { groundMaterial, albedoTint } from './terrain/glsl.js';
import { buildSiteGround } from './terrain/siteGround.js';
import { gridSpec, buildRoadGeometry, buildBlockGeometry, buildKerbGeometry, buildFarGeometry, TOP, KERB_R } from './terrain/grid.js';
import { gridGlsl, ROAD_SURFACE, BLOCK_SURFACE, FAR_SURFACE } from './terrain/streetShaders.js';

// Ground surfaces: construction-site ground, roads/sidewalks and the wider
// city ground. CONTRACT: the walkable/landing surface inside the site fence
// must stay at y = 0 (physics ground plane). Outside the site the terrain
// carries kerbs, sidewalks, lots etc. and stays within ±0.3 m of 0:
//   carriageways (all layout.js roads, incl. SITE.road)  y = 0
//   sidewalks AND lots (whole block between kerbs)       y = ROAD.curbHeight (0.15)
//   site interior (fence rectangle) + gate crossover     y = 0
//   far field beyond the detailed grid                   y = -0.02
//
// Draw calls: site ground, carriageways, blocks, kerbs, far field = 5.
//
// buildTerrain(scene, site, quality?) → {
//   update(dt, env)        per-frame (puddle ripples, sun direction for far-field shadows, night lamps)
//   setQuality(q)          switch shader cost for a QUALITY preset (object or name)
//   heightAt(x, z)         ground surface height (0 / 0.15) — for props placed on the ground
//   meshes                 { site, roads, blocks, kerbs, far }
// }

function guessQuality() {
  try {
    const s = JSON.parse(localStorage.getItem('tcsim.settings') || '{}');
    if (s.quality && QUALITY[s.quality]) return QUALITY[s.quality];
  } catch { /* ignore */ }
  return matchMedia('(pointer: coarse)').matches ? QUALITY.low : QUALITY.high;
}

const tint = (name, target, hue) => albedoTint(MANIFEST.textures[name], target, hue);
const tex = (name, key) => textureSet(name)?.[key] || null;

export function buildTerrain(scene, site, quality) {
  const Q = typeof quality === 'string' ? QUALITY[quality] : quality || guessQuality();
  const low = Q?.name === 'low';
  const defines = low ? { TERRAIN_LOW: '' } : {};
  const group = new THREE.Group();
  group.name = 'terrain';
  scene.add(group);

  // ------------------------------------------------------------ site ground
  const siteG = buildSiteGround(group, site, Q);

  // ------------------------------------------------------------ street grid
  const spec = gridSpec(site);
  const grid = gridGlsl(spec.xs.length, spec.zs.length);
  const gridUniforms = {
    uXs: { value: spec.xs },
    uZs: { value: spec.zs },
    uD: { value: new THREE.Vector4(spec.D.minX, spec.D.minZ, spec.D.maxX, spec.D.maxZ) },
    uRoad: { value: new THREE.Vector4(spec.hw, spec.SW, KERB_R, ROAD.laneWidth) },
    uNight: { value: 0 },
  };
  const sb = spec.blocks.find((b) => b.site);

  const roadMat = groundMaterial({
    name: 'road_surface', defines, surface: grid + ROAD_SURFACE,
    uniforms: {
      ...gridUniforms,
      tAsphC: { value: tex('asphalt', 'map') }, tAsphN: { value: tex('asphalt', 'normalMap') },
      tWornC: { value: tex('asphalt_worn', 'map') }, tWornN: { value: tex('asphalt_worn', 'normalMap') },
      tConcC: { value: tex('concrete_slab', 'map') }, tDirtC: { value: tex('dirt', 'map') },
      uTilesR: { value: new THREE.Vector4(tileSize('asphalt'), tileSize('asphalt_worn'), tileSize('concrete_slab'), tileSize('dirt')) },
      uAsphTint: { value: tint('asphalt', 0.125, [1, 1, 1.03]) },
      uWornTint: { value: tint('asphalt_worn', 0.14, [1, 1, 1.02]) },
      uConcTint: { value: tint('concrete_slab', 0.27, [1, 0.99, 0.95]) },
      uDirtTint: { value: tint('dirt', 0.1) },
      uGate: { value: new THREE.Vector4(spec.gate.minX, sb ? sb.minZ : -61, spec.gate.maxX, site.fence.minZ) },
      uWet: { value: 0.1 },
    },
  });
  const blockMat = groundMaterial({
    name: 'block_surface', defines, surface: grid + BLOCK_SURFACE,
    uniforms: {
      ...gridUniforms,
      tPaveC: { value: tex('sidewalk_pavers', 'map') }, tPaveN: { value: tex('sidewalk_pavers', 'normalMap') },
      tGrassC: { value: tex('grass', 'map') }, tGrassN: { value: tex('grass', 'normalMap') },
      tStoneC: { value: tex('tiles_or_stone', 'map') }, tStoneN: { value: tex('tiles_or_stone', 'normalMap') },
      tAsphC: { value: tex('asphalt', 'map') }, tAsphN: { value: tex('asphalt', 'normalMap') },
      tConcC: { value: tex('concrete_slab', 'map') },
      uTilesB: { value: new THREE.Vector4(tileSize('sidewalk_pavers'), tileSize('grass'), tileSize('tiles_or_stone'), tileSize('asphalt')) },
      uTileConc: { value: tileSize('concrete_slab') },
      uPaveTint: { value: tint('sidewalk_pavers', 0.24, [0.95, 0.97, 1.0]) },
      uGrassTint: { value: tint('grass', 0.1, [0.72, 1.0, 0.7]) },
      uStoneTint: { value: tint('tiles_or_stone', 0.22) },
      uAsphTint: { value: tint('asphalt', 0.1) },
      uConcTint: { value: tint('concrete_slab', 0.32, [1, 0.99, 0.96]) },
      uSiteCell: { value: new THREE.Vector2(sb ? spec.BX[sb.i].v : -1e5, sb ? spec.BZ[sb.j].v : -1e5) },
    },
  });
  const farMat = groundMaterial({
    name: 'far_ground', defines, surface: grid + FAR_SURFACE,
    uniforms: {
      ...gridUniforms,
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
      uLampCol: { value: new THREE.Color(1.0, 0.62, 0.3) },
    },
  });
  // shared uniform objects so one write updates every material
  for (const m of [roadMat, blockMat, farMat]) Object.assign(m.userData.uniforms, gridUniforms);

  const add = (geo, mat, name) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    group.add(m);
    return m;
  };
  const roads = add(buildRoadGeometry(spec), roadMat, 'roads');
  const { geometry: blockGeo, outlines } = buildBlockGeometry(spec);
  const blocks = add(blockGeo, blockMat, 'blocks');
  const kerbMat = kerbMaterial();
  const kerbs = add(buildKerbGeometry(outlines), kerbMat, 'kerbs');
  const far = add(buildFarGeometry(spec), farMat, 'far_ground');
  far.receiveShadow = false;

  const mats = [siteG.material, roadMat, blockMat, farMat];
  const sunTmp = new THREE.Vector3();
  let t = 0;

  function heightAt(x, z) {
    const fe = site.fence;
    if (x > fe.minX && x < fe.maxX && z > fe.minZ && z < fe.maxZ) return 0;
    const { D } = spec;
    if (x < D.minX || x > D.maxX || z < D.minZ || z > D.maxZ) return -0.02;
    for (const b of spec.blocks) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (b.site && x > spec.gate.minX && x < spec.gate.maxX && z < fe.minZ) return 0;
      // rounded kerb returns
      const r = [[b.minX, b.minZ, 1, 1, b.r[0]], [b.maxX, b.minZ, -1, 1, b.r[1]], [b.maxX, b.maxZ, -1, -1, b.r[2]], [b.minX, b.maxZ, 1, -1, b.r[3]]];
      for (const [cx, cz, sx, sz, rr] of r) {
        if (!rr) continue;
        const ox = cx + sx * rr, oz = cz + sz * rr;
        if ((x - ox) * sx < 0 && (z - oz) * sz < 0 && Math.hypot(x - ox, z - oz) > rr) return 0;
      }
      return TOP;
    }
    return 0;
  }

  return {
    group,
    meshes: { site: siteG.mesh, roads, blocks, kerbs, far },
    heightAt,
    setQuality(q) {
      const qq = typeof q === 'string' ? QUALITY[q] : q;
      const lo = qq?.name === 'low';
      for (const m of mats) {
        if (!m.defines) continue;
        const had = 'TERRAIN_LOW' in m.defines;
        if (had === lo) continue;
        if (lo) m.defines.TERRAIN_LOW = ''; else delete m.defines.TERRAIN_LOW;
        m.needsUpdate = true;
      }
    },
    update(dt, env) {
      t += dt;
      for (const m of mats) {
        const u = m.userData?.uniforms;
        if (u?.uTime) u.uTime.value = t;
      }
      if (env) {
        gridUniforms.uNight.value = env.nightFactor ?? 0;
        // environment.js exposes wetness (0 dry … 1 raining): damp base + rain
        const wet = Math.min(1, Math.max(0, env.wetness || 0));
        siteG.material.userData.uniforms?.uWet && (siteG.material.userData.uniforms.uWet.value = 0.15 + 0.85 * wet);
        roadMat.userData.uniforms.uWet.value = 0.08 + 0.92 * wet;
        // sun direction for the far field's painted shadows
        if (env.keyDir) sunTmp.copy(env.keyDir);
        else if (env.sunDir) sunTmp.copy(env.sunDir);
        else if (env.sun) sunTmp.copy(env.sun.position).sub(env.sun.target?.position || sunTmp.set(0, 0, 0));
        if (sunTmp.lengthSq() > 0) farMat.userData.uniforms.uSunDir.value.copy(sunTmp).normalize();
      }
    },
  };
}

// Precast concrete kerb units: 915 mm stones with dark joints, road grime
// wicking up the face.
function kerbMaterial() {
  const mat = pbrMaterial('concrete_slab', { repeat: [1 / 3, 1 / 3], albedo: 0.3, color: 0xf4f1ea, roughness: 1.05 });
  mat.name = 'kerb';
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', /* glsl */ `
      #include <map_fragment>
      #ifdef USE_MAP
      {
        vec2 km = vMapUv * 3.0; // metres along / down the kerb
        float fwj = max(fwidth(km.x), 1e-4);
        float jd = abs(mod(km.x + 0.4575, 0.915) - 0.4575);
        float joint = 1.0 - smoothstep(0.004, 0.004 + fwj * 1.5, jd);
        diffuseColor.rgb *= 1.0 - 0.75 * joint;
        diffuseColor.rgb *= mix(1.0, 0.5, smoothstep(0.06, 0.2, km.y));
        diffuseColor.rgb *= 0.88 + 0.24 * fract(sin(floor(km.x / 0.915) * 91.7) * 4375.5);
      }
      #endif`);
  };
  mat.customProgramCacheKey = () => 'kerb';
  return mat;
}
