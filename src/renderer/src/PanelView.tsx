import { useEffect, useState, useCallback } from 'react'
import type { JarvizState } from './state/JarvizFSM'

// ── Type declarations for preload API ───────────────────────────────────────
declare global {
  interface Window {
    jarviz: {
      onActivate:   (cb: () => void) => () => void
      onAgentState: (cb: (s: string) => void) => () => void
      onCaption:    (cb: (c: { phase: string; user: string; reply: string }) => void) => () => void
      panel: {
        show:           (section?: string) => void
        hide:           () => void
        ping:           () => void
        getDiagnostics: () => Promise<Diagnostics>
        previewVoice:   (voice: string) => Promise<{ ok: boolean; error?: string }>
        onPreviewAudio: (cb: (a: { audio: number[]; mime: string }) => void) => () => void
      }
      settings: {
        get: () => Promise<{ envOverrides: Record<string, string>; llmBackend: string; whisperModel: string }>
        set: (patch: { envOverrides?: Record<string, string>; llmBackend?: string; whisperModel?: string }) => Promise<boolean>
      }
      transcripts: {
        list:       () => Promise<Array<TranscriptMeta>>
        get:        (id: string) => Promise<TranscriptFull | null>
        delete:     (id: string) => Promise<boolean>
        clear:      () => Promise<boolean>
        newSession: () => Promise<boolean>
      }
      setMini: (on: boolean) => Promise<boolean>
      getMini: () => Promise<boolean>
      installUpdate: () => Promise<boolean>
      onUpdaterStatus: (cb: (s: { state: string; progress?: number }) => void) => () => void
    }
  }
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
interface TranscriptMeta { id: string; startedAt: number; endedAt: number; preview: string; turns: number }
interface TranscriptFull { id: string; startedAt: number; endedAt: number; preview: string; turns: Array<{ role: string; text: string; ts: number }> }

// ── Sidebar navigation definition ───────────────────────────────────────────
interface NavItem {
  id:       string
  label:    string
  gradient: string   // CSS gradient for the icon tile
  icon:     React.ReactNode
  soon?:    boolean
  group:    'settings' | 'jarviz'
}

const NAV: NavItem[] = [
  { id: 'general',     label: 'General',     group: 'settings', gradient: 'linear-gradient(135deg,#7A7A82,#4E4E55)', icon: <GearIcon /> },
  { id: 'voice',       label: 'Voice',       group: 'settings', gradient: 'linear-gradient(135deg,#FF7AB6,#A142F4)', icon: <VoiceIcon /> },
  { id: 'llm',         label: 'LLM',         group: 'settings', gradient: 'linear-gradient(135deg,#4285F4,#00BCD4)', icon: <SparkIcon /> },
  { id: 'keys',        label: 'API Keys',    group: 'settings', gradient: 'linear-gradient(135deg,#FBBC04,#EA8300)', icon: <KeyIcon /> },
  { id: 'wake',        label: 'Wake word',   group: 'settings', gradient: 'linear-gradient(135deg,#7ED957,#1FAC6A)', icon: <WaveIcon /> },
  { id: 'transcripts', label: 'Transcripts', group: 'jarviz',   gradient: 'linear-gradient(135deg,#FFA34E,#E25822)', icon: <ChatIcon /> },
  { id: 'status',      label: 'Status',      group: 'jarviz',   gradient: 'linear-gradient(135deg,#30D5C8,#0E8A82)', icon: <ChartIcon /> },
  { id: 'about',       label: 'About',       group: 'jarviz',   gradient: 'linear-gradient(135deg,#8E8E93,#555561)', icon: <InfoIcon /> },
]

const GEMINI_VOICES = [
  { id: 'Aoede',       label: 'Aoede',        hint: 'soft female · breezy (default)' },
  { id: 'Vindemiatrix',label: 'Vindemiatrix', hint: 'gentle female · refined' },
  { id: 'Despina',     label: 'Despina',      hint: 'smooth female · even' },
  { id: 'Sulafat',     label: 'Sulafat',      hint: 'rich female · resonant' },
  { id: 'Achernar',    label: 'Achernar',     hint: 'bright female · sharp' },
  { id: 'Enceladus',   label: 'Enceladus',    hint: 'breathy · soft' },
  { id: 'Algieba',     label: 'Algieba',      hint: 'smooth · warm' },
  { id: 'Kore',        label: 'Kore',         hint: 'firm female · professional' },
  { id: 'Puck',        label: 'Puck',         hint: 'upbeat · friendly' },
  { id: 'Iapetus',     label: 'Iapetus',      hint: 'clear male · articulate' },
  { id: 'Charon',      label: 'Charon',       hint: 'calm male · neutral' },
  { id: 'Orus',        label: 'Orus',         hint: 'firm male · decisive' },
  { id: '',            label: 'Off',          hint: 'use ElevenLabs / browser voice' },
]

const PROVIDER_MODELS: Record<string, { value: string; label: string }[]> = {
  anthropic: [
    { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
    { value: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5' },
    { value: 'claude-opus-4-5-20251101',   label: 'Claude Opus 4.5' },
  ],
  openai: [
    { value: 'gpt-5.2',    label: 'GPT-5.2' },
    { value: 'gpt-5.1',    label: 'GPT-5.1' },
    { value: 'gpt-5',      label: 'GPT-5' },
    { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
    { value: 'gpt-4o',     label: 'GPT-4o' },
  ],
  gemini: [
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3 Pro (preview)' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)' },
    { value: 'gemini-2.5-pro',         label: 'Gemini 2.5 Pro' },
  ],
}

const KEY_FIELDS: Array<{ k: string; label: string; hint: string }> = [
  { k: 'EMERGENT_LLM_KEY',     label: 'Emergent Universal Key',  hint: 'sk-emergent-… · proxies Claude/GPT/Gemini chat.' },
  { k: 'GEMINI_API_KEY',       label: 'Gemini API Key',           hint: 'REQUIRED for Gemini voices · free at aistudio.google.com/apikey.' },
  { k: 'ANTHROPIC_API_KEY',    label: 'Anthropic API Key',        hint: 'Direct Claude access · console.anthropic.com.' },
  { k: 'OPENAI_API_KEY',       label: 'OpenAI API Key',           hint: 'Direct GPT access · platform.openai.com.' },
  { k: 'GROQ_API_KEY',         label: 'Groq API Key',             hint: 'Free fast Llama · console.groq.com.' },
  { k: 'XAI_API_KEY',          label: 'xAI API Key',              hint: 'Grok models · console.x.ai.' },
  { k: 'TAVILY_API_KEY',       label: 'Tavily API Key',           hint: 'Optional · richer web search.' },
  { k: 'ELEVENLABS_API_KEY',   label: 'ElevenLabs API Key',       hint: 'Optional · premium voice (fallback when Gemini absent).' },
  { k: 'PICOVOICE_ACCESS_KEY', label: 'Picovoice Access Key',     hint: 'Optional · hardware-grade wake word.' },
]

const STATE_ACCENT: Record<string, string> = {
  idle: '#8AB4F8', listening: '#FF8A80', transcribing: '#A8D8B9',
  thinking: '#D7AEFB', speaking: '#FBD688', followUp: '#8AB4F8', error: '#F28B82',
}

const FONT_MONO: React.CSSProperties = {
  fontFamily: '"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '0.04em',
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000) % 60
  const m = Math.floor(ms / 60000) % 60
  const h = Math.floor(ms / 3600000)
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}

// ── Main component ─────────────────────────────────────────────────────────
export function PanelView() {
  const [active, setActive] = useState<string>('general')
  const [agentState, setAgentState] = useState<JarvizState | string>('idle')
  const [diag, setDiag] = useState<Diagnostics | null>(null)

  // Settings state
  const [llmBackend, setLlmBackend] = useState('emergent')
  const [emergentProvider, setEmergentProvider] = useState('anthropic')
  const [emergentModel, setEmergentModel] = useState('claude-sonnet-4-5-20250929')
  const [whisperModel, setWhisperModel] = useState('base')
  const [geminiVoice, setGeminiVoice] = useState('Aoede')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [miniMode, setMiniMode] = useState(false)
  const [saved, setSaved] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewMsg, setPreviewMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const [sessions, setSessions] = useState<TranscriptMeta[]>([])
  const [openSession, setOpenSession] = useState<TranscriptFull | null>(null)

  const accent = STATE_ACCENT[agentState] ?? '#8AB4F8'

  // ── Diagnostics + live state ───────────────────────────────────────────
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

  useEffect(() => window.jarviz?.onAgentState?.((s) => setAgentState(s as JarvizState)), [])

  useEffect(() => {
    return window.jarviz.panel.onPreviewAudio(({ audio, mime }) => {
      try {
        const blob = new Blob([new Uint8Array(audio)], { type: mime })
        const url = URL.createObjectURL(blob)
        const a = new Audio(url)
        a.onended = () => URL.revokeObjectURL(url)
        a.onerror = () => URL.revokeObjectURL(url)
        void a.play()
      } catch (e) { console.error('[Panel] preview play failed', e) }
    })
  }, [])

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

  useEffect(() => {
    if (active !== 'transcripts') return
    window.jarviz.transcripts.list().then(setSessions).catch(console.error)
  }, [active])

  useEffect(() => {
    const handler = (_: unknown, section: string): void => {
      if (NAV.some(n => n.id === section)) setActive(section)
    }
    const ipc = (window as unknown as { electron?: { ipcRenderer: { on: (c: string, h: typeof handler) => void; removeListener: (c: string, h: typeof handler) => void } } }).electron
    if (!ipc) return
    ipc.ipcRenderer.on('panel:focus-section', handler)
    return () => ipc.ipcRenderer.removeListener('panel:focus-section', handler)
  }, [])

  const saveSettings = useCallback(async () => {
    const next = {
      ...keys,
      EMERGENT_PROVIDER: emergentProvider,
      EMERGENT_MODEL:    emergentModel,
      GEMINI_TTS_VOICE:  geminiVoice,
    }
    await window.jarviz.settings.set({ llmBackend, whisperModel, envOverrides: next })
    setKeys(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }, [keys, emergentProvider, emergentModel, geminiVoice, llmBackend, whisperModel])

  const previewVoice = useCallback(async () => {
    setPreviewBusy(true)
    setPreviewMsg(null)
    try {
      await saveSettings()
      const r = await window.jarviz.panel.previewVoice(geminiVoice)
      if (r.ok) setPreviewMsg({ kind: 'ok', text: 'Playing preview…' })
      else      setPreviewMsg({ kind: 'err', text: r.error || 'Preview failed.' })
    } catch (e) {
      setPreviewMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setPreviewBusy(false)
    }
  }, [geminiVoice, saveSettings])

  const nav = NAV.find(n => n.id === active) ?? NAV[0]

  return (
    <div style={{
      position:   'fixed',
      inset:      0,
      display:    'flex',
      background: 'linear-gradient(180deg,#1A1C24 0%,#0E0F16 100%)',
      color:      '#E6E7EB',
      fontFamily: '"SF Pro Text","Inter",system-ui,-apple-system,sans-serif',
      fontSize:   13,
      overflow:   'hidden',
    }}>
      {/* ── Sidebar ────────────────────────────────────────────────────── */}
      <aside style={{
        width: 236,
        borderRight: '1px solid rgba(255,255,255,0.06)',
        padding: '44px 10px 14px',
        WebkitAppRegion: 'drag' as never,   // make the sidebar the drag region on macOS
      }}>
        <SidebarGroup title={null}>
          <SidebarItem item={NAV[0]} active={active === NAV[0].id} onClick={() => setActive(NAV[0].id)} />
        </SidebarGroup>

        <SidebarGroup title="Settings">
          {NAV.filter(n => n.group === 'settings' && n.id !== 'general').map(n => (
            <SidebarItem key={n.id} item={n} active={active === n.id} onClick={() => setActive(n.id)} />
          ))}
        </SidebarGroup>

        <SidebarGroup title="Jarviz">
          {NAV.filter(n => n.group === 'jarviz').map(n => (
            <SidebarItem key={n.id} item={n} active={active === n.id} onClick={() => setActive(n.id)} />
          ))}
        </SidebarGroup>
      </aside>

      {/* ── Main content pane ─────────────────────────────────────────── */}
      <main style={{ flex: 1, overflow: 'auto', padding: '38px 28px 32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 22 }}>
          <IconTile gradient={nav.gradient} size={28}>{nav.icon}</IconTile>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: '-0.01em' }}>{nav.label}</h1>
          <span style={{ flex: 1 }} />
          {/* State dot */}
          <span style={{
            ...FONT_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.14em',
            textTransform: 'uppercase', opacity: 0.7, display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: accent, boxShadow: `0 0 6px ${accent}` }} />
            {String(agentState).toUpperCase()}
          </span>
        </div>

        {active === 'general' && (
          <GeneralPane
            miniMode={miniMode}
            onToggleMini={() => {
              const next = !miniMode
              setMiniMode(next)
              void window.jarviz.setMini(next)
            }}
          />
        )}

        {active === 'voice' && (
          <VoicePane
            voice={geminiVoice}
            onChange={setGeminiVoice}
            onSave={saveSettings}
            onPreview={previewVoice}
            previewBusy={previewBusy}
            previewMsg={previewMsg}
            saved={saved}
            hasKey={!!diag?.envHasGeminiKey}
          />
        )}

        {active === 'llm' && (
          <LLMPane
            llmBackend={llmBackend} setLlmBackend={setLlmBackend}
            emergentProvider={emergentProvider} setEmergentProvider={setEmergentProvider}
            emergentModel={emergentModel} setEmergentModel={setEmergentModel}
            whisperModel={whisperModel} setWhisperModel={setWhisperModel}
            onSave={saveSettings} saved={saved}
          />
        )}

        {active === 'keys' && (
          <KeysPane keys={keys} setKeys={setKeys} onSave={saveSettings} saved={saved} />
        )}

        {active === 'wake' && (
          <WakePane keys={keys} setKeys={setKeys} onSave={saveSettings} saved={saved} />
        )}

        {active === 'transcripts' && (
          <TranscriptsPane
            sessions={sessions}
            openSession={openSession}
            setOpenSession={setOpenSession}
            refresh={() => window.jarviz.transcripts.list().then(setSessions)}
          />
        )}

        {active === 'status' && diag && <StatusPane diag={diag} accent={accent} />}

        {active === 'about' && <AboutPane />}
      </main>
    </div>
  )
}

// ── Sidebar primitives ─────────────────────────────────────────────────────

function SidebarGroup({ title, children }: { title: string | null; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {title && (
        <div style={{
          fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.14em',
          opacity: 0.5, fontWeight: 700, padding: '6px 10px 6px',
        }}>
          {title}
        </div>
      )}
      {children}
    </div>
  )
}

function SidebarItem({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={`sidebar-${item.id}`}
      onClick={onClick}
      disabled={item.soon}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', padding: '6px 10px',
        borderRadius: 8, border: 'none',
        cursor: item.soon ? 'not-allowed' : 'pointer',
        background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
        color: active ? '#fff' : 'rgba(230,231,235,0.90)',
        fontSize: 13.5, fontWeight: 500,
        transition: 'background 0.15s',
        marginBottom: 2,
        WebkitAppRegion: 'no-drag' as never,
      }}
      onMouseEnter={(e) => { if (!active && !item.soon) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)' }}
      onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
    >
      <IconTile gradient={item.gradient} size={26}>{item.icon}</IconTile>
      <span style={{ flex: 1, textAlign: 'left', opacity: item.soon ? 0.5 : 1 }}>{item.label}</span>
      {item.soon && (
        <span style={{
          fontSize: 9.5, padding: '2px 7px', borderRadius: 6,
          background: 'rgba(255,255,255,0.08)', opacity: 0.8,
        }}>Soon</span>
      )}
    </button>
  )
}

function IconTile({ gradient, size, children }: { gradient: string; size: number; children: React.ReactNode }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: Math.round(size * 0.27),
      background: gradient,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.15), 0 1px 2px rgba(0,0,0,0.3)',
      flexShrink: 0,
    }}>
      {children}
    </span>
  )
}

