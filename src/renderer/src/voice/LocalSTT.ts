import {
  env,
  AutoTokenizer,
  AutoProcessor,
  WhisperForConditionalGeneration,
  AutomaticSpeechRecognitionPipeline,
} from '@xenova/transformers'
import { AudioManager } from '../audio/AudioManager'
import { TRANSFORMERS_WASM_CDN_BASE } from './onnxAssets'

env.allowLocalModels = false
env.useBrowserCache  = true

/**
 * Nested onnxruntime-web (1.14): CDN wasm + single-thread ORT in Electron reduces pthread / wasm flake.
 * Quantized Whisper medium/large often hits OrtRun error 1 (ORT_FAIL) in WASM from bad quantized matmul paths.
 */
const onnxBackend = env.backends?.onnx as { wasm?: { wasmPaths?: string; numThreads?: number } } | undefined
if (onnxBackend?.wasm) {
  onnxBackend.wasm.wasmPaths = TRANSFORMERS_WASM_CDN_BASE
  onnxBackend.wasm.numThreads = 1
}

type ASRPipeline = AutomaticSpeechRecognitionPipeline

let asr: ASRPipeline | null = null
let loadState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
let loadAttempts = 0
const MAX_LOAD_RETRIES = 3
const RETRY_DELAY_MS   = 5000
const STT_TIMEOUT_MS   = 10000

function hasWhisperCpp(): boolean {
  return !!(window as unknown as { jarviz?: { stt?: { whisperCppTranscribeWav?: unknown } } }).jarviz?.stt?.whisperCppTranscribeWav
}

function encodeWav16kMonoPcm16(pcm: Float32Array): Uint8Array {
  // 16-bit PCM WAV, mono, 16kHz
  const sampleRate = 16000
  const numChannels = 1
  const bitsPerSample = 16
  const blockAlign = (numChannels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  let o = 0
  writeStr(o, 'RIFF'); o += 4
  view.setUint32(o, 36 + dataSize, true); o += 4
  writeStr(o, 'WAVE'); o += 4
  writeStr(o, 'fmt '); o += 4
  view.setUint32(o, 16, true); o += 4 // PCM chunk size
  view.setUint16(o, 1, true); o += 2  // PCM format
  view.setUint16(o, numChannels, true); o += 2
  view.setUint32(o, sampleRate, true); o += 4
  view.setUint32(o, byteRate, true); o += 4
  view.setUint16(o, blockAlign, true); o += 2
  view.setUint16(o, bitsPerSample, true); o += 2
  writeStr(o, 'data'); o += 4
  view.setUint32(o, dataSize, true); o += 4

  // PCM samples
  let p = 44
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    const int16 = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
    view.setInt16(p, int16, true)
    p += 2
  }
  return new Uint8Array(buffer)
}

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

function transcribeTimeoutMs(): number {
  const id = activeModel.id.toLowerCase()
  if (id.includes('large')) return STT_TIMEOUT_MS * 6
  if (id.includes('medium')) return STT_TIMEOUT_MS * 3
  return STT_TIMEOUT_MS
}

/** WASM Whisper needs much longer than wall-clock STT for long clips; short timeouts abort ORT and can surface as RangeError. */
function transcribeTimeoutMsForSamples(sampleCount: number): number {
  const sec = sampleCount / 16000
  const floor = transcribeTimeoutMs()
  const scaled = Math.ceil(8000 + sec * 5500)
  return Math.max(floor, scaled)
}

function isWasmSessionFailure(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return (
    /Can't create a session/i.test(msg) ||
    /offset is out of bounds/i.test(msg) ||
    /table index is out of bounds/i.test(msg) ||
    /out of memory/i.test(msg) ||
    /wasm/i.test(msg)
  )
}

function resolveModel(key: string): WhisperModelInfo {
  const normalized = key.trim().toLowerCase()
  return WHISPER_MODELS[normalized] ?? WHISPER_MODELS.base
}

export function getActiveModel(): WhisperModelInfo { return activeModel }
export function isModelReady(): boolean { return loadState === 'ready' }
export function getLoadState(): typeof loadState { return loadState }
export function getAvailableModels(): Record<string, WhisperModelInfo> { return WHISPER_MODELS }

/**
 * Build ASR without `pipeline()` — that helper tries `AutoModelForCTC` after `AutoModelForSpeechSeq2Seq`,
 * and Whisper is not CTC, so the *last* error becomes misleading `Unsupported model type: whisper`.
 */
