import * as THREE from 'three'
import { Spring, ColorSpring, Vec2Spring } from './Spring'
import { ParticleField } from './ParticleField'
import vertexShader   from './shaders/orb.vert?raw'
import fragmentShader from './shaders/orb.frag?raw'

// ─────────────────────────────────────────────────────────────────────────────
export type OrbState = 'idle' | 'listening' | 'thinking' | 'searching' | 'speaking' | 'alert'

interface StateConfig {
  colorA:    THREE.Color
  colorB:    THREE.Color
  colorC:    THREE.Color
  colorRim:  THREE.Color
  colorVein: THREE.Color
  noiseScale:     number
  displacement:   number
  turbulence:     number
  warpStrength:   number
  fresnelPower:   number
  rimIntensity:   number
  sssStrength:    number
  chromaticStr:   number
  iridStr:        number
  causticStr:     number
  gradientSpeed:  number
  sparkle:        number
  audioMult:      number
  scale:          number
  glowTightScale: number; glowTightOpacity: number
  glowMedScale:   number; glowMedOpacity:   number
  glowWideScale:  number; glowWideOpacity:  number
}

const S: Record<OrbState, StateConfig> = {
  idle: {
    colorA: new THREE.Color('#4285F4'), colorB: new THREE.Color('#A142F4'),
    colorC: new THREE.Color('#D4A017'), colorRim: new THREE.Color('#8AB4F8'),
    colorVein: new THREE.Color('#1A1035'),
    noiseScale: 0.85, displacement: 0.022, turbulence: 0.0, warpStrength: 0.12,
    fresnelPower: 3.6, rimIntensity: 0.78, sssStrength: 0.35,
    chromaticStr: 0.30, iridStr: 0.22, causticStr: 0.22,
    gradientSpeed: 0.28, sparkle: 0.05, audioMult: 1.0,
    scale: 1.00,
    glowTightScale: 1.10, glowTightOpacity: 0.28,
    glowMedScale:   1.22, glowMedOpacity:   0.12,
    glowWideScale:  1.35, glowWideOpacity:  0.05,
  },
  listening: {
    colorA: new THREE.Color('#EA4335'), colorB: new THREE.Color('#FF6D00'),
    colorC: new THREE.Color('#FBBC04'), colorRim: new THREE.Color('#FF8A80'),
    colorVein: new THREE.Color('#2A0A18'),
    noiseScale: 1.00, displacement: 0.045, turbulence: 0.2, warpStrength: 0.25,
    fresnelPower: 2.8, rimIntensity: 0.95, sssStrength: 0.55,
    chromaticStr: 0.55, iridStr: 0.28, causticStr: 0.50,
    gradientSpeed: 0.72, sparkle: 0.26, audioMult: 1.5,
    scale: 1.03,
    glowTightScale: 1.12, glowTightOpacity: 0.40,
    glowMedScale:   1.24, glowMedOpacity:   0.16,
    glowWideScale:  1.36, glowWideOpacity:  0.07,
  },
  thinking: {
    colorA: new THREE.Color('#A142F4'), colorB: new THREE.Color('#E040FB'),
    colorC: new THREE.Color('#4285F4'), colorRim: new THREE.Color('#D7AEFB'),
    colorVein: new THREE.Color('#1A0630'),
    noiseScale: 1.20, displacement: 0.058, turbulence: 0.6, warpStrength: 0.40,
    fresnelPower: 2.4, rimIntensity: 0.95, sssStrength: 0.48,
    chromaticStr: 0.52, iridStr: 0.25, causticStr: 0.55,
    gradientSpeed: 1.05, sparkle: 0.38, audioMult: 1.2,
    scale: 1.02,
    glowTightScale: 1.12, glowTightOpacity: 0.38,
    glowMedScale:   1.25, glowMedOpacity:   0.16,
    glowWideScale:  1.36, glowWideOpacity:  0.07,
  },
  searching: {
    colorA: new THREE.Color('#34A853'), colorB: new THREE.Color('#00BCD4'),
    colorC: new THREE.Color('#4285F4'), colorRim: new THREE.Color('#81C995'),
    colorVein: new THREE.Color('#0A1A14'),
    noiseScale: 0.95, displacement: 0.040, turbulence: 0.3, warpStrength: 0.28,
    fresnelPower: 2.6, rimIntensity: 0.90, sssStrength: 0.50,
    chromaticStr: 0.45, iridStr: 0.20, causticStr: 0.45,
    gradientSpeed: 0.92, sparkle: 0.30, audioMult: 1.0,
    scale: 1.02,
    glowTightScale: 1.11, glowTightOpacity: 0.34,
    glowMedScale:   1.23, glowMedOpacity:   0.14,
    glowWideScale:  1.35, glowWideOpacity:  0.06,
  },
  speaking: {
    colorA: new THREE.Color('#4285F4'), colorB: new THREE.Color('#34A853'),
    colorC: new THREE.Color('#FBBC04'), colorRim: new THREE.Color('#8AB4F8'),
    colorVein: new THREE.Color('#0A1520'),
    noiseScale: 0.90, displacement: 0.055, turbulence: 0.25, warpStrength: 0.24,
    fresnelPower: 3.0, rimIntensity: 0.90, sssStrength: 0.52,
    chromaticStr: 0.48, iridStr: 0.20, causticStr: 0.48,
    gradientSpeed: 1.32, sparkle: 0.42, audioMult: 2.5,
    scale: 1.03,
    glowTightScale: 1.12, glowTightOpacity: 0.36,
    glowMedScale:   1.24, glowMedOpacity:   0.15,
    glowWideScale:  1.36, glowWideOpacity:  0.06,
  },
  alert: {
    colorA: new THREE.Color('#EA4335'), colorB: new THREE.Color('#FF6D00'),
    colorC: new THREE.Color('#FF1744'), colorRim: new THREE.Color('#FF8A80'),
    colorVein: new THREE.Color('#2A0505'),
    noiseScale: 1.40, displacement: 0.075, turbulence: 1.0, warpStrength: 0.50,
    fresnelPower: 1.8, rimIntensity: 1.10, sssStrength: 0.55,
    chromaticStr: 0.55, iridStr: 0.10, causticStr: 0.60,
    gradientSpeed: 1.75, sparkle: 0.52, audioMult: 2.0,
    scale: 1.05,
    glowTightScale: 1.14, glowTightOpacity: 0.46,
    glowMedScale:   1.28, glowMedOpacity:   0.20,
    glowWideScale:  1.38, glowWideOpacity:  0.08,
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Glow sphere helpers -- proven simple single-color approach
// ─────────────────────────────────────────────────────────────────────────────
const GLOW_VERT = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal  = normalize(normalMatrix * normal);
    vec4 wp  = modelMatrix * vec4(position, 1.0);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const makeGlowFrag = (falloff: number) => `
  uniform vec3  uColor;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float fr = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))), ${falloff.toFixed(1)});
    float a = fr * uOpacity;
    gl_FragColor = vec4(uColor * a, a);
  }
`

function makeGlowMesh(
  geo: THREE.BufferGeometry,
  falloff: number,
  color: THREE.Color,
  opacity: number,
): THREE.Mesh {
  return new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: {
      uColor:   { value: color.clone() },
      uOpacity: { value: opacity },
    },
    vertexShader:   GLOW_VERT,
    fragmentShader: makeGlowFrag(falloff),
    transparent: true, depthWrite: false,
    side:    THREE.BackSide,
    blending:THREE.AdditiveBlending,
    toneMapped: false,
  }))
}

