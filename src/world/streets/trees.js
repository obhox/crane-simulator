import * as THREE from 'three';
import { rng } from '../../util/math.js';
import { GeoBuilder, M, patchShader, canvasTexture, CURB_Y, instancedProps } from './common.js';

// Procedural street trees (lime / plane-tree habit): a clear stem pruned to
// ~3 m for traffic clearance, 4–6 scaffold limbs, secondary branches and
// clusters of alpha-tested leaf cards. Card normals are bent towards the
// crown's outward direction so the canopy shades like a volume rather than
// a pile of flat quads. Wind sway is done in the vertex shader (whole-tree
// bend growing with height² + per-leaf flutter), shared by the shadow pass.

const VARIANTS = 3;

function leafTexture() {
  const S = 512;
  const r = rng(71);
  const tex = canvasTexture(S, S, (c) => {
    c.clearRect(0, 0, S, S);
    // twigs
    c.strokeStyle = 'rgba(70,52,34,1)';
    c.lineCap = 'round';
    for (let i = 0; i < 9; i++) {
      c.lineWidth = 2 + r() * 2;
      c.beginPath();
      const x = S * (0.2 + r() * 0.6), y = S * (0.2 + r() * 0.6);
      c.moveTo(S / 2, S / 2);
      c.quadraticCurveTo((x + S / 2) / 2 + (r() - 0.5) * 60, (y + S / 2) / 2 + (r() - 0.5) * 60, x, y);
      c.stroke();
    }
    // leaves: pointed ovals, darker at the rim, in clumps
    for (let i = 0; i < 330; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * S * 0.46;
      const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
      const L = 22 + r() * 24, W = L * (0.5 + r() * 0.15);
      const h = 88 + r() * 30, s = 38 + r() * 25, l = 22 + r() * 18 - d / S * 10;
      c.save();
      c.translate(x, y);
      c.rotate(r() * Math.PI * 2);
      c.fillStyle = `hsl(${h},${s}%,${l}%)`;
      c.beginPath();
      c.moveTo(-L / 2, 0);
      c.quadraticCurveTo(-L * 0.1, -W, L / 2, 0);
      c.quadraticCurveTo(-L * 0.1, W, -L / 2, 0);
      c.fill();
      c.strokeStyle = `hsla(${h},${s}%,${l + 14}%,0.5)`;
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(-L / 2, 0); c.lineTo(L / 2, 0); c.stroke();
      c.restore();
    }
  });
  return tex;
}

// bark: vertical fissures, greys and browns
function barkTexture() {
  const r = rng(5);
  return canvasTexture(128, 256, (c) => {
    c.fillStyle = '#5b5248'; c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 260; i++) {
      const x = r() * 128, y = r() * 256, h = 20 + r() * 60;
      const v = 60 + r() * 50;
      c.fillStyle = `rgba(${v},${v * 0.93},${v * 0.85},0.55)`;
      c.fillRect(x, y, 2 + r() * 5, h);
    }
    for (let i = 0; i < 90; i++) {
      c.fillStyle = 'rgba(25,20,16,0.6)';
      c.fillRect(r() * 128, r() * 256, 1.5, 30 + r() * 80);
    }
  }, { repeat: true });
}

