import type { Db } from './adapter'
import { createCategoryBackup } from './backup'
import { isEmptyDatabase } from './connection'
import type { DataSafetyContext } from './context'
import {
  migrate,
  planMigrations,
  type Migration,
  type MigrationRecorder,
  type MigrationResult,
  type PreMigrationBackup
} from './migrate'

/** What the user is shown when the schema of a database cannot be verified. No technical detail. */
export const SCHEMA_VERIFICATION_MESSAGE =
  'StockFlow detected a database schema verification problem.\nYour data has not been changed.\n' +
  'Restore a verified backup or contact support.'

/** An applied migration whose recorded checksum differs from the checksum this app pins for it. */
export interface ChecksumMismatch {
  readonly version: number
  /** This app's name for the migration. */
  readonly migration: string
  /** The checksum pinned in this app. */
  readonly expected: string
  /** The checksum recorded in schema_migrations when the migration was applied. */
  readonly actual: string
}

/**
 * An applied migration does not match this version of StockFlow: a shipped migration was edited, the recorded
 * history was altered, or the database and the app disagree about the schema. Such a database is not safe for
 * business writes, so it is refused (normal startup stops) and nothing in it is changed. The message is safe to
 * show; the cause carries the technical detail for the log.
 */
export class SchemaChecksumMismatchError extends Error {
  readonly code = 'SCHEMA_CHECKSUM_MISMATCH'
  readonly mismatches: readonly ChecksumMismatch[]

  constructor(mismatches: readonly ChecksumMismatch[]) {
    super(SCHEMA_VERIFICATION_MESSAGE, {
      cause: new Error(mismatches.map(describeMismatch).join(' '))
    })
    this.name = 'SchemaChecksumMismatchError'
    this.mismatches = mismatches
  }
}

/**
 * Every migration recorded in schema_migrations whose checksum differs from the one this app pins for that
 * version. A recorded migration this app does not know (a newer schema) or a missing history is not a mismatch:
 * those keep their own errors and warnings.
 */
export function appliedChecksumMismatches(
  db: Db,
  migrations: readonly Migration[]
): ChecksumMismatch[] {
  const history = db.get(
    "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'"
  )
  if (history === undefined) return []
  const rows = db.all<{ version: number; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version'
  )
  const mismatches: ChecksumMismatch[] = []
  for (const row of rows) {
    const migration = migrations.find((candidate) => candidate.version === row.version)
    if (migration !== undefined && row.checksum !== migration.checksum) {
      mismatches.push({
        version: row.version,
        migration: migration.name,
        expected: migration.checksum,
        actual: row.checksum
      })
    }
  }
  return mismatches
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
 * Brings `db` up to the newest schema of `ctx.migrations`:
 *
 * 1. the migration list and the schema version are checked (an invalid, unknown or newer schema keeps its own
 *    MigrationError);
 * 2. every applied migration's recorded checksum must equal this app's: otherwise a SchemaChecksumMismatchError is
 *    thrown before anything is backed up, migrated or changed, and nothing is ever "corrected";
 * 3. the verified pre-migration backup, then each pending migration in its own transaction, recorded in
 *    schema_migrations and checked with PRAGMA foreign_key_check before it commits.
 */
export async function upgradeSchema(db: Db, ctx: DataSafetyContext): Promise<MigrationResult> {
  planMigrations(db, ctx.migrations)
  const mismatches = appliedChecksumMismatches(db, ctx.migrations)
  if (mismatches.length > 0) {
    for (const mismatch of mismatches) {
      ctx.log.error(
        '[schema] applied migration checksum mismatch: the database is refused and left unchanged',
        undefined,
        { ...mismatch }
      )
    }
    throw new SchemaChecksumMismatchError(mismatches)
  }
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

function describeMismatch(mismatch: ChecksumMismatch): string {
  return (
    `Migration ${mismatch.version} (${mismatch.migration}) is recorded with checksum ${mismatch.actual}, ` +
    `but this version of StockFlow expects ${mismatch.expected}.`
  )
}
