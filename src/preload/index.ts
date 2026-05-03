import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/** Agent round-trip must exceed IPC ceiling — LLM + tools + TTS can exceed 20s easily */
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
  dragStart: (mouseX: number, mouseY: number) =>
    ipcRenderer.send('drag:start', { mouseX, mouseY }),
  dragMove: (mouseX: number, mouseY: number) =>
    ipcRenderer.send('drag:move', { mouseX, mouseY }),
  dragEnd: () => ipcRenderer.send('drag:end'),

  onActivate: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('jarviz:activate', handler)
    return () => ipcRenderer.removeListener('jarviz:activate', handler)
  },

  onOpenSettings: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('jarviz:open-settings', handler)
    return () => ipcRenderer.removeListener('jarviz:open-settings', handler)
  },

  log: (msg: string) => ipcRenderer.send('renderer:log', msg),

  orbResize: (size: number) => ipcRenderer.send('orb:resize', { size }),
  orbGetSize: (): Promise<number> => ipcRenderer.invoke('orb:getSize'),

  getWhisperModel: (): Promise<string> => ipcRenderer.invoke('config:whisperModel'),

  settings: {
    get: (): Promise<{
      envOverrides: Record<string, string>
      llmBackend: string
      whisperModel: string
    }> => ipcRenderer.invoke('settings:get'),

    set: (patch: {
      envOverrides?: Record<string, string>
      llmBackend?: string
      whisperModel?: string
    }): Promise<boolean> => ipcRenderer.invoke('settings:set', patch),
  },

  agent: {
    query: (text: string): Promise<{ text: string; audio: number[] | null }> =>
      invokeWithTimeout('agent:query', { text }),

    cancel: () => ipcRenderer.send('agent:cancel'),

    onState: (cb: (state: string) => void) => {
      const handler = (_: Electron.IpcRendererEvent, { state }: { state: string }) => cb(state)
      ipcRenderer.on('agent:state', handler)
      return () => ipcRenderer.removeListener('agent:state', handler)
    },
  },
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
