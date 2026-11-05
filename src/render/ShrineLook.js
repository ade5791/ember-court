// ShrineLook - the single definition of the Stage 2 Dusk Shrine look (docs/STAGE2_SPEC.md section 4).
// Same light slots as the ford (1 sun + 1 hemi + 4 points), re-targeted: nothing is added, removed or toggled, so the
// visible light count and every lit program key stay identical across all three stages. The sky sphere stays
// visible; only its two gradient uniforms change (no recompile). The dusk PMREM is generated once at load.
// Pure configuration plus constructors: no clock, no RNG.
import * as THREE from 'three';
import { makeGorgeEnvironment } from './GorgeEnv.js';
import { snapshotGorge } from './FoundryLook.js';

export const SHRINE_LOOK = Object.freeze({
  // sunset: ember-orange horizon under a bruised violet zenith; the fog matches the horizon so the far maples and
  // the main hall dissolve into the afterglow instead of reading as cut-outs
  // (v2: fog was brown and dense enough to flatten the whole frame to one mid-tone; it now leans rose-violet,
  // thins out, and the zenith is lifted so the orange->violet gradient reads above the cedar line)
  skyHorizon: [0.66, 0.24, 0.07], skyZenith: [0.12, 0.05, 0.30],
  background: [0.34, 0.12, 0.10],
  fog: [0.26, 0.11, 0.13], fogDensity: 0.015,
  exposure: 1.0,
  // low key from the north-west, behind the main hall: long raking shadows across the flagstones toward the player
  sunColor: [1.0, 0.52, 0.26], sunIntensity: 2.4, sunDir: [-0.55, 0.30, -1.0], sunDist: 30,
  shadowRadius: 3.0,
  hemiSky: [0.34, 0.28, 0.62], hemiGround: [0.07, 0.035, 0.03], hemiIntensity: 0.55,
  // stone lanterns at the four corners (doc.shrine.lightSlots)
  pointColor: [1.0, 0.62, 0.30], pointIntensity: 18, pointDistance: 11, pointDecay: 2,
  env: { sky: [0.36, 0.14, 0.07], zenith: [0.07, 0.06, 0.12], maple: [0.22, 0.03, 0.03], cliff: [0.03, 0.02, 0.025], floor: [0.05, 0.035, 0.03] },
  envIntensity: 0.34,
});

export function makeShrineEnvironment(renderer) { return makeGorgeEnvironment(renderer, 0.04, SHRINE_LOOK.env); }

// rig: { scene, renderer, sun, hemi, points: PointLight[4], shrineSlots: [[x,y,z] x4], sky (mesh or null), shrineEnv }
export function setShrineLook(rig) {
  const L = SHRINE_LOOK, s = rig.scene, r = rig.renderer;
  snapshotGorge(rig);
  s.background = new THREE.Color(L.background[0], L.background[1], L.background[2]);
  if (!s.fog) s.fog = new THREE.FogExp2(0, L.fogDensity);
  s.fog.color.setRGB(L.fog[0], L.fog[1], L.fog[2]); s.fog.density = L.fogDensity;
  s.environment = rig.shrineEnv.texture; s.environmentIntensity = L.envIntensity;
  r.toneMappingExposure = L.exposure;
  const d = L.sunDir, n = Math.hypot(d[0], d[1], d[2]);
  rig.sun.color.setRGB(L.sunColor[0], L.sunColor[1], L.sunColor[2]); rig.sun.intensity = L.sunIntensity; rig.sun.shadow.radius = L.shadowRadius;
  rig.sun.position.set(d[0] / n * L.sunDist, d[1] / n * L.sunDist, d[2] / n * L.sunDist); rig.sun.target.position.set(0, 0, 0);
  rig.hemi.color.setRGB(L.hemiSky[0], L.hemiSky[1], L.hemiSky[2]); rig.hemi.groundColor.setRGB(L.hemiGround[0], L.hemiGround[1], L.hemiGround[2]);
  rig.hemi.intensity = L.hemiIntensity;
  const slots = rig.shrineSlots || [];
  rig.points.forEach((p, i) => {
    p.color.setRGB(L.pointColor[0], L.pointColor[1], L.pointColor[2]); p.intensity = L.pointIntensity; p.distance = L.pointDistance; p.decay = L.pointDecay;
    if (slots[i]) p.position.set(slots[i][0], slots[i][1], slots[i][2]);
  });
  if (rig.sky) {
    rig.sky.visible = true;
    const u = rig.sky.material.uniforms;
    if (u && u.uH) { u.uH.value.setRGB(L.skyHorizon[0], L.skyHorizon[1], L.skyHorizon[2]); u.uZ.value.setRGB(L.skyZenith[0], L.skyZenith[1], L.skyZenith[2]); }
  }
}
