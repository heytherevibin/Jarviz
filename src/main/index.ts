import { config } from 'dotenv'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
config({ path: join(__dirname, '../../.env'), override: true })

import { app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, nativeImage } from 'electron'
import Store from 'electron-store'
import { runAgent } from './agent/claude'
import { synthesize } from './agent/tts'
import { mergeStoredEnv } from './store-env'

// ── Crash recovery — keep IPC alive on unexpected errors ─────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[Main] unhandled rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[Main] uncaught exception:', err)
})

const store = new Store()
mergeStoredEnv(store)

const DEFAULT_ORB_SIZE = 360
const MIN_ORB_SIZE = 160
const MAX_ORB_SIZE = 600
const SNAP_THRESHOLD = 80
const SNAP_MARGIN = 12

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

let dragOffset = { x: 0, y: 0 }
let agentAbort: AbortController | null = null

// ── Agent session state ───────────────────────────────────────────────────────
let conversationHistory: Array<{ role: string; content: string; [k: string]: unknown }> = []
let lastQueryAt = 0
const SESSION_TIMEOUT_MS = 5 * 60 * 1000

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

/** macOS menu extras: smallest reliable path is decoding PNG bytes (path-only decode occasionally fails inside asar/watch). */
function createTrayIcon(): Electron.NativeImage {
  const trayPath = resolveTrayIconPath()
  if (!app.isPackaged) {
    console.log('[Main] tray probe cwd=', process.cwd(), '__dirname=', __dirname, 'chosen=', trayPath ?? '(none)')
  }

  if (trayPath) {
    try {
      const png = readFileSync(trayPath)
      const decoded = nativeImage.createFromBuffer(png)
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
      const fromPathImg = nativeImage.createFromPath(trayPath)
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

/** Show orb and make Jarviz the foreground app so the macOS system menu shows this app’s menus. */
function focusOrbWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.show()
  mainWindow.focus()
  if (process.platform === 'darwin') app.focus()
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
    envOverrides: store.get('envOverrides', {}) as Record<string, string>,
    llmBackend:   store.get('llmBackend', process.env.LLM_BACKEND ?? 'groq') as string,
    whisperModel: store.get('whisperModel', process.env.WHISPER_MODEL ?? 'base') as string,
  }))

  ipcMain.handle('settings:set', (
    _,
    patch: {
      envOverrides?: Record<string, string>
      llmBackend?:   string
      whisperModel?: string
    },
  ) => {
    if (patch.envOverrides !== undefined) store.set('envOverrides', patch.envOverrides)
    if (patch.llmBackend !== undefined) store.set('llmBackend', patch.llmBackend)
    if (patch.whisperModel !== undefined) store.set('whisperModel', patch.whisperModel)
    mergeStoredEnv(store)
    return true
  })

  ipcMain.on('renderer:log', (_, msg: string) => console.log('[UI]', msg))

  ipcMain.on('agent:cancel', () => {
    if (agentAbort) {
      agentAbort.abort()
      agentAbort = null
      console.log('[Agent] cancelled by user')
    }
  })

  ipcMain.handle('agent:query', async (event, { text }: { text: string }) => {
    const now = Date.now()
    if (now - lastQueryAt > SESSION_TIMEOUT_MS) conversationHistory = []
    lastQueryAt = now

    const sendState = (state: string) => event.sender.send('agent:state', { state })

    sendState('thinking')
    try {
      const { reply, history } = await runAgent(
        text,
        conversationHistory,
        (state) => sendState(state),
      )
      conversationHistory = history.slice(-20)

      sendState('speaking')
      const audioBuffer = await synthesize(reply)
      return { text: reply, audio: audioBuffer ? Array.from(audioBuffer) : null }
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
      return { text, audio: null }
    }
  })

  globalShortcut.register('CommandOrControl+Shift+J', () => {
    mainWindow?.webContents.send('jarviz:activate')
  })

  globalShortcut.register('CommandOrControl+,', () => {
    mainWindow?.webContents.send('jarviz:open-settings')
  })
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
    skipTaskbar: false,
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

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.show()
    if (process.platform === 'darwin') app.focus()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function openSettingsFromMenu(): void {
  if (!mainWindow) return
  if (!mainWindow.isDestroyed()) {
    focusOrbWindow()
    mainWindow.webContents.send('jarviz:open-settings')
  }
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
          label: 'Settings…',
          accelerator: 'Command+,',
          click: () => openSettingsFromMenu(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  } else {
    template.push({
      label: 'File',
      submenu: [
        {
          label: 'Settings…',
          accelerator: 'Ctrl+,',
          click: () => openSettingsFromMenu(),
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

function createTray(): void {
  const icon = createTrayIcon()
  if (icon.isEmpty())
    console.error('[Main] Tray icon empty — OS may hide menu-bar item. Check vite copied out/main/tray.png (see build log).')

  try {
    tray = new Tray(icon)
    ;(globalThis as unknown as { __jarvizTray?: Tray }).__jarvizTray = tray
    tray.setIgnoreDoubleClickEvents(true)
    tray.setToolTip('Jarviz')
    /** Text label helps when the raster is omitted or monochrome by the shell. macOS-only. */
    if (process.platform === 'darwin') tray.setTitle('Jarviz')

    if (process.platform === 'darwin') {
      tray.on('click', () => focusOrbWindow())
    }

    const menu = Menu.buildFromTemplate([
      { label: 'Jarviz', enabled: false },
      { type: 'separator' },
      {
        label: 'Settings…',
        accelerator: 'CommandOrControl+,',
        click: () => openSettingsFromMenu(),
      },
      { label: 'Show Orb', click: () => focusOrbWindow() },
      { type: 'separator' },
      { role: 'quit' },
    ])
    tray.setContextMenu(menu)
  } catch (err) {
    console.error('[Main] Tray() threw — menu-bar item unavailable:', err)
    tray = null
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.jarviz.app')
  try {
    app.setName(APP_TITLE)
  } catch {
    /* setName may vary by Electron build */
  }

  setApplicationMenu()
  createTray()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') app.quit()
})
