import { existsSync, renameSync } from 'node:fs'
import { win32 } from 'node:path'

/*
 * Preserving a damaged database (a recovery artifact). A database that fails verification cannot have a verified
 * backup, and SQLite's online backup is never run on it. Instead a restore moves its files into <root>\recovery
 * under one name, so that they stay a set SQLite can open together:
 *
 *   damaged-live-db_2026-09-14_153045.db   (+ .db-wal, .db-shm and .db-journal, when they existed)
 *
 * The files are renamed, never copied or rewritten, so they are kept exactly as they were for a specialist. They are
 * never called verified backups, never listed or rotated as backups, and never deleted by StockFlow.
 */

export const RECOVERY_FILE_PREFIX = 'damaged-live-db_'

/** The files SQLite keeps next to a database: its write-ahead log, the WAL index and the rollback journal. */
export const COMPANION_SUFFIXES = Object.freeze(['-wal', '-shm', '-journal'] as const)

const NAME = /^damaged-live-db_\d{4}-\d{2}-\d{2}_\d{6}(?:_\d{1,2})?\.db$/
const MAX_SEQUENCE = 99

/** `damaged-live-db_<YYYY-MM-DD>_<HHMMSS>[_<n>].db`, in local time like the backup names, but never a backup name. */
export function formatRecoveryFileName(time: Date, sequence = 1): string {
  const date = `${pad(time.getFullYear(), 4)}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`
  const clock = `${pad(time.getHours())}${pad(time.getMinutes())}${pad(time.getSeconds())}`
  return `${RECOVERY_FILE_PREFIX}${date}_${clock}${sequence > 1 ? `_${sequence}` : ''}.db`
}

/** True for a plain file name (no folder part) of the kind formatRecoveryFileName writes. */
export function isRecoveryFileName(fileName: string): boolean {
  return NAME.test(fileName)
}

/** The first recovery file for `time` in `directory` such that neither it nor any of its companions exists. */
export function freeRecoveryFile(directory: string, time: Date): string {
  for (let sequence = 1; sequence <= MAX_SEQUENCE; sequence++) {
    const file = win32.join(directory, formatRecoveryFileName(time, sequence))
    if (['', ...COMPANION_SUFFIXES].every((suffix) => !existsSync(`${file}${suffix}`))) return file
  }
  throw new Error('Too many damaged databases were preserved in the same second.')
}

/**
 * Moves `databaseFile` and its companions to `target` (with the same suffixes): the companions first and the
 * database file last. Returns the new paths of the files moved (none when none existed). Never replaces a file.
 * Throws at the first failure; whatever was moved stays moved, and reinstateQuarantined puts it back.
 */
export function quarantineDatabaseFiles(databaseFile: string, target: string): string[] {
  const moved: string[] = []
  for (const suffix of [...COMPANION_SUFFIXES, '']) {
    if (!existsSync(`${databaseFile}${suffix}`)) continue
    moveWithoutReplacing(`${databaseFile}${suffix}`, `${target}${suffix}`)
    moved.push(`${target}${suffix}`)
  }
  return moved
}

/**
 * Moves every preserved file at `target` (with its suffix) back to `databaseFile`. It removes nothing and never
 * replaces a file: whatever a restore installed must be removed first. Returns true when anything was moved back.
 * Throws at the first failure; whatever was not moved back stays in the recovery folder.
 */
export function reinstateQuarantined(databaseFile: string, target: string): boolean {
  let reinstated = false
  for (const suffix of ['', ...COMPANION_SUFFIXES]) {
    if (!existsSync(`${target}${suffix}`)) continue
    moveWithoutReplacing(`${target}${suffix}`, `${databaseFile}${suffix}`)
    reinstated = true
  }
  return reinstated
}

/** Renames `from` to `to`, refusing when `to` exists (Windows would otherwise replace it). */
function moveWithoutReplacing(from: string, to: string): void {
  if (existsSync(to)) throw new Error(`${win32.basename(to)} already exists.`)
  renameSync(from, to)
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}