const I = S.idle
const CAM_Z = 4.2

// ─────────────────────────────────────────────────────────────────────────────
export class OrbScene {
  private renderer:  THREE.WebGLRenderer
  private scene:     THREE.Scene
  private camera:    THREE.PerspectiveCamera
  private scrim:     THREE.Mesh
  private orbGroup:  THREE.Group
  private orb:       THREE.Mesh
  private glowTight: THREE.Mesh
  private glowMed:   THREE.Mesh
  private glowWide:  THREE.Mesh
  private particles: ParticleField
  private uniforms:  Record<string, THREE.IUniform>
  private clock = new THREE.Clock()
  private rafId:     number = 0
  private onContextLost: (e: Event) => void

  private state:  OrbState    = 'idle'
  private target: StateConfig = S.idle

  private sp = {
    scale:         new Spring(I.scale,           300, 24),
    glowTightScale:new Spring(I.glowTightScale,  250, 22),
    glowMedScale:  new Spring(I.glowMedScale,    200, 20),
    glowWideScale: new Spring(I.glowWideScale,   160, 18),
    glowTightOp:   new Spring(I.glowTightOpacity, 250, 22),
    glowMedOp:     new Spring(I.glowMedOpacity,   200, 20),
    glowWideOp:    new Spring(I.glowWideOpacity,  160, 18),

    noiseScale:    new Spring(I.noiseScale,    300, 24),
    displacement:  new Spring(I.displacement,  300, 24),
    turbulence:    new Spring(I.turbulence,    350, 26),
    warpStrength:  new Spring(I.warpStrength,  250, 22),
    fresnelPower:  new Spring(I.fresnelPower,  300, 24),
    rimIntensity:  new Spring(I.rimIntensity,  300, 24),
    sssStrength:   new Spring(I.sssStrength,   250, 22),
    chromaticStr:  new Spring(I.chromaticStr,  250, 22),
    iridStr:       new Spring(I.iridStr,       250, 22),
    causticStr:    new Spring(I.causticStr,     250, 22),
    gradientSpeed: new Spring(I.gradientSpeed, 300, 24),
    sparkle:       new Spring(I.sparkle,       300, 24),
  }

