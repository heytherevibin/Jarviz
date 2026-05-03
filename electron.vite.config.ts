import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

const workspaceRoot = dirname(fileURLToPath(import.meta.url))
const trayAsset = join(workspaceRoot, 'resources/tray.png')

/** Hoisted onnxruntime-web (vad-web); must match `onnxWASMBasePath` in renderer. */
const onnxWasmSrcDir = join(workspaceRoot, 'node_modules/onnxruntime-web/dist')
const onnxWasmPublicDir = join(workspaceRoot, 'src/renderer/public/onnx-wasm')
const ONNX_WASM_BUNDLE_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'] as const

function syncOnnxWasmToRendererPublic(): void {
  if (!existsSync(onnxWasmSrcDir)) {
    console.warn('[jarviz] onnxruntime-web dist missing — install deps; VAD WASM will fail')
    return
  }
  mkdirSync(onnxWasmPublicDir, { recursive: true })
  let n = 0
  for (const name of ONNX_WASM_BUNDLE_FILES) {
    const from = join(onnxWasmSrcDir, name)
    if (!existsSync(from)) {
      console.warn('[jarviz] missing ONNX file:', from)
      continue
    }
    cpSync(from, join(onnxWasmPublicDir, name))
    n++
  }
  if (n === ONNX_WASM_BUNDLE_FILES.length) {
    console.log('[jarviz] synced ONNX wasm for VAD →', onnxWasmPublicDir)
  }
}

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

/** Same-origin ORT wasm for MicVAD — Electron often rejects cross-origin `import()` of ort-wasm-*.mjs from CDNs. */
function syncOnnxWasmPlugin(): Plugin {
  return {
    name: 'jarviz-sync-onnx-wasm-public',
    buildStart() {
      syncOnnxWasmToRendererPublic()
    },
  }
}

export default defineConfig({
  main: {
    /** Bundle MCP SDK: Node 22 + this package's `exports` wildcard breaks `require('@modelcontextprotocol/sdk/client/stdio')` in production. */
    plugins: [externalizeDepsPlugin({ exclude: ['@modelcontextprotocol/sdk'] }), copyTrayIntoMainOutPlugin()],
    build: {
      rollupOptions: {
        /** Native `.node` — must load from node_modules at runtime, not roll into the bundle */
        external: ['electron-liquid-glass'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), syncOnnxWasmPlugin()],
    assetsInclude: ['**/*.vert', '**/*.frag', '**/*.glsl'],
  },
})
