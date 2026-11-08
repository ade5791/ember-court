// DuelistSim - wave enemy simulation (owner: game). Deterministic: fixed 60 Hz, seeded rng stream, no THREE/DOM.
// Decision loop: APPROACH -> SPACE (circle at ring distance, waits for the attack token) -> ATTACK (verb from the
// timing table: E_SLASH / E_THRUST / E_COMBO) -> RECOVER -> SPACE. Hits from the hero -> HIT (flinch) or STAGGER
// (posture break, takes double damage). Contacts go through the same resolveDefence as the boss, once per id.
import { SIM } from '../shared/constants.js';
import { Outcome, Surface, Verb } from '../shared/enums.js';
import { resolveDefence, ART } from '../boss/WyvernBrain.js';

export const DUEL_STATE = Object.freeze({ APPROACH: 0, SPACE: 1, ATTACK: 2, RECOVER: 3, HIT: 4, STAGGER: 5, DEAD: 6 });
export const DUEL_STATE_NAMES = Object.freeze(['APPROACH', 'SPACE', 'ATTACK', 'RECOVER', 'HIT', 'STAGGER', 'DEAD']);

const VERB_STATS = {
  E_SLASH: { dmg: 14, posture: 22, lunge: 0.3, half: 0.9 },
  E_THRUST: { dmg: 18, posture: 26, lunge: 0.8, half: 0.45 },
  E_COMBO: { dmg: 12, posture: 18, lunge: 0.6, half: 0.8 },
  // Stage 2 Shadow Warden only. C_CHARGED is a RED (unblockable, undeflectable) lunge: dodge it. C_SLAM is a
  // wide ground slam with a 2.1 m shock radius: deflectable, punishes standing at the ring.
  C_CHARGED: { dmg: 30, posture: 40, lunge: 2.2, half: 0.7, art: ART.RED },
  C_SLAM: { dmg: 26, posture: 34, lunge: 0.5, half: 1.6, reach: 2.1 },
};
const VERB_ENUM = { E_SLASH: Verb.E_SLASH, E_THRUST: Verb.E_THRUST, E_COMBO: Verb.E_COMBO, C_CHARGED: Verb.C_CHARGED, C_SLAM: Verb.C_GROUND_SLAM };
// Stage 2 elite profile (docs/STAGE2_SPEC.md). Phase 2 below half HP: shorter waits, follow-up chains.
export const WARDEN = Object.freeze({ HP: 420, RING: 3.4, POSTURE: 150, ENRAGE_FRAC: 0.5, GUARD_P: 0.45, CHAIN_P: 0.5,
  VERBS: ['E_SLASH', 'E_THRUST', 'E_COMBO', 'C_CHARGED', 'C_SLAM'], SPAWN: [0, -6], SCALE: 1.12 });
export const DUELIST = Object.freeze({ HP: 70, POSTURE: 60, RADIUS: SIM.CAPSULE_RADIUS, RING: 2.6, WALK: 1.5, RUN: 3.4,
  HIT_F: 18, STAGGER_F: 100, DEATH_F: 110, TURN: 4.0 });
const TAU = Math.PI * 2;
function wrap(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }

export class DuelistSim {
  constructor({ id, timing, rng, colliders = null, x = 0, z = 0, aggression = 1, elite = false }) {
    this.id = id; this.rng = rng; this.colliders = colliders; this.aggression = aggression;
    this.elite = elite; this.phase = 1; this.phaseSink = null;
    this.ring = elite ? WARDEN.RING : DUELIST.RING;
    this.hpMax = elite ? WARDEN.HP : DUELIST.HP; this.postureMax = elite ? WARDEN.POSTURE : DUELIST.POSTURE;
    this.verbs = {};
    for (const k of (elite ? WARDEN.VERBS : ['E_SLASH', 'E_THRUST', 'E_COMBO'])) {
      const t = timing.verbs[k], v = { name: k, clip: t.clip, reach: t.contactDistM || 1.4, art: ART.NORMAL, ...VERB_STATS[k] };
      v.phases = t.phases.map((p) => ({ ...p })); let f = 0; v.active = [];
      for (const p of v.phases) { p.start = f; if (p.phase.startsWith('ACTIVE')) v.active.push([f, f + p.specF]); f += p.specF; }
      v.total = f; v.startup = v.phases[0].specF;
      this.verbs[k] = v;
    }
    this.radius = DUELIST.RADIUS;
    this.x = x; this.z = z; this.yaw = 0; this.prevX = x; this.prevZ = z; this.prevYaw = 0;
    this.hp = this.hpMax; this.posture = 0;
    this.knockX = 0; this.knockZ = 0; this.knockF = 0;   // v2.22 sweep knockback (metres per frame, frames left)
    this.state = DUEL_STATE.APPROACH; this.f = 0; this.verb = null; this.actionId = 0; this.hitSeg = -1;
    this.spaceDir = rng.float() < 0.5 ? 1 : -1; this.spaceF = 0; this.waitF = 40 + (rng.float() * 40 | 0);
    this.wantsToken = false; this.hasToken = false; this.speed = 0; this.guard = false;
    this.rec = { actionId: 0, attackerId: id, targetId: 0, verb: 0, outcome: 0, damage: 0, posture: 0, art: ART.NORMAL,
      effect: 'none', perfect: false, pos: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, surface: Surface.FLESH, tx: 0, tz: 0, frame: 0 };
    this.heroSink = null;          // (rec) => void
    this.telegraphSink = null;     // (duelist, verbDef) => void
    this.anim = { clip: 'e_idle', time: 0, loop: true };
    this._animT = 0;
  }

  get targetable() { return this.state !== DUEL_STATE.DEAD; }
  get alive() { return this.state !== DUEL_STATE.DEAD; }
  forwardX() { return -Math.sin(this.yaw); }
  forwardZ() { return -Math.cos(this.yaw); }

  _turn(tx, tz, rate) {
    const want = Math.atan2(-(tx - this.x), -(tz - this.z)), d = wrap(want - this.yaw), m = rate / 60;
    this.yaw = wrap(this.yaw + Math.max(-m, Math.min(m, d)));
    return d;
  }

  // Clip time for the current verb at frame f (piecewise warp from the timing table).
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

