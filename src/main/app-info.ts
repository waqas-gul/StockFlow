import type { AppInfo } from '@shared/types/app-info'
import { toDisplayPath } from './data-paths'
import type { Db } from './db/adapter'
import { readUserVersion } from './db/connection'

export interface AppInfoSources {
  readonly db: Db
  readonly appVersion: string
  readonly isDev: boolean
  /** Absolute data folder. Only its display form leaves the main process. */
  readonly dataDir: string
  readonly appDataPath: string
}

/** The answer to `app.info()`: display-safe values only, never absolute paths or handles. */
export function readAppInfo(sources: AppInfoSources): AppInfo {
  const { db } = sources
  const [{ version }] = db.all<{ version: string }>('SELECT sqlite_version() AS version')
  return {
    appVersion: sources.appVersion,
    mode: sources.isDev ? 'development' : 'production',
    databaseDriver: db.driver,
    sqliteVersion: version,
    schemaVersion: readUserVersion(db),
    dataDirectory: toDisplayPath(sources.dataDir, sources.appDataPath)
  }
}
