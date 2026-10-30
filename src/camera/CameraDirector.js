// CameraDirector - third-person shot grammar (CINEMATIC_SPEC sections 3 and 9.6). Presentation only: it reads actor
// poses and listens to events, it never feeds the simulation. Built on the GameBlocks BaseCameraRig
// (src/gameblocks/modules/camera) for pose state and exponential smoothing; one blend per shot handoff.
//
// Shots: EXPLORE, DUEL, BOSS_GROUND, BOSS_AIR (base), plus additive layers IMPACT (FOV kick + trauma shake),
// DEFLECT (push-in), PHANTOM (FOV +4 + desat amount for the grade), PHASE (push-in on the boss roar).
// C5: after composing the pose, the boom is shortened until the camera keeps >= 0.25 m from every collider, wall
// and the ground, then hard-clamped to the 9.6 limits. Allocation-free per frame; shake noise is a hash of the
// presentation clock (no Math.random).
import * as THREE from 'three';
import { BaseCameraRig } from '../gameblocks/modules/camera/BaseCameraRig.js';
import { smoothingAlpha, clamp } from '../gameblocks/modules/math/ScalarUtils.js';
import { Outcome } from '../shared/enums.js';

export const SHOT = Object.freeze({ EXPLORE: 0, DUEL: 1, BOSS_GROUND: 2, BOSS_AIR: 3 });
export const SHOT_NAMES = Object.freeze(['EXPLORE', 'DUEL', 'BOSS_GROUND', 'BOSS_AIR']);

// boom = distance behind the hero, height = pivot height above hero feet, fov in degrees, blend = handoff seconds
const BASE = [
  { boom: 4.6, height: 1.75, fov: 55, pitch: -0.06, blend: 1.5, side: 0.0 },
  { boom: 3.7, height: 1.55, fov: 52, pitch: -0.14, blend: 0.6, side: 0.55 },
  { boom: 7.5, height: 2.4, fov: 55, pitch: -0.10, blend: 0.6, side: 0.9 },
  { boom: 9.5, height: 2.8, fov: 58, pitch: 0.0, blend: 0.8, side: 0.6 },
];

export const CAMERA_LIMITS = Object.freeze({
  margin: 0.25, wallTop: 1.12, innerClamp: 15.75, outerClamp: 20.65, ceiling: 10.75, pitchMaxAir: 0.70,
});

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _pivot = new THREE.Vector3(), _desired = new THREE.Vector3();
const _look = new THREE.Vector3(), _toT = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

function hash1(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; }
function noise1(t, seed) { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return hash1(i + seed) * (1 - u) + hash1(i + 1 + seed) * u; }

export class CameraDirector extends BaseCameraRig {
  static id = 'camera';
  static deps = ['world'];

  constructor() { super({}); this.shot = SHOT.EXPLORE; }

  init(ctx, { camera, colliders, reducedMotion = false }) {
    this.ctx = ctx; this.camera = camera; this.colliders = colliders; this.reducedMotion = reducedMotion;
    this.hero = null;             // { position: Vector3, yaw }
    this.target = null;           // { position: Vector3 (lock point), airborne: bool } or null
    this.lockOn = false;
    this.shot = SHOT.EXPLORE; this.prevShot = SHOT.EXPLORE;
    this.blendT = 1; this.blendDur = 1;
    // current smoothed rig params (blend between shots happens on these scalars, not on positions)
    this.cur = { boom: BASE[0].boom, height: BASE[0].height, fov: BASE[0].fov, pitch: BASE[0].pitch, side: 0 };
    this.orbitYaw = 0;            // player look yaw around the hero
    this.orbitPitch = 0;
    this.trauma = 0; this.kick = 0; this.kickT = 0;
    this.push = 0; this.pushT = 0; this.pushIn = 0.12; this.pushOut = 0.5; this.pushDist = 0;
    this.phantom = 0; this.phantomT = 0;     // 0..1 amount, read by the grade for the cool desat
    this.clock = 0;
    this.minClearance = Infinity; // running C5 stat (harness reads and resets)
    this.lastClearance = Infinity;
    this.pulledIn = 0;
    const bus = ctx && ctx.get ? ctx.get('bus') : null;
    this.bus = bus;
    if (bus) {
      this._onContact = (p) => this.onContact(p);
      this._onParry = (p) => this.onParry(p);
      this._onPhase = () => this.onBossPhase();
      bus.on('combat/contact', this._onContact); bus.on('combat/parry', this._onParry); bus.on('boss/phase', this._onPhase);
    }
    return this;
  }

