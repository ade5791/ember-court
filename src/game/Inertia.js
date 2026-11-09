// Inertialization (offset decay) for sim-time-driven poses. Presentation only.
// pose() hard-switches clips on state changes (loco -> swing, swing -> recovery idle, boss verb -> verb). At the
// switch we capture the offset between the last displayed pose and the new target pose, then decay that offset to
// identity over a short window with a smoothstep curve (zero velocity at both ends). The new clip keeps playing
// underneath, so timing is never delayed - only the visible pop is removed.
// Applies only to bones that some clip actually animates (unbound bones carry additive layer edits that the mixer
// never rewrites; offsetting them would compound). Zero allocation per frame.
import * as THREE from 'three';

const _q = new THREE.Quaternion(), _o = new THREE.Quaternion(), _id = new THREE.Quaternion();
const _tv = new Float32Array(3);
// q -> axis*angle * scale into out[k..k+2] (hemisphere-fixed, shortest arc)
function qlog(q, out, k, scale) {
  let x = q.x, y = q.y, z = q.z, w = q.w; if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(x * x + y * y + z * z);
  const f = s < 1e-8 ? 2 : (2 * Math.atan2(s, w)) / s;
  out[k] = x * f * scale; out[k + 1] = y * f * scale; out[k + 2] = z * f * scale;
}
// exp(v[k..k+2] * scale) -> quaternion q
function qexp(v, k, scale, q) {
  const x = v[k] * scale, y = v[k + 1] * scale, z = v[k + 2] * scale, a = Math.sqrt(x * x + y * y + z * z);
  if (a < 1e-8) return q.set(x * 0.5, y * 0.5, z * 0.5, 1).normalize();
  const h = a * 0.5, s = Math.sin(h) / a; return q.set(x * s, y * s, z * s, Math.cos(h));
}

