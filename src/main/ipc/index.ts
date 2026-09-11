import { z } from 'zod'
import type { IpcChannel } from '@shared/ipc-contract'
import { readAppInfo, type AppInfoSources } from '../app-info'
import {
  registerIpcHandlers,
  type HandlerOptions,
  type IpcHandlers,
  type IpcRegistrar
} from './handle'

export interface IpcDependencies {
  readonly appInfo: AppInfoSources
}

/** Every allow-listed IPC call and its implementation. The typecheck fails if one is missing. */
export function createIpcHandlers(deps: IpcDependencies): IpcHandlers {
  return {
    app: {
      info: { input: z.undefined(), run: () => readAppInfo(deps.appInfo) }
    }
  }
}

/** Registers every contract call with Electron's `ipcMain`, which src/main/index.ts passes in. */
export function registerIpc(
  registrar: IpcRegistrar,
  deps: IpcDependencies,
  options: HandlerOptions
): IpcChannel[] {
  return registerIpcHandlers(registrar, createIpcHandlers(deps), options)
}
