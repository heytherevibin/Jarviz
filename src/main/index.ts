import { config } from 'dotenv'
import { existsSync, readFileSync } from 'fs'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
config({ path: join(__dirname, '../../.env'), override: true })

import { app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, nativeImage, shell, dialog } from 'electron'
import Store from 'electron-store'
import { spawn } from 'child_process'
import { runAgent } from './agent/claude'
import { mcpRefreshFromStore, parseMcpServers } from './agent/mcp-registry'
import { streamSpeak, type SpeechChunk } from './agent/streaming'
import { getEffectiveEnvOverrides, mergeStoredEnv } from './store-env'
import { TranscriptStore } from './agent/transcript'
import { setupAutoUpdater, quitAndInstallUpdate } from './updater'
import { attachMacLiquidGlass } from './macLiquidGlass'
import {
  initAgentContext,
  memoryList,
  memorySearch,
  memoryUpsert,
  memoryDelete,
  permissionsGet,
  permissionsSet,
  memorySyncEnabledGet,
  memorySyncEnabledSet,
  activityList,
} from './agent/context'

// ── Crash recovery — keep IPC alive on unexpected errors ─────────────────────
function showMainProcessAlert(title: string, body: string): void {
  const text = body.length > 2800 ? `${body.slice(0, 2800)}…` : body
  void app.whenReady().then(() => {
    try {
      dialog.showErrorBox(title, text)
    } catch {
      /* headless / CI */
    }
  })
}
process.on('unhandledRejection', (reason) => {
  console.error('[Main] unhandled rejection:', reason)
  if (app.isPackaged) {
    showMainProcessAlert('Jarviz — background error', String(reason instanceof Error ? reason.stack || reason.message : reason))
  }
})
process.on('uncaughtException', (err) => {
  console.error('[Main] uncaught exception:', err)
  if (app.isPackaged) {
    showMainProcessAlert('Jarviz — uncaught error', err.stack || err.message)
  }
})

const store = new Store()
mergeStoredEnv(store)
const transcripts = new TranscriptStore(store)
initAgentContext(store)

function applyLaunchAtLoginSetting(): void {
  if (process.platform !== 'darwin') return
  const openAtLogin = store.get('app.launchAtLogin', false) as boolean
  try {
    app.setLoginItemSettings({ openAtLogin })
  } catch (e) {
    console.warn('[Main] setLoginItemSettings failed:', e)
  }
}

const DEFAULT_ORB_SIZE = 360
const MIN_ORB_SIZE = 160
const MAX_ORB_SIZE = 600
const SNAP_THRESHOLD = 80
const SNAP_MARGIN = 12
const MINI_SIZE = 64

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

let dragOffset = { x: 0, y: 0 }
let agentAbort: AbortController | null = null
let miniMode = false
/** When false, wake word and hotkey activation are paused (Settings still works). */
let jarvizEnabled = true

// ── Agent session state ───────────────────────────────────────────────────────
let conversationHistory: unknown[] = []
let lastQueryAt = 0
const SESSION_TIMEOUT_MS = 5 * 60 * 1000

function tryAutoConfigureWhisperCpp(): void {
  const overrides = store.get('envOverrides', {}) as Record<string, string>
  const existingBin = (process.env.WHISPERCPP_BIN || process.env.WHISPER_CPP_BIN || overrides.WHISPERCPP_BIN || overrides.WHISPER_CPP_BIN || '').trim()
  const existingModel = (process.env.WHISPERCPP_MODEL || process.env.WHISPER_CPP_MODEL || overrides.WHISPERCPP_MODEL || overrides.WHISPER_CPP_MODEL || '').trim()
  if (existingBin && existingModel) return

  // macOS defaults (Homebrew + app support folder)
  const binCandidates = [
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
  ]
  const modelCandidates = [
    join(app.getPath('userData'), 'whispercpp', 'ggml-base.en.bin'),
    join(app.getPath('userData'), 'whispercpp', 'ggml-base.bin'),
  ]

  const foundBin = existingBin || binCandidates.find(p => existsSync(p)) || ''
  const foundModel = existingModel || modelCandidates.find(p => existsSync(p)) || ''
  if (!foundBin || !foundModel) return

  // Persist into store envOverrides so it works without manual setup.
  const next = { ...overrides }
  if (!existingBin) next.WHISPERCPP_BIN = foundBin
  if (!existingModel) next.WHISPERCPP_MODEL = foundModel
  store.set('envOverrides', next)
  mergeStoredEnv(store)
  console.log('[STT] auto-configured whisper.cpp:', {
    bin: process.env.WHISPERCPP_BIN,
    model: process.env.WHISPERCPP_MODEL,
  })
}

