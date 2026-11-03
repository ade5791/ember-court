// GauntletBrain - simulation side of the Stage 3 boss "Chrome Gauntlet" (docs/STAGE3_SPEC.md sections 3-5).
// Deterministic: fixed 60 Hz only, randomness from the seeded 'gauntlet' stream, never reads presentation
// state. Owns root XZ/Y, yaw, HP, posture, phase (1 normal, 2 enraged), the verb state machine, remote hazards
// (slam wave, lightning columns, dome) and contact resolution against the hero.
// Presentation reads this.anim ({ clip, time, loop }) and this.fx; it never writes back.
//
// Every verb: ACTION f=1..total (telegraph fired at f=0, startup = active[0]) -> HOLD 18 f -> WAIT (phase
// spacing). Each contact is applied once per (contactId, target).
import { SIM, GAUNTLET } from '../shared/constants.js';
import { GauntletVerb as GV, Outcome, Surface, ActorKind, Phase } from '../shared/enums.js';

export const G_STATE = Object.freeze({ WAIT: 0, ACTION: 1, HOLD: 2, ROAR: 3, STAGGER: 4, DEAD: 5 });
export const G_STATE_NAMES = Object.freeze(['WAIT', 'ACTION', 'HOLD', 'ROAR', 'STAGGER', 'DEAD']);

// shape: 'arc' (front arc, half-angle), 'front' (narrow front), 'tail' (rear half-plane), 'disc' (at slam point),
// 'cols' (lightning columns), 'dome' (expanding sphere around root), 'push' (roar)
// guard: jg = just-guard allowed, blk = held block allowed (chip), dg = dodge i-frames avoid it,
// blkBreak = a held block is a guard break. dmg = HP on hit, jgPosture = boss posture gained on a just-guard.
const BASE = {
  [GV.G_SWEEP_L]: { name: 'G_SWEEP_L', clip: 'sweep_l', active: [30, 38], total: 78, shape: 'arc', reach: 5.2, half: 100 * Math.PI / 180, dmg: 22, jgPosture: 28, jg: 1, blk: 1, dg: 1, track: 18 },
  [GV.G_SWEEP_R]: { name: 'G_SWEEP_R', clip: 'sweep_r', active: [30, 38], total: 78, shape: 'arc', reach: 5.2, half: 100 * Math.PI / 180, dmg: 22, jgPosture: 28, jg: 1, blk: 1, dg: 1, track: 18 },
  [GV.G_LUNGE]: { name: 'G_LUNGE', clip: 'lunge', active: [48, 56], total: 102, shape: 'front', reach: 4.6, half: 0.55, dmg: 28, jgPosture: 34, jg: 1, blk: 1, dg: 1, track: 30, travel: [30, 52, 7.0] },
  [GV.G_SLAM]: { name: 'G_SLAM', clip: 'rear_slam', active: [54, 58], total: 110, shape: 'disc', reach: 3.4, dmg: 34, jgPosture: 40, jg: 1, blk: 1, dg: 1, track: 30,
    leap: [36, 54], wave: { from: 58, to: 88, r0: 3.4, r1: 10.0, thick: 0.8, dmg: 16 } },
  [GV.G_LIGHTNING]: { name: 'G_LIGHTNING', clip: 'summon', active: [50, 56], total: 110, shape: 'cols', reach: 1.6, dmg: 26, jgPosture: 0, jg: 0, blk: 0, dg: 1, track: 50,
    cols: { every: 12, count: 3, lead: 50, len: 6 } },
  [GV.G_DOME]: { name: 'G_DOME', clip: 'dome', active: [60, 66], total: 126, shape: 'dome', reach: 6.5, dmg: 24, jgPosture: 30, jg: 1, blk: 0, blkBreak: 1, dg: 1, track: 40, coreOpen: 90 },
  [GV.G_TAIL]: { name: 'G_TAIL', clip: 'tail', active: [24, 32], total: 68, shape: 'tail', reach: 6.0, dmg: 18, jgPosture: 20, jg: 1, blk: 1, dg: 1, track: 0 },
  [GV.G_ROAR]: { name: 'G_ROAR', clip: 'roar', active: [20, 20], total: 83, shape: 'push', reach: 4.0, dmg: 0, jgPosture: 0, jg: 0, blk: 0, dg: 0, track: 0 },
};

