import { readdirSync, rmSync } from 'node:fs'
import { win32 } from 'node:path'
import type { BackupCategory } from '../data-paths'
import { errorCodeOf, type Logger } from '../logging'
import { parseBackupFileName, sidecarFileOf, type BackupName } from './backup-files'

/** Keep the `keepLast` newest backups (pre-migration and pre-restore). */
export interface KeepLastPolicy {
  readonly keepLast: number
}

/**
 * Automatic backups: keep the newest backup of each of the `keepDaily` most recent days that have backups, and the
 * first (oldest) backup of each of the `keepMonthly` most recent months that have backups. Days and months are
 * counted among those with backups, not on the calendar, so a long break never deletes every backup.
 */
export interface CalendarPolicy {
  readonly keepDaily: number
  readonly keepMonthly: number
}

export type RetentionPolicy = KeepLastPolicy | CalendarPolicy

/** The approved policy: 14 daily + 12 monthly automatic backups; the last 5 pre-migration and pre-restore ones. */
export const DEFAULT_RETENTION: Readonly<Record<BackupCategory, RetentionPolicy>> = Object.freeze({
  auto: Object.freeze({ keepDaily: 14, keepMonthly: 12 }),
  'pre-migration': Object.freeze({ keepLast: 5 }),
  'pre-restore': Object.freeze({ keepLast: 5 })
})

/**
 * The backups that `policy` deletes from a folder listing. Pure. Only StockFlow backup names are ever selected
 * (never a temporary file, a sidecar or an unrelated file), and never `protect`: the backup just created.
 */
export function selectBackupsToDelete(
  fileNames: readonly string[],
  policy: RetentionPolicy,
  protect?: string
): string[] {
  assertValidPolicy(policy)
  const newestFirst = fileNames
    .map(parseBackupFileName)
    .filter((backup): backup is BackupName => backup !== null)
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
  const keep = new Set<string>(protect === undefined ? [] : [protect])
  if ('keepLast' in policy) {
    for (const backup of newestFirst.slice(0, policy.keepLast)) keep.add(backup.fileName)
  } else {
    const newestOfDay = new Map<string, BackupName>()
    for (const backup of newestFirst) {
      if (!newestOfDay.has(backup.dayKey)) newestOfDay.set(backup.dayKey, backup)
    }
    const firstOfMonth = new Map<string, BackupName>()
    for (const backup of [...newestFirst].reverse()) {
      if (!firstOfMonth.has(backup.monthKey)) firstOfMonth.set(backup.monthKey, backup)
    }
    const kept = [
      ...[...newestOfDay.values()].slice(0, policy.keepDaily),
      ...[...firstOfMonth.values()].reverse().slice(0, policy.keepMonthly)
    ]
    for (const backup of kept) keep.add(backup.fileName)
  }
  return newestFirst.filter((backup) => !keep.has(backup.fileName)).map((backup) => backup.fileName)
}

export interface RotationResult {
  readonly deleted: readonly string[]
  /** Backups that could not be deleted; they are kept and logged. */
  readonly failed: readonly string[]
}

export interface RotateOptions {
  readonly log: Logger
  /** The backup just created and verified: never deleted. */
  readonly protect?: string
}

/**
 * Deletes the backups `policy` selects in `directory`, each with its sidecar. Call it only after a new backup was
 * created and verified. It never throws: a failure is logged and the remaining backups are kept.
 */
export function rotateBackups(
  directory: string,
  policy: RetentionPolicy,
  options: RotateOptions
): RotationResult {
  const { log } = options
  const folder = win32.basename(directory)
  const deleted: string[] = []
  const failed: string[] = []
  try {
    const files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
    for (const fileName of selectBackupsToDelete(files, policy, options.protect)) {
      const file = win32.join(directory, fileName)
      try {
        rmSync(file)
      } catch (error) {
        failed.push(fileName)
        log.warn('[backup] an old backup could not be deleted; it is kept', {
          file: fileName,
          code: errorCodeOf(error)
        })
        continue
      }
      deleted.push(fileName)
      try {
        rmSync(sidecarFileOf(file), { force: true })
      } catch (error) {
        log.warn('[backup] the sidecar of a deleted backup could not be deleted', {
          file: fileName,
          code: errorCodeOf(error)
        })
      }
    }
  } catch (error) {
    log.error('[backup] backup rotation stopped', error, { folder })
  }
  if (deleted.length > 0 || failed.length > 0) {
    log.info('[backup] old backups rotated', {
      folder,
      deleted: deleted.length,
      failed: failed.length
    })
  }
  return { deleted, failed }
}

function assertValidPolicy(policy: RetentionPolicy): void {
  const valid =
    'keepLast' in policy
      ? Number.isInteger(policy.keepLast) && policy.keepLast >= 1
      : Number.isInteger(policy.keepDaily) &&
        policy.keepDaily >= 1 &&
        Number.isInteger(policy.keepMonthly) &&
        policy.keepMonthly >= 0
  if (!valid) throw new RangeError(`Invalid backup retention policy: ${JSON.stringify(policy)}.`)
}