function buildTree(seed, lod) {
  const r = rng(seed);
  const wood = new GeoBuilder({ color: 3, leaf: 1 });
  const leaves = new GeoBuilder({ color: 3, leaf: 1 });
  const H = 9 + r() * 3; // overall height
  const clear = 2.8 + r() * 0.6; // clear stem
  const crownC = new THREE.Vector3(0, clear + (H - clear) * 0.5, 0);
  const crownR = new THREE.Vector3(3 + r() * 1.2, (H - clear) * 0.55, 3 + r() * 1.2);
  const radial = lod ? 4 : 6;
  const barkCol = [1, 1, 1];

  const limb = (p0, dir, len, r0, r1, depth) => {
    const segs = lod ? 1 : depth > 1 ? 2 : 3;
    const pts = [p0.clone()];
    const d = dir.clone();
    const p = p0.clone();
    for (let i = 0; i < segs; i++) {
      d.y += 0.12 + r() * 0.1; // limbs curve up towards the light
      d.x += (r() - 0.5) * 0.25; d.z += (r() - 0.5) * 0.25;
      d.normalize();
      p.addScaledVector(d, len / segs);
      pts.push(p.clone());
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.TubeGeometry(curve, segs * 2, 1, depth > 1 ? Math.max(4, radial - 2) : radial, false);
    // taper: scale the tube radius along its length
    const pos = tube.attributes.position;
    const ring = (depth > 1 ? Math.max(4, radial - 2) : radial) + 1;
    for (let i = 0; i <= segs * 2; i++) {
      const c = curve.getPointAt(i / (segs * 2));
      const rad = r0 + (r1 - r0) * (i / (segs * 2));
      for (let j = 0; j < ring; j++) {
        const k = i * ring + j;
        const v = new THREE.Vector3().fromBufferAttribute(pos, k).sub(c).multiplyScalar(rad).add(c);
        pos.setXYZ(k, v.x, v.y, v.z);
      }
    }
    tube.computeVertexNormals();
    const uv = tube.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * len * 0.8);
    wood.add(tube, null, { color: barkCol, leaf: 0 });
    return { curve, end: p.clone(), dir: d.clone() };
  };

  const cluster = (c, size, n) => {
    for (let i = 0; i < n; i++) {
      const g = new THREE.PlaneGeometry(size * (0.8 + r() * 0.4), size * (0.8 + r() * 0.4));
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * Math.PI, r() * Math.PI * 2, r() * Math.PI));
      const off = new THREE.Vector3((r() - 0.5), (r() - 0.3), (r() - 0.5)).multiplyScalar(size * 0.7);
      g.applyQuaternion(q);
      g.translate(c.x + off.x, c.y + off.y, c.z + off.z);
      // crown normals: blend towards the direction out of the crown ellipsoid
      const pos = g.attributes.position, nor = g.attributes.normal;
      const n0 = new THREE.Vector3(), v = new THREE.Vector3();
      for (let k = 0; k < pos.count; k++) {
        v.fromBufferAttribute(pos, k).sub(crownC).divide(crownR);
        n0.fromBufferAttribute(nor, k);
        if (n0.dot(v) < 0) n0.negate();
        n0.lerp(v.normalize(), 0.75).normalize();
        nor.setXYZ(k, n0.x, n0.y, n0.z);
      }
      const shade = 0.82 + r() * 0.3;
      leaves.add(g, null, { color: [shade, shade * (0.97 + r() * 0.06), shade * 0.9], leaf: 1 });
    }
  };

  // stem
  const lean = new THREE.Vector3((r() - 0.5) * 0.08, 1, (r() - 0.5) * 0.08).normalize();
  const trunk = limb(new THREE.Vector3(0, -0.1, 0), lean, clear + 0.4, 0.17, 0.13, 0);
  const top = trunk.end;
  // leader continues up the middle
  const leader = limb(top, new THREE.Vector3(0, 1, 0), H - clear - 1.2, 0.12, 0.035, 1);
  const tips = [leader.end];
  const n = lod ? 4 : 4 + Math.floor(r() * 3);
  const a0 = r() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + (r() - 0.5) * 0.5;
    const el = 0.55 + r() * 0.35;
    const d = new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
    const start = top.clone().add(new THREE.Vector3(0, (r() - 0.3) * 0.8, 0));
    const L = 3.2 + r() * 1.4;
    const m = limb(start, d, L, 0.1, 0.03, 1);
    tips.push(m.end);
    if (!lod) {
      for (let k = 0; k < 2; k++) {
        const t = 0.45 + r() * 0.35;
        const p = m.curve.getPointAt(t);
        const sd = m.dir.clone().add(new THREE.Vector3((r() - 0.5) * 1.6, 0.3 + r() * 0.4, (r() - 0.5) * 1.6)).normalize();
        const s = limb(p, sd, 1.6 + r() * 1.2, 0.04, 0.015, 2);
        tips.push(s.end);
      }
    } else {
      tips.push(m.curve.getPointAt(0.55));
    }
  }
  // leaf clusters at the tips + fill points inside the crown shell
  const cardSize = lod ? 2.6 : 1.7;
  for (const t of tips) cluster(t, cardSize, lod ? 3 : 6);
  const fill = lod ? 8 : 26;
  for (let i = 0; i < fill; i++) {
    const u = r() * Math.PI * 2, v = Math.acos(1 - 2 * r() * 0.85);
    const s = 0.55 + r() * 0.4;
    const p = new THREE.Vector3(Math.sin(v) * Math.cos(u) * crownR.x * s, Math.cos(v) * crownR.y * s, Math.sin(v) * Math.sin(u) * crownR.z * s).add(crownC);
    cluster(p, cardSize, lod ? 2 : 3);
  }
  return { wood: wood.build(), leaves: leaves.build(), height: H };
}

