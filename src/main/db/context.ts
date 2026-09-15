import type { DataPaths } from '../data-paths'
import type { Logger } from '../logging'
import type { Db } from './adapter'
import type { Migration } from './migrate'

/** What the data-safety operations (startup, migration, backup, restore) need from the running app. */
export interface DataSafetyContext {
  readonly paths: DataPaths
  /** The running app's version, recorded in backup names, backup sidecars and schema_migrations. */
  readonly appVersion: string
  readonly log: Logger
  /** The schema migrations: the production list in the app, fixture lists in the tests. */
  readonly migrations: readonly Migration[]
  /** The clock for backup names and times. */
  readonly now: () => Date
  /** Failure injection for the tests. The app never sets it. */
  readonly faults?: DataSafetyFaults
}

/** Points at which the tests make a data-safety operation fail. Each runs only when set. */
export interface DataSafetyFaults {
  /** Backup: after SQLite wrote the temporary copy, before it is verified. */
  readonly afterBackupCopy?: (tempFile: string) => void
  /** Backup: after the temporary copy passed verification, before it is renamed to its final name. */
  readonly beforeBackupFinalize?: (tempFile: string, finalFile: string) => void
  /** Restore: after the current database was closed and set aside, before the restored copy is moved into place. */
  readonly beforeRestoreInstall?: () => void
  /** Restore: after the restored copy is in place, before it is opened. */
  readonly afterRestoreInstall?: (databaseFile: string) => void
  /** Restore: after the restored database was opened and migrated, before the final checks. */
  readonly beforeRestoreFinalCheck?: (db: Db) => void
}
