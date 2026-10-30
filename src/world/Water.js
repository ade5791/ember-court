// Water - the Crimson Ford river surface (CINEMATIC_SPEC section 6 + 4). A MeshStandardMaterial patched with
// onBeforeCompile so it stays in the same lighting/tonemap pipeline as the arena: flow-scrolled procedural
// normals, depth tint toward the amber bed, fresnel-weighted opacity, a 32-slot stain ring buffer (ink-blood)
// and a 24-slot ripple ring buffer. Slot counts are fixed so the program key never changes at runtime.
// Time comes from the engine clock (setTime), never performance.now().
import * as THREE from 'three';

export const WATER_STAIN_SLOTS = 32;
export const WATER_RIPPLE_SLOTS = 24;
const STAIN_LIFE = 20.0;
const RIPPLE_LIFE = 0.8;

export class Water {
  // halfZ = waterline |z| where the bank slope crosses the surface; the plane itself extends meshPad past it so the
  // bank geometry cuts the water (a plane ending at the waterline floats 3 cm over the slope = hard rectangle edge).
  // reflectionScale 0 = env-only reflection (low tier); 0.5 = half-res planar reflection of the real scene.
  constructor({ halfX, halfZ, y, flowDir, meshPad = 0.6, reflectionScale = 0.5 }) {
    this.y = y; this.reflectionScale = reflectionScale;
    this.stains = new Float32Array(WATER_STAIN_SLOTS * 4);     // x, z, radius, birth
    this.ripples = new Float32Array(WATER_RIPPLE_SLOTS * 4);   // x, z, strength, birth
    for (let i = 0; i < WATER_STAIN_SLOTS; i++) this.stains[i * 4 + 3] = -1e4;
    for (let i = 0; i < WATER_RIPPLE_SLOTS; i++) this.ripples[i * 4 + 3] = -1e4;
    this.stainHead = 0; this.rippleHead = 0; this.time = 0;
    const u = this.uniforms = {
      uTime: { value: 0 },
      uFlow: { value: new THREE.Vector2(flowDir[0], flowDir[2]).normalize().multiplyScalar(0.35) },
      uShallow: { value: new THREE.Color(0.20, 0.16, 0.09) },
      uDeep: { value: new THREE.Color(0.015, 0.035, 0.04) },
      uHalf: { value: new THREE.Vector2(halfX, halfZ) },
      uStains: { value: this._vec4Array(WATER_STAIN_SLOTS) },
      uRipples: { value: this._vec4Array(WATER_RIPPLE_SLOTS) },
      uStainLife: { value: STAIN_LIFE },
      uRippleLife: { value: RIPPLE_LIFE },
      uReflTex: { value: null },
      uReflMat: { value: new THREE.Matrix4() },
      uReflOn: { value: 0 },
    };
    this._initReflection();
    const mat = this.material = new THREE.MeshStandardMaterial({
      color: 0x18262a, roughness: 0.04, metalness: 0.0, transparent: true, opacity: 0.78, depthWrite: false, envMapIntensity: 1.6,
    });
    mat.name = 'ford_water';
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWaterW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vWaterW;
uniform float uTime; uniform vec2 uFlow; uniform vec3 uShallow; uniform vec3 uDeep; uniform vec2 uHalf;
uniform vec4 uStains[${WATER_STAIN_SLOTS}]; uniform vec4 uRipples[${WATER_RIPPLE_SLOTS}];
uniform float uStainLife; uniform float uRippleLife;
uniform sampler2D uReflTex; uniform mat4 uReflMat; uniform float uReflOn;
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y); }
float wHeight(vec2 p) {
  return wNoise(p * 1.7 - uFlow * uTime * 1.6) * 0.55 + wNoise(p * 4.3 + vec2(-uFlow.y, uFlow.x) * uTime * 0.9 - uFlow * uTime * 3.0) * 0.30
       + wNoise(p * 9.1 - uFlow * uTime * 5.0) * 0.15; }
float wRipple(vec2 p) {
  float h = 0.0;
  for (int i = 0; i < ${WATER_RIPPLE_SLOTS}; i++) {
    vec4 r = uRipples[i]; float age = uTime - r.w;
    if (age < 0.0 || age > uRippleLife) continue;
    float d = distance(p, r.xy); float front = age * 1.8;
    h += r.z * sin((d - front) * 18.0) * exp(-abs(d - front) * 9.0) * (1.0 - age / uRippleLife);
  }
  return h; }
