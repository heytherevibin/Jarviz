import type Store from 'electron-store'

type EnvOverrides = Record<string, string>

const ENV_KEYS_MANAGED = [
  'EMERGENT_LLM_KEY', 'EMERGENT_PROVIDER', 'EMERGENT_MODEL',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'XAI_API_KEY',
  'TAVILY_API_KEY', 'ELEVENLABS_API_KEY', 'PICOVOICE_ACCESS_KEY',
  'GEMINI_TTS_VOICE',
]

/** Overlay persisted keys onto process.env (called after dotenv + whenever settings save). */
export function mergeStoredEnv(store: Store): void {
  const overrides = store.get('envOverrides', {}) as EnvOverrides
  for (const k of ENV_KEYS_MANAGED) {
    const v = overrides[k]
    if (typeof v === 'string' && v.trim().length > 0) {
      process.env[k] = v.trim()
    } else if (k === 'GEMINI_TTS_VOICE' && (v === '' || v === undefined)) {
      // Empty voice means "Off" — actively clear it so old value doesn't linger
      delete process.env[k]
    }
  }
  // Apply any other (non-managed) overrides too
  for (const [k, v] of Object.entries(overrides)) {
    if (ENV_KEYS_MANAGED.includes(k)) continue
    if (typeof v === 'string' && v.trim().length > 0) process.env[k] = v.trim()
  }

  const lb = store.get('llmBackend') as string | undefined
  if (typeof lb === 'string' && lb.trim()) process.env.LLM_BACKEND = lb.trim()

  const wm = store.get('whisperModel') as string | undefined
  if (typeof wm === 'string' && wm.trim()) process.env.WHISPER_MODEL = wm.trim()
}