// ── Row primitives (Klack-style grouped cards) ─────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 12,
      overflow: 'hidden',
      marginBottom: 16,
    }}>
      {children}
    </div>
  )
}

function Row({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '12px 16px',
      minHeight: 44,
      borderTop: first ? 'none' : '1px solid rgba(255,255,255,0.06)',
      gap: 14,
    }}>
      {children}
    </div>
  )
}

function RowLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13.5, color: '#E6E7EB' }}>{children}</div>
      {hint && <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 2, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  )
}

function Toggle({ checked, onChange, 'data-testid': testId }: { checked: boolean; onChange: (v: boolean) => void; 'data-testid'?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => onChange(!checked)}
      style={{
        width: 42, height: 24, borderRadius: 14,
        border: 'none', cursor: 'pointer',
        background: checked ? 'linear-gradient(135deg,#4285F4,#A142F4)' : 'rgba(255,255,255,0.12)',
        position: 'relative',
        transition: 'background 0.2s',
        padding: 0,
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2, left: checked ? 20 : 2,
        width: 20, height: 20, borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
        transition: 'left 0.2s',
      }} />
    </button>
  )
}

function Select({ value, onChange, children, 'data-testid': testId, width }: {
  value: string; onChange: (v: string) => void; children: React.ReactNode
  'data-testid'?: string; width?: number | string
}) {
  return (
    <select
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        appearance: 'none',
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.10)',
        color: '#E6E7EB',
        padding: '7px 28px 7px 12px',
        borderRadius: 8,
        fontSize: 13,
        cursor: 'pointer',
        minWidth: width ?? 180,
        backgroundImage: 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\'><path fill=\'%23888\' d=\'M0 0l5 6 5-6z\'/></svg>")',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 10px center',
      }}
    >
      {children}
    </select>
  )
}

