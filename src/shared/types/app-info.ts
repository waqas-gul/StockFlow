/** SQLite drivers the Db adapter can run on. better-sqlite3 was selected in Phase 3A; node:sqlite is the fallback. */
export type DatabaseDriver = 'better-sqlite3' | 'node:sqlite'

/** Safe, display-only facts about the running app, returned by `window.api.app.info()`. */
export interface AppInfo {
  readonly appVersion: string
  readonly mode: 'development' | 'production'
  readonly databaseDriver: DatabaseDriver
  readonly sqliteVersion: string
  /** `PRAGMA user_version` of the open database. */
  readonly schemaVersion: number
  /** The data folder in display form (e.g. `%APPDATA%\StockFlow\data`), never the full user path. */
  readonly dataDirectory: string
}
