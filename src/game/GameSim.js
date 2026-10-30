// GameSim - the whole run as one deterministic unit (owner: game). No THREE, no DOM, no Math.random.
// Flow: TITLE -> INTRO -> WAVE 1 -> WAVE_CLEAR -> WAVE 2 -> WAVE_CLEAR -> BOSS -> VICTORY | DEFEAT.
// Owns HeroSim, the wave duelists and the WyvernBrain; the page (src/game/main.js) only feeds a hero command
// per fixed step and draws what this produces. Same seed + same commands -> same run (hash()).
import { SIM, BOSS } from '../shared/constants.js';
import { GameState, Outcome } from '../shared/enums.js';
import { Rng } from '../core/Rng.js';
import { WyvernBrain, BRAIN_STATE, ART } from '../boss/WyvernBrain.js';
import { HeroSim, HERO_STATE, makeHeroCommand } from './HeroSim.js';
import { DuelistSim, DUEL_STATE, assignTokens, separate } from './DuelistSim.js';

export const GAME_STATE_NAMES = Object.freeze(['BOOT', 'TITLE', 'INTRO', 'WAVE', 'WAVE_CLEAR', 'BOSS', 'VICTORY', 'DEFEAT']);
export const WAVES = Object.freeze([
  Object.freeze({ name: 'The Ford Guard', spawns: [[-3.0, -6.0], [3.0, -6.0]], tokens: 1, aggression: 1.0 }),
  Object.freeze({ name: 'Ember Duelists', spawns: [[-5.0, -5.0], [0.0, -8.0], [5.0, -5.0]], tokens: 1, aggression: 1.25 }),
]);
export const FLOW_F = Object.freeze({ INTRO: 150, WAVE_CLEAR: 150, VICTORY_HOLD: 150, DEFEAT_HOLD: 120, BOSS_HOLD: 130 });
const HERO_SPAWN = [0, 9, 0];
const BOSS_ID = 100, HERO_ID = 1;

export class GameSim {
  constructor({ seed = SIM.SEED_DEFAULT, timing, colliders = null, bus = null, god = false, startAt = 'title' }) {
    this.seed = seed >>> 0; this.timing = timing; this.colliders = colliders; this.bus = bus; this.god = god;
    this.hero = new HeroSim({ timing, colliders, god });
    this.hero.id = HERO_ID;
    this.hero.contactSink = (R) => { if (this.onHeroContact) this.onHeroContact(R); };
    this.hero.hitSink = (t, dealt, v) => { if (this.onHeroHit) this.onHeroHit(t, dealt, v); };
    this.cmd = makeHeroCommand();
    this.duelists = [];
    this.targets = [];
    this.bossTarget = { id: BOSS_ID, x: 0, z: 0, radius: BOSS.BODY_RADIUS, targetable: false, isBoss: true,
      onHeroHit: (h, v) => this._hitBoss(h, v) };
    // presentation hooks (copy what you keep)
    this.onState = null; this.onHeroContact = null; this.onHeroHit = null; this.onTelegraph = null; this.onDuelistTelegraph = null;
    this.reset(startAt);
  }

  reset(startAt = 'title') {
    const root = new Rng(this.seed);
    this.rngWave = root.stream('waves');
    this.brain = new WyvernBrain().init({}, { rng: root.stream('boss'), colliders: this.colliders, bus: this.bus, actorId: BOSS_ID });
    this.brain.heroSink = (R) => this.hero.applyContact(R);
    this.brain.telegraphSink = (v, art, lead) => { if (this.onTelegraph) this.onTelegraph(v, art, lead); };
    this.hero.reset(HERO_SPAWN[0], HERO_SPAWN[1], HERO_SPAWN[2]);
    this.duelists.length = 0;
    this.frame = 0; this.stateF = 0; this.wave = -1; this.bossActive = false;
    this.stats = { kills: 0, waveTimes: [], bossF: 0, totalF: 0, perfects: 0, phantoms: 0, finishers: 0, damageTaken: 0, damageDealt: 0 };
    this.state = GameState.TITLE;
    if (startAt === 'wave2') { this._spawnWave(1); this._setState(GameState.WAVE); }
    else if (startAt === 'boss') this._startBoss();
    else if (startAt === 'wave1') { this._spawnWave(0); this._setState(GameState.WAVE); }
    else this._setState(GameState.TITLE);
  }

  _setState(s) {
    this.state = s; this.stateF = 0;
    if (this.bus) { const p = this.bus.payload('game/state'); p.state = s; p.name = GAME_STATE_NAMES[s]; p.wave = this.wave; this.bus.dispatch('game/state'); }
    if (this.onState) this.onState(s, this);
  }

  start() { if (this.state === GameState.TITLE) this._setState(GameState.INTRO); }

  _spawnWave(i) {
    this.wave = i; this.duelists.length = 0;
    const W = WAVES[i];
    for (let k = 0; k < W.spawns.length; k++) {
      const d = new DuelistSim({ id: 10 + i * 10 + k, timing: this.timing, rng: this.rngWave, colliders: this.colliders,
        x: W.spawns[k][0], z: W.spawns[k][1], aggression: W.aggression });
      d.yaw = Math.PI;      // face the player bank (+Z)
      d.heroSink = (R) => this.hero.applyContact(R);
      d.telegraphSink = (dd, v) => { if (this.onDuelistTelegraph) this.onDuelistTelegraph(dd, v); };
      this.duelists.push(d);
    }
    this.waveStartF = this.frame;
    if (this.bus) { const p = this.bus.payload('wave/start'); p.wave = i; p.count = W.spawns.length; this.bus.dispatch('wave/start'); }
  }