async function createWhisperAsrPipeline(
  modelId: string,
  label: string,
  onProgress?: (msg: string) => void,
): Promise<AutomaticSpeechRecognitionPipeline> {
  const progress_callback = (p: { status: string; progress?: number }) => {
    if (p.status === 'downloading' && p.progress != null) {
      onProgress?.(`Downloading ${label}: ${Math.round(p.progress)}%`)
    }
    if (p.status === 'ready') onProgress?.(`${label} ready`)
  }

  const idLower = modelId.toLowerCase()
  /** Medium/large: load full-precision first — quantized graphs often fail at inference (OrtRun 1) in ORT Web. */
  const heavy = idLower.includes('large') || idLower.includes('medium')
  const variants: Array<{ quantized: boolean; note: string }> = heavy
    ? [
        { quantized: false, note: 'full-precision' },
        { quantized: true, note: 'quantized' },
      ]
    : [
        { quantized: true, note: 'quantized' },
        { quantized: false, note: 'full-precision' },
      ]

  let lastErr: unknown
  for (const { quantized, note } of variants) {
    try {
      onProgress?.(`Loading ${label} (${note})…`)
      const common = { quantized, progress_callback }
      const [tokenizer, processor, whisperModel] = await Promise.all([
        AutoTokenizer.from_pretrained(modelId, common),
        AutoProcessor.from_pretrained(modelId, common),
        WhisperForConditionalGeneration.from_pretrained(modelId, common),
      ])
      onProgress?.(`${label} ready (${note})`)
      return new AutomaticSpeechRecognitionPipeline({
        task: 'automatic-speech-recognition',
        tokenizer,
        processor,
        model: whisperModel,
      })
    } catch (e) {
      lastErr = e
      console.warn(`[STT] Whisper ${note} load failed:`, e)
      onProgress?.(`${note} failed: ${e}`)
    }
  }
  // If a heavy model fails with WASM/session errors, bubble it up quickly so callers can fall back.
  if (heavy && isWasmSessionFailure(lastErr)) {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

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

  // Large/medium models are unreliable in Electron+WASM on some machines (session creation + out-of-bounds).
  // Prefer automatic fallback so wake word / STT stays functional.
  const fallbacks: WhisperModelInfo[] = [
    activeModel,
    // Prefer English-only smaller models for reliability and speed
    WHISPER_MODELS['base.en'],
    WHISPER_MODELS.small,
    WHISPER_MODELS.tiny,
  ].filter(Boolean) as WhisperModelInfo[]

  loadState = 'loading'

  let lastErr: unknown = null
  for (const candidate of fallbacks) {
    activeModel = candidate
    loadAttempts = 0
    onProgress?.(`Downloading ${candidate.label} (${candidate.size}) (first run only)…`)

    while (loadAttempts < MAX_LOAD_RETRIES) {
      loadAttempts++
      try {
        asr = await createWhisperAsrPipeline(candidate.id, candidate.label, onProgress)
        loadState = 'ready'
        onProgress?.(`[Whisper] using ${candidate.label}`)
        return
      } catch (e) {
        lastErr = e
        const msg = `Whisper load failed (${candidate.label}) (attempt ${loadAttempts}/${MAX_LOAD_RETRIES}): ${e}`
        console.error(`[STT] ${msg}`)
        onProgress?.(msg)

        // If this looks like a WASM/session failure on a heavy model, stop retrying it and fall back immediately.
        const idLower = candidate.id.toLowerCase()
        const heavy = idLower.includes('large') || idLower.includes('medium')
        if (heavy && isWasmSessionFailure(e)) {
          onProgress?.(`[Whisper] ${candidate.label} unstable in WASM — falling back`)
          break
        }

        if (loadAttempts < MAX_LOAD_RETRIES) {
          onProgress?.(`Retrying in ${RETRY_DELAY_MS / 1000}s…`)
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
        }
      }
    }
  }

  loadState = 'failed'
  throw lastErr instanceof Error ? lastErr : new Error(`Whisper model failed: ${String(lastErr)}`)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ])
}

function peakAbs(x: Float32Array): number {
  let m = 0
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]))
  return m
}

function normalizeIfHot(x: Float32Array, targetPeak = 0.85): Float32Array {
  const peak = peakAbs(x)
  if (!Number.isFinite(peak) || peak <= 0) return x
  if (peak <= targetPeak) return x
  const g = targetPeak / peak
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g
  return out
}

function isOffsetOob(e: unknown): boolean {
  return e instanceof RangeError && /offset is out of bounds/i.test(e.message)
}

async function resampleTo16k(buffer: AudioBuffer): Promise<Float32Array> {
  if (buffer.sampleRate === 16000) {
    return Float32Array.from(buffer.getChannelData(0))
  }

  const outFrames = Math.max(1, Math.ceil(buffer.duration * 16000))
  const offCtx = new OfflineAudioContext(1, outFrames, 16000)
  const src = offCtx.createBufferSource()
  src.buffer = buffer
  src.connect(offCtx.destination)
  src.start()
  const resampled = await offCtx.startRendering()
  return Float32Array.from(resampled.getChannelData(0))
}

