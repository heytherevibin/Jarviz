import * as THREE from 'three'
import type { OrbState } from './OrbScene'

// ─────────────────────────────────────────────────────────────────────────────
interface PStateConfig {
  minR:    number
  maxR:    number
  colorA:  THREE.Color
  colorB:  THREE.Color
  colorC:  THREE.Color
  speed:   number
  spread:  number
  scatter: number
  opacity: number
  size:    number
  snapK:   number
}

const PC: Record<OrbState, PStateConfig> = {
  idle: {
    minR: 1.25, maxR: 1.60,
    colorA: new THREE.Color('#4285F4'), colorB: new THREE.Color('#A142F4'), colorC: new THREE.Color('#D4A017'),
    speed: 0.10, spread: Math.PI, scatter: 0.10,
    opacity: 0.40, size: 2.4, snapK: 3.5,
  },
  listening: {
    minR: 1.10, maxR: 1.25,
    colorA: new THREE.Color('#EA4335'), colorB: new THREE.Color('#FF6D00'), colorC: new THREE.Color('#FBBC04'),
    speed: 0.45, spread: Math.PI * 0.50, scatter: 0.03,
    opacity: 0.55, size: 2.0, snapK: 8.0,
  },
  thinking: {
    minR: 1.06, maxR: 1.32,
    colorA: new THREE.Color('#A142F4'), colorB: new THREE.Color('#E040FB'), colorC: new THREE.Color('#4285F4'),
    speed: 1.20, spread: Math.PI * 0.28, scatter: 0.06,
    opacity: 0.60, size: 1.8, snapK: 6.0,
  },
  searching: {
    minR: 1.15, maxR: 1.48,
    colorA: new THREE.Color('#34A853'), colorB: new THREE.Color('#00BCD4'), colorC: new THREE.Color('#4285F4'),
    speed: 0.55, spread: Math.PI * 0.20, scatter: 0.04,
    opacity: 0.50, size: 1.9, snapK: 5.5,
  },
  speaking: {
    minR: 1.18, maxR: 1.70,
    colorA: new THREE.Color('#4285F4'), colorB: new THREE.Color('#34A853'), colorC: new THREE.Color('#FBBC04'),
    speed: 0.55, spread: Math.PI * 0.80, scatter: 0.22,
    opacity: 0.50, size: 2.2, snapK: 4.5,
  },
  alert: {
    minR: 1.60, maxR: 2.50,
    colorA: new THREE.Color('#EA4335'), colorB: new THREE.Color('#FF6D00'), colorC: new THREE.Color('#FF1744'),
    speed: 2.20, spread: Math.PI, scatter: 0.40,
    opacity: 0.70, size: 2.8, snapK: 2.0,
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Vertex shader -- per-particle palette color selection via aPhase
// ─────────────────────────────────────────────────────────────────────────────
const PARTICLE_VERT = `
attribute float aPhase;
attribute float aSizeMult;
uniform float uTime;
uniform float uBaseSize;
uniform float uAudio;
varying float vAlpha;
varying float vPhase;

void main() {
  float pulse    = sin(aPhase + uTime * 1.1) * 0.30 + 0.70;
  float audioBump = 1.0 + uAudio * 0.6;
  vAlpha = pulse;
  vPhase = aPhase;

  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uBaseSize * aSizeMult * pulse * audioBump;
  gl_Position  = projectionMatrix * mvPos;
}
`

// ─────────────────────────────────────────────────────────────────────────────
// Fragment shader -- palette-colored circular particles
// ─────────────────────────────────────────────────────────────────────────────
const PARTICLE_FRAG = `
precision mediump float;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;
uniform float uOpacity;
uniform float uTime;
varying float vAlpha;
varying float vPhase;

void main() {
  vec2  uv = gl_PointCoord - 0.5;
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;

  // Pick color from palette based on particle phase
  float t = fract(vPhase * 0.318 + uTime * 0.1);
  vec3 col;
  if (t < 0.333) {
    col = mix(uColorA, uColorB, t * 3.0);
  } else if (t < 0.666) {
    col = mix(uColorB, uColorC, (t - 0.333) * 3.0);
  } else {
    col = mix(uColorC, uColorA, (t - 0.666) * 3.0);
  }

  float alpha  = exp(-r2 * 14.0) * vAlpha * uOpacity;
  col += col * (0.25 - r2) * 2.0;

  gl_FragColor = vec4(col * alpha, alpha);
}
`

// ─────────────────────────────────────────────────────────────────────────────
export class ParticleField {
  private points:    THREE.Points
  private geo:       THREE.BufferGeometry
  private mat:       THREE.ShaderMaterial

  private N:         number = 480

  private px:  Float32Array
  private py:  Float32Array
  private pz:  Float32Array
  private vx:  Float32Array
  private vy:  Float32Array
  private vz:  Float32Array

  private baseTheta: Float32Array
  private basePhi:   Float32Array
  private baseR:     Float32Array
  private phase:     Float32Array
  private sizeMult:  Float32Array

  private state:     OrbState = 'idle'
  private targetCfg: PStateConfig = PC.idle
  private curColorA: THREE.Color = PC.idle.colorA.clone()
  private curColorB: THREE.Color = PC.idle.colorB.clone()
  private curColorC: THREE.Color = PC.idle.colorC.clone()
  private curOpacity = PC.idle.opacity
  private curSize    = PC.idle.size
  private elapsed    = 0

  private audioAmp   = 0

  constructor(parent: THREE.Object3D) {
    const N = this.N

    this.px = new Float32Array(N); this.py = new Float32Array(N); this.pz = new Float32Array(N)
    this.vx = new Float32Array(N); this.vy = new Float32Array(N); this.vz = new Float32Array(N)
    this.baseTheta = new Float32Array(N)
    this.basePhi   = new Float32Array(N)
    this.baseR     = new Float32Array(N)
    this.phase     = new Float32Array(N)
    this.sizeMult  = new Float32Array(N)

    const positions = new Float32Array(N * 3)
    const phases    = new Float32Array(N)
    const sizes     = new Float32Array(N)

    for (let i = 0; i < N; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi   = Math.acos(2 * Math.random() - 1)
      const r     = PC.idle.minR + Math.random() * (PC.idle.maxR - PC.idle.minR)

      this.baseTheta[i] = theta
      this.basePhi[i]   = phi
      this.baseR[i]     = r
      this.phase[i]     = Math.random() * Math.PI * 2
      this.sizeMult[i]  = 0.6 + Math.random() * 0.8

      this.px[i] = Math.sin(phi) * Math.cos(theta) * r
      this.py[i] = Math.cos(phi) * r
      this.pz[i] = Math.sin(phi) * Math.sin(theta) * r

      positions[i * 3]     = this.px[i]
      positions[i * 3 + 1] = this.py[i]
      positions[i * 3 + 2] = this.pz[i]
      phases[i] = this.phase[i]
      sizes[i]  = this.sizeMult[i]
    }

    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('aPhase',   new THREE.BufferAttribute(phases, 1))
    this.geo.setAttribute('aSizeMult',new THREE.BufferAttribute(sizes, 1))

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:     { value: 0 },
        uBaseSize: { value: PC.idle.size },
        uColorA:   { value: PC.idle.colorA.clone() },
        uColorB:   { value: PC.idle.colorB.clone() },
        uColorC:   { value: PC.idle.colorC.clone() },
        uOpacity:  { value: PC.idle.opacity },
        uAudio:    { value: 0 },
      },
      vertexShader:   PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent:    true,
      depthWrite:     false,
      blending:       THREE.AdditiveBlending,
      toneMapped:     false,
    })

    this.points = new THREE.Points(this.geo, this.mat)
    this.points.renderOrder = 3
    parent.add(this.points)
  }

  setState(state: OrbState): void {
    const changed = this.state !== state
    this.state     = state
    this.targetCfg = PC[state]

    if (!changed) return

    const cfg = PC[state]
    this.curColorA.copy(cfg.colorA)
    this.curColorB.copy(cfg.colorB)
    this.curColorC.copy(cfg.colorC)
    this.curOpacity = cfg.opacity
    this.curSize    = cfg.size

    for (let i = 0; i < this.N; i++) {
      this.baseR[i] = cfg.minR + Math.random() * (cfg.maxR - cfg.minR)
    }
  }

  setAudioAmplitude(amp: number): void { this.audioAmp = amp }

  tick(dt: number, elapsed: number): void {
    this.elapsed = elapsed
    const cfg    = this.targetCfg
    const N      = this.N

    const T = Math.min(dt * 12, 1)
    this.curColorA.lerp(cfg.colorA, T)
    this.curColorB.lerp(cfg.colorB, T)
    this.curColorC.lerp(cfg.colorC, T)
    this.curOpacity += (cfg.opacity - this.curOpacity) * T
    this.curSize    += (cfg.size    - this.curSize)    * T

    this.audioAmp *= 0.88
    const audioPush = this.audioAmp * 0.50

    const pos = this.geo.attributes.position as THREE.BufferAttribute

    for (let i = 0; i < N; i++) {
      const tOff  = elapsed * cfg.speed + this.baseTheta[i]
      const phiBase = this.basePhi[i]

      const phiTarget = Math.PI * 0.5
        + (phiBase - Math.PI * 0.5) * (cfg.spread / Math.PI)

      const targetR = this.baseR[i]
        + Math.sin(elapsed * 0.4 + this.phase[i]) * cfg.scatter
        + audioPush

      const tx = Math.sin(phiTarget) * Math.cos(tOff) * targetR
      const ty = Math.cos(phiTarget) * targetR
      const tz = Math.sin(phiTarget) * Math.sin(tOff) * targetR

      const k  = cfg.snapK * dt
      const kc = Math.min(k, 0.95)

      this.px[i] += (tx - this.px[i]) * kc
      this.py[i] += (ty - this.py[i]) * kc
      this.pz[i] += (tz - this.pz[i]) * kc

      pos.setXYZ(i, this.px[i], this.py[i], this.pz[i])
    }

    pos.needsUpdate = true

    ;(this.mat.uniforms.uColorA.value as THREE.Color).copy(this.curColorA)
    ;(this.mat.uniforms.uColorB.value as THREE.Color).copy(this.curColorB)
    ;(this.mat.uniforms.uColorC.value as THREE.Color).copy(this.curColorC)
    this.mat.uniforms.uTime.value     = elapsed
    this.mat.uniforms.uBaseSize.value = this.curSize
    this.mat.uniforms.uOpacity.value  = this.curOpacity
    this.mat.uniforms.uAudio.value    = this.audioAmp
  }

  dispose(): void {
    this.points.removeFromParent()
    this.geo.dispose()
    this.mat.dispose()
  }
}
