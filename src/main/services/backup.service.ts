import { mkdirSync, statSync } from 'node:fs'
import { win32 } from 'node:path'
import type { BackupStatus, ManualBackupResult } from '@shared/types/backup'
import { backupFolder, isSameOrInside, toDisplayLocation } from '../data-paths'
import { BackupError, createVerifiedBackup, type BackupInfo } from '../db/backup'
import { formatBackupFileName } from '../db/backup-files'
import { readUserVersion } from '../db/connection'
import type { DataSafetyContext } from '../db/context'
import { AppFailure } from '../errors'
import { backupFailureMessage, describeBackupStatus, type BackupStatusStore } from './backup-status'
import type { LiveDatabase } from './live-database'
import type { OperationLock } from './operation-lock'

/** The file dialogs of Settings → Backup & Restore. The main process opens them; the renderer never sends a path. */
export interface BackupDialogs {
  /** The Save dialog of a manual backup, opened at `defaultPath`. Null when the user cancels. */
  chooseBackupFile(defaultPath: string): Promise<string | null>
  /** The Open dialog of a restore, opened in `defaultFolder`. Null when the user cancels. */
  chooseRestoreFile(defaultFolder: string): Promise<string | null>
}

export interface BackupServiceDeps {
  readonly ctx: DataSafetyContext
  readonly database: LiveDatabase
  readonly lock: OperationLock
  readonly status: BackupStatusStore
  readonly dialogs: BackupDialogs
  /** Opens a folder in File Explorer (shell.openPath). Throws when it cannot. */
  readonly openFolder: (folder: string) => Promise<void>
  /** Where the first Save dialog opens: the user's Documents folder. */
  readonly documentsDir: string
  /** Absolute AppData and profile folders, only to shorten the paths shown in the renderer. */
  readonly appDataPath: string
  readonly homePath: string
}

const INSIDE_DATA_FOLDER =
  'Choose a folder outside the StockFlow data folder, such as a USB drive, a second drive or your Documents folder.'

/** Backup Now, Open Backup Folder and the backup status of Settings → Backup & Restore. */
export class BackupService {
  readonly #deps: BackupServiceDeps

  constructor(deps: BackupServiceDeps) {
    this.#deps = deps
  }

  status(): BackupStatus {
    const { ctx, lock, status, appDataPath, homePath } = this.#deps
    return describeBackupStatus({
      paths: ctx.paths,
      record: status.record,
      busy: lock.current !== null,
      appDataPath,
      homePath
    })
  }

  /**
   * Backup Now. The main process's Save dialog proposes a StockFlow backup name; the user chooses where (a USB drive,
   * a second drive or any folder outside the StockFlow data folder); the Phase 4A engine writes a verified backup
   * there and never replaces a file. The path stays in the main process: the renderer gets the file name and a
   * display form of the folder.
   */
  async createManual(): Promise<ManualBackupResult> {
    const { ctx, database, lock, dialogs, status, appDataPath, homePath } = this.#deps
    const db = database.get()
    return lock.run('MANUAL_BACKUP', async () => {
      const suggested = formatBackupFileName(ctx.now(), ctx.appVersion, readUserVersion(db))
      const chosen = await dialogs.chooseBackupFile(win32.join(this.#startFolder(), suggested))
      if (chosen === null) return { status: 'CANCELLED' }
      if (!win32.isAbsolute(chosen)) {
        throw new AppFailure({
          code: 'BACKUP_FAILED',
          message: 'This location cannot be used. Choose another folder.'
        })
      }
      const file = /\.db$/i.test(chosen) ? chosen : `${chosen}.db`
      const folder = win32.dirname(file)
      if (isSameOrInside(folder, ctx.paths.root)) {
        ctx.log.warn('[backup] a manual backup inside the StockFlow data folder was refused')
        throw new AppFailure({ code: 'BACKUP_FAILED', message: INSIDE_DATA_FOLDER })
      }
      let backup: BackupInfo
      try {
        backup = await createVerifiedBackup(db, folder, ctx, { fileName: win32.basename(file) })
      } catch (error) {
        const code = error instanceof BackupError ? error.code : null
        throw new AppFailure({ code: 'BACKUP_FAILED', message: backupFailureMessage(code) })
      }
      status.update({ lastManual: { at: backup.createdAt, fileName: backup.fileName, folder } })
      ctx.log.info('[backup] manual backup saved', { file: backup.fileName })
      return {
        status: 'CREATED',
        backup: {
          at: backup.createdAt,
          fileName: backup.fileName,
          location: toDisplayLocation(folder, appDataPath, homePath)
        }
      }
    })
  }

  /** Opens `<root>\backups\auto` in File Explorer: always this folder, never one the renderer names. */
  async openFolder(): Promise<void> {
    const folder = backupFolder(this.#deps.ctx.paths, 'auto')
    mkdirSync(folder, { recursive: true })
    await this.#deps.openFolder(folder)
  }

  /** The folder of the last manual backup while it still exists (e.g. the USB drive is plugged in), or Documents. */
  #startFolder(): string {
    const folder = this.#deps.status.record.lastManual?.folder
    return folder !== undefined && isDirectory(folder) ? folder : this.#deps.documentsDir
  }
}

function isDirectory(folder: string): boolean {
  try {
    return statSync(folder).isDirectory()
  } catch {
    return false
  }
}
