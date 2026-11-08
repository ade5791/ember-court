// GameSim - the whole run as one deterministic unit (owner: game). No THREE, no DOM, no Math.random.
// Flow: TITLE -> INTRO -> WAVE 1 -> WAVE_CLEAR -> WAVE 2 -> WAVE_CLEAR -> BOSS -> VICTORY | DEFEAT.
// Owns HeroSim, the wave duelists and the WyvernBrain; the page (src/game/main.js) only feeds a hero command
// per fixed step and draws what this produces. Same seed + same commands -> same run (hash()).
import { SIM, BOSS, GAUNTLET } from '../shared/constants.js';
import { GameState, Outcome } from '../shared/enums.js';
import { Rng } from '../core/Rng.js';
import { WyvernBrain, BRAIN_STATE, ART } from '../boss/WyvernBrain.js';
import { GauntletBrain, G_STATE } from '../boss/GauntletBrain.js';
import { HeroSim, HERO_STATE, makeHeroCommand } from './HeroSim.js';
import { StyleMeter } from './StyleMeter.js';
import { DuelistSim, DUEL_STATE, assignTokens, separate, WARDEN } from './DuelistSim.js';
import { ROAD, ROAD_AMBUSH, AMBUSH_SPAWNS, roadX } from '../shared/road.js';

export const GAME_STATE_NAMES = Object.freeze(['BOOT', 'TITLE', 'INTRO', 'WAVE', 'WAVE_CLEAR', 'BOSS', 'VICTORY', 'DEFEAT', 'DOOR', 'STAGE3', 'STAGE2', 'GATE', 'LOOT', 'ROAD']);
export const WARDEN_ID = 300;
export const WAVES = Object.freeze([
  Object.freeze({ name: 'The Ford Guard', spawns: [[-3.0, -6.0], [3.0, -6.0]], tokens: 1, aggression: 1.0 }),
  Object.freeze({ name: 'Ember Duelists', spawns: [[-5.0, -5.0], [0.0, -8.0], [5.0, -5.0]], tokens: 1, aggression: 1.25 }),
]);
// v2.18: every stage opens with its own waves before the boss. Same DuelistSim, same 3-slot pool, per-stage tint.
// Spawns are in each arena's own coordinates (hero spawns at +Z, boss/warden side is -Z).
export const STAGE_WAVES = Object.freeze({
  shrine: Object.freeze([
    Object.freeze({ name: 'Shrine Acolytes', spawns: [[-3.5, -5.5], [3.5, -5.5]], tokens: 1, aggression: 1.15, hp: 80 }),
    Object.freeze({ name: 'Dusk Blades', spawns: [[-5.0, -4.5], [0.0, -7.5], [5.0, -4.5]], tokens: 2, aggression: 1.3, hp: 80 }),
  ]),
  foundry: Object.freeze([
    Object.freeze({ name: 'Foundry Thralls', spawns: [[-3.5, -4.0], [3.5, -4.0]], tokens: 1, aggression: 1.3, hp: 95 }),
    Object.freeze({ name: 'Chrome Wardens', spawns: [[-5.0, -3.5], [0.0, -6.0], [5.0, -3.5]], tokens: 2, aggression: 1.45, hp: 95 }),
  ]),
});
// ROAD: DOOR / GATE length (the road-map leg plays across it). LOOT_AUTO: an unclaimed boss drop flies to the
// hero after this long, so a run never stalls on loot. LOOT_HOLD: beat between the claim and the road map.
export const FLOW_F = Object.freeze({ INTRO: 150, WAVE_CLEAR: 150, VICTORY_HOLD: 150, DEFEAT_HOLD: 120, BOSS_HOLD: 130,
  ROAD: 190, LOOT_AUTO: 300, LOOT_HOLD: 75 });
