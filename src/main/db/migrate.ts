import type { Db } from './adapter'
import { readUserVersion } from './connection'

/** One forward-only schema change. A migration is never edited once it has shipped. */
export interface Migration {
  /** The schema version this migration produces: 1 for the first, then 2, 3, … with no gaps. */
  readonly version: number
  /** For example `0001_initial`. */
  readonly name: string
  /**
   * The SHA-256 of the migration's SQL, written `sha256:<64 hex digits>`. It is pinned in the migration's source
   * and recorded in `schema_migrations`; it is never recomputed at run time.
   */
  readonly checksum: string
  /** Applies the change. It runs inside the runner's transaction and must be synchronous. */
  up(db: Db): void
}

export interface MigrationPlan {
  /** `PRAGMA user_version` of the database. */
  readonly currentVersion: number
  /** The newest schema version this app understands. */
  readonly latestVersion: number
  readonly pending: readonly Migration[]
}

/**
 * Called once before the first pending migration is applied. It must resolve only after a verified backup of
 * the database exists (the Phase 4 backup system plugs in here); rejecting aborts with nothing applied.
 */
export type PreMigrationBackup = (db: Db, plan: MigrationPlan) => Promise<void>

/** Records an applied migration (for example in `schema_migrations`), inside that migration's transaction. */
export type MigrationRecorder = (db: Db, migration: Migration) => void

export interface MigrateOptions {
  readonly backupBeforeMigrating: PreMigrationBackup
  readonly recordMigration?: MigrationRecorder
}

export interface MigrationResult {
  readonly fromVersion: number
  readonly toVersion: number
  /** Names of the migrations applied by this run, in order. */
  readonly applied: readonly string[]
}

export type MigrationErrorCode =
  | 'INVALID_MIGRATIONS'
  | 'UNKNOWN_SCHEMA_VERSION'
  | 'DATABASE_TOO_NEW'
  | 'BACKUP_FAILED'
  | 'MIGRATION_FAILED'

export class MigrationError extends Error {
  readonly code: MigrationErrorCode
  /** The version of the migration that failed (MIGRATION_FAILED only). */
  readonly version?: number

  constructor(
    code: MigrationErrorCode,
    message: string,
    options: { cause?: unknown; version?: number } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'MigrationError'
    this.code = code
    this.version = options.version
  }
}

/** Checks that the versions run 1, 2, 3, … in order and that every name is present and unique. */
export function validateMigrations(migrations: readonly Migration[]): void {
  const names = new Set<string>()
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(
        'INVALID_MIGRATIONS',
        `Migration "${migration.name}" has version ${migration.version}; expected ${index + 1}.`
      )
    }
    const name = migration.name.trim()
    if (name === '' || names.has(name)) {
      throw new MigrationError(
        'INVALID_MIGRATIONS',
        `Migration ${migration.version} has a blank or duplicate name "${migration.name}".`
      )
    }
    names.add(name)
  })
}

/** Reads the schema version and lists the pending migrations. Refuses a database newer than the app. */
export function planMigrations(db: Db, migrations: readonly Migration[]): MigrationPlan {
  validateMigrations(migrations)
  const currentVersion = readUserVersion(db)
  const latestVersion = migrations.length
  if (currentVersion < 0) {
    throw new MigrationError(
      'UNKNOWN_SCHEMA_VERSION',
      `This database has an invalid schema version (${currentVersion}).`
    )
  }
  if (currentVersion > latestVersion) {
    throw new MigrationError(
      'DATABASE_TOO_NEW',
      `This database uses schema ${currentVersion}, but this version of StockFlow understands schemas up to ` +
        `${latestVersion}. Install the newer version of StockFlow, or restore a backup made by this version.`
    )
  }
  return { currentVersion, latestVersion, pending: migrations.slice(currentVersion) }
}

/**
 * Brings the database up to the newest schema. Nothing happens when it is current. Otherwise the pre-migration
 * backup runs first, then each pending migration runs in its own BEGIN IMMEDIATE transaction that also sets
 * `user_version` (and records the migration): a migration applies completely or not at all.
 *
 * Call it before any IPC request is served, so nothing else uses the connection meanwhile.
 */
export async function migrate(
  db: Db,
  migrations: readonly Migration[],
  options: MigrateOptions
): Promise<MigrationResult> {
  const plan = planMigrations(db, migrations)
  if (plan.pending.length === 0) {
    return { fromVersion: plan.currentVersion, toVersion: plan.currentVersion, applied: [] }
  }

  try {
    await options.backupBeforeMigrating(db, plan)
  } catch (error) {
    throw new MigrationError(
      'BACKUP_FAILED',
      `The pre-migration backup failed, so the database was not changed: ${messageOf(error)}`,
      { cause: error }
    )
  }

  const applied: string[] = []
  for (const migration of plan.pending) {
    try {
      db.transaction(() => {
        db.exec(`PRAGMA user_version = ${migration.version}`)
        // Returned so the transaction refuses (and rolls back) an async migration.
        const outcome = migration.up(db)
        options.recordMigration?.(db, migration)
        return outcome
      })
    } catch (error) {
      throw new MigrationError(
        'MIGRATION_FAILED',
        `Migration ${migration.name} failed and was rolled back: ${messageOf(error)}`,
        { cause: error, version: migration.version }
      )
    }
    applied.push(migration.name)
  }
  return { fromVersion: plan.currentVersion, toVersion: plan.latestVersion, applied }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
