import { useEffect, useState } from 'react'

const ENV_KEYS = [
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'TAVILY_API_KEY',
  'ELEVENLABS_API_KEY',
] as const

type Props = { open: boolean; onClose: () => void }

export function SettingsOverlay({ open, onClose }: Props) {
  const [llmBackend, setLlmBackend] = useState('groq')
  const [whisperModel, setWhisperModel] = useState('base')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!open) return
    window.jarviz.settings.get().then(s => {
      setLlmBackend(s.llmBackend || 'groq')
      setWhisperModel(s.whisperModel || 'base')
      setKeys({ ...s.envOverrides })
      setSaved(false)
    }).catch(console.error)
  }, [open])

  const save = () => {
    window.jarviz.settings.set({
      llmBackend,
      whisperModel,
      envOverrides: keys,
    }).then(() => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }).catch(console.error)
  }

  if (!open) return null

  return (
    <div
      className="jarviz-settings-root"
      style={{
        position:          'fixed',
        inset:             0,
        zIndex:            100,
        background:        'rgba(8,10,18,0.94)',
        display:           'flex',
        alignItems:        'center',
        justifyContent:    'center',
        padding:           '12px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={e => { if (e.key === 'Escape') onClose() }}
      role="presentation"
    >
      <div
        style={{
          width:          'min(420px, 100vw - 24px)',
          maxHeight:      'min(560px, 92vh)',
          overflow:       'auto',
          borderRadius:   '14px',
          padding:        '18px 16px',
          background:     'linear-gradient(165deg, rgba(28,32,44,0.96), rgba(18,20,30,0.98))',
          border:         '1px solid rgba(255,255,255,0.08)',
          boxShadow:      '0 24px 48px rgba(0,0,0,0.45)',
          color:          '#e8eaef',
          fontFamily:     'system-ui, -apple-system, sans-serif',
          fontSize:       '13px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <strong style={{ fontSize: '15px' }}>Settings</strong>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              borderRadius: '8px',
              padding: '6px 12px',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>

        <label style={{ display: 'block', marginBottom: '10px' }}>
          <span style={{ opacity: 0.85 }}>LLM backend</span>
          <select
            value={llmBackend}
            onChange={e => setLlmBackend(e.target.value)}
            style={{
              display: 'block',
              width: '100%',
              marginTop: '6px',
              padding: '8px',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(0,0,0,0.35)',
              color: '#fff',
            }}
          >
            <option value="gemini">Gemini</option>
            <option value="groq">Groq</option>
            <option value="xai">xAI Grok</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>

        <label style={{ display: 'block', marginBottom: '14px' }}>
          <span style={{ opacity: 0.85 }}>Whisper model</span>
          <select
            value={whisperModel}
            onChange={e => setWhisperModel(e.target.value)}
            style={{
              display: 'block',
              width: '100%',
              marginTop: '6px',
              padding: '8px',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(0,0,0,0.35)',
              color: '#fff',
            }}
          >
            <option value="tiny">tiny</option>
            <option value="tiny.en">tiny.en</option>
            <option value="base">base</option>
            <option value="base.en">base.en</option>
            <option value="small">small</option>
            <option value="small.en">small.en</option>
            <option value="medium">medium</option>
            <option value="medium.en">medium.en</option>
            <option value="large-v3">large-v3</option>
          </select>
        </label>

        <div style={{ opacity: 0.75, fontSize: '11px', marginBottom: '10px' }}>
          API keys are stored locally (electron-store) and applied on save. Restart not required for most keys.
        </div>

        {ENV_KEYS.map(k => (
          <label key={k} style={{ display: 'block', marginBottom: '10px' }}>
            <span style={{ opacity: 0.8, fontSize: '11px' }}>{k}</span>
            <input
              type="password"
              autoComplete="off"
              value={keys[k] ?? ''}
              onChange={e => setKeys(prev => ({ ...prev, [k]: e.target.value }))}
              placeholder="Paste key…"
              style={{
                display: 'block',
                width: '100%',
                marginTop: '4px',
                padding: '8px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(0,0,0,0.35)',
                color: '#fff',
              }}
            />
          </label>
        ))}

        <button
          type="button"
          onClick={save}
          style={{
            marginTop: '12px',
            width: '100%',
            padding: '10px',
            borderRadius: '10px',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            background: 'linear-gradient(135deg, #4285F4, #A142F4)',
            color: '#fff',
          }}
        >
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>
    </div>
  )
}
