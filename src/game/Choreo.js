// Choreo.js - scripted-fight player (film v14). A beat sheet drives the hero command, cues the boss and picks the
// camera shot. The sim still resolves every press, so a take is a played fight, not keyframes. Recording only
// (?rec=1 + __ember.choreo(sheet)); never constructed in normal play.
const KEY = { A: 'attack', B: 'heavy', S: 'sweep' };
const DIRS = { F: [1, 0], B: [-1, 0], L: [0, -1], R: [0, 1], FR: [0.7, 0.7], FL: [0.7, -0.7], BR: [-0.7, 0.7], BL: [-0.7, -0.7] };
const D2R = Math.PI / 180;
const AVOID = [0, 14, -14, 28, -28, 42, -42, 58, -58, 75, -75, 95, -95, 120, -120], LIFT = [0, 1.6, 3.0];
function wrap(a) { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; }

export class Choreo {
  // api: { H, sim, HS, BS, BossVerb, RUN, WALK, lim, ty(z), clip() }
  constructor(api) {
    this.api = api; this.steps = null; this.i = 0; this.f = 0; this.n = 0; this.aid = -1; this.teleAt = -1;
    this.acts = []; this.act = null; this.marks = []; this.fails = []; this.trace = [];
    this.shot = null; this.shotNew = false; this.done = true; this.cs = null;
    this.cue = -1; this.pin = null; this._hitF = -99; this._p0 = 0; this.shotT = 0; this.cu = [0, -1];
    this.yo = 0; this.yt = 0; this.c0 = 0; this.occ = {}; this._pp = [0, 0, 0]; this._lift = 0; this.lo = 0; this.lt = 0; this.why = ''; this.whys = {}; this.flip = 1;
  }
  load(sheet) {
    this.steps = sheet.steps; this.i = 0; this.done = false; this.cs = null; this.shot = null; this.pin = null; this.cue = -1; this.teleAt = -1;
    this.acts.length = 0; this.marks.length = 0; this.fails.length = 0; this.trace.length = 0; this.occ = {}; this.whys = {}; this.yo = 0; this.yt = 0; this._enter();
    return this.steps.length;
  }
  get active() { return !!this.steps && !this.done; }
  onTelegraph(lead) { this.teleAt = this.api.sim.frame + lead; }
  report() { return { done: this.done, step: this.i, acts: this.acts, marks: this.marks, fails: this.fails, trace: this.trace, occ: this.occ, whys: this.whys, coll: this.api.coll ? this.api.coll().filter((r) => r[0] >= 20) : null, hb: this._hb }; }
  _enter() { this.f = 0; this.n = 0; this.aid = this.api.H.actionId; }
  _next() {
    const s = this.steps[this.i]; this.trace.push([this.i, s.t, this.api.sim.frame]);
    this.i++; if (this.i >= this.steps.length) this.done = true; else this._enter();
  }
  _fail(msg) { this.fails.push([this.i, this.steps[this.i].t, this.api.sim.frame, msg]); return 1; }

