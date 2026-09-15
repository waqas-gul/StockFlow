import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { win32 } from 'node:path'
import { z } from 'zod'
import { isSameOrInside, type DataPaths } from '../data-paths'
import { errorCodeOf, type Logger } from '../logging'
import { openSqlite, type Db } from './adapter'
import { createCategoryBackup, readSidecar, type BackupInfo } from './backup'
import { parseBackupFileName } from './backup-files'
import {
  STOCKFLOW_APPLICATION_ID,
  openDatabase,
  readApplicationId,
  readUserVersion
} from './connection'
import type { DataSafetyContext } from './context'
import type { Migration, MigrationResult } from './migrate'
import {
  freeRecoveryFile,
  isRecoveryFileName,
  quarantineDatabaseFiles,
  reinstateQuarantined
} from './quarantine'
import {
  SchemaChecksumMismatchError,
  appliedChecksumMismatches,
  upgradeSchema,
  type ChecksumMismatch
} from './schema-upgrade'
import {
  foreignKeyViolations,
  integrityProblems,
  verifyDatabaseFile,
  type DatabaseFileError,
  type DatabaseFileProblem,
  type RecordCounts
} from './verify'

/*
 * Restore (plan §20.4), backend only: the future Settings screen (Phase 4B) chooses the file through a main-process
 * dialog, shows the summary, asks for confirmation, then calls restoreDatabase and relaunches the app. Phase 4B may
 * also offer it while normal startup is refused, when there is no open database (`live` is then null).
 *
 * The candidate is always validated first; if it fails, nothing else is touched. Then the current database decides
 * how it is kept:
 *
 * - HEALTHY (it opens and passes what a verified backup requires): a verified pre-restore backup is made, and the
 *   current database is set aside (shop.db.restore-rollback) until the restored one has passed its final checks.
 * - DAMAGED (it cannot be opened, fails integrity_check or foreign_key_check, or cannot be verified): it cannot have a
 *   verified backup, and SQLite's online backup is never run on it. Its files are moved, byte for byte, into
 *   <root>\recovery as damaged-live-db_<time>.db (with its -wal, -shm and -journal): a recovery artifact, kept as it
 *   was, never called a verified backup (quarantine.ts).
 *
 * The user never loses the previous database. From the moment it is moved until the restored one has passed its
 * final checks, a marker file (shop.db.restore-pending) says that a restore is in progress. Any failure puts the
 * previous files back; if even that fails, the next start does (recoverInterruptedRestore). A failed restore never
 * deletes anything of the previous database.
 */

export type RestoreErrorCode =
  | 'CANDIDATE_NOT_FOUND'
  | 'CANDIDATE_IS_LIVE_DATA'
  | 'NOT_A_DATABASE'
  | 'NOT_STOCKFLOW'
  | 'DAMAGED'
  | 'SCHEMA_TOO_NEW'
  | 'SCHEMA_CHECKSUM_MISMATCH'
  | 'UNREADABLE'
  | 'PRE_RESTORE_BACKUP_FAILED'
  | 'PRESERVATION_FAILED'
  | 'DATABASE_IN_USE'
  | 'REPLACE_FAILED'
  | 'REOPEN_FAILED'
  | 'MIGRATION_FAILED'
  | 'VERIFICATION_FAILED'
  | 'ROLLBACK_FAILED'

/** Why a restore did not happen. The message is safe to show to the user; the technical detail is its cause. */
export class RestoreError extends Error {
  readonly code: RestoreErrorCode

  constructor(code: RestoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RestoreError'
    this.code = code
  }
}

/** Where a restore failed. */
export type RestoreStage =
  | 'VALIDATION'
  | 'PRE_RESTORE_BACKUP'
  | 'PRESERVATION'
  | 'RELEASE'
  | 'REPLACE'
  | 'REOPEN'
  | 'MIGRATION'
  | 'VERIFICATION'
  | 'COMPLETION'

/** How the current database was kept: in a verified pre-restore backup, or preserved as a recovery artifact. */
export type RestorePath = 'HEALTHY' | 'DAMAGED'

/** Why the current database could not have a verified pre-restore backup. */
export type LiveDatabaseProblem =
  | 'MISSING'
  | 'CANNOT_OPEN'
  | 'INVALID_SCHEMA_VERSION'
  | 'INTEGRITY_CHECK_FAILED'
  | 'FOREIGN_KEY_CHECK_FAILED'
  | 'UNVERIFIABLE'

