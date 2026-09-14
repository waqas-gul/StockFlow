import type { Db } from './adapter'
import { isEmptyDatabase, openDatabase } from './connection'
import { migrate, type MigrationRecorder, type PreMigrationBackup } from './migrate'
import { migrations } from './migrations'

/**
 * Placeholder for the verified pre-migration backup of Phase 4. It never pretends to back anything up: it lets
 * migrations run only on an empty database (nothing to lose) and refuses every other database. So 0001_initial
 * can create a new database, but no later migration can touch a database that holds a schema until Phase 4
 * replaces this with a real, verified backup.
 */
export const preMigrationBackupNotAvailable: PreMigrationBackup = async (db) => {
  if (isEmptyDatabase(db)) return
  throw new Error(
    'A verified pre-migration backup is required before an existing database can be migrated, ' +
      'and backups are not available yet (Phase 4).'
  )
}

/**
 * Records an applied migration in `schema_migrations`. The runner calls it inside the migration's own
 * transaction, so the row exists exactly when the migration does.
 */
export function recordSchemaMigration(appVersion: string): MigrationRecorder {
  return (db, migration) => {
    db.run(
      `INSERT INTO schema_migrations (version, name, applied_at, app_version, checksum)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
      [migration.version, migration.name, appVersion, migration.checksum]
    )
  }
}

export interface InitializeOptions {
  /** The running app's version, recorded with every migration it applies. */
  readonly appVersion: string
}

/**
 * Opens the app database and brings its schema up to date. Call it before any window or IPC handler exists.
 * On failure the connection is closed and the error thrown.
 */
export async function initializeDatabase(file: string, options: InitializeOptions): Promise<Db> {
  const db = openDatabase(file)
  try {
    await migrate(db, migrations, {
      backupBeforeMigrating: preMigrationBackupNotAvailable,
      recordMigration: recordSchemaMigration(options.appVersion)
    })
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
