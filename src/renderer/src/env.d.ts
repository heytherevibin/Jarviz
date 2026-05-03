/// <reference types="vite/client" />
import type { JarvizAPI } from '../../preload/index'

declare global {
  interface Window {
    jarviz: JarvizAPI
  }
}

declare module '*.vert?raw' {
  const src: string
  export default src
}
declare module '*.frag?raw' {
  const src: string
  export default src
}
declare module '*.glsl?raw' {
  const src: string
  export default src
}