function TextInput({ value, onChange, placeholder, password, 'data-testid': testId }: {
  value: string; onChange: (v: string) => void; placeholder?: string; password?: boolean
  'data-testid'?: string
}) {
  return (
    <input
      data-testid={testId}
      type={password ? 'password' : 'text'}
      value={value}
      placeholder={placeholder}
      autoComplete="off"
      onChange={(e) => onChange(e.target.value)}
      style={{
        flex: 1, minWidth: 240,
        padding: '7px 12px',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.10)',
        background: 'rgba(255,255,255,0.04)',
        color: '#E6E7EB',
        fontSize: 12.5,
        fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
      }}
    />
  )
}

function Button({ children, onClick, variant = 'secondary', disabled, 'data-testid': testId, width }: {
  children: React.ReactNode; onClick: () => void
  variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean
  'data-testid'?: string; width?: number | string
}) {
  const bg = variant === 'primary'
    ? 'linear-gradient(135deg,#4285F4,#A142F4)'
    : variant === 'danger'
      ? 'rgba(234,67,53,0.18)'
      : 'rgba(255,255,255,0.08)'
  const border = variant === 'danger' ? '1px solid rgba(234,67,53,0.40)' : '1px solid rgba(255,255,255,0.10)'
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '7px 14px', borderRadius: 8, border, cursor: disabled ? 'wait' : 'pointer',
        background: disabled ? 'rgba(120,120,120,0.15)' : bg,
        color: '#fff', fontSize: 12.5, fontWeight: 600,
        width,
      }}
    >
      {children}
    </button>
  )
}

