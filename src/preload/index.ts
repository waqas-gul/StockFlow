import { contextBridge, ipcRenderer } from 'electron'
import { createApi } from './api'

// The renderer's only bridge to the main process: window.api.<domain>.<action>(input), one function per call in
// the shared IPC contract (src/shared/ipc-contract.ts), each sent with ipcRenderer.invoke on its own channel.
// Nothing else is exposed: no ipcRenderer, no channel names, no process, no Node APIs.
const api = createApi((channel, input) => ipcRenderer.invoke(channel, input))

if (!process.contextIsolated) {
  throw new Error('StockFlow requires contextIsolation to be enabled.')
}

contextBridge.exposeInMainWorld('api', api)
