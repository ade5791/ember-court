// Quality presets - ARCHITECTURE.md section 7. Light count is identical across presets (section 8);
// presets only change resolution and budgets. Selected by ?q=low|med|high (auto probe lands with src/render/).
export const QUALITY = Object.freeze({
  low: Object.freeze({ name: 'low', pixelRatioCap: 1.0, shadowMap: 1024, cascades: 2, ao: 'off', post: 'tonemap',
    particles: 400, trailSegments: 16, decals: 16, anisotropy: 2, waterReflection: 0 }),
  med: Object.freeze({ name: 'med', pixelRatioCap: 1.5, shadowMap: 2048, cascades: 3, ao: 'half', post: 'bloom',
    particles: 900, trailSegments: 24, decals: 32, anisotropy: 4, waterReflection: 0.35 }),
  high: Object.freeze({ name: 'high', pixelRatioCap: 2.0, shadowMap: 2048, cascades: 3, ao: 'full', post: 'grade',
    particles: 1500, trailSegments: 32, decals: 48, anisotropy: 8, waterReflection: 0.5 }),
  // recording only (?q=ultra): high with 4096 shadow maps and 16x anisotropy. Same budgets and light count, so no new programs.
  ultra: Object.freeze({ name: 'ultra', pixelRatioCap: 2.0, shadowMap: 4096, cascades: 3, ao: 'full', post: 'grade',
    particles: 1500, trailSegments: 32, decals: 48, anisotropy: 16, waterReflection: 0.5 }),
});

export function resolveQuality(name) {
  return QUALITY[name] || QUALITY.high;
}