function windPatch(mat, uniforms, key) {
  return patchShader(mat, key, {
    uniforms,
    vertexPars: 'uniform float uTime; uniform vec3 uWind; attribute float leaf;',
    vertex: {
      begin_vertex: `$
        {
          #ifdef USE_INSTANCING
            vec3 org = vec3( instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2] );
            // wind direction into the (randomly rotated) tree's local frame
            vec2 wdir = normalize( ( transpose( mat3( instanceMatrix ) ) * vec3( uWind.x, 0.0, uWind.y ) ).xz + 1e-5 );
          #else
            vec3 org = vec3( 0.0 );
            vec2 wdir = uWind.xy;
          #endif
          float ph = dot( org.xz, vec2( 0.113, 0.071 ) );
          float h = max( 0.0, position.y - 2.5 ) / 9.0;
          float gust = 0.6 + 0.4 * sin( uTime * 0.37 + ph * 0.5 );
          float sway = ( sin( uTime * 1.13 + ph ) * 0.6 + sin( uTime * 2.31 + ph * 1.7 ) * 0.25 ) * gust;
          vec2 bend = wdir * uWind.z * ( 0.05 + 0.06 * sway ) * h * h * 3.0;
          transformed.xz += bend;
          transformed.y -= dot( bend, bend ) * 0.15;
          float fl = leaf * uWind.z * 0.05;
          transformed += fl * vec3( sin( uTime * 6.1 + position.x * 3.1 + ph ), sin( uTime * 7.3 + position.y * 2.7 ), cos( uTime * 5.7 + position.z * 3.3 ) );
        }`,
    },
  });
}

export function buildTrees(root, quality, plan) {
  const list = plan.trees || [];
  if (!list.length) return { update() {}, meshes: [] };
  const low = quality.name === 'low';
  const uniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(0.8, 0.6, 0.35) } };
  const leafTex = leafTexture();
  const bark = barkTexture();
  const leafMat = windPatch(new THREE.MeshStandardMaterial({
    map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.78, metalness: 0,
    vertexColors: true, color: 0x9fb07a, alphaToCoverage: !low,
  }), uniforms, 'treeLeaf');
  const woodMat = windPatch(new THREE.MeshStandardMaterial({ map: bark, roughness: 0.92, metalness: 0, vertexColors: true, color: 0xb8aea2 }), uniforms, 'treeWood');
  const leafDepth = windPatch(new THREE.MeshDepthMaterial({ map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide }), uniforms, 'treeLeafDepth');
  const woodDepth = windPatch(new THREE.MeshDepthMaterial(), uniforms, 'treeWoodDepth');

  // near (detailed) vs far (few big cards) — the camera lives near the site
  const nearR = low ? 0 : quality.name === 'medium' ? 150 : 190;
  const variants = [];
  for (let v = 0; v < VARIANTS; v++) variants.push([buildTree(1000 + v * 17, 0), buildTree(2000 + v * 31, 1)]);
  const r = rng(314);
  const buckets = variants.map(() => [[], []]);
  for (const t of list) {
    const v = Math.floor(r() * VARIANTS);
    const lod = t.dist < nearR ? 0 : 1;
    const s = 0.85 + r() * 0.3;
    buckets[v][lod].push(M(t.x, CURB_Y, t.z, 0, r() * Math.PI * 2, 0, s, s * (0.9 + r() * 0.2), s));
  }
  const meshes = [];
  buckets.forEach((b, v) => b.forEach((mats, lod) => {
    if (!mats.length) return;
    const tree = variants[v][lod];
    for (const [geo, mat, dm, name] of [[tree.wood, woodMat, woodDepth, 'wood'], [tree.leaves, leafMat, leafDepth, 'leaves']]) {
      // near trees: quadrant chunks that cast; far card trees only cast on
      // ultra (their shadows are a few texels in the far cascade)
      const cast = lod === 0 ? !low : quality.name === 'ultra';
      meshes.push(...instancedProps(root, geo, mat, mats, {
        name: `trees.${name}.v${v}.lod${lod}`, cast, shadowR: 1e4, depthMaterial: dm,
      }));
    }
  }));
  let t = 0;
  return {
    meshes,
    setWind(speed, dirRad) {
      uniforms.uWind.value.set(Math.cos(dirRad), Math.sin(dirRad), Math.min(1.5, 0.15 + speed / 12));
    },
    update(dt) {
      t += dt;
      uniforms.uTime.value = t;
    },
  };
}
