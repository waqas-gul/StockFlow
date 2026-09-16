import { z } from 'zod'
import type { IpcChannel } from '@shared/ipc-contract'
import { EditableSettingsPatchSchema } from '@shared/settings'
import { RESTORE_CONFIRMATION } from '@shared/types/backup'
import { readAppInfo, type AppInfoSources } from '../app-info'
import type { DataSafetyContext } from '../db/context'
import type { BackupService } from '../services/backup.service'
import type { LiveDatabase } from '../services/live-database'
import { integrityCheckReport } from '../services/maintenance.service'
import type { RestoreService } from '../services/restore.service'
import { readSettingsView, updateSettingsView } from '../services/settings.service'
import {
  registerIpcHandlers,
  type HandlerOptions,
  type IpcHandlers,
  type IpcRegistrar
} from './handle'

export interface IpcDependencies {
  /** The display-only facts of app.info(); its database is `database`. */
  readonly appInfo: Omit<AppInfoSources, 'db'>
  /** The app's database connection. It is refused while a restore runs and once StockFlow restarts. */
  readonly database: LiveDatabase
  readonly backups: BackupService
  readonly restore: RestoreService
  /** The migrations, clock and log of the running app. */
  readonly ctx: DataSafetyContext
}

/** Every call without input refuses any value, so no path can be passed where none is expected. */
const NO_INPUT = z.undefined()

/** backup.restore: the one-time token from selectRestoreCandidate and the typed confirmation. Never a path. */
export const RestoreRequestSchema = z.strictObject({
  token: z.string().regex(/^[0-9a-f]{32}$/),
  confirmation: z.literal(RESTORE_CONFIRMATION)
})

/** Every allow-listed IPC call and its implementation. The typecheck fails if one is missing. */
export function createIpcHandlers(deps: IpcDependencies): IpcHandlers {
  const { database, backups, restore, ctx } = deps
  return {
    app: {
      info: { input: NO_INPUT, run: () => readAppInfo({ ...deps.appInfo, db: database.get() }) }
    },
    settings: {
      get: { input: NO_INPUT, run: () => readSettingsView(database.get(), ctx.log) },
      update: {
        input: EditableSettingsPatchSchema,
        run: (patch) => updateSettingsView(database.get(), patch)
      }
    },
    backup: {
      status: { input: NO_INPUT, run: () => backups.status() },
      createManual: { input: NO_INPUT, run: () => backups.createManual() },
      openFolder: { input: NO_INPUT, run: () => backups.openFolder() },
      selectRestoreCandidate: { input: NO_INPUT, run: () => restore.selectCandidate() },
      restore: { input: RestoreRequestSchema, run: (request) => restore.restore(request) }
    },
    maintenance: {
      integrityCheck: { input: NO_INPUT, run: () => integrityCheckReport(database.get(), ctx) }
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
