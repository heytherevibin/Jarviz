/**
 * Speech synthesis layer with 3 backends (in preference order):
 *
 *   1. Gemini TTS  — premium prebuilt voices (Charon, Kore, Puck, Algieba, …)
 *                    Requires `GEMINI_API_KEY` and `GEMINI_TTS_VOICE` set in settings.
 *   2. ElevenLabs  — set `ELEVENLABS_API_KEY` (+ optional `ELEVENLABS_VOICE_ID`).
 *   3. Web Speech  — built-in fallback handled in the renderer (returns null here).
 *
 * Returns either:
 *   • Buffer of MP3 (ElevenLabs) — renderer plays via `audio/mpeg` Audio element.
 *   • Buffer of WAV  (Gemini)    — renderer plays via `audio/wav` Audio element.
 *   • null                       — renderer falls back to Web Speech.
 */

const TTS_TIMEOUT_MS = 12000

// ── Gemini TTS prebuilt voices (curated list) ────────────────────────────────
export const GEMINI_VOICES = [
  { id: 'Charon',      label: 'Charon — calm, neutral (recommended)' },
  { id: 'Kore',        label: 'Kore — firm, professional' },
  { id: 'Puck',        label: 'Puck — upbeat, friendly' },
  { id: 'Algieba',     label: 'Algieba — smooth, warm' },
  { id: 'Aoede',       label: 'Aoede — breezy, light' },
  { id: 'Enceladus',   label: 'Enceladus — breathy, soft' },
  { id: 'Orus',        label: 'Orus — firm, decisive' },
  { id: 'Despina',     label: 'Despina — smooth, even' },
  { id: 'Iapetus',     label: 'Iapetus — clear, articulate' },
  { id: 'Achernar',    label: 'Achernar — bright, sharp' },
  { id: 'Sulafat',     label: 'Sulafat — rich, resonant' },
  { id: 'Vindemiatrix',label: 'Vindemiatrix — gentle, refined' },
] as const

const DEFAULT_GEMINI_VOICE = 'Charon'
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts'

// ElevenLabs default — "Bella", soft young female (matches Aoede aesthetic).
// Override per-install via ELEVENLABS_VOICE_ID env.
const ELEVEN_DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL'

export interface SynthesisResult {
  buffer: Buffer
  mime: 'audio/mpeg' | 'audio/wav'
}

export async function synthesize(text: string): Promise<SynthesisResult | null> {
  const trimmed = text.trim()
  if (!trimmed) return null

  // 1) Gemini TTS — only when a voice is explicitly chosen
  const voice = (process.env.GEMINI_TTS_VOICE || '').trim()
  if (voice && process.env.GEMINI_API_KEY) {
    const buf = await synthesizeGemini(trimmed, voice).catch(err => {
      console.error('[TTS] Gemini failed:', (err as Error).message)
      return null
    })
    if (buf) return { buffer: buf, mime: 'audio/wav' }
  }

  // 2) ElevenLabs (legacy)
  if (process.env.ELEVENLABS_API_KEY) {
    const buf = await synthesizeElevenLabs(trimmed).catch(err => {
      console.error('[TTS] ElevenLabs failed:', (err as Error).message)
      return null
    })
    if (buf) return { buffer: buf, mime: 'audio/mpeg' }
  }

  return null
}

// ── Gemini TTS implementation ────────────────────────────────────────────────
async function synthesizeGemini(text: string, voice: string): Promise<Buffer | null> {
  const apiKey = process.env.GEMINI_API_KEY!
  const model = process.env.GEMINI_TTS_MODEL || GEMINI_TTS_MODEL
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TTS_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method:  'POST',
      signal:  ctl.signal,
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || DEFAULT_GEMINI_VOICE } },
          },
        },
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      console.error('[TTS] Gemini error:', res.status, body.slice(0, 240))
      return null
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>
    }
    const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data)
    const inline = part?.inlineData
    if (!inline?.data) return null

    // Gemini returns raw PCM L16 @ 24kHz mono. Wrap in a WAV header so the
    // renderer can decode/play it without extra dependencies.
    const sampleRateMatch = /rate=(\d+)/.exec(inline.mimeType ?? '')
    const sampleRate = sampleRateMatch ? Number(sampleRateMatch[1]) : 24000
    const pcm = Buffer.from(inline.data, 'base64')
    return wrapPcmInWav(pcm, sampleRate, 1, 16)
  } finally {
    clearTimeout(timer)
  }
}

/** Build a minimal RIFF/WAVE container around PCM samples. */
function wrapPcmInWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate   = sampleRate * channels * bitsPerSample / 8
  const blockAlign = channels * bitsPerSample / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)            // fmt chunk size
  header.writeUInt16LE(1, 20)             // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

// ── ElevenLabs implementation (preserved) ────────────────────────────────────
async function synthesizeElevenLabs(text: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY!
  const voiceId = process.env.ELEVENLABS_VOICE_ID || ELEVEN_DEFAULT_VOICE
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TTS_TIMEOUT_MS)

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method:  'POST',
      signal:  ctl.signal,
      headers: {
        'xi-api-key':   apiKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id:       'eleven_turbo_v2_5',
        voice_settings: { stability: 0.52, similarity_boost: 0.80, style: 0.15, use_speaker_boost: true },
      }),
    })

    if (!res.ok) {
      console.error('[TTS] ElevenLabs error:', res.status, (await res.text()).slice(0, 200))
      return null
    }
    return Buffer.from(await res.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}