function SectionHint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, opacity: 0.55, lineHeight: 1.55, marginBottom: 12 }}>{children}</div>
}

function Banner({ kind, children }: { kind: 'info' | 'warn' | 'err' | 'ok'; children: React.ReactNode }) {
  const palette = {
    info: { bg: 'rgba(66,133,244,0.10)', bd: 'rgba(66,133,244,0.30)', fg: '#8AB4F8' },
    warn: { bg: 'rgba(251,188,4,0.10)',  bd: 'rgba(251,188,4,0.30)',  fg: '#FBD688' },
    err:  { bg: 'rgba(242,139,130,0.10)',bd: 'rgba(242,139,130,0.30)',fg: '#FFB4AB' },
    ok:   { bg: 'rgba(52,168,83,0.10)',  bd: 'rgba(52,168,83,0.30)',  fg: '#A8D8B9' },
  }[kind]
  return (
    <div style={{
      marginBottom: 14, padding: '10px 12px', borderRadius: 10,
      background: palette.bg, border: `1px solid ${palette.bd}`, color: palette.fg,
      fontSize: 12, lineHeight: 1.5,
    }}>
      {children}
    </div>
  )
}

function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 40, height: 40, padding: '0 8px',
      borderRadius: 8,
      background: 'linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.02))',
      border: '1px solid rgba(255,255,255,0.10)',
      boxShadow: 'inset 0 -2px 0 rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.3)',
      fontSize: 13, fontWeight: 500, color: '#E6E7EB',
    }}>
      {children}
    </span>
  )
}

