import type { BrowserWindow } from 'electron'

/**
 * Native macOS liquid / vibrancy glass via `electron-liquid-glass` (NSGlassEffectView on
 * supported OS builds, NSVisualEffectView fallback in the addon). Must not be combined
 * with BrowserWindow `vibrancy` — see package README.
 */
export async function attachMacLiquidGlass(win: BrowserWindow): Promise<number> {
  if (process.platform !== 'darwin') return -1
  try {
    const { default: liquidGlass } = await import('electron-liquid-glass')
    return liquidGlass.addView(win.getNativeWindowHandle(), {
      cornerRadius: 12,
      tintColor:    '#0a0c1248',
    })
  } catch (err) {
    console.warn('[Main] electron-liquid-glass attach failed — using CSS/vibrancy fallback if available:', err)
    return -1
  }
}
