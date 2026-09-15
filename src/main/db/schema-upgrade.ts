import type { Db } from './adapter'
import { createCategoryBackup } from './backup'
import { isEmptyDatabase } from './connection'
import type { DataSafetyContext } from './context'
import {
  migrate,
  type MigrationRecorder,
  type MigrationResult,
  type PreMigrationBackup
} from './migrate'

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

/**
 * The pre-migration backup (replacing the Phase 3A placeholder). A database that holds a schema or data gets a
 * verified backup in `backups\pre-migration` (the last 5 are kept) before any migration starts; if the backup
 * fails, the runner applies nothing. A new, empty database has nothing to lose and is migrated without one.
 */
export function verifiedPreMigrationBackup(ctx: DataSafetyContext): PreMigrationBackup {
  return async (db, plan) => {
    const versions = { from: plan.currentVersion, to: plan.latestVersion }
    if (isEmptyDatabase(db)) {
      ctx.log.info('[migrate] new database: no pre-migration backup is needed', versions)
      return
    }
    const backup = await createCategoryBackup(db, 'pre-migration', ctx)
    ctx.log.info('[migrate] verified pre-migration backup made', {
      file: backup.fileName,
      ...versions
    })
  }
}

/**
 * Brings `db` up to the newest schema of `ctx.migrations`: the verified pre-migration backup first, then each
 * pending migration in its own transaction, recorded in schema_migrations.
 */
export async function upgradeSchema(db: Db, ctx: DataSafetyContext): Promise<MigrationResult> {
  const result = await migrate(db, ctx.migrations, {
    backupBeforeMigrating: verifiedPreMigrationBackup(ctx),
    recordMigration: recordSchemaMigration(ctx.appVersion)
  })
  if (result.applied.length > 0) {
    ctx.log.info('[migrate] schema migrated', {
      from: result.fromVersion,
      to: result.toVersion,
      applied: result.applied.join(',')
    })
  }
  return result
}
