// Hud - title, in-game HUD, pause, victory/defeat screens (owner: ui). DOM only, no THREE.
// Reads game state each frame through update(view); writes nothing into the sim. Buttons call the
// handlers passed in init (onStart, onRetry, onRestart, onResume). Bars update every frame (A1.5: <= 2 frames).
const CSS = `
.ec-hud{position:fixed;inset:0;pointer-events:none;z-index:20;font-family:Georgia,'Times New Roman',serif;color:#f4dcc0}
.ec-hud *{box-sizing:border-box}
.ec-bars{position:absolute;left:calc(env(safe-area-inset-left,0px) + 18px);top:calc(env(safe-area-inset-top,0px) + 16px);width:min(300px,42vw)}
.ec-bar{height:9px;background:rgba(10,4,2,.6);border:1px solid rgba(255,214,170,.35);margin-bottom:5px;position:relative;overflow:hidden}
.ec-bar i{position:absolute;left:0;top:0;bottom:0;width:100%;transform-origin:left center}
.ec-bar.hp i{background:linear-gradient(90deg,#7e1710,#d4452c)}
.ec-bar.hp b{position:absolute;left:0;top:0;bottom:0;width:100%;background:#f6c49a;transform-origin:left center;opacity:.55}
.ec-bar.st{height:6px}.ec-bar.st i{background:linear-gradient(90deg,#b98a2c,#ffd774)}
.ec-bar.st.low i{background:#7a5a24}
.ec-boss{position:absolute;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 34px);transform:translateX(-50%);width:min(620px,74vw);display:none}
.ec-boss .nm{text-align:center;letter-spacing:.32em;font-size:13px;margin-bottom:6px;text-shadow:0 1px 3px #000}
.ec-boss .ec-bar{height:10px}.ec-boss .po i{background:linear-gradient(90deg,#c8902c,#ffe08a)}.ec-boss .po{height:4px}
.ec-wave{position:absolute;right:calc(env(safe-area-inset-right,0px) + 18px);top:calc(env(safe-area-inset-top,0px) + 16px);text-align:right;font-size:14px;letter-spacing:.2em;text-shadow:0 1px 3px #000}
.ec-wave small{display:block;opacity:.85;letter-spacing:.12em;font-size:12px;margin-top:4px}
.ec-hud.ec-touch .ec-wave{right:calc(env(safe-area-inset-right,0px) + 84px)}
.ec-hud.ec-ended .ec-boss{display:none!important}
.ec-banner{position:absolute;left:0;right:0;top:34%;text-align:center;opacity:0;transition:opacity .5s;text-shadow:0 2px 12px #000}
.ec-banner.on{opacity:1}.ec-banner h2{margin:0;font-weight:400;font-size:clamp(26px,5vw,52px);letter-spacing:.3em}
.ec-banner p{margin:8px 0 0;font-size:clamp(12px,1.6vw,16px);letter-spacing:.25em;opacity:.8}
.ec-cue{position:absolute;left:50%;top:58%;transform:translate(-50%,-50%);font-size:15px;letter-spacing:.3em;text-shadow:0 1px 6px #000;opacity:0;transition:opacity .12s}
.ec-cue.on{opacity:1}.ec-cue.perfect{color:#ffe7a6}.ec-cue.phantom{color:#9fd4ff}.ec-cue.hit{color:#ff8a70}
.ec-prompt{position:absolute;left:50%;top:66%;transform:translateX(-50%);padding:6px 14px;border:1px solid rgba(255,220,170,.6);background:rgba(20,8,4,.55);font-size:13px;letter-spacing:.2em;display:none}
.ec-vign{position:absolute;inset:0;box-shadow:inset 0 0 160px rgba(160,10,0,.0);transition:box-shadow .25s}
.ec-screen{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;pointer-events:auto;
  background:radial-gradient(ellipse at center,rgba(20,6,3,.35),rgba(8,2,1,.82));text-align:center;padding:24px}
.ec-screen.on{display:flex}
.ec-screen h1{margin:0;font-weight:400;font-size:clamp(40px,9vw,96px);letter-spacing:.24em;color:#ffd9b0;text-shadow:0 4px 24px rgba(200,40,10,.55)}
.ec-screen h3{margin:6px 0 28px;font-weight:400;letter-spacing:.42em;font-size:clamp(11px,1.6vw,15px);opacity:.8}
.ec-btn2{pointer-events:auto;min-width:220px;min-height:52px;margin:6px;padding:12px 26px;font:inherit;font-size:16px;letter-spacing:.3em;color:#ffe6c8;
  background:rgba(120,24,10,.55);border:1px solid rgba(255,200,150,.55);cursor:pointer}
.ec-btn2:hover,.ec-btn2:focus-visible{background:rgba(170,40,16,.75);outline:none}
.ec-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px}.ec-slot{display:contents}
.ec-keys{margin-top:26px;font-size:14px;line-height:1.9;letter-spacing:.1em;opacity:.92;max-width:600px;padding:10px 16px;background:rgba(10,4,2,.55);border-radius:6px}
.ec-stats{margin:4px 0 22px;font-size:14px;line-height:1.9;letter-spacing:.14em}
.ec-credit{position:absolute;bottom:calc(env(safe-area-inset-bottom,0px) + 10px);left:0;right:0;font-size:12px;opacity:.8;letter-spacing:.04em;text-shadow:0 1px 2px #000}
.ec-load{position:fixed;inset:0;z-index:40;background:#0b0504;display:flex;align-items:center;justify-content:center;flex-direction:column;
  color:#f0d2b0;font-family:Georgia,serif;letter-spacing:.3em;transition:opacity .6s}
.ec-load .pb{width:min(320px,60vw);height:3px;background:#2a130c;margin-top:16px}.ec-load .pb i{display:block;height:100%;width:0;background:#d4602e;transition:width .3s}
.ec-dmg{position:absolute;left:0;top:0;font-weight:700;font-size:22px;letter-spacing:.04em;color:#fff4dc;opacity:0;white-space:nowrap;
  text-shadow:0 0 2px #000,0 2px 6px #000,0 0 14px rgba(255,120,40,.55);will-change:transform,opacity}
.ec-dmg.big{font-size:34px;color:#ffd36a}.ec-dmg.weak{font-size:16px;color:#cfc6bb}.ec-dmg.fin{font-size:48px;color:#ffb347}
.ec-flash{position:absolute;inset:0;background:#fff3e0;opacity:0;mix-blend-mode:screen}
@media (prefers-reduced-motion:reduce){.ec-banner,.ec-cue,.ec-vign,.ec-load{transition:none}}
`;