function stripWhisperCppOutput(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    // Remove whisper.cpp timestamps like: [00:00.000 --> 00:03.120] Hello
    .map(l => l.replace(/^\[[^\]]+\]\s*/, ''))
  return lines.join(' ').replace(/\s+/g, ' ').trim()
}

async function runWhisperCppTranscribe(wavBytes: Uint8Array): Promise<string> {
  const bin = (process.env.WHISPERCPP_BIN || process.env.WHISPER_CPP_BIN || '').trim()
  const model = (process.env.WHISPERCPP_MODEL || process.env.WHISPER_CPP_MODEL || '').trim()
  if (!bin) throw new Error('WHISPERCPP_BIN is not set')
  if (!model) throw new Error('WHISPERCPP_MODEL is not set')

  const dir = tmpdir()
  const wavPath = join(dir, `jarviz-stt-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`)

  await writeFile(wavPath, wavBytes)

  const extraArgs = (process.env.WHISPERCPP_ARGS || '').trim()
  const args = [
    '-m', model,
    '-f', wavPath,
    '-l', 'en',
    ...(extraArgs ? extraArgs.split(/\s+/).filter(Boolean) : []),
  ]

  return await new Promise<string>((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += String(d) })
    p.stderr.on('data', (d) => { err += String(d) })
    p.on('error', reject)
    p.on('close', (code) => {
      void unlink(wavPath).catch(() => {})
      if (code !== 0) {
        reject(new Error(`whisper.cpp exited ${code}: ${err || out}`))
        return
      }
      const text = stripWhisperCppOutput(out || err)
      resolve(text)
    })
  })
}

function getOrbSize(): number {
  return store.get('orb.size', DEFAULT_ORB_SIZE) as number
}

function getInitialPosition() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const size = getOrbSize()
  return {
    x: store.get('orb.x', Math.round((width - size) / 2)) as number,
    y: store.get('orb.y', height - size - 40) as number,
  }
}

function snapPosition(x: number, y: number, size: number): { x: number; y: number } {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  let sx = x
  let sy = y

  if (x < SNAP_THRESHOLD) sx = SNAP_MARGIN
  else if (x + size > width - SNAP_THRESHOLD) sx = width - size - SNAP_MARGIN

  if (y < SNAP_THRESHOLD) sy = SNAP_MARGIN
  else if (y + size > height - SNAP_THRESHOLD) sy = height - size - SNAP_MARGIN

  return { x: sx, y: sy }
}

/** Resolve `resources/tray.png`: cwd → beside main bundle (`out/main/tray.png`) → extraResources when packaged. */
function resolveTrayIconPath(): string | null {
  const ordered: string[] = []
  if (!app.isPackaged) ordered.push(join(process.cwd(), 'resources', 'tray.png'))

  ordered.push(join(__dirname, 'tray.png'))
  ordered.push(join(process.resourcesPath, 'resources', 'tray.png'))

  if (!app.isPackaged) ordered.push(join(app.getAppPath(), 'resources', 'tray.png'))

  const seen = new Set<string>()
  for (const candidate of ordered) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* noop */
    }
  }
  return null
}

function macSystemTrayFallbackImage(): Electron.NativeImage {
  for (const name of ['NSBookmarksTemplate', 'NSTouchBarComposeTemplate']) {
    try {
      const sys = nativeImage.createFromNamedImage(name)
      if (!sys.isEmpty()) return sys
    } catch {
      /* omit */
    }
  }
  return nativeImage.createEmpty()
}

/** macOS status items look best ~22pt (44px @2x); oversize PNGs can render oddly in the menu bar. */
function normalizeMenubarTrayImage(img: Electron.NativeImage): Electron.NativeImage {
  if (process.platform !== 'darwin') return img
  const { width, height } = img.getSize()
  if (width <= 0 || height <= 0) return img
  const maxPx = 44
  const m = Math.max(width, height)
  if (m <= maxPx) return img
  const s = maxPx / m
  return img.resize({ width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) })
}