/** What a confirmation screen may show about a backup. No paths or business data. */
export interface RestoreSummary {
  readonly fileName: string
  readonly schemaVersion: number
  /** From the backup's sidecar or file name; null when neither says. */
  readonly appVersion: string | null
  /** From the sidecar or the file name, otherwise the file's modification time. ISO-8601 UTC. */
  readonly backupCreatedAt: string
  readonly sizeBytes: number
  readonly counts: RecordCounts
  /** True when the backup's schema is older than this app's: it is migrated after restoring. */
  readonly needsMigration: boolean
}

/**
 * A damaged database that a restore preserved in <root>\recovery, exactly as it was. It is NOT a backup: it failed
 * verification, it may hold the damage, and it is never listed, rotated or restored with the backups. StockFlow
 * keeps it (never deletes it) for a specialist.
 */
export interface RecoveryArtifact {
  /** The preserved database file's name, e.g. `damaged-live-db_2026-09-14_153045.db`. */
  readonly fileName: string
  /** Every preserved file in the order moved: the -wal, -shm and -journal that existed, then the database file. */
  readonly files: readonly string[]
  /** ISO-8601 UTC. */
  readonly preservedAt: string
  readonly reason: LiveDatabaseProblem
  /** Always false: a recovery artifact is never a verified backup. */
  readonly verified: false
}

export type RestoreOutcome =
  | {
      readonly ok: true
      /** The current database was healthy: it is kept in a verified pre-restore backup. */
      readonly path: 'HEALTHY'
      /** The restored database, open, migrated and verified. The caller relaunches the app with it. */
      readonly db: Db
      readonly summary: RestoreSummary
      readonly preRestoreBackup: BackupInfo
      readonly recoveryArtifact: null
      readonly migration: MigrationResult
    }
  | {
      readonly ok: true
      /** The current database was damaged or unverifiable: it is kept as a recovery artifact, never as a backup. */
      readonly path: 'DAMAGED'
      readonly db: Db
      readonly summary: RestoreSummary
      readonly preRestoreBackup: null
      /** Null when there was no database file to preserve. */
      readonly recoveryArtifact: RecoveryArtifact | null
      readonly migration: MigrationResult
    }
  | {
      readonly ok: false
      readonly stage: RestoreStage
      readonly error: RestoreError
      /**
       * The database to continue with: the caller's untouched connection, or the previous healthy database reopened.
       * Null when there is none: the caller had no open connection, the previous database is a damaged one (it is
       * put back as it was but never reopened here), or it could not be put back yet (the next start does it).
       */
      readonly db: Db | null
      /** True when the previous database had been moved and was put back. */
      readonly previousReinstated: boolean
      /** The path the restore took; null when the candidate failed validation, before the database was checked. */
      readonly path: RestorePath | null
    }

export interface RestoreFiles {
  /** The validated copy of the candidate that is moved into place. */
  readonly staging: string
  /** The temporary copy validated for a confirmation screen. */
  readonly check: string
  /** The previous (healthy) database, set aside during a restore. */
  readonly rollback: string
  /** Present from just before the previous database is closed until the restore is complete. */
  readonly pending: string
}

/** The working files of a restore, next to the database file (same folder, so every rename stays on one disk). */
export function restoreFilesOf(databaseFile: string): RestoreFiles {
  return {
    staging: `${databaseFile}.restore-staging`,
    check: `${databaseFile}.restore-check`,
    rollback: `${databaseFile}.restore-rollback`,
    pending: `${databaseFile}.restore-pending`
  }
}

const MESSAGES: Record<Exclude<RestoreErrorCode, 'ROLLBACK_FAILED'>, string> = {
  CANDIDATE_NOT_FOUND: 'The backup file could not be found.',
  CANDIDATE_IS_LIVE_DATA:
    'This file is part of the StockFlow data folder. Choose a backup file instead.',
  NOT_A_DATABASE: 'This file is not a StockFlow backup.',
  NOT_STOCKFLOW: 'This file is not a StockFlow backup.',
  DAMAGED: 'This backup is damaged and cannot be restored.',
  SCHEMA_TOO_NEW:
    'This backup was created by a newer version of StockFlow. Install the newer application version before restoring it.',
  SCHEMA_CHECKSUM_MISMATCH:
    'The schema of this backup could not be verified by this version of StockFlow, so it cannot be restored. ' +
    'Choose another backup or contact support.',
  UNREADABLE: 'This backup could not be read. Close any program that is using it and try again.',
  PRE_RESTORE_BACKUP_FAILED:
    'A safety backup of the current data could not be made, so nothing was restored.',
  PRESERVATION_FAILED:
    'The damaged database could not be moved to the recovery folder, so nothing was restored. ' +
    'Close any program that may be using it and try again.',
  DATABASE_IN_USE:
    'Another program is using the StockFlow database, so nothing was restored. Close it and try again.',
  REPLACE_FAILED: 'The backup could not be put in place. The previous data was kept.',
  REOPEN_FAILED: 'The restored database could not be opened. The previous data was put back.',
  MIGRATION_FAILED:
    'The backup could not be upgraded to this version of StockFlow. The previous data was put back.',
  VERIFICATION_FAILED:
    'The restored database failed its final check. The previous data was put back.'
}

