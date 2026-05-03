import { MicVAD } from '@ricky0123/vad-web'
import { AudioManager } from '../audio/AudioManager'
import { transcribeFloat32 } from './LocalSTT'
import { VAD_DIST_CDN_BASE, vadOnnxWasmBasePath } from './onnxAssets'

const WAKE_PHRASES = [
  'hey jarviz', 'ok jarviz', 'okay jarviz', 'jarviz',
  'hey jarvis', 'ok jarvis', 'okay jarvis', 'jarvis',
]

const WAKE_TARGETS = ['jarvis', 'jarviz']
const MAX_EDIT_DISTANCE = 1
const DEBOUNCE_MS = 500

/** VAD segment sample rate (MicVAD typically 16 kHz). */
const WAKE_SAMPLE_RATE = 16000
const MIN_WAKE_SEC = 0.35
const MAX_WAKE_SEC = 5.5
const MIN_WAKE_RMS = 0.008

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
  return dp[m][n]
}

function isWakeMatch(text: string): boolean {
  const lower = text.toLowerCase().replace(/[^a-z\s]/g, '')
  if (WAKE_PHRASES.some(p => lower.includes(p))) return true
  const words = lower.split(/\s+/).filter(w => w.length >= 4)
  return words.some(word =>
    WAKE_TARGETS.some(target => editDistance(word, target) <= MAX_EDIT_DISTANCE),
  )
}

function extractCommand(text: string): string {
  let t = text.trim()
  for (const phrase of WAKE_PHRASES) {
    const parts = phrase.split(/\s+/)
    const pattern = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[,;.!?\\s]+')
    const re = new RegExp(pattern + '[,;.!?]*\\s*', 'gi')
    t = t.replace(re, '').trim()
  }
  const words = t.split(/\s+/)
  const cleaned = words.filter(w => {
    const stripped = w.toLowerCase().replace(/[^a-z]/g, '')
    if (stripped.length < 4) return true
    return !WAKE_TARGETS.some(target => editDistance(stripped, target) <= MAX_EDIT_DISTANCE)
  })
  return cleaned.join(' ').trim()
}

const ECHO_PEAK_THRESHOLD = 0.35

export class LocalWakeWord {
  private vad: MicVAD | null = null
  private running = false
  private echoSuppressed = false
  private onDetect: ((command: string) => void) | null = null
  private onSpeechBegin: (() => void) | null = null
  private onSpeechDone: (() => void) | null = null
  private lastSpeechEndAt = 0
  private pendingAudio: Float32Array | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  private log(msg: string): void {
    console.log(msg)
    try { (window as unknown as { jarviz?: { log: (m: string) => void } }).jarviz?.log(msg) } catch {}
  }

  async start(
    onDetect: (command: string) => void,
    onSpeechBegin?: () => void,
    onSpeechDone?: () => void,
  ): Promise<boolean> {
    this.onDetect      = onDetect
    this.onSpeechBegin = onSpeechBegin ?? null
    this.onSpeechDone  = onSpeechDone ?? null

    try {
      /** Share app AudioContext so we can `resume()` it; MicVAD's own context often stays suspended in Electron → no VAD frames, no wake. */
      const audioContext = AudioManager.shared().getContext()
      await audioContext.resume().catch(() => {})

      /** Silero + worklet from CDN; ORT wasm from same-origin `public/onnx-wasm` (see electron-vite sync plugin). */
      this.vad = await MicVAD.new({
        baseAssetPath:    VAD_DIST_CDN_BASE,
        onnxWASMBasePath: vadOnnxWasmBasePath(),
        audioContext,
        startOnLoad: false,
        ortConfig: (ort) => {
          ort.env.logLevel = 'error'
          const w = ort.env?.wasm as { numThreads?: number } | undefined
          if (w) w.numThreads = 1
        },

        onSpeechStart: () => {
          if (!this.running) return
          console.log('[WakeWord] speech start')
          this.onSpeechBegin?.()
        },

        onSpeechEnd: (audio: Float32Array) => {
          if (!this.running) return

          const now = Date.now()
          const timeSinceLast = now - this.lastSpeechEndAt
          this.lastSpeechEndAt = now

          if (timeSinceLast < DEBOUNCE_MS && this.debounceTimer) {
            clearTimeout(this.debounceTimer)
          }
          this.pendingAudio = audio

          this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null
            if (this.pendingAudio) {
              this.processAudio(this.pendingAudio)
              this.pendingAudio = null
            }
          }, timeSinceLast < DEBOUNCE_MS ? DEBOUNCE_MS - timeSinceLast : 0)
        },

        onVADMisfire: () => {
          this.onSpeechDone?.()
        },
      })

      this.running = true
      await this.vad.start()
      console.log('[WakeWord] Silero VAD started')
      return true
    } catch (e) {
      console.error('[WakeWord] Silero VAD failed to start:', e)
      this.log(`[WakeWord] error: ${e}`)
      return false
    }
  }

  private async processAudio(audio: Float32Array): Promise<void> {
    try {
      const dur = audio.length / WAKE_SAMPLE_RATE
      if (dur < MIN_WAKE_SEC || dur > MAX_WAKE_SEC) {
        this.onSpeechDone?.()
        return
      }
      let sq = 0
      for (let i = 0; i < audio.length; i++) sq += audio[i] * audio[i]
      const rms = Math.sqrt(sq / audio.length)
      if (rms < MIN_WAKE_RMS) {
        this.onSpeechDone?.()
        return
      }

      const text = await transcribeFloat32(audio, 'en')
      this.log(`[WakeWord] heard: "${text}"`)

      if (isWakeMatch(text)) {
        const command = extractCommand(text)
        this.log(`[WakeWord] MATCH — command: "${command}"`)
        this.onDetect?.(command)
      } else {
        this.onSpeechDone?.()
      }
    } catch (e) {
      console.warn('[WakeWord] transcription error:', e)
      this.onSpeechDone?.()
    }
  }

  setEchoSuppression(enabled: boolean): void {
    this.echoSuppressed = enabled
  }

  async pause(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
      this.pendingAudio = null
    }
    if (this.vad) await this.vad.pause().catch(() => {})
  }

  async resume(): Promise<void> {
    if (!this.vad || !this.running) return
    const ctx = AudioManager.shared().getContext()
    await ctx.resume().catch(() => {})
    try {
      await this.vad.start()
    } catch (e) {
      this.log(`[WakeWord] MicVAD resume failed: ${e}`)
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.pendingAudio = null
    if (this.vad) await this.vad.destroy().catch(() => {})
    this.vad = null
  }
}