// ── Panes ───────────────────────────────────────────────────────────────────

function GeneralPane({ miniMode, onToggleMini }: { miniMode: boolean; onToggleMini: () => void }) {
  return (
    <>
      <Card>
        <Row first>
          <RowLabel hint="Compact 64px orb for unobtrusive operation. Cmd+Shift+M.">Mini orb mode</RowLabel>
          <Toggle checked={miniMode} onChange={onToggleMini} data-testid="toggle-mini" />
        </Row>
      </Card>

      <h2 style={sectionHeadingStyle}>Wake hotkey</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <KeyCap>⌘</KeyCap>
        <KeyCap>⇧</KeyCap>
        <KeyCap>J</KeyCap>
      </div>
      <SectionHint>
        Trigger Jarviz from anywhere with this shortcut, even when the orb is hidden behind other windows.
      </SectionHint>

      <h2 style={sectionHeadingStyle}>Other shortcuts</h2>
      <Card>
        <Row first><RowLabel>Open panel</RowLabel><ShortcutCaps parts={['⌘','⇧','P']} /></Row>
        <Row><RowLabel>Settings (this window)</RowLabel><ShortcutCaps parts={['⌘',',']} /></Row>
        <Row><RowLabel>Transcripts</RowLabel><ShortcutCaps parts={['⌘','⇧','T']} /></Row>
        <Row><RowLabel>Cancel current request</RowLabel><ShortcutCaps parts={['Esc']} /></Row>
      </Card>
    </>
  )
}

