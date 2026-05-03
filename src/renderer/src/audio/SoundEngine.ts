import { AudioManager } from './AudioManager'

export class SoundEngine {
  private audio: AudioManager
  private thinkingNodes: AudioNode[] = []
  private thinkingActive = false
  private cachedImpulse: AudioBuffer | null = null

  constructor(audioManager?: AudioManager) {
    this.audio = audioManager ?? AudioManager.shared()
  }

  private getCtx(): AudioContext {
    return this.audio.getContext()
  }

  // ── Activation chime ────────────────────────────────────────────────────────
  // Two-tone rising shimmer — crystalline, premium
  activation(): void {
    const ctx = this.getCtx()
    const now = ctx.currentTime

    const freqs   = [440, 554.37, 659.25, 880]   // A4 – C#5 – E5 – A5 (A major arpeggio)
    const delays  = [0,   0.04,   0.08,   0.14]

    freqs.forEach((freq, i) => {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      const rev  = this.createReverb(ctx, 0.4)

      osc.type      = 'sine'
      osc.frequency.setValueAtTime(freq * 0.5, now + delays[i])
      osc.frequency.linearRampToValueAtTime(freq, now + delays[i] + 0.05)

      gain.gain.setValueAtTime(0, now + delays[i])
      gain.gain.linearRampToValueAtTime(0.12, now + delays[i] + 0.04)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delays[i] + 0.8)

      osc.connect(gain)
      gain.connect(rev)
      rev.connect(ctx.destination)

      osc.start(now + delays[i])
      osc.stop(now + delays[i] + 0.9)
    })
  }

  // ── Thinking drone ──────────────────────────────────────────────────────────
  // Sub-bass pulse with gentle harmonic shimmer — loops until stopThinking()
  startThinking(): void {
    if (this.thinkingActive) return
    this.thinkingActive = true
    const ctx = this.getCtx()
    const now = ctx.currentTime

    const master = ctx.createGain()
    master.gain.setValueAtTime(0, now)
    master.gain.linearRampToValueAtTime(0.07, now + 0.3)
    master.connect(ctx.destination)

    // Sub oscillator
    const sub = ctx.createOscillator()
    sub.type = 'sine'
    sub.frequency.value = 55   // A1 — deep rumble

    // LFO for slow pulse
    const lfo  = ctx.createOscillator()
    const lfoG = ctx.createGain()
    lfo.frequency.value = 0.6
    lfoG.gain.value     = 8
    lfo.connect(lfoG)
    lfoG.connect(sub.frequency)

    // Harmonic shimmer
    const shimmer = ctx.createOscillator()
    shimmer.type      = 'triangle'
    shimmer.frequency.value = 220

    const shimmerGain = ctx.createGain()
    shimmerGain.gain.value = 0.3
    shimmer.connect(shimmerGain)
    shimmerGain.connect(master)

    sub.connect(master)
    lfo.start()
    shimmer.start()
    sub.start()

    this.thinkingNodes = [sub, lfo, shimmer, master, shimmerGain, lfoG]
  }

  stopThinking(): void {
    if (!this.thinkingActive) return
    this.thinkingActive = false
    const ctx = this.getCtx()
    const now = ctx.currentTime

    const nodes = this.thinkingNodes
    this.thinkingNodes = []

    const master = nodes[3] as GainNode | undefined
    if (master?.gain) {
      try {
        master.gain.setValueAtTime(master.gain.value, now)
        master.gain.linearRampToValueAtTime(0.0001, now + 0.4)
      } catch {}
    }

    setTimeout(() => {
      nodes.forEach(n => {
        try { (n as OscillatorNode).stop?.() } catch {}
        try { n.disconnect() } catch {}
      })
    }, 500)
  }

  // ── Dismiss / done ──────────────────────────────────────────────────────────
  // Soft falling two-tone — gentle closure
  dismiss(): void {
    const ctx = this.getCtx()
    const now = ctx.currentTime

    const pairs = [
      { freq: 659.25, delay: 0    },
      { freq: 440,    delay: 0.12 },
    ]

    pairs.forEach(({ freq, delay }) => {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, now + delay)
      osc.frequency.exponentialRampToValueAtTime(freq * 0.85, now + delay + 0.35)

      gain.gain.setValueAtTime(0.10, now + delay)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.5)

      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + delay)
      osc.stop(now + delay + 0.6)
    })
  }

  // ── Alert pulse ─────────────────────────────────────────────────────────────
  alert(): void {
    const ctx = this.getCtx()
    const now = ctx.currentTime

    for (let i = 0; i < 3; i++) {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'sawtooth'
      osc.frequency.value = 180

      gain.gain.setValueAtTime(0, now + i * 0.18)
      gain.gain.linearRampToValueAtTime(0.08, now + i * 0.18 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.14)

      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + i * 0.18)
      osc.stop(now + i * 0.18 + 0.2)
    }
  }

  private createReverb(ctx: AudioContext, duration: number): ConvolverNode {
    const conv = ctx.createConvolver()

    if (!this.cachedImpulse || this.cachedImpulse.sampleRate !== ctx.sampleRate) {
      const sampleRate = ctx.sampleRate
      const length     = sampleRate * duration
      const impulse    = ctx.createBuffer(2, length, sampleRate)
      for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch)
        for (let i = 0; i < length; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5)
        }
      }
      this.cachedImpulse = impulse
    }

    conv.buffer = this.cachedImpulse
    return conv
  }

  dispose(): void {
    this.stopThinking()
    this.cachedImpulse = null
  }
}
