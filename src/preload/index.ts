import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const IPC_TIMEOUT_MS = 120000

function invokeWithTimeout<T>(channel: string, args: unknown): Promise<T> {
  return Promise.race([
    ipcRenderer.invoke(channel, args) as Promise<T>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`IPC ${channel} timed out after ${IPC_TIMEOUT_MS}ms`)), IPC_TIMEOUT_MS),
    ),
  ])
}

const jarviz = {
  // Drag controls (orb only)
  dragStart: (mouseX: number, mouseY: number) => ipcRenderer.send('drag:start', { mouseX, mouseY }),
  dragMove:  (mouseX: number, mouseY: number) => ipcRenderer.send('drag:move',  { mouseX, mouseY }),
  dragEnd:   () => ipcRenderer.send('drag:end'),

  // Window events received by orb
  onActivate: (cb: () => void) => {
    const h = (): void => cb()
    ipcRenderer.on('jarviz:activate', h)
    return () => ipcRenderer.removeListener('jarviz:activate', h)
  },
  onOpenSettings:    (cb: () => void) => sub('jarviz:open-settings', cb),
  onOpenTranscripts: (cb: () => void) => sub('jarviz:open-transcripts', cb),
  /** Main → panel: switch tab after menu/tray shortcuts (must not use raw ipcRenderer in renderer). */
  onPanelFocusSection: (cb: (section: string) => void) => sub('panel:focus-section', cb),
  onMiniChanged:     (cb: (mini: boolean) => void) => sub('orb:miniChanged', cb),
  onUpdaterStatus:   (cb: (s: { state: string; progress?: number; message?: string; info?: unknown }) => void) =>
    sub('updater:status', cb),

  log: (msg: string) => ipcRenderer.send('renderer:log', msg),

  orbResize:  (size: number) => ipcRenderer.send('orb:resize', { size }),
  orbGetSize: (): Promise<number> => ipcRenderer.invoke('orb:getSize'),
  setMini:    (on: boolean): Promise<boolean> => ipcRenderer.invoke('orb:setMini', on),
  getMini:    (): Promise<boolean> => ipcRenderer.invoke('orb:getMini'),

  primaryScreenSize: (): Promise<{ width: number; height: number; x: number; y: number }> =>
    ipcRenderer.invoke('screen:primarySize'),

  getWhisperModel: (): Promise<string> => ipcRenderer.invoke('config:whisperModel'),

  installUpdate: (): Promise<boolean> => ipcRenderer.invoke('updater:install'),

  // Orb → main relay (so the panel can mirror live state without doing FSM work)
  relayState:   (state: string) => ipcRenderer.send('orb:state', state),
  relayCaption: (c: { phase: string; user: string; reply: string }) => ipcRenderer.send('orb:caption', c),

  // Panel listens for these
  onAgentState: (cb: (s: string) => void) => sub('panel:agentState', cb),
  onCaption:    (cb: (c: { phase: string; user: string; reply: string }) => void) => sub('panel:caption', cb),

  panel: {
    show: (section?: string) => ipcRenderer.send('panel:show', section),
    hide: () => ipcRenderer.send('panel:hide'),
    ping: () => ipcRenderer.invoke('panel:toggle'),
    getDiagnostics: (): Promise<{
      platform: string; uptimeMs: number; envHasGeminiKey: boolean; envHasEmergentKey: boolean;
      envGeminiVoice: string; llmBackend: string; memoryMB: number;
    }> => ipcRenderer.invoke('panel:getDiagnostics'),
    /** macOS: true after `electron-liquid-glass` attached to the framed Settings window (not the orb). */
    getSettingsNativeLiquidGlass: (): Promise<boolean> => ipcRenderer.invoke('settings:getNativeLiquidGlass'),
    previewVoice: (voice: string): Promise<{ ok: boolean; error?: string; fallback?: 'browser'; note?: string }> =>
      ipcRenderer.invoke('panel:previewVoice', voice),
    onPreviewAudio: (cb: (a: { audio: number[]; mime: string }) => void) => sub('panel:previewAudio', cb),
    onPreviewFallback: (cb: (p: { text: string }) => void) => sub('panel:previewFallback', cb),
  },

  settings: {
    get: (): Promise<{
      envOverrides: Record<string, string>
      llmBackend: string
      whisperModel: string
      wakeWordMode: 'phrases' | 'picovoice'
      allowDestructiveShell: boolean
      anthropicThinking: boolean
      mcpServers: unknown[]
    }> => ipcRenderer.invoke('settings:get'),

    set: (patch: {
      envOverrides?: Record<string, string>
      llmBackend?: string
      whisperModel?: string
      wakeWordMode?: 'phrases' | 'picovoice'
      allowDestructiveShell?: boolean
      anthropicThinking?: boolean
      mcpServers?: unknown
    }): Promise<boolean> => ipcRenderer.invoke('settings:set', patch),
  },

  transcripts: {
    list:       (): Promise<Array<{ id: string; startedAt: number; endedAt: number; preview: string; turns: number }>> =>
      ipcRenderer.invoke('transcripts:list'),
    get:        (id: string): Promise<{ id: string; startedAt: number; endedAt: number; preview: string; turns: Array<{ role: string; text: string; ts: number }> } | null> =>
      ipcRenderer.invoke('transcripts:get', id),
    delete:     (id: string): Promise<boolean> => ipcRenderer.invoke('transcripts:delete', id),
    clear:      (): Promise<boolean> => ipcRenderer.invoke('transcripts:clear'),
    newSession: (): Promise<boolean> => ipcRenderer.invoke('transcripts:newSession'),
  },

  app: {
    getLaunchAtLogin: (): Promise<boolean> => ipcRenderer.invoke('app:getLaunchAtLogin'),
    setLaunchAtLogin: (on: boolean): Promise<boolean> => ipcRenderer.invoke('app:setLaunchAtLogin', on),
    getJarvizEnabled: (): Promise<boolean> => ipcRenderer.invoke('app:getJarvizEnabled'),
    setJarvizEnabled: (on: boolean): Promise<boolean> => ipcRenderer.invoke('app:setJarvizEnabled', on),
    onJarvizSetEnabled: (cb: (enabled: boolean) => void) => sub<boolean>('jarviz:setEnabled', cb),
  },

  memory: {
    list: (opts?: { kind?: string; projectRoot?: string; limit?: number }) => ipcRenderer.invoke('memory:list', opts),
    search: (query: string, opts?: { kind?: string; projectRoot?: string; limit?: number }) =>
      ipcRenderer.invoke('memory:search', { query, ...(opts ?? {}) }),
    upsert: (item: { id?: string; kind: string; title: string; text: string; tags?: string[]; projectRoot?: string }) =>
      ipcRenderer.invoke('memory:upsert', item),
    delete: (id: string) => ipcRenderer.invoke('memory:delete', { id }),
    syncEnabledGet: () => ipcRenderer.invoke('agent:memorySync:get'),
    syncEnabledSet: (on: boolean) => ipcRenderer.invoke('agent:memorySync:set', on),
  },

  agentAdmin: {
    permissionsGet: () => ipcRenderer.invoke('agent:permissions:get'),
    permissionsSet: (next: unknown) => ipcRenderer.invoke('agent:permissions:set', next),
    activityList: (limit?: number) => ipcRenderer.invoke('agent:activity:list', { limit }),
  },

  system: {
    openMacPrivacyPane: (pane: string): Promise<boolean> => ipcRenderer.invoke('system:openMacPrivacyPane', pane),
  },

  agent: {
    query: (text: string): Promise<{ text: string; audio: number[] | null; audioMime: string | null; streaming?: boolean }> =>
      invokeWithTimeout('agent:query', { text }),

    cancel: () => ipcRenderer.send('agent:cancel'),

    onState: (cb: (state: string) => void) => sub('agent:state', (e: { state: string }) => cb(e.state)),

    onSpeakChunk: (cb: (chunk: { index: number; total: number; text: string; audio: number[] | null; audioMime: string | null; isFinal: boolean }) => void) =>
      sub('agent:speakChunk', cb),
  },

  stt: {
    whisperCppTranscribeWav: (wavBytes: number[]): Promise<{ text: string }> =>
      invokeWithTimeout('stt:whispercpp:transcribeWav', { wavBytes }),
  },
}

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('jarviz', jarviz)
  } catch (e) {
    console.error(e)
  }
}

export type JarvizAPI = typeof jarviz
