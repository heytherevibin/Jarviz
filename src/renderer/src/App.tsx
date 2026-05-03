import { useEffect, useRef, useCallback, useState, type CSSProperties } from 'react'
import { OrbScene, OrbState } from './orb/OrbScene'
import { SoundEngine } from './audio/SoundEngine'
import { AudioManager } from './audio/AudioManager'
import { loadWhisper, transcribeBlob } from './voice/LocalSTT'
import { LocalWakeWord } from './voice/LocalWakeWord'
import { PicovoiceWakeWord } from './voice/PicovoiceWakeWord'
import { speakLocal, stopLocalSpeech, isSpeakingLocal } from './voice/LocalTTS'
import { JarvizFSM, JarvizState } from './state/JarvizFSM'
import { SettingsOverlay } from './SettingsOverlay'
import { TranscriptOverlay } from './TranscriptOverlay'

declare global {
  interface Window {
    jarviz: {
      dragStart:  (x: number, y: number) => void
      dragMove:   (x: number, y: number) => void
      dragEnd:    () => void
      onActivate: (cb: () => void) => () => void
      log:        (msg: string) => void
      orbResize:  (size: number) => void
      orbGetSize: () => Promise<number>
      setMini:    (on: boolean) => Promise<boolean>
      getMini:    () => Promise<boolean>
      primaryScreenSize: () => Promise<{ width: number; height: number; x: number; y: number }>
      getWhisperModel: () => Promise<string>
      installUpdate: () => Promise<boolean>
      onOpenSettings:    (cb: () => void) => () => void
      onOpenTranscripts: (cb: () => void) => () => void
      onMiniChanged:     (cb: (mini: boolean) => void) => () => void
      onUpdaterStatus:   (cb: (s: { state: string; progress?: number; message?: string }) => void) => () => void
      settings: {
        get: () => Promise<{ envOverrides: Record<string, string>; llmBackend: string; whisperModel: string }>
        set: (patch: {
          envOverrides?: Record<string, string>
          llmBackend?: string
          whisperModel?: string
        }) => Promise<boolean>
      }
      transcripts: {
        list:       () => Promise<Array<{ id: string; startedAt: number; endedAt: number; preview: string; turns: number }>>
        get:        (id: string) => Promise<{ id: string; startedAt: number; endedAt: number; preview: string; turns: Array<{ role: string; text: string; ts: number }> } | null>
        delete:     (id: string) => Promise<boolean>
        clear:      () => Promise<boolean>
        newSession: () => Promise<boolean>
      }
      agent: {
        query:   (text: string) => Promise<{ text: string; audio: number[] | null }>
        cancel:  () => void
        onState: (cb: (state: string) => void) => () => void
      }
    }
  }
}

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
  bottom: 12,
  transform: 'translateX(-50%)',
  zIndex: 60,
  maxWidth: 'min(400px, calc(100vw - 24px))',
  width: 'max-content',
  minWidth: 0,
  maxHeight: 'min(124px, 36vh)',
  overflow: 'hidden',
  pointerEvents: 'none',
  boxSizing: 'border-box',
  contain: 'strict',
}

const hudCardStyle: CSSProperties = {
  maxWidth: 'min(400px, calc(100vw - 24px))',
  boxSizing: 'border-box',
  padding: '8px 12px 10px',
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.12)',
  backgroundColor: 'rgba(8,10,18,0.92)',
  boxShadow: '0 14px 40px rgba(0,0,0,0.6)',
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  fontSize: 11,
  lineHeight: 1.35,
  color: 'rgba(255,255,255,0.96)',
  textAlign: 'left',
}

const hudPhaseStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginBottom: 4,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const hudRowStyle: CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  opacity: 0.9,
}

