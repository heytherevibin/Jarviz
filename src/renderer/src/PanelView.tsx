import { useEffect, useState, useCallback, useRef } from 'react'
import type { JarvizState } from './state/JarvizFSM'

/**
 * Menubar panel — opens from the tray icon on macOS / Windows / Linux.
 * Contains EVERYTHING that isn't the orb itself: live status, settings,
 * transcripts, voice preview. Designed to be 360×560 next to the tray icon.
 */

declare global {
  interface Window {
    jarviz: {
      // Subset used by the panel
      onActivate:        (cb: () => void) => () => void
      onAgentState:      (cb: (s: string) => void) => () => void
      onCaption:         (cb: (c: { phase: string; user: string; reply: string }) => void) => () => void
      panel: {
        show:           (section?: string) => void
        hide:           () => void
        ping:           () => void
        getDiagnostics: () => Promise<{
          platform: string
          uptimeMs: number
          envHasGeminiKey: boolean
          envHasEmergentKey: boolean
          envGeminiVoice: string
          llmBackend: string
          memoryMB: number
        }>
        previewVoice:   (voice: string) => Promise<{ ok: boolean; error?: string }>
        onPreviewAudio: (cb: (a: { audio: number[]; mime: string }) => void) => () => void
      }
      settings: {
        get: () => Promise<{ envOverrides: Record<string, string>; llmBackend: string; whisperModel: string }>
        set: (patch: { envOverrides?: Record<string, string>; llmBackend?: string; whisperModel?: string }) => Promise<boolean>
      }
      transcripts: {
        list:       () => Promise<Array<{ id: string; startedAt: number; endedAt: number; preview: string; turns: number }>>
        get:        (id: string) => Promise<{ id: string; startedAt: number; endedAt: number; preview: string; turns: Array<{ role: string; text: string; ts: number }> } | null>
        delete:     (id: string) => Promise<boolean>
        clear:      () => Promise<boolean>
        newSession: () => Promise<boolean>
      }
      setMini: (on: boolean) => Promise<boolean>
      getMini: () => Promise<boolean>
      installUpdate: () => Promise<boolean>
      onUpdaterStatus: (cb: (s: { state: string; progress?: number }) => void) => () => void
      // Below are unused in panel but keep the type complete
      log?:           (msg: string) => void
      onOpenPanelSection?: (cb: (section: string) => void) => () => void
    }
  }
}

const STATE_ACCENT: Record<string, string> = {
  idle: '#8AB4F8', listening: '#FF8A80', transcribing: '#A8D8B9',
  thinking: '#D7AEFB', speaking: '#FBD688', followUp: '#8AB4F8', error: '#F28B82',
}

const STATE_LABEL: Record<string, string> = {
  idle: 'STANDBY', listening: 'LIVE-IN', transcribing: 'PARSE',
  thinking: 'COMPUTE', speaking: 'OUTBOUND', followUp: 'STANDBY', error: 'FAULT',
}

const GEMINI_VOICES = [
  // Soft female voices (recommended)
  { id: 'Aoede',       label: 'Aoede — soft female, breezy (default)' },
  { id: 'Vindemiatrix',label: 'Vindemiatrix — gentle female, refined' },
  { id: 'Despina',     label: 'Despina — smooth female, even' },
  { id: 'Sulafat',     label: 'Sulafat — rich female, resonant' },
  { id: 'Achernar',    label: 'Achernar — bright female, sharp' },
  { id: 'Enceladus',   label: 'Enceladus — breathy, soft' },
  { id: 'Algieba',     label: 'Algieba — smooth, warm' },
  { id: 'Iapetus',     label: 'Iapetus — clear male, articulate' },
  { id: 'Charon',      label: 'Charon — calm male, neutral' },
  { id: 'Kore',        label: 'Kore — firm female, professional' },
  { id: 'Puck',        label: 'Puck — upbeat, friendly' },
  { id: 'Orus',        label: 'Orus — firm male, decisive' },
  { id: '',            label: '— Off (use ElevenLabs / browser voice) —' },
]

