// GorgeLook - the single definition of the Crimson Ford look (CINEMATIC_SPEC section 6 lighting/mood):
// overcast cool-grey sky gradient, darker haze fog so the gorge recedes, key/fill ratio, PMREM environment colours
// and the per-material albedo grade applied to the arena GLB at load. Every page that renders the ford (review
// page, game) calls applyGorgeLook() + gradeMaterials() instead of setting its own sky or lights.
// Values are linear working-space RGB. Measured basis (tools/court/albedo_probe.py): the cliff backdrop reused the
// boulder texture (mean linear albedo 0.42) and read as pale domes; sand 0.34; leaves 0.46/0.06/0.03 (coral).
// Pure configuration plus constructors: no clock, no RNG.
import * as THREE from 'three';
import { makeGorgeEnvironment } from './GorgeEnv.js';

export const GORGE_LOOK = Object.freeze({
  // sky gradient (horizon -> zenith) and fog; fog colour equals the horizon so far geometry dissolves into it
  // g7: warm milky grey like the mood frame (the g6 horizon leaned lavender)
  skyHorizon: [0.150, 0.140, 0.128],
  skyZenith: [0.070, 0.070, 0.074],
  fogDensity: 0.020,
  // world-space gorge haze (hazeMaterials): start just past the 16 m wall line; max < 1 keeps the backdrop as
  // layered darker silhouettes instead of flat sky-coloured cards
  haze: { start: 17.0, end: 36.0, max: 0.78, mistTop: 9.0 },
  water: { shallow: [0.060, 0.058, 0.050], deep: [0.006, 0.016, 0.020] },
  // lights: overcast fill lowered so the near field gets real darks; neutral key (a warm key turned leaf
  // highlights salmon)
  hemiSky: [0.62, 0.62, 0.66], hemiGround: [0.07, 0.05, 0.045], hemiIntensity: 0.36,
  sunColor: [1.0, 0.93, 0.88], sunIntensity: 2.6, sunPos: [-15, 11, 7],
  envIntensity: 0.30,
  exposure: 1.0,
  // PMREM env colours (kept in step with the visible sky so reflections agree with it)
  env: { sky: [0.17, 0.158, 0.145], zenith: [0.08, 0.08, 0.085], maple: [0.20, 0.02, 0.025], cliff: [0.030, 0.028, 0.029], floor: [0.04, 0.032, 0.026] },
  // per-material albedo multiplier (material.color), by GLB material name. Targets in comments are mean linear albedo.
  albedo: {
    ford_cliff: [0.13, 0.14, 0.16],     // 0.42 -> ~0.06 dark wet slate; the haze term lifts it toward the horizon
    ford_rock: [0.34, 0.35, 0.38],      // 0.42 -> ~0.14: still the palest stone in the gorge (spec: pale boulders)
    ford_sand: [0.22, 0.24, 0.28],      // 0.34 -> ~0.08 wet dark bank, cooler than the dry sand texture
    ford_shrine: [0.38, 0.39, 0.42],    // 0.38 -> ~0.15 carved stone
    ford_riverbed: [0.66, 0.68, 0.72],
    ford_leaf: [0.32, 0.15, 0.40],      // texture 0.26/0.033/0.015 -> ~0.083/0.005/0.006: crimson, a touch of blue
    ford_cloth: [0.55, 0.62, 0.70],     // texture 0.31/0.06/0.045 sat 0.62 -> ~0.17: was competing with the maples
    M_wall: [0.58, 0.59, 0.63],
    ford_plank: [0.55, 0.56, 0.62],     // the warm saturated walkway was the loudest colour after the maples
    blk_pagoda: [0.45, 0.42, 0.45],
  },
  // wet sheen: roughness multiplier for surfaces near the water (only where an ORM exists the map still drives detail)
  // ford_leaf > 1: a glossy leaf mixes white sheen into the red and reads pink/salmon
  roughness: { ford_sand: 0.70, ford_rock: 0.62, ford_riverbed: 0.70, ford_moss: 0.80, ford_leaf: 1.12 },
  // per-material envMapIntensity multiplier. Measured (tools/court/leaf_probe.py): lit leaf faces were hue ~2 deg
  // (red) but sat ~0.53 - the grey overcast reflection adds white on top of the crimson and reads salmon.
  envScale: { ford_leaf: 0.35, ford_cloth: 0.6 },
  // leaf translucency (emissive = albedo map x tint). Tried and rejected in review at 0.30 / 0.10 / 0.045: emissive
  // ignores shadowing, so canopies read self-lit and flat at every strength. Darker albedo is the fix instead (AgX
  // desaturates bright reds, so the lit faces need a lower value to stay crimson). Left empty on purpose.
  translucency: {},
});

const v3 = (a) => new THREE.Color(a[0], a[1], a[2]);

// Big inverted sky sphere with the horizon/zenith gradient. fog:false, no depth write, drawn first; it is a constant
// part of the scene graph from load so compileAsync and the water reflection prewarm both see its program.
function makeSky(look) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: { uH: { value: v3(look.skyHorizon) }, uZ: { value: v3(look.skyZenith) } },
    // plain projection (no xyww far-plane trick): the water's reflection camera uses an oblique near plane, which
    // would clip a far-plane-pinned sky. Radius 100 + review cameras within 30 m of origin stays inside far 160 m.
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vD; uniform vec3 uH, uZ;
      void main(){ float y = clamp(vD.y, -1.0, 1.0);
        vec3 c = mix(uH, uZ, smoothstep(0.02, 0.75, y));
        c = mix(c, uH * 0.8, smoothstep(0.0, -0.3, y));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), mat);
  mesh.name = 'gorge_sky'; mesh.renderOrder = -1000; mesh.frustumCulled = false;
  mesh.castShadow = false; mesh.receiveShadow = false;
  return mesh;
}

