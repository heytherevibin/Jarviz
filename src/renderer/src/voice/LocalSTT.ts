import { pipeline, env } from '@xenova/transformers'
import { AudioManager } from '../audio/AudioManager'

env.allowLocalModels = false
env.useBrowserCache  = true

type ASRPipeline = Awaited<ReturnType<typeof pipeline>>

let asr: ASRPipeline | null = null
let loadState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
let loadAttempts = 0
const MAX_LOAD_RETRIES = 3
const RETRY_DELAY_MS   = 5000
const STT_TIMEOUT_MS   = 10000

interface WhisperModelInfo {
  id: string
  label: string
  size: string
  multilingual: boolean
}

const WHISPER_MODELS: Record<string, WhisperModelInfo> = {
  tiny:       { id: 'Xenova/whisper-tiny',      label: 'Whisper Tiny',      size: '~39MB',  multilingual: true },
  'tiny.en':  { id: 'Xenova/whisper-tiny.en',   label: 'Whisper Tiny (EN)', size: '~39MB',  multilingual: false },
  base:       { id: 'Xenova/whisper-base',       label: 'Whisper Base',      size: '~145MB', multilingual: true },
  'base.en':  { id: 'Xenova/whisper-base.en',    label: 'Whisper Base (EN)', size: '~145MB', multilingual: false },
  small:      { id: 'Xenova/whisper-small',      label: 'Whisper Small',     size: '~466MB', multilingual: true },
  'small.en': { id: 'Xenova/whisper-small.en',   label: 'Whisper Small (EN)',size: '~466MB', multilingual: false },
  medium:     { id: 'Xenova/whisper-medium',     label: 'Whisper Medium',    size: '~1.5GB', multilingual: true },
  'medium.en':{ id: 'Xenova/whisper-medium.en',  label: 'Whisper Medium (EN)',size:'~1.5GB', multilingual: false },
  'large-v3': { id: 'Xenova/whisper-large-v3',   label: 'Whisper Large v3',  size: '~3GB',   multilingual: true },
}

let activeModel: WhisperModelInfo = WHISPER_MODELS.base

function resolveModel(key: string): WhisperModelInfo {
  const normalized = key.trim().toLowerCase()
  return WHISPER_MODELS[normalized] ?? WHISPER_MODELS.base
}

export function getActiveModel(): WhisperModelInfo { return activeModel }
export function isModelReady(): boolean { return loadState === 'ready' }
export function getLoadState(): typeof loadState { return loadState }
export function getAvailableModels(): Record<string, WhisperModelInfo> { return WHISPER_MODELS }

export async function loadWhisper(
  onProgress?: (msg: string) => void,
  modelKey?: string,
): Promise<void> {
  if (asr) return
  if (loadState === 'loading') {
    while (loadState === 'loading') await new Promise(r => setTimeout(r, 200))
    if (asr) return
    throw new Error('Whisper model failed to load')
  }

  if (modelKey) activeModel = resolveModel(modelKey)
  const model = activeModel

  loadState = 'loading'
  onProgress?.(`Downloading ${model.label} (${model.size}) (first run only)…`)

  while (loadAttempts < MAX_LOAD_RETRIES) {
    loadAttempts++
    try {
      asr = await pipeline(
        'automatic-speech-recognition',
        model.id,
        {
          progress_callback: (p: { status: string; progress?: number }) => {
            if (p.status === 'downloading' && p.progress != null) {
              onProgress?.(`Downloading ${model.label}: ${Math.round(p.progress)}%`)
            }
            if (p.status === 'ready') {
              onProgress?.(`${model.label} ready`)
            }
          },
        },
      )
      loadState = 'ready'
      return
    } catch (e) {
      const msg = `Whisper load failed (attempt ${loadAttempts}/${MAX_LOAD_RETRIES}): ${e}`
      console.error(`[STT] ${msg}`)
      onProgress?.(msg)
      if (loadAttempts < MAX_LOAD_RETRIES) {
        onProgress?.(`Retrying in ${RETRY_DELAY_MS / 1000}s…`)
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
      }
    }
  }

  loadState = 'failed'
  throw new Error(`Whisper model failed after ${MAX_LOAD_RETRIES} attempts`)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ])
}

async function resampleTo16k(buffer: AudioBuffer): Promise<Float32Array> {
  if (buffer.sampleRate === 16000) return buffer.getChannelData(0).slice()

  const offCtx = new OfflineAudioContext(1, Math.ceil(buffer.duration * 16000), 16000)
  const src = offCtx.createBufferSource()
  src.buffer = buffer
  src.connect(offCtx.destination)
  src.start()
  const resampled = await offCtx.startRendering()
  return resampled.getChannelData(0).slice()
}

export async function transcribeBlob(blob: Blob): Promise<string> {
  if (!asr) await loadWhisper()

  const arrayBuf = await blob.arrayBuffer()
  const decoded  = await AudioManager.shared().decodeAudio(arrayBuf)
  const float32  = await resampleTo16k(decoded)

  const maxAmp = float32.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  const diagMsg = `[STT] audio ${decoded.duration.toFixed(2)}s, ${float32.length} samples, maxAmp=${maxAmp.toFixed(4)}`
  console.log(diagMsg)
  try { (window as unknown as {jarviz?:{log:(m:string)=>void}}).jarviz?.log(diagMsg) } catch {}

  const opts: Record<string, unknown> = { task: 'transcribe', language: 'en' }

  const timeout = activeModel.id.includes('large') ? STT_TIMEOUT_MS * 3
    : activeModel.id.includes('medium') ? STT_TIMEOUT_MS * 2
    : STT_TIMEOUT_MS

  const result = await withTimeout(
    (asr as ASRPipeline)(float32, opts as never),
    timeout,
    'transcribeBlob',
  )

  return (result as { text: string }).text?.trim() ?? ''
}

export async function transcribeFloat32(
  audio: Float32Array,
  language?: string,
): Promise<string> {
  if (!asr) await loadWhisper()

  const opts: Record<string, unknown> = { task: 'transcribe' }
  if (language) opts.language = language
  else opts.language = 'en'

  const result = await withTimeout(
    (asr as ASRPipeline)(audio, opts as never),
    STT_TIMEOUT_MS,
    'transcribeFloat32',
  )
  return (result as { text: string }).text?.trim() ?? ''
}