export class Hud {
  static id = 'hud';
  init({ host = document.body, credit = '', touch = false, onStart, onRetry, onRestart, onResume }) {
    this.disposed = false;
    this._style = document.createElement('style'); this._style.textContent = CSS; document.head.appendChild(this._style);
    const r = this.root = document.createElement('div'); r.className = 'ec-hud'; r.dataset.ec = 'hud';
    r.innerHTML = `
      <div class="ec-vign"></div>
      <div class="ec-bars" data-ec="bars"><div class="ec-bar hp"><b></b><i></i></div><div class="ec-bar st"><i></i></div></div>
      <div class="ec-wave" data-ec="wave"></div>
      <div class="ec-boss" data-ec="boss"><div class="nm">FORD WYVERN</div><div class="ec-bar hp"><b></b><i></i></div><div class="ec-bar po"><i></i></div></div>
      <div class="ec-banner" data-ec="banner"><h2></h2><p></p></div>
      <div class="ec-cue" data-ec="cue"></div>
      <div class="ec-prompt" data-ec="prompt"></div>
      <div class="ec-screen" data-ec="title"><h1>EMBER COURT</h1><h3>THE CRIMSON FORD</h3>
        <div class="ec-row"><button class="ec-btn2" data-ec="start">BEGIN</button><span class="ec-slot" data-ec="slot-fs"></span></div>
        <div class="ec-keys">${touch ? 'Left thumb moves. Tap ATK, hold HVY. BLK at the right moment deflects. DGE through red and blue strikes, ROLL to roll clear.'
          : 'WASD move &nbsp; Shift walk &nbsp; Mouse look<br>J / Left click attack &nbsp; K / Right click heavy<br>L or Q block - tap as a strike lands to deflect<br>Space dodge - through red and blue strikes &nbsp; C roll &nbsp; Esc pause'}</div>
        <div class="ec-credit"></div></div>
      <div class="ec-screen" data-ec="pause"><h1 style="font-size:clamp(30px,6vw,64px)">PAUSED</h1><h3>&nbsp;</h3>
        <button class="ec-btn2" data-ec="resume">RESUME</button><button class="ec-btn2" data-ec="quit">RESTART</button></div>
      <div class="ec-screen" data-ec="victory"><h1 style="font-size:clamp(30px,7vw,72px)">VICTORY</h1><h3>THE FORD IS QUIET</h3>
        <div class="ec-stats"></div><button class="ec-btn2" data-ec="again">PLAY AGAIN</button></div>
      <div class="ec-screen" data-ec="defeat"><h1 style="font-size:clamp(30px,7vw,72px);color:#ff9c84">FALLEN</h1><h3>&nbsp;</h3>
        <div class="ec-stats"></div><button class="ec-btn2" data-ec="retry">RETRY</button><button class="ec-btn2" data-ec="restart">FROM THE START</button></div>`;
    host.appendChild(r);
    const q = (s) => r.querySelector('[data-ec="' + s + '"]');
    this.el = { title: q('title'), pause: q('pause'), victory: q('victory'), defeat: q('defeat'), wave: q('wave'), boss: q('boss'),
      banner: q('banner'), cue: q('cue'), prompt: q('prompt'), bars: q('bars'), vign: r.querySelector('.ec-vign') };
    this.el.hpI = this.el.bars.querySelector('.hp i'); this.el.hpB = this.el.bars.querySelector('.hp b');
    this.el.st = this.el.bars.querySelector('.st'); this.el.stI = this.el.st.querySelector('i');
    this.el.bhpI = this.el.boss.querySelector('.hp i'); this.el.bhpB = this.el.boss.querySelector('.hp b'); this.el.bpoI = this.el.boss.querySelector('.po i');
    r.querySelector('.ec-credit').textContent = credit;
    const bind = (k, fn) => { const b = q(k); const h = (e) => { e.preventDefault(); e.stopPropagation(); if (fn) fn(); }; b.addEventListener('click', h); (this._binds ||= []).push([b, h]); };
    bind('start', onStart); bind('again', onRestart); bind('retry', onRetry); bind('restart', onRestart); bind('resume', onResume); bind('quit', onRestart);
    this._hpLag = 1; this._bhpLag = 1; this._cueT = 0; this._bannerT = 0; this._screen = '';
    // pooled floating damage numbers (Monster Hunter style) + full-screen impact flash. Fixed pool, no per-hit DOM churn.
    this._flash = document.createElement('div'); this._flash.className = 'ec-flash'; r.insertBefore(this._flash, r.firstChild); this._flashA = 0;
    this._dmg = [];
    for (let i = 0; i < 12; i++) { const e = document.createElement('div'); e.className = 'ec-dmg'; r.appendChild(e); this._dmg.push({ e, t: 9, life: 0.9, x: 0, y: 0, dx: 0 }); }
    this._dmgNext = 0;
    return this;
  }

