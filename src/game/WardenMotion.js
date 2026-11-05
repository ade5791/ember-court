// v2.18 Shadow Warden attack layer. Presentation only: runs after the clip pose + inertializer on the warden slot,
// adds authored torso channels (pitch / yaw coil / lean) on top of the mocap swing, and fires per-frame FX hooks.
// Never touches the sim, its timing table or the RNG. Frames count from verb start at 60 fps.
//
// Channel keys are [frame, degrees]; every channel starts at 0 on frame 0 and returns to 0 on its last key.
// Easing per segment: segment ending inside STARTUP = easeOutCubic (wind-up), ending inside ACTIVE = easeInQuad
// (strike), anything after = easeOutQuart (recovery settle). Spec: Motion designer frame table (E_SLASH/E_THRUST/
// E_COMBO); C_CHARGED and C_SLAM authored here to the same conventions.
// pitch + = forward bow, yaw + = coil away from the swing (sign learned from the blade tip, like the hero layer),
// lean + = whole-torso forward tilt from the Spine root (hips and feet stay planted, so no foot slide).

import * as THREE from 'three';

const easeOutCubic = (u) => 1 - Math.pow(1 - u, 3);
const easeInQuad = (u) => u * u;
const easeOutQuart = (u) => 1 - Math.pow(1 - u, 4);

// [startupEnd, lastActiveEnd]: segment easing selection
export const WARDEN_MOTION = Object.freeze({
  E_SLASH: { win: [22, 27],
    pitch: [[14, -6], [22, 12], [27, 10], [56, 0]],
    yaw: [[16, 30], [22, -25], [27, -30], [56, 0]],
    lean: [[22, 6], [56, 0]], sway: [[16, -0.10], [22, 0.12], [56, 0]],
    ghost: [22, 27, 2], arcF: 22, puff: [], glint: null, ring: null },
  E_THRUST: { win: [28, 34],
    pitch: [[20, -4], [28, 16], [34, 14], [67, 0]],
    yaw: [[20, 18], [28, -8], [67, 0]],
    lean: [[28, 12], [67, 0]], sway: [[20, -0.20], [28, 0.30], [34, 0.30], [67, 0]],
    ghost: [27, 27, 1], arcF: -1, puff: [28], glint: [28, 28], ring: null },
  E_COMBO: { win: [20, 44],
    pitch: [[12, -5], [20, 10], [30, 4], [37, -4], [39, 14], [44, 12], [79, 0]],
    yaw: [[12, 25], [20, -25], [32, -32], [39, 22], [44, 28], [79, 0]],
    lean: [[20, 5], [39, 9], [79, 0]], sway: [[20, 0.10], [39, 0.20], [79, 0]],
    ghost: [20, 24, 2, 39, 43, 2], arcF: 20, puff: [32], glint: null, ring: null },
  C_CHARGED: { win: [40, 48],
    pitch: [[28, -10], [40, 18], [48, 16], [88, 0]],
    yaw: [[30, 20], [40, -10], [88, 0]],
    lean: [[40, 16], [88, 0]], sway: [[28, -0.25], [40, 0.45], [48, 0.40], [88, 0]],
    ghost: [34, 48, 3], arcF: -1, puff: [40], glint: [40, 40], ring: null },
  C_SLAM: { win: [46, 52],
    pitch: [[34, -16], [46, 24], [52, 22], [102, 0]],
    yaw: [[34, 10], [46, -6], [102, 0]],
    lean: [[46, 18], [102, 0]], sway: [[34, -0.15], [46, 0.25], [102, 0]],
    ghost: [42, 52, 2], arcF: 46, puff: [46], glint: null, ring: 46 },
});

// v2.18 frame review: the spec angles read as near-identical to the bare mocap at gameplay camera distance (the
// warden is ~6 m off, scaled 1.12). One global gain on all three torso channels; timing and easing unchanged.
export const WARDEN_GAIN = 1.5;
const D2R = Math.PI / 180 * WARDEN_GAIN;
function evalChan(keys, f, win) {
  if (!keys || !keys.length || f <= 0) return 0;
  let pf = 0, pv = 0;
  for (let i = 0; i < keys.length; i++) {
    const kf = keys[i][0], kv = keys[i][1];
    if (f <= kf) {
      const u = (f - pf) / Math.max(1e-6, kf - pf);
      const e = kf <= win[0] ? easeOutCubic(u) : kf <= win[1] ? easeInQuad(u) : easeOutQuart(u);
      return pv + (kv - pv) * e;
    }
    pf = kf; pv = kv;
  }
  return 0;
}

const _pq = new THREE.Quaternion(), _rq = new THREE.Quaternion(), _rq2 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0), _lat = new THREE.Vector3(), _tip = new THREE.Vector3(), _p = new THREE.Vector3();
function rotWorld(b, axis, ang) {
  if (!b || !b.parent || Math.abs(ang) < 1e-5) return;
  b.parent.getWorldQuaternion(_pq); _rq.setFromAxisAngle(axis, ang);
  _rq2.copy(_pq).invert().multiply(_rq).multiply(_pq); b.quaternion.premultiply(_rq2);
}

