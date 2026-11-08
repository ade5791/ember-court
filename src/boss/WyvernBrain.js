// WyvernBrain - simulation side of the Ford Wyvern (CINEMATIC_SPEC section 9). Deterministic: fixed-step only,
// randomness from the seeded 'boss' stream, no reads of presentation state (bone positions, mixer time).
// Owns root XZ, yaw, flight height, HP, posture, phase, the verb state machine and contact resolution.
// Presentation reads this.anim ({ clip, time, loop }) and the pose; it never writes back.
//
// Frame data is the 9.2 table (60 Hz). Every verb: PREROLL (clip frozen at frame 0, telegraph fired) ->
// STARTUP -> ACTIVE -> RECOVERY (clip tail) -> HOLD (>= 36 f after a RED/BLUE art, 12 f otherwise) -> WAIT
// (phase spacing). Contacts are applied once per (actionId, target).
import { SIM, BOSS } from '../shared/constants.js';
import { BossStance, BossVerb, Outcome, Surface, ActorKind, Phase } from '../shared/enums.js';

export const ART = Object.freeze({ NORMAL: 0, RED: 1, BLUE: 2 });
export const BRAIN_STATE = Object.freeze({ WAIT: 0, PREROLL: 1, ACTION: 2, HOLD: 3, ROAR: 4, TAKEOFF: 5, HOVER: 6,
  STAGGER: 7, FALL: 8, DEAD: 9 });
export const BRAIN_STATE_NAMES = Object.freeze(['WAIT', 'PREROLL', 'ACTION', 'HOLD', 'ROAR', 'TAKEOFF', 'HOVER', 'STAGGER', 'FALL', 'DEAD']);

// shape: 'front' (planar reach + half-angle cone), 'tail' (side half-plane within reach), 'cone' (breath),
// 'ring' (radius around root), 'swoop' (radius around root while diving), 'orb' (projectile), 'none'
export const VERBS = Object.freeze({
  [BossVerb.W_BITE]: { name: 'W_BITE', clip: 'bite', stance: BossStance.GROUND_UP, pre: 0, active: [39, 50], total: 50, shape: 'front', reach: 3.8, half: 0.6, art: ART.NORMAL, dmg: 22, posture: 30 },
  [BossVerb.W_LUNGE]: { name: 'W_LUNGE', clip: 'bite_low', stance: BossStance.GROUND_LOW, pre: 0, active: [30, 38], total: 60, shape: 'front', reach: 4.9, half: 0.5, art: ART.NORMAL, dmg: 26, posture: 34, clipActive: [3, 8] },
  [BossVerb.W_CHARGE]: { name: 'W_CHARGE', clip: 'charge_bite', stance: BossStance.GROUND_LOW, pre: 0, active: [33, 40], total: 60, shape: 'front', reach: 4.2, half: 0.55, art: ART.RED, dmg: 34, posture: 0, travel: 6.0, travelSpeed: 6.0 },
  [BossVerb.W_TAIL_L]: { name: 'W_TAIL_L', clip: 'tail_l', stance: BossStance.GROUND_UP, pre: 24, active: [17, 38], total: 102, shape: 'tail', side: -1, reach: 5.0, art: ART.RED, dmg: 30, posture: 0 },
  [BossVerb.W_TAIL_R]: { name: 'W_TAIL_R', clip: 'tail_r', stance: BossStance.GROUND_UP, pre: 24, active: [17, 38], total: 100, shape: 'tail', side: 1, reach: 5.0, art: ART.RED, dmg: 30, posture: 0 },
  [BossVerb.W_SPIT]: { name: 'W_SPIT', clip: 'spit', stance: BossStance.GROUND_UP, pre: 0, active: [23, 23], total: 50, shape: 'orb', art: ART.NORMAL, dmg: 18, posture: 20 },
  [BossVerb.W_HAZE]: { name: 'W_HAZE', clip: 'haze_breath', stance: BossStance.GROUND_UP, pre: 0, active: [59, 82], total: 146, shape: 'cone', reach: 6.8, half: 20 * Math.PI / 180, art: ART.RED, dmg: 6, posture: 0, pool: { r: 2.2, ahead: 3.8, frames: 240 } },
  [BossVerb.W_SWOOP]: { name: 'W_SWOOP', clip: 'swoop', stance: BossStance.AIR, pre: 30, active: [25, 32], total: 60, shape: 'swoop', reach: 1.9, art: ART.BLUE, dmg: 32, posture: 0 },
  [BossVerb.W_SKY_HAZE]: { name: 'W_SKY_HAZE', clip: 'hover_haze', stance: BossStance.AIR, pre: 0, active: [21, 32], total: 148, shape: 'none', art: ART.RED, dmg: 6, posture: 0, pool: { r: 3.5, ahead: 4.0, frames: 240, from: 32 } },
  [BossVerb.W_LAND]: { name: 'W_LAND', clip: 'land', stance: BossStance.AIR, pre: 0, active: [23, 26], total: 54, shape: 'ring', reach: 3.3 + SIM.CAPSULE_RADIUS, art: ART.NORMAL, dmg: 0, posture: 30 },
  [BossVerb.W_ROAR]: { name: 'W_ROAR', clip: 'hit', stance: -1, pre: 0, active: [20, 20], total: 83, shape: 'push', reach: 3.8, art: ART.NORMAL, dmg: 0, posture: 0, clipRate: 0.6 },
});
export const RED_VERBS = Object.freeze([BossVerb.W_CHARGE, BossVerb.W_TAIL_L, BossVerb.W_TAIL_R, BossVerb.W_HAZE, BossVerb.W_SKY_HAZE]);

export const PHASES = Object.freeze([
  null,
  { hpAbove: 0.60, wait: [70, 100], air: 0.0, low: 0.30, poolFrames: 240, decay: 8 },
  { hpAbove: 0.25, wait: [50, 80], air: 0.5, low: 0.30, poolFrames: 240, decay: 8 },
  { hpAbove: -1, wait: [30, 50], air: 0.3, low: 0.30, poolFrames: 360, decay: 12 },
]);

