import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { win32 } from 'node:path'
import { BACKUP_CATEGORIES, backupFolder } from '../data-paths'
import { errorCodeOf } from '../logging'
import { parseBackupFileName } from './backup-files'
import type { DataSafetyContext } from './context'

/*
 * A backup is written as `<name>.db.tmp` and renamed only once verified (backup.ts); its sidecar is written as
 * `<name>.json.tmp`. If Windows ends StockFlow in the middle (for example during the shutdown backup while Windows
 * itself shuts down), those temporary files stay behind. They are never listed, rotated or restored as backups, and
 * this startup cleanup removes them.
 */

/** A temporary backup file younger than this is kept: it may still belong to a backup that is running. */
export const STALE_BACKUP_TEMP_AGE_MS = 60 * 60 * 1000

const DATABASE_TEMP = /^(.+\.db)\.tmp(?:-journal|-wal|-shm)?$/
const SIDECAR_TEMP = /^(.+)\.json\.tmp$/

/**
 * True for a temporary file of a StockFlow-named backup: `<backup>.db.tmp` with its -journal, -wal or -shm, or the
 * sidecar's `<backup>.json.tmp`, where `<backup>.db` is a name StockFlow generates (parseBackupFileName). Any other
 * name, including a finished backup or a manual backup's chosen name, is not StockFlow's temporary file.
 */
export function isOwnedBackupTempFile(fileName: string): boolean {
  const database = DATABASE_TEMP.exec(fileName)
  if (database !== null) return parseBackupFileName(database[1]) !== null
  const sidecar = SIDECAR_TEMP.exec(fileName)
  return sidecar !== null && parseBackupFileName(`${sidecar[1]}.db`) !== null
}

/**
 * Run at startup, before the database is opened, so no backup of this StockFlow is running (and the single-instance
 * lock excludes another one). Removes StockFlow's own temporary backup files (isOwnedBackupTempFile) older than
 * STALE_BACKUP_TEMP_AGE_MS, only directly inside `<root>\backups\auto`, `pre-migration` and `pre-restore`: never in
 * a subfolder, the recovery folder, the data folder or a folder the user chose for a manual backup. A file dated in
 * the future is kept. Never throws; returns the removed files as `<category>\<name>`.
 */
export function removeStaleBackupTempFiles(
  ctx: Pick<DataSafetyContext, 'paths' | 'log' | 'now'>
): string[] {
  const now = ctx.now().getTime()
  const removed: string[] = []
  for (const category of BACKUP_CATEGORIES) {
    const directory = backupFolder(ctx.paths, category)
    for (const name of namesIn(directory)) {
      if (!isOwnedBackupTempFile(name)) continue
      const file = win32.join(directory, name)
      const label = `${category}\\${name}`
      try {
        const stats = lstatSync(file)
        const age = now - stats.mtimeMs
        if (!stats.isFile() || age < STALE_BACKUP_TEMP_AGE_MS) continue
        rmSync(file)
        removed.push(label)
      } catch (error) {
        ctx.log.warn(
          '[backup] a temporary file left by an interrupted backup could not be removed',
          { file: label, code: errorCodeOf(error) }
        )
      }
    }
  }
  if (removed.length > 0) {
    ctx.log.info('[backup] removed temporary files left by an interrupted backup', {
      count: removed.length,
      files: removed.join(', ')
    })
  }
  return removed
}

function namesIn(directory: string): string[] {
  try {
    return readdirSync(directory).sort()
  } catch {
    return []
  }
}