  step(hero, frame) {
    this.prevX = this.x; this.prevZ = this.z; this.prevYaw = this.yaw;
    const dx = hero.x - this.x, dz = hero.z - this.z, dist = Math.hypot(dx, dz) || 1e-6;
    let mx = 0, mz = 0, anim = 'e_idle';
    this.f++;
    const heroDead = !hero.alive;
    switch (this.state) {
      case DUEL_STATE.DEAD: anim = 'e_death'; break;
      case DUEL_STATE.HIT:
        anim = 'e_hit';
        if (this.f >= DUELIST.HIT_F) { this.state = DUEL_STATE.SPACE; this.f = 0; }
        break;
      case DUEL_STATE.STAGGER:
        anim = this.f < 40 ? 'e_hit' : 'e_idle';
        if (this.f >= DUELIST.STAGGER_F) { this.state = DUEL_STATE.SPACE; this.f = 0; this.posture = 0; }
        break;
      case DUEL_STATE.APPROACH: {
        this._turn(hero.x, hero.z, DUELIST.TURN);
        if (dist > this.ring + 0.4) { const s = DUELIST.RUN / 60; mx = this.forwardX() * s; mz = this.forwardZ() * s; anim = 'e_run'; this.speed = DUELIST.RUN; }
        else { this.state = DUEL_STATE.SPACE; this.f = 0; }
        break;
      }
      case DUEL_STATE.SPACE: {
        this._turn(hero.x, hero.z, DUELIST.TURN);
        this.wantsToken = !heroDead && this.f >= this.waitF;
        const nx = dx / dist, nz = dz / dist;
        if (this.hasToken && this.wantsToken) {
          // close in, then commit
          const v = this._pickVerb(dist);
          // the red charge is a lunge: it commits from lunge range, everything else closes to reach first
          if (dist <= v.reach + 0.9 + (v.name === 'C_CHARGED' ? v.lunge : 0)) { this._startAttack(v.name); break; }
          const s = DUELIST.RUN / 60; mx = nx * s; mz = nz * s; anim = 'e_run';
        } else {
          // circle at the ring; drift radially toward the ring distance
          const radial = (dist - this.ring) * 0.04;
          if (++this.spaceF > 150 + (this.id % 3) * 30) { this.spaceF = 0; this.spaceDir = -this.spaceDir; }
          const s = DUELIST.WALK / 60;
          mx = (-nz * this.spaceDir) * s + nx * Math.max(-s, Math.min(s, radial));
          mz = (nx * this.spaceDir) * s + nz * Math.max(-s, Math.min(s, radial));
          anim = radial < -0.002 ? 'e_back' : 'e_walk';
        }
        break;
      }
      case DUEL_STATE.ATTACK: {
        const v = this.verbs[this.verb];
        if (this.f < v.startup - 6) this._turn(hero.x, hero.z, DUELIST.TURN);   // tracks until late startup, then commits
        const lungeEnd = v.startup + 4;
        if (this.f <= lungeEnd && dist > v.reach * 0.7) { const s = v.lunge / lungeEnd; mx = this.forwardX() * s; mz = this.forwardZ() * s; }
        for (let i = 0; i < v.active.length; i++) {
          const a = v.active[i];
          if (this.f >= a[0] && this.f < a[1] && this.hitSeg < i) this._tryContact(hero, v, i, dist, dx, dz, frame);
        }
        anim = v.clip;
        if (this.f >= v.total) { this.state = DUEL_STATE.RECOVER; this.f = 0; this.hasToken = false; this.wantsToken = false; }
        break;
      }
      case DUEL_STATE.RECOVER:
        this._turn(hero.x, hero.z, DUELIST.TURN * 0.5);
        if (this.f >= 20) {
          // phase-2 warden: a follow-up (thrust or the red charge) straight out of recovery, still telegraphed
          if (this.elite && this.phase >= 2 && !heroDead && this.rng.float() < WARDEN.CHAIN_P && dist < 4.5) {
            this._startAttack(dist > 2.4 ? 'C_CHARGED' : 'E_THRUST'); this.hasToken = true; break;
          }
          this.state = DUEL_STATE.SPACE; this.f = 0; this.waitF = (50 + this.rng.float() * 60) / this.aggression | 0;
        }
        break;
    }
    // integrate + collide (boulders and walls); hero push-out is handled by the director (actor separation)
    if (this.knockF > 0) { const k = this.knockF / 10; mx += this.knockX * k; mz += this.knockZ * k; this.knockF--; }
    this.x += mx; this.z += mz;
    if (this.colliders) { const r = this.colliders.resolveCapsule(this.x, this.z, this.radius, 0.0, SIM.ACTOR_HEIGHT); this.x = r.x; this.z = r.z; }
    const C = this.colliders, limX = (C ? C.halfX : SIM.ARENA_HALF) - this.radius, limZ = (C ? C.halfZ : SIM.ARENA_HALF) - this.radius;
    this.x = Math.max(-limX, Math.min(limX, this.x)); this.z = Math.max(-limZ, Math.min(limZ, this.z));
    if (this.state !== DUEL_STATE.APPROACH) this.speed = Math.hypot(this.x - this.prevX, this.z - this.prevZ) * 60;
    // animation selection for presentation (clip + time); attack clips are time-warped from the table
    const A = this.anim;
    if (this.state === DUEL_STATE.ATTACK) { A.clip = this.verbs[this.verb].clip; A.time = this.verbClipTime(this.f); A.loop = false; }
    else if (this.state === DUEL_STATE.DEAD) { A.clip = 'e_death'; A.time = Math.min(this.f, DUELIST.DEATH_F) / 60; A.loop = false; }
    else if (anim === 'e_hit') { A.clip = 'e_hit'; A.time = Math.min(this.f, 40) / 60; A.loop = false; }
    else { if (A.clip !== anim) this._animT = 0; this._animT += 1 / 60; A.clip = anim; A.time = this._animT; A.loop = true; }
  }