export const DEFENCE = Object.freeze({
  DEFLECT_PERFECT: [2, 5], DEFLECT_NORMAL: [6, 9], IFRAMES: [3, 16], PERFECT_STEP: [3, 8],
  RED_COUNTER_F: 30, BLUE_BACKSTAB_F: 40, BLOCK_CHIP_SPIT: 0.15, STAGGER_F: 150, FINISHER_RANGE: 3.0,
});

// Pure defence resolution (fixture-testable, C1/C2). hero fields: invuln, dodgeF (frames into dodge, -1 none),
// deflectF (frames since block press, -1 none), blocking, stepToward (step direction dot toward attacker, -1..1).
// Returns { outcome, perfect, effect } with effect in 'none'|'slip'|'behind'|'reflect'|'phantom'.
const _res = { outcome: 0, perfect: false, effect: 'none' };
export function resolveDefence(art, hero, isOrb = false, out = _res) {
  out.perfect = false; out.effect = 'none';
  const D = DEFENCE;
  if (hero.invuln) { out.outcome = Outcome.WHIFF_IFRAME; return out; }
  const dF = hero.dodgeF;
  if (dF >= D.IFRAMES[0] && dF <= D.IFRAMES[1]) {
    out.outcome = Outcome.WHIFF_IFRAME;
    if (dF <= D.PERFECT_STEP[1]) {
      out.perfect = true;
      if (art === ART.RED) out.effect = 'slip';
      else if (art === ART.BLUE) out.effect = hero.stepToward > 0.5 ? 'behind' : 'phantom';
      else out.effect = 'phantom';
    }
    return out;
  }
  const pF = hero.deflectF;
  if (art === ART.NORMAL && pF >= D.DEFLECT_PERFECT[0] && pF <= D.DEFLECT_NORMAL[1]) {
    out.outcome = Outcome.PARRIED; out.perfect = pF <= D.DEFLECT_PERFECT[1];
    if (isOrb) { if (out.perfect) out.effect = 'reflect'; else out.outcome = Outcome.BLOCKED; }
    return out;
  }
  if (hero.blocking || (pF >= 0 && pF <= D.DEFLECT_NORMAL[1] + 1 && art === ART.BLUE)) {
    if (art === ART.RED) { out.outcome = Outcome.HIT; return out; }
    out.outcome = Outcome.BLOCKED;           // BLUE: the caller applies full posture (block "takes full posture")
    return out;
  }
  out.outcome = Outcome.HIT;
  return out;
}

const TAU = Math.PI * 2;
function wrapAngle(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }

const CLAMP = SIM.ARENA_HALF - 4.6;          // boss XZ <= 11.4: spread wings (land/takeoff/swoop) reach 4.2 m; 12.0 clipped the wall by 0.19 m
const CORNER_CUT = 1.2;                       // chamfer on the clamp square (see _clampAndPush)
const WALK_SPEED = 2.2, TURN_RATE = 2.4, FLY_SPEED = 7.0;
const HOVER_Y = 6.0;                         // cruise root height (>= BOSS.HOVER_Y 4.65)
const TAKEOFF_F = 68, LAND_DESCENT_F = 23, ROAR_F = 83, AIR_FALL_F = 40, CRASH_F = 70, STAGGER_HIT_F = 50;
const FINISHER_F = 96, FINISHER_HIT_F = 60, FINISHER_DMG = 160;
const POOL_SLOTS = 3, TICK_F = 15;           // pools/breath tick 4/s

export class WyvernBrain {
  static id = 'boss';
  static deps = ['world'];

  // rng: a forked Rng stream ('boss'); colliders optional (boulder push-out); bus optional
  init(ctx, { rng, colliders = null, bus = null, actorId = 100 }) {
    this.ctx = ctx; this.rng = rng; this.colliders = colliders; this.bus = bus; this.actorId = actorId;
    this.x = BOSS.SPAWN[0]; this.z = BOSS.SPAWN[2]; this.y = 0; this.yaw = 0;   // yaw 0 faces -Z (toward... north)
    this.yaw = Math.PI;                                                          // spawn facing +Z (the player bank)
    this.hp = BOSS.HP; this.posture = 0; this.phase = 1; this.pendingPhase = 0; this.forceNext = -1;
    this.stance = BossStance.GROUND_UP;
    this.state = BRAIN_STATE.WAIT; this.f = 0; this.waitF = 60;
    this.verb = -1; this.def = null; this.actionId = 0; this.hitDone = false; this.lastVerb = -1; this.lastRed = -1;
    this.airLeft = 0; this.invuln = false; this.chainBite = false;
    this.travelLeft = 0; this.tick = 0; this.simFrame = 0;
    this.swoop = { sx: 0, sz: 0, ex: 0, ez: 0, dx: 0, dz: 0, speed: 14 / 60, startY: HOVER_Y };
    this.pools = []; for (let i = 0; i < POOL_SLOTS; i++) this.pools.push({ x: 0, z: 0, r: 0, left: 0, id: 0 });
    this.orb = { active: false, x: 0, y: 0, z: 0, vx: 0, vz: 0, dist: 0, reflected: false, id: 0 };
    this.backstabUntil = -1; this.counterUntil = -1;
    this.finisherF = -1; this.finisherHits = 0; this.staggerLeft = 0; this.fallStage = 0;
    this.anim = { clip: 'idle', time: 0, loop: true };
    this.contacts = 0;                          // total contacts emitted (harness)
    this.heroSink = null;                       // (rec) => void, hero applies the contact
    this.rec = { actionId: 0, attackerId: actorId, targetId: 0, verb: 0, outcome: 0, damage: 0, posture: 0, art: 0,
      effect: 'none', perfect: false, pos: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, surface: Surface.FLESH, tx: 0, tz: 0, frame: 0 };
    this.telegraphSink = null;                  // (verb, art, leadFrames) presentation hook (fx aura)
    this.log = [];                              // compact event log for fixtures: [frame, kind, a, b]
    this.logOn = false;
    this._cands = [];
    this._lastHero = { x: 0, z: 0 };
    return this;
  }

