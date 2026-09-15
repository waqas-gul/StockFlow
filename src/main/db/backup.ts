import {
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
import {
  BACKUP_CATEGORIES,
  backupFolder,
  isSameOrInside,
  type BackupCategory,
  type DataPaths
} from '../data-paths'
import { errorCodeOf, type Logger } from '../logging'
import type { Db } from './adapter'
import { formatBackupFileName, sidecarFileOf } from './backup-files'
import { readUserVersion } from './connection'
import type { DataSafetyContext } from './context'
import { DEFAULT_RETENTION, rotateBackups, type RetentionPolicy } from './rotation'
import { verifyDatabaseFile, type DatabaseFileReport, type RecordCounts } from './verify'

export type BackupErrorCode =
  | 'UNSAFE_DESTINATION'
  | 'DESTINATION_UNAVAILABLE'
  | 'COPY_FAILED'
  | 'VERIFICATION_FAILED'
  | 'FINALIZE_FAILED'

/** A backup that was not made. Nothing was left behind, and existing backups were not touched. */
export class BackupError extends Error {
  readonly code: BackupErrorCode

  constructor(code: BackupErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BackupError'
    this.code = code
  }
}

/** A verified backup. Main-process only: `file` is an absolute path and never goes to the renderer. */
export interface BackupInfo {
  readonly file: string
  readonly fileName: string
  /** When the backup was made, ISO-8601 UTC. */
  readonly createdAt: string
  readonly appVersion: string
  readonly schemaVersion: number
  readonly sqliteVersion: string
  readonly applicationId: number
  readonly sizeBytes: number
  readonly counts: RecordCounts
  /** False when the optional sidecar could not be written. The backup is valid either way. */
  readonly sidecarWritten: boolean
}

/** The `format` of a StockFlow backup sidecar. */
export const SIDECAR_FORMAT = 'stockflow-backup-sidecar'

const MAX_SEQUENCE = 99
const MAX_SIDECAR_BYTES = 64 * 1024

/**
 * Backs up `db` into `directory` with SQLite's online backup, never by copying the open file:
 *
 * 1. the copy is written to `<name>.db.tmp`;
 * 2. it is verified: made self-contained, then StockFlow application_id, schema version, integrity_check and
 *    foreign_key_check (verify.ts);
 * 3. only then is it renamed to `<name>.db`, a name no file has (an existing file is never replaced);
 * 4. an optional JSON sidecar with a safe summary is written next to it.
 *
 * On any failure the temporary file is removed, existing backups are left untouched, the failure is logged and a
 * BackupError is thrown. `directory` is chosen by the main process, never by the renderer, and is never the data
 * folder of the live database.
 */
export async function createVerifiedBackup(
  db: Db,
  directory: string,
  ctx: DataSafetyContext
): Promise<BackupInfo> {
  const started = Date.now()
  let tempFile: string | undefined
  try {
    if (isSameOrInside(directory, ctx.paths.dataDir)) {
      throw new BackupError('UNSAFE_DESTINATION', 'A backup is never written into the data folder.')
    }
    try {
      mkdirSync(directory, { recursive: true })
    } catch (error) {
      throw new BackupError('DESTINATION_UNAVAILABLE', 'The backup folder could not be created.', {
        cause: error
      })
    }
    const time = ctx.now()
    const file = freeBackupFile(directory, time, ctx.appVersion, readUserVersion(db))
    tempFile = `${file}.tmp`
    try {
      await db.backup(tempFile)
    } catch (error) {
      throw new BackupError('COPY_FAILED', 'SQLite could not write the backup copy.', {
        cause: error
      })
    }
    ctx.faults?.afterBackupCopy?.(tempFile)
    let report: DatabaseFileReport
    try {
      report = verifyDatabaseFile(tempFile)
    } catch (error) {
      throw new BackupError(
        'VERIFICATION_FAILED',
        `The backup copy failed verification: ${messageOf(error)}`,
        { cause: error }
      )
    }
    try {
      ctx.faults?.beforeBackupFinalize?.(tempFile, file)
      // A file that took the name meanwhile is never replaced: the backup fails instead.
      if (existsSync(file)) throw new Error(`${win32.basename(file)} already exists.`)
      renameSync(tempFile, file)
    } catch (error) {
      throw new BackupError(
        'FINALIZE_FAILED',
        'The verified backup could not be given its final name.',
        { cause: error }
      )
    }
    tempFile = undefined

    const summary: Omit<BackupInfo, 'sidecarWritten'> = {
      file,
      fileName: win32.basename(file),
      createdAt: time.toISOString(),
      appVersion: ctx.appVersion,
      schemaVersion: report.schemaVersion,
      sqliteVersion: report.sqliteVersion,
      applicationId: report.applicationId,
      sizeBytes: statSync(file).size,
      counts: report.counts
    }
    const sidecarWritten = writeSidecar(summary, ctx.log)
    ctx.log.info('[backup] verified backup created', {
      file: summary.fileName,
      schema: summary.schemaVersion,
      bytes: summary.sizeBytes,
      ms: Date.now() - started,
      sidecar: sidecarWritten
    })
    return { ...summary, sidecarWritten }
  } catch (error) {
    if (tempFile !== undefined) removeTemporaryFiles(tempFile, ctx.log)
    const failure =
      error instanceof BackupError
        ? error
        : new BackupError('COPY_FAILED', `The backup failed: ${messageOf(error)}`, { cause: error })
    ctx.log.error('[backup] the backup failed; existing backups were not touched', failure, {
      code: failure.code
    })
    throw failure
  }
}

/**
 * A verified backup in `<root>\backups\<category>`, then that folder's rotation. Rotation runs only after the new
 * backup is verified, never deletes it, and cannot make it fail.
 */
export async function createCategoryBackup(
  db: Db,
  category: BackupCategory,
  ctx: DataSafetyContext,
  policy: RetentionPolicy = DEFAULT_RETENTION[category]
): Promise<BackupInfo> {
  const directory = backupFolder(ctx.paths, category)
  const backup = await createVerifiedBackup(db, directory, ctx)
  rotateBackups(directory, policy, { protect: backup.fileName, log: ctx.log })
  return backup
}

/** Creates `<root>\backups\auto`, `pre-migration` and `pre-restore`. */
export function ensureBackupFolders(paths: DataPaths): void {
  for (const category of BACKUP_CATEGORIES) {
    mkdirSync(backupFolder(paths, category), { recursive: true })
  }
}

/** What a restore screen may show from a backup's sidecar. */
export interface SidecarSummary {
  readonly appVersion: string
  readonly backupCreatedAt: string
}

const SidecarSummarySchema = z.object({
  format: z.literal(SIDECAR_FORMAT),
  appVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/),
  backupCreatedAt: z.iso.datetime()
})