// v2.19 campaign route (road map + per-boss drops). One leg per stage; drop = weapon id from HeroSim.WEAPONS.
export const ROUTE = Object.freeze([
  Object.freeze({ key: 'ford', place: 'THE CRIMSON FORD', boss: 'FORD WYVERN', drop: 2 }),
  Object.freeze({ key: 'shrine', place: 'THE DUSK SHRINE', boss: 'SHADOW WARDEN', drop: 3 }),
  Object.freeze({ key: 'foundry', place: 'THE FROZEN FOUNDRY', boss: 'CHROME GAUNTLET', drop: 4 }),
]);
// ARM: frames the drop rises out of the corpse before it can be claimed (the boss often dies at sword range, so
// without it the hero stood on the drop and claimed it on frame 1 - nobody ever saw it)
export const DROP = Object.freeze({ R: 1.0, CLAMP: 8.5, ARM: 55 });
const HERO_SPAWN = [0, 9, 0];
// v2.10 great sword pickup: planted in the ford beside the wyvern's landing spot (BOSS.SPAWN 0,-9) when the boss
// fight starts. Walking into it equips it (no extra button, works the same on touch). Radius is hero centre to hilt.
export const GREAT_PICKUP = Object.freeze({ X: 4.2, Z: -4.6, R: 1.1 });
const BOSS_ID = 100, HERO_ID = 1, GAUNTLET_ID = 200;

export class GameSim {
  constructor({ seed = SIM.SEED_DEFAULT, timing, colliders = null, bus = null, god = false, startAt = 'title', dodgeProfile = null, stage3 = false, stage3Colliders = null, stage2Colliders = null, weapon = 0, roadColliders = null, road = true, character = 'hero' }) {
    // v2.20 road: between two bosses the hero walks a 120 m pass and fights three ambushes (src/shared/road.js).
    // Needs the road collider doc; without it (old fixtures) DOOR/GATE jump straight to the next stage as before.
    this.roadColliders = roadColliders; this.road = !!(road && roadColliders);
    this.onAmbush = null;
    // weapon: review-state carry (?wpn=N) - the best boss drop the hero is assumed to hold on a stage entry
    this.carryStart = weapon | 0;
    // stage3: after the wyvern dies the run goes DOOR -> STAGE3 (Frozen Foundry) instead of VICTORY.
    // Off by default until the foundry presentation ships; startAt 'stage3' always enters it.
    this.stage3 = stage3 || startAt === 'stage3' || startAt === 'road0' || startAt === 'road1';
    this.seed = seed >>> 0; this.timing = timing; this.colliders = colliders; this.bus = bus; this.god = god;
    // stage3Colliders: the Frozen Foundry doc (assets/foundry-colliders.json). Swapped in on Stage 3 entry and back
    // out on any reset that leaves Stage 3, so the hero never collides with the ford while standing in the foundry.
    this.stage3Colliders = stage3Colliders;
    // stage2Colliders: the Dusk Shrine doc (assets/shrine-colliders.json); falls back to the ford when absent (fixtures).
    this.stage2Colliders = stage2Colliders;
    this.hero = new HeroSim({ timing, colliders, god, dodgeProfile });
    this.hero.id = HERO_ID;
    this.hero.setCharacter(character);   // v2.24 loadout before the first reset below (hero = unchanged)
    // style meter (DMC layer): fed from the authoritative hit / contact sinks, never from visuals
    this.style = new StyleMeter();
    this.hero.contactSink = (R) => { this._styleContact(R); if (this.onHeroContact) this.onHeroContact(R); };
    this.hero.hitSink = (t, dealt, v) => {
      if (dealt > 0 && !v.burst) this._styleAdd(v.charge ? 'CHARGED' : v.name);
      if (this.onHeroHit) this.onHeroHit(t, dealt, v);
    };
    this.cmd = makeHeroCommand();
    this.duelists = [];
    this.targets = [];
    this.bossTarget = { id: BOSS_ID, x: 0, z: 0, radius: BOSS.BODY_RADIUS, targetable: false, isBoss: true,
      onHeroHit: (h, v) => this._hitBoss(h, v) };
    this.gauntletTarget = { id: GAUNTLET_ID, x: 0, z: 0, radius: GAUNTLET.BODY_RADIUS, targetable: false, isBoss: true,
      onHeroHit: (h, v) => this._hitGauntlet(h, v) };
    // presentation hooks (copy what you keep)
    this.onEquip = null;
    this.onState = null; this.onHeroContact = null; this.onHeroHit = null; this.onTelegraph = null; this.onDuelistTelegraph = null; this.onGauntletTelegraph = null;
    this.reset(startAt);
  }