const FILE_PROBLEMS: Record<DatabaseFileProblem, Exclude<RestoreErrorCode, 'ROLLBACK_FAILED'>> = {
  MISSING: 'CANDIDATE_NOT_FOUND',
  NOT_SQLITE: 'NOT_A_DATABASE',
  NOT_STOCKFLOW: 'NOT_STOCKFLOW',
  INVALID_SCHEMA_VERSION: 'DAMAGED',
  SCHEMA_TOO_NEW: 'SCHEMA_TOO_NEW',
  INTEGRITY_CHECK_FAILED: 'DAMAGED',
  FOREIGN_KEY_CHECK_FAILED: 'DAMAGED',
  UNREADABLE: 'UNREADABLE'
}

const STAGE_FAILURES: Record<
  Exclude<RestoreStage, 'VALIDATION' | 'PRE_RESTORE_BACKUP'>,
  Exclude<RestoreErrorCode, 'ROLLBACK_FAILED'>
> = {
  PRESERVATION: 'PRESERVATION_FAILED',
  RELEASE: 'DATABASE_IN_USE',
  REPLACE: 'REPLACE_FAILED',
  REOPEN: 'REOPEN_FAILED',
  MIGRATION: 'MIGRATION_FAILED',
  VERIFICATION: 'VERIFICATION_FAILED',
  COMPLETION: 'REPLACE_FAILED'
}

const DATABASE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const

/** The pending marker of a restore over a damaged database. */
interface DamagedMarker {
  readonly previous: 'DAMAGED'
  /** The recovery file name its files were moved to. */
  readonly quarantine: string
  /**
   * True once every file of the damaged database is in the recovery folder: any database file in the data folder
   * is then one the restore installed.
   */
  readonly preserved: boolean
  readonly startedAt?: string
  readonly reason?: LiveDatabaseProblem
}

const DamagedMarkerSchema = z.object({
  previous: z.literal('DAMAGED'),
  quarantine: z.string().refine(isRecoveryFileName),
  preserved: z.boolean()
})

/** The current database and whether it can have a verified backup (`problem` null). */
type CurrentDatabase =
  | { readonly problem: null; readonly db: Db; readonly openedHere: boolean }
  | { readonly problem: LiveDatabaseProblem; readonly db: Db | null; readonly openedHere: boolean }

/**
 * Checks a candidate backup for a confirmation screen, without restoring anything. The candidate is copied first
 * and only the copy is opened, so the candidate itself is never modified (opening even a WAL-flagged file would
 * create files next to it). Throws a RestoreError with a user-safe message.
 */
export function validateRestoreCandidate(
  candidateFile: string,
  ctx: DataSafetyContext
): RestoreSummary {
  const { check } = restoreFilesOf(ctx.paths.databaseFile)
  try {
    return stageCandidate(candidateFile, check, ctx)
  } finally {
    removeLeftover(check, ctx.log)
  }
}

/**
 * Restores `candidateFile` in place of the current database. `live` is the app's open connection, or null when
 * there is none (normal startup was refused): the database is then checked through a private copy, opened here only
 * when that copy is healthy, and a failed restore hands no connection back. The caller must not use `live`
 * afterwards unless the outcome returns it. Relaunching the app is the caller's job (Phase 4B).
 *
 * 1. Validate a private copy of the candidate: the file that will be installed. If it fails, nothing else is
 *    touched (not even a damaged current database).
 * 2. Check the current database as a verified backup requires: schema version, integrity_check and
 *    foreign_key_check. If it passes: restoreOverHealthy; otherwise, or when it cannot be opened: restoreOverDamaged.
 */
