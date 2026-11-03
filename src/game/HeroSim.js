// HeroSim - player hero simulation for the full game (owner: game). No THREE, no DOM, no Math.random.
// Fixed 60 Hz. Reads a per-step command built from the input layer (or the QA bot), owns position, yaw,
// stamina, HP and the verb state machine. Field names match what WyvernBrain / DuelistSim read on a hero
// (x, z, y, yaw, radius, invuln, dodgeF, deflectF, blocking, stepDirX/Z, stepToward, pushX/Z, id).
// Verb frame data comes from assets/attack-timing.json (same table the controls page plays).
import { SIM } from '../shared/constants.js';
import { Outcome } from '../shared/enums.js';

export const HERO_STATE = Object.freeze({ LOCO: 0, ACTION: 1, DODGE: 2, HITSTUN: 3, DEAD: 4, FINISHER: 5 });
export const HERO_STATE_NAMES = Object.freeze(['LOCO', 'ACTION', 'DODGE', 'HITSTUN', 'DEAD', 'FINISHER']);

// gameplay numbers per verb (frame data comes from the timing table)
export const HERO_VERBS = Object.freeze({
  LIGHT_1: { clip: 'light_1', stamina: 12, lunge: 0.35, chainTo: 'LIGHT_2', chain: [16, 30], dodgeFrom: 20, dmg: 14, posture: 12 },
  LIGHT_2: { clip: 'light_2', stamina: 12, lunge: 0.35, chainTo: 'LIGHT_3', chain: [15, 31], dodgeFrom: 19, dmg: 14, posture: 12 },
  LIGHT_3: { clip: 'light_3', stamina: 16, lunge: 0.60, chainTo: null, chain: null, dodgeFrom: 30, dmg: 20, posture: 18 },
  HEAVY: { clip: 'heavy', stamina: 30, lunge: 0.80, chainTo: null, chain: null, dodgeFrom: 50, dmg: 32, posture: 34 },
});
export const HERO_DODGE = Object.freeze({ total: 34, travel: 3.0, travelF: [2, 22], stamina: 20, cancelFrom: 28, guardRange: 9.0 });
// Guarded quickstep directions (relative to facing). Clip names match the MotionBricks bake (motion/mb/hero.combat.json).
export const STEP_DIR = Object.freeze({ NONE: 0, F: 1, B: 2, L: 3, R: 4 });
export const STEP_CLIP = Object.freeze(['dodge', 'dodge_F', 'dodge_B', 'dodge_L', 'dodge_R']);
export const HERO_FINISHER_F = 96;          // matches the boss finisher length (WyvernBrain FINISHER_F)
// Finisher presentation: Sword Judgment (clip 102). Blade lands on clip frame 62, the boss takes the blow on sim
// frame 60 (WyvernBrain FINISHER_HIT_F); knots map sim frames -> clip frames (60 fps).
export const HERO_FINISHER_CLIP = Object.freeze({ clip: 'mh_judgment', knots: [[0, 0], [60, 62], [96, 112]] });
const HITSTUN_F = 20, GUARDBREAK_F = 50, DEATH_F = 100, ASSIST_RANGE = 4.5;
const STAMINA_REGEN = 34 / 60, STAMINA_DELAY = 30, BLOCK_REGEN_SCALE = 0.35;
// Charged heavy: holding heavy freezes the swing at the top of its wind-up (CHARGE_HOLD_F frames before ACTIVE)
// for up to CHARGE_MAX_F frames. Charge level 0..1 (counted after CHARGE_MIN_F so a tap stays a plain heavy)
// scales damage x1..1.7, posture x1..1.9 and lunge x1..1.5. Releasing (or reaching max) fires the swing.
export const HERO_CHARGE = Object.freeze({ HOLD_F: 8, MIN_F: 8, MAX_F: 54, DMG: 0.7, POSTURE: 0.9, LUNGE: 0.5 });
// Health regen: after REGEN_DELAY frames without taking damage, HP refills at REGEN_PER_S (never while dead).
export const HERO_REGEN = Object.freeze({ DELAY_F: 300, PER_S: 4 });
// v2.10 great sword (picked up beside the wyvern's landing): same verbs and frame data as the standard blade,
// longer reach and heavier hits for a little more stamina. weapon 0 = standard sword, 1 = great sword.
// v2.12: the great sword is heavy - every verb's frame data (startup, active, recovery, chain window, dodge cancel)
// is stretched by SWING, and locomotion top speed is scaled by MOVE. Dodge / roll are unchanged (defence stays fair).
export const GREATSWORD = Object.freeze({ REACH: 0.7, DMG: 1.4, POSTURE: 1.35, STAMINA: 1.15, SWING: 1.3, MOVE: 0.72, TURN: 0.8 });
// Stretch one verb record's frame data by k (phases, chain window, dodge cancel). Pure; used for the great-sword set.
// Stretch timing-table phases by k (specF / playedF; clip frame knots unchanged, so the clip plays slower).
export function scalePhases(phases, k) {
  const s = (n) => Math.max(1, Math.round(n * k));
  return phases.map((p) => ({ ...p, specF: s(p.specF), playedF: p.playedF ? s(p.playedF) : undefined }));
}
export function scaleVerb(v, k) {
  const s = (n) => Math.max(1, Math.round(n * k));
  const o = { ...v, phases: scalePhases(v.phases, k) };
  let f = 0; for (const p of o.phases) { p.start = f; f += p.specF; }
  o.total = f; o.startup = o.phases[0].specF; o.active = o.phases[1].specF;
  o.chain = v.chain ? [s(v.chain[0]), s(v.chain[1])] : null; o.dodgeFrom = s(v.dodgeFrom);
  return o;
}
export const WEAPON = Object.freeze({ SWORD: 0, GREAT: 1 });
const TURN = SIM.TURN_RATE / 60;
const TAU = Math.PI * 2;
function wrap(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }

// Command filled each fixed step by the game (input layer or bot). Reused, never reallocated.
export function makeHeroCommand() {
  return { mx: 0, mz: 0, speed: 0, attack: false, heavy: false, heavyHeld: false, dodge: false, roll: false, blockHeld: false, blockPress: false };
}

export class HeroSim {
  // timing: parsed attack-timing.json; colliders: world Colliders (optional); god: HP never below 1
  constructor({ timing, colliders = null, god = false, dodgeProfile = null }) {
    this.colliders = colliders; this.god = god;
    // per-direction cumulative travel fractions (one per travel frame) from the MotionBricks root curve; linear fallback
    const N = HERO_DODGE.travelF[1] - HERO_DODGE.travelF[0] + 1;
    const lin = Float32Array.from({ length: N }, (_, i) => (i + 1) / N);
    this.stepProfile = STEP_CLIP.map((c) => (dodgeProfile && dodgeProfile.clips[c] && dodgeProfile.clips[c].profile.length === N)
      ? Float32Array.from(dodgeProfile.clips[c].profile) : lin);
    this.verbs = {};
    for (const k in HERO_VERBS) {
      const t = timing.verbs[k], v = { ...HERO_VERBS[k], name: k };
      if (t.clip) v.clip = t.clip;           // the timing table owns the clip choice (v2.8 long-sword set)
      v.phases = t.phases.map((p) => ({ ...p })); let f = 0;
      for (const p of v.phases) { p.start = f; f += p.specF; }
      v.total = f; v.startup = v.phases[0].specF; v.active = v.phases[1].specF;
      v.reach = t.contactDistM || 1.35;
      this.verbs[k] = v;
    }
    // great-sword frame data: same verbs stretched by GREATSWORD.SWING (this.verbs swaps on equip / reset)
    this.verbsStd = this.verbs; this.verbsGreat = {};
    for (const k in this.verbsStd) this.verbsGreat[k] = scaleVerb(this.verbsStd[k], GREATSWORD.SWING);
    this._charged = { ...this.verbs.HEAVY };   // scratch verb record for a charged release (no per-hit allocation)
    this._great = { name: '', dmg: 0, posture: 0, reach: 0, charge: 0 };   // scratch verb record for great-sword hits
    this.id = 1; this.radius = SIM.CAPSULE_RADIUS;
    this.contactSink = null;     // (rec) => void, presentation hook after the hero applied an incoming contact
    this.hitSink = null;         // (targetKind, target, dmg, info) => void, presentation hook for outgoing hits
    this._hitIds = new Int32Array(8); this._hitN = 0;
    this.reset(0, 9, 0);
  }

