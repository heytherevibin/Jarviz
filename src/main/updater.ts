import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Wires electron-updater. Only does work when the app is packaged AND a
 * publish target is configured in `build.publish` (package.json) / GH_TOKEN env.
 * In dev or unpackaged runs this is a complete no-op.
 */
export function setupAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) {
    console.log('[Updater] dev mode — auto-update disabled')
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = { info: (...a: unknown[]) => console.log('[Updater]', ...a),
                         warn: (...a: unknown[]) => console.warn('[Updater]', ...a),
                         error: (...a: unknown[]) => console.error('[Updater]', ...a),
                         debug: () => {} } as never

  autoUpdater.on('update-available',  info => getWindow()?.webContents.send('updater:status', { state: 'available',  info }))
  autoUpdater.on('download-progress', p   => getWindow()?.webContents.send('updater:status', { state: 'downloading', progress: p.percent }))
  autoUpdater.on('update-downloaded', info => getWindow()?.webContents.send('updater:status', { state: 'ready',       info }))
  autoUpdater.on('error',             err  => getWindow()?.webContents.send('updater:status', { state: 'error',       message: err.message }))

  // Check on startup, then every 6h
  autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  setInterval(() => { autoUpdater.checkForUpdatesAndNotify().catch(() => {}) }, 6 * 60 * 60 * 1000)
}

export function quitAndInstallUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.quitAndInstall()
}
