declare global {
  /** API exposed to the renderer by the preload script. Empty until IPC contracts are added. */
  type StockFlowApi = Readonly<Record<string, never>>

  interface Window {
    readonly api: StockFlowApi
  }
}

export {}