  // named DOM slot another ui system may place its control into (e.g. 'fs' beside BEGIN)
  slot(name) { return this.root.querySelector('[data-ec="slot-' + name + '"]'); }

  showLoading(p) { /* the loader overlay is owned by index.html (#load) */ const b = document.querySelector('#load .pb i'); if (b) b.style.width = Math.round(p * 100) + '%'; }
  hideLoading() { const l = document.getElementById('load'); if (l) { l.style.opacity = '0'; setTimeout(() => l.remove(), 700); } }

  screen(name) {
    if (this._screen === name) return;
    this._screen = name;
    for (const k of ['title', 'pause', 'victory', 'defeat']) this.el[k].classList.toggle('on', k === name);
    const play = name === '';
    this.el.bars.style.display = play || name === 'pause' ? '' : 'none';
    this.el.wave.style.display = play ? '' : 'none';
    this.root.classList.toggle('ec-ended', name === 'victory' || name === 'defeat' || name === 'title');
    const btn = name && this.el[name].querySelector('button'); if (btn) btn.focus({ preventScroll: true });
  }

  banner(title, sub = '', seconds = 2.2) {
    this.el.banner.querySelector('h2').textContent = title; this.el.banner.querySelector('p').textContent = sub;
    this.el.banner.classList.add('on'); this._bannerT = seconds;
  }

  cue(text, kind) { const c = this.el.cue; c.textContent = text; c.className = 'ec-cue on ' + kind; this._cueT = 0.7; }