  setHero(hero) { this.hero = hero; }
  setTarget(target, lockOn = false) { this.target = target; this.lockOn = lockOn; }
  addLook(dYaw, dPitch) { this.orbitYaw += dYaw; this.orbitPitch = clamp(this.orbitPitch + dPitch, -0.35, 0.70); }

  // ---- event layers ----
  onContact(p) {
    if (p.outcome !== Outcome.HIT && p.outcome !== Outcome.BLOCKED && p.outcome !== Outcome.GUARDBREAK) return;
    const heavy = p.damage >= 25 || p.outcome === Outcome.GUARDBREAK;
    this.impact(heavy ? 'heavy' : 'light');
  }
  impact(kind) {
    const tr = kind === 'slam' ? 0.6 : kind === 'heavy' ? 0.35 : 0.15;
    this.trauma = Math.min(1, this.trauma + tr);
    this.kick = kind === 'light' ? -2 : -4; this.kickT = 0;
  }
  onParry(p) { if (p && p.perfect) this.deflect(); }
  deflect() { this.push = 1; this.pushT = 0; this.pushDist = 0.45; this.pushIn = 0.12; this.pushOut = 0.5; }
  onBossPhase() { this.push = 1; this.pushT = 0; this.pushDist = 1.2; this.pushIn = 0.4; this.pushOut = 1.2; }
  phantomStep(frames = 18) { this.phantom = 1; this.phantomT = frames / 60; }

  _chooseShot() {
    const t = this.target;
    if (t && t.isBoss) return t.airborne ? SHOT.BOSS_AIR : SHOT.BOSS_GROUND;
    if (t && (this.lockOn || t.distance < 9.0)) return SHOT.DUEL;
    return SHOT.EXPLORE;
  }

