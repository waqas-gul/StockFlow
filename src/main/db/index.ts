import { errorCodeOf } from '../logging'
import type { Db } from './adapter'
import { ensureBackupFolders } from './backup'
import { openDatabase } from './connection'
import type { DataSafetyContext } from './context'
import { checkSchemaHistory } from './integrity'
import { recoverInterruptedRestore } from './restore'
import { upgradeSchema } from './schema-upgrade'

export { recordSchemaMigration, verifiedPreMigrationBackup } from './schema-upgrade'

/**
 * Opens the app database and brings its schema up to date. Call it before any window or IPC handler exists.
 *
 * 1. A restore interrupted by a crash is rolled back, so an incomplete restore is never opened.
 * 2. The database is opened with verified connection pragmas and its StockFlow marker checked.
 * 3. Pending migrations run, after a verified pre-migration backup when the database holds anything.
 * 4. The recorded schema history (migration names and checksums) is compared with this app's migrations. A
 *    mismatch is logged as a warning and never changed: it does not stop the app, because the data itself passed
 *    the checks above; the maintenance integrity report shows it as an error.
 * 5. The backup folders are created (a failure is logged; backups report their own failures).
 *
 * On failure the connection is closed and the error thrown.
 */
export async function initializeDatabase(ctx: DataSafetyContext): Promise<Db> {
  recoverInterruptedRestore(ctx.paths.databaseFile, ctx.log)
  const db = openDatabase(ctx.paths.databaseFile)
  try {
    const migration = await upgradeSchema(db, ctx)
    ctx.log.info('[startup] database ready', {
      schema: migration.toVersion,
      migrated: migration.applied.length
    })
    reportSchemaHistory(db, ctx)
    prepareBackupFolders(ctx)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function reportSchemaHistory(db: Db, ctx: DataSafetyContext): void {
  const history = checkSchemaHistory(db, ctx.migrations)
  if (history.status === 'OK') {
    ctx.log.info('[startup] schema history verified')
    return
  }
  ctx.log.warn(
    '[startup] the recorded schema history does not match this version of StockFlow; it is reported, not changed',
    { issues: history.issues.length, detail: history.issues.join(' | ') }
  )
}

function prepareBackupFolders(ctx: DataSafetyContext): void {
  try {
    ensureBackupFolders(ctx.paths)
  } catch (error) {
    ctx.log.warn('[startup] the backup folders could not be created', { code: errorCodeOf(error) })
  }
}
