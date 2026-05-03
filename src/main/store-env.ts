import type Store from 'electron-store'

type EnvOverrides = Record<string, string>

export const ENV_KEYS_MANAGED = [
  'EMERGENT_LLM_KEY', 'EMERGENT_PROVIDER', 'EMERGENT_MODEL',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'XAI_API_KEY',
  'TAVILY_API_KEY', 'ELEVENLABS_API_KEY', 'PICOVOICE_ACCESS_KEY',
  'GEMINI_TTS_VOICE',
] as const

/** Keys the renderer reads for wake word / APIs — fill from `process.env` when store is empty (e.g. `.env` only). */
export function getEffectiveEnvOverrides(store: Store): Record<string, string> {
  const stored = store.get('envOverrides', {}) as EnvOverrides
  const out: Record<string, string> = { ...stored }
  for (const k of ENV_KEYS_MANAGED) {
    if (out[k]?.trim()) continue
    const fromEnv = process.env[k]?.trim()
    if (fromEnv) out[k] = fromEnv
  }
  return out
}

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
  for (const [k, v] of Object.entries(overrides)) {
    if ((ENV_KEYS_MANAGED as readonly string[]).includes(k)) continue
    if (typeof v === 'string' && v.trim().length > 0) process.env[k] = v.trim()
  }

  const lb = store.get('llmBackend') as string | undefined
  if (typeof lb === 'string' && lb.trim()) process.env.LLM_BACKEND = lb.trim()

  const wm = store.get('whisperModel') as string | undefined
  if (typeof wm === 'string' && wm.trim()) process.env.WHISPER_MODEL = wm.trim()

  if (store.get('agent.allowDestructiveShell', false) === true) {
    process.env.JARVIZ_ALLOW_DESTRUCTIVE_SHELL = '1'
  } else {
    delete process.env.JARVIZ_ALLOW_DESTRUCTIVE_SHELL
  }

  if (store.get('agent.anthropicThinking', true) === false) {
    process.env.ANTHROPIC_THINKING = '0'
  }
}
