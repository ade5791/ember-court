// Rim - Fresnel rim term injected into standard/physical materials as extra emissive radiance.
// One shared program variant (customProgramCacheKey 'rim'); the rim colour is a per-actor uniform, so turning the
// rim on/off or retinting it per stage never recompiles. A zero colour adds exactly 0.0 to the emissive accumulator.
// Purpose: separate characters from the stage backdrop (complementary rim: cool in the warm shrine, warm in the foundry).
import * as THREE from 'three';

export const RIM_POWER = 3.0;

// per stage and per actor role, linear HDR colour of the rim at grazing angle
export const STAGE_RIM = Object.freeze({
  ford: Object.freeze({ hero: [0, 0, 0], foe: [0, 0, 0] }),
  shrine: Object.freeze({ hero: [0.10, 0.16, 0.34], foe: [0.30, 0.22, 0.60] }),
  road: Object.freeze({ hero: [0.30, 0.20, 0.10], foe: [0.34, 0.46, 0.80] }),
  foundry: Object.freeze({ hero: [0.42, 0.22, 0.08], foe: [0.10, 0.30, 0.42] }),
});

export function makeRimUniform() { return { value: new THREE.Color(0, 0, 0) }; }

export function addRim(material, uRim) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = uRim;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n' +
        '{ float rimF = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);\n' +
        '  totalEmissiveRadiance += uRim * pow(rimF, ' + RIM_POWER.toFixed(1) + '); }');
  };
  material.customProgramCacheKey = () => 'rim';
  material.needsUpdate = true;
  return material;
}

// apply to every standard mesh material under root (materials are shared per model, so each is patched once)
export function addRimToModel(root, uRim) {
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) if (m.isMeshStandardMaterial && !seen.has(m)) { seen.add(m); addRim(m, uRim); }
  });
  return seen.size;
}
