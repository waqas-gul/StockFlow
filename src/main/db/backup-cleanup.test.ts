import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupFolder, type BackupCategory } from '../data-paths'
import { openSqlite } from './adapter'
import {
  STALE_BACKUP_TEMP_AGE_MS,
  isOwnedBackupTempFile,
  removeStaleBackupTempFiles
} from './backup-cleanup'
import { createTempDir, holdOpen, testContext, type TempDir, type TestContext } from './test-utils'

const NOW = new Date(2026, 8, 16, 10, 0, 0)
const BACKUP = 'stockflow-backup_2026-09-15_223010_v1.0.0_s1.db'
const OLD = new Date(NOW.getTime() - STALE_BACKUP_TEMP_AGE_MS - 60_000)
const RECENT = new Date(NOW.getTime() - 5 * 60_000)

let temp: TempDir
let ctx: TestContext

beforeEach(() => {
  temp = createTempDir()
  ctx = testContext(temp, { now: () => NOW })
})

afterEach(() => {
  temp.remove()
})

function folder(category: BackupCategory = 'auto'): string {
  return backupFolder(ctx.paths, category)
}

/** Writes a file into `directory` with the given modification time. */
function place(directory: string, name: string, modified: Date = OLD): string {
  mkdirSync(directory, { recursive: true })
  const file = win32.join(directory, name)
  writeFileSync(file, 'partial backup bytes')
  utimesSync(file, modified, modified)
  return file
}

function listing(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).sort() : []
}

describe('isOwnedBackupTempFile', () => {
  it('recognizes the temporary files of a StockFlow backup and of its sidecar', () => {
    for (const name of [
      `${BACKUP}.tmp`,
      `${BACKUP}.tmp-journal`,
      `${BACKUP}.tmp-wal`,
      `${BACKUP}.tmp-shm`,
      'stockflow-backup_2026-09-15_223010_v1.0.0_s1.json.tmp',
      'stockflow-backup_2026-09-15_223010_v1.0.0_s1_2.db.tmp'
    ]) {
      expect(isOwnedBackupTempFile(name), name).toBe(true)
    }
  })

  it('refuses every other name, including finished backups, sidecars and look-alikes', () => {
    for (const name of [
      BACKUP,
      'stockflow-backup_2026-09-15_223010_v1.0.0_s1.json',
      'stockflow-backup_2026-02-30_223010_v1.0.0_s1.db.tmp',
      'stockflow-backup_garbage.db.tmp',
      `${BACKUP}.TMP`,
      `${BACKUP}.tmp.db`,
      `${BACKUP}.tmp-other`,
      `copy of ${BACKUP}.tmp`,
      'my-shop.db.tmp',
      'backup-status.json.tmp',
      'damaged-live-db_2026-09-15_223010.db',
      'shop.db.restore-staging',
      'notes.tmp',
      `..\\${BACKUP}.tmp`,
      `sub\\${BACKUP}.tmp`
    ]) {
      expect(isOwnedBackupTempFile(name), name).toBe(false)
    }
  })
})

