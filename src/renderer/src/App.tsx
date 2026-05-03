import { useEffect, useRef, useCallback, useState, type CSSProperties } from 'react'
import { OrbScene, OrbState } from './orb/OrbScene'
import { SoundEngine } from './audio/SoundEngine'
import { AudioManager } from './audio/AudioManager'
import { loadWhisper, transcribeBlob } from './voice/LocalSTT'
import { LocalWakeWord } from './voice/LocalWakeWord'
import { PicovoiceWakeWord } from './voice/PicovoiceWakeWord'
import { speakLocal, stopLocalSpeech, isSpeakingLocal } from './voice/LocalTTS'
import { JarvizFSM, JarvizState } from './state/JarvizFSM'



const rlog = (msg: string) => {
  console.log(msg)
  try { window.jarviz?.log(msg) } catch {}
}

const PHASE_LABEL: Record<JarvizState, string> = {
  idle:         'Ready',
  listening:    'Listening…',
  transcribing: 'Transcribing…',
  thinking:     'Thinking…',
  speaking:     'Speaking…',
  followUp:     'Listening for follow-up…',
  error:        'Error',
}

const WHISPER_HALLUCINATIONS = [
  'thanks for watching', 'thank you for watching', 'subscribe',
  'like and subscribe', 'blank_audio', 'silence', 'you',
  'thank you', 'bye', 'goodbye',
]

function isNoiseTranscript(raw: string): boolean {
  const cleaned = raw.trim()
    .replace(/^\(.*\)$/, '')
    .replace(/^[\s.,!?]+|[\s.,!?]+$/g, '')
  if (!cleaned) return true
  if (/(.)\1{5,}/.test(cleaned)) return true
  const words = cleaned.split(/\s+/)
  if (new Set(words).size <= 2 && words.length > 4) return true
  const lower = cleaned.toLowerCase()
  return WHISPER_HALLUCINATIONS.some(h => lower === h || lower === `[${h}]`)
}

// ── Map FSM states to orb visual states ──────────────────────────────────────
const FSM_TO_ORB: Record<JarvizState, OrbState> = {
  idle:         'idle',
  listening:    'listening',
  transcribing: 'thinking',
  thinking:     'thinking',
  speaking:     'speaking',
  followUp:     'listening',
  error:        'alert',
}

/* Viewport-fixed shell + HUD: inline styles only — avoids Electron translucent-window /
 * backdrop-filter compositor bugs that paint the status panel across the entire surface. */
const shellStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  margin: 0,
  padding: 0,
  overflow: 'hidden',
  cursor: 'grab',
  touchAction: 'none',
}

const canvasStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  margin: 0,
  padding: 0,
  display: 'block',
  width: '100%',
  height: '100%',
  zIndex: 0,
  background: 'transparent',
}

const hudWrapStyle: CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: 16,
  transform: 'translateX(-50%)',
  zIndex: 60,
  maxWidth: 'min(440px, calc(100vw - 24px))',
  width: 'max-content',
  minWidth: 0,
  maxHeight: 'min(140px, 38vh)',
  overflow: 'hidden',
  pointerEvents: 'none',
  boxSizing: 'border-box',
  contain: 'strict',
}

const hudCardStyle: CSSProperties = {
  maxWidth: 'min(440px, calc(100vw - 24px))',
  boxSizing: 'border-box',
  padding: '10px 14px 12px',
  borderRadius: 14,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'linear-gradient(165deg, rgba(14,18,28,0.88), rgba(8,10,18,0.94))',
  backdropFilter: 'blur(18px) saturate(140%)',
  WebkitBackdropFilter: 'blur(18px) saturate(140%)',
  boxShadow: '0 18px 44px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)',
  fontFamily: '"SF Pro Display", "Inter", system-ui, -apple-system, Segoe UI, sans-serif',
  fontSize: 12,
  lineHeight: 1.4,
  color: 'rgba(240,242,248,0.97)',
  textAlign: 'left',
  position: 'relative',
}

const hudPhaseRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 6,
}

const hudDotStyle = (color: string): CSSProperties => ({
  width: 7, height: 7, borderRadius: '50%',
  background: color,
  boxShadow: `0 0 8px ${color}, 0 0 14px ${color}77`,
  flexShrink: 0,
})

const hudPhaseStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: 9.5,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: 'rgba(255,255,255,0.92)',
  flex: 1,
}

