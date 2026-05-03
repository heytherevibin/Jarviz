import { useEffect, useLayoutEffect, useState, useCallback, useRef, createContext, useContext, useMemo } from 'react'
import type { JarvizState } from './state/JarvizFSM'
import { MemoryTab } from './panel/MemoryTab'
import { ToolsTab } from './panel/ToolsTab'

/**
 * Menubar panel — opens from the tray icon on macOS / Windows / Linux.
 * Tray popover: status, Setup, Voice, transcripts. Matches main PANEL_* (~392×620).
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
        get: () => Promise<{ envOverrides: Record<string, string>; llmBackend: string; whisperModel: string; wakeWordMode: 'phrases' | 'picovoice' }>
        set: (patch: { envOverrides?: Record<string, string>; llmBackend?: string; whisperModel?: string; wakeWordMode?: 'phrases' | 'picovoice' }) => Promise<boolean>
      }
      transcripts: {
        list:       () => Promise<Array<{ id: string; startedAt: number; endedAt: number; preview: string; turns: number }>>
        get:        (id: string) => Promise<{ id: string; startedAt: number; endedAt: number; preview: string; turns: Array<{ role: string; text: string; ts: number }> } | null>
        delete:     (id: string) => Promise<boolean>
        clear:      () => Promise<boolean>
        newSession: () => Promise<boolean>
      }
      app: {
        getLaunchAtLogin: () => Promise<boolean>
        setLaunchAtLogin: (on: boolean) => Promise<boolean>
        getJarvizEnabled: () => Promise<boolean>
        setJarvizEnabled: (on: boolean) => Promise<boolean>
        onJarvizSetEnabled: (cb: (enabled: boolean) => void) => () => void
      }
      memory: {
        list: (opts?: { kind?: string; projectRoot?: string; limit?: number }) => Promise<Array<{ id: string; kind: string; title: string; text: string; tags: string[]; projectRoot?: string; createdAt: number; updatedAt: number }>>
        search: (query: string, opts?: { kind?: string; projectRoot?: string; limit?: number }) => Promise<Array<{ id: string; kind: string; title: string; text: string; tags: string[]; projectRoot?: string; createdAt: number; updatedAt: number }>>
        upsert: (item: { id?: string; kind: string; title: string; text: string; tags?: string[]; projectRoot?: string }) => Promise<{ id: string; kind: string; title: string; text: string; tags: string[]; projectRoot?: string; createdAt: number; updatedAt: number }>
        delete: (id: string) => Promise<boolean>
        syncEnabledGet: () => Promise<boolean>
        syncEnabledSet: (on: boolean) => Promise<boolean>
      }
      agentAdmin: {
        permissionsGet: () => Promise<{ tools: Record<string, 'allow' | 'ask' | 'deny'>; allowedRoots: string[] }>
        permissionsSet: (next: { tools: Record<string, 'allow' | 'ask' | 'deny'>; allowedRoots: string[] }) => Promise<{ tools: Record<string, 'allow' | 'ask' | 'deny'>; allowedRoots: string[] }>
        activityList: (limit?: number) => Promise<Array<{ id: string; ts: number; type: string; label: string; detail?: string }>>
      }
      system: {
        openMacPrivacyPane: (pane: string) => Promise<boolean>
      }
      setMini: (on: boolean) => Promise<boolean>
      getMini: () => Promise<boolean>
      installUpdate: () => Promise<boolean>
      onUpdaterStatus: (cb: (s: { state: string; progress?: number }) => void) => () => void
      onPanelFocusSection: (cb: (section: string) => void) => () => void
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

/** Friendly labels for the menubar header */
const STATE_LABEL_UI: Record<string, string> = {
  idle: 'Ready',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  speaking: 'Speaking',
  followUp: 'Ready',
  error: 'Error',
}

/** Dark menubar popover vs framed settings window (system-like) */
const POPOVER_CHROME = {
  hairline:      'rgba(255,255,255,0.09)',
  fillCard:      'linear-gradient(168deg, rgba(42,42,50,0.92) 0%, rgba(26,26,32,0.96) 45%, rgba(20,20,26,0.98) 100%)',
  fillGroup:     'rgba(255,255,255,0.04)',
  fillGroupHd:   'rgba(0,0,0,0.18)',
  segTrack:      'rgba(0,0,0,0.32)',
  shadow:        '0 28px 90px rgba(0,0,0,0.52), 0 0 0 1px rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.06)',
  radiusOut:     14,
  radiusIn:      10,
  radiusSeg:     8,
  textMain:      'rgba(255,255,255,0.92)',
  textSub:       'rgba(255,255,255,0.52)',
  textSoft:      'rgba(255,255,255,0.42)',
  titleColor:    'rgba(255,255,255,0.96)',
  segActive:     'rgba(255,255,255,0.95)',
  segIdle:       'rgba(255,255,255,0.42)',
  pageTint:      'transparent',
  inputBg:       'rgba(0,0,0,0.35)',
  buttonRowBg:   'rgba(255,255,255,0.08)',
  uiMode:        'solid' as const,
} as const

/** Windows / non-vibrant settings — light split-pane (same structure as Mac, no vibrancy) */
const NATIVE_CHROME = {
  hairline:      'rgba(0,0,0,0.1)',
  fillCard:      '#e8e8ed',
  fillGroup:      '#ffffff',
  fillGroupHd:    'rgba(0,0,0,0.04)',
  segTrack:      'rgba(0,0,0,0.08)',
  shadow:        'none',
  radiusOut:     8,
  radiusIn:      8,
  radiusSeg:     6,
  textMain:      'rgba(0,0,0,0.88)',
  textSub:       'rgba(0,0,0,0.48)',
  textSoft:      'rgba(0,0,0,0.38)',
  titleColor:    'rgba(0,0,0,0.9)',
  segActive:     'rgba(0,0,0,0.92)',
  segIdle:       'rgba(0,0,0,0.45)',
  pageTint:      '#ececec',
  inputBg:       '#ffffff',
  buttonRowBg:   '#f2f2f5',
  uiMode:        'solid' as const,
} as const