export class WardenMotion {
  constructor({ fx, mistPreset, reducedMotion = false, tint = 0xb89cff, colliders }) {
    this.fx = fx; this.mistPreset = mistPreset; this.reduced = reducedMotion; this.tint = tint; this.colliders = colliders;
    this.sign = {}; this.aid = -1; this.verb = ''; this.lastF = -1; this.acc = 0; this.latPrev = 0; this.learned = false;
    this.applied = 0;       // frames the layer actually drove (QA probe reads this)
    this.peak = 0;          // max |pitch| + |yaw| + |lean| in degrees this verb (QA probe)
  }

  // s: duelist slot (root, bones, sword), d: DuelistSim (elite), alpha: render interpolation, dt: present dt
  apply(s, d, alpha, dt, actorId) {
    const spec = d.state === 2 /* DUEL_STATE.ATTACK */ ? WARDEN_MOTION[d.verb] : null;
    if (!spec || !s.bones) { this.aid = -1; return; }
    const fx_ = d.forwardX(), fz_ = d.forwardZ();
    const id = d.actionId !== undefined ? d.actionId : d.verb + ':' + (d.attackStart || 0);
    if (this.aid !== id || this.verb !== d.verb || d.f < this.lastF) { this.aid = id; this.verb = d.verb; this.lastF = -1; this.acc = 0; this.learned = false; this.peak = 0; this.latPrev = null; }
    const f = d.f + (dt > 0 ? alpha : 0);

    // learn the swing side from the blade tip's lateral travel during the active window (once per verb)
    s.sword.tip.getWorldPosition(_tip);
    const lat = (_tip.x - s.root.position.x) * -fz_ + (_tip.z - s.root.position.z) * fx_;
    if (this.latPrev !== null && d.f >= spec.win[0] && d.f < spec.win[1]) this.acc += lat - this.latPrev;
    this.latPrev = lat;
    if (d.f >= spec.win[1] && !this.learned) { this.learned = true; if (Math.abs(this.acc) > 0.05) this.sign[d.verb] = -Math.sign(this.acc); }
    const ys = this.sign[d.verb] || 1;

    const pitch = evalChan(spec.pitch, f, spec.win) * D2R;
    const yaw = evalChan(spec.yaw, f, spec.win) * D2R * ys;
    const lean = evalChan(spec.lean, f, spec.win) * D2R;
    // sway: presentation-only root drive toward the target (metres, unscaled by the angle gain); <= 0.45 m
    const sway = evalChan(spec.sway, f, spec.win);
    if (sway) { s.root.position.x += fx_ * sway; s.root.position.z += fz_ * sway; }
    this.peak = Math.max(this.peak, (Math.abs(pitch) + Math.abs(yaw) + Math.abs(lean)) * 180 / Math.PI);

    // right-hand lateral axis: + rotation rears back, so forward bow is negative
    _lat.set(-fz_, 0, fx_);
    const B = s.bones;
    rotWorld(B.Spine, _lat, -lean);
    rotWorld(B.Spine, _lat, -pitch * 0.3); rotWorld(B.Spine01, _lat, -pitch * 0.35); rotWorld(B.Spine02, _lat, -pitch * 0.35);
    rotWorld(B.Spine, UP, yaw * 0.3); rotWorld(B.Spine01, UP, yaw * 0.35); rotWorld(B.Spine02, UP, yaw * 0.35);
    rotWorld(B.neck, UP, -yaw * 0.3); rotWorld(B.neck, _lat, (pitch + lean) * 0.35);   // eyes stay on the hero
    this.applied++;

    // FX hooks fire once per integer sim frame
    if (dt <= 0 || d.f === this.lastF) return;
    for (let fr = this.lastF + 1; fr <= d.f; fr++) this._fxFrame(s, d, spec, fr, actorId, fx_, fz_);
    this.lastF = d.f;
  }

  _fxFrame(s, d, spec, fr, actorId, fx_, fz_) {
    const fx = this.fx, g = spec.ghost;
    if (!this.reduced && g) {
      for (let i = 0; i + 2 < g.length; i += 3) if (fr >= g[i] && fr <= g[i + 1] && ((fr - g[i]) % g[i + 2]) === 0) fx.afterimage(actorId, this.tint, 1.0);
    }
    const gy = this.colliders ? this.colliders.terrainY(d.z) : 0;
    if (spec.glint && fr >= spec.glint[0] && fr <= spec.glint[1] && ((fr - spec.glint[0]) % 2) === 0) {
      /* glint flare removed v2.18: read as a stray white star in review */
    }
    for (const pf of spec.puff) if (fr === pf) fx.mist(d.x + fx_ * 0.45, gy + 0.08, d.z + fz_ * 0.45, 0.55, this.mistPreset, this.reduced ? 4 : 10, 0.4);
    if (spec.ring !== null && fr === spec.ring) {
      fx.shockwave(d.x + fx_ * 1.4, gy + 0.22, d.z + fz_ * 1.4, 3.2, this.tint, 1.0, 0.6);
      fx.mist(d.x + fx_ * 1.4, gy + 0.1, d.z + fz_ * 1.4, 1.1, this.mistPreset, this.reduced ? 6 : 16, 0.7);
    }
    if (spec.arcF >= 0 && fr === spec.arcF) { s.sword.tip.getWorldPosition(_p); fx.flare(_p, 0.35, this.tint); }
  }
}