  reset(startAt = 'title') {
    const root = new Rng(this.seed);
    this.rngWave = root.stream('waves');
    this.brain = new WyvernBrain().init({}, { rng: root.stream('boss'), colliders: this.colliders, bus: this.bus, actorId: BOSS_ID });
    this.brain.heroSink = (R) => this.hero.applyContact(R);
    this.brain.telegraphSink = (v, art, lead) => { if (this.onTelegraph) this.onTelegraph(v, art, lead); };
    this.gauntlet = new GauntletBrain().init({}, { rng: root.stream('gauntlet'), colliders: null, bus: this.bus, actorId: GAUNTLET_ID });
    this.gauntlet.heroSink = (R) => this.hero.applyContact(R);
    this.gauntlet.telegraphSink = (v, unguardable, lead) => { if (this.onGauntletTelegraph) this.onGauntletTelegraph(v, unguardable, lead); };
    this.stage3Active = false; this.stage2Active = false; this.warden = null;
    this.roadActive = false; this.roadLeg = -1; this.ambushIdx = -1; this.ambushLive = false; this.roadStartF = 0;
    this.rngRoad = root.stream('road');
    this.rngWarden = root.stream('warden');
    this.hero.colliders = this.colliders;
    this.hero.reset(HERO_SPAWN[0], HERO_SPAWN[1], HERO_SPAWN[2]);
    this.style.reset(); this._seenSnatch = 0; this._seenTrigger = 0; this._seenFinisher = 0; this._seenRift = 0;
    this.duelists.length = 0;
    this.frame = 0; this.stateF = 0; this.wave = -1; this.bossActive = false;
    this.pickup = { x: GREAT_PICKUP.X, z: GREAT_PICKUP.Z, active: false, takenF: -1 };
    // boss drop: spawned at the corpse in LOOT; carry = best drop claimed, kept across stage retries
    this.drop = { x: 0, z: 0, weapon: 0, leg: -1, active: false, takenF: -1, auto: false };
    // stage retries keep carry + claimed (the road map still shows them); a title restart is a fresh campaign;
    // a review-state entry (?start=stage2|stage3&wpn=N) starts from carryStart
    if (this._keepCarry !== undefined) { this.carry = this._keepCarry; this.claimed = this._keepClaimed || []; this._keepCarry = undefined; this._keepClaimed = undefined; }
    else { this.carry = startAt === 'title' && this.frame0Done ? 0 : this.carryStart; this.claimed = []; }
    this.frame0Done = true;
    this.stats = { kills: 0, waveTimes: [], bossF: 0, totalF: 0, perfects: 0, phantoms: 0, finishers: 0, damageTaken: 0, damageDealt: 0 };
    this.state = GameState.TITLE;
    if (startAt === 'wave2') { this._spawnWave(1); this._setState(GameState.WAVE); }
    else if (startAt === 'boss') this._startBoss();
    else if (startAt === 'stage3') this._startStage3();
    else if (startAt === 'stage2') this._startStage2();
    else if (startAt === 'road0') this._startRoad(0);
    else if (startAt === 'road1') this._startRoad(1);
    else if (startAt === 'wave1') { this._spawnWave(0); this._setState(GameState.WAVE); if (this.carry > 0) this.hero.equip(this.carry); }   // ?wpn=N review carry
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
    if (this.hero.weapon === 0 && this.hero.lockW < 0) { this.pickup.active = true; this.pickup.takenF = -1; }   // v2.24: signature-weapon characters skip the pickup
    this._setState(GameState.BOSS);
  }