export async function restoreDatabase(
  live: Db | null,
  candidateFile: string,
  ctx: DataSafetyContext
): Promise<RestoreOutcome> {
  const { staging } = restoreFilesOf(ctx.paths.databaseFile)
  ctx.log.info('[restore] started', { file: win32.basename(candidateFile) })

  let summary: RestoreSummary
  try {
    summary = stageCandidate(candidateFile, staging, ctx)
  } catch (error) {
    return failure(ctx, 'VALIDATION', error as RestoreError, live, false, null)
  }

  const current = live !== null && live.isOpen ? assess(live, false) : openCurrentDatabase(ctx)
  const outcome =
    current.problem === null
      ? await restoreOverHealthy(current.db, summary, ctx)
      : await restoreOverDamaged(current.db, current.problem, summary, ctx)
  if (current.openedHere && !outcome.ok && outcome.db !== null) {
    // The caller had no connection, so none is handed back: the one opened here is closed.
    outcome.db.close()
    return { ...outcome, db: null }
  }
  return outcome
}

/**
 * The current database is healthy (the Phase 4A path):
 *
 * 1. make a verified backup of it in `backups\pre-restore`; if that fails, nothing is restored;
 * 2. checkpoint the WAL into shop.db and make sure nothing else is reading it;
 * 3. mark the restore as pending, close the live connection, and set shop.db aside (stale WAL/SHM removed);
 * 4. move the validated copy into place and reopen it with the verified connection pragmas;
 * 5. migrate it if it is older (with its own verified pre-migration backup);
 * 6. check the StockFlow marker, the schema version, integrity_check and foreign_key_check; then clear the marker.
 *
 * On any failure after step 3 the previous database is put back and reopened.
 */
async function restoreOverHealthy(
  live: Db,
  summary: RestoreSummary,
  ctx: DataSafetyContext
): Promise<RestoreOutcome> {
  const { databaseFile } = ctx.paths
  const files = restoreFilesOf(databaseFile)
  const failed = (
    stage: RestoreStage,
    error: RestoreError,
    db: Db | null,
    previousReinstated: boolean
  ): RestoreOutcome => failure(ctx, stage, error, db, previousReinstated, 'HEALTHY')

  let preRestoreBackup: BackupInfo
  try {
    preRestoreBackup = await createCategoryBackup(live, 'pre-restore', ctx)
  } catch (error) {
    const problem = new RestoreError(
      'PRE_RESTORE_BACKUP_FAILED',
      MESSAGES.PRE_RESTORE_BACKUP_FAILED,
      { cause: error }
    )
    return failed('PRE_RESTORE_BACKUP', problem, live, false)
  }

  try {
    // Waits up to the busy timeout for readers; a reader still holding a snapshot makes it report busy.
    const [checkpoint] = live.all<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')
    if (checkpoint.busy !== 0) throw new Error('Another connection is reading the database.')
  } catch (error) {
    const problem = new RestoreError('DATABASE_IN_USE', MESSAGES.DATABASE_IN_USE, { cause: error })
    return failed('RELEASE', problem, live, false)
  }
  try {
    const marker = {
      startedAt: ctx.now().toISOString(),
      preRestoreBackup: preRestoreBackup.fileName
    }
    writeFileSync(files.pending, `${JSON.stringify(marker)}\n`)
  } catch (error) {
    removeQuietly(files.pending)
    const problem = new RestoreError('REPLACE_FAILED', MESSAGES.REPLACE_FAILED, { cause: error })
    return failed('RELEASE', problem, live, false)
  }

  let stage: RestoreStage = 'RELEASE'
  let setAside = false
  let restored: Db | undefined
  try {
    live.close()
    if (sizeOf(`${databaseFile}-wal`) > 0) {
      throw new Error('The WAL still holds changes: another connection has the database open.')
    }
    // Windows refuses to rename a file that another program holds open.
    renameSync(databaseFile, files.rollback)
    setAside = true
    removeDatabaseFiles(databaseFile)

    stage = 'REPLACE'
    ctx.faults?.beforeRestoreInstall?.()
    renameSync(files.staging, databaseFile)

    stage = 'REOPEN'
    ctx.faults?.afterRestoreInstall?.(databaseFile)
    restored = openDatabase(databaseFile)

    stage = 'MIGRATION'
    const migration = await upgradeSchema(restored, ctx)

    stage = 'VERIFICATION'
    ctx.faults?.beforeRestoreFinalCheck?.(restored)
    assertRestored(restored, ctx)

    stage = 'COMPLETION'
    rmSync(files.pending)
    if (removeQuietly(files.rollback) !== undefined) {
      ctx.log.warn(
        '[restore] the previous database copy could not be removed; the next start removes it'
      )
    }
    ctx.log.info('[restore] the backup was restored', {
      file: summary.fileName,
      schema: migration.toVersion,
      migrated: migration.applied.length
    })
    return {
      ok: true,
      path: 'HEALTHY',
      db: restored,
      summary,
      preRestoreBackup,
      recoveryArtifact: null,
      migration
    }
  } catch (error) {
    const problem = stageError(stage, error)
    restored?.close()
    try {
      return failed(stage, problem, reinstatePrevious(databaseFile, setAside), setAside)
    } catch (rollbackError) {
      ctx.log.error(
        '[restore] the previous database could not be put back from its set-aside copy',
        rollbackError
      )
    }
    try {
      return failed(stage, problem, reinstateFromBackup(databaseFile, preRestoreBackup), true)
    } catch (backupError) {
      ctx.log.error(
        '[restore] the previous database could not be put back from the pre-restore backup',
        backupError,
        {
          file: preRestoreBackup.fileName
        }
      )
    }
    const fatal = new RestoreError(
      'ROLLBACK_FAILED',
      'The restore failed, and the previous data could not be put back yet. Restart StockFlow to put it back. ' +
        `A verified copy is also kept in the backup ${preRestoreBackup.fileName}.`,
      { cause: problem }
    )
    return failed(stage, fatal, null, false)
  }
}