  reset(x, z, yaw) {
    this.x = x; this.z = z; this.y = 0; this.yaw = yaw; this.prevX = x; this.prevZ = z; this.prevYaw = yaw;
    this.speed = 0; this.vx = 0; this.vz = 0;
    this.hp = SIM.HP_PLAYER; this.stamina = SIM.STAMINA_MAX; this.staminaIdle = 0;
    this.state = HERO_STATE.LOCO; this.verb = null; this.actF = 0; this.actionId = 0; this.stateF = 0;
    this.invuln = false; this.dodgeF = -1; this.deflectF = -1; this.blocking = false;
    this.stepDirX = 0; this.stepDirZ = 1; this.stepToward = 0; this.pushX = 0; this.pushZ = 0; this.stepKind = STEP_DIR.NONE;
    this.queued = null; this.hitstunLen = HITSTUN_F;
    this.frame = 0; this.hitsTaken = 0; this.damageTaken = 0; this.damageDealt = 0; this.flash = 0;
    this.perfects = 0; this.deflects = 0; this.phantoms = 0; this.finishers = 0;
    this.lastEvent = ''; this.lastEventFrame = -999; this.lastStaminaFail = -999;
    this.maxBackwardDot = 1;
    this._hitN = 0;
    this.charging = false; this.chargeF = 0; this.chargeLvl = 0; this.chargedHits = 0;
    this.hpIdle = 0; this.hpRegained = 0;
    this.weapon = WEAPON.SWORD; this.verbs = this.verbsStd;
  }

  equipGreatsword() { if (this.weapon === WEAPON.GREAT) return false; this.weapon = WEAPON.GREAT; this.verbs = this.verbsGreat; this._event('equip'); return true; }

  // charge level of the current (or last) heavy, 0..1
  _chargeLevel() { return Math.max(0, Math.min(1, (this.chargeF - HERO_CHARGE.MIN_F) / (HERO_CHARGE.MAX_F - HERO_CHARGE.MIN_F))); }

  get alive() { return this.state !== HERO_STATE.DEAD; }
  facingX() { return -Math.sin(this.yaw); }
  facingZ() { return -Math.cos(this.yaw); }

  // Frame index inside the current verb and its phase name ('STARTUP' | 'ACTIVE' | 'RECOVERY' | 'DONE').
  phase() {
    if (this.state !== HERO_STATE.ACTION) return null;
    const v = this.verbs[this.verb];
    for (const p of v.phases) if (this.actF < p.start + p.specF) return p.phase;
    return 'DONE';
  }
  // Clip time (s) of the current verb at fractional frame f (piecewise warp, spec frames -> clip frames).
  verbClipTime(f) {
    const v = this.verbs[this.verb];
    for (let i = 0; i < v.phases.length; i++) {
      const p = v.phases[i];
      if (f < p.start + p.specF || i === v.phases.length - 1) {
        const played = p.playedF || p.specF, u = Math.min(1, Math.max(0, (f - p.start) / played));
        return (p.clipF[0] + (p.clipF[1] - p.clipF[0]) * u) / 60;
      }
    }
    return 0;
  }

  _event(name) { this.lastEvent = name; this.lastEventFrame = this.frame; }

  _spend(cost) {
    if (this.stamina < cost * 0.5) { this.lastStaminaFail = this.frame; return false; }   // allow going slightly negative-free
    this.stamina = Math.max(0, this.stamina - cost); this.staminaIdle = 0; return true;
  }

