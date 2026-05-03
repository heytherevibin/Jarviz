// ─────────────────────────────────────────────────────────────────────────────
// 3D Simplex Noise — Ashima Arts / Stefan Gustavson (MIT)
// ─────────────────────────────────────────────────────────────────────────────
vec3 mod289_3(vec3 x){ return x - floor(x*(1./289.))*289.; }
vec4 mod289_4(vec4 x){ return x - floor(x*(1./289.))*289.; }
vec4 permute(vec4 x)  { return mod289_4(((x*34.)+10.)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314*r; }

float snoise(vec3 v){
  const vec2 C = vec2(1./6., 1./3.);
  const vec4 D = vec4(0., .5, 1., 2.);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g  = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289_3(i);
  vec4 p = permute(permute(permute(
    i.z+vec4(0.,i1.z,i2.z,1.))
    +i.y+vec4(0.,i1.y,i2.y,1.))
    +i.x+vec4(0.,i1.x,i2.x,1.));
  float n_ = 0.142857142857;
  vec3  ns = n_*D.wyz - D.xzx;
  vec4 j   = p - 49.*floor(p*ns.z*ns.z);
  vec4 x_  = floor(j*ns.z);
  vec4 y_  = floor(j - 7.*x_);
  vec4 x   = x_*ns.x + ns.yyyy;
  vec4 y   = y_*ns.x + ns.yyyy;
  vec4 h   = 1.0 - abs(x) - abs(y);
  vec4 b0  = vec4(x.xy,y.xy);
  vec4 b1  = vec4(x.zw,y.zw);
  vec4 s0  = floor(b0)*2.+1.;
  vec4 s1  = floor(b1)*2.+1.;
  vec4 sh  = -step(h,vec4(0.));
  vec4 a0  = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1  = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0  = vec3(a0.xy,h.x);
  vec3 p1  = vec3(a0.zw,h.y);
  vec3 p2  = vec3(a1.xy,h.z);
  vec3 p3  = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m = max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
  m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
// ─────────────────────────────────────────────────────────────────────────────

uniform float uTime;
uniform float uNoiseScale;
uniform float uDisplacement;
uniform float uAudioAmplitude;
uniform float uPulse;
uniform float uTurbulence;
uniform float uWarpStrength;

varying vec3  vNormal;
varying vec3  vWorldPos;
varying float vNoise;
varying vec3  vViewDir;
varying vec3  vRawPos;

// ── Domain-Warped Curl Noise ─────────────────────────────────────────────────
float domainWarpedNoise(vec3 p, float s, float t) {
  vec3 q = vec3(
    snoise(p * s + vec3(0.0,  0.0,  0.0) + t * 0.10),
    snoise(p * s + vec3(5.20, 1.30, 2.80) + t * 0.12),
    snoise(p * s + vec3(1.70, 9.20, 6.40) + t * 0.08)
  );

  vec3 r = vec3(
    snoise(p * s + 1.2*q + vec3(1.70, 9.20, 6.40) + t * 0.14),
    snoise(p * s + 1.2*q + vec3(8.30, 2.80, 3.10) + t * 0.11),
    snoise(p * s + 1.2*q + vec3(2.40, 4.10, 7.60) + t * 0.09)
  );

  float base = snoise(p * s + 1.2 * r + t * 0.08);

  float detail = snoise(p * s * 2.3 - t * 0.17) * 0.30
               + snoise(p * s * 4.5 + t * 0.31) * 0.10;

  return base + detail;
}

void main() {
  vec3 p = position;
  float s = uNoiseScale;
  float t = uTime;

  float warpedN = domainWarpedNoise(p, s, t);

  // Turbulence ripple with audio-driven intensity
  float turbMult = 1.0 + uAudioAmplitude * 1.5;
  float ripple = snoise(p * s * 18.0 + t * 0.7) * 0.035 * uTurbulence * turbMult;

  // Directional ripple wave -- propagates outward from center when audio active
  float radial = length(p.xz);
  float rippleWave = sin(radial * 12.0 - t * 6.0) * 0.03 * uAudioAmplitude;

  // Stronger audio-reactive push (0.45 multiplier, directional variation)
  float audioShape = snoise(p * 4.0 + t * 0.5) * 0.5 + 0.5;
  float audioPush = uAudioAmplitude * 0.45 * audioShape;

  // Audio-driven warp speed boost
  float audioWarpBoost = 1.0 + uAudioAmplitude * 0.8;
  float warpedNAudio = domainWarpedNoise(p, s, t * audioWarpBoost);

  float breathe = uPulse * 0.012;

  float warpBlend = mix(0.3, 1.0, uWarpStrength);
  float finalNoise = mix(
    snoise(p * s + t * 0.15) * 0.8,
    mix(warpedN, warpedNAudio, min(uAudioAmplitude * 2.0, 1.0)),
    warpBlend
  );

  float disp = finalNoise * uDisplacement + ripple + rippleWave + audioPush + breathe;

  vec3 displaced = p + normal * disp;

  vec4 worldPos4 = modelMatrix * vec4(displaced, 1.0);

  // Tangent-space finite differences on the base noise term (cheap) + warpBlend scaling
  vec3 N0 = normalize(normal);
  vec3 axisRef = abs(N0.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tanU = normalize(cross(N0, axisRef));
  vec3 tanV = normalize(cross(N0, tanU));
  float hN = 0.024;
  vec3 pU = normalize(p + tanU * hN);
  vec3 pV = normalize(p + tanV * hN);
  vec3 pMu = normalize(p - tanU * hN);
  vec3 pMv = normalize(p - tanV * hN);
  float gU = (snoise(pU * s + t * 0.15) - snoise(pMu * s + t * 0.15)) / max(2.0 * hN, 0.00001);
  float gV = (snoise(pV * s + t * 0.15) - snoise(pMv * s + t * 0.15)) / max(2.0 * hN, 0.00001);
  float bend = uDisplacement * warpBlend * 0.55;
  vec3 nAdj = normalize(N0 + tanU * gU * bend + tanV * gV * bend);
  vNormal   = normalize(normalMatrix * nAdj);
  vWorldPos = worldPos4.xyz;
  vNoise    = finalNoise;
  vViewDir  = normalize(cameraPosition - vWorldPos);
  vRawPos   = position;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