  get airborne() { return this.stance === BossStance.AIR; }
  forwardX() { return -Math.sin(this.yaw); }
  forwardZ() { return -Math.cos(this.yaw); }

  // Intro (9.6): starts high above the ford, lands into W_ROAR.
  startIntro() {
    this.stance = BossStance.AIR; this.y = 9.0; this.x = 0; this.z = -9; this._landFrom = 9.0;
    this._startVerb(BossVerb.W_LAND); this.introRoar = true;
  }

  // ---------------- per fixed step ----------------
  fixedUpdate(hero, simFrame) {
    this.simFrame = simFrame;
    this._lastHero.x = hero.x; this._lastHero.z = hero.z;
    if (this.finisherF >= 0) { this._finisherStep(hero); this._setAnimFinisher(); return; }
    this._decayPosture();
    this._stepPools(hero);
    this._stepOrb(hero);
    switch (this.state) {
      case BRAIN_STATE.WAIT: this._wait(hero); break;
      case BRAIN_STATE.PREROLL: this._preroll(hero); break;
      case BRAIN_STATE.ACTION: this._action(hero); break;
      case BRAIN_STATE.HOLD: this._hold(hero); break;
      case BRAIN_STATE.ROAR: this._roar(hero); break;
      case BRAIN_STATE.TAKEOFF: this._takeoff(hero); break;
      case BRAIN_STATE.HOVER: this._hover(hero); break;
      case BRAIN_STATE.STAGGER: this._stagger(hero); break;
      case BRAIN_STATE.FALL: this._fall(hero); break;
      case BRAIN_STATE.DEAD: this.f++; this.anim.clip = 'death'; this.anim.time = Math.min(this.f, 94) / 60; this.anim.loop = false; break;
    }
    this._clampAndPush(hero);
  }

  _decayPosture() {
    if (this.state === BRAIN_STATE.STAGGER || this.state === BRAIN_STATE.FALL) return;
    this.posture = Math.max(0, this.posture - PHASES[this.phase].decay / 60);
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
    this._turnToward(h.x, h.z, TURN_RATE);
    const low = this.stance === BossStance.GROUND_LOW;
    let moving = false;
    if (dist > 4.8) { const s = WALK_SPEED / 60 / dist; this.x += dx * s; this.z += dz * s; moving = true; }
    this.anim.clip = moving ? (low ? 'walk' : 'walk_up') : (low ? 'idle_low' : 'idle');
    this.anim.time = (this.f % (moving ? 60 : 120)) / 60; this.anim.loop = true;
    if (this.pendingPhase) { this._startRoar(); return; }
    if (this.f >= this.waitF) this._choose(h, dist);
  }

  _choose(h, dist) {
    const P = PHASES[this.phase], r = this.rng;
    // review fixture: one-shot forced ground verb (never set in play; no RNG draw so it cannot skew seeded runs)
    if (this.forceNext >= 0) { const fv = this.forceNext; this.forceNext = -1; this._startVerb(fv); return; }
    if (this.phase >= 2 && this.lastVerb !== -1 && r.float() < P.air) { this._startTakeoff(); return; }
    // side of the hero relative to boss facing
    const dx = h.x - this.x, dz = h.z - this.z, fwd = dx * this.forwardX() + dz * this.forwardZ();
    const right = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
    const cands = this._cands; cands.length = 0;
    const add = (v, w) => { if (RED_VERBS.indexOf(v) >= 0 && v === this.lastRed) return; if (v === BossVerb.W_CHARGE && this.lastVerb === BossVerb.W_SPIT) return; cands.push(v, w); };
    if (fwd < 0.3 * dist && dist < 5.0) add(right > 0 ? BossVerb.W_TAIL_R : BossVerb.W_TAIL_L, 6);
    if (dist <= 4.2) { add(BossVerb.W_BITE, 5); add(BossVerb.W_LUNGE, 2); }
    else if (dist <= 5.8) { add(BossVerb.W_LUNGE, 5); add(BossVerb.W_BITE, 1); if (this.phase >= 2) add(BossVerb.W_HAZE, 3); }
    else { add(BossVerb.W_SPIT, 4); add(BossVerb.W_CHARGE, 3); if (this.phase >= 2) add(BossVerb.W_HAZE, 2); }
    if (cands.length === 0) add(BossVerb.W_SPIT, 1);
    if (cands.length === 0) add(BossVerb.W_BITE, 1);
    let tot = 0; for (let i = 1; i < cands.length; i += 2) tot += cands[i];
    let pick = r.float() * tot, v = cands[0];
    for (let i = 0; i < cands.length; i += 2) { pick -= cands[i + 1]; if (pick <= 0) { v = cands[i]; break; } }
    this._startVerb(v);
  }

  _startVerb(v) {
    const d = VERBS[v];
    this.verb = v; this.def = d; this.actionId++; this.hitDone = false; this.tick = 0; this.f = 0;
    if (d.stance >= 0) this.stance = d.stance;
    this.travelLeft = d.travel || 0;
    if (v === BossVerb.W_SWOOP) this._planSwoop();
    this.state = d.pre > 0 ? BRAIN_STATE.PREROLL : BRAIN_STATE.ACTION;
    const lead = d.pre + d.active[0];
    if (this.telegraphSink && v !== BossVerb.W_ROAR) this.telegraphSink(v, d.art, lead);
    if (v !== BossVerb.W_ROAR) this._emitTelegraph(v, lead);
    this._emitAction('action/start', Phase.STARTUP);
    if (this.logOn) this.log.push([this.simFrame, 'start', v, lead]);
  }

