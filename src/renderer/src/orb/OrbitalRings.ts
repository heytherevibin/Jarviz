// 3D orbital rings — three thin TorusGeometry hoops at different orientations,
// rendered with a holographic shader and color-locked to the orb's rim palette.
// Adds the "JARVIS HUD" depth cue around the central sphere.

import * as THREE from 'three'

const RING_VERT = /* glsl */`
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld  = wp.xyz;
    vNormal = normalize(normalMatrix * normal);
    vView   = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const RING_FRAG = /* glsl */`
  precision highp float;
  uniform vec3  uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uDashFreq;
  uniform float uDashGap;
  uniform float uPulse;
  varying vec2  vUv;
  varying vec3  vNormal;
  varying vec3  vView;

  void main() {
    // Dashed segments along major direction
    float t = vUv.x * uDashFreq - uTime * 0.5;
    float seg = step(uDashGap, fract(t));
    if (seg < 0.5) discard;

    // Soft thickness mask (fade edges of torus tube)
    float edge = smoothstep(0.0, 0.45, vUv.y) * smoothstep(1.0, 0.55, vUv.y);

    // Camera-facing rim glow
    float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.2);

    // Travelling highlight pulse
    float wave = smoothstep(0.0, 0.06, fract(t * 0.34) - 0.94);

    float a = (edge * 0.85 + rim * 0.55 + wave) * uOpacity * (0.85 + uPulse * 0.30);
    vec3 col = uColor + vec3(0.04, 0.05, 0.10) * rim;
    gl_FragColor = vec4(col * a, a);
  }
`

interface RingHandle {
  mesh: THREE.Mesh
  baseRot: THREE.Euler
  spin:    THREE.Vector3
  uniforms: Record<string, THREE.IUniform>
}

export class OrbitalRings {
  private rings: RingHandle[] = []
  private group:  THREE.Group
  private hidden = false

  constructor(parent: THREE.Group, color: THREE.Color) {
    this.group = new THREE.Group()
    parent.add(this.group)

    const cfgs: Array<{ radius: number; tube: number; dashFreq: number; dashGap: number; rot: THREE.Euler; spin: THREE.Vector3; opacity: number }> = [
      { radius: 1.35, tube: 0.014, dashFreq: 60.0, dashGap: 0.35, rot: new THREE.Euler( 0.20,  0.00,  0.10), spin: new THREE.Vector3(0.0, 0.30, 0.0), opacity: 0.85 },
      { radius: 1.55, tube: 0.010, dashFreq: 90.0, dashGap: 0.50, rot: new THREE.Euler( 1.30,  0.40,  0.00), spin: new THREE.Vector3(0.05, 0.0, 0.18), opacity: 0.55 },
      { radius: 1.75, tube: 0.008, dashFreq: 28.0, dashGap: 0.30, rot: new THREE.Euler(-0.55,  1.05,  0.50), spin: new THREE.Vector3(0.10, 0.04, 0.06), opacity: 0.45 },
    ]

    for (const c of cfgs) {
      const geo = new THREE.TorusGeometry(c.radius, c.tube, 12, 256)
      const uniforms: Record<string, THREE.IUniform> = {
        uColor:    { value: color.clone() },
        uOpacity:  { value: c.opacity },
        uTime:     { value: 0 },
        uDashFreq: { value: c.dashFreq },
        uDashGap:  { value: c.dashGap },
        uPulse:    { value: 0 },
      }
      const mat = new THREE.ShaderMaterial({
        vertexShader:   RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms,
        transparent: true,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
        side:        THREE.DoubleSide,
        toneMapped:  false,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.rotation.copy(c.rot)
      mesh.renderOrder = 3 // behind the orb body (orb has renderOrder 4)
      this.group.add(mesh)

      this.rings.push({ mesh, baseRot: c.rot.clone(), spin: c.spin.clone(), uniforms })
    }
  }

  setColor(color: THREE.Color): void {
    for (const r of this.rings) {
      ;(r.uniforms.uColor.value as THREE.Color).copy(color)
    }
  }

  setVisible(v: boolean): void {
    if (this.hidden === !v) return
    this.hidden = !v
    this.group.visible = v
  }

  setIntensity(intensity: number): void {
    // 0..1 — scales opacity uniformly. Used to amp rings during speaking/thinking.
    for (let i = 0; i < this.rings.length; i++) {
      const base = [0.85, 0.55, 0.45][i] ?? 0.5
      this.rings[i].uniforms.uOpacity.value = base * intensity
    }
  }

  tick(dt: number, elapsed: number, pulse: number, audioAmp: number): void {
    if (this.hidden) return
    for (const r of this.rings) {
      r.mesh.rotation.x += r.spin.x * dt
      r.mesh.rotation.y += r.spin.y * dt
      r.mesh.rotation.z += r.spin.z * dt
      r.uniforms.uTime.value  = elapsed
      r.uniforms.uPulse.value = pulse + audioAmp * 0.6
    }
  }

  dispose(): void {
    for (const r of this.rings) {
      r.mesh.removeFromParent()
      r.mesh.geometry.dispose()
      ;(r.mesh.material as THREE.Material).dispose()
    }
    this.rings = []
    this.group.removeFromParent()
  }
}