/**
 * The current database is damaged, cannot be opened, or cannot be verified, so it cannot have a verified backup
 * (and SQLite's online backup is never run on it). It is preserved instead:
 *
 * 1. mark the restore as pending, naming the recovery file, and close the connection if there is one;
 * 2. move shop.db with its -wal, -shm and -journal into <root>\recovery as damaged-live-db_<time>.db…, byte for
 *    byte, then record in the marker that every file was moved;
 * 3. move the validated copy into place, reopen it, migrate it if it is older, and check it as the healthy path does;
 * 4. clear the marker. The preserved files stay in the recovery folder.
 *
 * On any failure the preserved files are put back exactly as they were (never reopened here, never deleted). If
 * even that fails, they stay in the recovery folder and the next start puts them back.
 */
async function restoreOverDamaged(
  current: Db | null,
  reason: LiveDatabaseProblem,
  summary: RestoreSummary,
  ctx: DataSafetyContext
): Promise<RestoreOutcome> {
  const { databaseFile, recoveryDir } = ctx.paths
  const files = restoreFilesOf(databaseFile)
  // A connection still open (never closed, or its close failed) is the caller's to keep using.
  const failed = (
    stage: RestoreStage,
    error: RestoreError,
    previousReinstated: boolean
  ): RestoreOutcome =>
    failure(
      ctx,
      stage,
      error,
      current !== null && current.isOpen ? current : null,
      previousReinstated,
      'DAMAGED'
    )
  ctx.log.warn(
    '[restore] the current database cannot have a verified backup: its files are preserved in the recovery folder instead',
    { reason }
  )

  const preservedAt = ctx.now()
  let marker: DamagedMarker
  try {
    mkdirSync(recoveryDir, { recursive: true })
    const quarantine = win32.basename(freeRecoveryFile(recoveryDir, preservedAt))
    marker = {
      previous: 'DAMAGED',
      quarantine,
      preserved: false,
      startedAt: preservedAt.toISOString(),
      reason
    }
    writeMarker(files.pending, marker)
  } catch (error) {
    removeQuietly(files.pending)
    return failed('PRESERVATION', stageError('PRESERVATION', error), false)
  }

  let stage: RestoreStage = 'PRESERVATION'
  let restored: Db | undefined
  try {
    current?.close()
    const moved = quarantineDatabaseFiles(databaseFile, win32.join(recoveryDir, marker.quarantine))
    const preserved: DamagedMarker = { ...marker, preserved: true }
    writeMarker(files.pending, preserved)
    marker = preserved
    const recoveryArtifact: RecoveryArtifact | null =
      moved.length === 0
        ? null
        : {
            fileName: marker.quarantine,
            files: moved,
            preservedAt: preservedAt.toISOString(),
            reason,
            verified: false
          }
    if (recoveryArtifact !== null) {
      ctx.log.info(
        '[restore] the damaged database was moved to the recovery folder; it is not a verified backup',
        { file: recoveryArtifact.fileName, files: moved.length }
      )
    }

    stage = 'REPLACE'
    ctx.faults?.beforeRestoreInstall?.()
    renameSync(files.staging, databaseFile)

    stage = 'REOPEN'
    ctx.faults?.afterRestoreInstall?.(databaseFile)
    restored = openDatabase(databaseFile)

    stage = 'MIGRATION'
    const migration = await upgradeSchema(restored, ctx)

    stage = 'VERIFICATION'
    ctx.faults?.beforeRestoreFinalCheck?.(restored)
    assertRestored(restored, ctx)

    stage = 'COMPLETION'
    rmSync(files.pending)
    ctx.log.info(
      '[restore] the backup was restored; the damaged database is kept in the recovery folder',
      {
        file: summary.fileName,
        schema: migration.toVersion,
        migrated: migration.applied.length,
        recovery: recoveryArtifact?.fileName ?? null
      }
    )
    return {
      ok: true,
      path: 'DAMAGED',
      db: restored,
      summary,
      preRestoreBackup: null,
      recoveryArtifact,
      migration
    }
  } catch (error) {
    const problem = stageError(stage, error)
    restored?.close()
    try {
      const reinstated = putBackPreserved(databaseFile, marker, files.pending, recoveryDir)
      removeQuietly(files.pending)
      return failed(stage, problem, reinstated)
    } catch (rollbackError) {
      ctx.log.error(
        '[restore] the damaged database could not be put back yet; it stays in the recovery folder and the next start puts it back',
        rollbackError,
        { file: marker.quarantine }
      )
      const fatal = new RestoreError(
        'ROLLBACK_FAILED',
        'The restore failed, and the previous data could not be put back yet. Restart StockFlow to put it back. ' +
          `Until then it is kept, unchanged, in the recovery folder (${marker.quarantine}).`,
        { cause: problem }
      )
      return failed(stage, fatal, false)
    }
  }
}