  _planSwoop() {
    // straight line through the hero's telegraph-time position, entering from the boss side; no homing afterwards
    const h = this._lastHero, S = this.swoop;
    let dx = h.x - this.x, dz = h.z - this.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    S.dx = dx; S.dz = dz; S.speed = 14 / 60;
    const pre = S.speed * 28;                       // talons reach the hero position at frame 28 (active 25-32)
    S.sx = h.x - dx * pre; S.sz = h.z - dz * pre; S.ex = h.x + dx * (14 - pre); S.ez = h.z + dz * (14 - pre);
    S.startY = this.y;
  }

  _preroll(h) {
    const d = this.def; this.f++;
    if (this.verb === BossVerb.W_SWOOP) {
      // 30 f circle-in: glide from the current point to the dive start (straight, smoothed)
      const S = this.swoop, u = this.f / d.pre, k = u * u * (3 - 2 * u);
      this.x += (S.sx - this.x) * Math.min(1, k * 0.35 + 0.05); this.z += (S.sz - this.z) * Math.min(1, k * 0.35 + 0.05);
      this._turnToward(S.ex, S.ez, 6.0);
      this.anim.clip = 'glide'; this.anim.time = (this.f % 120) / 60; this.anim.loop = true;
    } else {
      // tail pre-roll: frozen first frame, yaw HELD - turning to face the hero would carry them out of the sweep
      this.anim.clip = d.clip; this.anim.time = 0; this.anim.loop = false;
    }
    if (this.f >= d.pre) { this.state = BRAIN_STATE.ACTION; this.f = 0; if (this.verb === BossVerb.W_SWOOP) { this.x = this.swoop.sx; this.z = this.swoop.sz; } }
  }

  // verb frame -> clip frame (piecewise warp so the clip's measured active window lands on the verb's active window)
  _clipFrame(d, f) {
    const a0 = d.active[0], a1 = d.active[1], ca = d.clipActive || d.active, ct = d.clipTotal || d.total;
    if (f <= a0) return a0 > 0 ? f / a0 * ca[0] : ca[0];
    if (f <= a1) return a1 > a0 ? ca[0] + (f - a0) / (a1 - a0) * (ca[1] - ca[0]) : ca[1];
    const rest = d.total - a1;
    return rest > 0 ? ca[1] + (f - a1) / rest * (ct - ca[1]) : ct;
  }

  _action(h) {
    const d = this.def, v = this.verb; this.f++;
    const f = this.f;
    this.anim.clip = d.clip; this.anim.loop = false;
    this.anim.time = this._clipFrame(d, f) * (d.clipRate || 1) / 60;
    if (f === d.active[0]) this._emitAction('action/phase', Phase.ACTIVE);
    if (f === d.active[1] + 1) this._emitAction('action/phase', Phase.RECOVERY);
    // movement per verb
    if (v === BossVerb.W_CHARGE) {
      if (f < d.active[0] && this.travelLeft > 0) {          // committed charge line: aim locked after frame 6
        if (f < 6) this._turnToward(h.x, h.z, 6.0);
        const s = Math.min(this.travelLeft, d.travelSpeed / 60);
        this.x += this.forwardX() * s; this.z += this.forwardZ() * s; this.travelLeft -= s;
      }
    } else if (v === BossVerb.W_SWOOP) {
      const S = this.swoop;
      this.x += S.dx * S.speed; this.z += S.dz * S.speed;
      const u = f / d.total;                                   // dive to 0.6 m at frame 28, climb back out
      const k = f <= 28 ? f / 28 : 1 - (f - 28) / (d.total - 28);
      this.y = S.startY + (0.6 - S.startY) * Math.sin(Math.min(1, Math.max(0, k)) * Math.PI / 2);
      if (u >= 1) this.y = S.startY;
    } else if (v === BossVerb.W_LAND) {
      if (f <= LAND_DESCENT_F) { const u = f / LAND_DESCENT_F; this.y = this._landFrom * (1 - u * u); }
      else this.y = 0;
    } else if (v === BossVerb.W_SKY_HAZE || v === BossVerb.W_HAZE) {
      if (f < d.active[0]) this._turnToward(h.x, h.z, TURN_RATE * 0.8);
    } else if (d.shape !== 'tail' && f < Math.max(4, d.active[0] - 12)) this._turnToward(h.x, h.z, TURN_RATE);   // tracking ends 12 f before contact
    if (v === BossVerb.W_LAND && f === LAND_DESCENT_F) this.stance = BossStance.GROUND_UP;

    // contact resolution inside the active window only (C9)
    if (f >= d.active[0] && f <= d.active[1]) this._contact(h, d, f);
    // haze pools
    if (d.pool && f === (d.pool.from || d.active[1] + 1)) {
      const P = PHASES[this.phase];
      this._spawnPool(this.x + this.forwardX() * d.pool.ahead, this.z + this.forwardZ() * d.pool.ahead, d.pool.r, v === BossVerb.W_HAZE ? P.poolFrames : d.pool.frames);
    }
    if (f >= d.total) this._endAction();
  }

  _contact(h, d, f) {
    const v = this.verb;
    if (d.shape === 'orb') { if (f === d.active[0]) this._spawnOrb(h); return; }
    if (d.shape === 'push') { if (f === d.active[0]) this._pushHero(h, d.reach, 1.5); return; }
    const ticking = d.shape === 'cone';
    if (!ticking && this.hitDone) return;
    if (ticking && ((f - d.active[0]) % TICK_F) !== 0) return;
    if (h.y > 1.0) return;                                   // hero never airborne in v2, guard anyway
    const dx = h.x - this.x, dz = h.z - this.z, dist = Math.hypot(dx, dz);
    const fx = this.forwardX(), fz = this.forwardZ();
    const fwd = dx * fx + dz * fz, right = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
    const hr = h.radius || SIM.CAPSULE_RADIUS;
    let inside = false;
    switch (d.shape) {
      case 'front': inside = dist <= d.reach + hr && fwd > 0 && Math.acos(Math.min(1, fwd / Math.max(1e-6, dist))) <= d.half + Math.atan2(hr, Math.max(dist, 0.5)); break;
      case 'tail': inside = dist <= d.reach + hr && right * d.side >= -0.6 && fwd <= 1.6; break;
      case 'cone': inside = dist <= d.reach && fwd > 0 && Math.acos(Math.min(1, fwd / Math.max(1e-6, dist))) <= d.half; break;
      case 'ring': inside = dist <= d.reach; break;
      case 'swoop': inside = dist <= d.reach + hr && this.y < 2.0; break;
      default: inside = false;
    }
    if (!inside) return;
    this.hitDone = true;
    this._deliver(h, d, v, ticking ? this.actionId * 16 + ((f - d.active[0]) / TICK_F | 0) : this.actionId * 16, false);
  }