  setStats(kind, s) {
    const t = (f) => { const sec = Math.round(f / 60); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
    this.el[kind].querySelector('.ec-stats').innerHTML = 'TIME ' + t(s.totalF) + '<br>FOES FELLED ' + s.kills
      + '<br>PERFECT DEFLECTS ' + s.perfects + ' &nbsp; PHANTOM STEPS ' + s.phantoms + '<br>FINISHERS ' + s.finishers
      + (kind === 'defeat' && s.bossHp !== undefined && s.reachedBoss ? '<br>WYVERN ' + Math.round(100 * s.bossHp / s.bossMax) + '% REMAINING' : '');
  }

  // view: { hp, hpMax, stamina, staminaMax, staminaFail, boss: null | { hp, max, posture, postureMax }, wave, waveCount,
  //         foes, finisher, flash }   dt: real seconds
  update(view, dt) {
    const E = this.el;
    if (this._touchCls !== !!view.touch) { this._touchCls = !!view.touch; this.root.classList.toggle('ec-touch', this._touchCls); }
    const hp = Math.max(0, view.hp / view.hpMax);
    E.hpI.style.transform = 'scaleX(' + hp.toFixed(4) + ')';
    this._hpLag = this._hpLag > hp ? Math.max(hp, this._hpLag - dt * 0.35) : hp;
    E.hpB.style.transform = 'scaleX(' + this._hpLag.toFixed(4) + ')';
    E.stI.style.transform = 'scaleX(' + Math.max(0, view.stamina / view.staminaMax).toFixed(4) + ')';
    E.st.classList.toggle('low', view.staminaFail);
    if (view.boss) {
      E.boss.style.display = 'block';
      const b = Math.max(0, view.boss.hp / view.boss.max);
      E.bhpI.style.transform = 'scaleX(' + b.toFixed(4) + ')';
      this._bhpLag = this._bhpLag > b ? Math.max(b, this._bhpLag - dt * 0.25) : b;
      E.bhpB.style.transform = 'scaleX(' + this._bhpLag.toFixed(4) + ')';
      E.bpoI.style.transform = 'scaleX(' + Math.min(1, view.boss.posture / view.boss.postureMax).toFixed(4) + ')';
    } else { E.boss.style.display = 'none'; this._bhpLag = 1; }
    E.wave.innerHTML = view.waveLabel || '';
    E.prompt.style.display = view.finisher ? 'block' : 'none';
    if (view.finisher) E.prompt.textContent = view.touch ? 'HVY  -  FINISHER' : 'K / RIGHT CLICK  -  FINISHER';
    E.vign.style.boxShadow = 'inset 0 0 160px rgba(160,10,0,' + (view.flash > 0 ? 0.55 : hp < 0.3 ? 0.28 : 0) + ')';
    if (this._cueT > 0 && (this._cueT -= dt) <= 0) E.cue.classList.remove('on');
    if (this._bannerT > 0 && (this._bannerT -= dt) <= 0) E.banner.classList.remove('on');
    for (const d of this._dmg) {
      if (d.t >= d.life) continue;
      d.t += dt; const k = Math.min(1, d.t / d.life);
      const pop = k < 0.12 ? 1.6 - 5 * k : 1.0;                 // punch in, settle
      const y = d.y - 46 * (1 - (1 - k) * (1 - k));             // ease-out rise
      d.e.style.opacity = (k < 0.7 ? 1 : (1 - k) / 0.3).toFixed(3);
      d.e.style.transform = 'translate(' + (d.x + d.dx * k).toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-50%) scale(' + pop.toFixed(3) + ')';
      if (d.t >= d.life) d.e.style.opacity = '0';
    }
    if (this._flashA > 0) { this._flashA = Math.max(0, this._flashA - dt * 3.2); this._flash.style.opacity = this._flashA.toFixed(3); }
  }

  // screen-space damage number. kind: '' | 'big' | 'weak' | 'fin'. x/y in CSS px. dx: horizontal drift (caller-seeded).
  popDamage(x, y, amount, kind = '', dx = 0) {
    if (!(amount > 0) || x < -50 || y < -50 || x > innerWidth + 50 || y > innerHeight + 50) return;
    const d = this._dmg[this._dmgNext]; this._dmgNext = (this._dmgNext + 1) % this._dmg.length;
    d.e.textContent = String(Math.round(amount)); d.e.className = 'ec-dmg' + (kind ? ' ' + kind : '');
    d.x = x; d.y = y; d.dx = dx; d.t = 0; d.life = kind === 'fin' ? 1.4 : kind === 'big' ? 1.1 : 0.85;
  }

  // full-screen white flash (capped; reduced-motion callers pass a lower k)
  flash(k = 0.6) { this._flashA = Math.max(this._flashA, Math.min(0.85, k)); this._flash.style.opacity = this._flashA.toFixed(3); }

  clearFx() { for (const d of this._dmg) { d.t = 9; d.e.style.opacity = '0'; } this._flashA = 0; this._flash.style.opacity = '0'; }

  dispose() {
    this.disposed = true;
    for (const [b, h] of this._binds || []) b.removeEventListener('click', h);
    this.root.remove(); this._style.remove();
  }
}