  // v2.20 road entry (from DOOR / GATE, a road retry or ?start=road0|road1): hero refilled at the near end of the pass,
  // facing down the road (-Z), best drop in hand. Ambushes trigger as he crosses each one's z.
  _startRoad(leg) {
    const weapon = Math.max(this.hero.weapon, this.carry);
    this.duelists.length = 0; this.bossActive = false; this.pickup.active = false; this.drop.active = false;
    this.stage2Active = false; this.stage3Active = false; this.warden = null;
    this.hero.colliders = this.roadColliders;
    this.hero.reset(roadX(ROAD.SPAWN_Z), ROAD.SPAWN_Z, 0);
    if (weapon > 0) this.hero.equip(weapon);
    this.roadActive = true; this.roadLeg = leg; this.ambushIdx = -1; this.ambushLive = false; this.roadStartF = this.frame;
    this._setState(GameState.ROAD);
  }
  get ambushDef() { return this.roadActive && this.ambushIdx >= 0 ? ROAD_AMBUSH[this.roadLeg][this.ambushIdx] : null; }
  get roadCleared() { return this.roadActive && !this.ambushLive && this.ambushIdx === ROAD_AMBUSH[this.roadLeg].length - 1; }
  _spawnAmbush(i) {
    const A = ROAD_AMBUSH[this.roadLeg][i], cx = roadX(A.z), lim = ROAD.HALF_X - 1.0;
    this.ambushIdx = i; this.ambushLive = true; this.duelists.length = 0;
    for (let k = 0; k < A.n; k++) {
      const s = AMBUSH_SPAWNS[k], x = Math.max(-lim, Math.min(lim, cx + s[0])), z = A.z + s[1];
      const d = new DuelistSim({ id: 600 + this.roadLeg * 100 + i * 10 + k, timing: this.timing, rng: this.rngRoad,
        colliders: this.roadColliders, x, z, aggression: A.aggression });
      d.hpMax = A.hp; d.hp = A.hp;
      d.yaw = s[1] < 0 ? Math.PI : 0;          // ahead: face back up the road (+Z); flanker behind: face down it
      d.heroSink = (R) => this.hero.applyContact(R);
      d.telegraphSink = (dd, v) => { if (this.onDuelistTelegraph) this.onDuelistTelegraph(dd, v); };
      this.duelists.push(d);
    }
    this.waveStartF = this.frame;
    if (this.bus) { const p = this.bus.payload('wave/start'); p.wave = i; p.count = A.n; this.bus.dispatch('wave/start'); }
    if (this.onAmbush) this.onAmbush(i, A, this);
  }
  _stepRoad() {
    const h = this.hero, list = ROAD_AMBUSH[this.roadLeg];
    this.stats.roadF = (this.stats.roadF || 0) + 1;
    if (!this.ambushLive && this.ambushIdx + 1 < list.length && h.z < list[this.ambushIdx + 1].z) this._spawnAmbush(this.ambushIdx + 1);
    if (this.ambushLive) assignTokens(this.duelists, list[this.ambushIdx].tokens);
    for (const d of this.duelists) { d.step(h, this.frame); if (!d.alive && !d.counted) { d.counted = true; this._kill(d); } }
    separate(this.duelists, h);
    if (this.ambushLive) {
      let alive = 0; for (const d of this.duelists) if (d.alive) alive++;
      if (alive === 0 && h.alive) {
        this.ambushLive = false; this.stats.waveTimes.push(this.frame - this.waveStartF);
        if (this.bus) { const p = this.bus.payload('wave/clear'); p.wave = this.ambushIdx; this.bus.dispatch('wave/clear'); }
      }
    }
    // the gate opens once every ambush on the pass has fallen
    if (this.roadCleared && h.alive && Math.hypot(h.x - roadX(ROAD.GATE_Z), h.z - ROAD.GATE_Z) < ROAD.GATE_R) {
      const leg = this.roadLeg; this.roadActive = false; this.roadLeg = -1;
      if (leg === 0) this._startStage2(); else this._startStage3();
    }
  }