  // Resolve defence and hand the contact to the hero sink exactly once per id.
  _deliver(h, d, verb, contactId, isOrb, ox = 0, oy = 0, oz = 0) {
    const toBx = this.x - h.x, toBz = this.z - h.z, tl = Math.hypot(toBx, toBz) || 1;
    h.stepToward = h.dodgeF >= 0 ? (h.stepDirX * toBx + h.stepDirZ * toBz) / tl : 0;
    const res = resolveDefence(d.art, h, isOrb);
    const R = this.rec;
    R.actionId = contactId; R.targetId = h.id; R.verb = verb; R.outcome = res.outcome; R.perfect = res.perfect; R.effect = res.effect;
    R.art = d.art; R.frame = this.simFrame;
    let dmg = 0, pos = 0;
    if (res.outcome === Outcome.HIT) { dmg = d.dmg; pos = d.posture; }
    else if (res.outcome === Outcome.BLOCKED) {
      if (isOrb) dmg = Math.round(d.dmg * DEFENCE.BLOCK_CHIP_SPIT);
      pos = d.art === ART.BLUE ? 100 : d.posture;
      if (verb === BossVerb.W_LAND) pos = d.posture;
    } else if (res.outcome === Outcome.PARRIED) {
      this.posture = Math.min(BOSS.POSTURE_MAX, this.posture + (res.perfect ? 60 : 35));
      if (this.posture >= BOSS.POSTURE_MAX) this._postureBreak();
    }
    R.damage = dmg; R.posture = pos;
    if (isOrb) { R.pos.x = ox; R.pos.y = oy; R.pos.z = oz; } else { R.pos.x = h.x; R.pos.y = 1.1; R.pos.z = h.z; }
    R.normal.x = -toBx / tl; R.normal.y = 0.2; R.normal.z = -toBz / tl;
    R.surface = Surface.FLESH;
    // defence side effects owned by the boss
    R.tx = h.x; R.tz = h.z;
    if (res.effect === 'slip') {                              // RED perfect step: to the attacker's flank
      const side = (h.x - this.x) * Math.cos(this.yaw) - (h.z - this.z) * Math.sin(this.yaw) >= 0 ? 1 : -1;
      R.tx = this.x + Math.cos(this.yaw) * side * 3.2; R.tz = this.z - Math.sin(this.yaw) * side * 3.2;
      this.counterUntil = this.simFrame + DEFENCE.RED_COUNTER_F;
    } else if (res.effect === 'behind') {                     // BLUE perfect step forward: teleport behind
      R.tx = this.x - this.forwardX() * 4.4; R.tz = this.z - this.forwardZ() * 4.4;
      this.backstabUntil = this.simFrame + DEFENCE.BLUE_BACKSTAB_F;
    }
    if (res.effect !== 'none' || res.outcome !== Outcome.WHIFF_IFRAME) this.contacts++;
    if (this.logOn) this.log.push([this.simFrame, 'contact', verb, res.outcome, res.effect, dmg]);
    if (this.heroSink) this.heroSink(R);
    this._emitContact(R);
  }

  _endAction() {
    const d = this.def, v = this.verb;
    this.lastVerb = v;
    if (d.art === ART.RED) this.lastRed = v;      // "never the same RED verb twice in a row" (across normal verbs too)
    this._emitAction('action/end', Phase.RECOVERY);
    if (v === BossVerb.W_LAND && this.introRoar) { this.introRoar = false; this._startRoar(true); return; }
    if (this.stance === BossStance.AIR && v !== BossVerb.W_LAND) {
      this.airLeft--;
      if (this.airLeft <= 0 || this.pendingPhase) { this._landFrom = this.y; this._startVerb(BossVerb.W_LAND); return; }
      this.state = BRAIN_STATE.HOVER; this.f = 0; this.waitF = this._waitFrames(); return;
    }
    this.state = BRAIN_STATE.HOLD; this.f = 0;
    this.holdF = d.art !== ART.NORMAL ? 36 : 12;
  }

  _hold(h) {
    this.f++;
    const low = this.stance === BossStance.GROUND_LOW;
    this.anim.clip = low ? 'idle_low' : 'idle'; this.anim.time = (this.f % 120) / 60; this.anim.loop = true;
    if (this.f < this.holdF) return;
    if (this.pendingPhase) { this._startRoar(); return; }
    // phase 3: tail sweep chains into a bite once the punish window has passed
    if (this.phase === 3 && (this.lastVerb === BossVerb.W_TAIL_L || this.lastVerb === BossVerb.W_TAIL_R)
      && Math.hypot(h.x - this.x, h.z - this.z) <= 4.0) { this._startVerb(BossVerb.W_BITE); return; }
    this.state = BRAIN_STATE.WAIT; this.f = 0; this.waitF = this._waitFrames();
  }

  _waitFrames() { const w = PHASES[this.phase].wait; return Math.round(this.rng.range(w[0], w[1])); }

  // ---------------- flight ----------------
  _startTakeoff() { this.state = BRAIN_STATE.TAKEOFF; this.f = 0; this.airLeft = 1 + (this.rng.float() < 0.5 ? 1 : 0); this.stance = BossStance.AIR; }

