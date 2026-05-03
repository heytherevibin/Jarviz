import { useEffect, useState } from 'react'

const ENV_KEYS = [
  'EMERGENT_LLM_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'TAVILY_API_KEY',
  'ELEVENLABS_API_KEY',
  'PICOVOICE_ACCESS_KEY',
] as const

const ENV_KEY_HINTS: Record<string, string> = {
  EMERGENT_LLM_KEY:    'Universal key (sk-emergent-…) — proxies Claude / GPT / Gemini.',
  ANTHROPIC_API_KEY:   'Direct Anthropic key (console.anthropic.com).',
  OPENAI_API_KEY:      'Direct OpenAI key (platform.openai.com/api-keys).',
  GEMINI_API_KEY:      'Direct Google AI Studio key (aistudio.google.com/apikey).',
  GROQ_API_KEY:        'Free fast Llama models (console.groq.com).',
  XAI_API_KEY:         'xAI Grok (console.x.ai).',
  TAVILY_API_KEY:      'Optional — richer web search results.',
  ELEVENLABS_API_KEY:  'Optional — premium voice output.',
  PICOVOICE_ACCESS_KEY:'Optional — efficient hardware-grade "Jarvis" wake word (console.picovoice.ai).',
}

const PROVIDER_MODELS: Record<string, { value: string; label: string }[]> = {
  anthropic: [
    { value: 'claude-sonnet-4-5-20250929',  label: 'Claude Sonnet 4.5  (recommended)' },
    { value: 'claude-haiku-4-5-20251001',   label: 'Claude Haiku 4.5  (fast)' },
    { value: 'claude-opus-4-5-20251101',    label: 'Claude Opus 4.5  (most capable)' },
    { value: 'claude-sonnet-4-6',           label: 'Claude Sonnet 4.6' },
  ],
  openai: [
    { value: 'gpt-5.2',     label: 'GPT-5.2  (recommended)' },
    { value: 'gpt-5.1',     label: 'GPT-5.1' },
    { value: 'gpt-5',       label: 'GPT-5' },
    { value: 'gpt-5-mini',  label: 'GPT-5 Mini  (fast)' },
    { value: 'gpt-4o',      label: 'GPT-4o' },
    { value: 'o3',          label: 'o3  (reasoning)' },
  ],
  gemini: [
    { value: 'gemini-3.1-pro-preview',     label: 'Gemini 3 Pro  (preview)' },
    { value: 'gemini-3-flash-preview',     label: 'Gemini 3 Flash  (preview)' },
    { value: 'gemini-2.5-pro',             label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash',           label: 'Gemini 2.5 Flash  (fast)' },
  ],
}

type Props = { open: boolean; onClose: () => void }

export function SettingsOverlay({ open, onClose }: Props) {
  const [llmBackend, setLlmBackend] = useState('emergent')
  const [emergentProvider, setEmergentProvider] = useState('anthropic')
  const [emergentModel, setEmergentModel] = useState('claude-sonnet-4-5-20250929')
  const [whisperModel, setWhisperModel] = useState('base')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [miniMode, setMiniMode] = useState(false)

  useEffect(() => {
    if (!open) return
    Promise.all([
      window.jarviz.settings.get(),
      window.jarviz.getMini(),
    ]).then(([s, mini]) => {
      setLlmBackend(s.llmBackend || 'emergent')
      setWhisperModel(s.whisperModel || 'base')
      setKeys({ ...s.envOverrides })
      setEmergentProvider(s.envOverrides.EMERGENT_PROVIDER || 'anthropic')
      setEmergentModel(s.envOverrides.EMERGENT_MODEL || 'claude-sonnet-4-5-20250929')
      setMiniMode(!!mini)
      setSaved(false)
    }).catch(console.error)
  }, [open])

  // Keep model in sync when provider changes (don't let mismatched model leak through)
  useEffect(() => {
    const list = PROVIDER_MODELS[emergentProvider]
    if (list && !list.some(m => m.value === emergentModel)) {
      setEmergentModel(list[0].value)
    }
  }, [emergentProvider, emergentModel])

  const save = (): void => {
    const next = { ...keys, EMERGENT_PROVIDER: emergentProvider, EMERGENT_MODEL: emergentModel }
    window.jarviz.settings.set({
      llmBackend,
      whisperModel,
      envOverrides: next,
    }).then(() => {
      setKeys(next)
      setSaved(true)
      setTimeout(() => setSaved(false), 1800)
    }).catch(console.error)
  }

  const toggleMini = (): void => {
    const next = !miniMode
    setMiniMode(next)
    window.jarviz.setMini(next).catch(console.error)
  }

  if (!open) return null

  return (
    <div
      className="jarviz-settings-root"
      data-testid="settings-overlay"
      style={{
        position:       'fixed',
        inset:          0,
        zIndex:         100,
        background:     'rgba(6,8,14,0.94)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        padding:        12,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={e => { if (e.key === 'Escape') onClose() }}
      role="presentation"
    >
      <div
        style={{
          width:        'min(460px, 100vw - 24px)',
          maxHeight:    'min(640px, 92vh)',
          overflow:     'auto',
          borderRadius: 16,
          padding:      '20px 18px',
          background:   'linear-gradient(165deg, rgba(28,32,44,0.96), rgba(18,20,30,0.98))',
          border:       '1px solid rgba(255,255,255,0.10)',
          boxShadow:    '0 24px 48px rgba(0,0,0,0.6)',
          color:        '#e8eaef',
          fontFamily:   'system-ui, -apple-system, sans-serif',
          fontSize:     13,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <strong style={{ fontSize: 16, letterSpacing: 0.3 }}>Jarviz Settings</strong>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
              Press Cmd/Ctrl + , anytime · Esc to close
            </div>
          </div>
          <button
            type="button"
            data-testid="settings-close-button"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              borderRadius: 8,
              padding: '6px 12px',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>

        <SectionLabel>LLM backend</SectionLabel>
        <select
          data-testid="settings-backend-select"
          value={llmBackend}
          onChange={e => setLlmBackend(e.target.value)}
          style={selectStyle}
        >
          <option value="emergent">Emergent Universal Key (Claude / GPT / Gemini)</option>
          <option value="anthropic">Anthropic (your key)</option>
          <option value="openai">OpenAI (your key)</option>
          <option value="gemini">Google Gemini (your key)</option>
          <option value="groq">Groq Llama (free)</option>
          <option value="xai">xAI Grok</option>
        </select>

        {llmBackend === 'emergent' && (
          <div style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 12,
            background: 'rgba(120, 80, 220, 0.10)',
            border: '1px solid rgba(160,120,255,0.22)',
          }}>
            <SectionLabel small>Emergent provider</SectionLabel>
            <select
              data-testid="settings-emergent-provider"
              value={emergentProvider}
              onChange={e => setEmergentProvider(e.target.value)}
              style={selectStyle}
            >
              <option value="anthropic">Anthropic Claude</option>
              <option value="openai">OpenAI GPT</option>
              <option value="gemini">Google Gemini</option>
            </select>

            <SectionLabel small>Model</SectionLabel>
            <select
              data-testid="settings-emergent-model"
              value={emergentModel}
              onChange={e => setEmergentModel(e.target.value)}
              style={selectStyle}
            >
              {PROVIDER_MODELS[emergentProvider]?.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <div style={hintStyle}>
              Universal key proxies all three providers. Top up at Profile → Universal Key.
            </div>
          </div>
        )}

        <SectionLabel>Whisper STT model</SectionLabel>
        <select
          data-testid="settings-whisper-select"
          value={whisperModel}
          onChange={e => setWhisperModel(e.target.value)}
          style={selectStyle}
        >
          <option value="tiny">tiny  · ~39 MB · fastest</option>
          <option value="tiny.en">tiny.en  · ~39 MB · English</option>
          <option value="base">base  · ~145 MB · balanced</option>
          <option value="base.en">base.en  · ~145 MB · English</option>
          <option value="small">small  · ~466 MB · accurate</option>
          <option value="medium">medium  · ~1.5 GB · high accuracy</option>
          <option value="large-v3">large-v3  · ~3 GB · best accuracy</option>
        </select>

        <SectionLabel>Display</SectionLabel>
        <button
          type="button"
          data-testid="settings-mini-toggle"
          onClick={toggleMini}
          style={{
            ...selectStyle,
            background: miniMode ? 'rgba(120,80,220,0.25)' : 'rgba(0,0,0,0.35)',
            border: `1px solid ${miniMode ? 'rgba(160,120,255,0.4)' : 'rgba(255,255,255,0.12)'}`,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {miniMode ? '◉' : '○'}  Mini mode (Cmd/Ctrl+Shift+M) — {miniMode ? 'on, click orb to expand' : 'off'}
        </button>

        <SectionLabel>API keys</SectionLabel>
        <div style={{ ...hintStyle, marginBottom: 8 }}>
          Stored locally in electron-store. Applied immediately on save.
        </div>

        {ENV_KEYS.map(k => (
          <label key={k} style={{ display: 'block', marginBottom: 10 }}>
            <span style={{ opacity: 0.85, fontSize: 11, fontWeight: 600 }}>{k}</span>
            <input
              data-testid={`settings-key-${k.toLowerCase()}`}
              type="password"
              autoComplete="off"
              value={keys[k] ?? ''}
              onChange={e => setKeys(prev => ({ ...prev, [k]: e.target.value }))}
              placeholder={ENV_KEY_HINTS[k] ?? 'Paste key…'}
              style={inputStyle}
            />
          </label>
        ))}

        <button
          type="button"
          data-testid="settings-save-button"
          onClick={save}
          style={{
            marginTop: 12,
            width:     '100%',
            padding:   12,
            borderRadius: 12,
            border:    'none',
            cursor:    'pointer',
            fontWeight: 700,
            fontSize:  14,
            letterSpacing: 0.4,
            background: saved
              ? 'linear-gradient(135deg, #34A853, #00BCD4)'
              : 'linear-gradient(135deg, #4285F4, #A142F4)',
            color: '#fff',
            transition: 'background 0.3s',
          }}
        >
          {saved ? '✓  Saved' : 'Save settings'}
        </button>
      </div>
    </div>
  )
}

function SectionLabel({ children, small }: { children: React.ReactNode; small?: boolean }) {
  return (
    <div style={{
      marginTop:   small ? 8 : 18,
      marginBottom: 6,
      fontSize:    small ? 10 : 11,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      fontWeight:  700,
      opacity:     0.7,
    }}>
      {children}
    </div>
  )
}

const selectStyle: React.CSSProperties = {
  display:    'block',
  width:      '100%',
  marginTop:  4,
  padding:    '9px 10px',
  borderRadius: 10,
  border:     '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(0,0,0,0.35)',
  color:      '#fff',
  fontSize:   13,
  appearance: 'none',
  cursor:     'pointer',
}

const inputStyle: React.CSSProperties = {
  display:    'block',
  width:      '100%',
  marginTop:  4,
  padding:    '9px 10px',
  borderRadius: 10,
  border:     '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(0,0,0,0.35)',
  color:      '#fff',
  fontSize:   12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

const hintStyle: React.CSSProperties = {
  fontSize:  11,
  opacity:   0.6,
  marginTop: 6,
  lineHeight: 1.4,
}