  // Stage 2 entry (from DOOR or the review state): ford at dusk, one elite duelist, hero refilled, weapon kept.
  _startStage2() {
    const weapon = Math.max(this.hero.weapon, this.carry);
    this.duelists.length = 0; this.bossActive = false; this.pickup.active = false; this.stage3Active = false; this.drop.active = false;
    const c2 = this.stage2Colliders || this.colliders;
    this.hero.colliders = c2;
    this.hero.reset(HERO_SPAWN[0], HERO_SPAWN[1], HERO_SPAWN[2]);
    if (weapon > 0) this.hero.equip(weapon);
    if (this.stageWaves && !this._stageWavesDone) { this._startStageWaves('shrine', c2); return; }
    this._stageWavesDone = false;
    const w = new DuelistSim({ id: WARDEN_ID, timing: this.timing, rng: this.rngWarden, colliders: c2,
      x: WARDEN.SPAWN[0], z: WARDEN.SPAWN[1], aggression: 1.15, elite: true });
    w.yaw = Math.PI; w.isBoss = true;
    w.heroSink = (R) => this.hero.applyContact(R);
    w.telegraphSink = (dd, v) => { if (this.onDuelistTelegraph) this.onDuelistTelegraph(dd, v); };
    w.phaseSink = (dd) => {
      if (this.bus) { const p = this.bus.payload('boss/phase'); p.actorId = WARDEN_ID; p.phase = 2; p.intro = false; this.bus.dispatch('boss/phase'); }
    };
    this.warden = w; this.duelists.push(w);
    this.stage2Active = true; this.stage2StartF = this.frame;
    this._setState(GameState.STAGE2);
  }

  // Stage 3 entry (from GATE, DOOR or the review state): foundry, hero refilled at spawn, weapon kept.
  _startStage3() {
    const weapon = Math.max(this.hero.weapon, this.carry);
    this.duelists.length = 0; this.bossActive = false; this.pickup.active = false; this.stage2Active = false; this.drop.active = false;
    this.hero.colliders = this.stage3Colliders; this.gauntlet.colliders = this.stage3Colliders;
    this.hero.reset(GAUNTLET.HERO_SPAWN[0], GAUNTLET.HERO_SPAWN[1], 0);
    if (weapon > 0) this.hero.equip(weapon);
    if (this.stageWaves && !this._stageWavesDone) { this._startStageWaves('foundry', this.stage3Colliders); return; }
    this._stageWavesDone = false;
    this.stage3Active = true; this.stage3StartF = this.frame;
    this.gauntlet.startIntro();
    this._setState(GameState.STAGE3);
  }

  // v2.18 stage waves: STAGE_WAVE (state reused: WAVE with stageArena set) -> WAVE_CLEAR -> next or the stage boss.
  // Hero position/HP were already reset by the caller; the boss entry re-runs with _stageWavesDone set.
  _startStageWaves(arena, colliders) {
    this.stageArena = arena; this.stageWaveColliders = colliders; this.stageWaveIdx = -1;
    this.stage2Active = false; this.stage3Active = false;
    this._spawnStageWave(0);
  }
  _spawnStageWave(i) {
    const W = STAGE_WAVES[this.stageArena][i]; this.stageWaveIdx = i; this.duelists.length = 0;
    const base = this.stageArena === 'shrine' ? 400 : 500;
    for (let k = 0; k < W.spawns.length; k++) {
      const d = new DuelistSim({ id: base + i * 10 + k, timing: this.timing, rng: this.rngWave, colliders: this.stageWaveColliders,
        x: W.spawns[k][0], z: W.spawns[k][1], aggression: W.aggression });
      if (W.hp) { d.hpMax = W.hp; d.hp = W.hp; }
      d.yaw = Math.PI; d.stageTint = this.stageArena;
      d.heroSink = (R) => this.hero.applyContact(R);
      d.telegraphSink = (dd, v) => { if (this.onDuelistTelegraph) this.onDuelistTelegraph(dd, v); };
      this.duelists.push(d);
    }
    this.waveStartF = this.frame;
    if (this.bus) { const p = this.bus.payload('wave/start'); p.wave = i; p.count = W.spawns.length; this.bus.dispatch('wave/start'); }
    this._setState(GameState.WAVE);
  }
  _stageWaveCleared() {
    const list = STAGE_WAVES[this.stageArena];
    if (this.stageWaveIdx + 1 < list.length) { this._spawnStageWave(this.stageWaveIdx + 1); return; }
    const a = this.stageArena; this.stageArena = null; this._stageWavesDone = true;
    // the hero keeps current HP/position into the boss entry (the reset there refills him, matching the old flow)
    if (a === 'shrine') this._startStage2(); else this._startStage3();
  }
  get stageWaveDef() { return this.stageArena ? STAGE_WAVES[this.stageArena][this.stageWaveIdx] : null; }