function ShortcutCaps({ parts }: { parts: string[] }) {
  return (
    <div style={{ display: 'flex', gap: 5 }}>
      {parts.map(p => <span key={p} style={{
        ...FONT_MONO, fontSize: 11,
        padding: '3px 8px', borderRadius: 6,
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.25)',
      }}>{p}</span>)}
    </div>
  )
}

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
  opacity: 0.55, margin: '18px 0 8px',
}

interface VoicePaneProps {
  voice: string
  onChange: (v: string) => void
  onSave: () => Promise<void>
  onPreview: () => Promise<void>
  previewBusy: boolean
  previewMsg: { kind: 'ok' | 'err'; text: string } | null
  saved: boolean
  hasKey: boolean
}
function VoicePane({ voice, onChange, onSave, onPreview, previewBusy, previewMsg, saved, hasKey }: VoicePaneProps) {
  return (
    <>
      {!hasKey && (
        <Banner kind="warn">
          Gemini voices need a free <strong>GEMINI_API_KEY</strong>. Add it in the API Keys tab to hear
          the selected voice — without it, Jarviz falls back to your browser TTS voice.
        </Banner>
      )}
      <Card>
        <Row first>
          <RowLabel hint="Prebuilt voices via Google Gemini TTS.">Voice</RowLabel>
          <Select value={voice} onChange={onChange} data-testid="panel-voice-select" width={260}>
            {GEMINI_VOICES.map(v => (
              <option key={v.id} value={v.id}>
                {v.label}{v.id ? ` — ${v.hint}` : ''}
              </option>
            ))}
          </Select>
        </Row>
      </Card>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" onClick={onPreview} disabled={previewBusy} data-testid="panel-voice-preview">
          {previewBusy ? '… synthesising' : '▷  Preview voice'}
        </Button>
        <Button onClick={onSave} data-testid="panel-voice-save">{saved ? '✓  Saved' : 'Save'}</Button>
      </div>

      {previewMsg && (
        <div style={{ marginTop: 12 }}>
          <Banner kind={previewMsg.kind === 'ok' ? 'ok' : 'err'}>{previewMsg.text}</Banner>
        </div>
      )}
    </>
  )
}

interface LLMProps {
  llmBackend: string; setLlmBackend: (v: string) => void
  emergentProvider: string; setEmergentProvider: (v: string) => void
  emergentModel: string; setEmergentModel: (v: string) => void
  whisperModel: string; setWhisperModel: (v: string) => void
  onSave: () => Promise<void>; saved: boolean
}
function LLMPane(p: LLMProps) {
  useEffect(() => {
    const list = PROVIDER_MODELS[p.emergentProvider]
    if (list && !list.some(m => m.value === p.emergentModel)) p.setEmergentModel(list[0].value)
  }, [p.emergentProvider, p.emergentModel, p])

  return (
    <>
      <Card>
        <Row first>
          <RowLabel hint="Universal key proxies all three; or bring your own.">Backend</RowLabel>
          <Select value={p.llmBackend} onChange={p.setLlmBackend} data-testid="panel-backend-select">
            <option value="emergent">Emergent Universal</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Google Gemini</option>
            <option value="groq">Groq</option>
            <option value="xai">xAI Grok</option>
          </Select>
        </Row>

        {p.llmBackend === 'emergent' && (
          <>
            <Row>
              <RowLabel>Provider</RowLabel>
              <Select value={p.emergentProvider} onChange={p.setEmergentProvider}>
                <option value="anthropic">Anthropic Claude</option>
                <option value="openai">OpenAI GPT</option>
                <option value="gemini">Google Gemini</option>
              </Select>
            </Row>
            <Row>
              <RowLabel>Model</RowLabel>
              <Select value={p.emergentModel} onChange={p.setEmergentModel}>
                {(PROVIDER_MODELS[p.emergentProvider] ?? []).map(m =>
                  <option key={m.value} value={m.value}>{m.label}</option>)}
              </Select>
            </Row>
          </>
        )}
      </Card>

      <h2 style={sectionHeadingStyle}>Speech recognition</h2>
      <Card>
        <Row first>
          <RowLabel hint="Local Whisper. Larger = more accurate, slower.">Whisper model</RowLabel>
          <Select value={p.whisperModel} onChange={p.setWhisperModel}>
            <option value="tiny">tiny (39 MB · fastest)</option>
            <option value="base">base (145 MB · balanced)</option>
            <option value="small">small (466 MB · accurate)</option>
            <option value="medium">medium (1.5 GB)</option>
            <option value="large-v3">large-v3 (3 GB · best)</option>
          </Select>
        </Row>
      </Card>

      <Button variant="primary" onClick={p.onSave} data-testid="panel-llm-save">
        {p.saved ? '✓  Saved' : 'Save'}
      </Button>
    </>
  )
}