// Phase 2 (enrage): startups -15% (never below 24 f), recovery -20%. Active length and remote-hazard offsets
// shift with the startup so contact geometry is unchanged.
function enrage(d) {
  if (d.shape === 'push') return d;
  const a0 = d.active[0], len = d.active[1] - a0, rec = d.total - d.active[1];
  const n0 = Math.max(24, Math.round(a0 * 0.85)), sh = n0 - a0;
  const o = { ...d, active: [n0, n0 + len], total: n0 + len + Math.round(rec * 0.8), track: Math.max(0, d.track + sh) };
  if (d.travel) o.travel = [d.travel[0] + sh, d.travel[1] + sh, d.travel[2]];
  if (d.leap) o.leap = [d.leap[0] + sh, d.leap[1] + sh];
  if (d.wave) o.wave = { ...d.wave, from: d.wave.from + sh, to: d.wave.to + sh };
  if (d.cols) o.cols = { ...d.cols, lead: d.cols.lead + sh };
  return Object.freeze(o);
}
function freezeAll(t) { const o = {}; for (const k of Object.keys(t)) o[k] = Object.freeze(t[k]); return Object.freeze(o); }
export const VERBS_P1 = freezeAll(BASE);
export const VERBS_P2 = (() => { const o = {}; for (const k of Object.keys(VERBS_P1)) o[k] = enrage(VERBS_P1[k]); return Object.freeze(o); })();
// enraged follow-up sweep: second swing of the L->R chain comes out fast
export const CHAIN_SWEEP_R = Object.freeze({ ...VERBS_P2[GV.G_SWEEP_R], active: [18, 26], total: 62, track: 8 });

export const G_PHASES = Object.freeze([null, { wait: [60, 90], decay: 10 }, { wait: [36, 60], decay: 14 }]);
export const G_DEFENCE = Object.freeze({
  JG: [0, 8], JG_PERFECT: [0, 4], LATE: [9, 12], IFRAMES: [3, 16], FACE_COS: Math.cos(100 * Math.PI / 180),
  CHIP: 0.25, BLOCK_STAMINA: 0.8, JG_PERFECT_MUL: 1.25, STAGGER_F: 150, FINISHER_RANGE: 3.0,
});
const COOLDOWN = Object.freeze({ [GV.G_DOME]: 600, [GV.G_LIGHTNING]: 420 });

// Pure defence resolution (fixture-testable). hero: invuln, dodgeF, deflectF, blocking, x, z, yaw.
// (ax, az) = where the hit comes from (boss root, slam point, wave origin). Returns { outcome, perfect, effect }
// effect in 'none' | 'jg' | 'chip' | 'break'.
const _res = { outcome: 0, perfect: false, effect: 'none' };
export function resolveGauntletDefence(d, hero, ax, az, out = _res) {
  const D = G_DEFENCE;
  out.perfect = false; out.effect = 'none';
  if (hero.invuln) { out.outcome = Outcome.WHIFF_IFRAME; return out; }
  if (d.dg && hero.dodgeF >= D.IFRAMES[0] && hero.dodgeF <= D.IFRAMES[1]) { out.outcome = Outcome.WHIFF_IFRAME; return out; }
  // guard only counts when the hero faces the source within 100 deg
  const tx = ax - hero.x, tz = az - hero.z, tl = Math.hypot(tx, tz) || 1;
  const facing = (-Math.sin(hero.yaw) * tx - Math.cos(hero.yaw) * tz) / tl >= D.FACE_COS;
  const pF = hero.deflectF;
  if (d.jg && facing && pF >= D.JG[0] && pF <= D.JG[1]) {
    out.outcome = Outcome.PARRIED; out.perfect = pF <= D.JG_PERFECT[1]; out.effect = 'jg'; return out;
  }
  const guarding = facing && (hero.blocking || (pF >= D.LATE[0] && pF <= D.LATE[1]));
  if (guarding && d.blkBreak) { out.outcome = Outcome.GUARDBREAK; out.effect = 'break'; return out; }
  if (guarding && d.blk) { out.outcome = Outcome.BLOCKED; out.effect = 'chip'; return out; }
  out.outcome = Outcome.HIT;
  return out;
}