const hudRowStyle: CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  opacity: 0.93,
  fontSize: 12.5,
  fontWeight: 400,
  letterSpacing: '0.005em',
}

const hudLabelStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: 9,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  marginRight: 8,
  display: 'inline-block',
  padding: '1px 6px',
  borderRadius: 4,
  verticalAlign: 'middle',
  opacity: 0.85,
}

const STATE_DOT_COLOR: Record<JarvizState, string> = {
  idle:         '#8AB4F8',
  listening:    '#FF8A80',
  transcribing: '#A8D8B9',
  thinking:     '#D7AEFB',
  speaking:     '#FBD688',
  followUp:     '#8AB4F8',
  error:        '#F28B82',
}

// ── Recording config per context ─────────────────────────────────────────────
const RECORD_OPTS = {
  normal:   { maxDurationMs: 15000, silenceMs: 1400, speechThreshold: 8 },
  followUp: { maxDurationMs: 15000, silenceMs: 1200, waitForSpeechMs: 5000, speechThreshold: 12 },
}

/** Match main process [`MIN_ORB_SIZE`/`MAX_ORB_SIZE`](src/main/index.ts) for hit-test vs visual scale. */
const ORB_SIZE_MIN = 160
const ORB_SIZE_MAX = 600

interface RecordOptions {
  maxDurationMs?: number
  silenceMs?: number
  waitForSpeechMs?: number
  speechThreshold?: number
}

function recordUntilSilence(opts: RecordOptions = {}): Promise<Blob | null> {
  const maxDuration    = opts.maxDurationMs ?? 15000
  const silenceTimeout = opts.silenceMs ?? 1400
  const waitForSpeech  = opts.waitForSpeechMs ?? maxDuration
  const threshold      = opts.speechThreshold ?? 8

  return new Promise(async (resolve) => {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      rlog('[Recorder] mic open')
    } catch (e) {
      rlog(`[Recorder] mic denied: ${e}`)
      resolve(null)
      return
    }

    const ctx      = new AudioContext()
    const src      = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    src.connect(analyser)
    const fft = new Uint8Array(analyser.frequencyBinCount)

    const chunks: Blob[] = []
    let dismissed = false
    const rec = new MediaRecorder(stream)
    rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }

    const cleanup = () => {
      stream.getTracks().forEach(t => t.stop())
      if (ctx.state !== 'closed') ctx.close().catch(() => {})
    }

    rec.onstop = () => {
      cleanup()
      if (dismissed || !chunks.length) { resolve(null); return }
      resolve(new Blob(chunks, { type: 'audio/webm' }))
    }
    rec.start(100)
    rlog('[Recorder] recording — speak now')

    let spoken = false, silStart = 0, intervalId = 0
    const startedAt = Date.now()
    const maxT = setTimeout(() => { clearInterval(intervalId); rec.stop() }, maxDuration)

    const check = () => {
      analyser.getByteFrequencyData(fft)
      const avg = fft.reduce((a, b) => a + b, 0) / fft.length
      if (avg > threshold) { spoken = true; silStart = 0 }
      else if (spoken) {
        if (!silStart) silStart = Date.now()
        if (Date.now() - silStart > silenceTimeout) {
          clearTimeout(maxT); clearInterval(intervalId); rec.stop(); return
        }
      } else if (Date.now() - startedAt > waitForSpeech) {
        rlog('[Recorder] no speech detected — dismissing')
        dismissed = true
        clearTimeout(maxT); clearInterval(intervalId); rec.stop(); return
      }
    }
    intervalId = window.setInterval(check, 80)
  })
}

// ── MP3/WAV playback with live amplitude ─────────────────────────────────────
function playAudioReactive(
  bytes: number[],
  mime: string,
  setAmp: (v: number) => void,
  onEnd: () => void,
): { stop: () => void } {
  let cleaned = false
  let raf = 0
  let el: HTMLAudioElement | null = null
  let ctx: AudioContext | null = null
  let url: string | null = null

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    cancelAnimationFrame(raf)
    setAmp(0)
    if (el) { el.pause(); el.onended = null; el.onerror = null }
    if (url) URL.revokeObjectURL(url)
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {})
    onEnd()
  }

  try {
    const blob = new Blob([new Uint8Array(bytes)], { type: mime || 'audio/mpeg' })
    url = URL.createObjectURL(blob)
    el  = new Audio(url)
    el.crossOrigin = 'anonymous'

    ctx = new AudioContext()
    const src      = ctx.createMediaElementSource(el)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.78
    src.connect(analyser)
    analyser.connect(ctx.destination)

    const fft = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteFrequencyData(fft)
      let s = 0
      for (let i = 0; i < fft.length; i++) s += fft[i]
      setAmp(Math.min(1, (s / fft.length) / 255 * 1.6))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    el.onended = cleanup
    el.onerror = cleanup
    el.play().catch(cleanup)
  } catch {
    setAmp(0)
    onEnd()
  }

  return { stop: cleanup }
}