export async function transcribeBlob(blob: Blob): Promise<string> {
  const rawAb = await blob.arrayBuffer()
  const arrayBuf = rawAb.slice(0)
  const decoded = await AudioManager.shared().decodeAudio(arrayBuf)
  let float32 = await resampleTo16k(decoded)

  float32 = Float32Array.from(float32)

  const maxAmp = peakAbs(float32)
  const diagMsg = `[STT] audio ${decoded.duration.toFixed(2)}s, ${float32.length} samples, maxAmp=${maxAmp.toFixed(4)}`
  console.log(diagMsg)
  try { (window as unknown as {jarviz?:{log:(m:string)=>void}}).jarviz?.log(diagMsg) } catch {}

  // Prefer native whisper.cpp when available (bypasses Electron+WASM ORT instability).
  if (hasWhisperCpp()) {
    try {
      const wav = encodeWav16kMonoPcm16(float32)
      const r = await (window as unknown as { jarviz: { stt: { whisperCppTranscribeWav: (b: number[]) => Promise<{ text: string }> } } })
        .jarviz.stt.whisperCppTranscribeWav(Array.from(wav))
      const t = r.text?.trim() ?? ''
      if (t) return t
    } catch (e) {
      console.warn('[STT] whisper.cpp failed, falling back to browser STT:', e)
    }
  }

  if (!asr) await loadWhisper()

  const opts: Record<string, unknown> = {
    task: 'transcribe',
    language: 'en',
    chunk_length_s: 30,
    stride_length_s: 5,
  }

  try {
    const result = await withTimeout(
      (asr as ASRPipeline)(float32, opts as never),
      transcribeTimeoutMsForSamples(float32.length),
      'transcribeBlob',
    )
    return (result as { text: string }).text?.trim() ?? ''
  } catch (e) {
    console.error('[STT] transcribeBlob failed:', e)
    if (!isOffsetOob(e)) throw e

    // Workaround: ORT/WASM occasionally throws offset-OOB on long/hot clips in Electron.
    // Retry once with normalization + shorter window to keep Jarviz usable.
    const retry = normalizeIfHot(float32)
    const maxRetrySec = 10
    const maxRetrySamples = maxRetrySec * 16000
    const retryPcm = retry.length > maxRetrySamples ? retry.subarray(0, maxRetrySamples) : retry
    const retryDiag = `[STT] retrying after offset-OOB: ${retryPcm.length} samples (<=${maxRetrySec}s), peak=${peakAbs(retryPcm).toFixed(4)}`
    console.warn(retryDiag)
    try { (window as unknown as {jarviz?:{log:(m:string)=>void}}).jarviz?.log(retryDiag) } catch {}

    const result = await withTimeout(
      (asr as ASRPipeline)(retryPcm, opts as never),
      transcribeTimeoutMsForSamples(retryPcm.length),
      'transcribeBlob(retry)',
    )
    return (result as { text: string }).text?.trim() ?? ''
  }

}

export async function transcribeFloat32(
  audio: Float32Array,
  language?: string,
): Promise<string> {
  const opts: Record<string, unknown> = { task: 'transcribe' }
  if (language) opts.language = language
  else opts.language = 'en'

  const pcm = Float32Array.from(audio)
  if (hasWhisperCpp()) {
    try {
      const wav = encodeWav16kMonoPcm16(pcm)
      const r = await (window as unknown as { jarviz: { stt: { whisperCppTranscribeWav: (b: number[]) => Promise<{ text: string }> } } })
        .jarviz.stt.whisperCppTranscribeWav(Array.from(wav))
      const t = r.text?.trim() ?? ''
      if (t) return t
    } catch (e) {
      console.warn('[STT] whisper.cpp failed, falling back to browser STT:', e)
    }
  }

  if (!asr) await loadWhisper()
  try {
    const result = await withTimeout(
      (asr as ASRPipeline)(pcm, opts as never),
      transcribeTimeoutMsForSamples(pcm.length),
      'transcribeFloat32',
    )
    return (result as { text: string }).text?.trim() ?? ''
  } catch (e) {
    console.error('[STT] transcribeFloat32 failed:', e)
    if (!isOffsetOob(e)) throw e
    const retry = normalizeIfHot(pcm)
    const maxRetrySec = 6
    const maxRetrySamples = maxRetrySec * 16000
    const retryPcm = retry.length > maxRetrySamples ? retry.subarray(0, maxRetrySamples) : retry
    const result = await withTimeout(
      (asr as ASRPipeline)(retryPcm, opts as never),
      transcribeTimeoutMsForSamples(retryPcm.length),
      'transcribeFloat32(retry)',
    )
    return (result as { text: string }).text?.trim() ?? ''
  }
}