  private cs = {
    colorA: new ColorSpring(I.colorA,   500, 32),
    colorB: new ColorSpring(I.colorB,   500, 32),
    colorC: new ColorSpring(I.colorC,   500, 32),
    rim:    new ColorSpring(I.colorRim,  500, 32),
    vein:   new ColorSpring(I.colorVein, 400, 28),
  }

  private mouseSpring = new Vec2Spring(0, 0, 75, 11)
  private mouseTarget = { x: 0, y: 0 }

  private pulsePhase = 0
  private audioAmp   = 0

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha:           true,
      antialias:       true,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3))
    // Keep orb window transparent (Siri-like). We handle compositor bleed-through
    // by ensuring other translucent windows are destroyed when hidden.
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.autoClear = false

    this.scene  = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
    this.camera.position.set(0, 0, CAM_Z)

    this.orbGroup = new THREE.Group()
    this.scene.add(this.orbGroup)

    const orbGeo = new THREE.SphereGeometry(1, 256, 256)

    this.uniforms = {
      uTime:             { value: 0 },
      uNoiseScale:       { value: I.noiseScale },
      uDisplacement:     { value: I.displacement },
      uTurbulence:       { value: I.turbulence },
      uWarpStrength:     { value: I.warpStrength },
      uAudioAmplitude:   { value: 0 },
      uPulse:            { value: 0 },
      uColorA:           { value: I.colorA.clone() },
      uColorB:           { value: I.colorB.clone() },
      uColorC:           { value: I.colorC.clone() },
      uColorRim:         { value: I.colorRim.clone() },
      uColorVein:        { value: I.colorVein.clone() },
      uFresnelPower:     { value: I.fresnelPower },
      uRimIntensity:     { value: I.rimIntensity },
      uSSSStrength:      { value: I.sssStrength },
      uOpacity:          { value: 1.0 },
      uChromaticStrength:{ value: I.chromaticStr },
      uIridStrength:     { value: I.iridStr },
      uCausticStrength:  { value: I.causticStr },
      uGradientSpeed:    { value: I.gradientSpeed },
      uSparkle:          { value: I.sparkle },
      uAudioReactive:    { value: 0 },
    }

    // Circular-only vignette drawn in WebGL:
    // - alpha=0 outside circle → window stays “only orb”
    // - tint matches the orb colors so it feels like an extension, not a gray ring
    // - keep radius close to the orb to avoid touching viewport bounds (no flat edges)
    const SCRIM_VERT = `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `
    const SCRIM_FRAG = `
      precision highp float;
      varying vec2 vUv;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform vec3 uColorC;
      uniform float uTime;
      uniform float uGradientSpeed;
      void main() {
        vec2 p = vUv * 2.0 - 1.0; // -1..1
        float d = length(p);

        // Single smooth falloff (no “inner ring / outer ring” banding).
        // d=0 → full glow, d≈r0 → ~0 alpha
        float r0 = 0.52;
        float softness = 0.18;
        float a = smoothstep(r0, r0 - softness, d); // 1 near center, 0 near edge

        // Color extension: slowly drift between the orb palette
        float t = sin(uTime * (0.10 + uGradientSpeed * 0.06)) * 0.5 + 0.5;
        vec3 col = mix(mix(uColorA, uColorB, 0.55), uColorC, t);

        float alpha = 0.42 * a;
        gl_FragColor = vec4(col, alpha);
      }
    `
    this.scrim = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2, 1, 1),
      new THREE.ShaderMaterial({
        vertexShader: SCRIM_VERT,
        fragmentShader: SCRIM_FRAG,
        uniforms: {
          uColorA: this.uniforms.uColorA,
          uColorB: this.uniforms.uColorB,
          uColorC: this.uniforms.uColorC,
          uTime: this.uniforms.uTime,
          uGradientSpeed: this.uniforms.uGradientSpeed,
        },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.NormalBlending,
        toneMapped: false,
      }),
    )
    this.scrim.renderOrder = -100
    this.scene.add(this.scrim)

    this.orb = new THREE.Mesh(orbGeo, new THREE.ShaderMaterial({
      vertexShader, fragmentShader,
      uniforms:    this.uniforms,
      transparent: true, depthWrite: false,
      side:        THREE.FrontSide,
      toneMapped:  false,
      blending:       THREE.CustomBlending,
      blendEquation:  THREE.AddEquation,
      blendSrc:       THREE.OneFactor,
      blendDst:       THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha:  THREE.OneFactor,
      blendDstAlpha:  THREE.OneMinusSrcAlphaFactor,
    }))
    this.orb.renderOrder = 4

    const glowGeoWide  = new THREE.SphereGeometry(1, 64, 64)
    const glowGeoMed   = new THREE.SphereGeometry(1, 64, 64)
    const glowGeoTight = new THREE.SphereGeometry(1, 64, 64)
    this.glowWide  = makeGlowMesh(glowGeoWide,  1.4, I.colorA,   I.glowWideOpacity)
    this.glowMed   = makeGlowMesh(glowGeoMed,   2.4, I.colorRim, I.glowMedOpacity)
    this.glowTight = makeGlowMesh(glowGeoTight, 3.8, I.colorRim, I.glowTightOpacity)
    this.glowWide.renderOrder  = 0
    this.glowMed.renderOrder   = 1
    this.glowTight.renderOrder  = 2
    // Remove glow shells (they can read as a broken outer ring on some displays).
    this.glowWide.visible = false
    this.glowMed.visible = false
    this.glowTight.visible = false

    this.particles = new ParticleField(this.orbGroup)

    this.orbGroup.add(this.orb)

    this.onContextLost = (e: Event) => {
      e.preventDefault()
      console.warn('[OrbScene] WebGL context lost (will recover if possible)')
    }
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost, false)

    const iw = Math.max(1, canvas.clientWidth || Math.round(canvas.getBoundingClientRect().width) || 300)
    const ih = Math.max(1, canvas.clientHeight || Math.round(canvas.getBoundingClientRect().height) || 300)
    this.resize(iw, ih)
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setState(state: OrbState): void {
    const changed = this.state !== state
    this.state  = state
    this.target = S[state]
    this.particles.setState(state)

    if (!changed) return

    const tgt = this.target

    this.cs.colorA.snapTo(tgt.colorA, 0.85)
    this.cs.colorB.snapTo(tgt.colorB, 0.85)
    this.cs.colorC.snapTo(tgt.colorC, 0.85)
    this.cs.rim.snapTo(tgt.colorRim, 0.85)
    this.cs.vein.snapTo(tgt.colorVein, 0.85)

    this.sp.noiseScale.snapTo(tgt.noiseScale, 0.85)
    this.sp.displacement.snapTo(tgt.displacement, 0.85)
    this.sp.turbulence.snapTo(tgt.turbulence, 0.85)
    this.sp.warpStrength.snapTo(tgt.warpStrength, 0.85)
    this.sp.fresnelPower.snapTo(tgt.fresnelPower, 0.85)
    this.sp.rimIntensity.snapTo(tgt.rimIntensity, 0.85)
    this.sp.sssStrength.snapTo(tgt.sssStrength, 0.85)
    this.sp.chromaticStr.snapTo(tgt.chromaticStr, 0.85)
    this.sp.iridStr.snapTo(tgt.iridStr, 0.85)
    this.sp.causticStr.snapTo(tgt.causticStr, 0.85)
    this.sp.gradientSpeed.snapTo(tgt.gradientSpeed, 0.85)
    this.sp.sparkle.snapTo(tgt.sparkle, 0.85)
    this.sp.scale.snapTo(tgt.scale, 0.85)
    this.sp.glowTightScale.snapTo(tgt.glowTightScale, 0.85)
    this.sp.glowMedScale.snapTo(tgt.glowMedScale, 0.85)
    this.sp.glowWideScale.snapTo(tgt.glowWideScale, 0.85)
    this.sp.glowTightOp.snapTo(tgt.glowTightOpacity, 0.85)
    this.sp.glowMedOp.snapTo(tgt.glowMedOpacity, 0.85)
    this.sp.glowWideOp.snapTo(tgt.glowWideOpacity, 0.85)

    this.cs.colorA.writeCurrentTo(this.uniforms.uColorA.value as THREE.Color)
    this.cs.colorB.writeCurrentTo(this.uniforms.uColorB.value as THREE.Color)
    this.cs.colorC.writeCurrentTo(this.uniforms.uColorC.value as THREE.Color)
    this.cs.rim.writeCurrentTo(this.uniforms.uColorRim.value as THREE.Color)
    this.cs.vein.writeCurrentTo(this.uniforms.uColorVein.value as THREE.Color)

    const rimCol = this.uniforms.uColorRim.value as THREE.Color
    const colA   = this.uniforms.uColorA.value as THREE.Color
    const tMat = this.glowTight.material as THREE.ShaderMaterial
    const mMat = this.glowMed.material   as THREE.ShaderMaterial
    const wMat = this.glowWide.material  as THREE.ShaderMaterial
    ;(tMat.uniforms.uColor.value as THREE.Color).copy(rimCol)
    ;(mMat.uniforms.uColor.value as THREE.Color).copy(rimCol)
    ;(wMat.uniforms.uColor.value as THREE.Color).copy(colA)
  }

  getState(): OrbState { return this.state }

  setAudioAmplitude(amp: number): void {
    this.audioAmp = Math.max(0, Math.min(1, amp))
    this.particles.setAudioAmplitude(amp)
  }

  setMousePosition(nx: number, ny: number): void {
    this.mouseTarget.x = nx
    this.mouseTarget.y = ny
  }

  resize(w: number, h: number): void {
    const cw = Math.max(1, Math.round(Number.isFinite(w) ? w : 1))
    const ch = Math.max(1, Math.round(Number.isFinite(h) ? h : 1))
    this.renderer.setSize(cw, ch, false)
    this.camera.aspect = cw / ch
    this.camera.updateProjectionMatrix()
  }

  start(): void {
    this.clock.start()
    const loop = () => {
      this.rafId = requestAnimationFrame(loop)
      const dt      = this.clock.getDelta()
      const elapsed = this.clock.elapsedTime
      this.tick(dt, elapsed)
      // Always clear the full drawing buffer. In transparent Electron windows on macOS,
      // failing to fully clear can leave "stale" GPU pixels that look like ghost rectangles.
      this.renderer.setClearColor(0x000000, 0)
      this.renderer.clear(true, true, true)
      this.renderer.render(this.scene, this.camera)
    }
    loop()
  }

  stop(): void { cancelAnimationFrame(this.rafId) }

  dispose(): void {
    this.stop()
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost, false)

    this.particles.dispose()

    const disposeMesh = (mesh: THREE.Mesh): void => {
      mesh.removeFromParent()
      mesh.geometry.dispose()
      const m = mesh.material as THREE.Material | THREE.Material[]
      if (Array.isArray(m)) m.forEach(x => x.dispose())
      else m.dispose()
    }

    disposeMesh(this.glowWide)
    disposeMesh(this.glowMed)
    disposeMesh(this.glowTight)
    disposeMesh(this.orb)
    disposeMesh(this.scrim)

    this.scene.remove(this.orbGroup)
    this.renderer.dispose()
  }

  // ── Internal tick ──────────────────────────────────────────────────────────

  private tick(dt: number, elapsed: number): void {
    const tgt = this.target

    this.pulsePhase += dt * (this.state === 'idle' ? 0.65 : 1.35)
    const pulse  = Math.sin(this.pulsePhase) * 0.5 + 0.5
    const slowP  = Math.sin(this.pulsePhase * 0.28) * 0.5 + 0.5

    this.audioAmp *= 0.88

    const sp = this.sp
    const ns  = sp.noiseScale.tick(tgt.noiseScale,   dt)
    const dp  = sp.displacement.tick(tgt.displacement, dt)
    const tb  = sp.turbulence.tick(tgt.turbulence,    dt)
    const ws  = sp.warpStrength.tick(tgt.warpStrength, dt)
    const fp  = sp.fresnelPower.tick(tgt.fresnelPower, dt)
    const ri  = sp.rimIntensity.tick(tgt.rimIntensity, dt)
    const ss  = sp.sssStrength.tick(tgt.sssStrength,   dt)
    const ca  = sp.chromaticStr.tick(tgt.chromaticStr, dt)
    const ir  = sp.iridStr.tick(tgt.iridStr,           dt)
    const cau = sp.causticStr.tick(tgt.causticStr,     dt)
    const gs  = sp.gradientSpeed.tick(tgt.gradientSpeed, dt)
    const spk = sp.sparkle.tick(tgt.sparkle,           dt)

    this.cs.colorA.tick(tgt.colorA, dt, this.uniforms.uColorA.value    as THREE.Color)
    this.cs.colorB.tick(tgt.colorB, dt, this.uniforms.uColorB.value    as THREE.Color)
    this.cs.colorC.tick(tgt.colorC, dt, this.uniforms.uColorC.value    as THREE.Color)
    this.cs.rim.tick(tgt.colorRim,  dt, this.uniforms.uColorRim.value  as THREE.Color)
    this.cs.vein.tick(tgt.colorVein, dt, this.uniforms.uColorVein.value as THREE.Color)

    const audioReactive = this.audioAmp * tgt.audioMult

    const U = this.uniforms
    U.uTime.value             = elapsed * ns * 0.50
    U.uNoiseScale.value       = ns
    U.uDisplacement.value     = dp + audioReactive * 0.015
    U.uTurbulence.value       = tb + audioReactive * 0.3
    U.uWarpStrength.value     = ws
    U.uAudioAmplitude.value   = this.audioAmp
    U.uPulse.value            = pulse
    U.uFresnelPower.value     = fp
    U.uRimIntensity.value     = ri
    U.uSSSStrength.value      = ss
    U.uChromaticStrength.value = ca
    U.uIridStrength.value     = ir
    U.uCausticStrength.value  = cau
    U.uGradientSpeed.value    = gs + audioReactive * 0.5
    U.uSparkle.value          = spk + audioReactive * 0.3
    U.uAudioReactive.value    = audioReactive

    const audioBreath = audioReactive * 0.04
    const orbS = sp.scale.tick(tgt.scale + pulse * 0.013 + audioBreath, dt)
    this.orb.scale.setScalar(orbS)

    const mouse = this.mouseSpring.tick(this.mouseTarget.x, this.mouseTarget.y, dt)
    this.orbGroup.rotation.y =  mouse.x * 0.18
    this.orbGroup.rotation.x = -mouse.y * 0.12

    this.glowTight.position.set(-mouse.x * 0.018, -mouse.y * 0.012, 0)
    this.glowMed.position.set(  -mouse.x * 0.042, -mouse.y * 0.028, 0)
    this.glowWide.position.set( -mouse.x * 0.085, -mouse.y * 0.058, 0)

    const curRim = this.uniforms.uColorRim.value as THREE.Color
    const curA   = this.uniforms.uColorA.value   as THREE.Color

    const glowAudioBoost = 1.0 + audioReactive * 0.60

    // Max glow scale = 1.40 to stay within camera frustum (FOV 38° at z=4.2 → ±1.45 visible)
    const MAX_GLOW = 1.40
    const tScale  = Math.min(sp.glowTightScale.tick(tgt.glowTightScale + pulse * 0.012 + audioBreath, dt), MAX_GLOW)
    const mScale  = Math.min(sp.glowMedScale.tick(  tgt.glowMedScale   + pulse * 0.018 + audioBreath * 2, dt), MAX_GLOW)
    const wScale  = Math.min(sp.glowWideScale.tick( tgt.glowWideScale   + slowP * 0.025 + audioBreath * 2, dt), MAX_GLOW)
    const tOp     = sp.glowTightOp.tick(tgt.glowTightOpacity * (0.80 + pulse * 0.20) * glowAudioBoost, dt)
    const mOp     = sp.glowMedOp.tick(  tgt.glowMedOpacity   * (0.75 + pulse * 0.25) * glowAudioBoost, dt)
    const wOp     = sp.glowWideOp.tick( tgt.glowWideOpacity   * (0.60 + slowP * 0.40) * glowAudioBoost, dt)

    this.glowTight.scale.setScalar(tScale)
    this.glowMed.scale.setScalar(mScale)
    this.glowWide.scale.setScalar(wScale)

    const tMat = this.glowTight.material as THREE.ShaderMaterial
    const mMat = this.glowMed.material   as THREE.ShaderMaterial
    const wMat = this.glowWide.material  as THREE.ShaderMaterial
    ;(tMat.uniforms.uColor.value as THREE.Color).copy(curRim)
    ;(mMat.uniforms.uColor.value as THREE.Color).copy(curRim)
    ;(wMat.uniforms.uColor.value as THREE.Color).copy(curA)
    tMat.uniforms.uOpacity.value = tOp
    mMat.uniforms.uOpacity.value = mOp
    wMat.uniforms.uOpacity.value = wOp

    this.particles.tick(dt, elapsed)
  }
}