export function applyGorgeLook(scene, renderer, quality, opts = {}) {
  const L = GORGE_LOOK;
  renderer.toneMappingExposure = L.exposure;
  const horizon = v3(L.skyHorizon);
  scene.background = horizon.clone();
  scene.fog = new THREE.FogExp2(horizon.clone(), L.fogDensity);
  const sky = makeSky(L); scene.add(sky);
  const envRT = makeGorgeEnvironment(renderer, 0.04, L.env);
  scene.environment = envRT.texture; scene.environmentIntensity = L.envIntensity;
  const hemi = new THREE.HemisphereLight(v3(L.hemiSky), v3(L.hemiGround), L.hemiIntensity);
  const sun = new THREE.DirectionalLight(v3(L.sunColor), L.sunIntensity);
  sun.position.set(L.sunPos[0], L.sunPos[1], L.sunPos[2]);
  sun.castShadow = opts.shadows !== false;
  sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 70 });
  sun.shadow.camera.updateProjectionMatrix();   // without this the default 10 m box stays in use
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.04; sun.shadow.radius = 4.0;   // softer overcast penumbra
  scene.add(hemi, sun, sun.target);
  return {
    sky, sun, hemi, envRT,
    dispose() {
      scene.remove(sky, hemi, sun, sun.target); sky.geometry.dispose(); sky.material.dispose();
      sun.dispose(); hemi.dispose(); envRT.dispose(); scene.environment = null; scene.fog = null; scene.background = null;
    },
  };
}

// Gorge haze: the cliffs, pagoda and far maples stand 20-45 m out, where FogExp2 at an arena-friendly density only
// reaches ~35-55%, so they read as hard pale blobs. This adds a world-space term on top of scene fog: horizontal
// distance past the wall line plus low valley mist, blended toward the fog colour. Inside the arena (r < hazeStart)
// it is exactly 0, so gameplay readability is untouched. Patched once per material at load (constant program set,
// compiled by the prewarm like any other variant).
export function hazeMaterials(materials) {
  const L = GORGE_LOOK; let n = 0;
  for (const m of materials) {
    if (m.userData.gorgeHaze || !m.fog || m.isShaderMaterial) continue;
    m.userData.gorgeHaze = true; n++;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      if (prev) prev(sh, r);
      sh.uniforms.uHaze = { value: new THREE.Vector4(L.haze.start, L.haze.end, L.haze.max, L.haze.mistTop) };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vHazeW;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvHazeW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vHazeW; uniform vec4 uHaze;')
        .replace('#include <fog_fragment>', `#include <fog_fragment>
#ifdef USE_FOG
{ float rr = length(vHazeW.xz);
  float hz = smoothstep(uHaze.x, uHaze.y, rr) * uHaze.z;
  hz = max(hz, smoothstep(uHaze.x, uHaze.y + 10.0, rr) * (1.0 - smoothstep(-1.0, uHaze.w, vHazeW.y)) * 0.92);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, hz); }
#endif`);
    };
    const prevKey = m.customProgramCacheKey;
    m.customProgramCacheKey = () => (prevKey ? prevKey.call(m) : '') + '|gorgeHaze';
    m.needsUpdate = true;
  }
  return n;
}

// River body colours in step with the grade: the amber shallows (0.20/0.16/0.09) read as milky beige once the banks
// went dark; cooler, darker shallows keep the bed visible through the clear edge without the paste look.
export function gradeWater(water) {
  const w = GORGE_LOOK.water;
  water.uniforms.uShallow.value.setRGB(w.shallow[0], w.shallow[1], w.shallow[2]);
  water.uniforms.uDeep.value.setRGB(w.deep[0], w.deep[1], w.deep[2]);
}

// Multiply each arena material's colour/roughness by the grade table. Idempotent: the original values are kept on
// userData so a second call (hot reload, quality switch) never compounds.
export function gradeMaterials(materials, envTexture = null) {
  const L = GORGE_LOOK; let n = 0;
  for (const m of materials) {
    const a = L.albedo[m.name]; const r = L.roughness[m.name]; const e = L.envScale[m.name]; const tl = L.translucency[m.name];
    if (!a && !r && !e && !tl) continue;
    if (tl && m.map && m.emissive) { m.emissiveMap = m.map; m.emissive.setRGB(tl[0], tl[1], tl[2]); m.needsUpdate = true; }
    if (!m.userData.gradeBase) m.userData.gradeBase = { color: m.color.clone(), roughness: m.roughness, env: m.envMapIntensity ?? 1 };
    const b = m.userData.gradeBase;
    if (a) m.color.setRGB(b.color.r * a[0], b.color.g * a[1], b.color.b * a[2]);
    if (r) m.roughness = Math.min(1, b.roughness * r);
    // three r17x uses scene.environmentIntensity (not material.envMapIntensity) when the map comes from
    // scene.environment, so bind the same PMREM texture on the material for its own intensity to apply
    // (same USE_ENVMAP / cube-UV program, no extra variant)
    if (e && envTexture) { m.envMap = envTexture; m.envMapIntensity = L.envIntensity * e; m.needsUpdate = true; }
    n++;
  }
  return n;
}