  _takeoff(h) {
    this.f++;
    const u = Math.min(1, this.f / TAKEOFF_F);
    this.y = HOVER_Y * u * u * (3 - 2 * u);
    this._turnToward(h.x, h.z, TURN_RATE);
    this.anim.clip = 'takeoff'; this.anim.time = Math.min(this.f, TAKEOFF_F) / 60; this.anim.loop = false;
    if (this.f >= TAKEOFF_F) { this.state = BRAIN_STATE.HOVER; this.f = 0; this.waitF = 24; }
  }

  _hover(h) {
    this.f++;
    this.y = HOVER_Y;
    this._turnToward(h.x, h.z, TURN_RATE);
    // keep 7-9 m from the hero while hovering
    const dx = h.x - this.x, dz = h.z - this.z, dist = Math.hypot(dx, dz) || 1;
    const want = dist < 7 ? -1 : dist > 9 ? 1 : 0;
    if (want) { const s = want * FLY_SPEED * 0.4 / 60 / dist; this.x += dx * s; this.z += dz * s; }
    this.anim.clip = 'hover'; this.anim.time = (this.f % 48) / 60; this.anim.loop = true;
    if (this.f < this.waitF) return;
    if (this.pendingPhase) { this._landFrom = this.y; this._startVerb(BossVerb.W_LAND); return; }
    this._startVerb(this.rng.float() < 0.55 && this.lastRed !== BossVerb.W_SKY_HAZE ? BossVerb.W_SKY_HAZE : BossVerb.W_SWOOP);
  }

  // ---------------- phase change ----------------
  _startRoar(intro = false) {
    if (this.pendingPhase) { this.phase = this.pendingPhase; this.pendingPhase = 0; }
    this.invuln = true;
    this._startVerb(BossVerb.W_ROAR);
    this.state = BRAIN_STATE.ROAR;
    if (this.bus) { const p = this.bus.payload('boss/phase'); p.actorId = this.actorId; p.phase = this.phase; p.stance = this.stance; p.intro = intro; this.bus.dispatch('boss/phase'); }
    if (this.logOn) this.log.push([this.simFrame, 'phase', this.phase, intro ? 1 : 0]);
  }

  _roar(h) {
    this.f++;
    const d = this.def;
    this.anim.clip = 'hit'; this.anim.time = Math.min(this.f * 0.6, 50) / 60; this.anim.loop = false;
    if (this.f === d.active[0]) this._pushHero(h, d.reach, 1.5);
    if (this.f >= ROAR_F) { this.invuln = false; this.lastVerb = BossVerb.W_ROAR; this.state = BRAIN_STATE.HOLD; this.f = 0; this.holdF = 12; }
  }

  // ---------------- incoming damage (hero -> boss) ----------------
  // part: 'body' | 'head'. Returns applied damage (0 if invulnerable). Contact dedupe is the hero side's job
  // (stable actionId per swing); this method applies exactly what it is given.
  takeHit(dmg, posture, part = 'body', backstab = false, fromFinisher = false) {
    if (this.state === BRAIN_STATE.DEAD) return 0;
    if (!fromFinisher && (this.invuln || this.finisherF >= 0)) return 0;
    const head = part === 'head';
    const d = Math.round(dmg * (this.dmgScale || 1) * (head ? 1.5 : 1) * (backstab && this.simFrame <= this.backstabUntil ? 1.5 : 1));
    this.hp = Math.max(0, this.hp - d);
    if (this.state !== BRAIN_STATE.STAGGER && this.state !== BRAIN_STATE.FALL) {
      this.posture = Math.min(BOSS.POSTURE_MAX, this.posture + posture * (head ? 2 : 1));
    }
    if (this.hp <= 0) { this._die(); return d; }
    const frac = this.hp / BOSS.HP;
    const nextPhase = frac > PHASES[1].hpAbove ? 1 : frac > PHASES[2].hpAbove ? 2 : 3;
    if (nextPhase > this.phase && !this.pendingPhase) this.pendingPhase = nextPhase;
    if (this.posture >= BOSS.POSTURE_MAX) this._postureBreak();
    return d;
  }

  _postureBreak() {
    if (this.state === BRAIN_STATE.STAGGER || this.state === BRAIN_STATE.FALL || this.state === BRAIN_STATE.DEAD) return;
    if (this.def && this.state === BRAIN_STATE.ACTION) this._emitAction('action/end', Phase.RECOVERY);
    this.orb.active = this.orb.active && this.orb.reflected;
    if (this.stance === BossStance.AIR) { this.state = BRAIN_STATE.FALL; this.f = 0; this.fallStage = 0; this._fallFrom = this.y; }
    else { this.state = BRAIN_STATE.STAGGER; this.f = 0; this.staggerLeft = DEFENCE.STAGGER_F; }
    if (this.bus) { const p = this.bus.payload('combat/guardbreak'); p.actorId = this.actorId; this.bus.dispatch('combat/guardbreak'); }
    if (this.logOn) this.log.push([this.simFrame, 'break', this.stance, 0]);
  }

  _stagger() {
    this.f++;
    this.anim.loop = false;
    if (this.f <= STAGGER_HIT_F) { this.anim.clip = 'hit'; this.anim.time = this.f / 60; }
    else { this.anim.clip = 'idle_low'; this.anim.time = ((this.f - STAGGER_HIT_F) % 120) / 60; this.anim.loop = true; }
    if (this.f >= this.staggerLeft) { this.posture = 0; this.stance = BossStance.GROUND_UP; this.state = BRAIN_STATE.HOLD; this.f = 0; this.holdF = 24; }
  }