  // dt = presentation dt (already scaled by Loop.presentScale)
  update(dt) {
    if (!this.hero || !this.camera) return;
    this.clock += dt;
    const next = this._chooseShot();
    if (next !== this.shot) { this.prevShot = this.shot; this.shot = next; this.blendT = 0; this.blendDur = BASE[next].blend; }
    if (this.blendT < 1) this.blendT = Math.min(1, this.blendT + dt / this.blendDur);
    // one exponential blend toward the active shot (lag derived from its blend time: ~95% at blendDur)
    const B = BASE[this.shot], a = smoothingAlpha(this.blendDur / 3, dt), c = this.cur;
    c.boom += (B.boom - c.boom) * a; c.height += (B.height - c.height) * a; c.fov += (B.fov - c.fov) * a;
    c.pitch += (B.pitch - c.pitch) * a; c.side += (B.side - c.side) * a;

    const hp = this.hero.position;
    _pivot.set(hp.x, hp.y + c.height, hp.z);
    let yaw, pitch;
    if (this.target && this.shot !== SHOT.EXPLORE) {
      // frame hero and target: camera behind the hero on the hero->target line, offset to the side (thirds)
      _toT.subVectors(this.target.position, _pivot);
      yaw = Math.atan2(-_toT.x, -_toT.z);
      const flat = Math.hypot(_toT.x, _toT.z);
      pitch = c.pitch + clamp(Math.atan2(_toT.y, Math.max(1, flat)) * 0.6, -0.2, this.shot === SHOT.BOSS_AIR ? CAMERA_LIMITS.pitchMaxAir : 0.35);
      this.orbitYaw += (yaw - this.orbitYaw - Math.round((yaw - this.orbitYaw) / (2 * Math.PI)) * 2 * Math.PI) * smoothingAlpha(0.12, dt);
      yaw = this.orbitYaw;
    } else { yaw = this.orbitYaw; pitch = c.pitch + this.orbitPitch; }

    // push-in layer
    if (this.push > 0) {
      this.pushT += dt;
      const inT = this.pushIn, outT = this.pushOut;
      const k = this.pushT < inT ? this.pushT / inT : Math.max(0, 1 - (this.pushT - inT) / outT);
      this.push = this.pushT < inT + outT ? k : 0;
    }
    const boom = c.boom - this.push * this.pushDist;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // forward (camera looks along) = (-sin yaw, ., -cos yaw); camera sits behind the pivot
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    _desired.set(_pivot.x - fx * boom * cp + rx * c.side, _pivot.y - sp * boom, _pivot.z - fz * boom * cp + rz * c.side);
    _look.set(_pivot.x + fx * 4 + rx * c.side * 0.4, _pivot.y + sp * 4, _pivot.z + fz * 4 + rz * c.side * 0.4);
    if (this.target && this.shot !== SHOT.EXPLORE) _look.lerp(this.target.position, 0.35);

    // shake (trauma^2, decays 1.6/s) is applied BEFORE the clearance solve so it can never break the C5 margin
    this.trauma = Math.max(0, this.trauma - 1.6 * dt);
    if (this.reducedMotion) this.trauma = 0;
    const sh = this.trauma * this.trauma;
    if (sh > 0) {
      const t = this.clock * 22;
      _desired.x += noise1(t, 1.3) * 0.12 * sh; _desired.y += noise1(t, 7.1) * 0.10 * sh; _desired.z += noise1(t, 3.7) * 0.12 * sh;
    }
    this._resolveClearance(_pivot, _desired);

    // FOV kick (6 f in/out envelope), deflect push-in FOV, phantom FOV +4
    let fov = c.fov;
    if (this.kick !== 0) {
      this.kickT += dt;
      const e = this.kickT < 0.05 ? this.kickT / 0.05 : Math.max(0, 1 - (this.kickT - 0.05 - 0.1) / 0.25);
      fov += this.kick * Math.min(1, e);
      if (this.kickT > 0.4) this.kick = 0;
    }
    if (this.push > 0) fov -= 5 * this.push * (this.pushDist < 1 ? 1 : 0.4);
    if (this.phantomT > 0) { this.phantomT -= dt; this.phantom = Math.max(0, Math.min(1, this.phantomT * 6)); fov += 4 * this.phantom; } else this.phantom = 0;
    if (this.reducedMotion) fov = c.fov;
    this.setLookAtPose({ position: _desired, lookAt: _look, up: _up });
    this.camera.position.copy(this.position);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.lookAt);
    if (Math.abs(this.camera.fov - fov) > 1e-4) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    const cl = this.colliders ? this.colliders.clearance(this.position.x, this.position.y, this.position.z, CAMERA_LIMITS.wallTop) : Infinity;
    this.lastClearance = cl;
    if (cl < this.minClearance) this.minClearance = cl;
  }

  // Walk the boom from the pivot outward and stop where clearance would drop under the margin.
  _resolveClearance(pivot, desired) {
    this.pulledIn = 0;
    if (!this.colliders) { this._clampLimits(desired); return; }
    const C = this.colliders, m = CAMERA_LIMITS.margin;
    this._clampLimits(desired);
    if (C.clearance(desired.x, desired.y, desired.z, CAMERA_LIMITS.wallTop) >= m) return;
    _v.subVectors(desired, pivot);
    const len = _v.length();
    let lo = 0, hi = 1;
    for (let i = 0; i < 12; i++) {                     // binary search on the boom fraction
      const mid = (lo + hi) * 0.5;
      _w.copy(pivot).addScaledVector(_v, mid);
      if (C.clearance(_w.x, _w.y, _w.z, CAMERA_LIMITS.wallTop) >= m) lo = mid; else hi = mid;
    }
    desired.copy(pivot).addScaledVector(_v, lo);
    this.pulledIn = len * (1 - lo);
    // if even the pivot is too close (hero hugging a boulder), lift the camera until it clears
    for (let i = 0; i < 16 && C.clearance(desired.x, desired.y, desired.z, CAMERA_LIMITS.wallTop) < m; i++) desired.y += 0.1;
    this._clampLimits(desired);
  }

  _clampLimits(p) {
    const L = CAMERA_LIMITS;
    const lim = p.y < L.wallTop + L.margin ? L.innerClamp : L.outerClamp;
    p.x = clamp(p.x, -lim, lim); p.z = clamp(p.z, -lim, lim);
    if (p.y > L.ceiling) p.y = L.ceiling;
  }

  snap() { this.initialized = false; this.blendT = 1; const B = BASE[this.shot]; Object.assign(this.cur, { boom: B.boom, height: B.height, fov: B.fov, pitch: B.pitch, side: B.side }); }
  resetStats() { this.minClearance = Infinity; }

  dispose() {
    if (this.bus) { this.bus.off('combat/contact', this._onContact); this.bus.off('combat/parry', this._onParry); this.bus.off('boss/phase', this._onPhase); }
    this.hero = this.target = this.camera = null;
  }
}
