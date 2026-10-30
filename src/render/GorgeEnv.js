// GorgeEnv - generated overcast-gorge environment for PMREM (CINEMATIC_SPEC section 6 lighting): overcast sky,
// a red maple band at the horizon, dark cliff rock below it and a river floor. Replaces RoomEnvironment, whose
// neutral grey box made every glossy surface (the water above all) mirror a featureless beige room.
// Colours come from GORGE_LOOK.env (src/render/GorgeLook.js) so the reflections agree with the visible sky.
// Pure function of its arguments (no clock, no RNG).
import * as THREE from 'three';

const DEFAULT_ENV = { sky: [0.86, 0.78, 0.78], zenith: [0.62, 0.62, 0.68], maple: [0.55, 0.10, 0.07], cliff: [0.16, 0.12, 0.11], floor: [0.22, 0.16, 0.09] };

export function makeGorgeEnvironment(renderer, sigma = 0.04, colors = DEFAULT_ENV) {
  const c = (k) => new THREE.Color(colors[k][0], colors[k][1], colors[k][2]);
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: {
      uSky: { value: c('sky') }, uZenith: { value: c('zenith') }, uMaple: { value: c('maple') },
      uCliff: { value: c('cliff') }, uFloor: { value: c('floor') },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vDir; uniform vec3 uSky, uZenith, uMaple, uCliff, uFloor;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main(){
        float y = vDir.y; float az = atan(vDir.z, vDir.x);
        vec3 sky = mix(uSky, uZenith, smoothstep(0.15, 0.9, y));
        // ragged maple/cliff skyline between y 0.02 and 0.30 (canopy lumps vary with azimuth)
        float lump = 0.16 + 0.10 * sin(az * 7.0) * sin(az * 3.0 + 1.3) + 0.05 * h(vec2(floor(az * 24.0), 1.0));
        float band = smoothstep(lump + 0.03, lump - 0.03, y);
        vec3 c = mix(sky, uMaple, band);
        c = mix(c, uCliff, smoothstep(0.04, -0.06, y));
        c = mix(c, uFloor, smoothstep(-0.15, -0.5, y));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, sigma);
  pmrem.dispose(); mat.dispose(); scene.children[0].geometry.dispose();
  return rt;
}