export class Inertializer {
  constructor(model, clips) {
    const animated = new Set();
    for (const c of clips) for (const t of c.tracks) animated.add(t.name.split('.')[0]);
    this.bones = [];
    model.traverse((o) => { if (o.isBone && animated.has(o.name)) this.bones.push(o); });
    const n = this.bones.length;
    this.lastQ = new Float32Array(n * 4); this.lastP = new Float32Array(n * 3);
    this.offQ = new Float32Array(n * 4); this.offP = new Float32Array(n * 3);
    this.rawQ = new Float32Array(n * 4); this.rawP = new Float32Array(n * 3); this.hasRaw = false;
    this.has = false; this.t = 0; this.dur = 0; this.enabled = true;
    this.clip = ''; this.time = 0; this.blends = 0;
    // C16 spring mode (velocity-matched inertialization, Holden-style): offset x (axis-angle / metres) and its
    // velocity v decay with a critically damped spring. Seeded so displayed velocity is continuous across the switch.
    this.mode = 'spring';
    this.prevLQ = new Float32Array(n * 4); this.prevRQ = new Float32Array(n * 4); this.prevLP = new Float32Array(n * 3); this.prevRP = new Float32Array(n * 3);
    this.xR = new Float32Array(n * 3); this.vR = new Float32Array(n * 3); this.xP = new Float32Array(n * 3); this.vP = new Float32Array(n * 3);
    this.oldVR = new Float32Array(n * 3); this.oldVP = new Float32Array(n * 3);
    this.springOn = false; this.seedV = false; this.hl = 0.05; this.hasPrev = false; this.hlScale = 0.3;
    // v2.22 planted-foot clips: the contact-IK bake owns these bones, so the spring offset never touches them while one
    // of plantClips plays (an offset on a planted leg skates the foot). plantMask[i] = 1 for those bone indices.
    this.plantClips = null; this.plantMask = new Uint8Array(n);
  }
  setPlant(clipNames, boneNames) {
    this.plantClips = new Set(clipNames); const s = new Set(boneNames);
    for (let i = 0; i < this.bones.length; i++) this.plantMask[i] = s.has(this.bones[i].name) ? 1 : 0;
  }
  // THREE.PropertyMixer only writes a binding when its mixed value changed since the last write. A held pose
  // (hit-stop, clamped clip end, frozen clip time) is therefore NOT rewritten, and anything layered on top after the
  // mixer (offsets here, additive rotWorld layers) compounds frame over frame. Call restore() before pose(): it puts
  // back the raw mixer output, so a skipped write leaves exactly the value the mixer would have written.
  restore() {
    if (!this.hasRaw) return;
    const B = this.bones, RQ = this.rawQ, RP = this.rawP;
    for (let i = 0; i < B.length; i++) { const j = i * 4, k = i * 3; B[i].quaternion.set(RQ[j], RQ[j + 1], RQ[j + 2], RQ[j + 3]); B[i].position.set(RP[k], RP[k + 1], RP[k + 2]); }
  }
  reset() { this.has = false; this.t = this.dur = 0; this.clip = ''; this.springOn = false; this.seedV = false; this.hasPrev = false; }
  // spring variant of apply(); same call contract.
  // deadline: seconds until the pose must be exact (sword contact). Infinity = none. The half-life is capped so the
  // spring is nearly settled, and the remainder is faded out over the last 0.1 s, reaching exactly zero at contact.
  applySpring(clip, time, loop, dt, durFor, deadline = Infinity) {
    const B = this.bones, n = B.length, LQ = this.lastQ, LP = this.lastP, RQ = this.rawQ, RP = this.rawP;
    const PLQ = this.prevLQ, PRQ = this.prevRQ, PLP = this.prevLP, PRP = this.prevRP, XR = this.xR, VR = this.vR, XP = this.xP, VP = this.vP;
    if (this.hasRaw) { PRQ.set(RQ); PRP.set(RP); }
    for (let i = 0; i < n; i++) { const q = B[i].quaternion, p = B[i].position, j = i * 4, k = i * 3; RQ[j] = q.x; RQ[j + 1] = q.y; RQ[j + 2] = q.z; RQ[j + 3] = q.w; RP[k] = p.x; RP[k + 1] = p.y; RP[k + 2] = p.z; }
    const hadRaw = this.hasRaw; this.hasRaw = true;
    const switched = this.has && (clip !== this.clip || (!loop && time < this.time - 0.05));
    const idt = dt > 1e-6 ? 1 / dt : 0;
    if (switched && this.enabled && dt > 1e-6) {
      const d = durFor(clip, this.clip);
      if (d > 0) {
        // displayed velocity just before the switch (per second), then extrapolate one frame with it
        for (let i = 0; i < n; i++) {
          const j = i * 4, k = i * 3, b = B[i];
          _q.set(LQ[j], LQ[j + 1], LQ[j + 2], LQ[j + 3]).normalize();
          if (this.hasPrev) { _o.set(-PLQ[j], -PLQ[j + 1], -PLQ[j + 2], PLQ[j + 3]).normalize(); _o.premultiply(_q); qlog(_o, this.oldVR, k, idt); }
          else { this.oldVR[k] = this.oldVR[k + 1] = this.oldVR[k + 2] = 0; }
          for (let c = 0; c < 3; c++) this.oldVP[k + c] = this.hasPrev ? (LP[k + c] - PLP[k + c]) * idt : 0;
          // extrapolated source pose e = exp(oldV*dt) * last ; offset x = log(e * inv(target))
          qexp(this.oldVR, k, dt, _o); _o.multiply(_q);
          _q.copy(b.quaternion).normalize().invert(); _o.multiply(_q).normalize();
          qlog(_o, XR, k, 1);
          for (let c = 0; c < 3; c++) XP[k + c] = LP[k + c] + this.oldVP[k + c] * dt - b.position.getComponent(c);
          VR[k] = VR[k + 1] = VR[k + 2] = 0; VP[k] = VP[k + 1] = VP[k + 2] = 0;
        }
        this.hl = Math.max(0.02, d * this.hlScale); this.springOn = true; this.seedV = true; this.blends++;
      }
    } else if (this.springOn && this.seedV && hadRaw) {
      // one frame after the switch the target velocity is known: offset velocity = old displayed vel - target vel
      for (let i = 0; i < n; i++) {
        const j = i * 4, k = i * 3;
        _q.set(RQ[j], RQ[j + 1], RQ[j + 2], RQ[j + 3]).normalize(); _o.set(-PRQ[j], -PRQ[j + 1], -PRQ[j + 2], PRQ[j + 3]).normalize(); _o.premultiply(_q);
        qlog(_o, _tv, 0, idt);
        VR[k] = this.oldVR[k] - _tv[0]; VR[k + 1] = this.oldVR[k + 1] - _tv[1]; VR[k + 2] = this.oldVR[k + 2] - _tv[2];
        for (let c = 0; c < 3; c++) VP[k + c] = this.oldVP[k + c] - (RP[k + c] - PRP[k + c]) * idt;
      }
      this.seedV = false;
    }
    this.clip = clip; this.time = time;
    if (this.springOn && dt > 0) {
      const hl = deadline < Infinity ? Math.min(this.hl, Math.max(0.016, deadline / 3.5)) : this.hl;
      const y = (2 * 0.69314718) / hl, e = Math.exp(-y * dt); let mag = 0;
      for (let m = 0; m < n * 3; m++) {
        let j0 = VR[m] + XR[m] * y; XR[m] = e * (XR[m] + j0 * dt); VR[m] = e * (VR[m] - j0 * y * dt);
        j0 = VP[m] + XP[m] * y; XP[m] = e * (XP[m] + j0 * dt); VP[m] = e * (VP[m] - j0 * y * dt);
        const a = Math.abs(XR[m]) + Math.abs(VR[m]) * 0.02; if (a > mag) mag = a;
      }
      if (mag < 1e-4) this.springOn = false;
    }
    if (this.springOn && deadline <= 0) this.springOn = false;
    if (this.springOn) {
      const u = deadline < 0.1 ? deadline / 0.1 : 1, g = u * u * (3 - 2 * u);
      const PM = this.plantClips && this.plantClips.has(clip) ? this.plantMask : null;
      // These contact-IK clips have an eight-frame unplanted entry. Skipping
      // their legs immediately snapped the old stance into the next step.
      // Settle the offset before the FIRST contact, not after it: all planted
      // samples and sim-owned root curves remain exactly as baked.
      const pu = Math.max(0, Math.min(1, time / (8 / 60)));
      const plantW = 1 - pu * pu * (3 - 2 * pu);
      for (let i = 0; i < n; i++) {
        const w = g * (PM && PM[i] ? plantW : 1);
        if (w <= 0) continue;
        const b = B[i], k = i * 3;
        qexp(XR, k, w, _o); b.quaternion.premultiply(_o);
        b.position.x += XP[k] * w; b.position.y += XP[k + 1] * w; b.position.z += XP[k + 2] * w;
      }
    }
    if (this.has) { PLQ.set(LQ); PLP.set(LP); this.hasPrev = true; }
    for (let i = 0; i < n; i++) {
      const b = B[i], q = b.quaternion, p = b.position, j = i * 4, k = i * 3;
      LQ[j] = q.x; LQ[j + 1] = q.y; LQ[j + 2] = q.z; LQ[j + 3] = q.w; LP[k] = p.x; LP[k + 1] = p.y; LP[k + 2] = p.z;
    }
    this.has = true;
  }
  // Call right after the mixer wrote the target pose and BEFORE additive layers.
  // clip/time: primary clip name and time this frame; loop: whether it wraps. durFor(newClip, oldClip) -> seconds.
  apply(clip, time, loop, dt, durFor, deadline = Infinity) {
    if (this.mode === 'spring') return this.applySpring(clip, time, loop, dt, durFor, deadline);
    const B = this.bones, n = B.length, LQ = this.lastQ, LP = this.lastP, OQ = this.offQ, OP = this.offP, RQ = this.rawQ, RP = this.rawP;
    for (let i = 0; i < n; i++) { const q = B[i].quaternion, p = B[i].position, j = i * 4, k = i * 3; RQ[j] = q.x; RQ[j + 1] = q.y; RQ[j + 2] = q.z; RQ[j + 3] = q.w; RP[k] = p.x; RP[k + 1] = p.y; RP[k + 2] = p.z; }
    this.hasRaw = true;
    const switched = this.has && (clip !== this.clip || (!loop && time < this.time - 0.05));
    if (switched && this.enabled) {
      const d = durFor(clip, this.clip);
      if (d > 0) {
        for (let i = 0; i < n; i++) {
          const b = B[i], q = b.quaternion, j = i * 4, k = i * 3;
          // three's invert() is a conjugate (unit-only); some rig helper bones carry non-unit values, so normalise
          // both sides - the offset is always a pure rotation and premultiplying it preserves the bone's magnitude
          _q.set(LQ[j], LQ[j + 1], LQ[j + 2], LQ[j + 3]).normalize();
          _o.copy(q).normalize().invert(); _o.premultiply(_q).normalize();   // off = last * inv(target)
          if (_o.w < 0) { _o.x = -_o.x; _o.y = -_o.y; _o.z = -_o.z; _o.w = -_o.w; }
          OQ[j] = _o.x; OQ[j + 1] = _o.y; OQ[j + 2] = _o.z; OQ[j + 3] = _o.w;
          OP[k] = LP[k] - b.position.x; OP[k + 1] = LP[k + 1] - b.position.y; OP[k + 2] = LP[k + 2] - b.position.z;
        }
        this.t = 0; this.dur = d; this.blends++;
      }
    }
    this.clip = clip; this.time = time;
    if (this.t < this.dur) {
      this.t += dt;
      const u = Math.min(1, this.t / this.dur), w = 1 - u * u * (3 - 2 * u);
      if (w > 1e-4) {
        for (let i = 0; i < n; i++) {
          const b = B[i], j = i * 4, k = i * 3;
          _o.set(OQ[j], OQ[j + 1], OQ[j + 2], OQ[j + 3]);
          _q.slerpQuaternions(_id, _o, w);
          b.quaternion.premultiply(_q);
          b.position.x += OP[k] * w; b.position.y += OP[k + 1] * w; b.position.z += OP[k + 2] * w;
        }
      } else this.dur = 0;
    }
    for (let i = 0; i < n; i++) {
      const b = B[i], q = b.quaternion, p = b.position, j = i * 4, k = i * 3;
      LQ[j] = q.x; LQ[j + 1] = q.y; LQ[j + 2] = q.z; LQ[j + 3] = q.w; LP[k] = p.x; LP[k + 1] = p.y; LP[k + 2] = p.z;
    }
    this.has = true;
  }
}

