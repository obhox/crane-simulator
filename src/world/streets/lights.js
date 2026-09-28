import * as THREE from 'three';

// Cheap night lighting.
//
// GlowPoints — additive point sprites for lamp heads / vehicle lights. A lamp
// seen from 300 m is sub-pixel and would simply vanish; photos show it as a
// bright 1–3 px dot, so the sprite keeps a minimum pixel size. It also gives
// the HDR bloom something to bite on up close.
//
// LightPools — street-light pools as additive ground decals. The added
// radiance is lamp illuminance × the albedo of the surface the decal covers
// (asphalt ≈ 0.07, concrete paving ≈ 0.18, baked into the per-instance tint),
// i.e. what a diffuse surface actually reflects, so pools read correctly
// whatever the (very low) night ambient is — no real per-pixel lights needed.

const FOG_FADE = /* glsl */`
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogF = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    fade *= 1.0 - fogF;
  #endif
`;

export class GlowPoints {
  constructor(root, capacity, { minPx = 2.2, dynamic = true, gain = 1 } = {}) {
    this.capacity = capacity;
    this.count = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    if (dynamic) for (const k of ['position', 'color', 'size']) g.attributes[k].setUsage(THREE.DynamicDrawUsage);
    g.setDrawRange(0, 0);
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uViewH: { value: 1000 }, uMinPx: { value: minPx }, uGain: { value: gain },
    }]);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float size;
        attribute vec3 color;
        uniform float uViewH, uMinPx;
        varying vec3 vCol;
        varying float vFade;
        #include <fog_pars_vertex>
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          float d = max( 0.1, - mvPosition.z );
          float px = size * projectionMatrix[1][1] * 0.5 * uViewH / d;
          gl_PointSize = clamp( px, uMinPx, 256.0 );
          // sub-minimum sprites keep a floor brightness (distant lamps read as dots)
          vFade = mix( 0.55, 1.0, clamp( px / uMinPx - 1.0, 0.0, 1.0 ) );
          vCol = color;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform float uGain;
        varying vec3 vCol;
        varying float vFade;
        #include <fog_pars_fragment>
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot( p, p );
          if ( r2 > 1.0 ) discard;
          float fade = vFade;
          ${FOG_FADE}
          float core = exp( - r2 * 14.0 ) + 0.18 * exp( - r2 * 3.5 ) * ( 1.0 - r2 );
          gl_FragColor = vec4( vCol * core * fade * uGain, 1.0 );
        }`,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.name = 'streets.glow';
    const vs = new THREE.Vector2();
    this.points.onBeforeRender = (renderer) => {
      const rt = renderer.getRenderTarget();
      this.uniforms.uViewH.value = rt ? rt.height : renderer.getDrawingBufferSize(vs).y;
    };
    root.add(this.points);
  }

  begin() { this.count = 0; }

  // size: sprite diameter in metres; k: brightness
  push(x, y, z, r, g, b, size, k) {
    if (this.count >= this.capacity || k <= 0) return;
    const i = this.count++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 3] = r * k; this.col[i * 3 + 1] = g * k; this.col[i * 3 + 2] = b * k;
    this.size[i] = size;
  }

  end() {
    const g = this.points.geometry;
    g.setDrawRange(0, this.count);
    for (const k of ['position', 'color', 'size']) {
      const a = g.attributes[k];
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
  }
}

// Instanced ground decals. Each instance is a rectangle (the matrix places a
// unit XZ quad) lit by one lamp at iPool.xy with an elliptical LED
// distribution: long along the road (iPool.z), narrower across it (iPool.w).
export class LightPools {
  constructor(root, capacity) {
    this.capacity = capacity;
    this.count = 0;
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.pool = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.axis = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    g.setAttribute('iPool', this.pool);
    g.setAttribute('iAxis', this.axis);
    g.setAttribute('iTint', this.tint);
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uGain: { value: 0 } }]);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      fog: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec4 iPool;
        attribute vec2 iAxis;
        attribute vec3 iTint;
        varying vec2 vRel;
        varying vec3 vTint;
        #include <fog_pars_vertex>
        void main() {
          vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
          vec2 d = wp.xz - iPool.xy;
          // into lamp space: along-road / across-road, normalised by the pool radii
          vRel = vec2( dot( d, iAxis ) / iPool.z, dot( d, vec2( -iAxis.y, iAxis.x ) ) / iPool.w );
          vTint = iTint;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform float uGain;
        varying vec2 vRel;
        varying vec3 vTint;
        #include <fog_pars_fragment>
        void main() {
          float r2 = dot( vRel, vRel );
          if ( r2 > 1.0 ) discard;
          float fall = ( 1.0 - r2 );
          // peaked like a real LED optic: hot spot under the head, soft
          // shoulder, darker gaps between lamps (EN 13201 uniformity ~0.4)
          fall = fall * fall * ( 0.15 + 0.85 * exp( - r2 * 4.5 ) );
          float fade = 1.0;
          ${FOG_FADE}
          gl_FragColor = vec4( vTint * fall * uGain * fade, 1.0 );
        }`,
    });
    this.mesh = new THREE.InstancedMesh(g, this.material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.name = 'streets.lightPools';
    root.add(this.mesh);
    this._m = new THREE.Matrix4();
  }

  // rect: centre (cx, y, cz), size along x / z; lamp at (lx, lz), along-road unit (ax, az)
  add(cx, y, cz, sx, sz, lx, lz, ax, az, along, across, tint) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this._m.makeScale(sx, 1, sz).setPosition(cx, y, cz);
    this.mesh.setMatrixAt(i, this._m);
    this.pool.setXYZW(i, lx, lz, along, across);
    this.axis.setXY(i, ax, az);
    this.tint.setXYZ(i, tint[0], tint[1], tint[2]);
    this.mesh.count = this.count;
  }

  // oriented rectangle (length along the unit heading (ax, az), width across it)
  addOriented(cx, y, cz, len, wid, lx, lz, ax, az, along, across, tint) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    // columns: x → heading, z → perpendicular (right-handed about +y)
    this._m.set(ax * len, 0, -az * wid, cx, 0, 1, 0, y, az * len, 0, ax * wid, cz, 0, 0, 0, 1);
    this.mesh.setMatrixAt(i, this._m);
    this.pool.setXYZW(i, lx, lz, along, across);
    this.axis.setXY(i, ax, az);
    this.tint.setXYZ(i, tint[0], tint[1], tint[2]);
    this.mesh.count = this.count;
  }

  begin() { this.count = 0; this.mesh.count = 0; }

  finish() {
    this.mesh.instanceMatrix.needsUpdate = true;
    this.pool.needsUpdate = this.axis.needsUpdate = this.tint.needsUpdate = true;
  }

  setNight(n, gain = 2) {
    const k = Math.max(0, (n - 0.15) / 0.85);
    this.uniforms.uGain.value = k * gain;
    this.mesh.visible = k > 0;
  }
}
