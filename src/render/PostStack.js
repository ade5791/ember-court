// PostStack - the single definition of the finish chain (ARCHITECTURE.md section 7: post is finish only).
// RenderPass (MSAA half-float) -> UnrealBloom (HDR threshold, so only emissives, flame, blades and VFX bloom)
// -> Grade (per-stage split tone, saturation, vignette, impact flash) -> OutputPass (AgX + sRGB, reads exposure).
// Per-stage settings only move uniforms, never defines, so swapping stage never compiles a program.
// Everything is drawn into the composer target, so every lit program is keyed for a render target (NoToneMapping,
// linear out). prewarm() compiles against that target - compiling against the canvas would build the wrong variant.
// ?post=off (or quality.post === 'tonemap') disables the chain and the game renders straight to the canvas.
// No clock, no RNG: flash decay is driven by the presentation dt passed to render().
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// bloom: [strength, radius, threshold (linear HDR luminance)]; shadow/high: split-tone tints added by luminance band;
// gain: per-channel multiply; sat: saturation; vig: [strength, softness]; contrast: pivot 0.18 (linear mid grey)
export const STAGE_POST = Object.freeze({
  ford: Object.freeze({ bloom: [0.32, 0.45, 1.05], gain: [1.0, 1.0, 1.0], shadow: [0.0, 0.0, 0.0], high: [0.0, 0.0, 0.0], sat: 1.0, contrast: 1.0, vig: [0.28, 0.55] }),
  // dusk shrine: violet shadows, ember highlights, lanterns and the setting sky bloom
  shrine: Object.freeze({ bloom: [0.62, 0.55, 0.92], gain: [1.04, 0.98, 0.98], shadow: [0.010, 0.000, 0.030], high: [0.035, 0.010, -0.015], sat: 1.12, contrast: 1.10, vig: [0.42, 0.50] }),
  // frozen foundry: cyan shadows, warm crystal highlights; blades, lightning and the dome bloom hard
  // mountain pass: cool haze shadows, warm sun highlights, gentle bloom on the lanterns
  road: Object.freeze({ bloom: [0.40, 0.50, 0.98], gain: [1.02, 1.0, 0.98], shadow: [0.000, 0.004, 0.018], high: [0.030, 0.014, -0.012], sat: 1.04, contrast: 1.08, vig: [0.36, 0.52] }),
  foundry: Object.freeze({ bloom: [0.78, 0.50, 0.85], gain: [0.98, 1.0, 1.05], shadow: [0.000, 0.006, 0.022], high: [0.040, 0.012, -0.010], sat: 1.08, contrast: 1.14, vig: [0.48, 0.48] }),
});

