// StockFlow is Windows-only, so these paths follow Windows rules on every platform (including in tests).
import { win32 } from 'node:path'

/** The database file inside the data folder. */
export const DATABASE_FILE_NAME = 'shop.db'

/**
 * The kinds of automatic backup, each in its own folder under `<root>\backups` with its own retention: scheduled
 * (`auto`), before every migration, and before every restore.
 */
export const BACKUP_CATEGORIES = Object.freeze(['auto', 'pre-migration', 'pre-restore'] as const)
export type BackupCategory = (typeof BACKUP_CATEGORIES)[number]

export interface DataPaths {
  /** The pinned userData folder: %APPDATA%\StockFlow, or %APPDATA%\StockFlow-dev in development. */
  readonly root: string
  /** `<root>\data`: the database and its WAL files. */
  readonly dataDir: string
  /** `<root>\data\shop.db`. */
  readonly databaseFile: string
  /** `<root>\logs`: the technical log. */
  readonly logsDir: string
  /** `<root>\logs\app.log`, rotated to app.log.1 … app.log.3. */
  readonly logFile: string
  /** `<root>\backups`: one folder per backup category. */
  readonly backupsDir: string
  /**
   * `<root>\recovery`: damaged databases that a restore moved aside, kept exactly as they were. They are never
   * verified backups, and are never listed, rotated or restored as backups.
   */
  readonly recoveryDir: string
}

export function resolveDataPaths(root: string): DataPaths {
  const dataDir = win32.join(root, 'data')
  const logsDir = win32.join(root, 'logs')
  return {
    root,
    dataDir,
    databaseFile: win32.join(dataDir, DATABASE_FILE_NAME),
    logsDir,
    logFile: win32.join(logsDir, 'app.log'),
    backupsDir: win32.join(root, 'backups'),
    recoveryDir: win32.join(root, 'recovery')
  }
}

/** `<root>\backups\<category>`. */
export function backupFolder(paths: DataPaths, category: BackupCategory): string {
  return win32.join(paths.backupsDir, category)
}

/** True when `target` is `folder` or inside it. Compared like Windows: case-insensitive, after resolving `..`. */
export function isSameOrInside(target: string, folder: string): boolean {
  const relative = win32.relative(
    win32.resolve(folder).toLowerCase(),
    win32.resolve(target).toLowerCase()
  )
  return relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative)
}

/**
 * A path for display in the renderer: `%APPDATA%\StockFlow\data` instead of the full path, so the Windows user
 * name never leaves the main process. A path outside AppData shows only its last folder name.
 */
export function toDisplayPath(target: string, appDataPath: string): string {
  const relative = win32.relative(appDataPath, target)
  if (relative === '') return '%APPDATA%'
  if (relative.startsWith('..') || win32.isAbsolute(relative)) {
    return `…\\${win32.basename(target)}`
  }
  return win32.join('%APPDATA%', relative)
}