export type RestoreRecovery = 'NONE' | 'REINSTATED' | 'CLEANED_UP'

/**
 * Run at startup, before the database is opened. When a restore was interrupted (the marker is still there), the
 * previous database is put back in place of whatever was installed: the set-aside copy of a healthy database, or the
 * preserved files of a damaged one (from the recovery folder, exactly as they were). Leftovers of a completed restore
 * are removed. Throws when the previous database cannot be put back: opening an incomplete restore would be unsafe.
 */
export function recoverInterruptedRestore(paths: DataPaths, log: Logger): RestoreRecovery {
  const { databaseFile } = paths
  const files = restoreFilesOf(databaseFile)
  let cleaned = false
  for (const copy of [files.staging, files.check]) {
    if (DATABASE_SUFFIXES.some((suffix) => existsSync(`${copy}${suffix}`))) {
      removeDatabaseFiles(copy)
      cleaned = true
    }
  }
  if (existsSync(files.pending)) {
    const damaged = readDamagedMarker(files.pending)
    if (damaged !== null) {
      const reinstated = putBackPreserved(databaseFile, damaged, files.pending, paths.recoveryDir)
      rmSync(files.pending)
      if (reinstated) {
        log.warn(
          '[restore] an interrupted restore was rolled back: the damaged database is back in place, as it was'
        )
        return 'REINSTATED'
      }
      // Interrupted before any of its files was moved: the damaged database is still in place.
      cleaned = true
    } else if (existsSync(files.rollback)) {
      removeDatabaseFiles(databaseFile)
      renameSync(files.rollback, databaseFile)
      rmSync(files.pending)
      log.warn(
        '[restore] an interrupted restore was rolled back: the previous database is back in place'
      )
      return 'REINSTATED'
    } else {
      // Interrupted before the previous database was set aside: it is still in place.
      rmSync(files.pending)
      cleaned = true
    }
  } else if (existsSync(files.rollback)) {
    // A completed restore whose copy of the previous database was not removed (it is also in backups\pre-restore).
    rmSync(files.rollback)
    cleaned = true
  }
  if (!cleaned) return 'NONE'
  log.info('[restore] removed files left by an earlier restore')
  return 'CLEANED_UP'
}