// ── Streaming chunk-queue player ─────────────────────────────────────────────
// Manages a queue of speech chunks arriving over IPC. Plays them in order,
// driving the orb amplitude live for each chunk. Falls back to Web Speech for
// chunks that have no audio bytes attached.
class StreamingPlayer {
  private queue: Array<{ text: string; audio: number[] | null; mime: string | null; isFinal: boolean }> = []
  private playing  = false
  private stopped  = false
  private current: { stop: () => void } | null = null
  private webSpeechCleanup: (() => void) | null = null
  private finalEnqueued = false
  private sawAudio = false

  constructor(
    private setAmp:  (v: number) => void,
    private onAllDone: () => void,
  ) {}

  enqueue(chunk: { text: string; audio: number[] | null; audioMime: string | null; isFinal: boolean }): void {
    if (this.stopped) return
    if (chunk.isFinal) this.finalEnqueued = true
    this.queue.push({ text: chunk.text, audio: chunk.audio, mime: chunk.audioMime, isFinal: chunk.isFinal })
    if (!this.playing) this.playNext()
  }

  private playNext(): void {
    if (this.stopped) return
    const next = this.queue.shift()
    if (!next) {
      this.playing = false
      // If the final chunk has been enqueued AND drained, we're done
      if (this.finalEnqueued) {
        this.setAmp(0)
        this.onAllDone()
      }
      return
    }
    this.playing = true
    const onChunkEnd = (): void => { this.current = null; this.playNext() }

    if (next.audio && next.audio.length > 0) {
      this.sawAudio = true
      this.current = playAudioReactive(next.audio, next.mime || 'audio/mpeg', this.setAmp, onChunkEnd)
    } else {
      // If we're already playing real audio for this reply, don't mix voices by falling back to Web Speech.
      // Instead, advance after an estimated duration so follow-up timing stays natural.
      if (this.sawAudio) {
        const words = next.text.trim().split(/\s+/).filter(Boolean).length
        const ms = Math.max(200, Math.min(3000, Math.round((words / 2.8) * 1000)))
        window.setTimeout(onChunkEnd, ms)
        return
      }
      // No audio bytes and no TTS backend configured — use Web Speech consistently for the whole reply.
      const env = startSpeechEnvelope(this.setAmp)
      this.webSpeechCleanup = () => { env(); stopLocalSpeech() }
      speakLocal(next.text, () => { env(); this.webSpeechCleanup = null; onChunkEnd() })
    }
  }

  stop(): void {
    this.stopped = true
    this.queue = []
    if (this.current) { this.current.stop(); this.current = null }
    if (this.webSpeechCleanup) { this.webSpeechCleanup(); this.webSpeechCleanup = null }
    this.setAmp(0)
  }
}

