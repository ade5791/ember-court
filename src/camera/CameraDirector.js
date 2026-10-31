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
  { boom: 4.3, height: 1.65, fov: 55, pitch: -0.10, blend: 0.9, side: 0.45 },   // STABLE v2: same lens as explore
  { boom: 7.5, height: 2.4, fov: 55, pitch: -0.10, blend: 0.6, side: 0.9 },   // C13 bias: view the hero->boss line obliquely so the hero never stacks on the body
  { boom: 9.5, height: 2.8, fov: 58, pitch: 0.0, blend: 0.8, side: 0.6 },
];

export const CAMERA_LIMITS = Object.freeze({
  margin: 0.25, wallTop: 1.12, innerClamp: 15.75, outerClamp: 20.65, ceiling: 10.75, pitchMaxAir: 0.70,
  cineClamp: 14.6,       // authored shots stay inside the walls: the maple canopy outside them buried the intro
});
// C13 boss occlusion: when the wyvern's body sits on the camera->hero line, swing the orbit (and lift) so the hero
// stays readable. Decided from the UN-swung pose, so the decision cannot oscillate with its own correction.
export const OCCLUSION = Object.freeze({ radius: 2.3, swing: 0.75, lift: 1.4, lag: 0.30, heroY: 1.1 });

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _pivot = new THREE.Vector3(), _desired = new THREE.Vector3();
const _look = new THREE.Vector3(), _toT = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
// STABLE v1: smoothed lock point and smoothed pivot (the rig never follows a bobbing head or a snapping root 1:1)
const _tgtS = new THREE.Vector3(), _pivotS = new THREE.Vector3();
export const CAMERA_STABILITY = Object.freeze({
  targetLag: 0.22,      // s, low-pass on the lock point (wyvern head bob, duelist lunges)
  yawLagDuel: 0.22, yawLagBoss: 0.38,   // s, framing yaw follow (was 0.12 for both)
  pivotLagXZ: 0.05, pivotLagY: 0.10,    // s, hero pivot follow (absorbs phantom-step teleports)
  maxFovDrop: 0,        // degrees the view may narrow below the shot base: 0 = no zoom-in ever
});

