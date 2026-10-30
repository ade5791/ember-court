// Rng - xoshiro128** with named forkable streams (ARCHITECTURE.md section 9). No Math.random() in src/.
function rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }
function splitmix32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15; t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    const sm = splitmix32(this.seed);
    this.s = new Uint32Array(4);
    this.s[0] = sm(); this.s[1] = sm(); this.s[2] = sm(); this.s[3] = sm();
    if ((this.s[0] | this.s[1] | this.s[2] | this.s[3]) === 0) this.s[0] = 1;
  }
  u32() {
    const s = this.s;
    const r = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t; s[3] = rotl(s[3], 11);
    return r;
  }
  float() { return this.u32() / 4294967296; }
  range(a, b) { return a + (b - a) * this.float(); }
  // Independent stream derived from the ROOT seed and a name: same name -> same sequence, regardless of use order.
  stream(name) { return new Rng((this.seed ^ fnv1a(name)) >>> 0); }
  // Snapshot/restore (prewarm must be simulation-transparent).
  save(out) { out[0] = this.s[0]; out[1] = this.s[1]; out[2] = this.s[2]; out[3] = this.s[3]; return out; }
  load(src) { this.s[0] = src[0]; this.s[1] = src[1]; this.s[2] = src[2]; this.s[3] = src[3]; }
}