  // Called from fillCommand on every fixed step (command already cleared). Step results:
  // 0 = still running, 1 = finished without using this frame (run the next step now), 2 = finished, frame used.
  fill(c) {
    const { H, sim, HS } = this.api;
    if (this.api.STAM) H.stamina = this.api.STAM;          // film fixture: the script never drops a press on stamina
    // film fixture: the boss cannot phase or break before the written finale (pin floors hp, caps posture)
    if (this.pin) { const B = sim.brain; if (B.hp < this.pin.hp) B.hp = this.pin.hp; if (B.posture > this.pin.posture) B.posture = this.pin.posture; }
    this._holdBoss(); this._track();
    if (H.state === HS.HITSTUN && this._hitF !== sim.frame - 1) this.fails.push([this.i, 'hit', sim.frame, 'hero was hit']);
    if (H.state === HS.HITSTUN) this._hitF = sim.frame;
    let guard = 0;
    while (!this.done && guard++ < 16) {
      const r = this._run(this.steps[this.i], c, this.f++);
      if (r === 0) break;
      this._next();
      if (r === 2) break;
    }
  }
  // The boss only acts on cue: it idles (turning and walking to keep range) until a 'boss' step names its next verb.
  _holdBoss() {
    const { sim, BS } = this.api, B = sim.brain;
    if (!sim.bossActive || B.state !== BS.WAIT) return;
    if (this.cue >= 0) { B.forceNext = this.cue; B.waitF = B.f; this.cue = -1; } else B.waitF = B.f + 3;
  }
  // Per-action log: verb, clip actually playing, combo depth, root path length (rule: no planted swings).
  _track() {
    const { H, sim, HS } = this.api, a = this.act;
    if (a) { a.travel += Math.hypot(H.x - a.px, H.z - a.pz); a.px = H.x; a.pz = H.z; if (H.flashF >= 0) a.flash = 1; }
    const live = H.state === HS.ACTION;
    if (a && (!live || H.actionId !== a.id)) { a.end = sim.frame; a.travel = +a.travel.toFixed(3); delete a.px; delete a.pz; this.act = null; }
    if (live && !this.act) { this.act = { id: H.actionId, f: sim.frame, verb: H.verb, clip: '', n: H.comboN, travel: 0, px: H.x, pz: H.z, flash: 0 }; this.acts.push(this.act); }
    if (this.act && !this.act.clip && H.flashF < 0) this.act.clip = this.api.clip() || '';
  }
  _dir(k) {   // unit stick vector for a direction relative to the hero -> boss line (R matches the bot's dance R)
    const { H, sim } = this.api, B = sim.brain; let ux = B.x - H.x, uz = B.z - H.z; const l = Math.hypot(ux, uz) || 1; ux /= l; uz /= l;
    const d = DIRS[k] || DIRS.F, px = -uz, pz = ux, x = ux * d[0] + px * d[1], z = uz * d[0] + pz * d[1], m = Math.hypot(x, z) || 1;
    return [x / m, z / m];
  }
  _edge() { const { H, sim } = this.api, B = sim.brain; return Math.hypot(B.x - H.x, B.z - H.z) - this.api.bossR; }
  _run(s, c, f) {
    const { H, sim, HS, BS } = this.api, B = sim.brain;
    switch (s.t) {
      case 'cam': this.shot = s; this.shotNew = s.cut !== false; if (this.shotNew) this.marks.push(['cut', sim.frame, s.name || '']); return 1;
      case 'mark': this.marks.push([s.name, sim.frame, '']); return 1;
      case 'boss': this.cue = this.api.BossVerb[s.verb]; this.teleAt = -1; if (this.cue === undefined) { this.cue = -1; return this._fail('unknown boss verb ' + s.verb); } return 1;
      case 'set':
        if (s.bossHp !== undefined) B.hp = s.bossHp; if (s.posture !== undefined) B.posture = s.posture;
        if (s.gauge !== undefined) H.gauge = s.gauge; if (s.pin !== undefined) this.pin = s.pin; return 1;
      case 'wait': if (s.drift) this._drift(c, s.drift); return f + 1 >= s.f ? 2 : 0;
      case 'until': {
        if (s.drift) this._drift(c, s.drift);
        const ok = (s.boss ? B.state === BS[s.boss] : true) && (s.hero ? H.state === HS[s.hero] : true)
          && (s.edge ? this._edge() <= s.edge : true) && (s.cine === 0 ? !this.api.cine() : true);
        return ok ? 1 : f > (s.max || 900) ? this._fail('until timed out') : 0;
      }
      case 'move': return this._move(s, c, f);
      case 'str': return this._str(s, c, f);
      case 'step': return this._step(s, c, f);
      case 'guard': case 'evade': return this._react(s, c, f);
      case 'trigger': c.trigger = true; return 2;
      case 'rift': return this._rift(s, c, f);
      case 'fin': return this._fin(s, c, f);
      default: return this._fail('unknown step ' + s.t);
    }
  }
  _drift(c, k) { const d = this._dir(k); c.mx = d[0]; c.mz = d[1]; c.speed = this.api.WALK; }
  // move: run (or walk) along a direction relative to the boss line until the body-edge distance is reached or f frames pass.
  _move(s, c, f) {
    const e = this._edge(), k = s.dir || 'F', away = k[0] === 'B';
    if (s.edge !== undefined && (away ? e >= s.edge : e <= s.edge)) return 1;
    if (f >= (s.f || 240)) return s.f === undefined ? this._fail('move timed out') : 1;
    const d = this._dir(k); c.mx = d[0]; c.mz = d[1]; c.speed = s.walk ? this.api.WALK : this.api.RUN; return 0;
  }
  // str: a button string ('AAB' = light light heavy). One press per action; the next key is buffered a few frames into
  // the action the previous key started, so the sim chains it through the real combo route. The step ends when the
  // last action ends (shown in full); out: 'R' holds the stick through its recovery so the hero flows out moving.
  _str(s, c, f) {
    const { H, HS } = this.api, keys = s.keys, n = this.n;
    if (f > (s.max || 900)) return this._fail('string timed out at key ' + n);
    if (n > 0 && H.actionId !== this.aid && H.state === HS.ACTION) { this.aid = H.actionId; this.n++; return 0; }
    if (n === 0) {
      if (H.actionId !== this.aid && H.state === HS.ACTION) { this.aid = H.actionId; this.n = 1; return 0; }
      if (H.state === HS.LOCO || H.state === HS.DODGE || H.state === HS.ACTION) c[KEY[keys[0]]] = true;
      return 0;
    }
    const live = H.state === HS.ACTION && H.actionId === this.aid;
    if (n < keys.length) {
      if (!live) { if (H.state === HS.LOCO) { this._fail('chain dropped before key ' + n); c[KEY[keys[n]]] = true; } return 0; }
      if (H.flashF < 0 && H.actF >= (s.at || 4) && !H.queued) c[KEY[keys[n]]] = true;
      return 0;
    }
    if (!live) return 1;
    if (s.out) { const ph = H.phase(); if (ph !== 'STARTUP' && ph !== 'ACTIVE') { const d = this._dir(s.out); c.mx = d[0]; c.mz = d[1]; c.speed = this.api.RUN; } }
    return 0;
  }
  // step: a quickstep (or roll: true) in a direction relative to the boss line. Ends at the dodge's cancel frame so the
  // next string can come straight out of it.
  _step(s, c, f) {
    const { H, HS } = this.api;
    if (this.n === 1) return H.state === HS.DODGE && H.dodgeF < this.api.DODGE_CANCEL ? 0 : 1;
    if (H.state === HS.DODGE && H.dodgeF <= 1) { this.n = 1; return 0; }
    if (f > 120) return this._fail('step never started');
    const d = this._dir(s.dir || 'R'); c.mx = d[0]; c.mz = d[1]; c.speed = this.api.RUN;
    if (s.roll) c.roll = true; else c.dodge = true;
    return 0;
  }
  // guard / evade: answer the cued boss verb on its telegraphed contact frame (the same leads the play bot uses).
  _react(s, c, f) {
    const { H, sim, HS } = this.api, guard = s.t === 'guard';
    if (this.n === 0) {
      if (this.teleAt < 0) { if (s.drift && H.state === HS.LOCO) this._drift(c, s.drift); return f > (s.max || 420) ? this._fail('no telegraph for ' + s.t) : 0; }
      const at = this.teleAt - (s.lead !== undefined ? s.lead : guard ? 3 : 5);
      if (sim.frame + 1 < at) { if (s.drift && H.state === HS.LOCO) this._drift(c, s.drift); return 0; }
      if (sim.frame + 1 > at) this._fail(s.t + ' pressed late by ' + (sim.frame + 1 - at));
      if (guard) c.blockPress = true;
      else { const d = this._dir(s.dir || 'R'); c.mx = d[0]; c.mz = d[1]; c.speed = this.api.RUN; if (s.roll) c.roll = true; else c.dodge = true; }
      this.n = 1; this._p0 = H.perfects; return 0;
    }
    if (guard) {
      if (sim.frame < this.teleAt + (s.after !== undefined ? s.after : 8)) return 0;
      if (s.perfect !== false && H.perfects === this._p0) this._fail('guard was not a perfect deflect');
      this.teleAt = -1; return 1;
    }
    if (H.state === HS.DODGE && H.dodgeF < this.api.DODGE_CANCEL) return 0;
    this.teleAt = -1; return 1;
  }
  // rift: light the Ember Trigger (the film fixture fills the gauge), hold gap frames, then cash it into an Ember Rift.
  _rift(s, c, f) {
    const { H, HS } = this.api;
    if (this.n === 0) {
      if (H.triggerF > 0) { this.n = 1; this.f = 0; return 0; }
      if (f > 60) return this._fail('trigger never lit');
      if (H.gauge < 100) H.gauge = 100; c.trigger = true; return 0;
    }
    if (this.n === 1) {
      if (s.drift && H.state === HS.LOCO) this._drift(c, s.drift);
      if (f < (s.gap || 40) || H.state !== HS.LOCO) return f > 400 ? this._fail('rift never armed') : 0;
      c.mx = 0; c.mz = 0; c.speed = 0; c.trigger = true; this.n = 2; this.f = 0; return 0;
    }
    if (H.state === HS.RIFT) { this.n = 3; return 0; }
    if (this.n === 3) return 1;
    return f > 30 ? this._fail('rift did not start') : 0;
  }
  // fin: once the boss is staggered, run to its head and take the finisher (a heavy press inside finisher range).
  _fin(s, c, f) {
    const { H, sim, HS, BS } = this.api, B = sim.brain;
    if (this.n === 1) return H.state === HS.FINISHER ? 0 : 1;
    if (H.state === HS.FINISHER) { this.n = 1; return 0; }
    if (f > (s.max || 360)) return this._fail(B.state === BS.STAGGER ? 'finisher never started' : 'boss never staggered');
    if (B.state !== BS.STAGGER) return 0;
    const hx = B.x + B.forwardX() * 2.9, hz = B.z + B.forwardZ() * 2.9, dx = hx - H.x, dz = hz - H.z, d = Math.hypot(dx, dz) || 1;
    if (sim.finisherReady()) { c.heavy = true; return 0; }
    c.mx = dx / d; c.mz = dz / d; c.speed = this.api.RUN; return 0;
  }