const TAU = Math.PI * 2;
function wrapAngle(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
const HOLD_F = 18, ROAR_F = 83, STAGGER_HIT_F = 40, FINISHER_F = 96, FINISHER_HIT_F = 60, FINISHER_DMG = 180;
const LEAP_Y = 4.5;

export class GauntletBrain {
  static id = 'gauntlet';
  static deps = ['world'];

  // rng: forked Rng stream ('gauntlet'); colliders optional; bus optional
  init(ctx, { rng, colliders = null, bus = null, actorId = 200 }) {
    this.ctx = ctx; this.rng = rng; this.colliders = colliders; this.bus = bus; this.actorId = actorId;
    this.x = GAUNTLET.SPAWN[0]; this.z = GAUNTLET.SPAWN[2]; this.y = 0;
    this.yaw = Math.PI;                       // facing +Z (the hero spawn); yaw 0 faces -Z
    this.hp = GAUNTLET.HP; this.posture = 0; this.phase = 1; this.pendingPhase = 0; this.forceNext = -1;
    this.state = G_STATE.WAIT; this.f = 0; this.waitF = 90; this.holdF = 0;
    this.verb = -1; this.def = null; this.actionId = 0; this.hitDone = false; this.lastVerb = -1; this.repeat = 0;
    this.chain = -1; this.invuln = false; this.simFrame = 0;
    this.cool = new Int32Array(8);           // per-verb cooldown end frame
    this.slam = { x: 0, z: 0, sx: 0, sz: 0, hit: false };
    this.wave = { active: false, x: 0, z: 0, r: 0, id: 0, hit: false };
    this.cols = []; for (let i = 0; i < 3; i++) this.cols.push({ x: 0, z: 0, at: -1, left: 0, id: 0, hit: false });
    this.dome = { active: false, r: 0 };
    this.coreUntil = -1;
    this.finisherF = -1; this.finisherHits = 0; this.staggerLeft = 0;
    this.travelLeft = 0;
    this.anim = { clip: 'idle', time: 0, loop: true };
    this.contacts = 0; this.jgCount = 0;
    this.heroSink = null; this.telegraphSink = null;
    this.rec = { actionId: 0, attackerId: actorId, targetId: 0, verb: 0, outcome: 0, damage: 0, posture: 0, art: 0,
      effect: 'none', perfect: false, pos: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, surface: Surface.FLESH,
      tx: 0, tz: 0, frame: 0, stamina: 0, slide: 0, boss: 'gauntlet' };
    this.log = []; this.logOn = false;
    this._cands = [];
    return this;
  }

  forwardX() { return -Math.sin(this.yaw); }
  forwardZ() { return -Math.cos(this.yaw); }
  get enraged() { return this.phase >= 2; }
  get coreOpen() { return this.simFrame <= this.coreUntil || (this.state === G_STATE.ACTION && this.verb === GV.G_SLAM && this.f < (this.def.leap ? this.def.leap[0] : 0) && this.f > 20); }
  verbDef(v) { return (this.phase >= 2 ? VERBS_P2 : VERBS_P1)[v]; }

  startIntro() { this._startRoar(true); }

  fixedUpdate(h, simFrame) {
    this.simFrame = simFrame;
    if (this.finisherF >= 0) { this._finisherStep(h); return; }
    if (this.state !== G_STATE.STAGGER && this.state !== G_STATE.DEAD) this.posture = Math.max(0, this.posture - G_PHASES[this.phase].decay / 60);
    this._stepHazards(h);
    switch (this.state) {
      case G_STATE.WAIT: this._wait(h); break;
      case G_STATE.ACTION: this._action(h); break;
      case G_STATE.HOLD: this._hold(h); break;
      case G_STATE.ROAR: this._roar(h); break;
      case G_STATE.STAGGER: this._stagger(); break;
      case G_STATE.DEAD: this.f++; this.anim.clip = 'death'; this.anim.time = Math.min(this.f, 100) / 60; this.anim.loop = false; break;
    }
    this._clampAndPush(h);
  }

  _turnToward(tx, tz, rate) {
    const want = Math.atan2(-(tx - this.x), -(tz - this.z));
    const d = wrapAngle(want - this.yaw), m = rate / 60;
    this.yaw = wrapAngle(this.yaw + (d > m ? m : d < -m ? -m : d));
    return d;
  }

  _wait(h) {
    this.f++;
    const dx = h.x - this.x, dz = h.z - this.z, dist = Math.hypot(dx, dz);
    this._turnToward(h.x, h.z, GAUNTLET.TURN_RATE);
    let moving = false;
    if (dist > 5.0) { const s = GAUNTLET.WALK_SPEED / 60 / dist; this.x += dx * s; this.z += dz * s; moving = true; }
    this.anim.clip = moving ? 'walk' : 'idle'; this.anim.time = (this.f % (moving ? 60 : 120)) / 60; this.anim.loop = true;
    if (this.pendingPhase) { this._startRoar(false); return; }
    if (this.f >= this.waitF) this._choose(h, dist);
  }

  _choose(h, dist) {
    if (this.forceNext >= 0) { const fv = this.forceNext; this.forceNext = -1; this._startVerb(fv); return; }
    const dx = h.x - this.x, dz = h.z - this.z, fwd = (dx * this.forwardX() + dz * this.forwardZ()) / (dist || 1);
    const c = this._cands; c.length = 0;
    const add = (v, w) => {
      if (v === this.lastVerb && this.repeat >= 1) return;                       // never three in a row
      if (this.cool[v] > this.simFrame) return;
      c.push(v, w);
    };
    const side = (dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw)) >= 0 ? GV.G_SWEEP_R : GV.G_SWEEP_L;
    if (fwd < -0.3 && dist < 6.0) { add(GV.G_TAIL, 70); add(GV.G_DOME, 30); }
    else if (dist <= 5.5) { add(side, 45); add(GV.G_LUNGE, 15); add(GV.G_SLAM, 25); add(GV.G_DOME, 15); }
    else { add(GV.G_LUNGE, 45); add(GV.G_SLAM, 30); add(GV.G_LIGHTNING, 25); }
    if (c.length === 0) { c.push(GV.G_LUNGE, 1); }
    let tot = 0; for (let i = 1; i < c.length; i += 2) tot += c[i];
    let pick = this.rng.float() * tot, v = c[0];
    for (let i = 0; i < c.length; i += 2) { pick -= c[i + 1]; if (pick <= 0) { v = c[i]; break; } }
    this._startVerb(v);
  }

  _startVerb(v, defOverride = null) {
    const d = defOverride || this.verbDef(v);
    this.repeat = v === this.lastVerb ? this.repeat + 1 : 0;
    this.verb = v; this.def = d; this.actionId++; this.hitDone = false; this.f = 0;
    this.state = v === GV.G_ROAR ? G_STATE.ROAR : G_STATE.ACTION;
    if (COOLDOWN[v]) this.cool[v] = this.simFrame + COOLDOWN[v];
    this.travelLeft = d.travel ? d.travel[2] : 0;
    if (v === GV.G_SLAM) { this.slam.sx = this.x; this.slam.sz = this.z; this.slam.x = this.x; this.slam.z = this.z; this.slam.hit = false; }
    if (v === GV.G_LIGHTNING) for (const col of this.cols) { col.at = -1; col.left = 0; }
    if (v !== GV.G_ROAR) {
      if (this.telegraphSink) this.telegraphSink(v, d.jg ? 0 : 1, d.active[0]);
      this._emit('ai/telegraph', d.active[0]);
    }
    this._emitAction('action/start', Phase.STARTUP);
    if (this.logOn) this.log.push([this.simFrame, 'start', v, d.active[0]]);
  }

  _action(h) {
    const d = this.def, v = this.verb; this.f++;
    const f = this.f;
    this.anim.clip = d.clip; this.anim.loop = false; this.anim.time = f / 60;
    if (f === d.active[0]) this._emitAction('action/phase', Phase.ACTIVE);
    if (f === d.active[1] + 1) this._emitAction('action/phase', Phase.RECOVERY);
    if (f < d.track) this._turnToward(h.x, h.z, GAUNTLET.TURN_RATE * 1.6);
    // committed lunge line (aim locked once tracking ends); stops short of running through the hero
    if (d.travel && f >= d.travel[0] && f < d.travel[1] && this.travelLeft > 0) {
      const dist = Math.hypot(h.x - this.x, h.z - this.z);
      if (dist > GAUNTLET.BODY_RADIUS + 1.2) {
        const s = Math.min(this.travelLeft, d.travel[2] / (d.travel[1] - d.travel[0]));
        this.x += this.forwardX() * s; this.z += this.forwardZ() * s; this.travelLeft -= s;
      }
    }
    // rear-up leap: target sampled at leap start (hero position 2.0 m short along the line), straight arc
    if (d.leap) {
      if (f === d.leap[0]) {
        let tx = h.x - this.x, tz = h.z - this.z; const l = Math.hypot(tx, tz) || 1;
        const go = Math.max(0, Math.min(7.0, l - 2.0));
        this.slam.sx = this.x; this.slam.sz = this.z;
        this.slam.x = this.x + tx / l * go; this.slam.z = this.z + tz / l * go;
        this.yaw = Math.atan2(-tx, -tz);
      }
      if (f > d.leap[0] && f <= d.leap[1]) {
        const u = (f - d.leap[0]) / (d.leap[1] - d.leap[0]);
        this.x = this.slam.sx + (this.slam.x - this.slam.sx) * u; this.z = this.slam.sz + (this.slam.z - this.slam.sz) * u;
        this.y = LEAP_Y * Math.sin(Math.PI * u);
      }
      if (f === d.leap[1]) this.y = 0;
      if (d.wave && f === d.wave.from) {
        const W = this.wave; W.active = true; W.x = this.x + this.forwardX() * 2.0; W.z = this.z + this.forwardZ() * 2.0;
        W.r = d.wave.r0; W.id = this.actionId * 16 + 1; W.hit = false; W.def = d;
      }
    }
    // lightning: columns placed on the hero at f 0, 12, 24; each strikes `lead` frames after placement
    if (d.cols && f - 1 <= d.cols.every * (d.cols.count - 1) && (f - 1) % d.cols.every === 0) this._placeCol(h, (f - 1) / d.cols.every | 0, d);
    if (v === GV.G_DOME) {
      this.dome.active = f >= d.active[0] && f <= d.active[1];
      this.dome.r = this.dome.active ? d.reach * (f - d.active[0] + 1) / (d.active[1] - d.active[0] + 1) : 0;
      if (f === d.active[1]) this.coreUntil = this.simFrame + d.coreOpen;
    }
    if (f >= d.active[0] && f <= d.active[1]) this._contact(h, d, f);
    if (f >= d.total) this._endAction();
  }

  _placeCol(h, i, d) {
    const c = this.cols[i]; if (!c) return;
    const lim = SIM.ARENA_HALF - 1.0;
    c.x = Math.max(-lim, Math.min(lim, h.x)); c.z = Math.max(-lim, Math.min(lim, h.z));
    c.at = this.simFrame + d.cols.lead; c.left = d.cols.lead + d.cols.len; c.id = this.actionId * 16 + 2 + i; c.hit = false; c.def = d;
    if (this.logOn) this.log.push([this.simFrame, 'col', Math.round(c.x * 10), Math.round(c.z * 10)]);
  }

  // Remote hazards outlive the verb (a stagger does not cancel a column already placed).
  _stepHazards(h) {
    const hr = h.radius || SIM.CAPSULE_RADIUS;
    const W = this.wave;
    if (W.active) {
      const w = W.def.wave, span = w.to - w.from;
      W.r += (w.r1 - w.r0) / span;
      if (W.r >= w.r1) W.active = false;
      else if (!W.hit) {
        const dist = Math.hypot(h.x - W.x, h.z - W.z);
        if (Math.abs(dist - W.r) <= w.thick * 0.5 + hr) { W.hit = true; this._deliver(h, W.def, GV.G_SLAM, W.id, W.x, W.z, w.dmg, 'wave'); }
      }
    }
    for (const c of this.cols) {
      if (c.left <= 0) continue;
      c.left--;
      const d = c.def;
      if (!c.hit && this.simFrame >= c.at && this.simFrame < c.at + d.cols.len && Math.hypot(h.x - c.x, h.z - c.z) <= d.reach + hr) {
        c.hit = true; this._deliver(h, d, GV.G_LIGHTNING, c.id, c.x, c.z, d.dmg, 'col');
      }
    }
  }

  _contact(h, d, f) {
    if (d.shape === 'push') { if (f === d.active[0]) this._pushHero(h, d.reach, 1.5); return; }
    if (d.shape === 'cols' || this.hitDone) return;
    const hr = h.radius || SIM.CAPSULE_RADIUS;
    const dx = h.x - this.x, dz = h.z - this.z, dist = Math.hypot(dx, dz);
    const fwd = dx * this.forwardX() + dz * this.forwardZ();
    let inside = false, ax = this.x, az = this.z;
    switch (d.shape) {
      case 'arc': case 'front': inside = dist <= d.reach + hr && fwd > 0 && Math.acos(Math.min(1, fwd / Math.max(1e-6, dist))) <= d.half + Math.atan2(hr, Math.max(dist, 0.5)); break;
      case 'tail': inside = dist <= d.reach + hr && fwd <= 0.5; break;
      case 'disc': {
        ax = this.x + this.forwardX() * 2.0; az = this.z + this.forwardZ() * 2.0;
        inside = Math.hypot(h.x - ax, h.z - az) <= d.reach + hr; break;
      }
      case 'dome': inside = dist <= this.dome.r + hr; break;
      default: inside = false;
    }
    if (!inside) return;
    this.hitDone = true;
    this._deliver(h, d, this.verb, this.actionId * 16, ax, az, d.dmg, 'body');
  }

  // Resolve defence and hand the contact to the hero exactly once per contactId.
  _deliver(h, d, verb, contactId, ax, az, dmgFull, src) {
    const res = resolveGauntletDefence(d, h, ax, az);
    const R = this.rec;
    R.actionId = contactId; R.targetId = h.id; R.verb = verb; R.outcome = res.outcome; R.perfect = res.perfect; R.effect = res.effect;
    R.art = 0; R.frame = this.simFrame; R.slide = 0;
    let dmg = 0, pos = 0;
    if (res.outcome === Outcome.HIT) { dmg = dmgFull; pos = dmgFull; }
    else if (res.outcome === Outcome.BLOCKED) {
      dmg = Math.round(dmgFull * G_DEFENCE.CHIP);
      pos = Math.round(dmgFull * G_DEFENCE.BLOCK_STAMINA * 2);     // hero takes posture * 0.5 as stamina
      R.slide = 0.4;
    } else if (res.outcome === Outcome.GUARDBREAK) { dmg = Math.round(dmgFull * 0.5); pos = 0; }
    else if (res.outcome === Outcome.PARRIED) {
      const gain = Math.round(d.jgPosture * (res.perfect ? G_DEFENCE.JG_PERFECT_MUL : 1));
      this.posture = Math.min(GAUNTLET.POSTURE_MAX, this.posture + gain); this.jgCount++;
      if (this.posture >= GAUNTLET.POSTURE_MAX) this._postureBreak();
    }
    R.damage = dmg; R.posture = pos;
    R.pos.x = h.x; R.pos.y = 1.1; R.pos.z = h.z;
    const tx = ax - h.x, tz = az - h.z, tl = Math.hypot(tx, tz) || 1;
    R.normal.x = -tx / tl; R.normal.y = 0.2; R.normal.z = -tz / tl;
    R.surface = Surface.BLADE; R.tx = h.x; R.tz = h.z;
    if (res.outcome !== Outcome.WHIFF_IFRAME) this.contacts++;
    if (this.logOn) this.log.push([this.simFrame, 'contact', verb, res.outcome, src, dmg]);
    if (this.heroSink) this.heroSink(R);
    this._emitContact(R);
  }

  _pushHero(h, reach, strength) {
    const dx = h.x - this.x, dz = h.z - this.z, l = Math.hypot(dx, dz);
    if (l > reach + (h.radius || SIM.CAPSULE_RADIUS) || l < 1e-6) return;
    h.pushX += dx / l * strength; h.pushZ += dz / l * strength;
  }

  _endAction() {
    const v = this.verb;
    this.lastVerb = v; this.dome.active = false; this.y = 0;
    this._emitAction('action/end', Phase.RECOVERY);
    // enraged chains (spec section 4): sweep L -> fast sweep R; slam -> lightning (cooldown permitting)
    if (this.phase >= 2 && this.chain < 0) {
      if (v === GV.G_SWEEP_L) { this.chain = v; this._startVerb(GV.G_SWEEP_R, CHAIN_SWEEP_R); return; }
      if (v === GV.G_SLAM && this.cool[GV.G_LIGHTNING] <= this.simFrame) { this.chain = v; this._startVerb(GV.G_LIGHTNING); return; }
    }
    this.chain = -1;
    this.state = G_STATE.HOLD; this.f = 0; this.holdF = HOLD_F;
  }

  _hold() {
    this.f++;
    this.anim.clip = 'idle'; this.anim.time = (this.f % 120) / 60; this.anim.loop = true;
    if (this.f < this.holdF) return;
    this.state = G_STATE.WAIT; this.f = 0;
    const w = G_PHASES[this.phase].wait; this.waitF = Math.round(this.rng.range(w[0], w[1]));
  }

  // ---------------- roar / enrage ----------------
  _startRoar(intro) {
    if (this.pendingPhase) { this.phase = this.pendingPhase; this.pendingPhase = 0; }
    this.invuln = true; this.chain = -1;
    this._startVerb(GV.G_ROAR, VERBS_P1[GV.G_ROAR]);
    if (this.bus) { const p = this.bus.payload('boss/phase'); p.actorId = this.actorId; p.phase = this.phase; p.stance = 0; p.intro = intro; this.bus.dispatch('boss/phase'); }
    if (this.logOn) this.log.push([this.simFrame, 'phase', this.phase, intro ? 1 : 0]);
  }

  _roar(h) {
    this.f++;
    this.anim.clip = 'roar'; this.anim.time = this.f / 60; this.anim.loop = false;
    if (this.f === this.def.active[0]) this._pushHero(h, this.def.reach, 1.5);
    if (this.f >= ROAR_F) { this.invuln = false; this.lastVerb = GV.G_ROAR; this.state = G_STATE.HOLD; this.f = 0; this.holdF = 12; }
  }

  // ---------------- incoming damage (hero -> boss) ----------------
  // part: 'body' | 'head' | 'core'. Contact dedupe is the hero side's job (stable actionId per swing).
  takeHit(dmg, posture, part = 'body', fromFinisher = false) {
    if (this.state === G_STATE.DEAD) return 0;
    if (!fromFinisher && (this.invuln || this.finisherF >= 0)) return 0;
    const mul = part === 'head' ? 1.5 : part === 'core' ? 1.25 : 1;
    const d = Math.round(dmg * mul);
    this.hp = Math.max(0, this.hp - d);
    if (this.state !== G_STATE.STAGGER) this.posture = Math.min(GAUNTLET.POSTURE_MAX, this.posture + posture * (part === 'head' ? 2 : 1));
    if (this.hp <= 0) { this._die(); return d; }
    if (this.phase === 1 && this.hp / GAUNTLET.HP <= GAUNTLET.ENRAGE_FRAC && !this.pendingPhase) this.pendingPhase = 2;
    if (this.posture >= GAUNTLET.POSTURE_MAX) this._postureBreak();
    return d;
  }

  // Which hurt part a hero swing from (hx, hz) lands on.
  hitPart(hx, hz) {
    const G = GAUNTLET, fx = this.forwardX(), fz = this.forwardZ();
    if (this.coreOpen && Math.hypot(hx - (this.x + fx * G.CORE_AHEAD), hz - (this.z + fz * G.CORE_AHEAD)) < G.CORE_RADIUS + 1.0) return 'core';
    if (Math.hypot(hx - (this.x + fx * G.HEAD_AHEAD), hz - (this.z + fz * G.HEAD_AHEAD)) < G.HEAD_RADIUS + 0.9) return 'head';
    return 'body';
  }

  _postureBreak() {
    if (this.state === G_STATE.STAGGER || this.state === G_STATE.DEAD) return;
    if (this.state === G_STATE.ACTION) this._emitAction('action/end', Phase.RECOVERY);
    this.dome.active = false; this.y = 0; this.chain = -1;
    this.state = G_STATE.STAGGER; this.f = 0; this.staggerLeft = G_DEFENCE.STAGGER_F;
    if (this.bus) { const p = this.bus.payload('combat/guardbreak'); p.actorId = this.actorId; this.bus.dispatch('combat/guardbreak'); }
    if (this.logOn) this.log.push([this.simFrame, 'break', 0, 0]);
  }

  _stagger() {
    this.f++;
    this.anim.loop = this.f > STAGGER_HIT_F;
    this.anim.clip = this.f <= STAGGER_HIT_F ? 'hit' : 'down'; this.anim.time = (this.f <= STAGGER_HIT_F ? this.f : (this.f - STAGGER_HIT_F) % 120) / 60;
    if (this.f >= this.staggerLeft) { this.posture = 0; this.state = G_STATE.HOLD; this.f = 0; this.holdF = 24; }
  }

  _die() {
    this.wave.active = false; this.dome.active = false; this.y = 0;
    for (const c of this.cols) c.left = 0;
    this.state = G_STATE.DEAD; this.f = 0;
    if (this.logOn) this.log.push([this.simFrame, 'death', 0, 0]);
    if (this.bus) { const p = this.bus.payload('actor/death'); p.actorId = this.actorId; p.kind = ActorKind.GAUNTLET; p.killerId = 0; this.bus.dispatch('actor/death'); }
  }

  // ---------------- finisher ----------------
  canFinish(h) {
    if (this.finisherF >= 0 || this.state !== G_STATE.STAGGER) return false;
    const hx = this.x + this.forwardX() * GAUNTLET.HEAD_AHEAD, hz = this.z + this.forwardZ() * GAUNTLET.HEAD_AHEAD;
    return Math.hypot(h.x - hx, h.z - hz) <= G_DEFENCE.FINISHER_RANGE;
  }
  startFinisher(h) {
    if (!this.canFinish(h)) return false;
    this.finisherF = 0; this.finisherHits = 0; this.invuln = true;
    return true;
  }
  _finisherStep(h) {
    this.finisherF++; h.invuln = true;
    this.anim.clip = this.finisherF < FINISHER_HIT_F ? 'down' : 'hit'; this.anim.loop = false;
    this.anim.time = (this.finisherF < FINISHER_HIT_F ? this.finisherF % 120 : this.finisherF - FINISHER_HIT_F) / 60;
    if (this.finisherF === FINISHER_HIT_F) { this.takeHit(FINISHER_DMG, 0, 'head', true); this.finisherHits++; this.contacts++; }
    if (this.finisherF >= FINISHER_F) {
      this.finisherF = -1; this.invuln = false; h.invuln = false;
      if (this.state === G_STATE.STAGGER) { this.posture = 0; this.state = G_STATE.HOLD; this.f = 0; this.holdF = 30; }
    }
  }

  // ---------------- arena ----------------
  _clampAndPush(h) {
    const c = GAUNTLET.CLAMP;
    if (this.colliders && this.y < 0.5) {
      const r = this.colliders.resolveCapsule(this.x, this.z, GAUNTLET.BODY_RADIUS, 0.3, 2.0);
      this.x = r.x; this.z = r.z;
    }
    if (this.x > c) this.x = c; else if (this.x < -c) this.x = -c;
    if (this.z > c) this.z = c; else if (this.z < -c) this.z = -c;
    if (this.y > 1.5 || this.state === G_STATE.DEAD) return;
    const dx = h.x - this.x, dz = h.z - this.z, l = Math.hypot(dx, dz), min = GAUNTLET.BODY_RADIUS + (h.radius || SIM.CAPSULE_RADIUS);
    if (l < min) { const k = l > 1e-6 ? 1 / l : 0; h.pushX += (dx * k || 1) * (min - l); h.pushZ += dz * k * (min - l); }
  }

  // ---------------- events ----------------
  _emitAction(id, phase) {
    if (!this.bus) return;
    const p = this.bus.payload(id);
    p.actorId = this.actorId; p.actionId = this.actionId; p.verb = this.verb; p.phase = phase; p.frame = this.f; p.boss = true; p.reason = 'complete';
    this.bus.dispatch(id);
  }
  _emit(id, lead) {
    if (!this.bus) return;
    const p = this.bus.payload(id);
    p.actorId = this.actorId; p.actionId = this.actionId; p.verb = this.verb; p.leadFrames = lead; p.art = 0; p.boss = true;
    this.bus.dispatch(id);
  }
  _emitContact(R) {
    if (!this.bus) return;
    const p = this.bus.payload('combat/contact');
    p.actionId = R.actionId; p.attackerId = this.actorId; p.targetId = R.targetId; p.verb = R.verb; p.outcome = R.outcome;
    p.damage = R.damage; p.posture = R.posture; p.pos = R.pos; p.normal = R.normal; p.surface = R.surface; p.boss = true;
    p.perfect = R.perfect; p.effect = R.effect; p.art = 0;
    this.bus.dispatch('combat/contact');
    if (R.outcome === Outcome.PARRIED) {
      const q = this.bus.payload('combat/parry');
      q.defenderId = R.targetId; q.attackerId = this.actorId; q.actionId = R.actionId; q.pos = R.pos; q.perfect = R.perfect;
      this.bus.dispatch('combat/parry');
    }
  }

  // ---------------- determinism ----------------
  hash(h = 2166136261) {
    const q = (v) => { h = Math.imul(h ^ (Math.round(v * 1000) | 0), 16777619) >>> 0; };
    q(this.x); q(this.y); q(this.z); q(this.yaw); q(this.hp); q(this.posture); q(this.phase); q(this.state); q(this.f);
    q(this.verb); q(this.actionId); q(this.contacts); q(this.rng.s[0]); q(this.rng.s[3]);
    q(this.wave.active ? this.wave.r : -1); for (const c of this.cols) { q(c.left); q(c.x); q(c.z); }
    return h >>> 0;
  }

  dispose() { this.heroSink = null; this.telegraphSink = null; this.bus = null; this.colliders = null; }
}