/** macOS menu extras: smallest reliable path is decoding PNG bytes (path-only decode occasionally fails inside asar/watch). */
function createTrayIcon(): Electron.NativeImage {
  const trayPath = resolveTrayIconPath()
  if (!app.isPackaged) {
    console.log('[Main] tray probe cwd=', process.cwd(), '__dirname=', __dirname, 'chosen=', trayPath ?? '(none)')
  }

  if (trayPath) {
    try {
      const png = readFileSync(trayPath)
      const decoded = normalizeMenubarTrayImage(nativeImage.createFromBuffer(png))
      if (!decoded.isEmpty()) {
        if (process.platform === 'darwin') decoded.setTemplateImage(false)
        console.log('[Main] tray raster ok', trayPath, 'bytes=', png.length)
        return decoded
      }
      console.warn('[Main] tray createFromBuffer empty despite file:', trayPath)
    } catch (err) {
      console.warn('[Main] tray read/buffer decode failed:', trayPath, err)
    }

    try {
      const fromPathImg = normalizeMenubarTrayImage(nativeImage.createFromPath(trayPath))
      if (!fromPathImg.isEmpty()) {
        if (process.platform === 'darwin') fromPathImg.setTemplateImage(false)
        console.log('[Main] tray raster ok (createFromPath)', trayPath)
        return fromPathImg
      }
    } catch (err) {
      console.warn('[Main] tray createFromPath failed:', trayPath, err)
    }
  } else {
    console.warn('[Main] no tray PNG on disk yet — expected resources/tray.png or out/main/tray.png after vite writes bundle')
  }

  if (process.platform === 'darwin') {
    const fb = macSystemTrayFallbackImage()
    if (!fb.isEmpty()) {
      console.warn('[Main] tray using macOS template fallback image')
      fb.setTemplateImage(true)
      return fb
    }
  }

  return nativeImage.createEmpty()
}