describe('removeStaleBackupTempFiles', () => {
  it('removes old temporary backup files from every StockFlow backup folder and logs their names', () => {
    place(folder('auto'), `${BACKUP}.tmp`)
    place(folder('auto'), `${BACKUP}.tmp-journal`)
    place(folder('pre-migration'), `${BACKUP}.tmp-wal`)
    place(folder('pre-migration'), `${BACKUP}.tmp-shm`)
    place(folder('pre-restore'), 'stockflow-backup_2026-09-15_223010_v1.0.0_s1.json.tmp')

    const removed = removeStaleBackupTempFiles(ctx)

    expect(removed).toEqual([
      `auto\\${BACKUP}.tmp`,
      `auto\\${BACKUP}.tmp-journal`,
      `pre-migration\\${BACKUP}.tmp-shm`,
      `pre-migration\\${BACKUP}.tmp-wal`,
      'pre-restore\\stockflow-backup_2026-09-15_223010_v1.0.0_s1.json.tmp'
    ])
    for (const category of ['auto', 'pre-migration', 'pre-restore'] as const) {
      expect(listing(folder(category))).toEqual([])
    }
    expect(ctx.log.entries).toEqual([
      {
        level: 'INFO',
        message: '[backup] removed temporary files left by an interrupted backup',
        context: { count: 5, files: removed.join(', ') }
      }
    ])
  })

  it('keeps finished backups, sidecars and every file it does not own', () => {
    const kept = [
      BACKUP,
      'stockflow-backup_2026-09-15_223010_v1.0.0_s1.json',
      'my-shop.db.tmp',
      'stockflow-backup_garbage.db.tmp',
      'notes.tmp'
    ]
    for (const name of kept) place(folder('auto'), name)

    expect(removeStaleBackupTempFiles(ctx)).toEqual([])
    expect(listing(folder('auto'))).toEqual([...kept].sort())
    expect(ctx.log.entries).toEqual([])
  })

  it('keeps a temporary file that is recent, or dated in the future, as it may belong to a running backup', () => {
    place(folder('auto'), `${BACKUP}.tmp`, RECENT)
    place(folder('auto'), `${BACKUP}.tmp-journal`, new Date(NOW.getTime() + 24 * 3600_000))
    const justUnder = new Date(NOW.getTime() - STALE_BACKUP_TEMP_AGE_MS + 1_000)
    place(folder('pre-restore'), `${BACKUP}.tmp`, justUnder)

    expect(removeStaleBackupTempFiles(ctx)).toEqual([])
    expect(listing(folder('auto'))).toEqual([`${BACKUP}.tmp`, `${BACKUP}.tmp-journal`])
    expect(listing(folder('pre-restore'))).toEqual([`${BACKUP}.tmp`])
  })

  it('never looks outside the three backup folders: recovery, data, backups root, subfolders and user folders', () => {
    const elsewhere = [
      place(ctx.paths.recoveryDir, `${BACKUP}.tmp`),
      place(ctx.paths.recoveryDir, 'damaged-live-db_2026-09-15_223010.db'),
      place(ctx.paths.dataDir, `${BACKUP}.tmp`),
      place(ctx.paths.backupsDir, `${BACKUP}.tmp`),
      place(ctx.paths.root, `${BACKUP}.tmp`),
      place(win32.join(folder('auto'), 'nested'), `${BACKUP}.tmp`),
      place(temp.file('USB'), `${BACKUP}.tmp`)
    ]

    expect(removeStaleBackupTempFiles(ctx)).toEqual([])
    for (const file of elsewhere) expect(existsSync(file), file).toBe(true)
  })

  it('keeps a folder that has a temporary file name', () => {
    const directory = win32.join(folder('auto'), `${BACKUP}.tmp`)
    mkdirSync(directory, { recursive: true })
    utimesSync(directory, OLD, OLD)

    expect(removeStaleBackupTempFiles(ctx)).toEqual([])
    expect(existsSync(directory)).toBe(true)
  })

  it('does nothing when the backup folders do not exist yet', () => {
    expect(removeStaleBackupTempFiles(ctx)).toEqual([])
    expect(ctx.log.entries).toEqual([])
  })

  it('logs a file it cannot remove and still removes the others', () => {
    const busy = win32.join(folder('auto'), `${BACKUP}.tmp`)
    mkdirSync(folder('auto'), { recursive: true })
    openSqlite(busy).close()
    utimesSync(busy, OLD, OLD)
    holdOpen(temp, busy)
    place(folder('pre-migration'), `${BACKUP}.tmp`)

    expect(removeStaleBackupTempFiles(ctx)).toEqual([`pre-migration\\${BACKUP}.tmp`])
    expect(existsSync(busy)).toBe(true)
    expect(ctx.log.entries).toContainEqual({
      level: 'WARN',
      message: '[backup] a temporary file left by an interrupted backup could not be removed',
      context: { file: `auto\\${BACKUP}.tmp`, code: 'EBUSY' }
    })
  })
})