// Pose-jerk meter (QA): max per-bone local rotation change between consecutive displayed frames (after all layers).
export class PoseJerk {
  constructor(bones) {
    this.bones = bones; this.prev = new Float32Array(bones.length * 4); this.has = false;
    this.samples = new Float32Array(20000); this.n = 0; this.who = {};
    // C16: angular acceleration = change of the per-frame delta rotation (velocity kinks; 30 Hz linear keys kink every 2 frames)
    this.prevD = new Float32Array(bones.length * 4); this.hasD = false; this.acc = new Float32Array(20000); this.na = 0;
  }
  sample() {
    const B = this.bones, P = this.prev; let mx = 0, mb = '', ma = 0;
    for (let i = 0; i < B.length; i++) {
      const q = _q.copy(B[i].quaternion).normalize(), j = i * 4;
      if (this.has) {
        const dot = Math.min(1, Math.abs(q.x * P[j] + q.y * P[j + 1] + q.z * P[j + 2] + q.w * P[j + 3])); const a = 2 * Math.acos(dot); if (a > mx) { mx = a; mb = B[i].name; }
        // delta d = q * inv(prev), hemisphere-fixed; accel = angle between this d and last d
        _o.set(-P[j], -P[j + 1], -P[j + 2], P[j + 3]); _o.premultiply(q); if (_o.w < 0) { _o.x = -_o.x; _o.y = -_o.y; _o.z = -_o.z; _o.w = -_o.w; }
        const D = this.prevD;
        if (this.hasD) { const dd = Math.min(1, Math.abs(_o.x * D[j] + _o.y * D[j + 1] + _o.z * D[j + 2] + _o.w * D[j + 3])); const ac = 2 * Math.acos(dd); if (ac > ma) { ma = ac; this.accBone = B[i].name; } }
        D[j] = _o.x; D[j + 1] = _o.y; D[j + 2] = _o.z; D[j + 3] = _o.w;
      }
      P[j] = q.x; P[j + 1] = q.y; P[j + 2] = q.z; P[j + 3] = q.w;
    }
    if (this.hasD && this.na < this.acc.length) this.acc[this.na++] = ma;
    if (this.has) this.hasD = true;
    if (this.has && this.n < this.samples.length) { this.samples[this.n++] = mx; if (mx > 0.35) this.who[mb] = (this.who[mb] || 0) + 1; }
    this.has = true;
  }
  reset() { this.n = 0; this.has = false; this.who = {}; this.hasD = false; this.na = 0; }
  report() {
    const a = Array.from(this.samples.subarray(0, this.n)).sort((x, y) => x - y), q = (p) => a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(3) : 0;
    const c = Array.from(this.acc.subarray(0, this.na)).sort((x, y) => x - y), qa = (p) => c.length ? +c[Math.min(c.length - 1, Math.floor(c.length * p))].toFixed(3) : 0;
    return { n: a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: a.length ? +a[a.length - 1].toFixed(3) : 0, pops: a.filter((x) => x > 0.35).length, who: this.who,
      acc: { p50: qa(0.5), p95: qa(0.95), p99: qa(0.99), kinks: c.filter((x) => x > 0.15).length } };
  }
}
