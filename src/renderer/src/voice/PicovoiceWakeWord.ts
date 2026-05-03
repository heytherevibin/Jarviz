// Optional Picovoice Porcupine wake-word integration.
// Only activates when PICOVOICE_ACCESS_KEY is provided in the renderer env.
// Uses the built-in "jarvis" keyword (the closest match to Jarviz).
//
// Picovoice Porcupine is far more efficient than the VAD+Whisper fallback —
// it runs entirely in a worker, sub-1% CPU, no Whisper download needed.

import { PorcupineWorker, BuiltInKeyword } from '@picovoice/porcupine-web'
import { WebVoiceProcessor } from '@picovoice/web-voice-processor'

/** Absolute URL beside `index.html` — `/porcupine_params.pv` breaks under `file://` (packaged Electron). */
function porcupineModelPublicPath(): string {
  if (typeof window === 'undefined') return 'porcupine_params.pv'
  try {
    return new URL('porcupine_params.pv', new URL('.', window.location.href)).href
  } catch {
    return 'porcupine_params.pv'
  }
}

export class PicovoiceWakeWord {
  private worker: PorcupineWorker | null = null
  private subscribed = false
  private onWake: (() => void) | null = null

  /** Initialize. Returns true on success, false if disabled / failed. */
  async start(accessKey: string, onWake: () => void): Promise<boolean> {
    if (!accessKey) return false
    this.onWake = onWake

    try {
      this.worker = await PorcupineWorker.create(
        accessKey,
        BuiltInKeyword.Jarvis,
        (detection) => {
          if (detection.label && this.onWake) this.onWake()
        },
        { publicPath: porcupineModelPublicPath() },
        {
          processErrorCallback: (err) => {
            console.warn('[Picovoice] process error:', err)
          },
        },
      )
      await WebVoiceProcessor.subscribe(this.worker)
      this.subscribed = true
      console.log('[Picovoice] Porcupine subscribed (keyword: jarvis)')
      return true
    } catch (e) {
      console.warn('[Picovoice] failed to initialise — falling back to VAD wake word:', (e as Error).message)
      await this.stop()
      return false
    }
  }

  async pause(): Promise<void> {
    if (this.subscribed && this.worker) {
      await WebVoiceProcessor.unsubscribe(this.worker).catch(() => {})
      this.subscribed = false
    }
  }

  async resume(): Promise<void> {
    if (!this.subscribed && this.worker) {
      await WebVoiceProcessor.subscribe(this.worker).catch(() => {})
      this.subscribed = true
    }
  }

  async stop(): Promise<void> {
    await this.pause()
    if (this.worker) {
      try { this.worker.terminate() } catch { /* ignore */ }
      this.worker = null
    }
    this.onWake = null
  }
}