interface KeysProps {
  keys: Record<string, string>
  setKeys: React.Dispatch<React.SetStateAction<Record<string, string>>>
  onSave: () => Promise<void>; saved: boolean
}
function KeysPane(p: KeysProps) {
  return (
    <>
      <SectionHint>
        Keys are stored locally in electron-store. They never leave your machine except to the chosen provider.
      </SectionHint>
      <Card>
        {KEY_FIELDS.map((f, i) => (
          <Row key={f.k} first={i === 0}>
            <RowLabel hint={f.hint}>{f.label}</RowLabel>
            <TextInput
              value={p.keys[f.k] ?? ''}
              onChange={(v) => p.setKeys(prev => ({ ...prev, [f.k]: v }))}
              placeholder={f.hint}
              password
              data-testid={`panel-key-${f.k.toLowerCase()}`}
            />
          </Row>
        ))}
      </Card>
      <Button variant="primary" onClick={p.onSave} data-testid="panel-keys-save">
        {p.saved ? '✓  Saved' : 'Save'}
      </Button>
    </>
  )
}

function WakePane(p: KeysProps) {
  return (
    <>
      <SectionHint>
        Jarviz listens for "Hey Jarviz" or "Jarvis" using a local VAD + Whisper.
        For sub-1% CPU hardware-grade detection, add a <strong>Picovoice access key</strong> (free tier).
      </SectionHint>
      <Card>
        <Row first>
          <RowLabel hint="Optional — upgrades wake word to Picovoice Porcupine.">Picovoice access key</RowLabel>
          <TextInput
            value={p.keys.PICOVOICE_ACCESS_KEY ?? ''}
            onChange={(v) => p.setKeys(prev => ({ ...prev, PICOVOICE_ACCESS_KEY: v }))}
            placeholder="Paste key from console.picovoice.ai"
            password
          />
        </Row>
      </Card>
      <h2 style={sectionHeadingStyle}>Activation</h2>
      <Card>
        <Row first><RowLabel>Voice wake phrase</RowLabel>
          <span style={{ ...FONT_MONO, fontSize: 12, opacity: 0.85 }}>"Hey Jarviz" · "Jarvis"</span>
        </Row>
        <Row><RowLabel>Keyboard shortcut</RowLabel>
          <ShortcutCaps parts={['⌘','⇧','J']} />
        </Row>
      </Card>
      <Button variant="primary" onClick={p.onSave}>{p.saved ? '✓ Saved' : 'Save'}</Button>
    </>
  )
}