/**
 * The app version and creation time from the sidecar next to `backupFile`, or null when it is missing or not
 * valid. A sidecar is only a convenience: the .db file itself is authoritative.
 */
export function readSidecar(backupFile: string): SidecarSummary | null {
  const file = sidecarFileOf(backupFile)
  try {
    if (statSync(file).size > MAX_SIDECAR_BYTES) return null
    const parsed = SidecarSummarySchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (!parsed.success) return null
    return { appVersion: parsed.data.appVersion, backupCreatedAt: parsed.data.backupCreatedAt }
  } catch {
    return null
  }
}

/** The first name for this time that neither a backup nor a backup in progress has. */
function freeBackupFile(
  directory: string,
  time: Date,
  appVersion: string,
  schemaVersion: number
): string {
  for (let sequence = 1; sequence <= MAX_SEQUENCE; sequence++) {
    const file = win32.join(
      directory,
      formatBackupFileName(time, appVersion, schemaVersion, sequence)
    )
    if (!existsSync(file) && !existsSync(`${file}.tmp`)) return file
  }
  throw new BackupError(
    'DESTINATION_UNAVAILABLE',
    'Too many backups were started in the same second.'
  )
}

/** Safe summary metadata only: no names, amounts or other business data. */
function writeSidecar(backup: Omit<BackupInfo, 'sidecarWritten'>, log: Logger): boolean {
  const file = sidecarFileOf(backup.file)
  const tempFile = `${file}.tmp`
  const sidecar = {
    format: SIDECAR_FORMAT,
    formatVersion: 1,
    backupFile: backup.fileName,
    backupCreatedAt: backup.createdAt,
    appVersion: backup.appVersion,
    schemaVersion: backup.schemaVersion,
    sqliteVersion: backup.sqliteVersion,
    applicationId: backup.applicationId,
    sizeBytes: backup.sizeBytes,
    counts: backup.counts
  }
  try {
    writeFileSync(tempFile, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8')
    renameSync(tempFile, file)
    return true
  } catch (error) {
    removeQuietly(tempFile)
    log.warn('[backup] the sidecar could not be written; the backup itself is valid', {
      file: backup.fileName,
      code: errorCodeOf(error)
    })
    return false
  }
}

function removeTemporaryFiles(tempFile: string, log: Logger): void {
  for (const file of [tempFile, `${tempFile}-journal`, `${tempFile}-wal`, `${tempFile}-shm`]) {
    const error = removeQuietly(file)
    if (error !== undefined) {
      log.warn('[backup] a temporary backup file could not be removed', {
        file: win32.basename(file),
        code: errorCodeOf(error)
      })
    }
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
