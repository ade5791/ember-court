// Loop - fixed-step simulation, interpolated rendering, deterministic time dilation (ARCHITECTURE.md section 3,
// CINEMATIC_SPEC section 3). The sim always advances in SIM.FIXED_DT steps. Dilation scales only the real time fed
// into the accumulator (timeScale), so a slowed fight runs the exact same steps, just fewer per real second:
// for a given seed + per-frame inputs the sim state at frame N is identical with or without dilation (check C4).
//
// Dilation requests are counted in SIM frames, not real seconds, so their end is deterministic too.
// Presentation slow (presentScale) is separate: it only slows render-side clocks (camera, fx) and never the sim.
import { SIM } from '../shared/constants.js';

const MAX_DILATIONS = 4;

export class Loop {
  static id = 'loop';
  static deps = [];

  constructor({ fixedUpdate, update, lateUpdate = null, reducedMotion = false } = {}) {
    this.fixedUpdate = fixedUpdate;     // (dt, simFrame) -> void
    this.update = update;               // (realDt, alpha, presentDt) -> void
    this.lateUpdate = lateUpdate;       // (realDt) -> void
    this.reducedMotion = reducedMotion;
    this.simFrame = 0;
    this.accumulator = 0;
    this.timeScale = 1;
    this.presentScale = 1;
    this.alpha = 0;
    this.running = false;
    this.paused = false;
    this.lastSteps = 0;
    this.droppedSteps = 0;              // steps discarded by the substep cap (diagnostic)
    this._raf = 0;
    this._last = 0;
    this._tick = this._tick.bind(this);
    // fixed pool of dilation requests: scale, framesLeft, presentation-only flag
    this._dScale = new Float32Array(MAX_DILATIONS);
    this._dLeft = new Int32Array(MAX_DILATIONS);
    this._dPresent = new Uint8Array(MAX_DILATIONS);
    this._onVis = () => { this._last = performance.now(); };
  }

  // Slow the sim to `scale` for `simFrames` frames. Overlapping requests: the slowest wins.
  // Reduced motion keeps dilation (it is gameplay readable) but never below 0.5x.
  dilate(scale, simFrames, presentationOnly = false) {
    let slot = -1;
    for (let i = 0; i < MAX_DILATIONS; i++) if (this._dLeft[i] <= 0) { slot = i; break; }
    if (slot < 0) {                     // pool full: replace the request that ends soonest
      slot = 0;
      for (let i = 1; i < MAX_DILATIONS; i++) if (this._dLeft[i] < this._dLeft[slot]) slot = i;
    }
    this._dScale[slot] = this.reducedMotion ? Math.max(0.5, scale) : scale;
    this._dLeft[slot] = simFrames | 0;
    this._dPresent[slot] = presentationOnly ? 1 : 0;
    this._resolveScales();
  }

  clearDilation() { this._dLeft.fill(0); this._resolveScales(); }

  _resolveScales() {
    let sim = 1, pres = 1;
    for (let i = 0; i < MAX_DILATIONS; i++) {
      if (this._dLeft[i] <= 0) continue;
      const s = this._dScale[i];
      if (this._dPresent[i]) { if (s < pres) pres = s; } else if (s < sim) sim = s;
    }
    this.timeScale = sim;
    this.presentScale = Math.min(pres, sim);
  }

  _consumeDilationFrame() {
    let changed = false;
    for (let i = 0; i < MAX_DILATIONS; i++) {
      if (this._dLeft[i] > 0) { this._dLeft[i]--; if (this._dLeft[i] === 0) changed = true; }
    }
    if (changed) this._resolveScales();
  }

  // One fixed step. Public so harnesses can pump the sim in lockstep without RAF.
  step() {
    this.fixedUpdate(SIM.FIXED_DT, this.simFrame);
    this.simFrame++;
    this._consumeDilationFrame();
  }

  // Advance by real seconds (already delta-capped by the caller or _tick).
  advance(realDt) {
    const dt = realDt > SIM.DELTA_CAP ? SIM.DELTA_CAP : realDt;
    if (!this.paused) {
      this.accumulator += dt * this.timeScale;
      let steps = 0;
      while (this.accumulator >= SIM.FIXED_DT) {
        if (steps >= SIM.SUBSTEP_CAP) {
          const extra = Math.floor(this.accumulator / SIM.FIXED_DT);
          this.droppedSteps += extra;
          this.accumulator -= extra * SIM.FIXED_DT;
          break;
        }
        this.step();
        this.accumulator -= SIM.FIXED_DT;
        steps++;
        // a dilation that started inside this batch takes effect on the remaining real time next frame;
        // the steps themselves are unaffected, so determinism holds.
      }
      this.lastSteps = steps;
      this.alpha = this.accumulator / SIM.FIXED_DT;
    }
    this.update(dt, this.alpha, this.paused ? 0 : dt * this.presentScale);
    if (this.lateUpdate) this.lateUpdate(dt);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    document.addEventListener('visibilitychange', this._onVis);
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    document.removeEventListener('visibilitychange', this._onVis);
  }

  _tick(now) {
    if (!this.running) return;
    const dt = (now - this._last) / 1000;
    this._last = now;
    this.advance(dt < 0 ? 0 : dt);
    this._raf = requestAnimationFrame(this._tick);
  }

  // Snapshot/restore for prewarm transparency and the C4 harness.
  save() {
    return { simFrame: this.simFrame, accumulator: this.accumulator, dScale: Array.from(this._dScale),
      dLeft: Array.from(this._dLeft), dPresent: Array.from(this._dPresent) };
  }

  load(s) {
    this.simFrame = s.simFrame; this.accumulator = s.accumulator;
    this._dScale.set(s.dScale); this._dLeft.set(s.dLeft); this._dPresent.set(s.dPresent);
    this._resolveScales();
  }

  dispose() { this.stop(); }
}
