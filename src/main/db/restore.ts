import { copyFileSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { isSameOrInside } from '../data-paths'
import type { Logger } from '../logging'
import type { Db } from './adapter'
import { createCategoryBackup, readSidecar, type BackupInfo } from './backup'
import { parseBackupFileName } from './backup-files'
import { openDatabase } from './connection'
import type { DataSafetyContext } from './context'
import type { MigrationResult } from './migrate'
import { upgradeSchema } from './schema-upgrade'
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
 * dialog, shows the summary, asks for confirmation, then calls restoreDatabase and relaunches the app.
 *
 * The user is never left without a database. From the moment the current database is set aside until the restored
 * one has passed its final checks, a marker file (shop.db.restore-pending) says that a restore is in progress, and
 * the previous database is kept whole (shop.db.restore-rollback). Any failure puts it back; if even that fails, the
 * next start does (recoverInterruptedRestore). A verified pre-restore backup is always made first as well.
 */

export type RestoreErrorCode =
  | 'CANDIDATE_NOT_FOUND'
  | 'CANDIDATE_IS_LIVE_DATA'
  | 'NOT_A_DATABASE'
  | 'NOT_STOCKFLOW'
  | 'DAMAGED'
  | 'SCHEMA_TOO_NEW'
  | 'UNREADABLE'
  | 'PRE_RESTORE_BACKUP_FAILED'
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
  | 'RELEASE'
  | 'REPLACE'
  | 'REOPEN'
  | 'MIGRATION'
  | 'VERIFICATION'
  | 'COMPLETION'

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

export type RestoreOutcome =
  | {
      readonly ok: true
      /** The restored database, open, migrated and verified. The caller relaunches the app with it. */
      readonly db: Db
      readonly summary: RestoreSummary
      readonly preRestoreBackup: BackupInfo
      readonly migration: MigrationResult
    }
  | {
      readonly ok: false
      readonly stage: RestoreStage
      readonly error: RestoreError
      /**
       * The database to continue with: the untouched live connection, or the previous database reopened. Null only
       * when it could not be put back now; it is then put back by the next start.
       */
      readonly db: Db | null
      /** True when the previous database had been set aside and was put back. */
      readonly previousReinstated: boolean
    }

export interface RestoreFiles {
  /** The validated copy of the candidate that is moved into place. */
  readonly staging: string
  /** The temporary copy validated for a confirmation screen. */
  readonly check: string
  /** The previous database, set aside during a restore. */
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
  UNREADABLE: 'This backup could not be read. Close any program that is using it and try again.',
  PRE_RESTORE_BACKUP_FAILED:
    'A safety backup of the current data could not be made, so nothing was restored.',
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
  RELEASE: 'DATABASE_IN_USE',
  REPLACE: 'REPLACE_FAILED',
  REOPEN: 'REOPEN_FAILED',
  MIGRATION: 'MIGRATION_FAILED',
  VERIFICATION: 'VERIFICATION_FAILED',
  COMPLETION: 'REPLACE_FAILED'
}

const DATABASE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const

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
 * Restores `candidateFile` in place of the live database `live`:
 *
 * 1. validate a private copy of the candidate (the file that will be installed);
 * 2. make a verified backup of the current database in `backups\pre-restore`;
 * 3. checkpoint the WAL into shop.db and make sure nothing else is reading it;
 * 4. mark the restore as pending, close the live connection, and set shop.db aside (stale WAL/SHM removed);
 * 5. move the validated copy into place and reopen it with the verified connection pragmas;
 * 6. migrate it if it is older (with its own verified pre-migration backup);
 * 7. run integrity_check and foreign_key_check; then clear the marker.
 *
 * On any failure after step 4 the previous database is put back and reopened. The caller must not use `live`
 * afterwards unless the outcome returns it. Relaunching the app is the caller's job (Phase 4B).
 */
export async function restoreDatabase(
  live: Db,
  candidateFile: string,
  ctx: DataSafetyContext
): Promise<RestoreOutcome> {
  const { databaseFile } = ctx.paths
  const files = restoreFilesOf(databaseFile)
  ctx.log.info('[restore] started', { file: win32.basename(candidateFile) })

  const failed = (
    stage: RestoreStage,
    error: RestoreError,
    db: Db | null,
    previousReinstated: boolean
  ): RestoreOutcome => {
    removeLeftover(files.staging, ctx.log)
    ctx.log.error('[restore] the restore failed', error, {
      stage,
      code: error.code,
      reinstated: previousReinstated
    })
    return { ok: false, stage, error, db, previousReinstated }
  }

  let summary: RestoreSummary
  try {
    summary = stageCandidate(candidateFile, files.staging, ctx)
  } catch (error) {
    return failed('VALIDATION', error as RestoreError, live, false)
  }

  let preRestoreBackup: BackupInfo
  try {
    preRestoreBackup = await createCategoryBackup(live, 'pre-restore', ctx)
  } catch (error) {
    const failure = new RestoreError(
      'PRE_RESTORE_BACKUP_FAILED',
      MESSAGES.PRE_RESTORE_BACKUP_FAILED,
      {
        cause: error
      }
    )
    return failed('PRE_RESTORE_BACKUP', failure, live, false)
  }

  try {
    // Waits up to the busy timeout for readers; a reader still holding a snapshot makes it report busy.
    const [checkpoint] = live.all<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')
    if (checkpoint.busy !== 0) throw new Error('Another connection is reading the database.')
  } catch (error) {
    const failure = new RestoreError('DATABASE_IN_USE', MESSAGES.DATABASE_IN_USE, { cause: error })
    return failed('RELEASE', failure, live, false)
  }
  try {
    const marker = {
      startedAt: ctx.now().toISOString(),
      preRestoreBackup: preRestoreBackup.fileName
    }
    writeFileSync(files.pending, `${JSON.stringify(marker)}\n`)
  } catch (error) {
    removeQuietly(files.pending)
    const failure = new RestoreError('REPLACE_FAILED', MESSAGES.REPLACE_FAILED, { cause: error })
    return failed('RELEASE', failure, live, false)
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
    assertHealthy(restored)

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
    return { ok: true, db: restored, summary, preRestoreBackup, migration }
  } catch (error) {
    const code = STAGE_FAILURES[stage as keyof typeof STAGE_FAILURES]
    const failure = new RestoreError(code, MESSAGES[code], { cause: error })
    restored?.close()
    try {
      return failed(stage, failure, reinstatePrevious(databaseFile, setAside), setAside)
    } catch (rollbackError) {
      ctx.log.error(
        '[restore] the previous database could not be put back from its set-aside copy',
        rollbackError
      )
    }
    try {
      return failed(stage, failure, reinstateFromBackup(databaseFile, preRestoreBackup), true)
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
      { cause: failure }
    )
    return failed(stage, fatal, null, false)
  }
}

export type RestoreRecovery = 'NONE' | 'REINSTATED' | 'CLEANED_UP'

/**
 * Run at startup, before the database is opened. When a restore was interrupted (the marker is still there), the
 * previous database is put back in place of whatever was installed. Leftovers of a completed restore are removed.
 * Throws when the previous database cannot be put back: opening an incomplete restore instead would be unsafe.
 */
export function recoverInterruptedRestore(databaseFile: string, log: Logger): RestoreRecovery {
  const files = restoreFilesOf(databaseFile)
  let cleaned = false
  for (const copy of [files.staging, files.check]) {
    if (DATABASE_SUFFIXES.some((suffix) => existsSync(`${copy}${suffix}`))) {
      removeDatabaseFiles(copy)
      cleaned = true
    }
  }
  if (existsSync(files.pending)) {
    if (existsSync(files.rollback)) {
      removeDatabaseFiles(databaseFile)
      renameSync(files.rollback, databaseFile)
      rmSync(files.pending)
      log.warn(
        '[restore] an interrupted restore was rolled back: the previous database is back in place'
      )
      return 'REINSTATED'
    }
    // Interrupted before the previous database was set aside: it is still in place.
    rmSync(files.pending)
    cleaned = true
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