const PROVIDER_MODELS: Record<string, { value: string; label: string }[]> = {
  anthropic: [
    { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
    { value: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5  (fast)' },
    { value: 'claude-opus-4-5-20251101',   label: 'Claude Opus 4.5  (most capable)' },
  ],
  openai: [
    { value: 'gpt-5.2',    label: 'GPT-5.2' },
    { value: 'gpt-5.1',    label: 'GPT-5.1' },
    { value: 'gpt-5',      label: 'GPT-5' },
    { value: 'gpt-5-mini', label: 'GPT-5 Mini  (fast)' },
    { value: 'gpt-4o',     label: 'GPT-4o' },
  ],
  gemini: [
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3 Pro  (preview)' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash  (preview)' },
    { value: 'gemini-2.5-pro',         label: 'Gemini 2.5 Pro' },
  ],
}

const ENV_KEYS = [
  'EMERGENT_LLM_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'XAI_API_KEY', 'TAVILY_API_KEY', 'ELEVENLABS_API_KEY', 'PICOVOICE_ACCESS_KEY',
]

const ENV_KEY_HINTS: Record<string, string> = {
  EMERGENT_LLM_KEY:    'sk-emergent-… — proxies Claude / GPT / Gemini chat. Already pre-configured.',
  ANTHROPIC_API_KEY:   'console.anthropic.com — direct.',
  OPENAI_API_KEY:      'platform.openai.com/api-keys — direct.',
  GEMINI_API_KEY:      'aistudio.google.com/apikey — REQUIRED for Gemini voices (free).',
  GROQ_API_KEY:        'console.groq.com — free tier.',
  XAI_API_KEY:         'console.x.ai — Grok models.',
  TAVILY_API_KEY:      'Optional — richer web search.',
  ELEVENLABS_API_KEY:  'Optional — premium voice (used if Gemini key absent).',
  PICOVOICE_ACCESS_KEY:'Optional — efficient hardware-grade wake word.',
}

interface Diagnostics {
  platform: string
  uptimeMs: number
  envHasGeminiKey: boolean
  envHasEmergentKey: boolean
  envGeminiVoice: string
  llmBackend: string
  memoryMB: number
}

function fmtUptime(ms: number): string {
  const sec = Math.floor(ms / 1000) % 60
  const min = Math.floor(ms / 60000) % 60
  const hr  = Math.floor(ms / 3600000)
  return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

const fontMono: React.CSSProperties = {
  fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '0.04em',
}

export function PanelView() {
  const [tab, setTab] = useState<'status' | 'voice' | 'keys' | 'transcripts'>('status')
  const [agentState, setAgentState] = useState<JarvizState | string>('idle')
  const [caption, setCaption] = useState({ phase: 'STANDBY', user: '', reply: '' })
  const [diag, setDiag] = useState<Diagnostics | null>(null)

  // Settings state
  const [llmBackend, setLlmBackend] = useState('emergent')
  const [emergentProvider, setEmergentProvider] = useState('anthropic')
  const [emergentModel, setEmergentModel] = useState('claude-sonnet-4-5-20250929')
  const [whisperModel, setWhisperModel] = useState('base')
  const [geminiVoice, setGeminiVoice] = useState('Aoede')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [miniMode, setMiniMode] = useState(false)

  // Transcripts state
  const [sessions, setSessions] = useState<Array<{ id: string; startedAt: number; endedAt: number; preview: string; turns: number }>>([])
  const [openSession, setOpenSession] = useState<{ id: string; preview: string; turns: Array<{ role: string; text: string; ts: number }> } | null>(null)

  const accent = STATE_ACCENT[agentState] ?? '#8AB4F8'
  const stateLabel = STATE_LABEL[agentState] ?? String(agentState).toUpperCase()

  // Refresh diagnostics every 1.5s
  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const d = await window.jarviz.panel.getDiagnostics()
        if (!cancelled) setDiag(d)
      } catch { /* noop */ }
    }
    refresh()
    const id = setInterval(refresh, 1500)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Preview audio playback
  useEffect(() => {
    return window.jarviz.panel.onPreviewAudio(({ audio, mime }) => {
      try {
        const blob = new Blob([new Uint8Array(audio)], { type: mime })
        const url = URL.createObjectURL(blob)
        const a = new Audio(url)
        a.onended = () => URL.revokeObjectURL(url)
        a.onerror = () => URL.revokeObjectURL(url)
        void a.play()
      } catch (e) {
        console.error('[Panel] preview play failed', e)
      }
    })
  }, [])

  // Listen for "focus this section" events from main (e.g. tray "Settings…" → keys tab)
  useEffect(() => {
    const handler = (_: unknown, section: string): void => {
      if (section === 'keys')        setTab('keys')
      else if (section === 'voice')  setTab('voice')
      else if (section === 'transcripts') setTab('transcripts')
      else if (section === 'status') setTab('status')
    }
    const ipc = (window as unknown as { electron?: { ipcRenderer: { on: (c: string, h: typeof handler) => void; removeListener: (c: string, h: typeof handler) => void } } }).electron
    if (!ipc) return
    ipc.ipcRenderer.on('panel:focus-section', handler)
    return () => ipc.ipcRenderer.removeListener('panel:focus-section', handler)
  }, [])

  // Subscribe to live agent state + caption
  useEffect(() => {
    const unState   = window.jarviz?.onAgentState?.((s) => setAgentState(s as JarvizState))
    const unCaption = window.jarviz?.onCaption?.((c) => setCaption(c))
    return () => { unState?.(); unCaption?.() }
  }, [])

  // Load settings on first mount
  const loadSettings = useCallback(async () => {
    const [s, mini] = await Promise.all([window.jarviz.settings.get(), window.jarviz.getMini()])
    setLlmBackend(s.llmBackend || 'emergent')
    setWhisperModel(s.whisperModel || 'base')
    setKeys({ ...s.envOverrides })
    setEmergentProvider(s.envOverrides.EMERGENT_PROVIDER || 'anthropic')
    setEmergentModel(s.envOverrides.EMERGENT_MODEL || 'claude-sonnet-4-5-20250929')
    setGeminiVoice(s.envOverrides.GEMINI_TTS_VOICE ?? 'Aoede')
    setMiniMode(!!mini)
  }, [])
  useEffect(() => { loadSettings().catch(console.error) }, [loadSettings])

  // Refresh transcripts whenever the tab opens
  useEffect(() => {
    if (tab !== 'transcripts') return
    window.jarviz.transcripts.list().then(setSessions).catch(console.error)
  }, [tab])

  const saveSettings = useCallback(async () => {
    const next = { ...keys, EMERGENT_PROVIDER: emergentProvider, EMERGENT_MODEL: emergentModel, GEMINI_TTS_VOICE: geminiVoice }
    await window.jarviz.settings.set({ llmBackend, whisperModel, envOverrides: next })
    setKeys(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }, [keys, emergentProvider, emergentModel, geminiVoice, llmBackend, whisperModel])

  const previewVoice = useCallback(async () => {
    setPreviewBusy(true)
    setPreviewError(null)
    try {
      // Save first so the preview uses the latest selection
      await saveSettings()
      const r = await window.jarviz.panel.previewVoice(geminiVoice)
      if (!r.ok) setPreviewError(r.error || 'Voice preview failed.')
    } catch (e) {
      setPreviewError((e as Error).message)
    } finally {
      setPreviewBusy(false)
    }
  }, [geminiVoice, saveSettings])

  const toggleMini = (): void => {
    const next = !miniMode
    setMiniMode(next)
    void window.jarviz.setMini(next)
  }

  // Voice diagnostic — explains why voice may not change
  const voiceWarning = (() => {
    if (!geminiVoice) return null
    if (!diag) return null
    if (!diag.envHasGeminiKey) {
      return `⚠ Gemini voice "${geminiVoice}" requires GEMINI_API_KEY — set it in the API Keys tab. Right now Jarviz is using the system browser voice.`
    }
    if (diag.envGeminiVoice !== geminiVoice) {
      return `⚠ Voice change not yet applied — click Save below.`
    }
    return null
  })()

  // ── UI ─────────────────────────────────────────────────────────────────────
  return (
    <div style={{
      width:        '100vw',
      height:       '100vh',
      background:   'linear-gradient(180deg, rgba(14,18,28,0.96), rgba(8,10,18,0.99))',
      color:        '#E8EAEF',
      fontFamily:   'system-ui, -apple-system, "SF Pro Display", Segoe UI, sans-serif',
      fontSize:     12.5,
      display:      'flex',
      flexDirection:'column',
      overflow:     'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px 10px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: accent, boxShadow: `0 0 8px ${accent}, 0 0 14px ${accent}77`,
          }} />
          <span style={{ ...fontMono, fontSize: 11, fontWeight: 700, letterSpacing: '0.16em' }}>
            J-CORE · {stateLabel}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ ...fontMono, fontSize: 10, opacity: 0.6 }}>
            {diag ? fmtUptime(diag.uptimeMs) : '—'}
          </span>
        </div>
        {(caption.user || caption.reply) && (
          <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 4, lineHeight: 1.5 }}>
            {caption.user && <div><span style={pillStyle('#8AB4F8')}>YOU</span> {caption.user}</div>}
            {caption.reply && <div style={{ marginTop: 4 }}><span style={pillStyle('#FBBC04')}>JARVIZ</span> {caption.reply}</div>}
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(0,0,0,0.18)',
      }}>
        {([
          ['status',      'Status'],
          ['voice',       'Voice'],
          ['keys',        'Keys'],
          ['transcripts', 'Transcripts'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            data-testid={`panel-tab-${id}`}
            onClick={() => setTab(id)}
            style={{
              flex: 1,
              padding: '9px 0',
              border: 'none',
              borderBottom: tab === id ? `2px solid ${accent}` : '2px solid transparent',
              background: 'transparent',
              color: tab === id ? '#fff' : 'rgba(255,255,255,0.55)',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.10em',
              textTransform: 'uppercase',
              transition: 'color 0.2s',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: '14px 16px' }}>
        {tab === 'status' && diag && <StatusTab diag={diag} accent={accent} miniMode={miniMode} onToggleMini={toggleMini} />}
        {tab === 'voice' && (
          <VoiceTab
            voice={geminiVoice}
            onChange={setGeminiVoice}
            onSave={saveSettings}
            onPreview={previewVoice}
            previewBusy={previewBusy}
            previewError={previewError}
            voiceWarning={voiceWarning}
            saved={saved}
          />
        )}
        {tab === 'keys' && (
          <KeysTab
            llmBackend={llmBackend} setLlmBackend={setLlmBackend}
            emergentProvider={emergentProvider} setEmergentProvider={setEmergentProvider}
            emergentModel={emergentModel} setEmergentModel={setEmergentModel}
            whisperModel={whisperModel} setWhisperModel={setWhisperModel}
            keys={keys} setKeys={setKeys}
            onSave={saveSettings} saved={saved}
          />
        )}
        {tab === 'transcripts' && (
          <TranscriptsTab
            sessions={sessions}
            openSession={openSession}
            setOpenSession={setOpenSession}
            refresh={() => window.jarviz.transcripts.list().then(setSessions)}
          />
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '8px 14px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        fontSize: 10,
        opacity: 0.6,
        ...fontMono,
      }}>
        <span>{diag?.platform ?? '—'}</span>
        <span>·</span>
        <span>RAM {diag?.memoryMB.toFixed(0) ?? '—'} MB</span>
        <span style={{ flex: 1 }} />
        <span>v0.4</span>
      </div>
    </div>
  )
}

function pillStyle(color: string): React.CSSProperties {
  return {
    fontWeight: 700, fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase',
    marginRight: 6, padding: '1px 6px', borderRadius: 4,
    background: `${color}1A`, color,
    display: 'inline-block', verticalAlign: 'middle',
  }
}

const sectionLabel: React.CSSProperties = {
  fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase',
  fontWeight: 700, opacity: 0.65, margin: '14px 0 6px',
}

const selectStyle: React.CSSProperties = {
  display: 'block', width: '100%', padding: '8px 10px',
  borderRadius: 8, border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(0,0,0,0.30)', color: '#fff',
  fontSize: 12, appearance: 'none', cursor: 'pointer',
}

const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', padding: '8px 10px',
  borderRadius: 8, border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(0,0,0,0.30)', color: '#fff',
  fontSize: 11.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

const buttonPrimary = (saved: boolean): React.CSSProperties => ({
  width: '100%', padding: 10, marginTop: 12,
  borderRadius: 10, border: 'none', cursor: 'pointer',
  fontWeight: 700, fontSize: 12.5, letterSpacing: '0.04em',
  background: saved ? 'linear-gradient(135deg, #34A853, #00BCD4)' : 'linear-gradient(135deg, #4285F4, #A142F4)',
  color: '#fff', transition: 'background 0.3s',
})

const buttonSecondary: React.CSSProperties = {
  padding: '7px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.14)',
  cursor: 'pointer', fontSize: 11, fontWeight: 600,
  background: 'rgba(255,255,255,0.06)', color: '#fff',
}

// ── Tabs ───────────────────────────────────────────────────────────────────

interface StatusProps {
  diag: Diagnostics
  accent: string
  miniMode: boolean
  onToggleMini: () => void
}
function StatusTab({ diag, accent, miniMode, onToggleMini }: StatusProps) {
  return (
    <div>
      <div style={sectionLabel}>System</div>
      <Row label="Platform"      value={diag.platform} />
      <Row label="Uptime"        value={fmtUptime(diag.uptimeMs)} mono />
      <Row label="Memory"        value={`${diag.memoryMB.toFixed(0)} MB`} mono />
      <Row label="LLM backend"   value={diag.llmBackend} accent={accent} />

      <div style={sectionLabel}>Configuration</div>
      <Row label="Universal key" value={diag.envHasEmergentKey ? '✓ set' : '✗ missing'}
           accent={diag.envHasEmergentKey ? '#A8D8B9' : '#F28B82'} />
      <Row label="Gemini key"    value={diag.envHasGeminiKey ? '✓ set' : '✗ missing — voice will use browser fallback'}
           accent={diag.envHasGeminiKey ? '#A8D8B9' : '#F28B82'} />
      <Row label="Voice"         value={diag.envGeminiVoice || '— off —'} accent={accent} />

      <div style={sectionLabel}>Display</div>
      <button
        type="button"
        data-testid="panel-mini-toggle"
        onClick={onToggleMini}
        style={{
          ...selectStyle,
          textAlign: 'left', cursor: 'pointer',
          background: miniMode ? 'rgba(120,80,220,0.20)' : 'rgba(0,0,0,0.30)',
          border: `1px solid ${miniMode ? 'rgba(160,120,255,0.40)' : 'rgba(255,255,255,0.10)'}`,
        }}
      >
        {miniMode ? '◉' : '○'}  Mini orb mode  (Cmd/Ctrl+Shift+M)
      </button>
    </div>
  )
}

interface VoiceProps {
  voice: string
  onChange: (v: string) => void
  onSave: () => Promise<void>
  onPreview: () => Promise<void>
  previewBusy: boolean
  previewError: string | null
  voiceWarning: string | null
  saved: boolean
}
function VoiceTab({ voice, onChange, onSave, onPreview, previewBusy, previewError, voiceWarning, saved }: VoiceProps) {
  return (
    <div>
      <div style={sectionLabel}>Gemini voice</div>
      <select
        data-testid="panel-voice-select"
        value={voice}
        onChange={e => onChange(e.target.value)}
        style={selectStyle}
      >
        {GEMINI_VOICES.map(v => (
          <option key={v.id} value={v.id}>{v.label}</option>
        ))}
      </select>

      {voiceWarning && (
        <div style={{
          marginTop: 10, padding: 10, borderRadius: 8,
          background: 'rgba(242,139,130,0.10)', border: '1px solid rgba(242,139,130,0.30)',
          color: '#FFB4AB', fontSize: 11, lineHeight: 1.5,
        }}>
          {voiceWarning}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          type="button"
          data-testid="panel-voice-preview"
          onClick={onPreview}
          disabled={previewBusy}
          style={{
            ...buttonSecondary,
            flex: 1, padding: 9,
            background: previewBusy ? 'rgba(120,120,120,0.15)' : 'rgba(160,120,255,0.18)',
            border: '1px solid rgba(160,120,255,0.40)',
            cursor: previewBusy ? 'wait' : 'pointer',
          }}
        >
          {previewBusy ? '… synthesising' : '▷ Preview voice'}
        </button>
        <button
          type="button"
          data-testid="panel-voice-save"
          onClick={onSave}
          style={{ ...buttonSecondary, flex: 1, padding: 9 }}
        >
          {saved ? '✓ Saved' : 'Save'}
        </button>
      </div>

      {previewError && (
        <div style={{
          marginTop: 10, padding: 10, borderRadius: 8,
          background: 'rgba(242,139,130,0.10)', border: '1px solid rgba(242,139,130,0.30)',
          color: '#FFB4AB', fontSize: 11,
        }}>
          {previewError}
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 11, opacity: 0.65, lineHeight: 1.5 }}>
        Gemini voices need a free <strong>GEMINI_API_KEY</strong> from{' '}
        <span style={{ color: '#8AB4F8' }}>aistudio.google.com/apikey</span>. Without one,
        Jarviz falls back to the browser TTS voice (which sounds the same regardless of selection).
      </div>
    </div>
  )
}

interface KeysProps {
  llmBackend: string; setLlmBackend: (v: string) => void
  emergentProvider: string; setEmergentProvider: (v: string) => void
  emergentModel: string; setEmergentModel: (v: string) => void
  whisperModel: string; setWhisperModel: (v: string) => void
  keys: Record<string, string>; setKeys: React.Dispatch<React.SetStateAction<Record<string, string>>>
  onSave: () => Promise<void>
  saved: boolean
}
function KeysTab(p: KeysProps) {
  useEffect(() => {
    const list = PROVIDER_MODELS[p.emergentProvider]
    if (list && !list.some(m => m.value === p.emergentModel)) {
      p.setEmergentModel(list[0].value)
    }
  }, [p.emergentProvider, p.emergentModel, p])

  return (
    <div>
      <div style={sectionLabel}>LLM backend</div>
      <select data-testid="panel-backend-select" value={p.llmBackend} onChange={e => p.setLlmBackend(e.target.value)} style={selectStyle}>
        <option value="emergent">Emergent Universal Key (Claude/GPT/Gemini)</option>
        <option value="anthropic">Anthropic (your key)</option>
        <option value="openai">OpenAI (your key)</option>
        <option value="gemini">Google Gemini (your key)</option>
        <option value="groq">Groq Llama (free)</option>
        <option value="xai">xAI Grok</option>
      </select>

      {p.llmBackend === 'emergent' && (
        <>
          <div style={{ ...sectionLabel, marginTop: 12 }}>Provider via Emergent</div>
          <select value={p.emergentProvider} onChange={e => p.setEmergentProvider(e.target.value)} style={selectStyle}>
            <option value="anthropic">Anthropic Claude</option>
            <option value="openai">OpenAI GPT</option>
            <option value="gemini">Google Gemini</option>
          </select>
          <div style={{ marginTop: 8 }}>
            <select value={p.emergentModel} onChange={e => p.setEmergentModel(e.target.value)} style={selectStyle}>
              {(PROVIDER_MODELS[p.emergentProvider] ?? []).map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
        </>
      )}

      <div style={sectionLabel}>Whisper STT</div>
      <select value={p.whisperModel} onChange={e => p.setWhisperModel(e.target.value)} style={selectStyle}>
        <option value="tiny">tiny  · 39 MB · fastest</option>
        <option value="base">base  · 145 MB · balanced</option>
        <option value="small">small  · 466 MB · accurate</option>
        <option value="medium">medium  · 1.5 GB · high accuracy</option>
        <option value="large-v3">large-v3  · 3 GB · best accuracy</option>
      </select>

      <div style={sectionLabel}>API keys</div>
      {ENV_KEYS.map(k => (
        <div key={k} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.10em', opacity: 0.75, marginBottom: 3 }}>{k}</div>
          <input
            data-testid={`panel-key-${k.toLowerCase()}`}
            type="password"
            value={p.keys[k] ?? ''}
            placeholder={ENV_KEY_HINTS[k]}
            autoComplete="off"
            onChange={e => p.setKeys(prev => ({ ...prev, [k]: e.target.value }))}
            style={inputStyle}
          />
        </div>
      ))}

      <button type="button" data-testid="panel-keys-save" onClick={p.onSave} style={buttonPrimary(p.saved)}>
        {p.saved ? '✓ Saved' : 'Save'}
      </button>
    </div>
  )
}

interface TranscriptsProps {
  sessions: Array<{ id: string; startedAt: number; endedAt: number; preview: string; turns: number }>
  openSession: { id: string; preview: string; turns: Array<{ role: string; text: string; ts: number }> } | null
  setOpenSession: (s: { id: string; preview: string; turns: Array<{ role: string; text: string; ts: number }> } | null) => void
  refresh: () => Promise<void>
}
function TranscriptsTab(p: TranscriptsProps) {
  const open = async (id: string): Promise<void> => {
    const s = await window.jarviz.transcripts.get(id)
    if (s) p.setOpenSession({ id: s.id, preview: s.preview, turns: s.turns })
  }
  const del = async (id: string): Promise<void> => {
    if (!confirm('Delete this conversation?')) return
    await window.jarviz.transcripts.delete(id)
    if (p.openSession?.id === id) p.setOpenSession(null)
    void p.refresh()
  }

  if (p.openSession) {
    return (
      <div>
        <button type="button" onClick={() => p.setOpenSession(null)} style={buttonSecondary}>← Back</button>
        <div style={{ marginTop: 10, fontWeight: 700, fontSize: 12 }}>{p.openSession.preview || '(empty)'}</div>
        {p.openSession.turns.map((t, i) => (
          <div key={i} style={{ marginTop: 10, padding: 8, borderRadius: 8,
            background: t.role === 'user' ? 'rgba(138,180,248,0.10)' : 'rgba(251,188,4,0.07)',
            border: '1px solid rgba(255,255,255,0.06)', fontSize: 12, lineHeight: 1.5,
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', opacity: 0.7,
              color: t.role === 'user' ? '#8AB4F8' : '#FBBC04', marginBottom: 4 }}>
              {t.role === 'user' ? 'You' : 'Jarviz'}
            </div>
            {t.text}
          </div>
        ))}
        <button type="button" onClick={() => del(p.openSession!.id)} style={{ ...buttonSecondary, marginTop: 12, background: 'rgba(234,67,53,0.20)', borderColor: 'rgba(234,67,53,0.40)' }}>
          Delete this session
        </button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ ...sectionLabel, marginTop: 0 }}>{p.sessions.length} saved</div>
      {p.sessions.length === 0 && <div style={{ opacity: 0.5, fontSize: 11.5, marginTop: 8 }}>No saved conversations yet.</div>}
      {p.sessions.map(s => (
        <button key={s.id} type="button" data-testid={`panel-transcript-${s.id}`} onClick={() => open(s.id)} style={{
          width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 6,
          background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 8, cursor: 'pointer', color: '#fff',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {s.preview || '(empty)'}
          </div>
          <div style={{ fontSize: 10, opacity: 0.55, marginTop: 2 }}>{new Date(s.startedAt).toLocaleString()} · {s.turns} turns</div>
        </button>
      ))}
      {p.sessions.length > 0 && (
        <button type="button" onClick={async () => {
          if (!confirm('Delete ALL saved conversations?')) return
          await window.jarviz.transcripts.clear()
          void p.refresh()
        }} style={{ ...buttonSecondary, marginTop: 8, width: '100%', background: 'rgba(234,67,53,0.18)', borderColor: 'rgba(234,67,53,0.40)' }}>
          Clear all
        </button>
      )}
    </div>
  )
}

function Row({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 11.5 }}>
      <span style={{ opacity: 0.65 }}>{label}</span>
      <span style={{ ...(mono ? fontMono : null), color: accent ?? '#fff', fontWeight: accent ? 600 : 400 }}>{value}</span>
    </div>
  )
}