  _pickVerb(dist) {
    if (!this._next && this.elite) {
      const r = this.rng.float();
      // far: the red charge closes distance; near: slam or the strings
      this._next = dist > 3.0 ? (r < 0.55 ? 'C_CHARGED' : 'E_THRUST')
        : (r < 0.25 ? 'E_SLASH' : r < 0.5 ? 'E_COMBO' : r < 0.72 ? 'C_SLAM' : r < 0.88 ? 'E_THRUST' : 'C_CHARGED');
    }
    if (!this._next) {
      const r = this.rng.float();
      this._next = dist > 2.2 ? (r < 0.6 ? 'E_THRUST' : 'E_COMBO') : (r < 0.45 ? 'E_SLASH' : r < 0.75 ? 'E_COMBO' : 'E_THRUST');
    }
    return this.verbs[this._next];
  }

  _startAttack(name) {
    this.state = DUEL_STATE.ATTACK; this.verb = name; this.f = 0; this.actionId++; this.hitSeg = -1; this._next = null;
    // per-verb start counts (QA reads these instead of sampling state; not hashed, no gameplay effect)
    (this.verbCounts || (this.verbCounts = {}))[name] = (this.verbCounts[name] || 0) + 1;
    if (this.telegraphSink) this.telegraphSink(this, this.verbs[name]);
  }

  _tryContact(h, v, seg, dist, dx, dz, frame) {
    const hr = h.radius || SIM.CAPSULE_RADIUS;
    if (dist > v.reach + hr + this.radius * 0.5) return;
    const fwd = (dx * this.forwardX() + dz * this.forwardZ()) / dist;
    if (Math.acos(Math.max(-1, Math.min(1, fwd))) > v.half) return;
    this.hitSeg = seg;
    h.stepToward = 0;
    const res = resolveDefence(v.art, h, false);
    const R = this.rec; R.art = v.art;
    R.actionId = this.id * 100000 + this.actionId * 4 + seg; R.targetId = h.id; R.verb = VERB_ENUM[v.name];
    R.outcome = res.outcome; R.perfect = res.perfect; R.effect = res.effect; R.frame = frame;
    R.damage = res.outcome === Outcome.HIT ? v.dmg : 0;
    R.posture = res.outcome === Outcome.BLOCKED ? v.posture : 0;
    R.pos.x = h.x; R.pos.y = 1.15; R.pos.z = h.z;
    R.normal.x = -dx / dist; R.normal.y = 0.2; R.normal.z = -dz / dist; R.tx = h.x; R.tz = h.z;
    if (res.outcome === Outcome.PARRIED) {
      // deflected: posture damage to the duelist, perfect deflect staggers outright
      this.posture += res.perfect ? (this.elite ? 48 : DUELIST.POSTURE) : 30;
      if (this.posture >= this.postureMax) { this.state = DUEL_STATE.STAGGER; this.f = 0; this.hasToken = false; }
      else { this.state = DUEL_STATE.RECOVER; this.f = -12; this.hasToken = false; }
    }
    if (this.heroSink) this.heroSink(R);
  }