  // v2.19 boss drop: the fallen boss leaves its weapon 1.6 m beyond its body toward the hero (clamped inside the arena). Walking
  // into it equips it; after LOOT_AUTO it flies to the hero on its own. leg = ROUTE index of the stage just won.
  _startLoot(leg, bx, bz, bodyR = 0.6) {
    const h = this.hero, D = this.drop, R = ROUTE[leg];
    let dx = h.x - bx, dz = h.z - bz; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const c = DROP.CLAMP;
    const off = bodyR + 1.6;   // clear of the corpse body capsule, which still blocks the hero in LOOT
    D.x = Math.max(-c, Math.min(c, bx + dx * off)); D.z = Math.max(-c, Math.min(c, bz + dz * off));
    D.weapon = R.drop; D.leg = leg; D.active = true; D.takenF = -1; D.auto = false;
    this.lootLeg = leg;
    this._setState(GameState.LOOT);
  }
  _claimDrop(auto) {
    const D = this.drop, h = this.hero;
    D.active = false; D.takenF = this.frame; D.auto = auto;
    this.carry = Math.max(this.carry, D.weapon); this.claimed.push(D.weapon);
    if (h.alive && h.equip(D.weapon)) {
      if (this.bus) { const p = this.bus.payload('weapon/equip'); p.actorId = HERO_ID; p.weapon = D.weapon; this.bus.dispatch('weapon/equip'); }
      if (this.onEquip) this.onEquip(D.weapon, 'drop');
    }
  }
  _lootDone() {
    const leg = this.lootLeg;
    if (leg === 0) this._setState(GameState.DOOR);
    else if (leg === 1) this._setState(GameState.GATE);
    else this._finish(true);
  }