const hudLabelStyle: CSSProperties = {
  fontWeight: 600,
  opacity: 0.7,
  marginRight: 4,
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

// ── MP3 playback with live amplitude ─────────────────────────────────────────
function playAudioReactive(
  bytes: number[],
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
    const blob = new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' })
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [transcriptsOpen, setTranscriptsOpen] = useState(false)
  const [updateBanner, setUpdateBanner] = useState<{ state: string; progress?: number; message?: string } | null>(null)

  const setOrbAmp = useCallback((v: number) => {
    sceneRef.current?.setAudioAmplitude(v)
  }, [])

  // Mic-driven idle amplitude (muted during speaking via FSM state check)
  const driveAudio = useCallback(() => {
    const fsm = fsmRef.current
    if (fsm && fsm.state !== 'speaking') {
      const a = analyserRef.current; const f = fftRef.current
      if (a && f) {
        a.getByteFrequencyData(f)
        let s = 0; for (let i = 0; i < f.length; i++) s += f[i]
        sceneRef.current?.setAudioAmplitude((s / f.length) / 255)
      }
    }
    rafRef.current = requestAnimationFrame(driveAudio)
  }, [])

  // ── Phase handlers — triggered by FSM state transitions ────────────────────

  const handleListening = useCallback(async (fsm: JarvizFSM) => {
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
      fsm.send({ type: 'RESPONSE_READY', text, audio: result?.audio ?? null })
    } catch (e) {
      rlog(`[Agent] error: ${e}`)
      fsm.send({ type: 'AGENT_FAILED', message: String(e) })
    }
  }, [])

  const handleSpeaking = useCallback((fsm: JarvizFSM) => {
    const { replyText, replyAudio } = fsm.context

    const onDone = () => {
      stopPlaybackRef.current = null
      rlog('[Speaking] done — entering follow-up')
      fsm.send({ type: 'SPEECH_DONE' })
    }

    if (replyAudio && replyAudio.length > 0) {
      const handle = playAudioReactive(replyAudio, setOrbAmp, onDone)
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
        return { phase, user, reply }
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
        if (event.type === 'INTERRUPTED') {
          stopLocalSpeech()
          if (stopPlaybackRef.current) {
            stopPlaybackRef.current()
            stopPlaybackRef.current = null
          }
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
          wakeWordRef.current?.resume().catch(() => {})
          if (oldState !== 'idle' && oldState !== 'followUp' && oldState !== 'error') {
            sound.dismiss()
          }
          break

        case 'listening':
          if (oldState === 'idle') sound.activation()
          wakeWordRef.current?.setEchoSuppression(false)
          wakeWordRef.current?.pause().catch(() => {})
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
          handleSpeaking(fsm)
          break

        case 'followUp':
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

    window.jarviz?.getWhisperModel?.()
      .then(key => loadWhisper(msg => rlog(`[Whisper] ${msg}`), key))
      .catch(() => loadWhisper(msg => rlog(`[Whisper] ${msg}`)))

    // ── Wake word ────────────────────────────────────────────────────────────
    const ww = new LocalWakeWord()
    wakeWordRef.current = ww
    ww.start(
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
    ).then(ok => rlog(`[WakeWord] VAD started: ${ok}`))

    // ── Picovoice Porcupine (opt-in, swaps in when access key is set) ───────
    void (async () => {
      try {
        const settings = await window.jarviz.settings.get()
        const accessKey = settings.envOverrides?.PICOVOICE_ACCESS_KEY
        if (!accessKey) return
        const pico = new PicovoiceWakeWord()
        const ok = await pico.start(accessKey, () => {
          rlog('[Picovoice] wake!')
          fsm.send({ type: 'ACTIVATE' })
        })
        if (ok) {
          picoRef.current = pico
          // Pause the heavier VAD+Whisper path; Porcupine handles wake from now on
          await ww.pause().catch(() => {})
          rlog('[Picovoice] active — VAD wake word paused')
        }
      } catch (e) {
        rlog(`[Picovoice] init error: ${(e as Error).message}`)
      }
    })()

    // ── External triggers ────────────────────────────────────────────────────
    const removeActivate = window.jarviz?.onActivate(() => {
      wakeWordRef.current?.pause().catch(() => {})
      fsm.send({ type: 'ACTIVATE' })
    })

    const removeOpenSettings = window.jarviz?.onOpenSettings(() => {
      setSettingsOpen(true)
    })

    const removeOpenTranscripts = window.jarviz?.onOpenTranscripts(() => {
      setTranscriptsOpen(true)
    })

    const removeUpdaterStatus = window.jarviz?.onUpdaterStatus(s => {
      setUpdateBanner(s)
      if (s.state === 'available' || s.state === 'ready') rlog(`[Updater] ${s.state}`)
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
      removeOpenSettings?.()
      removeOpenTranscripts?.()
      removeUpdaterStatus?.()
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
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (settingsOpen) {
        setSettingsOpen(false)
        return
      }
      if (transcriptsOpen) {
        setTranscriptsOpen(false)
        return
      }
      const fsm = fsmRef.current
      if (!fsm || fsm.state === 'idle') return
      if (fsm.state === 'thinking') window.jarviz?.agent?.cancel()
      fsm.send({ type: 'INTERRUPTED' })
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [settingsOpen, transcriptsOpen])

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
      <div
        style={hudWrapStyle}
        aria-live="polite"
        aria-atomic="true"
        role="status"
      >
        <div style={hudCardStyle}>
          <div style={hudPhaseStyle} title={caption.phase}>{caption.phase}</div>
          {caption.user ? (
            <div style={hudRowStyle} title={caption.user}>
              <span style={hudLabelStyle}>You</span>
              {caption.user}
            </div>
          ) : null}
          {caption.reply ? (
            <div style={{ ...hudRowStyle, marginTop: caption.user ? 4 : 0 }} title={caption.reply}>
              <span style={hudLabelStyle}>Jarviz</span>
              {caption.reply}
            </div>
          ) : null}
        </div>
      </div>
      <SettingsOverlay open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <TranscriptOverlay open={transcriptsOpen} onClose={() => setTranscriptsOpen(false)} />
      {updateBanner && updateBanner.state !== 'error' && (
        <div
          data-testid="update-banner"
          style={{
            position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
            zIndex: 90, background: 'rgba(28,32,44,0.96)',
            border: '1px solid rgba(160,120,255,0.3)',
            borderRadius: 10, padding: '8px 14px',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: 12, color: '#fff', pointerEvents: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >
          {updateBanner.state === 'available'    && '↻ Update available — downloading…'}
          {updateBanner.state === 'downloading'  && `↻ Update: ${Math.round(updateBanner.progress ?? 0)}%`}
          {updateBanner.state === 'ready'        && (
            <>
              ✓ Update ready —{' '}
              <button
                type="button"
                data-testid="update-install-btn"
                onClick={() => window.jarviz.installUpdate()}
                style={{ marginLeft: 6, padding: '2px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#A142F4', color: '#fff', fontWeight: 700 }}
              >
                Restart to install
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
