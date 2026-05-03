import * as THREE from 'three'

// ─────────────────────────────────────────────────────────────────────────────
// Damped spring — semi-implicit Euler integration
// stiffness: how hard it pulls toward target (higher = snappier)
// damping:   friction (lower = more overshoot/oscillation)
//
// Tuning guide:
//   Critical damping (no overshoot): damping = 2 * sqrt(stiffness)
//   Underdamped (satisfying overshoot): damping < 2 * sqrt(stiffness)
//
// Presets:
//   Snappy UI:      stiffness=300, damping=22
//   Orb scale:      stiffness=180, damping=14  ← slight bounce
//   Slow dreamy:    stiffness= 60, damping= 8
//   Glow layer lag: stiffness= 90, damping=12
// ─────────────────────────────────────────────────────────────────────────────
export class Spring {
  value:   number
  private vel = 0

  constructor(
    initial:          number,
    private stiffness = 180,
    private damping   = 14,
  ) {
    this.value = initial
  }

  tick(target: number, dt: number): number {
    const t   = Math.min(dt, 1 / 20)
    const acc = (target - this.value) * this.stiffness - this.vel * this.damping
    this.vel   += acc * t
    this.value += this.vel * t
    return this.value
  }

  snapTo(target: number, fraction = 0.85): void {
    this.value = this.value + (target - this.value) * fraction
    this.vel = 0
  }

  reset(v: number): void { this.value = v; this.vel = 0 }
  isSettled(threshold = 0.001): boolean {
    return Math.abs(this.vel) < threshold && Math.abs(this.value - this.vel) < threshold
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Color spring — three independent springs for R, G, B
// ─────────────────────────────────────────────────────────────────────────────
export class ColorSpring {
  private _r: Spring
  private _g: Spring
  private _b: Spring

  constructor(initial: THREE.Color, stiffness = 120, damping = 16) {
    this._r = new Spring(initial.r, stiffness, damping)
    this._g = new Spring(initial.g, stiffness, damping)
    this._b = new Spring(initial.b, stiffness, damping)
  }

  tick(target: THREE.Color, dt: number, out: THREE.Color): THREE.Color {
    out.r = this._r.tick(target.r, dt)
    out.g = this._g.tick(target.g, dt)
    out.b = this._b.tick(target.b, dt)
    return out
  }

  snapTo(target: THREE.Color, fraction = 0.85): void {
    this._r.snapTo(target.r, fraction)
    this._g.snapTo(target.g, fraction)
    this._b.snapTo(target.b, fraction)
  }

  writeCurrentTo(out: THREE.Color): void {
    out.setRGB(this._r.value, this._g.value, this._b.value)
  }

  reset(v: THREE.Color): void {
    this._r.reset(v.r)
    this._g.reset(v.g)
    this._b.reset(v.b)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vec2 spring — for mouse parallax tracking
// ─────────────────────────────────────────────────────────────────────────────
export class Vec2Spring {
  private sx: Spring
  private sy: Spring

  constructor(x = 0, y = 0, stiffness = 80, damping = 12) {
    this.sx = new Spring(x, stiffness, damping)
    this.sy = new Spring(y, stiffness, damping)
  }

  tick(tx: number, ty: number, dt: number): { x: number; y: number } {
    return { x: this.sx.tick(tx, dt), y: this.sy.tick(ty, dt) }
  }

  reset(x: number, y: number): void { this.sx.reset(x); this.sy.reset(y) }
}