/** macOS + window vibrancy — layered translucent stacks (reads over NSVisualEffectView) */
const NATIVE_GLASS_CHROME = {
  hairline:      'rgba(255,255,255,0.09)',
  fillCard:      'transparent',
  fillGroup:     'rgba(255,255,255,0.055)',
  fillGroupHd:   'rgba(0,0,0,0.22)',
  segTrack:      'rgba(255,255,255,0.07)',
  shadow:        '0 24px 80px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.14)',
  radiusOut:     16,
  radiusIn:      11,
  radiusSeg:     8,
  textMain:      'rgba(255,255,255,0.94)',
  textSub:       'rgba(255,255,255,0.48)',
  textSoft:      'rgba(255,255,255,0.34)',
  titleColor:    'rgba(255,255,255,0.98)',
  segActive:     'rgba(255,255,255,0.95)',
  segIdle:       'rgba(255,255,255,0.4)',
  pageTint:      'transparent',
  inputBg:       'rgba(0,0,0,0.32)',
  buttonRowBg:   'rgba(255,255,255,0.08)',
  uiMode:        'glass' as const,
} as const

type PanelChrome = typeof POPOVER_CHROME

const PanelChromeCtx = createContext<PanelChrome>(POPOVER_CHROME)
function useCx(): PanelChrome {
  return useContext(PanelChromeCtx)
}

function useFields(): { cx: PanelChrome; selectStyle: React.CSSProperties; inputStyle: React.CSSProperties; buttonSecondary: React.CSSProperties } {
  const cx = useCx()
  return useMemo(() => ({
    cx,
    selectStyle: {
      display: 'block', width: '100%', padding: '10px 12px', borderRadius: 8,
      border: `1px solid ${cx.hairline}`, background: cx.inputBg, color: cx.textMain,
      fontSize: 13, appearance: 'none', cursor: 'pointer', outline: 'none',
    },
    inputStyle: {
      display: 'block', width: '100%', padding: '10px 12px', borderRadius: 8,
      border: `1px solid ${cx.hairline}`, background: cx.inputBg, color: cx.textMain,
      fontSize: 12, fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace', outline: 'none',
    },
    buttonSecondary: {
      padding: '9px 14px', borderRadius: 8, border: `1px solid ${cx.hairline}`,
      cursor: 'pointer', fontSize: 12, fontWeight: 600, background: cx.buttonRowBg, color: cx.textMain,
    },
  }), [cx])
}

type SettingsTabId = 'voice' | 'keys' | 'transcripts' | 'memory' | 'privacy'

type SettingsNavEntry = {
  id: SettingsTabId
  /** Sidebar row */
  label: string
  /** Narrow menubar popover segment */
  segmentLabel: string
  paneTitle: string
  paneSubtitle: string
}

/** Grouped like System Settings: product areas, then app-specific surfaces */
const SETTINGS_NAV_GROUPS: { section: string; items: SettingsNavEntry[] }[] = [
  {
    section: 'Preferences',
    items: [
      { id: 'voice', label: 'Voice & speech', segmentLabel: 'Voice', paneTitle: 'Voice & speech', paneSubtitle: 'Gemini voices, preview, and spoken output quality.' },
      { id: 'keys', label: 'Models & keys', segmentLabel: 'Models', paneTitle: 'Models & API keys', paneSubtitle: 'Session info, app behavior, LLM routing, Whisper, wake word, and API keys.' },
    ],
  },
  {
    section: 'Jarviz',
    items: [
      { id: 'transcripts', label: 'Transcripts', segmentLabel: 'History', paneTitle: 'Transcripts', paneSubtitle: 'Saved sessions from this device.' },
      { id: 'memory', label: 'Memory', segmentLabel: 'Memory', paneTitle: 'Memory', paneSubtitle: 'Structured notes the agent can retrieve during tasks.' },
      { id: 'privacy', label: 'Privacy & system', segmentLabel: 'Privacy', paneTitle: 'Privacy & system', paneSubtitle: 'macOS permissions and a concise activity log.' },
    ],
  },
]

const SETTINGS_NAV_FLAT = SETTINGS_NAV_GROUPS.flatMap((g) => g.items)

