// GauntletView - presentation of the Stage 3 boss "Chrome Gauntlet" (Frost Predator mesh, CC BY 4.0).
// Owner: game. Reads GauntletBrain state (anim, verb, f, hazards) and never writes back.
// - Sim clip names -> source clips through per-verb time-warp knots (sim frame -> clip frame, 60 Hz), so the
//   authored strike lands on the sim active window. Measured with tools/boss/gauntlet-probe.py.
// - sweep_l plays the head sweep mirrored (pivot scale.x < 0; three flips front faces on a negative determinant).
// - Chrome blades: head crest + two forepaw blades, sockets computed once from the rest pose (scale-compensated).
// - Hazards: fixed pools (3 lightning columns + markers, 1 dome, 1 slam ring); all built at load so the prewarm
//   compiles them and nothing allocates mid-fight.
import * as THREE from 'three';
import { GAUNTLET } from '../shared/constants.js';
import { GauntletVerb as GV } from '../shared/enums.js';

export const GAUNTLET_ID = 200;
// Measured (gauntlet-probe.json): rest 1.68 m tall, 7.06 m nose-to-tail, faces +Z, head 2.81 m ahead of bbox centre.
// Scale 1.6 -> 2.7 m tall at the shoulder line, sweep reach 5.2 m lands inside the head arc.
export const GAUNTLET_VIEW = Object.freeze({ SCALE: 1.6 });

// Clip-frame anchors per sim clip: c0 = clip frame at f0, cs/ce = clip frames that cover the sim active window,
// cend = clip frame at d.total. The def can belong to the NEXT verb for one frame on an enraged chain (slam ->
// lightning switches def before anim.clip), so 'pre' must tolerate a missing field. Optional 'pre' = [simFrameFn, clipFrame] knot (lunge travel start / slam leap).
// Strike frames measured: g_swipe head crosses centre f30-40, g_pounce head peak f32-42, g_rear lands f62,
// g_roar head to the sky f88-96. Built from the LIVE verb def so enrage (shifted startups) and the fast chained
// sweep stay frame-aligned with contact.
const WARP = {
  sweep_r: { src: 'g_swipe', c0: 0, cs: 30, ce: 40, cend: 75 },
  sweep_l: { src: 'g_swipe', c0: 0, cs: 30, ce: 40, cend: 75, mirror: true },
  sweep_chain: { src: 'g_swipe', c0: 14, cs: 30, ce: 40, cend: 75 },
  lunge: { src: 'g_pounce', c0: 0, cs: 32, ce: 42, cend: 81, pre: [(d) => (d.travel ? d.travel[0] : -1), 14] },
  rear_slam: { src: 'g_rear', c0: 0, cs: 62, ce: 70, cend: 156, pre: [(d) => (d.leap ? d.leap[0] : -1), 30] },
  summon: { src: 'g_roar', c0: 0, cs: 90, ce: 98, cend: 174 },
  dome: { src: 'g_roar', c0: 0, cs: 90, ce: 100, cend: 174 },
  tail: { src: 'g_swipe', c0: 20, cs: 46, ce: 56, cend: 75 },
  roar: { src: 'g_roar', c0: 10, cs: 88, ce: 92, cend: 174 },
};
function knots(W, d, out) {
  out.length = 0; out.push([0, W.c0]);
  if (W.pre && d) { const pf = W.pre[0](d); if (pf > 0 && pf < d.active[0]) out.push([pf, W.pre[1]]); }
  const a0 = d ? d.active[0] : 30, a1 = d ? d.active[1] : 38, tot = d ? d.total : 78;
  out.push([a0, W.cs], [Math.max(a0 + 1, a1), W.ce], [Math.max(a1 + 2, tot), W.cend]);
  return out;
}
const ROAR_DEF = Object.freeze({ active: [20, 20], total: 83 });   // the roar runs in its own ROAR state
const LOOPS = { idle: 'g_idle', walk: 'g_walk', down: 'g_rest', hit: 'g_rest', death: 'g_rest' };