  // nearest live target inside the assist range, for attack snap-turn
  _assistYaw(targets) {
    let best = null, bd = ASSIST_RANGE;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]; if (!t || !t.targetable) continue;
      const d = Math.hypot(t.x - this.x, t.z - this.z) - (t.radius || 0);
      if (d < bd) { bd = d; best = t; }
    }
    return best ? Math.atan2(-(best.x - this.x), -(best.z - this.z)) : null;
  }

  _startVerb(name, targets) {
    const v = this.verbs[name];
    if (!this._spend(this.weapon === WEAPON.GREAT ? Math.round(v.stamina * GREATSWORD.STAMINA) : v.stamina)) return false;
    this.state = HERO_STATE.ACTION; this.verb = name; this.actF = 0; this.actionId++; this._hitN = 0;
    this.queued = null; this.blocking = false;
    this.charging = name === 'HEAVY'; this.chargeF = 0; this.chargeLvl = 0;
    const ay = this._assistYaw(targets); if (ay !== null) this.yaw = ay;
    return true;
  }

  // roll = true (ROLL button): always the evasive roll, even with a foe in guard range. Same frames, i-frames,
  // travel and stamina as the dodge; only the quickstep branch is skipped.
  _startDodge(cmd, targets, roll = false) {
    if (!this._spend(HERO_DODGE.stamina)) return false;
    this.state = HERO_STATE.DODGE; this.dodgeF = 0; this.actF = 0; this.blocking = false; this.queued = null;
    const l = Math.hypot(cmd.mx, cmd.mz);
    let dx, dz;
    if (l > 0.1) { dx = cmd.mx / l; dz = cmd.mz / l; }
    else { dx = -this.facingX(); dz = -this.facingZ(); }         // no stick: backstep
    // Guarded quickstep: with a foe in range the hero squares up to it and steps in one of four directions
    // relative to that facing (MotionBricks clips), never turning its back. Otherwise: the roll.
    const t = (targets && !roll) ? this._nearest(targets, HERO_DODGE.guardRange) : null;
    if (t) {
      this.yaw = Math.atan2(-(t.x - this.x), -(t.z - this.z));
      const fx = this.facingX(), fz = this.facingZ(), rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      const f = dx * fx + dz * fz, r = dx * rx + dz * rz;
      if (Math.abs(f) >= Math.abs(r)) { this.stepKind = f > 0 ? STEP_DIR.F : STEP_DIR.B; const g = f > 0 ? 1 : -1; dx = fx * g; dz = fz * g; }
      else { this.stepKind = r > 0 ? STEP_DIR.R : STEP_DIR.L; const g = r > 0 ? 1 : -1; dx = rx * g; dz = rz * g; }
    } else this.stepKind = STEP_DIR.NONE;
    this.stepDirX = dx; this.stepDirZ = dz;
    this._event('dodge');
    return true;
  }

  _nearest(targets, range) {
    let best = null, bd = range;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]; if (!t || !t.targetable) continue;
      const d = Math.hypot(t.x - this.x, t.z - this.z) - (t.radius || 0);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  // Called by the game when a finisher is granted (boss stagger / duelist guardbreak). Hero is invulnerable for it.
  startFinisher(target) {
    if (this.state === HERO_STATE.DEAD) return false;
    this.state = HERO_STATE.FINISHER; this.actF = 0; this.invuln = true; this.blocking = false; this.queued = null;
    if (target) this.yaw = Math.atan2(-(target.x - this.x), -(target.z - this.z));
    this.finishers++; this._event('finisher');
    return true;
  }

  // One fixed step. cmd: makeHeroCommand(); targets: [{ x, z, radius, targetable, id, onHeroHit(hero, verbDef, part) }]
  step(cmd, targets) {
    this.frame++;
    this.prevX = this.x; this.prevZ = this.z; this.prevYaw = this.yaw;
    if (this.deflectF >= 0 && ++this.deflectF > 20) this.deflectF = -1;
    if (cmd.blockPress) this.deflectF = 0;
    if (this.flash > 0) this.flash--;
    let mx = 0, mz = 0;                       // planar displacement this step (metres)

    switch (this.state) {
      case HERO_STATE.DEAD: this.actF++; this.speed = 0; break;

      case HERO_STATE.FINISHER:
        this.actF++;
        if (this.actF >= HERO_FINISHER_F) { this.state = HERO_STATE.LOCO; this.invuln = false; }
        break;

      case HERO_STATE.HITSTUN:
        this.actF++;
        if (this.actF >= this.hitstunLen) { this.state = HERO_STATE.LOCO; this.actF = 0; }
        break;

      case HERO_STATE.DODGE: {
        this.dodgeF++; this.actF++;
        const D = HERO_DODGE;
        if (this.dodgeF >= D.travelF[0] && this.dodgeF <= D.travelF[1]) {
          // travel follows the clip's own root curve (planted feet); the total is exactly D.travel
          const P = this.stepProfile[this.stepKind], j = this.dodgeF - D.travelF[0];
          const s = D.travel * (P[j] - (j > 0 ? P[j - 1] : 0));
          mx = this.stepDirX * s; mz = this.stepDirZ * s;
          if (this.stepKind === STEP_DIR.NONE) this.yaw = wrap(this.yaw + Math.max(-TURN, Math.min(TURN, wrap(Math.atan2(-this.stepDirX, -this.stepDirZ) - this.yaw))));
        }
        if (this.dodgeF >= D.cancelFrom && (cmd.attack || cmd.heavy)) {
          this.dodgeF = -1; this.state = HERO_STATE.LOCO;
          this._startVerb(cmd.heavy ? 'HEAVY' : 'LIGHT_1', targets);
        } else if (this.dodgeF >= D.total) { this.dodgeF = -1; this.state = HERO_STATE.LOCO; this.actF = 0; }
        break;
      }

      case HERO_STATE.ACTION: {
        const v = this.verbs[this.verb];
        // charged heavy: hold at the top of the wind-up while the button is held (tracks the target, no lunge)
        if (this.charging) {
          const holdAt = v.startup - HERO_CHARGE.HOLD_F;
          if (this.actF >= holdAt && cmd.heavyHeld && this.chargeF < HERO_CHARGE.MAX_F) {
            this.chargeF++; this.chargeLvl = this._chargeLevel();
            if (this.chargeF === HERO_CHARGE.MAX_F) this._event('charged');
            const ay = this._assistYaw(targets);
            if (ay !== null) this.yaw = wrap(this.yaw + Math.max(-TURN * 0.5, Math.min(TURN * 0.5, wrap(ay - this.yaw))));
            if (cmd.dodge || cmd.roll) { this.charging = false; this.state = HERO_STATE.LOCO; this._startDodge(cmd, targets, cmd.roll); }
            break;
          }
          if (this.actF >= holdAt) { this.charging = false; if (this.chargeLvl > 0) this._event('release'); }
        }
        this.actF++;
        // lunge during startup->active, scaled down when a target is already inside reach
        const lungeF = v.startup + v.active;
        if (this.actF <= lungeF) {
          let near = Infinity;
          for (let i = 0; i < targets.length; i++) { const t = targets[i]; if (t && t.targetable) near = Math.min(near, Math.hypot(t.x - this.x, t.z - this.z) - (t.radius || 0)); }
          const k = (near < v.reach * 0.8 ? 0.25 : 1) * (this.verb === 'HEAVY' ? 1 + HERO_CHARGE.LUNGE * this.chargeLvl : 1);
          mx = this.facingX() * v.lunge * k / lungeF; mz = this.facingZ() * v.lunge * k / lungeF;
        }
        // contact: ACTIVE window, reach + target radius, inside a 70 degree half-cone, once per (actionId, target)
        const ph = this.phase();
        if (ph === 'ACTIVE') this._resolveSwing(v, targets);
        // buffered follow-ups
        if (cmd.attack && v.chainTo) this.queued = v.chainTo;
        if (cmd.heavy) this.queued = 'HEAVY';
        if (cmd.dodge) this.queued = 'DODGE';
        if (cmd.roll) this.queued = 'ROLL';
        const evade = this.queued === 'DODGE' || this.queued === 'ROLL';
        if (evade && this.actF >= v.dodgeFrom) { const r = this.queued === 'ROLL'; this.state = HERO_STATE.LOCO; this._startDodge(cmd, targets, r); break; }
        if (this.queued && !evade && v.chain && this.actF >= v.chain[0] && this.actF <= v.chain[1]) {
          const q = this.queued; this.state = HERO_STATE.LOCO; if (!this._startVerb(q, targets)) this.state = HERO_STATE.LOCO;
          break;
        }
        if (this.actF >= v.total) {
          this.state = HERO_STATE.LOCO; this.actF = 0; this.chargeLvl = 0;
          if (this.queued === 'HEAVY') this._startVerb('HEAVY', targets);
          this.queued = null;
        }
        break;
      }

      default: {   // LOCO
        this.actF++;
        if ((cmd.dodge || cmd.roll) && this._startDodge(cmd, targets, cmd.roll)) break;
        if (cmd.heavy && this._startVerb('HEAVY', targets)) break;
        if (cmd.attack && this._startVerb('LIGHT_1', targets)) break;
        this.blocking = cmd.blockHeld;
        const gk = this.weapon === WEAPON.GREAT ? GREATSWORD.MOVE : 1;   // heavy blade: slower top speed and turns
        const want = (this.blocking ? Math.min(cmd.speed, SIM.WALK_SPEED) : cmd.speed) * gk;
        // dodge / lunge carry-over enters LOCO at full velocity; with the great sword cap it at the heavy top speed
        if (gk < 1) this.speed = Math.min(this.speed, SIM.RUN_SPEED * gk);
        const l = Math.hypot(cmd.mx, cmd.mz);
        const dirX = l > 1e-4 ? cmd.mx / l : 0, dirZ = l > 1e-4 ? cmd.mz / l : 0;
        // speed ramps with ACCEL/DECEL; facing always turns toward travel, so the hero never runs backwards
        const target = l > 1e-4 ? want : 0;
        const rate = (target > this.speed ? SIM.ACCEL : SIM.DECEL) / 60;
        this.speed += Math.max(-rate, Math.min(rate, target - this.speed));
        if (l > 1e-4) {
          const wantYaw = Math.atan2(-dirX, -dirZ), d = wrap(wantYaw - this.yaw);
          const tr = gk < 1 ? TURN * GREATSWORD.TURN : TURN;
          this.yaw = wrap(this.yaw + Math.max(-tr, Math.min(tr, d)));
          // move along facing once mostly turned (no backwards travel while the turn completes)
          const fx = this.facingX(), fz = this.facingZ();
          const dot = fx * dirX + fz * dirZ;
          const s = this.speed / 60 * Math.max(0, dot);
          mx = fx * s; mz = fz * s;
        } else {
          mx = this.facingX() * this.speed / 60; mz = this.facingZ() * this.speed / 60;
        }
      }
    }

    // stamina regen (slower while blocking, none while acting)
    if (this.state === HERO_STATE.LOCO || this.state === HERO_STATE.HITSTUN) {
      if (++this.staminaIdle > STAMINA_DELAY) this.stamina = Math.min(SIM.STAMINA_MAX, this.stamina + STAMINA_REGEN * (this.blocking ? BLOCK_REGEN_SCALE : 1));
    } else this.staminaIdle = 0;
    // health regen after a quiet spell (any damage taken resets hpIdle in the contact path)
    if (this.state !== HERO_STATE.DEAD && ++this.hpIdle > HERO_REGEN.DELAY_F && this.hp < SIM.HP_PLAYER) {
      const before = this.hp;
      this.hp = Math.min(SIM.HP_PLAYER, this.hp + HERO_REGEN.PER_S / 60);
      this.hpRegained += this.hp - before;
    }

    // integrate + collide
    this.x += mx + this.pushX; this.z += mz + this.pushZ; this.pushX = 0; this.pushZ = 0;
    if (this.colliders) { const r = this.colliders.resolveCapsule(this.x, this.z, this.radius, 0.0, SIM.ACTOR_HEIGHT); this.x = r.x; this.z = r.z; }
    const lim = SIM.ARENA_HALF - this.radius;
    this.x = Math.max(-lim, Math.min(lim, this.x)); this.z = Math.max(-lim, Math.min(lim, this.z));
    this.vx = (this.x - this.prevX) * 60; this.vz = (this.z - this.prevZ) * 60;
    if (this.state !== HERO_STATE.LOCO) this.speed = Math.hypot(this.vx, this.vz);
    else {
      // backwards-running metric: self-driven travel (push excluded) against facing, while actually moving
      const sp = Math.hypot(mx, mz) * 60;
      if (sp > 0.5) { const dot = (mx * this.facingX() + mz * this.facingZ()) * 60 / sp; if (dot < this.maxBackwardDot) this.maxBackwardDot = dot; }
    }
  }

  _resolveSwing(v, targets) {
    if (v.name === 'HEAVY' && this.chargeLvl > 0) {
      const c = this._charged, L = this.chargeLvl;
      c.dmg = Math.round(v.dmg * (1 + HERO_CHARGE.DMG * L)); c.posture = Math.round(v.posture * (1 + HERO_CHARGE.POSTURE * L));
      c.charge = L; v = c;
    }
    if (this.weapon === WEAPON.GREAT) {
      const g = this._great;
      g.name = v.name; g.charge = v.charge || 0; g.reach = v.reach + GREATSWORD.REACH;
      g.dmg = Math.round(v.dmg * GREATSWORD.DMG); g.posture = Math.round(v.posture * GREATSWORD.POSTURE); g.great = true;
      v = g;
    }
    const fx = this.facingX(), fz = this.facingZ();
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]; if (!t || !t.targetable) continue;
      let seen = false;
      for (let k = 0; k < this._hitN; k++) if (this._hitIds[k] === t.id) { seen = true; break; }
      if (seen) continue;
      const dx = t.x - this.x, dz = t.z - this.z, d = Math.hypot(dx, dz);
      if (d > v.reach + (t.radius || 0) + this.radius) continue;
      if (d > 0.3 && (dx * fx + dz * fz) / d < 0.34) continue;      // 70 degree half-cone
      if (this._hitN < this._hitIds.length) this._hitIds[this._hitN++] = t.id;
      const dealt = t.onHeroHit ? t.onHeroHit(this, v, this.actionId) : 0;
      if (dealt > 0) { this.damageDealt += dealt; if (v.charge) this.chargedHits++; }
      if (this.hitSink) this.hitSink(t, dealt, v);
    }
  }

  // Incoming contact record (WyvernBrain / DuelistSim rec shape). Applied exactly once by the attacker.
  applyContact(R) {
    if (this.state === HERO_STATE.DEAD) return;
    const O = Outcome;
    if ((R.outcome === O.HIT || R.outcome === O.BLOCKED) && R.damage > 0) this.hpIdle = 0;
    if (R.outcome === O.HIT && R.damage >= 8) this.charging = false;
    if (R.outcome === O.HIT) {
      this.hp -= R.damage; this.damageTaken += R.damage; this.hitsTaken++; this.flash = 12;
      if (this.god && this.hp < 1) this.hp = 1;
      if (this.hp <= 0) { this.hp = 0; this.state = HERO_STATE.DEAD; this.actF = 0; this.blocking = false; this.dodgeF = -1; this._event('death'); }
      else if (R.damage >= 8) { this.state = HERO_STATE.HITSTUN; this.actF = 0; this.hitstunLen = HITSTUN_F; this.blocking = false; this.queued = null; this._event('hit'); }
      else this._event('chip');
    } else if (R.outcome === O.BLOCKED) {
      this.hp = Math.max(this.god ? 1 : 0, this.hp - (R.damage || 0));
      this.stamina -= (R.posture || 0) * 0.5; this.staminaIdle = 0;
      if (this.stamina <= 0) { this.stamina = 0; this.state = HERO_STATE.HITSTUN; this.actF = 0; this.hitstunLen = GUARDBREAK_F; this.blocking = false; this._event('guardbreak'); }
      else this._event('block');
      if (R.slide > 0) { const l = Math.hypot(R.normal.x, R.normal.z) || 1; this.pushX += R.normal.x / l * R.slide; this.pushZ += R.normal.z / l * R.slide; }
    } else if (R.outcome === O.GUARDBREAK) {
      // Stage 3 G_DOME against a held block (wyvern/duelists never send this to the hero)
      this.hpIdle = 0;
      this.hp = Math.max(this.god ? 1 : 0, this.hp - (R.damage || 0)); this.damageTaken += R.damage || 0;
      if (this.hp <= 0) { this.state = HERO_STATE.DEAD; this.actF = 0; this.blocking = false; this.dodgeF = -1; this._event('death'); }
      else { this.state = HERO_STATE.HITSTUN; this.actF = 0; this.hitstunLen = GUARDBREAK_F; this.blocking = false; this.queued = null; this._event('guardbreak'); }
    } else if (R.outcome === O.PARRIED) {
      if (R.perfect) { this.perfects++; this._event('perfect'); this.stamina = Math.min(SIM.STAMINA_MAX, this.stamina + 15); }
      else { this.deflects++; this._event('deflect'); }
    } else if (R.outcome === O.WHIFF_IFRAME && R.effect && R.effect !== 'none') {
      this.phantoms++; this._event(R.effect);
    }
    if (R.effect === 'slip' || R.effect === 'behind') { this.x = R.tx; this.z = R.tz; this.prevX = this.x; this.prevZ = this.z; }
    if (this.contactSink) this.contactSink(R, this);
  }

  hash() {
    let x = 2166136261 >>> 0;
    const q = (v) => { x = Math.imul(x ^ (Math.round(v * 1000) | 0), 16777619) >>> 0; };
    q(this.x); q(this.z); q(this.yaw); q(this.hp); q(this.stamina); q(this.state); q(this.actF); q(this.weapon);
    return x >>> 0;
  }
}

export const DEATH_HOLD_F = DEATH_F;
