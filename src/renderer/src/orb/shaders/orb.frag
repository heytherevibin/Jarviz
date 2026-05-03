precision highp float;

uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;
uniform vec3  uColorRim;
uniform vec3  uColorVein;
uniform float uFresnelPower;
uniform float uRimIntensity;
uniform float uSSSStrength;
uniform float uOpacity;
uniform float uTime;
uniform float uChromaticStrength;
uniform float uIridStrength;
uniform float uCausticStrength;
uniform float uGradientSpeed;
uniform float uSparkle;
uniform float uAudioReactive;

varying vec3  vNormal;
varying vec3  vWorldPos;
varying float vNoise;
varying vec3  vViewDir;
varying vec3  vRawPos;

float hash31(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

// ─── Iridescence ─────────────────────────────────────────────────────────────
vec3 iridescence(vec3 N, vec3 V, float time) {
  float ndotv = clamp(dot(N, V), 0.0, 1.0);
  float phase = (1.0 - ndotv) * 9.42478 + time * 0.35;
  return vec3(
    sin(phase)          * 0.5 + 0.5,
    sin(phase + 2.0944) * 0.5 + 0.5,
    sin(phase + 4.1888) * 0.5 + 0.5
  );
}

// ─── 3-color oblique gradient (NO axis-aligned grid artifacts) ───────────────
vec3 gradientWave(vec3 rawPos, float noise, float time, float speed) {
  // Three oblique waves using dot products with non-axis-aligned directions
  // This prevents any grid/quadrant pattern on the sphere surface
  float wA = sin(dot(rawPos, vec3( 1.3,  2.1,  0.7)) + noise * 1.5 + time * speed) * 0.5 + 0.5;
  float wB = sin(dot(rawPos, vec3(-1.1,  0.8,  2.0)) + noise * 1.2 + time * speed * 0.7 + 2.094) * 0.5 + 0.5;
  float wC = sin(dot(rawPos, vec3( 0.9, -1.6,  1.4)) + noise * 1.8 + time * speed * 1.1 + 4.189) * 0.5 + 0.5;

  float total = wA + wB + wC + 0.001;
  return uColorA * (wA / total) + uColorB * (wB / total) + uColorC * (wC / total);
}

// ─── Sparkle / glitter (tiny twinkling points) ───────────────────────────────
float sparkle(vec3 pos, float time, float intensity) {
  float h1 = hash31(floor(pos * 60.0) + floor(time * 4.0));
  float h2 = hash31(floor(pos * 90.0) + floor(time * 6.0 + 100.0));
  float s1 = smoothstep(0.97, 1.0, h1) * 1.0;
  float s2 = smoothstep(0.985, 1.0, h2) * 1.5;
  float flicker = sin(time * 18.0 + h1 * 60.0) * 0.5 + 0.5;
  return (s1 + s2 * flicker) * intensity;
}

// ─── SSS ─────────────────────────────────────────────────────────────────────
vec3 layeredSSS(vec3 N, vec3 colDeep, vec3 colMid, vec3 colSurf, float strength, float thick) {
  vec3 key = normalize(vec3(0.4, 1.0, 0.6));
  float wD = pow(max(0.0, dot(N, key) * 0.5 + 0.5), 1.0) * thick;
  float wM = pow(max(0.0, dot(N, key) * 0.5 + 0.5), 1.6) * 0.55;
  float wS = pow(max(0.0, dot(N, key)), 3.2) * 0.3;
  return (colDeep * wD * 0.4 + colMid * wM + colSurf * wS * 0.3) * strength;
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vViewDir);
  float ndotv = max(dot(N, V), 0.0);
  float fr = pow(clamp(1.0 - ndotv, 0.0, 1.0), uFresnelPower);
  float thickness = smoothstep(0.5, -0.8, vNoise);

  // ── Gradient wave body color (smooth, no grid artifacts) ────────────────
  vec3 baseColor = gradientWave(vRawPos, vNoise, uTime, uGradientSpeed);
  baseColor *= 1.0 + uAudioReactive * 0.5;

  // ── Subtle vein network ─────────────────────────────────────────────────
  float veinMask = smoothstep(-0.4, 0.3, vNoise);
  vec3 body = mix(baseColor, uColorVein, (1.0 - veinMask) * 0.12);

  // ── SSS ─────────────────────────────────────────────────────────────────
  body += layeredSSS(N, uColorB * 0.6, uColorB * 0.5, uColorC * 0.4, uSSSStrength, thickness);

  // ── Caustics ────────────────────────────────────────────────────────────
  vec3 l1 = normalize(vec3(sin(uTime*0.71), cos(uTime*0.53+1.3), sin(uTime*0.37+2.1)));
  vec3 l2 = normalize(vec3(cos(uTime*0.43+0.7), sin(uTime*0.82), cos(uTime*0.61+1.8)));
  float c1 = pow(max(0.0, dot(N, l1)), 32.0);
  float c2 = pow(max(0.0, dot(N, l2)), 44.0);
  float caustics = (c1 * 0.10 + c2 * 0.08) * (1.0 - fr * fr) * uCausticStrength;
  body += mix(uColorC * 0.6, vec3(1.0), 0.3) * caustics;

  // ── Sparkle ─────────────────────────────────────────────────────────────
  float spk = sparkle(vRawPos, uTime, uSparkle) * (1.0 + uAudioReactive) * (0.4 + ndotv * 0.6);
  body += mix(uColorC, vec3(1.0), 0.6) * spk;

  // ── Specular ────────────────────────────────────────────────────────────
  float spec = pow(max(0.0, dot(reflect(-normalize(vec3(0.3, 0.8, 1.0)), N), V)), 56.0);
  body += uColorRim * spec * 0.22;

  // ── Iridescence ─────────────────────────────────────────────────────────
  vec3 iridCol = iridescence(N, V, uTime);
  float iridMask = smoothstep(0.20, 0.60, fr) * smoothstep(1.0, 0.60, fr);
  body = mix(body, iridCol, iridMask * uIridStrength * 0.4);

  // ── Rim light (chromatic) ───────────────────────────────────────────────
  vec3 rimCol = mix(uColorA, uColorC, sin(uTime * uGradientSpeed * 0.5) * 0.5 + 0.5);
  float ca = uChromaticStrength;
  float fr_r = pow(1.0 - ndotv, uFresnelPower * (1.0 - ca * 0.3));
  float fr_b = pow(1.0 - ndotv, uFresnelPower * (1.0 + ca * 0.3));
  vec3 chromaRim = vec3(rimCol.r * fr_r, rimCol.g * fr, rimCol.b * fr_b);
  body = mix(body, chromaRim * uRimIntensity, fr * 0.35);

  // ── Center depth glow ───────────────────────────────────────────────────
  body += uColorB * pow(1.0 - fr, 4.5) * 0.12;

  // ── Audio glow ──────────────────────────────────────────────────────────
  body += mix(uColorA, uColorC, fr) * uAudioReactive * 0.18;

  // ── Soft tonemap to prevent blowout ─────────────────────────────────────
  body = body / (1.0 + body * 0.3);

  // ── Alpha ───────────────────────────────────────────────────────────────
  float alpha = mix(0.97, 0.06, pow(fr, 2.0)) * mix(0.85, 1.0, thickness) * uOpacity;

  gl_FragColor = vec4(body * alpha, alpha);
}