  // air break / air death: air_fall -> fall_loop -> crash, then ground stagger (or death)
  _fall() {
    this.f++;
    const total = AIR_FALL_F + 20;
    if (this.f <= total) {
      const u = this.f / total; this.y = this._fallFrom * (1 - u * u);
      this.anim.clip = this.f <= AIR_FALL_F ? 'air_fall' : 'fall_loop';
      this.anim.time = (this.f <= AIR_FALL_F ? this.f : (this.f - AIR_FALL_F) % 50) / 60; this.anim.loop = this.f > AIR_FALL_F;
      return;
    }
    this.y = 0; this.stance = BossStance.GROUND_LOW;
    const cf = this.f - total;
    this.anim.clip = 'crash'; this.anim.time = Math.min(cf, CRASH_F) / 60; this.anim.loop = false;
    if (cf >= CRASH_F) {
      if (this.hp <= 0) { this.state = BRAIN_STATE.DEAD; this.f = 94; this._emitDeath(); return; }
      this.state = BRAIN_STATE.STAGGER; this.f = STAGGER_HIT_F; this.staggerLeft = STAGGER_HIT_F + DEFENCE.STAGGER_F;
    }
  }

  _die() {
    this.orb.active = false;
    for (const p of this.pools) p.left = 0;
    if (this.stance === BossStance.AIR) { this.state = BRAIN_STATE.FALL; this.f = 0; this._fallFrom = this.y; return; }
    this.state = BRAIN_STATE.DEAD; this.f = 0; this._emitDeath();
  }

  // ---------------- finisher (C3) ----------------
  // Available while staggered (head within 3.0 m) or inside the backstab window within 2.2 m.
  canFinish(h) {
    if (this.finisherF >= 0 || this.state === BRAIN_STATE.DEAD) return false;
    const hx = this.x + this.forwardX() * 2.9, hz = this.z + this.forwardZ() * 2.9;   // head point at scale 3
    if (this.state === BRAIN_STATE.STAGGER && this.stance !== BossStance.AIR) return Math.hypot(h.x - hx, h.z - hz) <= DEFENCE.FINISHER_RANGE;
    if (this.simFrame <= this.backstabUntil) return Math.hypot(h.x - this.x, h.z - this.z) <= 2.2 + BOSS.BODY_RADIUS;
    return false;
  }

  startFinisher(h) {
    if (!this.canFinish(h)) return false;
    this.finisherF = 0; this.finisherHits = 0; this.invuln = true;
    if (this.logOn) this.log.push([this.simFrame, 'finisher', 0, 0]);
    return true;
  }

  _finisherStep(h) {
    this.finisherF++;
    h.invuln = true;
    if (this.finisherF === FINISHER_HIT_F) {
      this.takeHit(FINISHER_DMG, 0, 'head', false, true);
      this.finisherHits++;
      this.contacts++;
    }
    if (this.finisherF >= FINISHER_F) {
      this.finisherF = -1; this.invuln = false; h.invuln = false;
      if (this.state === BRAIN_STATE.STAGGER) { this.posture = 0; this.state = BRAIN_STATE.HOLD; this.f = 0; this.holdF = 30; }
    }
  }

  _setAnimFinisher() {
    if (this.state === BRAIN_STATE.DEAD) { this.anim.clip = 'death'; this.anim.time = Math.min(this.f++, 94) / 60; this.anim.loop = false; return; }
    this.anim.clip = this.finisherF < FINISHER_HIT_F ? 'idle_low' : 'hit';
    this.anim.time = (this.finisherF < FINISHER_HIT_F ? this.finisherF % 120 : this.finisherF - FINISHER_HIT_F) / 60; this.anim.loop = false;
  }

  // ---------------- pools, orb, push ----------------
  _spawnPool(x, z, r, frames) {
    let s = this.pools[0];
    for (const p of this.pools) { if (p.left <= 0) { s = p; break; } if (p.left < s.left) s = p; }
    const lim = SIM.ARENA_HALF - r;
    s.x = Math.max(-lim, Math.min(lim, x)); s.z = Math.max(-lim, Math.min(lim, z)); s.r = r; s.left = frames; s.id = this.actionId;
    if (this.logOn) this.log.push([this.simFrame, 'pool', Math.round(s.x * 10), Math.round(s.z * 10)]);
  }

  _stepPools(h) {
    for (const p of this.pools) {
      if (p.left <= 0) continue;
      p.left--;
      if ((p.left % TICK_F) !== 0) continue;
      if (Math.hypot(h.x - p.x, h.z - p.z) > p.r) continue;
      if (h.invuln) continue;                                 // pools are a zone: i-frames do not help, only leaving does
      const R = this.rec;
      R.actionId = p.id * 16 + 8 + (p.left / TICK_F | 0) % 8; R.targetId = h.id; R.verb = BossVerb.W_HAZE; R.outcome = Outcome.HIT;
      R.perfect = false; R.effect = 'none'; R.art = ART.RED; R.damage = 6; R.posture = 0; R.frame = this.simFrame;
      R.pos.x = h.x; R.pos.y = 0.3; R.pos.z = h.z; R.normal.x = 0; R.normal.y = 1; R.normal.z = 0; R.tx = h.x; R.tz = h.z;
      this.contacts++;
      if (this.heroSink) this.heroSink(R);
      this._emitContact(R);
    }
  }

  _spawnOrb(h) {
    const O = this.orb, fx = this.forwardX(), fz = this.forwardZ();
    O.active = true; O.reflected = false; O.id = this.actionId;
    O.x = this.x + fx * 2.7; O.y = 1.5; O.z = this.z + fz * 2.7;
    let dx = h.x - O.x, dz = h.z - O.z; const l = Math.hypot(dx, dz) || 1;
    O.vx = dx / l * 14 / 60; O.vz = dz / l * 14 / 60; O.dist = 0;
  }

