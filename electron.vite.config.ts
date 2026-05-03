import { cpSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

const workspaceRoot = dirname(fileURLToPath(import.meta.url))
const trayAsset = join(workspaceRoot, 'resources/tray.png')

/** Copy tray.png beside `out/main/index.js`; base64/decoding is unreliable vs `createFromPath` on macOS. */
function copyTrayIntoMainOutPlugin(): Plugin {
  return {
    name: 'jarviz-copy-tray-main',
    /** Dev uses watch builds (`serve`), not full `vite build`; run for both so `out/main/tray.png` exists. */
    writeBundle(opts) {
      const outDir = opts.dir
      if (!outDir || basename(outDir) !== 'main') return
      if (!existsSync(trayAsset)) {
        console.warn('[jarviz] missing resources/tray.png — tray may be invisible until file exists')
        return
      }
      const dest = join(outDir, 'tray.png')
      cpSync(trayAsset, dest)
      console.log('[jarviz] copied tray icon →', dest)
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyTrayIntoMainOutPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
    assetsInclude: ['**/*.vert', '**/*.frag', '**/*.glsl'],
  },
})
