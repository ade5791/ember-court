// AmbientMotes - per-stage atmosphere particles (one Points draw per stage, allocation-free per frame).
//   shrine : ember sparks rising off the lanterns and drifting on a warm updraft, plus slow amber fireflies
//   foundry: frost motes falling through the roof shafts with a cold glint, plus rare bright ice flecks
// Parented to the stage root, so visibility follows the stage. HDR colours (>1) so the PostStack bloom reads them as
// light; with ?post=off they still read as small glints. Seeded from a named presentation stream (never the sim
// streams); motion is driven by presentation dt only. Reduced motion halves the count and the drift speed.
import * as THREE from 'three';

export const MOTES = Object.freeze({
  shrine: Object.freeze({ count: 240, box: [17, 9, 17], y0: 0.2, vy: [0.25, 0.9], drift: 0.55, size: [0.05, 0.14],
    a: [2.6, 1.05, 0.30], b: [1.6, 0.55, 0.18], flicker: 9.0, life: [3.5, 7.0] }),
  // road: sunlit dust and seed fluff drifting across the pass (the group follows the hero down the road)
  road: Object.freeze({ count: 200, box: [14, 7, 22], y0: 0.3, vy: [-0.06, 0.12], drift: 0.75, size: [0.03, 0.08],
    a: [1.35, 1.15, 0.80], b: [0.70, 0.62, 0.48], flicker: 2.0, life: [5.0, 9.0] }),
  foundry: Object.freeze({ count: 300, box: [17, 13, 17], y0: 0.1, vy: [-0.55, -0.18], drift: 0.35, size: [0.035, 0.10],
    a: [1.25, 1.55, 2.1], b: [0.55, 0.75, 1.2], flicker: 5.0, life: [5.0, 10.0] }),
});

export class AmbientMotes {
  constructor(kind, { rng, quality, reducedMotion = false }) {
    const P = this.P = MOTES[kind];
    this.kind = kind; this.rng = rng; this.rm = reducedMotion;
    const scale = quality && quality.name === 'low' ? 0.5 : 1;
    const n = this.n = Math.max(16, Math.floor(P.count * scale * (reducedMotion ? 0.5 : 1)));
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n); this.max = new Float32Array(n); this.phase = new Float32Array(n);
    this.col = new Float32Array(n * 4); this.size = new Float32Array(n); this.base = new Float32Array(n);
    this.t = 0;
    for (let i = 0; i < n; i++) { this._spawn(i, true); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, P.box[1] * 0.5, 0), 40);
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uScale: { value: 500 } },
      vertexShader: 'attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vC;' +
        'void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.5), 1.0, 48.0); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'varying vec4 vC; void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard;' +
        ' float k = (1.0 - r); k = k * k * (0.35 + 0.65 * exp(-r * 6.0)); gl_FragColor = vec4(vC.rgb * vC.a * k, vC.a * k);' +
        '\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
    });
    this.points = new THREE.Points(g, this.mat); this.points.name = 'motes_' + kind;
    this.points.frustumCulled = false; this.points.renderOrder = 7;
  }

  _spawn(i, initial) {
    const P = this.P, r = this.rng, o = i * 3;
    this.pos[o] = r.range(-P.box[0], P.box[0]); this.pos[o + 2] = r.range(-P.box[2], P.box[2]);
    // falling motes respawn at the top, rising embers at the floor; the initial fill is spread through the volume
    this.pos[o + 1] = initial ? r.range(P.y0, P.box[1]) : (P.vy[1] < 0 ? P.box[1] : P.y0 + r.range(0, 1.2));
    const k = this.rm ? 0.5 : 1;
    this.vel[o] = r.range(-1, 1) * P.drift * 0.4 * k; this.vel[o + 1] = r.range(P.vy[0], P.vy[1]) * k; this.vel[o + 2] = r.range(-1, 1) * P.drift * 0.4 * k;
    const life = r.range(P.life[0], P.life[1]); this.max[i] = life; this.life[i] = initial ? r.range(0.1, 1) * life : life;
    this.phase[i] = r.range(0, 6.283); this.base[i] = r.range(P.size[0], P.size[1]);
    const c = r.float(), o4 = i * 4;
    this.col[o4] = P.a[0] + (P.b[0] - P.a[0]) * c; this.col[o4 + 1] = P.a[1] + (P.b[1] - P.a[1]) * c; this.col[o4 + 2] = P.a[2] + (P.b[2] - P.a[2]) * c;
  }

  setViewportHeight(px) { this.mat.uniforms.uScale.value = px * 0.55; }

  update(dt) {
    if (dt <= 0 || !this.points.parent || !this.points.parent.visible) return;
    const P = this.P, p = this.pos, v = this.vel, col = this.col, sz = this.size;
    this.t += dt; const t = this.t, sway = this.rm ? 0.4 : 1;
    for (let i = 0; i < this.n; i++) {
      const o = i * 3, o4 = i * 4;
      this.life[i] -= dt;
      const y = p[o + 1];
      if (this.life[i] <= 0 || y > P.box[1] + 0.5 || y < 0.02) { this._spawn(i, false); continue; }
      const ph = this.phase[i];
      // curl-ish swirl: two out-of-phase sines per particle give a lazy figure-of-eight drift
      p[o] += (v[o] + Math.sin(t * 0.7 + ph) * P.drift * sway) * dt;
      p[o + 1] += v[o + 1] * dt;
      p[o + 2] += (v[o + 2] + Math.cos(t * 0.53 + ph * 1.3) * P.drift * sway) * dt;
      const u = this.life[i] / this.max[i];                       // 1 -> 0 over life
      const fade = Math.min(1, (1 - u) * 5) * Math.min(1, u * 3);  // fade in fast, out slow
      const fl = 0.65 + 0.35 * Math.sin(t * P.flicker + ph * 7.0);
      col[o4 + 3] = fade * fl;
      sz[i] = this.base[i] * (0.7 + 0.3 * fl);
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = true; a.aColor.needsUpdate = true; a.aSize.needsUpdate = true;
  }

  dispose() { this.points.geometry.dispose(); this.mat.dispose(); }
}