const GradeShader = {
  name: 'EmberGrade',
  uniforms: {
    tDiffuse: { value: null },
    uGain: { value: new THREE.Vector3(1, 1, 1) }, uShadow: { value: new THREE.Vector3() }, uHigh: { value: new THREE.Vector3() },
    uSat: { value: 1 }, uContrast: { value: 1 }, uVig: { value: new THREE.Vector2(0.3, 0.5) },
    uFlash: { value: new THREE.Vector4(1, 1, 1, 0) }, uAspect: { value: 1.6 },
    // v2.17 impact blur: xy = contact point in uv, z = strength (0 = off), w = clear radius in uv around the contact
    uBlur: { value: new THREE.Vector4(0.5, 0.5, 0, 0.12) },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec3 uGain, uShadow, uHigh; uniform float uSat, uContrast, uAspect;
    uniform vec2 uVig; uniform vec4 uFlash; uniform vec4 uBlur; varying vec2 vUv;
    void main() {
      vec4 t = texture2D(tDiffuse, vUv);
      // radial zoom blur toward the contact point: the contact itself stays sharp (clear radius), the frame edges
      // smear inward for a few frames. Uniform branch, so no extra program and zero cost when idle.
      if (uBlur.z > 0.001) {
        vec2 dv = vUv - uBlur.xy; float dl = length(dv * vec2(uAspect, 1.0));
        float m = uBlur.z * smoothstep(uBlur.w, uBlur.w + 0.35, dl);
        // v2.17e: per-pixel dither on the tap offsets so the stronger smear reads as streaks, not 8 stepped copies
        float jit = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
        vec3 acc = max(t.rgb, 0.0);
        for (int i = 1; i < 8; i++) { acc += max(texture2D(tDiffuse, vUv - dv * (m * (float(i) - jit) / 7.0)).rgb, 0.0); }
        t.rgb = acc / 8.0;
      }
      vec3 c = max(t.rgb, 0.0) * uGain;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // contrast around linear mid grey in log space keeps HDR highlights intact
      c = c * pow(max(l, 1e-4) / 0.18, uContrast - 1.0);
      l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      float sh = 1.0 - smoothstep(0.0, 0.25, l), hi = smoothstep(0.35, 1.6, l);
      c += uShadow * sh + uHigh * hi * (1.0 + l);
      vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0) / max(uAspect, 1.0) * 2.0;
      float v = 1.0 - uVig.x * smoothstep(uVig.y, 1.45, length(d));
      c *= v;
      // v2.17c: tinted exposure lift instead of mix() toward a flat colour. The mix pulled every pixel to one value
      // (measured on a charged heavy: luma 79 -> 117, contrast 22 -> 15, the "sepia wash"); a multiply keeps the
      // value structure, so the hero still separates from the arena during the flash
      c = c * (1.0 + uFlash.rgb * uFlash.a * 1.4) + uFlash.rgb * uFlash.a * 0.04;
      gl_FragColor = vec4(max(c, 0.0), t.a);
    }`,
};

export class PostStack {
  constructor(renderer, scene, camera, quality, { enabled = true } = {}) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.enabled = enabled && quality.post !== 'tonemap';
    this.flash = 0; this.flashColor = new THREE.Color(1, 1, 1); this.stage = '';
    this.blur = 0; this.blurX = 0.5; this.blurY = 0.5;
    if (!this.enabled) return;
    const pr = renderer.getPixelRatio(), w = innerWidth, h = innerHeight;
    // MSAA target: the canvas antialias flag does nothing once the scene renders into a target
    const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: quality.name === 'low' ? 0 : 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.setPixelRatio(pr); this.composer.setSize(w, h);
    this.renderPass = new RenderPass(scene, camera);
    // bloom at half resolution internally (UnrealBloomPass halves the first mip again)
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w * pr * 0.5, h * pr * 0.5), 0.4, 0.5, 1.0);
    this.grade = new ShaderPass(GradeShader);
    this.output = new OutputPass();
    this.composer.addPass(this.renderPass); this.composer.addPass(this.bloom);
    if (quality.post === 'grade' || quality.post === 'bloom') this.composer.addPass(this.grade);
    this.composer.addPass(this.output);
    this.setStage('ford');
  }

  setStage(name) {
    const P = STAGE_POST[name] || STAGE_POST.ford; this.stage = name;
    if (!this.enabled) return;
    this.bloom.strength = P.bloom[0]; this.bloom.radius = P.bloom[1]; this.bloom.threshold = P.bloom[2];
    const u = this.grade.uniforms;
    u.uGain.value.fromArray(P.gain); u.uShadow.value.fromArray(P.shadow); u.uHigh.value.fromArray(P.high);
    u.uSat.value = P.sat; u.uContrast.value = P.contrast; u.uVig.value.fromArray(P.vig);
  }

  // impact flash in the grade (screen-space, tinted): k 0..1, decays over ~0.18 s of presentation time
  kick(k, color = 0xffffff) { if (k > this.flash) { this.flash = k; this.flashColor.setHex(color); } }

  // v2.17 impact blur toward a world-space contact point. k 0..1 (1 = charged heavy); decays over ~0.14 s of
  // presentation time, so hitstop (dilated dt) holds it on screen exactly as long as the freeze. A contact behind
  // the camera falls back to screen centre. Presentation only: never reads or writes sim state.
  impactBlur(worldPos, k) {
    if (!this.enabled || !(k > this.blur)) return;
    const v = this._bp || (this._bp = new THREE.Vector3());
    v.copy(worldPos).project(this.camera);
    const ok = v.z < 1 && Math.abs(v.x) < 1.6 && Math.abs(v.y) < 1.6;
    this.blurX = ok ? Math.min(1, Math.max(0, v.x * 0.5 + 0.5)) : 0.5; this.blurY = ok ? Math.min(1, Math.max(0, v.y * 0.5 + 0.5)) : 0.5;
    this.blur = Math.min(1, k);
  }

  setSize(w, h) {
    if (!this.enabled) return;
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr); this.composer.setSize(w, h);
    this.bloom.setSize(w * pr * 0.5, h * pr * 0.5);
  }

  render(dt = 0) {
    if (!this.enabled) { this.renderer.render(this.scene, this.camera); return; }
    if (dt > 0) { this.flash = Math.max(0, this.flash - dt * 5.5); this.blur = Math.max(0, this.blur - dt * 7.0); }
    const u = this.grade.uniforms; u.uFlash.value.set(this.flashColor.r, this.flashColor.g, this.flashColor.b, this.flash * 0.55);
    // max smear 0.09 of the contact->pixel vector (strength eased so small hits barely move the edges)
    // v2.17c: 0.09 smeared the hero's legs and the arena into mud; 0.05 with a wider clear radius keeps the
    // contact and the hero crisp and only streaks the frame edges
    u.uBlur.value.set(this.blurX, this.blurY, this.blur * this.blur * 0.075, 0.34);   // v2.17e: 0.035 -> 0.075 (critic: smear unreadable), clear radius 0.42 -> 0.34   // v2.17d: outer band only, nearby foes stay readable
    u.uAspect.value = innerWidth / innerHeight;
    this.composer.render(dt);
  }

  // Compile every scene program against the composer's target (the only target the scene is drawn into), then one
  // full hidden pass so the bloom/grade/output programs and the shadow-depth variants are built before frame 1.
  async prewarm() {
    if (!this.enabled) { await this.renderer.compileAsync(this.scene, this.camera, this.scene); return; }
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.composer.readBuffer);
    await r.compileAsync(this.scene, this.camera, this.scene);
    r.setRenderTarget(this.composer.writeBuffer);
    await r.compileAsync(this.scene, this.camera, this.scene);
    r.setRenderTarget(prev);
    this.composer.render(0);
  }

  dispose() {
    if (!this.enabled) return;
    this.bloom.dispose(); this.grade.dispose && this.grade.dispose(); this.output.dispose && this.output.dispose();
    this.composer.dispose();
  }
}
