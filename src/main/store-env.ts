import type Store from 'electron-store'

type EnvOverrides = Record<string, string>

/** Overlay persisted keys onto process.env (called after dotenv + whenever settings save). */
export function mergeStoredEnv(store: Store): void {
  const overrides = store.get('envOverrides', {}) as EnvOverrides
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === 'string' && v.trim().length > 0) process.env[k] = v.trim()
  }

  const lb = store.get('llmBackend') as string | undefined
  if (typeof lb === 'string' && lb.trim()) process.env.LLM_BACKEND = lb.trim()

  const wm = store.get('whisperModel') as string | undefined
  if (typeof wm === 'string' && wm.trim()) process.env.WHISPER_MODEL = wm.trim()
}
