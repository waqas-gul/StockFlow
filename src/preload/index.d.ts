import type { StockFlowApi } from '@shared/ipc-contract'

declare global {
  interface Window {
    /** Exposed by the preload: one function per call in the shared IPC contract. */
    readonly api: StockFlowApi
  }
}

export {}
