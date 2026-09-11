// StockFlow is Windows-only, so these paths follow Windows rules on every platform (including in tests).
import { win32 } from 'node:path'

/** The database file inside the data folder. */
export const DATABASE_FILE_NAME = 'shop.db'

export interface DataPaths {
  /** The pinned userData folder: %APPDATA%\StockFlow, or %APPDATA%\StockFlow-dev in development. */
  readonly root: string
  /** `<root>\data`: the database and its WAL files. */
  readonly dataDir: string
  /** `<root>\data\shop.db`. */
  readonly databaseFile: string
}

export function resolveDataPaths(root: string): DataPaths {
  const dataDir = win32.join(root, 'data')
  return { root, dataDir, databaseFile: win32.join(dataDir, DATABASE_FILE_NAME) }
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
