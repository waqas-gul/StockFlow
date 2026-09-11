import { ipcCalls, type IpcChannel, type StockFlowApi } from '@shared/ipc-contract'
import type { Result } from '@shared/types/result'

/** Sends one allow-listed call to the main process (`ipcRenderer.invoke` in the real preload). */
export type InvokeChannel = (channel: IpcChannel, input: unknown) => Promise<Result<unknown>>

/**
 * Builds `window.api` from the shared contract: one function per allow-listed call, each sending exactly one
 * input value on its own channel. The object is frozen and offers no generic IPC access.
 */
export function createApi(invoke: InvokeChannel): StockFlowApi {
  const api: Record<string, Record<string, (input?: unknown) => Promise<Result<unknown>>>> = {}
  for (const { domain, action, channel } of ipcCalls) {
    const functions = (api[domain] ??= {})
    functions[action] = (input?: unknown) => invoke(channel, input)
  }
  for (const functions of Object.values(api)) Object.freeze(functions)
  return Object.freeze(api) as unknown as StockFlowApi
}
