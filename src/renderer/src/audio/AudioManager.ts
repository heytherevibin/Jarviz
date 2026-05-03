let instance: AudioManager | null = null

export class AudioManager {
  private ctx: AudioContext | null = null
  private resampleCtx: AudioContext | null = null

  static shared(): AudioManager {
    if (!instance) instance = new AudioManager()
    return instance
  }

  getContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext()
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }
    return this.ctx
  }

  getResamplingContext(sampleRate: number): AudioContext {
    if (
      this.resampleCtx &&
      this.resampleCtx.state !== 'closed' &&
      this.resampleCtx.sampleRate === sampleRate
    ) {
      return this.resampleCtx
    }
    if (this.resampleCtx && this.resampleCtx.state !== 'closed') {
      this.resampleCtx.close().catch(() => {})
    }
    this.resampleCtx = new AudioContext({ sampleRate })
    return this.resampleCtx
  }

  createAnalyser(fftSize = 256): { analyser: AnalyserNode; fft: Uint8Array } {
    const ctx = this.getContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = fftSize
    return { analyser, fft: new Uint8Array(analyser.frequencyBinCount) }
  }

  async decodeAudio(buffer: ArrayBuffer, sampleRate?: number): Promise<AudioBuffer> {
    const ctx = sampleRate ? this.getResamplingContext(sampleRate) : this.getContext()
    return ctx.decodeAudioData(buffer)
  }

  dispose(): void {
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close().catch(() => {})
    }
    if (this.resampleCtx && this.resampleCtx.state !== 'closed') {
      this.resampleCtx.close().catch(() => {})
    }
    this.ctx = null
    this.resampleCtx = null
    instance = null
  }
}