  _stepOrb(h) {
    const O = this.orb;
    if (!O.active) return;
    O.x += O.vx; O.z += O.vz; O.dist += 14 / 60;
    O.y += (1.0 - O.y) * 0.05;
    if (O.dist > 18 || Math.abs(O.x) > SIM.ARENA_HALF || Math.abs(O.z) > SIM.ARENA_HALF) { O.active = false; return; }
    if (O.reflected) {
      if (Math.hypot(O.x - this.x, O.z - this.z) <= BOSS.BODY_RADIUS + 0.4) {
        O.active = false;
        this.invuln = false;
        this.takeHit(18, 60, 'head');
        if (this.logOn) this.log.push([this.simFrame, 'orb_back', 0, 0]);
      }
      return;
    }
    if (Math.hypot(O.x - h.x, O.z - h.z) > 0.4 + (h.radius || SIM.CAPSULE_RADIUS)) return;
    const d = VERBS[BossVerb.W_SPIT];
    this._deliver(h, d, BossVerb.W_SPIT, O.id * 16 + 1, true, O.x, O.y, O.z);
    if (this.rec.effect === 'reflect') { O.reflected = true; O.vx = -O.vx * 1.3; O.vz = -O.vz * 1.3; O.dist = 0; }
    else O.active = false;
  }

  _pushHero(h, r, dist) {
    const dx = h.x - this.x, dz = h.z - this.z, l = Math.hypot(dx, dz);
    if (l > r + (h.radius || SIM.CAPSULE_RADIUS) || l < 1e-6) return;
    h.pushX = dx / l * dist; h.pushZ = dz / l * dist;          // hero controller applies it with wall sliding (9.4)
  }

  // Body capsule pushes the hero, never the reverse. Boss XZ clamped to |x|,|z| <= 12; boulders push the boss.
  _chamfer(c) {
    const lim = 2 * c - CORNER_CUT, s = Math.abs(this.x) + Math.abs(this.z);
    if (s > lim) { const k = (s - lim) * 0.5; this.x -= Math.sign(this.x) * k; this.z -= Math.sign(this.z) * k; }
  }

  _clampAndPush(h) {
    const c = CLAMP;   // one clamp for every state: a per-verb clamp pops the boss sideways when the verb starts
    if (this.x > c) this.x = c; else if (this.x < -c) this.x = -c;
    if (this.z > c) this.z = c; else if (this.z < -c) this.z = -c;
    // cut the corners: facing the centre from a corner, a wing points along a wall axis (measured 0.35 m
    // overshoot at root (12,-12) on land/bite_low). |x|+|z| <= 2c - 1.2 keeps edges at 12 m and corners at 11.4 m.
    this._chamfer(c);
    if (this.stance !== BossStance.AIR && this.colliders) {
      const r = this.colliders.resolveCapsule(this.x, this.z, BOSS.BODY_RADIUS, 0.3, 2.0);
      this.x = Math.max(-c, Math.min(c, r.x)); this.z = Math.max(-c, Math.min(c, r.z));
      this._chamfer(c);                      // a boulder push must not shove the boss back into a corner
    }
    if (this.y < 0) this.y = 0;
    if (this.y > BOSS.FLIGHT_CEILING - 3) this.y = BOSS.FLIGHT_CEILING - 3;
    if (this.stance === BossStance.AIR && this.y > 2.0) return;
    if (this.state === BRAIN_STATE.DEAD) return;
    const dx = h.x - this.x, dz = h.z - this.z, l = Math.hypot(dx, dz), min = BOSS.BODY_RADIUS + (h.radius || SIM.CAPSULE_RADIUS);
    if (l < min) { const k = l > 1e-6 ? 1 / l : 0; h.pushX += (dx * k || 1) * (min - l); h.pushZ += dz * k * (min - l); }
  }

  // ---------------- events ----------------
  _emitAction(id, phase) {
    if (!this.bus) return;
    const p = this.bus.payload(id);
    p.actorId = this.actorId; p.actionId = this.actionId; p.verb = this.verb; p.phase = phase; p.frame = this.f; p.boss = true;
    p.reason = 'complete';
    this.bus.dispatch(id);
  }
  _emitTelegraph(verb, lead) {
    if (!this.bus) return;
    const p = this.bus.payload('ai/telegraph');
    p.actorId = this.actorId; p.actionId = this.actionId; p.verb = verb; p.leadFrames = lead; p.art = VERBS[verb].art; p.boss = true;
    this.bus.dispatch('ai/telegraph');
  }
  _emitContact(R) {
    if (!this.bus) return;
    const p = this.bus.payload('combat/contact');
    p.actionId = R.actionId; p.attackerId = this.actorId; p.targetId = R.targetId; p.verb = R.verb; p.outcome = R.outcome;
    p.damage = R.damage; p.posture = R.posture; p.pos = R.pos; p.normal = R.normal; p.surface = R.surface; p.boss = true;
    p.perfect = R.perfect; p.effect = R.effect; p.art = R.art;
    this.bus.dispatch('combat/contact');
    if (R.outcome === Outcome.PARRIED) {
      const q = this.bus.payload('combat/parry');
      q.defenderId = R.targetId; q.attackerId = this.actorId; q.actionId = R.actionId; q.pos = R.pos; q.perfect = R.perfect;
      this.bus.dispatch('combat/parry');
    }
  }
  _emitDeath() {
    if (this.logOn) this.log.push([this.simFrame, 'death', 0, 0]);
    if (!this.bus) return;
    const p = this.bus.payload('actor/death'); p.actorId = this.actorId; p.kind = ActorKind.WYVERN; p.killerId = 0;
    this.bus.dispatch('actor/death');
  }

  // ---------------- determinism (C4) ----------------
  hash(h = 2166136261) {
    const q = (v) => { h = Math.imul(h ^ (Math.round(v * 1000) | 0), 16777619) >>> 0; };
    q(this.x); q(this.y); q(this.z); q(this.yaw); q(this.hp); q(this.posture); q(this.phase); q(this.state); q(this.f);
    q(this.verb); q(this.actionId); q(this.contacts); q(this.rng.s[0]); q(this.rng.s[3]);
    for (const p of this.pools) { q(p.left); q(p.x); q(p.z); }
    q(this.orb.active ? 1 : 0); q(this.orb.x); q(this.orb.z);
    return h >>> 0;
  }

  dispose() { this.heroSink = null; this.telegraphSink = null; this.bus = null; this.colliders = null; }
}
