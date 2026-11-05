// RoadLook - the single definition of the v2.20 mountain-pass look (the walk between two bosses).
// Same light slots as every other stage (1 sun + 1 hemi + 4 points): nothing added, removed or toggled, so every
// lit program key is unchanged. The 4 points are re-positioned per frame onto the lanterns nearest the hero by
// RoadStage.update (position only). Pure configuration plus constructors: no clock, no RNG.
import * as THREE from 'three';
import { makeGorgeEnvironment } from './GorgeEnv.js';
import { snapshotGorge } from './FoundryLook.js';

export const ROAD_LOOK = Object.freeze({
  // late afternoon in a high pass: blue-grey valley haze, warm sun low behind the travellers' backs so the road ahead
  // is rim-lit gold and the cliff walls fall into cool shadow; dense enough that the next ambush emerges from mist
  skyHorizon: [0.62, 0.50, 0.38], skyZenith: [0.16, 0.22, 0.34],
  background: [0.40, 0.38, 0.36],
  fog: [0.42, 0.39, 0.36], fogDensity: 0.012,
  exposure: 1.12,
  sunColor: [1.0, 0.70, 0.44], sunIntensity: 2.8, sunDir: [0.35, 0.62, 1.0], sunDist: 34,
  shadowRadius: 3.5,
  hemiSky: [0.46, 0.52, 0.62], hemiGround: [0.10, 0.08, 0.05], hemiIntensity: 0.62,
  pointColor: [1.0, 0.60, 0.28], pointIntensity: 14, pointDistance: 10, pointDecay: 2,
  env: { sky: [0.40, 0.36, 0.30], zenith: [0.10, 0.13, 0.18], maple: [0.10, 0.09, 0.05], cliff: [0.04, 0.04, 0.045], floor: [0.07, 0.06, 0.045] },
  envIntensity: 0.4,
});

export function makeRoadEnvironment(renderer) { return makeGorgeEnvironment(renderer, 0.04, ROAD_LOOK.env); }
export function roadSunDir() { const d = ROAD_LOOK.sunDir, n = Math.hypot(d[0], d[1], d[2]); return [d[0] / n, d[1] / n, d[2] / n]; }

// rig: { scene, renderer, sun, hemi, points: PointLight[4], sky, roadEnv }
export function setRoadLook(rig) {
  const L = ROAD_LOOK, s = rig.scene, r = rig.renderer;
  snapshotGorge(rig);
  s.background = new THREE.Color(L.background[0], L.background[1], L.background[2]);
  if (!s.fog) s.fog = new THREE.FogExp2(0, L.fogDensity);
  s.fog.color.setRGB(L.fog[0], L.fog[1], L.fog[2]); s.fog.density = L.fogDensity;
  s.environment = rig.roadEnv.texture; s.environmentIntensity = L.envIntensity;
  r.toneMappingExposure = L.exposure;
  const d = roadSunDir();
  rig.sun.color.setRGB(L.sunColor[0], L.sunColor[1], L.sunColor[2]); rig.sun.intensity = L.sunIntensity; rig.sun.shadow.radius = L.shadowRadius;
  rig.sun.position.set(d[0] * L.sunDist, d[1] * L.sunDist, d[2] * L.sunDist); rig.sun.target.position.set(0, 0, 0);
  rig.hemi.color.setRGB(L.hemiSky[0], L.hemiSky[1], L.hemiSky[2]); rig.hemi.groundColor.setRGB(L.hemiGround[0], L.hemiGround[1], L.hemiGround[2]);
  rig.hemi.intensity = L.hemiIntensity;
  rig.points.forEach((p) => { p.color.setRGB(L.pointColor[0], L.pointColor[1], L.pointColor[2]); p.intensity = L.pointIntensity; p.distance = L.pointDistance; p.decay = L.pointDecay; });
  if (rig.sky) {
    rig.sky.visible = true;
    const u = rig.sky.material.uniforms;
    if (u && u.uH) { u.uH.value.setRGB(L.skyHorizon[0], L.skyHorizon[1], L.skyHorizon[2]); u.uZ.value.setRGB(L.skyZenith[0], L.skyZenith[1], L.skyZenith[2]); }
  }
}