// ── Web Speech TTS amplitude envelope ────────────────────────────────────────
function startSpeechEnvelope(setAmp: (v: number) => void): () => void {
  let raf = 0
  let phase = 0
  const tick = () => {
    if (!isSpeakingLocal()) { setAmp(0); return }
    phase += 0.18
    const base   = 0.28 + 0.18 * Math.sin(phase)
    const jitter = (Math.random() - 0.5) * 0.10
    setAmp(Math.max(0, Math.min(0.85, base + jitter)))
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => { cancelAnimationFrame(raf); setAmp(0) }
}

export default function App() {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const sceneRef     = useRef<OrbScene | null>(null)
  const soundRef     = useRef(new SoundEngine())
  const fsmRef       = useRef<JarvizFSM | null>(null)
  const rafRef       = useRef(0)
  const analyserRef  = useRef<AnalyserNode | null>(null)
  const fftRef       = useRef<Uint8Array | null>(null)
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null)
  const wakeWordRef  = useRef<LocalWakeWord | null>(null)
  const picoRef      = useRef<PicovoiceWakeWord | null>(null)
  const stopPlaybackRef = useRef<(() => void) | null>(null)
  const followUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [caption, setCaption] = useState({ phase: 'Ready', user: '', reply: '' })
  const [updateBanner, setUpdateBanner] = useState<{ state: string; progress?: number; message?: string } | null>(null)
  const [hudAmp, setHudAmp]   = useState(0)
  const hudAmpRef = useRef(0)
  const hudAmpRafRef = useRef<number | null>(null)
  const lastHudAmpCommitRef = useRef(0)
  const [bootTs] = useState(() => Date.now())
  const [uptime, setUptime] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setUptime(Date.now() - bootTs), 500)
    return () => clearInterval(id)
  }, [bootTs])

  // Throttle panel relays to ~10 Hz max — avoids IPC spam during rapid FSM changes
  const lastRelayRef = useRef({ state: 0, caption: 0 })
  const relayState = useCallback((s: string): void => {
    const now = Date.now()
    if (now - lastRelayRef.current.state < 80) return
    lastRelayRef.current.state = now
    try { window.jarviz?.relayState?.(s) } catch { /* noop */ }
  }, [])
  const relayCaption = useCallback((c: { phase: string; user: string; reply: string }): void => {
    const now = Date.now()
    if (now - lastRelayRef.current.caption < 100) return
    lastRelayRef.current.caption = now
    try { window.jarviz?.relayCaption?.(c) } catch { /* noop */ }
  }, [])

  const setOrbAmp = useCallback((v: number) => {
    // Keep the orb shader/audio reactive path fully real-time.
    sceneRef.current?.setAudioAmplitude(v)

    // Avoid per-frame React re-renders (can stutter WebGL in Electron).
    // Smooth in a ref, then commit to state at ~30fps.
    hudAmpRef.current = hudAmpRef.current * 0.78 + v * 0.22
    if (hudAmpRafRef.current != null) return
    hudAmpRafRef.current = requestAnimationFrame(() => {
      hudAmpRafRef.current = null
      const now = performance.now()
      if (now - lastHudAmpCommitRef.current < 33) return
      lastHudAmpCommitRef.current = now
      setHudAmp(hudAmpRef.current)
    })
  }, [])

  // Mic-driven idle amplitude (muted during speaking via FSM state check)
  const driveAudio = useCallback(() => {
    const fsm = fsmRef.current
    if (fsm && fsm.state !== 'speaking') {
      const a = analyserRef.current; const f = fftRef.current
      if (a && f) {
        a.getByteFrequencyData(f as any)
        let s = 0; for (let i = 0; i < f.length; i++) s += f[i]
        sceneRef.current?.setAudioAmplitude((s / f.length) / 255)
      }
    }
    rafRef.current = requestAnimationFrame(driveAudio)
  }, [])

  // ── Phase handlers — triggered by FSM state transitions ────────────────────

  const handleListening = useCallback(async (fsm: JarvizFSM) => {
    await wakeWordRef.current?.pause().catch(() => {})
    const isFollowUp = fsm.context.turnCount > 0
    const wakeCommand = fsm.context.wakeCommand

    if (wakeCommand) {
      rlog(`[Listen] wake word command: "${wakeCommand}"`)
      fsm.clearWakeCommand()
      fsm.send({ type: 'TRANSCRIPT_READY', text: wakeCommand })
      return
    }

    const opts = isFollowUp ? RECORD_OPTS.followUp : RECORD_OPTS.normal
    const blob = await recordUntilSilence(opts)

    if (!blob || blob.size < 1000) {
      rlog(`[Listen] no audio captured${isFollowUp ? ' — ending conversation' : ''}`)
      fsm.send({ type: 'NO_AUDIO' })
      return
    }

    rlog(`[Listen] recorded ${blob.size} bytes`)
    fsm.send({ type: 'AUDIO_CAPTURED', blob })
  }, [])

  const handleTranscribing = useCallback(async (fsm: JarvizFSM, blob: Blob) => {
    try {
      const transcript = await transcribeBlob(blob)
      rlog(`[STT] "${transcript}"`)

      if (isNoiseTranscript(transcript)) {
        rlog(`[STT] noise/hallucination: "${transcript.slice(0, 60)}"`)
        speakLocal("I didn't catch that. Try again.", () => {})
        fsm.send({ type: 'NOISE_DETECTED' })
        return
      }

      fsm.send({ type: 'TRANSCRIPT_READY', text: transcript })
    } catch (e) {
      rlog(`[STT] error: ${e}`)
      fsm.send({ type: 'STT_FAILED' })
    }
  }, [])

  const handleThinking = useCallback(async (fsm: JarvizFSM) => {
    const transcript = fsm.context.transcript
    rlog(`[Agent] querying: "${transcript.slice(0, 80)}"`)

    try {
      const result = await window.jarviz.agent.query(transcript)
      rlog(`[Agent] text="${result?.text?.slice(0, 80)}" audio=${!!result?.audio}`)

      const text = result?.text ?? 'I had trouble processing that. Please try again.'
      fsm.send({ type: 'RESPONSE_READY', text, audio: result?.audio ?? null, audioMime: result?.audioMime ?? null })
    } catch (e) {
      rlog(`[Agent] error: ${e}`)
      fsm.send({ type: 'AGENT_FAILED', message: String(e) })
    }
  }, [])

  const streamingPlayerRef = useRef<StreamingPlayer | null>(null)

  const handleSpeaking = useCallback((fsm: JarvizFSM) => {
    const { replyText, replyAudio, replyAudioMime } = fsm.context

    const onDone = () => {
      stopPlaybackRef.current = null
      streamingPlayerRef.current = null
      if (fsm.state !== 'speaking') return
      rlog('[Speaking] done — entering follow-up')
      fsm.send({ type: 'SPEECH_DONE' })
    }

    // Streaming path: chunks arrive over IPC via onSpeakChunk listener
    if (replyAudio === null && replyText) {
      const player = new StreamingPlayer(setOrbAmp, onDone)
      streamingPlayerRef.current = player
      stopPlaybackRef.current = () => {
        player.stop()
        streamingPlayerRef.current = null
        onDone()
      }
      // No-op here — chunks will be enqueued by the IPC listener as they arrive
      return
    }

    // Legacy single-buffer path (kept for safety / non-streaming responses)
    if (replyAudio && replyAudio.length > 0) {
      const handle = playAudioReactive(replyAudio, replyAudioMime || 'audio/mpeg', setOrbAmp, onDone)
      stopPlaybackRef.current = handle.stop
    } else {
      const stopEnvelope = startSpeechEnvelope(setOrbAmp)
      speakLocal(replyText, () => {
        stopEnvelope()
        onDone()
      })
      stopPlaybackRef.current = () => {
        stopEnvelope()
        stopLocalSpeech()
        onDone()
      }
    }
  }, [setOrbAmp])

  const handleFollowUp = useCallback((fsm: JarvizFSM) => {
    if (followUpTimerRef.current) clearTimeout(followUpTimerRef.current)
    followUpTimerRef.current = null
    handleListening(fsm)
  }, [handleListening])

  // ── Main setup effect ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!canvasRef.current) return
    rlog('[App] mounting')

    const scene = new OrbScene(canvasRef.current)
    sceneRef.current = scene
    scene.start()

    const sound = soundRef.current
    const fsm = new JarvizFSM()
    fsmRef.current = fsm

    // Blob stash for the transcribing phase (can't put Blob in FSM context serialization)
    let pendingBlob: Blob | null = null

    // ── FSM state change handler ─────────────────────────────────────────────
    fsm.subscribe((newState, oldState, event, ctx) => {
      rlog(`[FSM] ${oldState} → ${newState} (${event.type})`)

      // Forward state + caption to main process so the menubar panel can mirror them
      relayState(newState)

      setCaption(prev => {
        const phase = PHASE_LABEL[newState] ?? newState
        let user = prev.user
        let reply = prev.reply
        if (event.type === 'TRANSCRIPT_READY') user = event.text.slice(0, 140)
        if (event.type === 'RESPONSE_READY') reply = event.text.slice(0, 180)
        if (newState === 'idle') {
          user = ''
          reply = ''
        }
        const next = { phase, user, reply }
        relayCaption(next)
        return next
      })

      scene.setState(FSM_TO_ORB[newState])

      // Exit actions
      if (oldState === 'thinking' || oldState === 'transcribing') {
        sound.stopThinking()
      }
      if (oldState === 'thinking' && event.type === 'INTERRUPTED') {
        window.jarviz?.agent?.cancel()
      }
      if (oldState === 'speaking') {
        setOrbAmp(0)
        if (event.type === 'INTERRUPTED' || event.type === 'WAKE_WORD' || event.type === 'ACTIVATE') {
          stopLocalSpeech()
          streamingPlayerRef.current?.stop()
          streamingPlayerRef.current = null
          if (stopPlaybackRef.current) {
            stopPlaybackRef.current()
            stopPlaybackRef.current = null
          }
          window.jarviz?.agent?.cancel()
        }
      }
      if (oldState === 'followUp' && followUpTimerRef.current) {
        clearTimeout(followUpTimerRef.current)
        followUpTimerRef.current = null
      }

      // Enter actions
      switch (newState) {
        case 'idle':
          sound.stopThinking()
          stopLocalSpeech()
          setOrbAmp(0)
          if (stopPlaybackRef.current) {
            stopPlaybackRef.current()
            stopPlaybackRef.current = null
          }
          wakeWordRef.current?.setEchoSuppression(false)
          wakeWordRef.current?.resume().catch(e => rlog(`[WakeWord] resume error: ${e}`))
          if (oldState !== 'idle' && oldState !== 'followUp' && oldState !== 'error') {
            sound.dismiss()
          }
          break

        case 'listening':
          if (oldState === 'idle' || oldState === 'speaking') sound.activation()
          wakeWordRef.current?.setEchoSuppression(false)
          handleListening(fsm)
          break

        case 'transcribing':
          sound.startThinking()
          if (event.type === 'AUDIO_CAPTURED') {
            pendingBlob = (event as { type: 'AUDIO_CAPTURED'; blob: Blob }).blob
          }
          if (pendingBlob) {
            handleTranscribing(fsm, pendingBlob)
            pendingBlob = null
          }
          break

        case 'thinking':
          sound.startThinking()
          handleThinking(fsm)
          break

        case 'speaking':
          sound.stopThinking()
          wakeWordRef.current?.setEchoSuppression(true)
          wakeWordRef.current?.resume().catch(e => rlog(`[WakeWord] resume error: ${e}`))
          handleSpeaking(fsm)
          break

        case 'followUp':
          wakeWordRef.current?.setEchoSuppression(false)
          handleFollowUp(fsm)
          break

        case 'error':
          sound.stopThinking()
          stopLocalSpeech()
          setOrbAmp(0)
          if (stopPlaybackRef.current) {
            stopPlaybackRef.current()
            stopPlaybackRef.current = null
          }
          rlog(`[Error] ${fsm.context.errorMessage}`)
          break
      }
    })

    // ── Mic analyser for idle orb amplitude ──────────────────────────────────
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const ana = ctx.createAnalyser(); ana.fftSize = 64
      src.connect(ana)
      analyserRef.current = ana
      fftRef.current = new Uint8Array(ana.frequencyBinCount)
      rlog('[App] mic ready')
    }).catch(e => rlog(`[App] mic failed: ${e}`))

    rafRef.current = requestAnimationFrame(driveAudio)

    // Defer Whisper download to idle time so the app boots instantly.
    // The wake word + transcription path will await this lazily on first use anyway.
    const idleLoad = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
    const kickoffWhisper = (): void => {
      window.jarviz?.getWhisperModel?.()
        .then(key => loadWhisper(msg => rlog(`[Whisper] ${msg}`), key))
        .catch(() => loadWhisper(msg => rlog(`[Whisper] ${msg}`)))
    }
    if (idleLoad) idleLoad(kickoffWhisper)
    else setTimeout(kickoffWhisper, 1500)

    // ── Wake word (VAD + Whisper phrases) then optional Picovoice ─────────────
    const ww = new LocalWakeWord()
    wakeWordRef.current = ww
    void ww.start(
      async (command) => {
        rlog(`[WakeWord] triggered — command: "${command}"`)
        await ww.pause().catch(() => {})
        fsm.send(command
          ? { type: 'WAKE_WORD', command }
          : { type: 'ACTIVATE' },
        )
      },
      undefined,
      () => { if (fsm.state === 'idle') scene.setState('idle') },
    ).then(async (vadOk) => {
      rlog(`[WakeWord] VAD started: ${vadOk}`)
      if (!vadOk) {
        rlog('[WakeWord] Silero VAD did not start — check mic permission and the renderer console (VAD assets must load from the same folder as index.html).')
        return
      }
      try {
        const settings = await window.jarviz.settings.get()
        if (settings.wakeWordMode !== 'picovoice') {
          rlog('[WakeWord] Picovoice disabled — using phrase wake (“hey jarviz”, …). Change in Setup → Wake word if you want Picovoice.')
          return
        }
        const accessKey = settings.envOverrides?.PICOVOICE_ACCESS_KEY?.trim()
        if (!accessKey) {
          rlog('[WakeWord] Picovoice selected but PICOVOICE_ACCESS_KEY is empty — add key in Setup or switch to Phrases.')
          return
        }
        const pico = new PicovoiceWakeWord()
        const ok = await pico.start(accessKey, () => {
          rlog('[Picovoice] wake!')
          fsm.send({ type: 'ACTIVATE' })
        })
        if (ok) {
          picoRef.current = pico
          await ww.pause().catch(() => {})
          rlog('[Picovoice] active — say "Jarvis" / VAD+Whisper wake paused')
        } else {
          rlog('[Picovoice] init failed — using VAD + Whisper wake phrases (e.g. "hey jarviz")')
        }
      } catch (e) {
        rlog(`[Picovoice] init error: ${(e as Error).message}`)
      }
    })

    // ── External triggers ────────────────────────────────────────────────────
    const applyJarvizEnabledFromMain = (enabled: boolean): void => {
      if (!enabled) {
        void wakeWordRef.current?.pause().catch(() => {})
        void picoRef.current?.pause().catch(() => {})
        if (fsm.state === 'error') fsm.send({ type: 'ERROR_DISMISS' })
        else if (fsm.state !== 'idle') fsm.send({ type: 'INTERRUPTED' })
        window.jarviz?.agent?.cancel()
        stopLocalSpeech()
        streamingPlayerRef.current?.stop()
        streamingPlayerRef.current = null
        if (stopPlaybackRef.current) {
          stopPlaybackRef.current()
          stopPlaybackRef.current = null
        }
        sound.stopThinking()
        setOrbAmp(0)
      } else {
        void wakeWordRef.current?.resume().catch(() => {})
        void picoRef.current?.resume().catch(() => {})
      }
    }

    const removeActivate = window.jarviz?.onActivate(() => {
      void window.jarviz?.app?.getJarvizEnabled?.().then((on) => {
        if (on === false) return
        void wakeWordRef.current?.pause().catch(() => {})
        fsm.send({ type: 'ACTIVATE' })
      }).catch(() => { /* if IPC missing, do not activate */ })
    })

    const removeJarvizSetEnabled = window.jarviz?.app?.onJarvizSetEnabled?.((enabled) => {
      applyJarvizEnabledFromMain(enabled)
    })
    void window.jarviz?.app?.getJarvizEnabled?.().then(applyJarvizEnabledFromMain).catch(() => {})

    // Settings + Transcripts now live in the menubar panel — orb window stays clean
    const removeOpenSettings = window.jarviz?.onOpenSettings(() => {
      window.jarviz?.panel?.show?.('keys')
    })

    const removeOpenTranscripts = window.jarviz?.onOpenTranscripts(() => {
      window.jarviz?.panel?.show?.('transcripts')
    })

    const removeUpdaterStatus = window.jarviz?.onUpdaterStatus(s => {
      setUpdateBanner(s)
      if (s.state === 'available' || s.state === 'ready') rlog(`[Updater] ${s.state}`)
    })

    const removeSpeakChunk = window.jarviz?.agent?.onSpeakChunk((chunk) => {
      const player = streamingPlayerRef.current
      if (!player) {
        rlog(`[Stream] chunk arrived with no active player — ignoring (i=${chunk.index})`)
        return
      }
      rlog(`[Stream] chunk ${chunk.index + 1}/${chunk.total} (audio=${chunk.audio?.length ?? 0}B, final=${chunk.isFinal})`)
      player.enqueue(chunk)
    })

    const removeAgentState = window.jarviz?.agent?.onState(s => {
      if (s === 'searching' || s === 'thinking') {
        scene.setState(s as OrbState)
        if (s === 'searching') sound.stopThinking()
        if (s === 'thinking')  sound.startThinking()
      }
    })

    const syncCanvasSize = (): void => {
      const el = canvasRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const w = r.width > 0 ? r.width : el.clientWidth
      const h = r.height > 0 ? r.height : el.clientHeight
      scene.resize(w || 300, h || 300)
    }

    const obs = new ResizeObserver(() => syncCanvasSize())
    obs.observe(canvasRef.current)
    syncCanvasSize()
    requestAnimationFrame(() => syncCanvasSize())

    const onUnload = () => {
      ww.stop()
      picoRef.current?.stop()
      sound.dispose()
      AudioManager.shared().dispose()
    }
    window.addEventListener('beforeunload', onUnload)

    return () => {
      window.removeEventListener('beforeunload', onUnload)
      cancelAnimationFrame(rafRef.current)
      if (followUpTimerRef.current) clearTimeout(followUpTimerRef.current)
      scene.dispose()
      sound.dispose()
      fsm.dispose()
      ww.stop()
      picoRef.current?.stop()
      AudioManager.shared().dispose()
      removeActivate?.()
      removeJarvizSetEnabled?.()
      removeOpenSettings?.()
      removeOpenTranscripts?.()
      removeUpdaterStatus?.()
      removeSpeakChunk?.()
      removeAgentState?.()
      obs.disconnect()
    }
  }, [driveAudio, handleListening, handleTranscribing, handleThinking, handleSpeaking, handleFollowUp, setOrbAmp])

  // ── Mouse parallax + window resize for orb size ─────────────────────────────
  const orbSizeRef = useRef(360)

  useEffect(() => {
    window.jarviz?.orbGetSize?.().then(s => { orbSizeRef.current = s }).catch(() => {})
  }, [])

  useEffect(() => {
    const STEP = 40
    const DEFAULT = 360

    const resizeTo = (size: number) => {
      const clamped = Math.max(ORB_SIZE_MIN, Math.min(ORB_SIZE_MAX, size))
      orbSizeRef.current = clamped
      window.jarviz?.orbResize(clamped)
    }

    const onMove = (e: MouseEvent) => sceneRef.current?.setMousePosition(
      (e.clientX / window.innerWidth  - 0.5) * 2,
      (e.clientY / window.innerHeight - 0.5) * 2,
    )
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -STEP : STEP
      resizeTo(orbSizeRef.current + delta)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '=' || e.key === '+') { e.preventDefault(); resizeTo(orbSizeRef.current + STEP) }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); resizeTo(orbSizeRef.current - STEP) }
      if (e.key === '0')                  { e.preventDefault(); resizeTo(DEFAULT) }
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    return
  }, [])

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const fsm = fsmRef.current
      if (!fsm || fsm.state === 'idle') return
      if (fsm.state === 'thinking') window.jarviz?.agent?.cancel()
      fsm.send({ type: 'INTERRUPTED' })
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [])

  // ── Drag + click handling ──────────────────────────────────────────────────
  const isInsideOrb = useCallback((e: React.MouseEvent) => {
    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    const dx = e.clientX - cx
    const dy = e.clientY - cy
    const minDim = Math.min(window.innerWidth, window.innerHeight)
    const size = Math.max(ORB_SIZE_MIN, Math.min(ORB_SIZE_MAX, orbSizeRef.current))
    const frac = Math.max(0.38, Math.min(0.48, 0.48 * (size / ORB_SIZE_MAX)))
    const orbRadius = minDim * frac
    return (dx * dx + dy * dy) <= orbRadius * orbRadius
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isInsideOrb(e)) return
    mouseDownPos.current = { x: e.screenX, y: e.screenY }
    window.jarviz?.dragStart(e.screenX, e.screenY)
  }, [isInsideOrb])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (e.buttons === 1 && mouseDownPos.current) window.jarviz?.dragMove(e.screenX, e.screenY)
  }, [])

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (!mouseDownPos.current) return
    window.jarviz?.dragEnd()
    const dx = Math.abs(e.screenX - mouseDownPos.current.x)
    const dy = Math.abs(e.screenY - mouseDownPos.current.y)
    if (dx < 6 && dy < 6) {
      const ww = wakeWordRef.current
      const fsm = fsmRef.current
      if (ww && fsm) {
        ww.pause().catch(() => {})
        fsm.send({ type: 'ACTIVATE' })
      }
    }
    mouseDownPos.current = null
  }, [])

  return (
    <div
      style={shellStyle}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { if (mouseDownPos.current) { window.jarviz?.dragEnd(); mouseDownPos.current = null } }}
    >
      <canvas ref={canvasRef} style={canvasStyle} />
    </div>
  )
}
