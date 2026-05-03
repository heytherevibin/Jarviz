/**
 * Pinned CDN bases for ONNX Runtime + VAD assets.
 * Vite dev cannot serve `ort-wasm-*.mjs` from `/` — same-origin `./` breaks MicVAD.
 * Keep versions aligned with package-lock / npm (vad uses hoisted onnxruntime-web).
 */
export const VAD_WEB_VERSION = '0.0.30'
export const ONNXRUNTIME_WEB_FOR_VAD = '1.17.3'
export const TRANSFORMERS_JS_VERSION = '2.17.2'

export const VAD_DIST_CDN_BASE =
  `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_WEB_VERSION}/dist/` as const

export const ONNX_WASM_CDN_FOR_VAD =
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNXRUNTIME_WEB_FOR_VAD}/dist/` as const

/**
 * MicVAD loads ORT via dynamic `import()` + Workers. Electron/Vite often block that cross-origin
 * (jsDelivr). `electron-vite.config` copies `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{mjs,wasm}`
 * into `src/renderer/public/onnx-wasm/` so this URL is same-origin in dev and in packaged `file:` builds.
 */
export function vadOnnxWasmBasePath(): string {
  if (typeof window === 'undefined') return ONNX_WASM_CDN_FOR_VAD
  try {
    return new URL('onnx-wasm/', window.location.href).href
  } catch {
    return ONNX_WASM_CDN_FOR_VAD
  }
}

/** Same bundle @xenova/transformers ships for nested onnxruntime-web wasm. */
export const TRANSFORMERS_WASM_CDN_BASE =
  `https://cdn.jsdelivr.net/npm/@xenova/transformers@${TRANSFORMERS_JS_VERSION}/dist/` as const