function warp(k, f) {
  if (f <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (f <= k[i][0]) { const a = k[i - 1], b = k[i]; return a[1] + (b[1] - a[1]) * (f - a[0]) / (b[0] - a[0]); }
  return k[k.length - 1][1];
}

// Pure chrome mirrors the night PMREM and goes black; a faint cold emissive keeps the blades the brightest
// thing on the silhouette (they are the boss's identity and its attack read).
// Frame review (3 passes): metalness 1 in the night foundry mirrors navy and reads as more blue hide. Bright
// polished steel with a cold self-lit core is what separates the blades from the body at the 7.5 m boom.
const chrome = () => new THREE.MeshStandardMaterial({ color: 0xf4f7fb, metalness: 0.75, roughness: 0.2, envMapIntensity: 2.0, emissive: 0x8fa6c8, emissiveIntensity: 0.55 });
function bladeGeo(len, wid, th) {
  // tapered blade along +Y from 0 to len: a 6-vertex diamond prism
  const g = new THREE.BufferGeometry();
  const p = [0, 0, 0, wid, len * 0.22, 0, 0, len, 0, -wid, len * 0.22, 0, 0, len * 0.2, th, 0, len * 0.2, -th];
  const idx = [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4, 1, 0, 5, 2, 1, 5, 3, 2, 5, 0, 3, 5];
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export class GauntletView {
  build({ gltf, scene, Inertializer, inertOpts = {} }) {
    const V = GAUNTLET_VIEW;
    this.root = new THREE.Group(); this.root.name = 'gauntlet_root';
    this.pivot = new THREE.Group(); this.pivot.rotation.y = Math.PI;
    this.model = gltf.scene;
    this.root.add(this.pivot); this.pivot.add(this.model); scene.add(this.root);
    this.pivot.scale.setScalar(V.SCALE);
    this.bones = {}; this.mats = new Set();
    this.model.traverse((o) => {
      if (o.isBone) this.bones[o.name] = o;
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; for (const m of [].concat(o.material)) this.mats.add(m); }
    });
    for (const m of this.mats) { if (!m.emissive) continue; m.userData.em0 = m.emissive.clone(); }
    const pick = (re) => { for (const k in this.bones) if (re.test(k)) return this.bones[k]; return null; };
    this.HEAD = pick(/^head_\d/); this.CHEST = pick(/^DEF-spine004_/); this.HIPS = pick(/^DEF-spine_0/);
    // Rigify on a quadruped: the "foot" chain is the FRONT leg and the "hand"/finger chain is the hind leg
    // (measured: footL001 1.76 m ahead of the root, handL -2.03 m). Blades go on the front feet.
    this.PAW_L = pick(/^DEF-footL001_/); this.PAW_R = pick(/^DEF-footR001_/); this.TAIL = pick(/^DEF-tail004_/);
    for (const [n, b] of Object.entries({ head: this.HEAD, chest: this.CHEST, hips: this.HIPS, pawL: this.PAW_L, pawR: this.PAW_R, tail: this.TAIL }))
      if (!b) throw new Error('gauntlet socket bone missing: ' + n);
    // rest-pose placement: hips-chest midpoint over the sim root (the BODY_RADIUS capsule centre), lowest deform
    // bone on the ground. Measured in pivot space so it is independent of where the root is.
    {
      this.root.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(this.pivot.matrixWorld).invert(), w = new THREE.Vector3();
      const loc = (b) => w.setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv).clone();
      const hp = loc(this.HIPS), cp = loc(this.CHEST);
      let minY = Infinity; for (const k in this.bones) if (/^DEF-/.test(k)) minY = Math.min(minY, loc(this.bones[k]).y);
      this.model.position.set(-(hp.x + cp.x) / 2, -minY, -(hp.z + cp.z) / 2);
      this.root.updateMatrixWorld(true);
      const hd = w.setFromMatrixPosition(this.HEAD.matrixWorld);
      this.headAhead = +(-hd.z).toFixed(2);                                     // metres ahead of the root (root faces -Z)
    }
    // mixer: every clip bound once, weights driven from sim time (no mixer clock)
    this.mixer = new THREE.AnimationMixer(this.model); this.actions = {}; this.on = [];
    for (const c of gltf.animations) { const a = this.mixer.clipAction(c); a.timeScale = 0; a.play(); a.setEffectiveWeight(0); this.actions[c.name] = a; }
    for (const k of new Set([...Object.values(LOOPS), ...Object.values(WARP).map((w) => w.src)]))
      if (!this.actions[k]) throw new Error('gauntlet clip missing: ' + k);
    this.inert = Inertializer ? new Inertializer(this.model, gltf.animations) : null;
    if (this.inert) Object.assign(this.inert, inertOpts);
    // ---- chrome blades from the rest pose
    this._pose('g_idle', 0); this.root.updateMatrixWorld(true);
    // put the drawn head on the sim's head hurt point (GAUNTLET.HEAD_AHEAD): the hit test is authoritative and the
    // visual follows it. Root faces -Z at build; pivot is rotated PI, so world -Z is pivot +Z (scaled by SCALE).
    {
      const hw = new THREE.Vector3().setFromMatrixPosition(this.HEAD.matrixWorld);
      const shift = GAUNTLET.HEAD_AHEAD - (-hw.z);
      this.model.position.z += shift / V.SCALE; this.root.updateMatrixWorld(true);
      this.headAhead = +(-new THREE.Vector3().setFromMatrixPosition(this.HEAD.matrixWorld).z).toFixed(2);
      this.headShift = +shift.toFixed(2);
    }
    this.bladeMat = chrome();
    this.edgeMat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.model.getWorldQuaternion(new THREE.Quaternion()));
    // Sized to read at the 7.5 m gameplay boom (frame review: 1 m blades vanished into the claws).
    this.crest = this._blade(this.HEAD, fwd.clone().add(new THREE.Vector3(0, 0.34, 0)).normalize(), 2.1, 0.36, 0.08, [0, 0.22, 0.05]);
    const pawDir = fwd.clone().multiplyScalar(0.95).add(new THREE.Vector3(0, -0.12, 0)).normalize();
    this.bladeL = this._blade(this.PAW_L, pawDir, 1.65, 0.24, 0.06, [0, 0.04, 0]);
    this.bladeR = this._blade(this.PAW_R, pawDir, 1.65, 0.24, 0.06, [0, 0.04, 0]);
    // fresnel rim on the creature skin: separates the blue body from the navy foundry without a new light
    // (light count is in every program key). Patched once at build, so the prewarm compiles the final variant.
    this.rim = { value: new THREE.Vector4(0.62, 0.80, 1.00, 0.55) };   // rgb, strength (frame review: 0.85 at pow 3 washed the whole body)
    for (const m of this.mats) {
      if (m === this.bladeMat || m === this.edgeMat || !m.isMeshStandardMaterial) continue;
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uRim = this.rim;
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec4 uRim;')
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{ float fr = smoothstep(0.72, 0.98, 1.0 - abs(dot(nonPerturbedNormal, normalize(-vViewPosition))));
  totalEmissiveRadiance += uRim.rgb * uRim.a * fr; }`);
      };
      const pk = m.customProgramCacheKey;
      m.customProgramCacheKey = () => (pk ? pk.call(m) : '') + '|gRim';
      m.needsUpdate = true;
    }
    // ---- hazards
    const colGeo = new THREE.CylinderGeometry(1, 1, 14, 24, 1, true); colGeo.translate(0, 7, 0);
    const ringGeo = new THREE.RingGeometry(0.86, 1, 48); ringGeo.rotateX(-Math.PI / 2);
    this.colMat = []; this.cols = []; this.markers = [];
    for (let i = 0; i < 3; i++) {
      const cm = new THREE.MeshBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
      const c = new THREE.Mesh(colGeo, cm); c.visible = false; c.renderOrder = 6; scene.add(c);
      const mm = new THREE.MeshBasicMaterial({ color: 0x6fc8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const m = new THREE.Mesh(ringGeo, mm); m.visible = false; m.renderOrder = 3; scene.add(m);
      this.cols.push(c); this.markers.push(m); this.colMat.push(cm);
    }
    this.domeMat = new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), this.domeMat); this.dome.visible = false; this.dome.renderOrder = 6; scene.add(this.dome);
    this.waveMat = new THREE.MeshBasicMaterial({ color: 0xffb070, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.wave = new THREE.Mesh(ringGeo, this.waveMat); this.wave.visible = false; this.wave.renderOrder = 3; scene.add(this.wave);
    this.react = { t: 9, amp: 0, flash: 0, dx: 0, dz: 0 };
    this.prev = { x: 0, y: 0, z: 0, yaw: 0 };
    this.seen = { wave: false, cols: [-1, -1, -1], struck: [-1, -1, -1], actionId: -1, dome: false };
    this.root.visible = false;
    this._pose('g_idle', 0);
    return this;
  }

  _blade(bone, dirWorld, len, wid, th, off) {
    const bq = bone.getWorldQuaternion(new THREE.Quaternion()), bs = new THREE.Vector3();
    bone.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), bs);
    const socket = new THREE.Group();
    socket.quaternion.copy(bq).invert().multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirWorld));
    socket.scale.setScalar(1 / (bs.x || 1));
    const offW = new THREE.Vector3().fromArray(off).applyQuaternion(bq.clone().invert());
    socket.position.copy(offW).multiplyScalar(1 / (bs.x || 1));
    bone.add(socket);
    const blade = new THREE.Mesh(bladeGeo(len, wid, th), this.bladeMat); blade.castShadow = true;
    const edge = new THREE.Mesh(bladeGeo(len * 1.02, wid * 0.35, th * 0.4), this.edgeMat); edge.position.z = 0.002; edge.renderOrder = 5;
    socket.add(blade, edge);
    const tip = new THREE.Object3D(); tip.position.y = len; socket.add(tip);
    const base = new THREE.Object3D(); base.position.y = len * 0.15; socket.add(base);
    return { socket, blade, edge, tip, base };
  }

  _pose(clip, t, w1 = 0, clip2 = null, t2 = 0) {
    if (this.inert) this.inert.restore();
    for (const a of this.on) a.setEffectiveWeight(0);
    this.on.length = 0;
    const set = (c, w, tt) => { const a = this.actions[c]; if (!a || w <= 0) return; const d = Math.max(1e-3, a.getClip().duration); a.time = Math.min(d - 1e-3, Math.max(0, tt)); a.setEffectiveWeight(w); this.on.push(a); };
    set(clip, 1 - w1, t); if (clip2) set(clip2, w1, t2);
    this.mixer.update(0);
    this.pc = clip; this.pt = t;
  }

  // Which source clip/time the sim state maps to this frame.
  _sample(G, simFrame) {
    const a = G.anim, out = this._s || (this._s = { clip: 'g_idle', t: 0, loop: true, mirror: false });
    out.mirror = false;
    const L = LOOPS[a.clip];
    if (L) {
      const d = this.actions[L].getClip().duration;
      out.clip = L; out.loop = a.clip === 'idle' || a.clip === 'walk' || a.clip === 'down';
      out.t = a.clip === 'idle' ? (simFrame / 60) % d : a.clip === 'walk' ? (simFrame / 60 * 1.05) % d
        : a.clip === 'hit' ? Math.min(d * 0.5, a.time * 0.9) : a.clip === 'death' ? Math.min(d - 0.01, a.time) : (a.time % d);
      return out;
    }
    let key = a.clip;
    if (key === 'sweep_r' && G.chain === GV.G_SWEEP_L) key = 'sweep_chain';
    const W = WARP[key];
    if (!W) { out.clip = 'g_idle'; out.t = 0; out.loop = true; return out; }
    const d = a.clip === 'roar' ? null : G.def;
    const k = knots(W, a.clip === 'roar' ? ROAR_DEF : d, this._k || (this._k = []));
    out.clip = W.src; out.loop = false; out.t = warp(k, a.time * 60) / 60; out.mirror = !!W.mirror;
    return out;
  }

  // alpha: render interpolation; dt: presentation delta (0 while paused/prewarm); terrainY(z)
  update(G, simFrame, alpha, dt, terrainY, blendFn) {
    const P = this.prev;
    const z = P.z + (G.z - P.z) * alpha;
    this.root.position.set(P.x + (G.x - P.x) * alpha, P.y + (G.y - P.y) * alpha + terrainY(z), z);
    let dy = G.yaw - P.yaw; dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
    this.root.rotation.y = P.yaw + dy * alpha;
    const s = this._sample(G, simFrame);
    this.pivot.scale.x = s.mirror ? -GAUNTLET_VIEW.SCALE : GAUNTLET_VIEW.SCALE;
    this._pose(s.clip, s.t);
    if (this.inert) this.inert.apply(this.pc, this.pt, s.loop, dt, blendFn);
    // tail verb: a body twist sells the rear sweep (the source has no dedicated tail attack)
    let twist = 0;
    if (G.anim.clip === 'tail') { const f = G.anim.time * 60; twist = Math.sin(Math.min(1, Math.max(0, (f - 10) / 30)) * Math.PI) * 0.75; }
    // death: settle and sink a little; hit reaction recoil
    const R = this.react; R.t += dt;
    const rk = R.t < 0.35 ? Math.sin(R.t / 0.35 * Math.PI) * R.amp : 0;
    this.pivot.rotation.set(-0.08 * rk, Math.PI + twist, 0);
    this.pivot.position.set(R.dx * 0.12 * rk, G.state === 5 ? -Math.min(0.5, G.f / 180) : 0, R.dz * 0.12 * rk);
    // emissive: enrage glow + hit flash (uniform values only, never a program change)
    R.flash = Math.max(0, R.flash - dt * 4);
    const pulse = G.phase >= 2 ? 0.18 + 0.1 * Math.sin(simFrame * 0.12) : 0;
    for (const m of this.mats) {
      if (!m.emissive) continue;
      m.emissive.copy(m.userData.em0).add(this._tint || (this._tint = new THREE.Color()).setRGB(0.9 * pulse + R.flash * 0.6, 0.12 * pulse + R.flash * 0.6, 0.06 * pulse + R.flash * 0.6));
    }
    this.edgeMat.color.setHex(G.phase >= 2 ? 0xff6a4a : 0x9fe8ff);
    this.edgeMat.opacity = 0.7 + 0.3 * (G.state === 1 && G.def && G.anim.time * 60 >= G.def.active[0] - 10 && G.anim.time * 60 <= G.def.active[1] ? 1 : 0);
  }

  hit(dx, dz, amp) { const R = this.react; R.t = 0; R.amp = Math.min(1.4, R.amp * 0.4 + amp); R.flash = Math.min(1, R.flash + 0.6); R.dx = dx; R.dz = dz; }

  // Hazards are read straight from the sim each frame (positions/radii are authoritative); fx calls fire once per
  // hazard instance id. Returns nothing; uses fx/cam via the callbacks object.
  hazards(G, simFrame, dt, terrainY, cb) {
    const S = this.seen;
    for (let i = 0; i < 3; i++) {
      const c = G.cols[i], col = this.cols[i], mk = this.markers[i], cm = this.colMat[i];
      const live = c.left > 0;
      mk.visible = live && simFrame < c.at; col.visible = live && simFrame >= c.at;
      if (mk.visible) {
        const u = 1 - (c.at - simFrame) / Math.max(1, c.def.cols.lead);
        mk.position.set(c.x, terrainY(c.z) + 0.05, c.z); mk.scale.setScalar(c.def.reach * (1.35 - 0.35 * u));
        mk.material.opacity = 0.25 + 0.65 * u * (0.7 + 0.3 * Math.sin(simFrame * 0.8));
      }
      if (col.visible) {
        const k = (simFrame - c.at) / c.def.cols.len;
        col.position.set(c.x, terrainY(c.z), c.z); col.scale.set(c.def.reach * (0.55 + 0.6 * k), 1, c.def.reach * (0.55 + 0.6 * k));
        cm.opacity = Math.max(0, 0.95 * (1 - k)); cm.color.setHex(k < 0.3 ? 0xffffff : 0xa8dcff);
        if (S.struck[i] !== c.id) { S.struck[i] = c.id; cb.strike(c.x, terrainY(c.z), c.z); }
      }
    }
    const D = G.dome;
    this.dome.visible = D.active && D.r > 0.05;
    if (this.dome.visible) { this.dome.position.set(G.x, terrainY(G.z), G.z); this.dome.scale.setScalar(D.r); this.domeMat.opacity = 0.35 + 0.25 * Math.sin(simFrame * 0.9); }
    if (D.active && !S.dome) cb.dome(G.x, terrainY(G.z), G.z);
    S.dome = D.active;
    const W = G.wave;
    this.wave.visible = W.active;
    if (W.active) {
      this.wave.position.set(W.x, terrainY(W.z) + 0.08, W.z); this.wave.scale.setScalar(W.r);
      this.waveMat.opacity = 0.8 * (1 - (W.r - W.def.wave.r0) / (W.def.wave.r1 - W.def.wave.r0));
      if (!S.wave) cb.slam(W.x, terrainY(W.z), W.z);
    }
    S.wave = W.active;
  }

  // every pooled mesh visible once (prewarm compiles their programs)
  prewarmShow(on) {
    for (const m of [...this.cols, ...this.markers, this.dome, this.wave]) m.visible = on;
    this.root.visible = on || this.root.visible;
  }

  hideHazards() { for (const m of [...this.cols, ...this.markers, this.dome, this.wave]) m.visible = false; }
}