  // Hero swing landed (HeroSim._resolveSwing). Returns damage dealt.
  onHeroHit(hero, v) {
    if (this.state === DUEL_STATE.DEAD) return 0;
    // guard: a spacing duelist facing the hero blocks the first light hit of a string (posture still builds)
    const toHx = hero.x - this.x, toHz = hero.z - this.z, l = Math.hypot(toHx, toHz) || 1;
    const facing = (toHx * this.forwardX() + toHz * this.forwardZ()) / l > 0.5;
    // warden: guards any light from the front while spacing (not just the opener) - break posture or flank him
    // v2.27 dance steps: heavies (v.heavy) count as HEAVY; the dance openers (D_L1 / D_L4) are guardable like LIGHT_1
    const hv = v.name === 'HEAVY' || !!v.heavy;
    const guardable = this.elite ? !hv : (v.name === 'LIGHT_1' || v.name === 'D_L1' || v.name === 'D_L4');
    const blocks = this.state === DUEL_STATE.SPACE && facing && guardable && this.rng.float() < (this.elite ? WARDEN.GUARD_P : 0.5);
    const stag = this.state === DUEL_STATE.STAGGER;
    let dmg = blocks ? 0 : Math.round(v.dmg * (stag ? 2 : 1));
    this.posture += blocks ? v.posture * 1.5 : v.posture;
    this.hp = Math.max(0, this.hp - dmg);
    this.lastHitBlocked = blocks;
    if (v.knock > 0 && !blocks && this.hp > 0) {   // sweep shove away from the hero: sum of k/10 over 10 frames = 5.5 x per-frame
      this.knockX = -toHx / l * v.knock / 5.5; this.knockZ = -toHz / l * v.knock / 5.5; this.knockF = 10;
    }
    if (this.hp <= 0) { this.state = DUEL_STATE.DEAD; this.f = 0; this.hasToken = false; return dmg; }
    if (this.elite && this.phase === 1 && this.hp <= this.hpMax * WARDEN.ENRAGE_FRAC) {
      this.phase = 2; this.aggression *= 1.6; if (this.phaseSink) this.phaseSink(this);
    }
    // hyper armour: the warden's C_ verbs do not flinch (only posture break stops them)
    const armoured = this.elite && this.state === DUEL_STATE.ATTACK && this.verb && this.verb.startsWith('C_');
    if (!stag && this.posture >= this.postureMax) { this.state = DUEL_STATE.STAGGER; this.f = 0; this.hasToken = false; }
    else if (!stag && !blocks && !armoured && (this.state !== DUEL_STATE.ATTACK || hv)) { this.state = DUEL_STATE.HIT; this.f = 0; this.hasToken = false; }
    return dmg;
  }
}

// Attack-token director: at most `max` duelists commit at once, round robin by wait time.
export function assignTokens(duelists, max = 1) {
  let holders = 0;
  for (const d of duelists) if (d.hasToken && d.alive) holders++;
  for (const d of duelists) {
    if (holders >= max) break;
    if (d.alive && d.wantsToken && !d.hasToken) { d.hasToken = true; holders++; }
  }
}

// Actor separation: duelists never overlap each other or the hero (they yield, the hero is not pushed).
export function separate(duelists, hero) {
  for (let i = 0; i < duelists.length; i++) {
    const a = duelists[i]; if (!a.alive) continue;
    const dx = a.x - hero.x, dz = a.z - hero.z, l = Math.hypot(dx, dz), min = a.radius + hero.radius + 0.25;   // capsules are 0.35 m; shoulders/stance need the extra 0.25 m to stop mesh overlap
    if (l < min && l > 1e-6) { a.x += dx / l * (min - l); a.z += dz / l * (min - l); }
    for (let j = i + 1; j < duelists.length; j++) {
      const b = duelists[j]; if (!b.alive) continue;
      const ex = b.x - a.x, ez = b.z - a.z, m = Math.hypot(ex, ez), mm = a.radius + b.radius + 0.2;
      if (m < mm && m > 1e-6) { const k = (mm - m) * 0.5 / m; a.x -= ex * k; a.z -= ez * k; b.x += ex * k; b.z += ez * k; }
    }
  }
}