interface TranscriptsProps {
  sessions: TranscriptMeta[]
  openSession: TranscriptFull | null
  setOpenSession: (s: TranscriptFull | null) => void
  refresh: () => Promise<void>
}
function TranscriptsPane(p: TranscriptsProps) {
  const open = async (id: string): Promise<void> => {
    const s = await window.jarviz.transcripts.get(id)
    if (s) p.setOpenSession(s)
  }
  const del = async (id: string): Promise<void> => {
    if (!confirm('Delete this conversation?')) return
    await window.jarviz.transcripts.delete(id)
    if (p.openSession?.id === id) p.setOpenSession(null)
    void p.refresh()
  }

  if (p.openSession) {
    return (
      <>
        <div style={{ marginBottom: 10 }}>
          <Button onClick={() => p.setOpenSession(null)}>← Back</Button>
        </div>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>{p.openSession.preview || '(empty)'}</div>
        {p.openSession.turns.map((t, i) => (
          <Card key={i}>
            <div style={{ padding: 14 }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
                opacity: 0.7, color: t.role === 'user' ? '#8AB4F8' : '#FBBC04',
                marginBottom: 6,
              }}>
                {t.role === 'user' ? 'YOU' : 'JARVIZ'} · {new Date(t.ts).toLocaleTimeString()}
              </div>
              <div style={{ lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{t.text}</div>
            </div>
          </Card>
        ))}
        <Button variant="danger" onClick={() => del(p.openSession!.id)}>Delete session</Button>
      </>
    )
  }

  return (
    <>
      <SectionHint>{p.sessions.length} saved conversations. Auto-resume within 5 min.</SectionHint>
      {p.sessions.length === 0 && <Banner kind="info">No saved conversations yet. Talk to Jarviz and they'll appear here.</Banner>}
      {p.sessions.length > 0 && (
        <Card>
          {p.sessions.map((s, i) => (
            <button
              key={s.id}
              type="button"
              data-testid={`panel-transcript-${s.id}`}
              onClick={() => open(s.id)}
              style={{
                display: 'flex', alignItems: 'center',
                width: '100%', padding: '12px 16px',
                background: 'transparent', border: 'none',
                borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.06)',
                cursor: 'pointer', color: '#E6E7EB', textAlign: 'left',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.preview || '(empty)'}
                </div>
                <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>
                  {new Date(s.startedAt).toLocaleString()} · {s.turns} turns
                </div>
              </div>
              <span style={{ opacity: 0.4, fontSize: 14 }}>›</span>
            </button>
          ))}
        </Card>
      )}
      {p.sessions.length > 0 && (
        <Button variant="danger" onClick={async () => {
          if (!confirm('Delete ALL saved conversations?')) return
          await window.jarviz.transcripts.clear()
          void p.refresh()
        }}>Clear all</Button>
      )}
    </>
  )
}

function StatusPane({ diag, accent }: { diag: Diagnostics; accent: string }) {
  return (
    <>
      <Card>
        <Row first><RowLabel>Platform</RowLabel><span style={FONT_MONO}>{diag.platform}</span></Row>
        <Row><RowLabel>Uptime</RowLabel><span style={FONT_MONO}>{fmtUptime(diag.uptimeMs)}</span></Row>
        <Row><RowLabel>Memory</RowLabel><span style={FONT_MONO}>{diag.memoryMB.toFixed(0)} MB</span></Row>
        <Row><RowLabel>LLM backend</RowLabel><span style={{ color: accent, fontWeight: 600 }}>{diag.llmBackend}</span></Row>
      </Card>

      <h2 style={sectionHeadingStyle}>Configuration health</h2>
      <Card>
        <Row first>
          <RowLabel>Universal key</RowLabel>
          <span style={{ color: diag.envHasEmergentKey ? '#A8D8B9' : '#F28B82' }}>
            {diag.envHasEmergentKey ? '✓ set' : '✗ missing'}
          </span>
        </Row>
        <Row>
          <RowLabel hint={!diag.envHasGeminiKey ? 'Needed for Gemini voices. Falls back to browser TTS otherwise.' : undefined}>
            Gemini key
          </RowLabel>
          <span style={{ color: diag.envHasGeminiKey ? '#A8D8B9' : '#F28B82' }}>
            {diag.envHasGeminiKey ? '✓ set' : '✗ missing'}
          </span>
        </Row>
        <Row>
          <RowLabel>Active voice</RowLabel>
          <span style={{ color: accent, fontWeight: 600 }}>{diag.envGeminiVoice || '— off —'}</span>
        </Row>
      </Card>
    </>
  )
}

function AboutPane() {
  return (
    <>
      <Card>
        <Row first><RowLabel>Jarviz</RowLabel><span>v0.6</span></Row>
        <Row><RowLabel>Built with</RowLabel><span>Electron 35 · React 18 · Three.js 0.176</span></Row>
        <Row><RowLabel>LLM</RowLabel><span>Claude Sonnet 4.5 · GPT-5.2 · Gemini 3 Pro</span></Row>
        <Row><RowLabel>Voice</RowLabel><span>Gemini TTS · ElevenLabs fallback</span></Row>
      </Card>
      <SectionHint>
        Jarviz is an autonomous desktop agent modeled after Iron Man's JARVIS.
        All voice processing runs locally. Only chat + tool results travel to the chosen LLM.
      </SectionHint>
    </>
  )
}

// ── Icon components ────────────────────────────────────────────────────────

function svgProps(size = 14) {
  return {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'white', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  }
}

function GearIcon()  {
  return <svg {...svgProps(14)}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
}
function VoiceIcon() {
  return <svg {...svgProps(14)}><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
}
function SparkIcon() {
  return <svg {...svgProps(14)}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
}
function KeyIcon() {
  return <svg {...svgProps(14)}><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15L19 4M18 5l2 2M15 8l2 2"/></svg>
}
function WaveIcon() {
  return <svg {...svgProps(14)}><path d="M2 12h3M19 12h3M7 8v8M11 4v16M15 8v8"/></svg>
}
function ChatIcon() {
  return <svg {...svgProps(14)}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
}
function ChartIcon() {
  return <svg {...svgProps(14)}><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/></svg>
}
function InfoIcon() {
  return <svg {...svgProps(14)}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
}
