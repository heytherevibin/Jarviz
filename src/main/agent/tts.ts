const DEFAULT_VOICE = 'pNInz6obpgDQGcFmaJgB'
const TTS_TIMEOUT_MS = 10000

export async function synthesize(text: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) return null

  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TTS_TIMEOUT_MS)

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method:  'POST',
        signal:  ctl.signal,
        headers: {
          'xi-api-key':   apiKey,
          'Content-Type': 'application/json',
          'Accept':       'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id:      'eleven_turbo_v2_5',
          voice_settings: { stability: 0.52, similarity_boost: 0.80, style: 0.15, use_speaker_boost: true },
        }),
      },
    )

    clearTimeout(timer)

    if (!res.ok) {
      console.error('[TTS] ElevenLabs error:', res.status, await res.text())
      return null
    }

    return Buffer.from(await res.arrayBuffer())
  } catch (err) {
    clearTimeout(timer)
    if ((err as Error).name === 'AbortError') {
      console.error('[TTS] ElevenLabs timed out, falling back to local TTS')
    } else {
      console.error('[TTS] fetch failed:', err)
    }
    return null
  }
}