  // Film camera, placed from the hero -> boss line. yaw 0 = behind the hero looking at the boss, 90 = profile from the
  // hero's right, 180 = over the boss. fixed: true freezes the line at the cut so the shot does not swing as the hero
  // circles. orbit = degrees per second. Returns true when it owned the camera this frame. The game cinematics win.
  applyCam(cam, dt, hp, bp, busy) {
    const s = this.shot; if (!s || s.off) return false;
    if (busy && !s.cine) { this.cs = null; return false; }
    const cut = this.shotNew || !this.cs, l = Math.hypot(bp.x - hp.x, bp.z - hp.z);
    if (cut) (this._hb || (this._hb = [])).push([s.name, +hp.x.toFixed(1), +hp.z.toFixed(1), +bp.x.toFixed(1), +bp.z.toFixed(1)]);
    if (cut) this.shotT = 0;
    if (l > 0.8 && (!s.fixed || cut)) { this.cu[0] = (bp.x - hp.x) / l; this.cu[1] = (bp.z - hp.z) / l; }   // hero on the boss (finisher): keep the last axis
    const ux = this.cu[0], uz = this.cu[1];
    const fk = s.focus !== undefined ? s.focus : 0.25, lk = s.look !== undefined ? s.look : 0.35, lim = s.lim !== undefined ? s.lim : 100;
    const dist = (s.dist || 6) + l * (s.sep !== undefined ? s.sep : 0.3);
    if (cut) this.flip = 1;
    const base0 = Math.max(-lim, Math.min(lim, (s.yaw || 0) + (s.orbit || 0) * this.shotT)); let base = base0 * this.flip;   // never orbit to the far side of the boss
    const cxp = hp.x + (bp.x - hp.x) * fk, czp = hp.z + (bp.z - hp.z) * fk, P = this._pp;
    const place = (off) => {
      const a = Math.max(-lim - 15, Math.min(lim + 15, base + off)) * D2R, ca = Math.cos(a), sa = Math.sin(a);
      P[0] = cxp + (-ux * ca - uz * sa) * dist; P[2] = czp + (ux * sa - uz * ca) * dist;
      P[1] = Math.max(hp.y + (s.h !== undefined ? s.h : 1.6) + this._lift, this.api.ty(P[2]) + 0.45);
    };
    const blk = (off, lift) => { this._lift = lift || 0; place(off); return this._blocked(P[0], P[1], P[2], hp, bp); };
    if (s.avoid !== false && this.api.clear) {
      const find = (from) => {   // nearest clear (yaw, lift) to the current offset; yaw first, then the same sweep 1.6 m and 3 m higher
        for (let li = 0; li < LIFT.length; li++) { let best = null, bd = 1e9;
          for (let i = 0; i < AVOID.length; i++) { const d = Math.abs(AVOID[i] - from); if (d < bd && !blk(AVOID[i], LIFT[li])) { bd = d; best = AVOID[i]; } }
          if (best !== null) { this.yt = best; this.lt = LIFT[li]; return true; } }
        return false;
      };
      if (cut) { this.yt = 0; this.lt = 0; if (!find(0)) { base = -base0; if (find(0)) this.flip = -1; else { base = base0; this.yt = 0; this.lt = 0; } } this.yo = this.yt; this.lo = this.lt; this.c0 = 0; }
      else {
        const b0 = blk(0, 0); this.c0 = b0 ? 0 : this.c0 + 1;
        if ((this.yt !== 0 || this.lt !== 0) && this.c0 > 24) { this.yt = 0; this.lt = 0; }
        else if (this.yt === 0 && this.lt === 0 ? b0 : blk(this.yt, this.lt)) find(this.yo);
        const k = 1 - Math.exp(-dt * 6); this.yo += (this.yt - this.yo) * k; this.lo += (this.lt - this.lo) * k;
      }
    } else { this.yo = 0; this.yt = 0; this.lo = 0; this.lt = 0; }
    this._lift = this.lo;
    place(this.yo); const px = P[0], py = P[1], pz = P[2];
    const tx = hp.x + (bp.x - hp.x) * lk, tz = hp.z + (bp.z - hp.z) * lk, ty = hp.y + (s.lookH !== undefined ? s.lookH : 1.3), fov = s.fov || 42;
    if (cut) this.cs = { px, py, pz, tx, ty, tz, fov };
    else {
      const o = this.cs, hid = this.api.clear && this._blocked(o.px, o.py, o.pz, hp, bp) ? 3 : 1;
      const k = 1 - Math.exp(-dt * (s.ease || 4) * hid), kt = 1 - Math.exp(-dt * (s.easeLook || 9));
      o.px += (px - o.px) * k; o.py += (py - o.py) * k; o.pz += (pz - o.pz) * k;
      o.tx += (tx - o.tx) * kt; o.ty += (ty - o.ty) * kt; o.tz += (tz - o.tz) * kt; o.fov += (fov - o.fov) * k;
      if (this.api.clear && this.api.clear(o.px, o.py, o.pz) < 0.32) {      // the eased path ran into a prop: carry on to the first clear point
        for (let q = 1; q <= 12; q++) { const u = q / 12, x = o.px + (px - o.px) * u, y = o.py + (py - o.py) * u, z = o.pz + (pz - o.pz) * u;
          if (this.api.clear(x, y, z) >= 0.32 || q === 12) { o.px = x; o.py = y; o.pz = z; break; } }
      }
    }
    const o = this.cs; this.shotNew = false; this.shotT += dt;
    const st = this.occ[s.name || '?'] || (this.occ[s.name || '?'] = [0, 0, 0, 0, 0, 0]); st[1]++;
    if (this.api.clear) { const w = this._blocked(o.px, o.py, o.pz, hp, bp); if (w) { st[0]++; st[1 + w]++; const y = (s.name || '?') + ' ' + this.why; this.whys[y] = (this.whys[y] || 0) + 1; } }
    cam.position.set(o.px, o.py, o.pz); cam.lookAt(o.tx, o.ty, o.tz);
    if (Math.abs(cam.fov - o.fov) > 0.01) { cam.fov = o.fov; cam.updateProjectionMatrix(); }
    return true;
  }
  // 0 = the shot reads. 1 = a prop is in the way (camera in / against geometry, prop on the camera -> hero line or on the
  // camera -> boss line). 2 = the boss body is between the camera and the hero (chest or knee line), or the camera is in it.
  _blocked(px, py, pz, hp, bp) {
    const A = this.api;
    const c0 = A.clear(px, py, pz); if (c0 < 0.32 || (c0 < 1.3 && A.hitI() !== -2)) { this.why = 'cam:' + A.hitI(); return 1; }        // (clearance counts the ground too; low shots sit 0.45 m up)
    const bx = bp.x - px, by = bp.y + 1.8 - py, bz = bp.z - pz;
    for (let k = 1; k <= 6; k++) { const t = k / 10; if (A.clear(px + bx * t, py + by * t, pz + bz * t) < 0.14) { this.why = 'bossline:' + A.hitI(); return 1; } }
    return this._ray(px, py, pz, hp.x, hp.y + 1.15, hp.z) || this._ray(px, py, pz, hp.x, hp.y + 0.5, hp.z);
  }
  _ray(px, py, pz, hx, hy, hz) {
    const A = this.api, dx = hx - px, dy = hy - py, dz = hz - pz, L2 = dx * dx + dy * dy + dz * dz || 1, L = Math.sqrt(L2);
    for (let k = 0; k <= 9; k++) { const t = k / 10.6, cl = A.clear(px + dx * t, py + dy * t, pz + dz * t);
      if (cl < 0.14 || (t < 0.45 && cl < 0.7 && A.hitI() !== -2)) { this.why = 'heroline:' + A.hitI(); return 1; } }
    const O = A.occ ? A.occ() : null; if (!O) return 0;
    const R = A.occR, tm = Math.max(0, 1 - 1.1 / L);       // the last 1.1 m is the hero's own space (he fights at the boss's feet)
    for (let i = 0; i < O.length; i++) {
      const q = O[i]; let t = ((q.x - px) * dx + (q.y - py) * dy + (q.z - pz) * dz) / L2;
      if (t > tm) continue; if (t < 0) t = 0;
      const ex = px + dx * t - q.x, ey = py + dy * t - q.y, ez = pz + dz * t - q.z;
      if (ex * ex + ey * ey + ez * ez < R[i] * R[i]) { this.why = 'boss:' + (A.occN ? A.occN[i] : i); return 2; }
    }
    return 0;
  }
}