function SettingsNavGlyph({ tab, color }: { tab: SettingsTabId; color: string }): JSX.Element {
  const s: React.CSSProperties = { width: 18, height: 18, display: 'block', flexShrink: 0 }
  const o = { fill: 'none' as const, stroke: color, strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (tab) {
    case 'voice':
      return (
        <svg viewBox="0 0 24 24" style={s} aria-hidden>
          <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Z" {...o} />
          <path d="M19 11a7 7 0 0 1-14 0M12 18v3" {...o} />
        </svg>
      )
    case 'keys':
      return (
        <svg viewBox="0 0 24 24" style={s} aria-hidden>
          <circle cx="8" cy="8" r="2.2" {...o} />
          <path d="M10.5 8h9M17.5 8v6a2 2 0 0 1-2 2h-5" {...o} />
          <path d="M6 12h4M6 16h4" {...o} />
        </svg>
      )
    case 'transcripts':
      return (
        <svg viewBox="0 0 24 24" style={s} aria-hidden>
          <path d="M8 9h8M8 13h5M8 17h6" {...o} />
          <rect x="4" y="5" width="16" height="14" rx="2.5" {...o} />
        </svg>
      )
    case 'memory':
      return (
        <svg viewBox="0 0 24 24" style={s} aria-hidden>
          <path d="M6 8h12v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V8Z" {...o} />
          <path d="M6 11h12M9 8V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" {...o} />
        </svg>
      )
    case 'privacy':
      return (
        <svg viewBox="0 0 24 24" style={s} aria-hidden>
          <path d="M12 21s7-4.35 7-11V6l-7-3-7 3v4c0 6.65 7 11 7 11Z" {...o} />
          <path d="m9 12 2 2 4-4" {...o} />
        </svg>
      )
    default:
      return <svg viewBox="0 0 24 24" style={s} aria-hidden />
  }
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
  PICOVOICE_ACCESS_KEY:'Only if wake engine = Picovoice (console.picovoice.ai). Default wake uses phrases, no Picovoice key needed.',
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
  const [tab, setTab] = useState<SettingsTabId>('keys')
  const [agentState, setAgentState] = useState<JarvizState | string>('idle')
  const [caption, setCaption] = useState({ phase: 'STANDBY', user: '', reply: '' })
  const [diag, setDiag] = useState<Diagnostics | null>(null)

  // Settings state
  const [llmBackend, setLlmBackend] = useState('emergent')
  const [emergentProvider, setEmergentProvider] = useState('anthropic')
  const [emergentModel, setEmergentModel] = useState('claude-sonnet-4-5-20250929')
  const [whisperModel, setWhisperModel] = useState('base')
  const [wakeWordMode, setWakeWordMode] = useState<'phrases' | 'picovoice'>('phrases')
  const [geminiVoice, setGeminiVoice] = useState('Aoede')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [miniMode, setMiniMode] = useState(false)
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  const [memorySync, setMemorySync] = useState(false)

  // Transcripts state
  const [sessions, setSessions] = useState<Array<{ id: string; startedAt: number; endedAt: number; preview: string; turns: number }>>([])
  const [openSession, setOpenSession] = useState<{ id: string; preview: string; turns: Array<{ role: string; text: string; ts: number }> } | null>(null)

  const accent = STATE_ACCENT[agentState] ?? '#8AB4F8'
  const stateLabelUi = STATE_LABEL_UI[agentState] ?? String(agentState).replace(/^./, c => c.toUpperCase())

  const nativeUi = useMemo(() => {
    const v = new URLSearchParams(window.location.search).get('view')
    return v === 'settings' || v === 'panel'
  }, [])
  const isMacUi = useMemo(
    () => typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || ''),
    [],
  )
  const glassUi = nativeUi && isMacUi
  const cx = nativeUi ? (glassUi ? NATIVE_GLASS_CHROME : NATIVE_CHROME) : POPOVER_CHROME

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

  // Listen for "focus this section" from main — useLayoutEffect so IPC fired right after show still applies.
  useLayoutEffect(() => {
    return window.jarviz.onPanelFocusSection((section: string) => {
      if (section === 'keys' || section === 'setup') setTab('keys')
      else if (section === 'voice')  setTab('voice')
      else if (section === 'transcripts' || section === 'history') setTab('transcripts')
      else if (section === 'memory') setTab('memory')
      else if (section === 'privacy' || section === 'tools') setTab('privacy')
      else if (section === 'status') setTab('keys')
    })
  }, [])

  // Subscribe to live agent state + caption
  useEffect(() => {
    const unState   = window.jarviz?.onAgentState?.((s) => setAgentState(s as JarvizState))
    const unCaption = window.jarviz?.onCaption?.((c) => setCaption(c))
    return () => { unState?.(); unCaption?.() }
  }, [])

  // Load settings on first mount
  const loadSettings = useCallback(async () => {
    const [s, mini, launch] = await Promise.all([
      window.jarviz.settings.get(),
      window.jarviz.getMini(),
      window.jarviz.app.getLaunchAtLogin(),
    ])
    setLlmBackend(s.llmBackend || 'emergent')
    setWhisperModel(s.whisperModel || 'base')
    setWakeWordMode(s.wakeWordMode === 'picovoice' ? 'picovoice' : 'phrases')
    setKeys({ ...s.envOverrides })
    setEmergentProvider(s.envOverrides.EMERGENT_PROVIDER || 'anthropic')
    setEmergentModel(s.envOverrides.EMERGENT_MODEL || 'claude-sonnet-4-5-20250929')
    setGeminiVoice(s.envOverrides.GEMINI_TTS_VOICE ?? 'Aoede')
    setMiniMode(!!mini)
    setLaunchAtLogin(!!launch)
    try {
      const sync = await window.jarviz.memory.syncEnabledGet()
      setMemorySync(!!sync)
    } catch { /* noop */ }
  }, [])
  useEffect(() => { loadSettings().catch(console.error) }, [loadSettings])

  // Refresh transcripts whenever the tab opens
  useEffect(() => {
    if (tab !== 'transcripts') return
    window.jarviz.transcripts.list().then(setSessions).catch(console.error)
  }, [tab])

  const saveSettings = useCallback(async () => {
    const next = { ...keys, EMERGENT_PROVIDER: emergentProvider, EMERGENT_MODEL: emergentModel, GEMINI_TTS_VOICE: geminiVoice }
    await window.jarviz.settings.set({ llmBackend, whisperModel, wakeWordMode, envOverrides: next })
    setKeys(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }, [keys, emergentProvider, emergentModel, geminiVoice, llmBackend, whisperModel, wakeWordMode])

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

  const toggleLaunchAtLogin = (): void => {
    const next = !launchAtLogin
    setLaunchAtLogin(next)
    void window.jarviz.app.setLaunchAtLogin(next).then((applied) => setLaunchAtLogin(!!applied)).catch(() => setLaunchAtLogin(!next))
  }

  const toggleMemorySync = (): void => {
    const next = !memorySync
    setMemorySync(next)
    void window.jarviz.memory.syncEnabledSet(next).then((applied) => setMemorySync(!!applied)).catch(() => setMemorySync(!next))
  }

  // Voice diagnostic — explains why voice may not change
  const voiceWarning = (() => {
    if (!geminiVoice) return null
    if (!diag) return null
    if (!diag.envHasGeminiKey) {
      return `⚠ Gemini voice "${geminiVoice}" requires GEMINI_API_KEY — set it under Models & keys. Right now Jarviz is using the system browser voice.`
    }
    if (diag.envGeminiVoice !== geminiVoice) {
      return `⚠ Voice change not yet applied — click Save below.`
    }
    return null
  })()

  // ── Menubar popover chrome ───────────────────────────────────────────────
  const fontUi: React.CSSProperties = {
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  }

  const paneMeta = SETTINGS_NAV_FLAT.find((n) => n.id === tab)
  const paneTitle = paneMeta?.paneTitle ?? 'Jarviz'
  const paneSubtitle = paneMeta?.paneSubtitle ?? 'Preferences for this Mac.'

  const tabPaneBody = (
    <>
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
          diag={diag}
          accent={accent}
          miniMode={miniMode}
          onToggleMini={toggleMini}
          launchAtLogin={launchAtLogin}
          onToggleLaunchAtLogin={toggleLaunchAtLogin}
          memorySync={memorySync}
          onToggleMemorySync={toggleMemorySync}
          llmBackend={llmBackend} setLlmBackend={setLlmBackend}
          emergentProvider={emergentProvider} setEmergentProvider={setEmergentProvider}
          emergentModel={emergentModel} setEmergentModel={setEmergentModel}
          whisperModel={whisperModel} setWhisperModel={setWhisperModel}
          wakeWordMode={wakeWordMode} setWakeWordMode={setWakeWordMode}
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
      {tab === 'memory' && (
        <PanelMemoryTab />
      )}
      {tab === 'privacy' && (
        <PanelToolsTab />
      )}
    </>
  )

  const footerBar = (
    <div style={{ padding: '8px 12px', borderTop: `1px solid ${cx.hairline}`, display: 'flex', gap: 8, alignItems: 'center', fontSize: 10, color: cx.textSub, ...fontMono }}>
      <span>{diag?.platform ?? '—'}</span>
      <span style={{ opacity: 0.4 }}>·</span>
      <span>{diag?.memoryMB != null ? `${diag.memoryMB.toFixed(0)} MB` : '—'}</span>
      <span style={{ flex: 1 }} />
      <span>v0.4</span>
    </div>
  )

  return (
    <PanelChromeCtx.Provider value={cx}>
    <div
      style={{
        ...fontUi,
        width: '100vw',
        height: '100vh',
        boxSizing: 'border-box',
        padding: nativeUi ? 0 : 10,
        color: cx.textMain,
        fontSize: 13,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: cx.pageTint,
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: nativeUi ? 'row' : 'column',
          borderRadius: nativeUi ? 0 : cx.radiusOut,
          overflow: 'hidden',
          background: cx.fillCard,
          boxShadow: cx.shadow,
        }}
      >
        {nativeUi ? (
          <>
            <aside
              style={{
                width:               220,
                flexShrink:          0,
                display:             'flex',
                flexDirection:       'column',
                paddingTop:          glassUi ? 44 : 24,
                paddingBottom:       14,
                paddingLeft:         14,
                paddingRight:        12,
                borderRight:         `1px solid ${cx.hairline}`,
                background:          glassUi
                  ? 'linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0) 38%), rgba(10,12,18,0.42)'
                  : 'rgba(0,0,0,0.035)',
                backdropFilter:      glassUi ? 'blur(56px) saturate(200%)' : undefined,
                WebkitBackdropFilter: glassUi ? 'blur(56px) saturate(200%)' : undefined,
              }}
            >
              <div style={{ fontSize: 18, fontWeight: 650, letterSpacing: '-0.03em', color: cx.titleColor, marginBottom: 2 }}>
                Jarviz
              </div>
              <div style={{ fontSize: 11, fontWeight: 500, color: cx.textSub, marginBottom: 16, letterSpacing: '0.01em' }}>
                Settings
              </div>
              <nav style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0, overflow: 'auto' }}>
                {SETTINGS_NAV_GROUPS.map((group, gi) => (
                  <div key={group.section}>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.11em',
                        textTransform: 'uppercase',
                        color: cx.textSoft,
                        marginBottom: 6,
                        marginTop: gi === 0 ? 0 : 2,
                        paddingLeft: 2,
                      }}
                    >
                      {group.section}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {group.items.map((item) => {
                        const active = tab === item.id
                        const iconColor = active
                          ? (glassUi ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.88)')
                          : (glassUi ? 'rgba(255,255,255,0.42)' : 'rgba(0,0,0,0.45)')
                        return (
                          <button
                            key={item.id}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            data-testid={`panel-tab-${item.id}`}
                            onClick={() => setTab(item.id)}
                            style={{
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              padding: '7px 10px',
                              borderRadius: 8,
                              border: active && glassUi ? '1px solid rgba(255,255,255,0.14)' : '1px solid transparent',
                              cursor: 'pointer',
                              textAlign: 'left',
                              background: active
                                ? (glassUi ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)')
                                : 'transparent',
                              boxShadow: active && glassUi ? 'inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 0 rgba(0,0,0,0.12)' : undefined,
                            }}
                          >
                            <span
                              aria-hidden
                              style={{
                                width: 28,
                                height: 28,
                                borderRadius: 7,
                                display: 'grid',
                                placeItems: 'center',
                                flexShrink: 0,
                                background: glassUi ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
                                border: glassUi ? '1px solid rgba(255,255,255,0.08)' : `1px solid ${cx.hairline}`,
                              }}
                            >
                              <SettingsNavGlyph tab={item.id} color={iconColor} />
                            </span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: active ? cx.titleColor : cx.textMain, letterSpacing: '-0.015em', lineHeight: 1.25 }}>
                              {item.label}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </nav>
            </aside>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                background: glassUi
                  ? 'linear-gradient(145deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 28%, rgba(255,255,255,0) 55%), rgba(8,10,14,0.28)'
                  : undefined,
                backdropFilter: glassUi ? 'blur(40px) saturate(180%)' : undefined,
                WebkitBackdropFilter: glassUi ? 'blur(40px) saturate(180%)' : undefined,
              }}
            >
              <div
                style={{
                  paddingTop: glassUi ? 40 : 22,
                  paddingLeft: 24,
                  paddingRight: 24,
                  paddingBottom: 12,
                  borderBottom: `1px solid ${cx.hairline}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.04em', color: cx.titleColor, lineHeight: 1.12 }}>
                      {paneTitle}
                    </div>
                    <div style={{ fontSize: 12, color: cx.textSub, marginTop: 6, lineHeight: 1.45, maxWidth: 420 }}>
                      {paneSubtitle}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, textAlign: 'right' }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '5px 11px',
                        borderRadius: 999,
                        background: glassUi ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
                        border: `1px solid ${cx.hairline}`,
                        fontSize: 11,
                        fontWeight: 600,
                        color: cx.textMain,
                        ...fontMono,
                      }}
                      title={`${STATE_LABEL[String(agentState)] ?? String(agentState)}`}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: accent,
                          boxShadow: `0 0 0 3px ${accent}33`,
                        }}
                      />
                      {stateLabelUi}
                    </span>
                    <div style={{ ...fontMono, fontSize: 10, color: cx.textSub, marginTop: 6 }}>
                      uptime {diag ? fmtUptime(diag.uptimeMs) : '—'}
                    </div>
                  </div>
                </div>
                {(caption.user || caption.reply) && (
                  <div style={{ fontSize: 12, lineHeight: 1.48, color: cx.textMain, marginTop: 10 }}>
                    {caption.user && (
                      <div style={{ padding: '6px 10px', borderRadius: 8, background: glassUi ? 'rgba(138,180,248,0.14)' : 'rgba(138,180,248,0.10)', marginBottom: 6 }}>
                        <span style={pillStyle('#9BB8FF')}>You</span>
                        <span>{caption.user}</span>
                      </div>
                    )}
                    {caption.reply && (
                      <div style={{ padding: '6px 10px', borderRadius: 8, background: glassUi ? 'rgba(251,188,68,0.12)' : 'rgba(251,188,68,0.08)' }}>
                        <span style={pillStyle('#F5C842')}>Reply</span>
                        <span>{caption.reply}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '16px 24px 20px', WebkitOverflowScrolling: 'touch' }}>
                {tabPaneBody}
              </div>
              {footerBar}
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${cx.hairline}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: cx.titleColor }}>
                    Jarviz
                  </div>
                  <div style={{ fontSize: 11, color: cx.textSub, marginTop: 2 }}>Menu bar & shortcuts</div>
                </div>
                <span
                  style={{
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 10px',
                    borderRadius: 999,
                    background: 'rgba(0,0,0,0.28)',
                    border: `1px solid ${cx.hairline}`,
                    fontSize: 11,
                    fontWeight: 600,
                    color: cx.textMain,
                    ...fontMono,
                  }}
                  title={`${STATE_LABEL[String(agentState)] ?? String(agentState)}`}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: accent,
                      boxShadow: `0 0 0 3px ${accent}22`,
                    }}
                  />
                  {stateLabelUi}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: caption.user || caption.reply ? 8 : 0 }}>
                <span style={{ ...fontMono, fontSize: 10, color: cx.textSub }}>
                  uptime {diag ? fmtUptime(diag.uptimeMs) : '—'}
                </span>
              </div>
              {(caption.user || caption.reply) && (
                <div style={{ fontSize: 12, lineHeight: 1.48, color: cx.textMain }}>
                  {caption.user && (
                    <div style={{ padding: '6px 10px', borderRadius: 8, background: 'rgba(138,180,248,0.10)', marginBottom: 6 }}>
                      <span style={pillStyle('#9BB8FF')}>You</span>
                      <span>{caption.user}</span>
                    </div>
                  )}
                  {caption.reply && (
                    <div style={{ padding: '6px 10px', borderRadius: 8, background: 'rgba(251,188,68,0.08)' }}>
                      <span style={pillStyle('#F5C842')}>Reply</span>
                      <span>{caption.reply}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div style={{ padding: '0 12px', marginBottom: 2 }}>
              <div
                style={{
                  display: 'flex',
                  gap: 2,
                  padding: 3,
                  borderRadius: cx.radiusSeg + 4,
                  background: cx.segTrack,
                  border: `1px solid ${cx.hairline}`,
                }}
                role="tablist"
              >
                {SETTINGS_NAV_FLAT.map((item) => {
                  const active = tab === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      data-testid={`panel-tab-${item.id}`}
                      onClick={() => setTab(item.id)}
                      style={{
                        flex: 1,
                        padding: '7px 2px',
                        borderRadius: cx.radiusSeg,
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.02em',
                        color: active ? cx.segActive : cx.segIdle,
                        background: active
                          ? 'linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0.08))'
                          : 'transparent',
                        boxShadow: active ? '0 2px 6px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.12)' : undefined,
                      }}
                    >
                      {item.segmentLabel}
                    </button>
                  )
                })}
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 12px 12px', WebkitOverflowScrolling: 'touch' }}>
              {tabPaneBody}
            </div>
            {footerBar}
          </>
        )}
      </div>
    </div>
    </PanelChromeCtx.Provider>
  )
}

function pillStyle(color: string): React.CSSProperties {
  return {
    fontWeight: 650,
    fontSize: 10,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    marginRight: 8,
    padding: '2px 7px',
    borderRadius: 6,
    background: `${color}24`,
    color,
    display: 'inline-block',
    verticalAlign: 'middle',
  }
}

function buttonPrimaryStyle(cx: PanelChrome, saved: boolean): React.CSSProperties {
  return {
    width: '100%',
    padding: '11px 12px',
    marginTop: 12,
    borderRadius: cx.radiusIn,
    border: 'none',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 13,
    letterSpacing: '0.01em',
    background: saved
      ? 'linear-gradient(180deg, #3da06b, #2d8f5f)'
      : 'linear-gradient(180deg, #5c8dff, #4a73e8)',
    color: '#fff',
    boxShadow: saved ? undefined : '0 8px 20px rgba(74,115,232,0.35)',
  }
}

// ── Tabs ───────────────────────────────────────────────────────────────────

function MenuSection({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }): React.ReactElement {
  const cx = useCx()
  const glass = cx.uiMode === 'glass'
  if (glass) {
    return (
      <div style={{ marginBottom: 22, ...style }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.01em',
            color: cx.textSub,
            marginBottom: 8,
            paddingLeft: 2,
          }}
        >
          {title}
        </div>
        <div
          style={{
            borderRadius: cx.radiusIn,
            border: '1px solid rgba(255,255,255,0.11)',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.03) 100%), rgba(255,255,255,0.04)',
            overflow: 'hidden',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12), 0 12px 40px rgba(0,0,0,0.2)',
            backdropFilter: 'blur(48px) saturate(200%)',
            WebkitBackdropFilter: 'blur(48px) saturate(200%)',
          }}
        >
          {children}
        </div>
      </div>
    )
  }
  return (
    <div style={{ marginBottom: 16, ...style }}>
      <div style={{
        borderRadius: cx.radiusIn,
        border: `1px solid ${cx.hairline}`,
        background: cx.fillGroup,
        overflow: 'hidden',
      }}
      >
        <div style={{
          padding: '7px 12px',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: cx.textSoft,
          background: cx.fillGroupHd,
          borderBottom: `1px solid ${cx.hairline}`,
        }}
        >{title}
        </div>
        {children}
      </div>
    </div>
  )
}

function PanelMemoryTab(): JSX.Element {
  const f = useFields()
  return <MemoryTab chrome={f.cx} MenuSection={MenuSection} buttonSecondary={f.buttonSecondary} />
}
function PanelToolsTab(): JSX.Element {
  const f = useFields()
  return <ToolsTab chrome={f.cx} MenuSection={MenuSection} buttonSecondary={f.buttonSecondary} />
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
  const f = useFields()
  const cx = f.cx
  return (
    <div style={{ paddingTop: 4 }}>
      <MenuSection title="Spoken output">
        <div style={{ padding: '12px 12px 4px' }}>
          <select
            data-testid="panel-voice-select"
            value={voice}
            onChange={(e) => onChange(e.target.value)}
            style={f.selectStyle}
          >
            {GEMINI_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        {voiceWarning && (
          <div style={{ padding: '0 12px 12px', fontSize: 12, lineHeight: 1.52, color: 'rgba(255,180,164,0.95)' }}>
            <div style={{ padding: '10px 11px', borderRadius: 8, background: 'rgba(234,104,104,0.12)', border: `1px solid rgba(242,139,130,0.35)` }}>
              {voiceWarning}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, padding: '10px 12px 12px', borderTop: `1px solid ${cx.hairline}` }}>
          <button
            type="button"
            data-testid="panel-voice-preview"
            onClick={onPreview}
            disabled={previewBusy}
            style={{
              ...f.buttonSecondary,
              flex: 1,
              padding: '10px 12px',
              opacity: previewBusy ? 0.65 : 1,
              cursor: previewBusy ? 'wait' : 'pointer',
              background: 'rgba(154,138,246,0.15)',
              borderColor: 'rgba(160,148,246,0.35)',
            }}
          >
            {previewBusy ? 'Playing…' : 'Preview'}
          </button>
          <button type="button" data-testid="panel-voice-save" onClick={onSave} style={{ ...f.buttonSecondary, flex: 1, padding: '10px 12px' }}>
            {saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </MenuSection>

      {previewError && (
        <div style={{ marginTop: -4, padding: '0 0 8px', fontSize: 12, color: 'rgba(180,60,50,0.95)' }}>
          <div style={{ padding: '10px 12px', borderRadius: cx.radiusIn, border: `1px solid rgba(242,139,130,0.35)`, background: 'rgba(242,139,130,0.08)' }}>
            {previewError}
          </div>
        </div>
      )}

      <p style={{ fontSize: 12, lineHeight: 1.55, color: cx.textSub, margin: '4px 2px 0' }}>
        Gemini voices need a free <strong style={{ fontWeight: 600, color: cx.textMain }}>GEMINI_API_KEY</strong>. Without one, the app uses browser TTS.
      </p>
    </div>
  )
}

interface KeysProps {
  diag: Diagnostics | null
  accent: string
  miniMode: boolean
  onToggleMini: () => void
  launchAtLogin: boolean
  onToggleLaunchAtLogin: () => void
  memorySync: boolean
  onToggleMemorySync: () => void
  llmBackend: string; setLlmBackend: (v: string) => void
  emergentProvider: string; setEmergentProvider: (v: string) => void
  emergentModel: string; setEmergentModel: (v: string) => void
  whisperModel: string; setWhisperModel: (v: string) => void
  wakeWordMode: 'phrases' | 'picovoice'; setWakeWordMode: (v: 'phrases' | 'picovoice') => void
  keys: Record<string, string>; setKeys: React.Dispatch<React.SetStateAction<Record<string, string>>>
  onSave: () => Promise<void>
  saved: boolean
}
function KeysTab(p: KeysProps) {
  const f = useFields()
  const cx = f.cx

  useEffect(() => {
    const list = PROVIDER_MODELS[p.emergentProvider]
    if (list && list.length && !list.some((m) => m.value === p.emergentModel)) {
      p.setEmergentModel(list[0].value)
    }
  }, [p.emergentProvider, p.emergentModel, p.setEmergentModel])

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: 11,
    letterSpacing: '0.06em',
    fontWeight: 600,
    color: cx.textSoft,
    margin: '0 0 6px',
    textTransform: 'uppercase',
  }

  return (
    <div style={{ paddingTop: 4 }}>
      {p.diag && (
        <>
          <MenuSection title="Runtime diagnostics">
            <MenuRow label="Platform" value={p.diag.platform} />
            <MenuRow label="Uptime" value={fmtUptime(p.diag.uptimeMs)} mono />
            <MenuRow label="Memory" value={`${p.diag.memoryMB.toFixed(0)} MB`} mono />
            <MenuRow label="LLM backend" value={p.diag.llmBackend} accent={p.accent} isLast />
          </MenuSection>
          <MenuSection title="Credentials">
            <MenuRow
              label="Emergent universal key"
              value={p.diag.envHasEmergentKey ? 'Configured' : 'Not set'}
              accent={p.diag.envHasEmergentKey ? '#94d4a8' : '#f1918c'}
            />
            <MenuRow
              label="Gemini API key"
              value={p.diag.envHasGeminiKey ? 'Configured' : 'Not set · browser TTS'}
              accent={p.diag.envHasGeminiKey ? '#94d4a8' : '#f1918c'}
            />
            <MenuRow label="Active voice" value={p.diag.envGeminiVoice || 'Off'} accent={p.accent} isLast />
          </MenuSection>
        </>
      )}
      <MenuSection title="Appearance">
        <button
          type="button"
          data-testid="panel-mini-toggle"
          onClick={p.onToggleMini}
          style={{
            width: '100%',
            padding: '12px 14px',
            margin: 0,
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            background: p.miniMode ? 'rgba(138,118,228,0.18)' : 'transparent',
            color: cx.textMain,
            fontSize: 13,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>
            <strong style={{ fontWeight: 600 }}>Mini orb mode</strong>
            <div style={{ fontSize: 11, color: cx.textSub, marginTop: 4 }}>⌘⇧M / Ctrl⇧M</div>
          </span>
          <span style={{ fontSize: 12, color: cx.textSub }}>{p.miniMode ? 'On' : 'Off'}</span>
        </button>
      </MenuSection>
      <MenuSection title="Login items">
        <button
          type="button"
          data-testid="panel-launch-at-login-toggle"
          onClick={p.onToggleLaunchAtLogin}
          style={{
            width: '100%',
            padding: '12px 14px',
            margin: 0,
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            background: p.launchAtLogin ? 'rgba(138,180,248,0.14)' : 'transparent',
            color: cx.textMain,
            fontSize: 13,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>
            <strong style={{ fontWeight: 600 }}>Launch at login</strong>
            <div style={{ fontSize: 11, color: cx.textSub, marginTop: 4 }}>Start Jarviz automatically when you sign in.</div>
          </span>
          <span style={{ fontSize: 12, color: cx.textSub }}>{p.launchAtLogin ? 'On' : 'Off'}</span>
        </button>
      </MenuSection>
      <MenuSection title="Knowledge sync">
        <button
          type="button"
          data-testid="panel-memory-sync-toggle"
          onClick={p.onToggleMemorySync}
          style={{
            width: '100%',
            padding: '12px 14px',
            margin: 0,
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            background: p.memorySync ? 'rgba(168,216,185,0.16)' : 'transparent',
            color: cx.textMain,
            fontSize: 13,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>
            <strong style={{ fontWeight: 600 }}>Sync memory (cloud)</strong>
            <div style={{ fontSize: 11, color: cx.textSub, marginTop: 4 }}>Default is local-only. Cloud sync will be added next.</div>
          </span>
          <span style={{ fontSize: 12, color: cx.textSub }}>{p.memorySync ? 'On' : 'Off'}</span>
        </button>
      </MenuSection>
      <MenuSection title="Language model">
        <div style={{ padding: 12 }}>
          <select data-testid="panel-backend-select" value={p.llmBackend} onChange={(e) => p.setLlmBackend(e.target.value)} style={f.selectStyle}>
            <option value="emergent">Emergent universal key</option>
            <option value="anthropic">Anthropic (your key)</option>
            <option value="openai">OpenAI (your key)</option>
            <option value="gemini">Google Gemini (your key)</option>
            <option value="groq">Groq Llama</option>
            <option value="xai">xAI Grok</option>
          </select>
          {p.llmBackend === 'emergent' && (
            <div style={{ marginTop: 10 }}>
              <div style={{ ...sectionLabelStyle, margin: '14px 0 8px' }}>Emergent routing</div>
              <select value={p.emergentProvider} onChange={(e) => p.setEmergentProvider(e.target.value)} style={f.selectStyle}>
                <option value="anthropic">Anthropic Claude</option>
                <option value="openai">OpenAI GPT</option>
                <option value="gemini">Google Gemini</option>
              </select>
              <div style={{ marginTop: 8 }}>
                <select value={p.emergentModel} onChange={(e) => p.setEmergentModel(e.target.value)} style={f.selectStyle}>
                  {(PROVIDER_MODELS[p.emergentProvider] ?? []).map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </MenuSection>

      <MenuSection title="Speech to text">
        <div style={{ padding: 12 }}>
          <select value={p.whisperModel} onChange={(e) => p.setWhisperModel(e.target.value)} style={f.selectStyle}>
            <option value="tiny">Tiny — fastest · 39 MB</option>
            <option value="base">Base — balanced · 145 MB</option>
            <option value="small">Small — accurate · 466 MB</option>
            <option value="medium">Medium — high accuracy · 1.5 GB</option>
            <option value="large-v3">Large — best accuracy · 3 GB</option>
          </select>
        </div>
      </MenuSection>

      <MenuSection title="Wake word">
        <div style={{ padding: 12 }}>
          <select
            data-testid="panel-wake-word-mode"
            value={p.wakeWordMode}
            onChange={(e) => p.setWakeWordMode(e.target.value === 'picovoice' ? 'picovoice' : 'phrases')}
            style={f.selectStyle}
          >
            <option value="phrases">Phrases — Silero + Whisper (e.g. “hey jarviz”, “ok jarvis”) — recommended</option>
            <option value="picovoice">Picovoice — keyword “Jarvis” only; needs PICOVOICE_ACCESS_KEY + app restart</option>
          </select>
          <p style={{ fontSize: 12, lineHeight: 1.5, color: cx.textSub, marginTop: 10 }}>
            Picovoice is optional. If it fails in your environment, keep <strong style={{ fontWeight: 600, color: cx.textMain }}>Phrases</strong>, save, and restart the app.
          </p>
        </div>
      </MenuSection>

      <MenuSection title="API keys & environment">
        <div style={{ maxHeight: 320, overflow: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {ENV_KEYS.map((k, i, arr) => (
            <div
              key={k}
              style={{
                padding: '12px 12px',
                borderBottom: i < arr.length - 1 ? `1px solid ${cx.hairline}` : undefined,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 600, color: cx.textSoft, marginBottom: 6, letterSpacing: '0.04em', fontFamily: '"JetBrains Mono", Menlo, monospace' }}>{k}</div>
              <input
                data-testid={`panel-key-${k.toLowerCase()}`}
                type="password"
                value={p.keys[k] ?? ''}
                placeholder={ENV_KEY_HINTS[k]}
                autoComplete="off"
                onChange={(e) => p.setKeys((prev) => ({ ...prev, [k]: e.target.value }))}
                style={{ ...f.inputStyle, fontSize: 11 }}
              />
            </div>
          ))}
        </div>
        <div style={{ borderTop: `1px solid ${cx.hairline}`, padding: 12 }}>
          <button type="button" data-testid="panel-keys-save" onClick={p.onSave} style={{ ...buttonPrimaryStyle(cx, p.saved), marginTop: 0 }}>
            {p.saved ? 'Saved' : 'Save settings'}
          </button>
        </div>
      </MenuSection>
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
  const f = useFields()
  const cx = f.cx
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
      <div style={{ paddingTop: 4 }}>
        <button type="button" onClick={() => p.setOpenSession(null)} style={{ ...f.buttonSecondary, marginBottom: 12 }}>
          ← History
        </button>
        <MenuSection title="Conversation">
          <div style={{ padding: '10px 12px', fontWeight: 600, borderBottom: `1px solid ${cx.hairline}`, color: cx.textMain }}>{p.openSession.preview || '(empty)'}</div>
          {p.openSession.turns.map((t, i, arr) => (
            <div
              key={i}
              style={{
                padding: '11px 12px',
                borderBottom: i < arr.length - 1 ? `1px solid ${cx.hairline}` : undefined,
                background: t.role === 'user' ? 'rgba(138,180,248,0.06)' : 'rgba(251,188,68,0.05)',
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: t.role === 'user' ? '#9bb8ff' : '#e8c86a', marginBottom: 6 }}>
                {t.role === 'user' ? 'You' : 'Assistant'}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.5, color: cx.textMain }}>{t.text}</div>
            </div>
          ))}
        </MenuSection>
        <button type="button" onClick={() => del(p.openSession!.id)} style={{ ...f.buttonSecondary, width: '100%', marginTop: 8, background: 'rgba(234,76,76,0.14)', borderColor: 'rgba(234,104,104,0.42)' }}>
          Delete session
        </button>
      </div>
    )
  }

  return (
    <div style={{ paddingTop: 4 }}>
      <MenuSection title={`Sessions · ${p.sessions.length}`}>
        {p.sessions.length === 0 && (
          <div style={{ padding: '18px 14px', fontSize: 13, color: cx.textSoft }}>
            Nothing saved yet. Chat from the orb to build history here.
          </div>
        )}
        {p.sessions.map((s, i, arr) => (
          <button
            key={s.id}
            type="button"
            data-testid={`panel-transcript-${s.id}`}
            onClick={() => open(s.id)}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '13px 14px',
              border: 'none',
              borderBottom: i < arr.length - 1 ? `1px solid ${cx.hairline}` : undefined,
              cursor: 'pointer',
              color: cx.textMain,
              background: 'rgba(255,255,255,0.02)',
              display: 'block',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.preview || '(empty)'}</div>
            <div style={{ fontSize: 11, color: cx.textSub, marginTop: 4 }}>
              {new Date(s.startedAt).toLocaleString()} · {s.turns} turns
            </div>
          </button>
        ))}
      </MenuSection>
      {p.sessions.length > 0 && (
        <button type="button" onClick={async () => {
          if (!confirm('Delete ALL saved conversations?')) return
          await window.jarviz.transcripts.clear()
          void p.refresh()
        }} style={{ ...f.buttonSecondary, marginTop: 10, width: '100%', background: 'rgba(234,76,76,0.12)', borderColor: 'rgba(234,104,104,0.38)' }}>
          Clear all
        </button>
      )}
    </div>
  )
}

function MenuRow({ label, value, mono, accent, isLast }: { label: string; value: string; mono?: boolean; accent?: string; isLast?: boolean }): React.ReactElement {
  const cx = useCx()
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 14,
        padding: '11px 14px',
        borderBottom: isLast ? 'none' : `1px solid ${cx.hairline}`,
      }}
    >
      <span style={{ fontSize: 13, color: cx.textSoft }}>{label}</span>
      <span style={{ ...(mono ? fontMono : {}), fontSize: 13, color: accent ?? cx.textMain, fontWeight: accent ? 600 : 500, textAlign: 'right' }}>{value}</span>
    </div>
  )
}