  _startBoss() {
    this.duelists.length = 0; this.wave = WAVES.length; this.bossActive = true; this.bossStartF = this.frame;
    this.brain.startIntro();
    this._setState(GameState.BOSS);
  }

  _hitBoss(h, v) {
    const B = this.brain;
    if (B.airborne && B.y > 2.0) return 0;
    const hx = B.x + B.forwardX() * 2.6, hz = B.z + B.forwardZ() * 2.6;
    const part = Math.hypot(h.x - hx, h.z - hz) < 1.6 ? 'head' : 'body';
    const back = this.frame <= B.backstabUntil;
    const counter = this.frame <= B.counterUntil ? 1.5 : 1;
    return B.takeHit(Math.round(v.dmg * counter), v.posture, part, back);
  }

  // Finisher prompt: true when a heavy press now would start one.
  finisherReady() {
    if (this.state !== GameState.BOSS || !this.hero.alive || this.hero.state === HERO_STATE.FINISHER) return false;
    return this.brain.canFinish(this.hero);
  }

  // One fixed step. cmd is filled by the caller (input layer or QA bot) before the call.
  step() {
    this.frame++; this.stateF++;
    const S = GameState, h = this.hero, c = this.cmd;
    if (this.state === S.TITLE || this.state === S.VICTORY && this.stateF > FLOW_F.VICTORY_HOLD * 4) return;

    // targets for hero swings
    const T = this.targets; T.length = 0;
    for (const d of this.duelists) T.push(d);
    if (this.bossActive) {
      const B = this.brain, bt = this.bossTarget;
      bt.x = B.x; bt.z = B.z; bt.targetable = B.state !== BRAIN_STATE.DEAD && !(B.airborne && B.y > 2.0) && B.finisherF < 0;
      T.push(bt);
    }
    // boss finisher replaces the heavy when available
    if (c.heavy && this.finisherReady()) {
      if (this.brain.startFinisher(h)) { h.startFinisher(this.bossTarget); this.stats.finishers++; c.heavy = false; }
    }
    // INTRO and the boss intro/roar: hero may move but cannot attack yet (no targets to hurt anyway)
    if (this.state === S.INTRO || this.state === S.WAVE_CLEAR) { c.attack = c.attack && false; }
    h.step(c, T);

    if (this.state === S.INTRO) {
      if (this.stateF >= FLOW_F.INTRO) { this._spawnWave(0); this._setState(S.WAVE); }
    } else if (this.state === S.WAVE) {
      assignTokens(this.duelists, WAVES[this.wave].tokens);
      for (const d of this.duelists) { d.step(h, this.frame); if (!d.alive && !d.counted) { d.counted = true; this._kill(d); } }
      separate(this.duelists, h);
      let alive = 0; for (const d of this.duelists) if (d.alive) alive++;
      if (alive === 0 && h.alive) {
        this.stats.waveTimes.push(this.frame - this.waveStartF);
        if (this.bus) { const p = this.bus.payload('wave/clear'); p.wave = this.wave; this.bus.dispatch('wave/clear'); }
        this._setState(S.WAVE_CLEAR);
      }
    } else if (this.state === S.WAVE_CLEAR) {
      for (const d of this.duelists) d.step(h, this.frame);            // corpses finish their death clip
      if (this.stateF >= FLOW_F.WAVE_CLEAR) {
        if (this.wave + 1 < WAVES.length) { this._spawnWave(this.wave + 1); this._setState(S.WAVE); }
        else this._startBoss();
      }
    } else if (this.state === S.BOSS) {
      this.brain.fixedUpdate(h, this.frame);
      this.stats.bossF++;
      if (this.brain.state === BRAIN_STATE.DEAD && this.brain.f >= FLOW_F.BOSS_HOLD) { this._finish(true); return; }
    }
    if (!h.alive && h.actF >= FLOW_F.DEFEAT_HOLD && this.state !== S.DEFEAT && this.state !== S.VICTORY) this._finish(false);
    if (this.state !== S.VICTORY && this.state !== S.DEFEAT) this.stats.totalF++;
  }

  _kill(d) {
    this.stats.kills++;
    if (this.bus) { const p = this.bus.payload('actor/death'); p.actorId = d.id; this.bus.dispatch('actor/death'); }
  }

  _finish(won) {
    const s = this.stats, h = this.hero;
    s.perfects = h.perfects; s.phantoms = h.phantoms; s.damageTaken = h.damageTaken; s.damageDealt = h.damageDealt;
    s.won = won; s.bossHp = this.brain.hp;
    if (this.bus) { const p = this.bus.payload('run/end'); p.won = won; p.frames = s.totalF; this.bus.dispatch('run/end'); }
    this._setState(won ? GameState.VICTORY : GameState.DEFEAT);
  }

  // Retry from the start of the encounter that was lost (boss retry keeps the waves cleared).
  retry() {
    const atBoss = this.bossActive;
    this.reset(atBoss ? 'boss' : 'title');
    if (!atBoss) this._setState(GameState.INTRO);
  }

  hash() {
    let x = this.hero.hash() ^ this.brain.hash();
    const q = (v) => { x = Math.imul(x ^ (Math.round(v * 1000) | 0), 16777619) >>> 0; };
    for (const d of this.duelists) { q(d.x); q(d.z); q(d.hp); q(d.state); }
    q(this.state); q(this.frame);
    return x >>> 0;
  }

  dispose() { this.brain.dispose(); this.onState = this.onHeroContact = this.onHeroHit = this.onTelegraph = this.onDuelistTelegraph = null; }
}

export { GameState, HERO_STATE, DUEL_STATE, BRAIN_STATE, ART, Outcome };
