// FoundryLook - the single definition of the Frozen Foundry look (docs/STAGE3_SPEC.md section 2).
// Same light slots as the ford, re-targeted: nothing is added, removed or toggled, so the visible light count (and
// with it every lit program key) is identical on both stages. The foundry PMREM is generated once at load.
// setFoundryLook() snapshots the gorge values the first time so restoreGorgeLook() can put them back exactly
// (title restart after a foundry run). Pure configuration plus constructors: no clock, no RNG.
import * as THREE from 'three';
import { makeGorgeEnvironment } from './GorgeEnv.js';

const hex = (h) => new THREE.Color(h);   // sRGB hex -> linear working space

export const FOUNDRY_LOOK = Object.freeze({
  // Stage 3 must read DARKER than the ford (brief: "a darker scene"). Measured frame luminance before this pass:
  // foundry mean 128 vs ford 76 - the pale fog was lifting every pixel. Night foundry: navy-black haze, a narrow
  // cold roof-shaft key, warm crystal pools at the wall bases carry the colour contrast.
  background: 0x080b16,                 // black-navy void beyond the walls
  fog: 0x1c2438, fogDensity: 0.022,     // dark haze: depth falls into the void instead of washing to white
  exposure: 0.9,
  // roof-shaft key: cold white from (+0.35, 1, -0.2); long hard shadows across the X grating
  sunColor: 0xd8e6ff, sunIntensity: 2.1, sunDir: [0.35, 1.0, -0.2], sunDist: 26,
  shadowRadius: 1.5,                    // harder than the overcast ford penumbra
  hemiSky: 0x4a5a80, hemiGround: 0x10141f, hemiIntensity: 0.32,
  pointColor: 0xff8a5c, pointIntensity: 26, pointDistance: 10, pointDecay: 2,
  // night PMREM (linear RGB): dim steel roof, black floor
  env: { sky: [0.16, 0.19, 0.27], zenith: [0.10, 0.12, 0.18], maple: [0.07, 0.08, 0.12], cliff: [0.02, 0.025, 0.04], floor: [0.03, 0.035, 0.05] },
  envIntensity: 0.38,
});

export function makeFoundryEnvironment(renderer) { return makeGorgeEnvironment(renderer, 0.04, FOUNDRY_LOOK.env); }

// rig: { scene, renderer, sun, hemi, points: PointLight[4], slots: [[x,y,z] x4], sky (mesh or null), envRT }
// Snapshot the gorge rig once, before any other stage look touches it (shared by FoundryLook and ShrineLook).
export function snapshotGorge(rig) {
  if (rig.saved) return;
  const s = rig.scene, r = rig.renderer, u = rig.sky && rig.sky.material.uniforms;
  rig.saved = {
    background: s.background, fog: s.fog ? [s.fog.color.clone(), s.fog.density] : null,
    env: s.environment, envI: s.environmentIntensity, exposure: r.toneMappingExposure,
    sun: [rig.sun.color.clone(), rig.sun.intensity, rig.sun.position.clone(), rig.sun.shadow.radius],
    hemi: [rig.hemi.color.clone(), rig.hemi.groundColor.clone(), rig.hemi.intensity],
    points: rig.points.map((p) => [p.color.clone(), p.intensity, p.distance, p.decay, p.position.clone()]),
    sky: rig.sky ? rig.sky.visible : false,
    skyU: u && u.uH ? [u.uH.value.clone(), u.uZ.value.clone()] : null,
  };
}

export function setFoundryLook(rig) {
  const L = FOUNDRY_LOOK, s = rig.scene, r = rig.renderer;
  snapshotGorge(rig);
  s.background = hex(L.background);
  // mutate the one FogExp2: fog type is in the program key, so keeping the type keeps every program
  if (!s.fog) s.fog = new THREE.FogExp2(hex(L.fog), L.fogDensity);
  s.fog.color.set(L.fog); s.fog.density = L.fogDensity;
  s.environment = rig.envRT.texture; s.environmentIntensity = L.envIntensity;
  r.toneMappingExposure = L.exposure;
  const d = L.sunDir, n = Math.hypot(d[0], d[1], d[2]);
  rig.sun.color.set(L.sunColor); rig.sun.intensity = L.sunIntensity; rig.sun.shadow.radius = L.shadowRadius;
  rig.sun.position.set(d[0] / n * L.sunDist, d[1] / n * L.sunDist, d[2] / n * L.sunDist); rig.sun.target.position.set(0, 0, 0);
  rig.hemi.color.set(L.hemiSky); rig.hemi.groundColor.set(L.hemiGround); rig.hemi.intensity = L.hemiIntensity;
  const slots = rig.slots || [];
  rig.points.forEach((p, i) => {
    p.color.set(L.pointColor); p.intensity = L.pointIntensity; p.distance = L.pointDistance; p.decay = L.pointDecay;
    if (slots[i]) p.position.set(slots[i][0], slots[i][1], slots[i][2]);
  });
  if (rig.sky) rig.sky.visible = false;
}

export function restoreGorgeLook(rig) {
  const v = rig.saved; if (!v) return;
  const s = rig.scene;
  s.background = v.background; s.environment = v.env; s.environmentIntensity = v.envI; rig.renderer.toneMappingExposure = v.exposure;
  if (s.fog && v.fog) { s.fog.color.copy(v.fog[0]); s.fog.density = v.fog[1]; }
  rig.sun.color.copy(v.sun[0]); rig.sun.intensity = v.sun[1]; rig.sun.position.copy(v.sun[2]); rig.sun.shadow.radius = v.sun[3];
  rig.hemi.color.copy(v.hemi[0]); rig.hemi.groundColor.copy(v.hemi[1]); rig.hemi.intensity = v.hemi[2];
  rig.points.forEach((p, i) => { const q = v.points[i]; p.color.copy(q[0]); p.intensity = q[1]; p.distance = q[2]; p.decay = q[3]; p.position.copy(q[4]); });
  if (rig.sky) rig.sky.visible = v.sky;
  if (rig.sky && v.skyU) { rig.sky.material.uniforms.uH.value.copy(v.skyU[0]); rig.sky.material.uniforms.uZ.value.copy(v.skyU[1]); }
}
