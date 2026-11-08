// StyleMeter - action-game style rank (owner: game). No THREE, no DOM, no Math.random. Fixed 60 Hz.
// Studied from Devil May Cry 5 footage (Nero vs Vergil, DMD): a D..SSS letter rank that climbs with VARIED
// offence and clean defence, decays when you stop pressing, and drops hard when you get hit. Style also fills
// the Trigger gauge (HeroSim.trigger*), so playing stylishly is what powers the burst mode.
// Gameplay contract: the meter never changes damage by itself; it only feeds the Trigger gauge.
export const STYLE_RANKS = Object.freeze(['D', 'C', 'B', 'A', 'S', 'SS', 'SSS']);
export const STYLE_TITLES = Object.freeze(['DULL', 'CRUEL', 'BRUTAL', 'ASCENDANT', 'SAVAGE', 'SUBLIME', 'SOVEREIGN']);
// points per rank band; gains per source; repeat penalty over the last VARIETY_N moves
export const STYLE = Object.freeze({
  BAND: 100, MAX: 700,
  GAIN: Object.freeze({ LIGHT_1: 14, LIGHT_2: 16, LIGHT_3: 24, HEAVY: 30, CHARGED: 46, SNATCH: 20, SWEEP: 26, SWEEP_REV: 30, FINISHER: 140,
    D_L1: 14, D_L2: 16, D_L3: 18, D_L4: 18, D_L5: 24, D_H1: 32, D_H2: 34,
    PERFECT: 60, DEFLECT: 30, PHANTOM: 50, JUSTGUARD: 45, KILL: 40, TRIGGER: 25, RIFT: 90 }),
  VARIETY_N: 5, REPEAT_CUT: 0.28, MIN_K: 0.15,
  HOLD_F: 100,            // frames after the last gain before decay starts
  DECAY: 0.22,            // points per frame at rank D, scaled up per rank
  DECAY_RANK: 0.35,
  HIT_DROP: 160,          // points lost when the hero takes a real hit (about 1.5 ranks)
  GAUGE_K: 0.22,          // trigger gauge gained per style point, x (1 + rank * GAUGE_RANK)
  GAUGE_RANK: 0.18,
});
const KINDS = Object.keys(STYLE.GAIN);

export class StyleMeter {
  constructor() { this._recent = new Int8Array(STYLE.VARIETY_N); this.reset(); }

  reset() {
    this.points = 0; this.rank = 0; this.peak = 0; this.idleF = 0; this.flashF = -999; this.frame = 0;
    this._recent.fill(-1); this._ri = 0; this.lastGain = 0; this.total = 0; this.drops = 0;
  }

  get frac() { return this.rank >= STYLE_RANKS.length - 1 ? Math.min(1, (this.points - this.rank * STYLE.BAND) / STYLE.BAND) : (this.points - this.rank * STYLE.BAND) / STYLE.BAND; }
  get letter() { return STYLE_RANKS[this.rank]; }
  get title() { return STYLE_TITLES[this.rank]; }

  // kind: key of STYLE.GAIN. Returns trigger-gauge gain for this event (caller feeds the hero).
  add(kind) {
    const base = STYLE.GAIN[kind]; if (!base) return 0;
    const id = KINDS.indexOf(kind);
    let reps = 0; for (let i = 0; i < this._recent.length; i++) if (this._recent[i] === id) reps++;
    // defence and finishers are never "spam": only offensive repeats are cut
    const off = kind.startsWith('D_') || kind === 'LIGHT_1' || kind === 'LIGHT_2' || kind === 'LIGHT_3' || kind === 'HEAVY' || kind === 'CHARGED' || kind === 'SNATCH' || kind === 'SWEEP' || kind === 'SWEEP_REV';
    const k = off ? Math.max(STYLE.MIN_K, 1 - STYLE.REPEAT_CUT * reps) : 1;
    if (off) { this._recent[this._ri] = id; this._ri = (this._ri + 1) % this._recent.length; }
    const g = base * k;
    const before = this.rank;
    this.points = Math.min(STYLE.MAX, this.points + g); this.idleF = 0; this.lastGain = g; this.total += g;
    this._rerank(); if (this.rank > before) this.flashF = this.frame;
    if (this.rank > this.peak) this.peak = this.rank;
    return g * STYLE.GAUGE_K * (1 + this.rank * STYLE.GAUGE_RANK);
  }

  hitTaken() {
    if (this.points <= 0) return;
    this.points = Math.max(0, this.points - STYLE.HIT_DROP); this.drops++; this._rerank(); this.idleF = 0;
    this._recent.fill(-1);
  }

  step() {
    this.frame++;
    if (++this.idleF > STYLE.HOLD_F && this.points > 0) {
      this.points = Math.max(0, this.points - STYLE.DECAY * (1 + this.rank * STYLE.DECAY_RANK)); this._rerank();
    }
  }

  _rerank() { this.rank = Math.min(STYLE_RANKS.length - 1, Math.floor(this.points / STYLE.BAND)); }

  hash(x) {
    const q = (v) => { x = Math.imul(x ^ (Math.round(v * 1000) | 0), 16777619) >>> 0; };
    q(this.points); q(this.rank); q(this.idleF);
    return x >>> 0;
  }
}
