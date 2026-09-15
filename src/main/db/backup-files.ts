import { win32 } from 'node:path'

/** Every StockFlow backup file name starts with this. Business or customer names never appear in it. */
export const BACKUP_FILE_PREFIX = 'stockflow-backup_'

/** The parts of a backup file name, e.g. `stockflow-backup_2026-09-14_153045_v1.0.0_s1.db`. */
export interface BackupName {
  readonly fileName: string
  /** The local date and time in the name. */
  readonly time: Date
  readonly appVersion: string
  readonly schemaVersion: number
  /** 1 for the first backup made in that second, then 2, 3, … (written as a `_2` suffix). */
  readonly sequence: number
  /** `YYYY-MM-DD`, local. */
  readonly dayKey: string
  /** `YYYY-MM`, local. */
  readonly monthKey: string
  /** Sorts backups from oldest to newest as text. */
  readonly sortKey: string
}

const NAME =
  /^stockflow-backup_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})_v([0-9A-Za-z.-]{1,40})_s(\d{1,9})(?:_(\d{1,3}))?\.db$/

/**
 * The file name of a backup made at local time `time`: local date and time, app version and schema version. Only
 * letters, digits, `.`, `-` and `_` are used, so the name is valid on Windows.
 */
export function formatBackupFileName(
  time: Date,
  appVersion: string,
  schemaVersion: number,
  sequence = 1
): string {
  const date = `${pad(time.getFullYear(), 4)}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`
  const clock = `${pad(time.getHours())}${pad(time.getMinutes())}${pad(time.getSeconds())}`
  const version = appVersion.replace(/[^0-9A-Za-z.-]/g, '-').slice(0, 40) || 'unknown'
  const suffix = sequence > 1 ? `_${sequence}` : ''
  return `${BACKUP_FILE_PREFIX}${date}_${clock}_v${version}_s${schemaVersion}${suffix}.db`
}

/**
 * The parts of a StockFlow backup file name, or null for any other file name. A name is accepted only if
 * formatBackupFileName would write it exactly, so impossible dates and times are refused.
 */
export function parseBackupFileName(fileName: string): BackupName | null {
  const match = NAME.exec(fileName)
  if (match === null) return null
  const [, year, month, day, hour, minute, second, appVersion, schema, suffix] = match
  const time = new Date(+year, +month - 1, +day, +hour, +minute, +second)
  const sequence = suffix === undefined ? 1 : Number(suffix)
  if (formatBackupFileName(time, appVersion, Number(schema), sequence) !== fileName) return null
  return {
    fileName,
    time,
    appVersion,
    schemaVersion: Number(schema),
    sequence,
    dayKey: `${year}-${month}-${day}`,
    monthKey: `${year}-${month}`,
    sortKey: `${year}${month}${day}${hour}${minute}${second}${pad(sequence, 3)}`
  }
}

/** The JSON sidecar next to a backup: the same name with `.json` instead of its extension. */
export function sidecarFileOf(backupFile: string): string {
  const extension = win32.extname(backupFile)
  return `${backupFile.slice(0, backupFile.length - extension.length)}.json`
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}