// Cinematic layer (v2): authored boss shots blended over the gameplay rig. Never narrows the lens; every shot
// still goes through the clearance solve and the arena clamp. dist/height are metres from the focus point.
export const CINE = Object.freeze({ NONE: 0, INTRO: 1, PHASE: 2, FINISHER: 3, DEATH: 4 });
export const CINE_NAMES = Object.freeze(['NONE', 'INTRO', 'PHASE', 'FINISHER', 'DEATH']);
const CINE_SHOT = [
  null,
  { dur: 5.0, inT: 0.6, outT: 1.2, d0: 13.0, d1: 10.5, h0: 5.0, h1: 2.6, orbit: 1.15, lookY: 0.2, fov: 0 },     // INTRO: sweeping orbit as it lands
  { dur: 1.9, inT: 0.35, outT: 0.8, d0: 9.5, d1: 7.8, h0: 0.7, h1: 0.5, orbit: 0.25, lookY: 0.4, fov: 0 },     // PHASE: low push on the roar
  { dur: 1.6, inT: 0.2, outT: 0.6, d0: 5.2, d1: 4.6, h0: 0.55, h1: 0.9, orbit: 0.55, lookY: -0.6, fov: 0 },    // FINISHER: low side arc
  { dur: 4.0, inT: 0.6, outT: 1.2, d0: 9.0, d1: 15.0, h0: 2.2, h1: 5.5, orbit: 0.5, lookY: -0.4, fov: 4 },     // DEATH: slow pull-back
];
const _cPos = new THREE.Vector3(), _cLook = new THREE.Vector3(), _cPiv = new THREE.Vector3();
function smooth01(x) { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); }

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
    this.cineKind = CINE.NONE; this.cineT = 0; this.cineW = 0; this.cineYaw0 = 0; this.cineCount = 0;
    this.cineFocus = new THREE.Vector3();   // owner (main) writes the subject point each frame
    this.cineLog = [0, 0, 0, 0, 0];
    this.occluder = { position: new THREE.Vector3(), active: false };   // owner (main) writes the boss body centre
    this.occYaw = 0; this.occSign = 0; this.occFrames = 0; this._cw = 0;
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
    this.trauma = Math.max(this.trauma, tr);     // rapid hits / duplicate events do not stack into a big shake
    this.kick = 0; this.kickT = 0;
  }
  onParry(p) { if (p && p.perfect) this.deflect(); }
  deflect() { if (this.push > 0.05) return; this.push = 1; this.pushT = 0; this.pushDist = 0.18; this.pushIn = 0.10; this.pushOut = 0.45; }
  onBossPhase() { this.push = 1; this.pushT = 0; this.pushDist = 0.8; this.pushIn = 0.5; this.pushOut = 1.4; }
  phantomStep(frames = 18) { this.phantom = 1; this.phantomT = frames / 60; }

  // Start an authored shot. A higher-priority shot (DEATH > FINISHER > INTRO > PHASE) is never cut by a lower one.
  cine(kind) {
    if (!CINE_SHOT[kind]) return;
    const pri = [0, 2, 1, 3, 4];
    if (this.cineKind !== CINE.NONE && this.cineT < CINE_SHOT[this.cineKind].dur && pri[kind] < pri[this.cineKind]) return;
    // start from where the gameplay camera already looks from, so the shot grows out of the current view
    if (this.cineKind === CINE.NONE || this.cineW < 0.05) this.cineYaw0 = Math.atan2(this.position.x - this.cineFocus.x, this.position.z - this.cineFocus.z);
    this.cineKind = kind; this.cineT = 0; this.cineCount++; this.cineLog[kind]++;
    this.push = 0; this.trauma = Math.min(this.trauma, 0.2);
  }
  get cineActive() { return this.cineKind !== CINE.NONE; }

  // Compose the cine pose into _cPos/_cLook/_cPiv; returns blend weight 0..1.
  _cinePose(dt) {
    const S = CINE_SHOT[this.cineKind];
    this.cineT += dt;
    if (this.cineT >= S.dur) { this.cineKind = CINE.NONE; this.cineW = 0; return 0; }
    const u = this.cineT / S.dur, e = smooth01(u);
    const w = Math.min(smooth01(this.cineT / S.inT), smooth01((S.dur - this.cineT) / S.outT));
    const f = this.cineFocus;
    let yaw = this.cineYaw0 + S.orbit * e * (this.cineKind === CINE.FINISHER ? -1 : 1);
    const d = S.d0 + (S.d1 - S.d0) * e, h = S.h0 + (S.h1 - S.h0) * e;
    if (this.cineKind === CINE.FINISHER && this.hero) {
      // side-on to the hero->target line, framed on the midpoint, low and close
      const hp = this.hero.position, mx = (hp.x + f.x) * 0.5, mz = (hp.z + f.z) * 0.5;
      const lx = f.x - hp.x, lz = f.z - hp.z, ll = Math.hypot(lx, lz) || 1;
      yaw = Math.atan2(-lz / ll, lx / ll) + S.orbit * (e - 0.5);
      _cPiv.set(mx, hp.y + 1.0, mz);
    } else _cPiv.copy(f);
    _cPos.set(_cPiv.x + Math.sin(yaw) * d, _cPiv.y + h, _cPiv.z + Math.cos(yaw) * d);
    _cLook.set(_cPiv.x, _cPiv.y + S.lookY, _cPiv.z);
    this.cineW = w;
    return this.reducedMotion ? w * 0.5 : w;
  }

  _chooseShot() {
    const t = this.target;
    if (t && t.isBoss) return t.airborne ? SHOT.BOSS_AIR : SHOT.BOSS_GROUND;
    if (t && (this.lockOn || t.distance < (this.shot === SHOT.DUEL ? 10.0 : 7.5))) return SHOT.DUEL;
    return SHOT.EXPLORE;
  }

  // dt = presentation dt (already scaled by Loop.presentScale)
  update(dt) {
    if (!this.hero || !this.camera) return;
    this.clock += dt;
    const next = this._chooseShot();
    if (this._snapPending) {
      // first frame after reset(): jump straight to the right shot, rig params and framing yaw (no whip, no blend)
      this._snapPending = false; this.shot = this.prevShot = next; this.blendT = 1;
      const B0 = BASE[next]; Object.assign(this.cur, { boom: B0.boom, height: B0.height, fov: B0.fov, pitch: B0.pitch, side: B0.side });
      if (this.target && next !== SHOT.EXPLORE) {
        const hp0 = this.hero.position;
        this.orbitYaw = Math.atan2(-(this.target.position.x - hp0.x), -(this.target.position.z - hp0.z));
      }
    }
    if (next !== this.shot) { this.prevShot = this.shot; this.shot = next; this.blendT = 0; this.blendDur = BASE[next].blend; }
    if (this.blendT < 1) this.blendT = Math.min(1, this.blendT + dt / this.blendDur);
    // one exponential blend toward the active shot (lag derived from its blend time: ~95% at blendDur)
    const B = BASE[this.shot], a = smoothingAlpha(this.blendDur / 3, dt), c = this.cur;
    c.boom += (B.boom - c.boom) * a; c.height += (B.height - c.height) * a; c.fov += (B.fov - c.fov) * a;
    c.pitch += (B.pitch - c.pitch) * a; c.side += (B.side - c.side) * a;

    const hp = this.hero.position;
    const S = CAMERA_STABILITY;
    if (!this.initialized || !this._stableInit) { _pivotS.set(hp.x, hp.y, hp.z); }
    else {
      const ax = smoothingAlpha(S.pivotLagXZ, dt), ay = smoothingAlpha(S.pivotLagY, dt);
      _pivotS.x += (hp.x - _pivotS.x) * ax; _pivotS.z += (hp.z - _pivotS.z) * ax; _pivotS.y += (hp.y - _pivotS.y) * ay;
    }
    _pivot.set(_pivotS.x, _pivotS.y + c.height, _pivotS.z);
    // smoothed lock point; snaps when a new target appears or after a reset
    if (this.target) {
      const tp = this.target.position;
      if (!this.initialized || !this._stableInit || this._tgtRef !== this.target || !this._tgtLive) _tgtS.copy(tp);
      else _tgtS.lerp(tp, smoothingAlpha(S.targetLag, dt));
      this._tgtRef = this.target; this._tgtLive = true;
    } else this._tgtLive = false;
    this._stableInit = true;
    let yaw, pitch;
    if (this.target && this.shot !== SHOT.EXPLORE) {
      // frame hero and target: camera behind the hero on the hero->target line, offset to the side (thirds)
      _toT.subVectors(_tgtS, _pivot);
      yaw = Math.atan2(-_toT.x, -_toT.z) + (BASE[this.shot].bias || 0);
      const flat = Math.hypot(_toT.x, _toT.z);
      pitch = c.pitch + clamp(Math.atan2(_toT.y, Math.max(1, flat)) * 0.6, -0.2, this.shot === SHOT.BOSS_AIR ? CAMERA_LIMITS.pitchMaxAir : 0.35);
      this.orbitYaw += (yaw - this.orbitYaw - Math.round((yaw - this.orbitYaw) / (2 * Math.PI)) * 2 * Math.PI) * smoothingAlpha(this.shot === SHOT.DUEL ? S.yawLagDuel : S.yawLagBoss, dt);
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
    // C13: occlusion test on the un-swung pose, then a smoothed swing + lift toward the clear side
    let occT = 0;
    if (this.occluder.active && this.occAvoid !== false && this.shot !== SHOT.EXPLORE && this.cineKind === CINE.NONE) {
      const s = this._occSide(_pivot, yaw, boom, cp, sp, c.side);
      if (s !== 0) { if (this.occSign === 0) this.occSign = s; occT = this.occSign * OCCLUSION.swing; }
    }
    if (occT === 0 && Math.abs(this.occYaw) < 0.02) this.occSign = 0;
    this.occYaw += (occT - this.occYaw) * smoothingAlpha(OCCLUSION.lag, dt);
    yaw += this.occYaw;
    _pivot.y += OCCLUSION.lift * Math.min(1, Math.abs(this.occYaw) / OCCLUSION.swing);
    // forward (camera looks along) = (-sin yaw, ., -cos yaw); camera sits behind the pivot
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    _desired.set(_pivot.x - fx * boom * cp + rx * c.side, _pivot.y - sp * boom, _pivot.z - fz * boom * cp + rz * c.side);
    _look.set(_pivot.x + fx * 4 + rx * c.side * 0.4, _pivot.y + sp * 4, _pivot.z + fz * 4 + rz * c.side * 0.4);
    if (this.target && this.shot !== SHOT.EXPLORE) _look.lerp(_tgtS, 0.35);

    // shake (trauma^2, decays 1.6/s) is applied BEFORE the clearance solve so it can never break the C5 margin
    this.trauma = Math.max(0, this.trauma - 1.6 * dt);
    if (this.reducedMotion) this.trauma = 0;
    const sh = this.trauma * this.trauma;
    if (sh > 0) {
      const t = this.clock * 22;
      _desired.x += noise1(t, 1.3) * 0.12 * sh; _desired.y += noise1(t, 7.1) * 0.10 * sh; _desired.z += noise1(t, 3.7) * 0.12 * sh;
    }
    let cw = 0;
    if (this.cineKind !== CINE.NONE) {
      cw = this._cinePose(dt);
      if (cw > 0) {
        _desired.lerp(_cPos, cw); _look.lerp(_cLook, cw); _pivot.lerp(_cPiv, cw);
        // gameplay orbit follows the shot so the hand-back has no whip
        if (this.shot === SHOT.EXPLORE) this.orbitYaw = Math.atan2(_look.x - _desired.x, _look.z - _desired.z) + Math.PI;
      }
    }
    this._cw = cw;
    this._resolveClearance(_pivot, _desired);
    if (this.occluder.active && cw === 0 && this._segOcc(this.occluder.position, _desired.x, _desired.y, _desired.z, this.hero.position) !== 0) this.occFrames++;

    // FOV kick (6 f in/out envelope), deflect push-in FOV, phantom FOV +4
    let fov = c.fov;
    if (this.kick !== 0) {
      this.kickT += dt;
      const e = this.kickT < 0.05 ? this.kickT / 0.05 : Math.max(0, 1 - (this.kickT - 0.05 - 0.1) / 0.25);
      fov += this.kick * Math.min(1, e);
      if (this.kickT > 0.4) this.kick = 0;
    }
    if (this.phantomT > 0) { this.phantomT -= dt; this.phantom = Math.max(0, Math.min(1, this.phantomT * 6)); fov += 4 * this.phantom; } else this.phantom = 0;
    if (cw > 0) fov += CINE_SHOT[this.cineKind] ? CINE_SHOT[this.cineKind].fov * cw : 0;
    if (fov < c.fov - CAMERA_STABILITY.maxFovDrop) fov = c.fov - CAMERA_STABILITY.maxFovDrop;
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

  // C13 helpers. _segOcc: nonzero when the occluder sphere cuts the camera->hero-chest segment (value = swing side).
  _segOcc(O, cx, cy, cz, hp) {
    const hx = hp.x, hy = hp.y + OCCLUSION.heroY, hz = hp.z;
    const dx = hx - cx, dy = hy - cy, dz = hz - cz, dd = dx * dx + dy * dy + dz * dz || 1;
    const t = clamp(((O.x - cx) * dx + (O.y - cy) * dy + (O.z - cz) * dz) / dd, 0, 1);
    if (t > 0.97) return 0;                                   // body beyond the hero: not an occluder
    const px = cx + dx * t - O.x, py = cy + dy * t - O.y, pz = cz + dz * t - O.z;
    if (px * px + py * py + pz * pz > OCCLUSION.radius * OCCLUSION.radius) return 0;
    return (dx * (O.z - cz) - dz * (O.x - cx)) > 0 ? -1 : 1;   // swing away from the side the body is on
  }
  _occSide(pivot, yaw, boom, cp, sp, side) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    return this._segOcc(this.occluder.position, pivot.x - fx * boom * cp + rx * side, pivot.y - sp * boom, pivot.z - fz * boom * cp + rz * side, this.hero.position);
  }

  _clampLimits(p) {
    const L = CAMERA_LIMITS;
    let lim = p.y < L.wallTop + L.margin ? L.innerClamp : L.outerClamp;
    if (this._cw > 0) lim += (Math.min(lim, L.cineClamp) - lim) * Math.min(1, this._cw * 1.5);
    p.x = clamp(p.x, -lim, lim); p.z = clamp(p.z, -lim, lim);
    if (p.y > L.ceiling) p.y = L.ceiling;
  }

  // Full reset for retry / restart: drop every additive layer, put the orbit behind the hero, and snap the
  // next update onto whatever shot the new situation calls for.
  reset(heroYaw = 0) {
    this.trauma = 0; this.kick = 0; this.kickT = 0; this.push = 0; this.pushT = 0; this.pushDist = 0;
    this.phantom = 0; this.phantomT = 0; this.pulledIn = 0; this.occYaw = 0; this.occSign = 0; this._cw = 0;
    this.cineKind = CINE.NONE; this.cineT = 0; this.cineW = 0;
    this.orbitYaw = heroYaw; this.orbitPitch = 0;
    this.target = null; this.lockOn = false; this.shot = this.prevShot = SHOT.EXPLORE;
    this._snapPending = true; this._stableInit = false; this._tgtLive = false; this.snap(); this.resetStats();
  }

  snap() { this.initialized = false; this.blendT = 1; const B = BASE[this.shot]; Object.assign(this.cur, { boom: B.boom, height: B.height, fov: B.fov, pitch: B.pitch, side: B.side }); }
  resetStats() { this.minClearance = Infinity; this.occFrames = 0; }

  dispose() {
    if (this.bus) { this.bus.off('combat/contact', this._onContact); this.bus.off('combat/parry', this._onParry); this.bus.off('boss/phase', this._onPhase); }
    this.hero = this.target = this.camera = null;
  }
}