/** Register IPC / shortcuts exactly once (avoid duplicates when a second window is created). */
let ipcRegistered = false
function registerMainProcessHandlers(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.on('drag:start', (_, { mouseX, mouseY }: { mouseX: number; mouseY: number }) => {
    if (!mainWindow) return
    const [wx, wy] = mainWindow.getPosition()
    dragOffset = { x: mouseX - wx, y: mouseY - wy }
  })

  ipcMain.on('drag:move', (_, { mouseX, mouseY }: { mouseX: number; mouseY: number }) => {
    if (!mainWindow) return
    mainWindow.setPosition(
      Math.round(mouseX - dragOffset.x),
      Math.round(mouseY - dragOffset.y),
    )
  })

  ipcMain.on('drag:end', () => {
    if (!mainWindow) return
    const [cx, cy] = mainWindow.getPosition()
    const [w] = mainWindow.getSize()
    const { x: sx, y: sy } = snapPosition(cx, cy, w)
    mainWindow.setPosition(sx, sy, true)
    store.set('orb.x', sx)
    store.set('orb.y', sy)
  })

  ipcMain.on('orb:resize', (_, { size }: { size: number }) => {
    if (!mainWindow) return
    const clamped = Math.round(Math.max(MIN_ORB_SIZE, Math.min(MAX_ORB_SIZE, size)))
    const [ox, oy] = mainWindow.getPosition()
    const [ow] = mainWindow.getSize()
    const delta = clamped - ow
    const nx = Math.round(ox - delta / 2)
    const ny = Math.round(oy - delta / 2)
    mainWindow.setSize(clamped, clamped)
    mainWindow.setPosition(nx, ny)
    store.set('orb.size', clamped)
  })

  ipcMain.handle('orb:getSize', () => getOrbSize())

  ipcMain.handle('config:whisperModel', () => {
    return process.env.WHISPER_MODEL || 'base'
  })

  ipcMain.handle('settings:get', () => ({
    envOverrides: getEffectiveEnvOverrides(store),
    llmBackend:   store.get('llmBackend', process.env.LLM_BACKEND ?? 'emergent') as string,
    whisperModel: store.get('whisperModel', process.env.WHISPER_MODEL ?? 'base') as string,
    /** `phrases` = Silero VAD + Whisper ("hey jarviz", …). `picovoice` = Picovoice "Jarvis" keyword if key set. */
    wakeWordMode: (store.get('wakeWordMode') as 'phrases' | 'picovoice' | undefined) ?? 'phrases',
    allowDestructiveShell: store.get('agent.allowDestructiveShell', false) === true,
    anthropicThinking:     store.get('agent.anthropicThinking', true) !== false,
    mcpServers:            (store.get('mcpServers', []) as unknown[]) ?? [],
  }))

  ipcMain.handle('settings:set', (
    _,
    patch: {
      envOverrides?: Record<string, string>
      llmBackend?:   string
      whisperModel?: string
      wakeWordMode?: 'phrases' | 'picovoice'
      allowDestructiveShell?: boolean
      anthropicThinking?: boolean
      mcpServers?: unknown
    },
  ) => {
    if (patch.envOverrides !== undefined) store.set('envOverrides', patch.envOverrides)
    if (patch.llmBackend !== undefined) store.set('llmBackend', patch.llmBackend)
    if (patch.whisperModel !== undefined) store.set('whisperModel', patch.whisperModel)
    if (patch.wakeWordMode !== undefined) store.set('wakeWordMode', patch.wakeWordMode)
    if (patch.allowDestructiveShell !== undefined) store.set('agent.allowDestructiveShell', !!patch.allowDestructiveShell)
    if (patch.anthropicThinking !== undefined) store.set('agent.anthropicThinking', !!patch.anthropicThinking)
    if (patch.mcpServers !== undefined) {
      const parsed = parseMcpServers(patch.mcpServers)
      if (!parsed) return false
      store.set('mcpServers', parsed)
    }
    mergeStoredEnv(store)
    if (patch.mcpServers !== undefined) {
      void mcpRefreshFromStore(store).catch((e) => console.error('[MCP] refresh:', e))
    }
    return true
  })

  ipcMain.on('renderer:log', (_, msg: string) => console.log('[UI]', msg))

  // ── Native STT (whisper.cpp) ─────────────────────────────────────────────
  ipcMain.handle('stt:whispercpp:transcribeWav', async (_, { wavBytes }: { wavBytes: number[] }) => {
    const bytes = Uint8Array.from(wavBytes)
    const text = await runWhisperCppTranscribe(bytes)
    return { text }
  })

  ipcMain.on('agent:cancel', () => {
    if (agentAbort) {
      agentAbort.abort()
      agentAbort = null
      console.log('[Agent] cancelled by user')
    }
  })

  ipcMain.handle('agent:query', async (event, { text }: { text: string }) => {
    const now = Date.now()
    if (now - lastQueryAt > SESSION_TIMEOUT_MS) {
      conversationHistory = []
      transcripts.startNewSession()
    }
    lastQueryAt = now

    const sendState = (state: string) => event.sender.send('agent:state', { state })

    sendState('thinking')
    try {
      const { reply, history } = await runAgent(
        text,
        conversationHistory as never,
        (state) => sendState(state),
      )
      conversationHistory = history.slice(-20)
      transcripts.append(text, reply)

      sendState('speaking')

      // Sentence-pipelined TTS — emit each chunk as soon as its audio is ready
      // so the renderer can start speaking the first sentence within ~0.5-1s
      // instead of waiting 3-6s for the full reply to synthesize.
      streamSpeak(reply, (chunk: SpeechChunk) => {
        event.sender.send('agent:speakChunk', chunk)
      }).catch(err => console.error('[Agent] streamSpeak error:', err))

      return {
        text:      reply,
        audio:     null,    // legacy field retained for type-compat; chunks ride on agent:speakChunk
        audioMime: null,
        streaming: true,
      }
    } catch (err) {
      const raw = (err as Error)?.message ?? String(err)
      console.error('[Agent] error:', raw)
      sendState('idle')
      let text = 'I encountered an error. Please try again.'
      if (/credit balance|insufficient|quota|billing/i.test(raw))
        text = 'All configured API keys are out of credits. Add credits or open Settings and add a working key.'
      else if (/api[_ ]?key|authenticat|401|403/i.test(raw))
        text = 'API key is invalid or unauthorized. Open Settings or check your dot env file.'
      else if (/network|fetch|ENOTFOUND|ETIMEDOUT/i.test(raw))
        text = 'Network error reaching the language model. Check your connection.'
      return { text, audio: null, audioMime: null, streaming: false }
    }
  })

  // ── Transcripts ──────────────────────────────────────────────────────────
  ipcMain.handle('transcripts:list',  () => transcripts.list().map(s => ({
    id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, preview: s.preview, turns: s.turns.length,
  })))
  ipcMain.handle('transcripts:get',    (_, id: string)  => transcripts.get(id))
  ipcMain.handle('transcripts:delete', (_, id: string)  => { transcripts.delete(id);  return true })
  ipcMain.handle('transcripts:clear',  () => { transcripts.clearAll(); conversationHistory = []; return true })
  ipcMain.handle('transcripts:newSession', () => {
    transcripts.startNewSession()
    conversationHistory = []
    return true
  })

  // ── Screen / Mini-mode ──────────────────────────────────────────────────
  ipcMain.handle('screen:primarySize', () => {
    const d = screen.getPrimaryDisplay()
    return { width: d.size.width, height: d.size.height, x: d.bounds.x, y: d.bounds.y }
  })

  ipcMain.handle('orb:setMini', (_, on: boolean) => {
    setMiniMode(!!on)
    return miniMode
  })
  ipcMain.handle('orb:getMini', () => miniMode)

  const setOrbOverlayVisible = (visible: boolean): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (visible) {
      try { mainWindow.setAlwaysOnTop(true, 'screen-saver') } catch { /* noop */ }
      if (!mainWindow.isVisible()) {
        if (process.platform === 'darwin') mainWindow.showInactive()
        else mainWindow.show()
      }
    } else {
      try { mainWindow.setAlwaysOnTop(false) } catch { /* noop */ }
      if (mainWindow.isVisible()) mainWindow.hide()
    }
  }

  // ── Orb → Panel relay (for live status mirror) ──────────────────────────
  ipcMain.on('orb:state', (_, state: string) => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('panel:agentState', state)
    }

    // Menu-bar native: show orb overlay only when active.
    // (Renderer continues running even when the window is hidden.)
    if (process.platform === 'darwin') {
      if (!jarvizEnabled) {
        setOrbOverlayVisible(false)
        return
      }
      const s = String(state || '').toLowerCase()
      const active = s === 'listening' || s === 'speaking' || s === 'thinking'
      setOrbOverlayVisible(active)
    }
  })
  ipcMain.on('orb:caption', (_, c: { phase: string; user: string; reply: string }) => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('panel:caption', c)
    }
  })

  // ── Updater ─────────────────────────────────────────────────────────────
  ipcMain.handle('updater:install', () => { quitAndInstallUpdate(); return true })

  // ── App settings (macOS native) ─────────────────────────────────────────
  ipcMain.handle('app:getLaunchAtLogin', () => {
    return !!(store.get('app.launchAtLogin', false) as boolean)
  })
  ipcMain.handle('app:setLaunchAtLogin', (_, on: boolean) => {
    const next = !!on
    store.set('app.launchAtLogin', next)
    applyLaunchAtLoginSetting()
    return next
  })
  ipcMain.handle('app:getJarvizEnabled', () => jarvizEnabled)
  ipcMain.handle('app:setJarvizEnabled', (_, on: boolean) => {
    setJarvizEnabled(!!on)
    return jarvizEnabled
  })

  // ── Agent Memory / Permissions / Activity ───────────────────────────────
  ipcMain.handle('memory:list', (_, opts?: { kind?: string; projectRoot?: string; limit?: number }) => {
    return memoryList({
      kind: (opts?.kind as never) ?? undefined,
      projectRoot: opts?.projectRoot,
      limit: opts?.limit,
    })
  })
  ipcMain.handle('memory:search', (_, { query, kind, projectRoot, limit }: { query: string; kind?: string; projectRoot?: string; limit?: number }) => {
    return memorySearch(String(query ?? ''), { kind: (kind as never) ?? undefined, projectRoot, limit })
  })
  ipcMain.handle('memory:upsert', (_, item: { id?: string; kind: string; title: string; text: string; tags?: string[]; projectRoot?: string }) => {
    return memoryUpsert({
      id: item.id,
      kind: item.kind as never,
      title: item.title,
      text: item.text,
      tags: item.tags,
      projectRoot: item.projectRoot,
    })
  })
  ipcMain.handle('memory:delete', (_, { id }: { id: string }) => {
    return memoryDelete(String(id ?? ''))
  })
  ipcMain.handle('agent:permissions:get', () => permissionsGet())
  ipcMain.handle('agent:permissions:set', (_, next) => permissionsSet(next))
  ipcMain.handle('agent:memorySync:get', () => memorySyncEnabledGet())
  ipcMain.handle('agent:memorySync:set', (_, on: boolean) => memorySyncEnabledSet(!!on))
  ipcMain.handle('agent:activity:list', (_, { limit }: { limit?: number } = {}) => activityList(limit ?? 200))

  ipcMain.handle('system:openMacPrivacyPane', async (_, pane: string) => {
    if (process.platform !== 'darwin') return false
    const urls: Record<string, string> = {
      privacy:   'x-apple.systempreferences:com.apple.preference.security?Privacy',
      microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      screen:    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      files:     'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
      fullDisk:  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    }
    const url = urls[String(pane)]
    if (!url) return false
    try {
      await shell.openExternal(url)
      return true
    } catch {
      return false
    }
  })

  // ── Settings window (framed; tray opens only via menu) ─────────────────
  ipcMain.on('panel:show',     (_, section?: string) => showSettingsWindow(section))
  ipcMain.on('panel:hide',     () => hideSettingsWindow())
  ipcMain.handle('panel:toggle', () => { toggleSettingsWindow(); return true })

  ipcMain.handle('settings:getNativeLiquidGlass', () => settingsLiquidGlassId >= 0)

  ipcMain.handle('panel:getDiagnostics', () => ({
    platform:           `${process.platform}-${process.arch}`,
    uptimeMs:           Math.round(process.uptime() * 1000),
    envHasGeminiKey:    !!process.env.GEMINI_API_KEY,
    envHasEmergentKey:  !!process.env.EMERGENT_LLM_KEY,
    envGeminiVoice:     process.env.GEMINI_TTS_VOICE ?? '',
    llmBackend:         (process.env.LLM_BACKEND ?? 'emergent'),
    memoryMB:           Math.round(process.memoryUsage().rss / (1024 * 1024)),
  }))

  ipcMain.handle('panel:previewVoice', async (event, voice: string) => {
    try {
      const { synthesize } = await import('./agent/tts')
      // Temporarily override env for this preview only
      const prev = process.env.GEMINI_TTS_VOICE
      if (voice) process.env.GEMINI_TTS_VOICE = voice
      else delete process.env.GEMINI_TTS_VOICE
      try {
        const r = await synthesize('Good evening — Jarviz online and ready.')
        if (!r) {
          if (!process.env.GEMINI_API_KEY && voice) {
            return { ok: false, error: 'No GEMINI_API_KEY set. Add it in the Keys tab — get a free one at aistudio.google.com/apikey.' }
          }
          if (!process.env.ELEVENLABS_API_KEY && !voice) {
            return { ok: false, error: 'Voice is "Off" and no ElevenLabs key set — preview unavailable. The browser TTS plays during real conversations.' }
          }
          return { ok: false, error: 'Synthesis returned no audio (check API key validity).' }
        }
        // Send to panel for playback
        event.sender.send('panel:previewAudio', {
          audio: Array.from(r.buffer),
          mime:  r.mime,
        })
        return { ok: true }
      } finally {
        if (prev !== undefined) process.env.GEMINI_TTS_VOICE = prev
        else if (!voice) { /* already deleted */ }
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  const regShortcut = (accelerator: string, fn: () => void): void => {
    try {
      if (!globalShortcut.register(accelerator, fn)) {
        console.error(`[Main] globalShortcut could not register "${accelerator}" (another app may own it).`)
      }
    } catch (e) {
      console.error(`[Main] globalShortcut.register threw for "${accelerator}":`, e)
    }
  }

  regShortcut('CommandOrControl+Shift+J', () => {
    if (!jarvizEnabled) return
    mainWindow?.webContents.send('jarviz:activate')
  })

  regShortcut('CommandOrControl+,', () => {
    showSettingsWindow('keys')
  })

  regShortcut('CommandOrControl+Shift+M', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    setMiniMode(!miniMode)
  })
}

/** Toggle compact mini-mode: window shrinks to a small orb; click to restore. */
function setMiniMode(on: boolean): void {
  if (!mainWindow) return
  miniMode = on
  store.set('orb.miniMode', on)
  if (on) {
    const [ox, oy] = mainWindow.getPosition()
    const [ow]    = mainWindow.getSize()
    const dx = Math.round(ox + (ow - MINI_SIZE) / 2)
    const dy = Math.round(oy + (ow - MINI_SIZE) / 2)
    mainWindow.setSize(MINI_SIZE, MINI_SIZE)
    mainWindow.setPosition(dx, dy)
  } else {
    const target = getOrbSize()
    const [ox, oy] = mainWindow.getPosition()
    const [ow]    = mainWindow.getSize()
    const dx = Math.round(ox - (target - ow) / 2)
    const dy = Math.round(oy - (target - ow) / 2)
    mainWindow.setSize(target, target)
    mainWindow.setPosition(dx, dy)
  }
  mainWindow.webContents.send('orb:miniChanged', miniMode)
}

function createWindow(): void {
  registerMainProcessHandlers()

  const { x, y } = getInitialPosition()
  const orbSize = getOrbSize()

  mainWindow = new BrowserWindow({
    width: orbSize,
    height: orbSize,
    x,
    y,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    // Orb is an overlay surface; keep it out of task switchers on macOS.
    skipTaskbar: process.platform === 'darwin',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  mainWindow.setBackgroundColor('#00000000')
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.setIgnoreMouseEvents(false)

  mainWindow.webContents.session.setPermissionRequestHandler((_, permission, callback) => {
    const allowed = ['media', 'microphone', 'speech', 'notifications']
    callback(allowed.includes(permission))
  })
  mainWindow.webContents.session.setPermissionCheckHandler((_, permission) => {
    return ['media', 'microphone', 'speech'].includes(permission)
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.once('did-finish-load', () => {
    syncJarvizEnabledToRenderer()
    applyOrbHiddenWhenDisabled()
  })

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    // For menu-bar native UX on macOS, start hidden and only show when active (listening/speaking).
    if (process.platform !== 'darwin') {
      mainWindow.show()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ── Framed Settings window (not a menubar popover) ───────────────────────────
let settingsWindow: BrowserWindow | null = null
/** `-1` until `electron-liquid-glass` attaches on macOS settings load; used for renderer chrome split */
let settingsLiquidGlassId = -1
let appQuitting = false
app.on('before-quit', () => { appQuitting = true })

const SETTINGS_W = 820
const SETTINGS_H = 720

function settingsRendererUrl(): string {
  const rendererHtml = join(__dirname, '../renderer/index.html')
  const q = 'view=settings'
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}?${q}`
  }
  return `${pathToFileURL(rendererHtml).href}?${q}`
}

function centerSettingsWindow(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) return
  const b = settingsWindow.getBounds()
  const { workArea } = screen.getPrimaryDisplay()
  const x = Math.round(workArea.x + (workArea.width - b.width) / 2)
  const y = Math.round(workArea.y + (workArea.height - b.height) / 2)
  settingsWindow.setPosition(x, y)
}

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) return

  const isMac = process.platform === 'darwin'

  settingsWindow = new BrowserWindow({
    width:          SETTINGS_W,
    height:         SETTINGS_H,
    minWidth:       640,
    minHeight:      480,
    show:           false,
    frame:          true,
    titleBarStyle:  isMac ? 'hiddenInset' : 'default',
    /** Klack-style: traffic lights float on content chrome */
    trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
    resizable:      true,
    fullscreenable: false,
    skipTaskbar:    false,
    title:          'Jarviz',
    // macOS: transparent + optional `electron-liquid-glass` (do not set `vibrancy` with that path — README).
    backgroundColor: isMac ? '#00000000' : '#ececec',
    transparent:    isMac,
    vibrancy:       undefined,
    visualEffectState: undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isMac) {
    try {
      settingsWindow.setWindowButtonVisibility(true)
    } catch {
      /* Electron / OS version may omit API */
    }
  }

  settingsWindow.webContents.once('did-finish-load', () => {
    void (async (): Promise<void> => {
      const win = settingsWindow
      if (!win || win.isDestroyed()) return
      if (process.platform !== 'darwin') return
      const id = await attachMacLiquidGlass(win)
      settingsLiquidGlassId = id
      if (id < 0) {
        try {
          win.setVibrancy('sidebar')
        } catch {
          try {
            win.setVibrancy('under-window')
          } catch {
            /* older Electron / non-mac */
          }
        }
      }
    })()
  })

  settingsWindow.on('close', (e) => {
    if (!appQuitting) {
      e.preventDefault()
      settingsWindow?.hide()
    }
  })

  settingsWindow.loadURL(settingsRendererUrl())

  settingsWindow.on('closed', () => {
    settingsWindow = null
    settingsLiquidGlassId = -1
  })
}

function toggleSettingsWindow(section?: string): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) createSettingsWindow()
  if (!settingsWindow) return
  if (settingsWindow.isVisible()) {
    hideSettingsWindow()
  } else {
    showSettingsWindow(section)
  }
}

function showSettingsWindow(section?: string): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) createSettingsWindow()
  if (!settingsWindow) return
  centerSettingsWindow()
  settingsWindow.show()
  settingsWindow.focus()
  if (section) {
    const send = (): void => {
      if (!settingsWindow || settingsWindow.isDestroyed()) return
      settingsWindow.webContents.send('panel:focus-section', section)
    }
    const arm = (): void => {
      if (settingsWindow?.webContents.isLoading()) {
        settingsWindow?.webContents.once('did-finish-load', send)
      } else {
        send()
      }
      setTimeout(send, 80)
      setTimeout(send, 220)
    }
    arm()
  }
}

function hideSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.hide()
  }
}

function syncJarvizEnabledToRenderer(): void {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('jarviz:setEnabled', jarvizEnabled)
  if (settingsWindow && !settingsWindow.isDestroyed())
    settingsWindow.webContents.send('jarviz:setEnabled', jarvizEnabled)
}

function applyOrbHiddenWhenDisabled(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!jarvizEnabled) {
    try { mainWindow.setAlwaysOnTop(false) } catch { /* noop */ }
    if (mainWindow.isVisible()) mainWindow.hide()
  }
}

function setJarvizEnabled(on: boolean): void {
  jarvizEnabled = !!on
  store.set('app.jarvizEnabled', jarvizEnabled)
  applyOrbHiddenWhenDisabled()
  syncJarvizEnabledToRenderer()
  setApplicationMenu()
}

/** Shown as the first menu on macOS screen menu bar (Electron dev name is otherwise "Electron"). */
const APP_TITLE = 'Jarviz'

/** macOS menu bar + Windows/Linux menu with Settings, Quit, and standard roles. */
function setApplicationMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: APP_TITLE,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          type:      'checkbox',
          label:     'Jarviz is on',
          checked:   jarvizEnabled,
          click:     (item) => { setJarvizEnabled(!!item.checked) },
        },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: () => { showSettingsWindow('keys') } },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  } else {
    template.push({
      label: 'File',
      submenu: [
        {
          type:      'checkbox',
          label:     'Jarviz is on',
          checked:   jarvizEnabled,
          click:     (item) => { setJarvizEnabled(!!item.checked) },
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Ctrl+,',
          click: () => {
            showSettingsWindow('keys')
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  template.push(
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' as const }] : []),
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  )

  if (isMac) {
    template.push({
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      type:    'checkbox',
      label:   'Jarviz is on',
      checked: jarvizEnabled,
      click:   (item) => { setJarvizEnabled(!!item.checked) },
    },
    { type: 'separator' },
    {
      label:       'Settings…',
      accelerator: 'CommandOrControl+,',
      click:       () => { showSettingsWindow('keys') },
    },
    { type: 'separator' },
    { role: 'quit' },
  ])
}

function createTray(): void {
  const icon = createTrayIcon()
  if (icon.isEmpty())
    console.error('[Main] Tray icon empty — OS may hide menu-bar item. Check vite copied out/main/tray.png (see build log).')

  try {
    tray = new Tray(icon)
    ;(globalThis as unknown as { __jarvizTray?: Tray }).__jarvizTray = tray
    tray.setIgnoreDoubleClickEvents(true)
    tray.setToolTip('Jarviz')

    // Avoid showing two stacked menus: on macOS, Control+click (or some builds) can emit
    // both `click` and `right-click` for one gesture; debounce also collapses accidental double-fires.
    let lastTrayMenuAt = 0
    const TRAY_MENU_DEBOUNCE_MS = 350
    const popup = (): void => {
      if (!tray || tray.isDestroyed()) return
      const now = Date.now()
      if (now - lastTrayMenuAt < TRAY_MENU_DEBOUNCE_MS) return
      lastTrayMenuAt = now
      tray.popUpContextMenu(buildTrayMenu())
    }
    tray.on('click', popup)
    // macOS: only `click` — pairing `right-click` with the same handler often opens the menu twice.
    if (process.platform !== 'darwin') {
      tray.on('right-click', popup)
    }
  } catch (err) {
    console.error('[Main] Tray() threw — menu-bar item unavailable:', err)
    tray = null
  }
}

app.whenReady().then(() => {
  try {
    app.setAppUserModelId('com.jarviz.app')
    try {
      app.setName(APP_TITLE)
    } catch {
      /* setName may vary by Electron build */
    }

    // macOS: stay a normal foreground app (Dock + Cmd-Tab). Pure accessory + LSUIElement
    // made Jarviz look like "nothing opens" when the tray icon was easy to miss.
    if (process.platform === 'darwin') {
      try {
        ;(app as unknown as { setActivationPolicy?: (p: 'regular' | 'accessory' | 'prohibited') => void })
          .setActivationPolicy?.('regular')
      } catch {
        /* best-effort */
      }
    }

    tryAutoConfigureWhisperCpp()

    // Restore most recent session if user re-opened within idle window
    const restored = transcripts.restoreActive(SESSION_TIMEOUT_MS)
    if (restored.length) {
      conversationHistory = restored.map(t => ({ role: t.role, content: t.text })) as unknown[]
      lastQueryAt = Date.now()
      console.log(`[Main] restored ${restored.length} previous turns`)
    }

    // Restore mini-mode preference
    miniMode = store.get('orb.miniMode', false) as boolean

    applyLaunchAtLoginSetting()

    jarvizEnabled = !!(store.get('app.jarvizEnabled', true) as boolean)

    setApplicationMenu()
    createTray()
    createWindow()
    if (miniMode && mainWindow) setMiniMode(true)

    // MCP: defer until app is ready (stdio transports spawn children; doing this at import
    // time could race Electron init and made packaged builds feel "dead on launch").
    void mcpRefreshFromStore(store).catch((e) => console.error('[MCP] startup:', e))

    // First packaged launch: open Settings once the window can paint (avoids blank flash / lost focus).
    if (process.platform === 'darwin' && app.isPackaged) {
      const key = 'app.firstLaunchPresented'
      if (!store.get(key, false)) {
        createSettingsWindow()
        const w = settingsWindow
        if (w && !w.isDestroyed()) {
          const markDone = (): void => {
            if (store.get(key, false)) return
            store.set(key, true)
          }
          w.once('ready-to-show', () => {
            centerSettingsWindow()
            w.show()
            w.focus()
            markDone()
          })
          w.webContents.once('did-fail-load', (_e, code, desc) => {
            console.error('[Main] settings did-fail-load', code, desc)
            markDone()
          })
        } else {
          store.set(key, true)
        }
      }
    }

    // Settings window is created lazily on first tray menu / shortcut open.
    setupAutoUpdater(() => mainWindow)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  } catch (err) {
    console.error('[Main] whenReady failed:', err)
    const msg = err instanceof Error ? err.stack || err.message : String(err)
    try {
      dialog.showErrorBox('Jarviz — could not start', msg)
    } catch {
      /* noop */
    }
    app.quit()
  }
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') app.quit()
})