float wStain(vec2 p) {
  float s = 0.0;
  for (int i = 0; i < ${WATER_STAIN_SLOTS}; i++) {
    vec4 st = uStains[i]; float age = uTime - st.w;
    if (age < 0.0 || age > uStainLife) continue;
    float d = distance(p, st.xy) / (st.z * (1.0 + 0.6 * clamp(age / 3.0, 0.0, 1.0)));
    float edge = wNoise(p * 3.0 + st.xy) * 0.35;
    s = max(s, (1.0 - smoothstep(0.55 - edge, 1.0, d)) * (1.0 - age / uStainLife));
  }
  return s; }`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec2 wp = vWaterW.xz; float e = 0.04;
  float h0 = wHeight(wp) + wRipple(wp);
  float hx = wHeight(wp + vec2(e, 0.0)) + wRipple(wp + vec2(e, 0.0));
  float hz = wHeight(wp + vec2(0.0, e)) + wRipple(wp + vec2(0.0, e));
  vec3 nW = normalize(vec3(-(hx - h0) / e * 0.16, 1.0, -(hz - h0) / e * 0.16));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  // depth tint: shallow amber near the banks (|z| -> uHalf.y), darker teal mid-channel
  float edge = smoothstep(uHalf.y - 1.6, uHalf.y, abs(vWaterW.z));
  diffuseColor.rgb = mix(uDeep, uShallow, 0.15 + 0.85 * edge * edge);
  float st = wStain(vWaterW.xz);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.012, 0.01), st * 0.85);
  vec3 vdir = normalize(cameraPosition - vWaterW);
  float fres = pow(1.0 - clamp(vdir.y, 0.0, 1.0), 4.0);
  // body alpha = turbidity of 18 cm of river water only; the fresnel/reflection layer is composited in opaque_fragment
  // mid-channel reads deeper: more turbid and darker; banks stay clear so the pebble bed shows through
  diffuseColor.a = clamp(0.58 - 0.38 * edge + st * 0.45, 0.0, 1.0);
}`)
        .replace('#include <opaque_fragment>', `{
  // Water composite. Normal alpha blending gives out = c*a + bg*(1-a). Wanted: refl*F + body*(1-F)*aB + bg*(1-F)*(1-aB),
  // so a = 1-(1-aB)(1-F) and c = (refl*F + body*(1-F)*aB)/a. Sun glints (directSpecular) add on top.
  float aB = diffuseColor.a;
  vec3 V = normalize(vViewPosition);
  float NdV = clamp(dot(normal, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec4 pc = uReflMat * vec4(vWaterW, 1.0);
  vec2 ruv = pc.xy / pc.w + normal.xy * 0.035;
  vec3 reflPlanar = texture2D(uReflTex, clamp(ruv, 0.001, 0.999)).rgb;
  vec3 reflEnv = reflectedLight.indirectSpecular / max(F, 0.05);
  vec3 refl = mix(reflEnv, reflPlanar, uReflOn);
  vec3 body = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
  float a = 1.0 - (1.0 - aB) * (1.0 - F);
  outgoingLight = (refl * F + body * (1.0 - F) * aB + reflectedLight.directSpecular) / max(a, 0.02);
  diffuseColor.a = a;
  // foam: broken band at the waterline plus faint streaks stretched along the flow
  vec2 fp = vWaterW.xz;
  float bank = smoothstep(uHalf.y - 0.5, uHalf.y - 0.05, abs(fp.y)) * (1.0 - smoothstep(uHalf.y + 0.05, uHalf.y + 0.3, abs(fp.y)));
  float fn = wNoise(fp * 5.0 - uFlow * uTime * 3.0) * 0.6 + wNoise(fp * 11.0 - uFlow * uTime * 4.5) * 0.4;
  vec2 fl = normalize(uFlow); vec2 q = vec2(dot(fp, fl), dot(fp, vec2(-fl.y, fl.x)));
  float streak = smoothstep(0.70, 0.86, wNoise(vec2(q.x * 0.8, q.y * 4.0) - vec2(uTime * 0.7, 0.0)));
  // streaks at 0.18 read as painted diagonal stripes in the colour-pass review; 0.07 keeps a hint of flow
  float foam = clamp(bank * smoothstep(0.35, 0.7, fn) + streak * 0.07, 0.0, 1.0);
  // colour pass: white foam at 0.75 read as a dashed road marking against the darker graded banks
  outgoingLight = mix(outgoingLight, vec3(0.34, 0.34, 0.33), foam * 0.55);
  diffuseColor.a = max(diffuseColor.a, foam * 0.6);
}
#include <opaque_fragment>`);
      this.shader = sh;
    };
    mat.customProgramCacheKey = () => 'ford_water_v4';
    const geo = new THREE.PlaneGeometry(halfX * 2, (halfZ + meshPad) * 2, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'ford_water';
    this.mesh.position.y = y;
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = true;
    this.mesh.onBeforeRender = (renderer, scene, camera) => this._renderReflection(renderer, scene, camera);
  }

  // ---- planar reflection (mirror camera about y = this.y with an oblique near plane; Reflector.js algorithm) ----
  _initReflection() {
    this.reflCam = new THREE.PerspectiveCamera();
    this.reflRT = this.reflectionScale > 0
      ? new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 0 }) : null;   // linear HDR, no tonemap
    if (this.reflRT) { this.reflRT.texture.name = 'ford_water_reflection'; this.uniforms.uReflTex.value = this.reflRT.texture; }
    this._s = { n: new THREE.Vector3(0, 1, 0), p: new THREE.Vector3(), cam: new THREE.Vector3(), view: new THREE.Vector3(),
      look: new THREE.Vector3(), tgt: new THREE.Vector3(), rot: new THREE.Matrix4(), plane: new THREE.Plane(),
      clip: new THREE.Vector4(), q: new THREE.Vector4(), size: new THREE.Vector2() };
    this._inRefl = false;
  }

  _renderReflection(renderer, scene, camera) {
    const u = this.uniforms;
    if (!this.reflRT || this._inRefl || !camera.isPerspectiveCamera) { u.uReflOn.value = 0; return; }
    const s = this._s, vc = this.reflCam;
    s.p.set(0, this.y, 0);
    s.cam.setFromMatrixPosition(camera.matrixWorld);
    s.view.subVectors(s.p, s.cam);
    if (s.view.dot(s.n) > 0) { u.uReflOn.value = 0; return; }   // camera under the surface
    s.view.reflect(s.n).negate().add(s.p);
    s.rot.extractRotation(camera.matrixWorld);
    s.look.set(0, 0, -1).applyMatrix4(s.rot).add(s.cam);
    s.tgt.subVectors(s.p, s.look).reflect(s.n).negate().add(s.p);
    vc.position.copy(s.view);
    vc.up.set(0, 1, 0).applyMatrix4(s.rot).reflect(s.n);
    vc.lookAt(s.tgt);
    vc.near = camera.near; vc.far = camera.far;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);
    // texture matrix: world -> mirror clip -> [0,1]
    const M = u.uReflMat.value;
    M.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    M.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    // oblique near plane = water plane, so the bed and anything below the surface never shows in the reflection
    s.plane.setFromNormalAndCoplanarPoint(s.n, s.p).applyMatrix4(vc.matrixWorldInverse);
    s.clip.set(s.plane.normal.x, s.plane.normal.y, s.plane.normal.z, s.plane.constant);
    const e = vc.projectionMatrix.elements;
    s.q.set((Math.sign(s.clip.x) + e[8]) / e[0], (Math.sign(s.clip.y) + e[9]) / e[5], -1.0, (1.0 + e[10]) / e[14]);
    s.clip.multiplyScalar(2.0 / s.clip.dot(s.q));
    e[2] = s.clip.x; e[6] = s.clip.y; e[10] = s.clip.z + 1.0 - 0.003; e[14] = s.clip.w;
    vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();
    // size follows the drawing buffer
    renderer.getDrawingBufferSize(s.size);
    const w = Math.max(4, Math.round(s.size.x * this.reflectionScale)), h = Math.max(4, Math.round(s.size.y * this.reflectionScale));
    if (this.reflRT.width !== w || this.reflRT.height !== h) this.reflRT.setSize(w, h);
    // render (water hidden; shadow map reused from the main pass)
    this._inRefl = true; this.mesh.visible = false;
    const prevRT = renderer.getRenderTarget(), prevXR = renderer.xr.enabled, prevShadow = renderer.shadowMap.autoUpdate;
    renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.reflRT);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, vc);
    renderer.xr.enabled = prevXR; renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevRT);
    if (camera.viewport !== undefined) renderer.state.viewport(camera.viewport);
    this.mesh.visible = true; this._inRefl = false;
    u.uReflOn.value = 1;
  }

  // Compile the reflection-target program variants (linear output, no tonemap = different program keys) behind the
  // loading screen. Call after the world is in the scene; draws nothing.
  async prewarm(renderer, scene, camera) {
    if (!this.reflRT) return;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.reflRT);
    const wasVisible = this.mesh.visible;
    this.mesh.visible = false;
    await renderer.compileAsync(scene, camera, scene);
    this.mesh.visible = wasVisible;
    renderer.setRenderTarget(prev);
  }

  _vec4Array(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = new THREE.Vector4(0, 0, 0, -1e4); return a; }

  setTime(t) { this.time = t; this.uniforms.uTime.value = t; }

  // Ink-blood stain written into the ring buffer (fx owns the trigger; this is the write).
  addStain(x, z, radius) {
    const v = this.uniforms.uStains.value[this.stainHead];
    v.set(x, z, radius, this.time);
    this.stainHead = (this.stainHead + 1) % WATER_STAIN_SLOTS;
  }

  addRipple(x, z, strength) {
    const v = this.uniforms.uRipples.value[this.rippleHead];
    v.set(x, z, strength, this.time);
    this.rippleHead = (this.rippleHead + 1) % WATER_RIPPLE_SLOTS;
  }

  reset() {
    for (const v of this.uniforms.uStains.value) v.set(0, 0, 0, -1e4);
    for (const v of this.uniforms.uRipples.value) v.set(0, 0, 0, -1e4);
    this.stainHead = 0; this.rippleHead = 0;
  }

  dispose() {
    this.mesh.geometry.dispose(); this.material.dispose();
    if (this.reflRT) { this.reflRT.dispose(); this.reflRT = null; }
    this.mesh.onBeforeRender = () => {};
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
  }
}