  _hitGauntlet(h, v) {
    const G = this.gauntlet;
    if (G.y > 1.5) return 0;
    return G.takeHit(v.dmg, v.posture, G.hitPart(h.x, h.z));
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
    if (!this.hero.alive || this.hero.state === HERO_STATE.FINISHER) return false;
    if (this.state === GameState.STAGE3) return this.gauntlet.canFinish(this.hero);
    if (this.state !== GameState.BOSS) return false;
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
    if (this.stage3Active) {
      const G = this.gauntlet, gt = this.gauntletTarget;
      gt.x = G.x; gt.z = G.z; gt.targetable = G.state !== G_STATE.DEAD && G.y <= 1.5 && G.finisherF < 0;
      T.push(gt);
    }
    // boss finisher replaces the heavy when available
    if (c.heavy && this.finisherReady()) {
      if (this.state === S.STAGE3) { if (this.gauntlet.startFinisher(h)) { h.startFinisher(this.gauntletTarget); this.stats.finishers++; c.heavy = false; } }
      else if (this.brain.startFinisher(h)) { h.startFinisher(this.bossTarget); this.stats.finishers++; c.heavy = false; }
    }
    // INTRO and the boss intro/roar: hero may move but cannot attack yet (no targets to hurt anyway)
    if (this.state === S.INTRO || this.state === S.WAVE_CLEAR || this.state === S.DOOR || this.state === S.GATE || this.state === S.LOOT) { c.attack = c.attack && false; }
    h.step(c, T);
    // style: counted verbs (snatch / trigger / finisher) by counter delta, then decay
    if (h.snatches !== this._seenSnatch) { this._seenSnatch = h.snatches; this._styleAdd('SNATCH'); }
    if (h.triggers !== this._seenTrigger) { this._seenTrigger = h.triggers; this._styleAdd('TRIGGER'); }
    if (h.finishers !== this._seenFinisher) { this._seenFinisher = h.finishers; this._styleAdd('FINISHER'); }
    if (h.rifts !== this._seenRift) { this._seenRift = h.rifts; this._styleAdd('RIFT'); }
    this.style.step();
    // great sword pickup: walk into it (any live, non-dead state) to equip
    const P = this.pickup;
    if (P.active && h.alive && Math.hypot(h.x - P.x, h.z - P.z) < GREAT_PICKUP.R + h.radius && h.equipGreatsword()) {
      P.active = false; P.takenF = this.frame;
      if (this.bus) { const p = this.bus.payload('weapon/equip'); p.actorId = HERO_ID; p.weapon = 1; this.bus.dispatch('weapon/equip'); }
      if (this.onEquip) this.onEquip(1);
    }

    if (this.state === S.INTRO) {
      if (this.stateF >= FLOW_F.INTRO) { this._spawnWave(0); this._setState(S.WAVE); }
    } else if (this.state === S.WAVE) {
      assignTokens(this.duelists, this.stageArena ? this.stageWaveDef.tokens : WAVES[this.wave].tokens);
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
        if (this.stageArena) this._stageWaveCleared();
        else if (this.wave + 1 < WAVES.length) { this._spawnWave(this.wave + 1); this._setState(S.WAVE); }
        else this._startBoss();
      }
    } else if (this.state === S.BOSS) {
      this.brain.fixedUpdate(h, this.frame);
      this.stats.bossF++;
      if (this.brain.state === BRAIN_STATE.DEAD && this.brain.f >= FLOW_F.BOSS_HOLD) {
        if (this.stage3) { this.stats.wyvernF = this.stats.bossF; this._startLoot(0, this.brain.x, this.brain.z, BOSS.BODY_RADIUS); return; }
        this._finish(true); return;
      }
    } else if (this.state === S.LOOT) {
      const D = this.drop;
      if (this.bossActive) this.brain.fixedUpdate(h, this.frame);           // corpses finish their clips
      else if (this.stage3Active) this.gauntlet.fixedUpdate(h, this.frame);
      else if (this.warden) this.warden.step(h, this.frame);
      if (D.active) {
        if (h.alive && this.stateF >= DROP.ARM && Math.hypot(h.x - D.x, h.z - D.z) < DROP.R + h.radius) this._claimDrop(false);
        else if (this.stateF >= FLOW_F.LOOT_AUTO) this._claimDrop(true);
      } else if (this.frame - D.takenF >= FLOW_F.LOOT_HOLD) { this._lootDone(); return; }
    } else if (this.state === S.DOOR) {
      if (this.stateF >= FLOW_F.ROAD) { if (this.road) this._startRoad(0); else this._startStage2(); }
    } else if (this.state === S.STAGE2) {
      const w = this.warden;
      w.hasToken = true;                        // a duel: the warden never waits on the token director
      w.step(h, this.frame);
      separate(this.duelists, h);
      this.stats.stage2F = (this.stats.stage2F || 0) + 1;
      if (!w.alive && !w.counted) { w.counted = true; this._kill(w); }
      if (!w.alive && w.f >= FLOW_F.BOSS_HOLD && h.alive) { this._startLoot(1, w.x, w.z); return; }
    } else if (this.state === S.GATE) {
      if (this.warden) this.warden.step(h, this.frame);   // corpse finishes its clip
      if (this.stateF >= FLOW_F.ROAD) { if (this.road) this._startRoad(1); else this._startStage3(); }
    } else if (this.state === S.ROAD) {
      this._stepRoad();
    } else if (this.state === S.STAGE3) {
      this.gauntlet.fixedUpdate(h, this.frame);
      this.stats.stage3F = (this.stats.stage3F || 0) + 1;
      if (this.gauntlet.state === G_STATE.DEAD && this.gauntlet.f >= FLOW_F.BOSS_HOLD) { this._startLoot(2, this.gauntlet.x, this.gauntlet.z, GAUNTLET.BODY_RADIUS); return; }
    }
    if (!h.alive && h.actF >= FLOW_F.DEFEAT_HOLD && this.state !== S.DEFEAT && this.state !== S.VICTORY) this._finish(false);
    if (this.state !== S.VICTORY && this.state !== S.DEFEAT) this.stats.totalF++;
  }

  // weapon perk: drops scale the Ember Trigger gauge earned from style (great sword 1.0 = unchanged)
  _styleAdd(kind) { const g = this.style.add(kind); if (g > 0) this.hero.addGauge(this.hero.wp ? g * this.hero.wp.GAUGE : this.hero.sig ? g * this.hero.sig.GAUGE : g); }

  _styleContact(R) {
    const O = Outcome;
    if (R.outcome === O.PARRIED) this._styleAdd(R.effect === 'jg' ? 'JUSTGUARD' : R.perfect ? 'PERFECT' : 'DEFLECT');
    else if (R.outcome === O.WHIFF_IFRAME && R.effect && R.effect !== 'none') this._styleAdd('PHANTOM');
    else if ((R.outcome === O.HIT && R.damage >= 8) || R.outcome === O.GUARDBREAK) this.style.hitTaken();
  }

  _kill(d) {
    this.stats.kills++; this._styleAdd('KILL');
    if (this.bus) { const p = this.bus.payload('actor/death'); p.actorId = d.id; this.bus.dispatch('actor/death'); }
  }

  _finish(won) {
    const s = this.stats, h = this.hero;
    s.perfects = h.perfects; s.phantoms = h.phantoms; s.damageTaken = h.damageTaken; s.damageDealt = h.damageDealt;
    s.won = won; s.bossHp = this.brain.hp; s.gauntletHp = this.gauntlet.hp; s.guards = this.gauntlet.jgCount;
    s.wardenHp = this.warden ? this.warden.hp : WARDEN.HP;
    s.stylePeak = this.style.peak; s.styleTotal = Math.round(this.style.total); s.snatches = h.snatches; s.triggers = h.triggers;
    if (this.bus) { const p = this.bus.payload('run/end'); p.won = won; p.frames = s.totalF; this.bus.dispatch('run/end'); }
    this._setState(won ? GameState.VICTORY : GameState.DEFEAT);
  }

  // Retry from the start of the encounter that was lost (boss retry keeps the waves cleared).
  retry() {
    // stage retries keep the drops already claimed on the road (carry); a full restart from the title does not
    if (this.roadActive) { const leg = this.roadLeg; this._keepCarry = this.carry; this._keepClaimed = this.claimed.slice(); this.reset(leg ? 'road1' : 'road0'); return; }
    if (this.stage3Active) { this._keepCarry = this.carry; this._keepClaimed = this.claimed.slice(); this.reset('stage3'); return; }
    if (this.stage2Active) { this._keepCarry = this.carry; this._keepClaimed = this.claimed.slice(); this.reset('stage2'); return; }
    const atBoss = this.bossActive;
    this.reset(atBoss ? 'boss' : 'title');
    if (!atBoss) this._setState(GameState.INTRO);
  }

  hash() {
    let x = this.hero.hash() ^ this.brain.hash();
    const q = (v) => { x = Math.imul(x ^ (Math.round(v * 1000) | 0), 16777619) >>> 0; };
    for (const d of this.duelists) { q(d.x); q(d.z); q(d.hp); q(d.state); }
    q(this.state); q(this.frame); q(this.pickup.active ? 1 : 0);
    if (this.drop.leg >= 0) { q(this.drop.x); q(this.drop.z); q(this.drop.takenF); q(this.carry); }
    if (this.roadActive) { q(this.roadLeg); q(this.ambushIdx); q(this.ambushLive ? 1 : 0); }
    if (this.stage3Active) x = this.gauntlet.hash(x);
    x = this.style.hash(x); q(this.hero.gauge); q(this.hero.triggerF);
    return x >>> 0;
  }

  dispose() { this.brain.dispose(); this.gauntlet.dispose(); this.onGauntletTelegraph = null; this.onAmbush = null; this.onState = this.onHeroContact = this.onHeroHit = this.onTelegraph = this.onDuelistTelegraph = null; }
}

export { GameState, HERO_STATE, DUEL_STATE, BRAIN_STATE, ART, Outcome, G_STATE };