/** Copies the candidate to `stagingFile`, verifies the copy and summarizes it. The candidate is only read. */
function stageCandidate(
  candidateFile: string,
  stagingFile: string,
  ctx: DataSafetyContext
): RestoreSummary {
  if (isSameOrInside(candidateFile, ctx.paths.dataDir)) {
    throw new RestoreError('CANDIDATE_IS_LIVE_DATA', MESSAGES.CANDIDATE_IS_LIVE_DATA)
  }
  let size: number
  let modified: Date
  try {
    const stats = statSync(candidateFile)
    if (!stats.isFile()) throw new Error('Not a file.')
    size = stats.size
    modified = stats.mtime
  } catch (error) {
    throw new RestoreError('CANDIDATE_NOT_FOUND', MESSAGES.CANDIDATE_NOT_FOUND, { cause: error })
  }
  try {
    removeDatabaseFiles(stagingFile)
    copyFileSync(candidateFile, stagingFile)
  } catch (error) {
    throw new RestoreError('UNREADABLE', MESSAGES.UNREADABLE, { cause: error })
  }
  let schemaVersion: number
  let counts: RecordCounts
  try {
    ;({ schemaVersion, counts } = verifyDatabaseFile(stagingFile, {
      maxSchemaVersion: ctx.migrations.length
    }))
  } catch (error) {
    const code = FILE_PROBLEMS[(error as DatabaseFileError).code]
    throw new RestoreError(code, MESSAGES[code], { cause: error })
  }
  // A backup whose recorded schema history does not match would be refused at the next start.
  const mismatches = checksumMismatchesOf(stagingFile, ctx.migrations)
  if (mismatches.length > 0) {
    throw new RestoreError('SCHEMA_CHECKSUM_MISMATCH', MESSAGES.SCHEMA_CHECKSUM_MISMATCH, {
      cause: new SchemaChecksumMismatchError(mismatches)
    })
  }
  const fileName = win32.basename(candidateFile)
  const sidecar = readSidecar(candidateFile)
  const named = parseBackupFileName(fileName)
  return {
    fileName,
    schemaVersion,
    appVersion: sidecar?.appVersion ?? named?.appVersion ?? null,
    backupCreatedAt:
      sidecar?.backupCreatedAt ?? named?.time.toISOString() ?? modified.toISOString(),
    sizeBytes: size,
    counts,
    needsMigration: schemaVersion < ctx.migrations.length
  }
}

/** The applied migrations of a verified candidate copy whose checksum differs from this app's. Read-only. */
function checksumMismatchesOf(file: string, migrations: readonly Migration[]): ChecksumMismatch[] {
  let db: Db | undefined
  try {
    db = openSqlite(file, { readonly: true })
    return appliedChecksumMismatches(db, migrations)
  } catch (error) {
    throw new RestoreError('UNREADABLE', MESSAGES.UNREADABLE, { cause: error })
  } finally {
    db?.close()
  }
}

/**
 * The current database when the caller has no open connection; a missing file is not created. SQLite may change or
 * delete the files of a database it cannot use (a WAL it cannot read is deleted when the connection closes), so the
 * files are checked through a private copy first: the originals are only read until they are preserved, or found
 * healthy and opened normally.
 */
function openCurrentDatabase(ctx: DataSafetyContext): CurrentDatabase {
  const { databaseFile } = ctx.paths
  if (!existsSync(databaseFile)) return { problem: 'MISSING', db: null, openedHere: true }
  const { check } = restoreFilesOf(databaseFile)
  let copy: CurrentDatabase
  try {
    copyDatabaseFiles(databaseFile, check)
    copy = openAndAssess(check, ctx)
  } catch (error) {
    ctx.log.warn('[restore] the current database could not be copied for its checks', {
      code: errorCodeOf(error)
    })
    copy = { problem: 'UNVERIFIABLE', db: null, openedHere: true }
  }
  copy.db?.close()
  removeLeftover(check, ctx.log)
  if (copy.problem !== null) return { problem: copy.problem, db: null, openedHere: true }
  return openAndAssess(databaseFile, ctx)
}

/** Opens `file` as StockFlow does and checks it. A file it cannot open gives CANNOT_OPEN and no connection. */
function openAndAssess(file: string, ctx: DataSafetyContext): CurrentDatabase {
  let db: Db
  try {
    db = openDatabase(file)
  } catch (error) {
    ctx.log.warn('[restore] the current database cannot be opened', { code: errorCodeOf(error) })
    return { problem: 'CANNOT_OPEN', db: null, openedHere: true }
  }
  return assess(db, true)
}

/** Copies a database file and whichever of its -wal, -shm and -journal exist to `target`, replacing an old copy. */
function copyDatabaseFiles(databaseFile: string, target: string): void {
  removeDatabaseFiles(target)
  for (const suffix of DATABASE_SUFFIXES) {
    if (existsSync(`${databaseFile}${suffix}`)) {
      copyFileSync(`${databaseFile}${suffix}`, `${target}${suffix}`)
    }
  }
}

function assess(db: Db, openedHere: boolean): CurrentDatabase {
  const problem = liveDatabaseProblem(db)
  return problem === null ? { problem, db, openedHere } : { problem, db, openedHere }
}

/** Null when `db` passes what a verified backup requires: a valid schema version, integrity_check, foreign_key_check. */
function liveDatabaseProblem(db: Db): LiveDatabaseProblem | null {
  try {
    if (readUserVersion(db) < 0) return 'INVALID_SCHEMA_VERSION'
    if (integrityProblems(db).length > 0) return 'INTEGRITY_CHECK_FAILED'
    if (foreignKeyViolations(db).length > 0) return 'FOREIGN_KEY_CHECK_FAILED'
    return null
  } catch {
    return 'UNVERIFIABLE'
  }
}

