import { contextBridge } from 'electron'

// The renderer's only bridge to the main process. Typed domain functions
// (window.api.<domain>.<action>) are added in later phases from the shared IPC contract.
// Nothing else is exposed: no ipcRenderer, no process, no Node APIs.
const api = Object.freeze({})

if (!process.contextIsolated) {
  throw new Error('StockFlow requires contextIsolation to be enabled.')
}

contextBridge.exposeInMainWorld('api', api)
