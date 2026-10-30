// World subsystem - Crimson Ford arena (ARCHITECTURE.md section 1 'src/world/', CINEMATIC_SPEC section 6).
// Loads the Blender-exported blockout GLB and the collider document, applies texture filtering from the quality
// preset, makes the stone lanterns emissive, adds the river water shader and owns the 4 fixed point-light slots
// (lights are never added/removed/toggled visible after init; dark slots get intensity 0 - section 8).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Colliders } from './Colliders.js';
import { Water } from './Water.js';

export const WORLD_ASSETS = Object.freeze({
  glb: '/assets/court-blockout.v3.glb',
  colliders: '/assets/court-colliders.v3.json',
});
const LANTERN_COLOR = 0xffa45a;
const LANTERN_INTENSITY = 6.0;     // candela-ish at physicallyCorrect units; tuned against the no-post baseline
const LANTERN_DISTANCE = 9.0;

export class World {
  static id = 'world';
  static deps = ['render'];

  async init(ctx, opts = {}) {
    this.disposed = false;
    this.ctx = ctx;
    const scene = this.scene = opts.scene;
    const renderer = opts.renderer;
    const quality = opts.quality;
    const base = opts.base || '';
    const [doc, gltf] = await Promise.all([
      fetch(base + WORLD_ASSETS.colliders).then((r) => { if (!r.ok) throw new Error('colliders ' + r.status); return r.json(); }),
      new GLTFLoader().loadAsync(base + WORLD_ASSETS.glb),
    ]);
    if (this.disposed) { disposeTree(gltf.scene); return; }
    this.colliders = new Colliders(doc);
    if (this.colliders.stage !== 'ford-32m') throw new Error('World: unexpected collider stage ' + this.colliders.stage);

    // texture filtering: anisotropy from the preset, clamped to the device (stops the floor shimmering at grazing angles)
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.anisotropy = Math.min(quality.anisotropy, maxAniso);
    const texSet = new Set(), matSet = new Set();
    this.root = gltf.scene;
    this.root.name = 'ford_arena';
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        matSet.add(m);
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
          const t = m[k]; if (!t) continue;
          texSet.add(t);
          t.anisotropy = this.anisotropy;
          t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
        }
        if (m.name === 'blk_lantern_glow') {
          m.emissive = new THREE.Color(LANTERN_COLOR); m.emissiveIntensity = 2.2; m.toneMapped = true;
        }
        if (m.alphaTest > 0 || m.name === 'ford_leaf' || m.name === 'ford_cloth') { m.side = THREE.DoubleSide; m.alphaToCoverage = false; }
      }
      // Casters: everything inside or bounding the 32 m floor, including canopies (alphaTest leaf cards cast through
      // three's alpha-aware depth material) and the bd_ perimeter walls - excluding them left only trunks and small
      // props casting, so the frame read as unshadowed (measured 0.8-1.8% of pixels changed by shadows). Only the far
      // backdrop (far_, cliff_, pagoda) and cloth strips stay non-casting.
      const backdrop = /^(bd_|far_|cliff_|pagoda)/.test(o.name);
      o.castShadow = !/^(far_|cliff_|pagoda)|^cloth|^prayer/.test(o.name);
      o.receiveShadow = true;
      if (backdrop) o.matrixAutoUpdate = false;
    });
    this.textures = texSet; this.materials = matSet;
    scene.add(this.root);

    // river water: band |z| < riverHalfZ across the arena, surface at waterTop
    const f = doc.ford;
    this.water = new Water({ halfX: doc.arena.half - 0.3, halfZ: f.riverHalfZ, y: f.waterTop, flowDir: f.flowDir,
      reflectionScale: quality.waterReflection ?? 0 });
    scene.add(this.water.mesh);

    // 4 fixed lantern light slots (constant visible light count)
    this.lights = [];
    for (const p of f.lightSlots) {
      const L = new THREE.PointLight(LANTERN_COLOR, LANTERN_INTENSITY, LANTERN_DISTANCE, 2);
      L.position.set(p[0], p[1], p[2]); L.castShadow = false; L.name = 'lantern_slot_' + this.lights.length;
      scene.add(L); this.lights.push(L);
    }
    this.stats = { meshes: 0, textures: texSet.size, materials: matSet.size, colliders: this.colliders.count,
      anisotropy: this.anisotropy, maxAnisotropy: maxAniso, lights: this.lights.length };
    this.root.traverse((o) => { if (o.isMesh) this.stats.meshes++; });
    return this;
  }

  setLantern(i, on) { this.lights[i].intensity = on ? LANTERN_INTENSITY : 0; }

  update(t) { if (this.water) this.water.setTime(t); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.root) { this.scene.remove(this.root); disposeTree(this.root); }
    if (this.water) this.water.dispose();
    for (const L of this.lights || []) { this.scene.remove(L); L.dispose(); }
    this.lights = [];
  }
}

function disposeTree(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
      m.dispose();
    }
  });
}