/**
 * Puts a preserved damaged database back in place. When every file had been moved, the database files in the data
 * folder are the restore's: they are removed first, and the marker records that before any file moves back, so an
 * interruption can never remove a file that was already put back. Returns true when anything was put back.
 */
function putBackPreserved(
  databaseFile: string,
  marker: DamagedMarker,
  pending: string,
  recoveryDir: string
): boolean {
  if (marker.preserved) {
    removeDatabaseFiles(databaseFile)
    writeMarker(pending, { ...marker, preserved: false })
  }
  return reinstateQuarantined(databaseFile, win32.join(recoveryDir, marker.quarantine))
}

function writeMarker(file: string, marker: DamagedMarker): void {
  writeFileSync(file, `${JSON.stringify(marker)}\n`)
}

/** The marker of a restore over a damaged database; null for any other marker (a healthy restore's, or unreadable). */
function readDamagedMarker(file: string): DamagedMarker | null {
  try {
    const parsed = DamagedMarkerSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Puts the set-aside database back (if it was set aside), reopens it and checks it. Throws on failure. */
function reinstatePrevious(databaseFile: string, setAside: boolean): Db {
  const { rollback, pending } = restoreFilesOf(databaseFile)
  if (setAside) {
    removeDatabaseFiles(databaseFile)
    renameSync(rollback, databaseFile)
  }
  const db = openHealthy(databaseFile)
  removeQuietly(pending)
  return db
}

/** Last resort: the verified pre-restore backup becomes the database again. Throws on failure. */
function reinstateFromBackup(databaseFile: string, backup: BackupInfo): Db {
  removeDatabaseFiles(databaseFile)
  copyFileSync(backup.file, databaseFile)
  const db = openHealthy(databaseFile)
  removeQuietly(restoreFilesOf(databaseFile).pending)
  return db
}

function openHealthy(databaseFile: string): Db {
  const db = openDatabase(databaseFile)
  try {
    assertHealthy(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** The final check of a restored database: StockFlow marker, this app's schema, integrity and foreign keys. */
function assertRestored(db: Db, ctx: DataSafetyContext): void {
  const applicationId = readApplicationId(db)
  if (applicationId !== STOCKFLOW_APPLICATION_ID) {
    throw new Error(`The restored database has application_id ${applicationId}, not StockFlow's.`)
  }
  const version = readUserVersion(db)
  if (version !== ctx.migrations.length) {
    throw new Error(
      `The restored database uses schema ${version}; this version of StockFlow uses schema ${ctx.migrations.length}.`
    )
  }
  assertHealthy(db)
}

function assertHealthy(db: Db): void {
  const problems = integrityProblems(db)
  if (problems.length > 0) {
    throw new Error(`PRAGMA integrity_check reported: ${problems.slice(0, 3).join('; ')}`)
  }
  const violations = foreignKeyViolations(db)
  if (violations.length > 0) {
    throw new Error(`PRAGMA foreign_key_check found ${violations.length} violation(s).`)
  }
}

/** The failed outcome of a restore, logged, with the staging copy removed. */
function failure(
  ctx: DataSafetyContext,
  stage: RestoreStage,
  error: RestoreError,
  db: Db | null,
  previousReinstated: boolean,
  path: RestorePath | null
): RestoreOutcome {
  removeLeftover(restoreFilesOf(ctx.paths.databaseFile).staging, ctx.log)
  ctx.log.error('[restore] the restore failed', error, {
    stage,
    code: error.code,
    reinstated: previousReinstated,
    path
  })
  return { ok: false, stage, error, db, previousReinstated, path }
}

function stageError(stage: RestoreStage, error: unknown): RestoreError {
  const code = STAGE_FAILURES[stage as keyof typeof STAGE_FAILURES]
  return new RestoreError(code, MESSAGES[code], { cause: error })
}

/** Removes a database file with its WAL, SHM and journal; the main file first. Throws if one cannot be removed. */
function removeDatabaseFiles(file: string): void {
  for (const suffix of DATABASE_SUFFIXES) rmSync(`${file}${suffix}`, { force: true })
}

function removeLeftover(file: string, log: Logger): void {
  try {
    removeDatabaseFiles(file)
  } catch {
    log.warn('[restore] a restore working file could not be removed', {
      file: win32.basename(file)
    })
  }
}

/** Removes `file` if it exists; returns the failure instead of throwing it. */
function removeQuietly(file: string): unknown {
  try {
    rmSync(file, { force: true })
    return undefined
  } catch (error) {
    return error
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
