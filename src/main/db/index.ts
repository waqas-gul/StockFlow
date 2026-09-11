import type { Db } from './adapter'
import { isEmptyDatabase, openDatabase } from './connection'
import { migrate, type PreMigrationBackup } from './migrate'
import { migrations } from './migrations'

/**
 * Placeholder for the verified pre-migration backup of Phase 4. It never pretends to back anything up: it lets
 * migrations run only on an empty database (nothing to lose) and refuses every other database.
 */
export const preMigrationBackupNotAvailable: PreMigrationBackup = async (db) => {
  if (isEmptyDatabase(db)) return
  throw new Error(
    'A verified pre-migration backup is required before an existing database can be migrated, ' +
      'and backups are not available yet (Phase 4).'
  )
}

/**
 * Opens the app database and brings its schema up to date. Call it before any window or IPC handler exists.
 * On failure the connection is closed and the error thrown.
 */
export async function initializeDatabase(file: string): Promise<Db> {
  const db = openDatabase(file)
  try {
    await migrate(db, migrations, { backupBeforeMigrating: preMigrationBackupNotAvailable })
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
