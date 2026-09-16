import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupFolder, resolveDataPaths, type DataPaths } from '../data-paths'
import { formatBackupFileName } from '../db/backup-files'
import {
  createMemoryLogger,
  createTempDir,
  replaceFolderWithFile,
  type MemoryLogger,
  type TempDir
} from '../db/test-utils'
import {
  BACKUP_STATUS_FILE_NAME,
  BackupStatusStore,
  backupFailureMessage,
  describeBackupStatus,
  listAutomaticBackups,
  type BackupStatusRecord
} from './backup-status'

const MANUAL = { at: '2026-09-14T10:00:00.000Z', fileName: 'shop copy.db', folder: 'E:\\Backups' }
const RESTORE = {
  at: '2026-09-14T11:00:00.000Z',
  fileName: 'stockflow-backup_2026-09-01_180000_v1.0.0_s1.db',
  restored: true,
  message: 'The backup was restored.'
}
const FAILURE = {
  at: '2026-09-14T12:00:00.000Z',
  trigger: 'SHUTDOWN',
  code: 'COPY_FAILED'
} as const
const EMPTY: BackupStatusRecord = {
  lastManual: null,
  lastAutomaticFailure: null,
  lastRestore: null
}

let temp: TempDir
let paths: DataPaths
let log: MemoryLogger

beforeEach(() => {
  temp = createTempDir()
  paths = resolveDataPaths(temp.file('StockFlow'))
  log = createMemoryLogger()
})

afterEach(() => {
  temp.remove()
})

function statusFile(): string {
  return win32.join(paths.backupsDir, BACKUP_STATUS_FILE_NAME)
}

function writeStatusFile(content: string): void {
  mkdirSync(paths.backupsDir, { recursive: true })
  writeFileSync(statusFile(), content)
}

/** A stand-in automatic backup: listing and status read file names only. */
function autoBackup(time: Date): string {
  mkdirSync(backupFolder(paths, 'auto'), { recursive: true })
  const name = formatBackupFileName(time, '1.0.0', 1)
  writeFileSync(win32.join(backupFolder(paths, 'auto'), name), 'backup')
  return name
}

describe('BackupStatusStore', () => {
  it('starts again, with a warning, when the status file cannot be read', () => {
    mkdirSync(statusFile(), { recursive: true })
    expect(new BackupStatusStore(paths, log).record).toEqual(EMPTY)
    expect(log.entries).toEqual([
      {
        level: 'WARN',
        message: '[backup] the backup status file could not be read; it starts again',
        context: { code: expect.any(String) }
      }
    ])
  })

  it('starts empty, without a warning, when there is no status file yet', () => {
    expect(new BackupStatusStore(paths, log).record).toEqual(EMPTY)
    expect(log.entries).toEqual([])
    expect(existsSync(statusFile())).toBe(false)
  })

  it('saves each change in backups\\backup-status.json, so the next start still knows it', () => {
    const store = new BackupStatusStore(paths, log)
    store.update({ lastManual: MANUAL })
    store.update({ lastAutomaticFailure: FAILURE, lastRestore: RESTORE })
    const expected = { lastManual: MANUAL, lastAutomaticFailure: FAILURE, lastRestore: RESTORE }
    expect(store.record).toEqual(expected)
    expect(new BackupStatusStore(paths, log).record).toEqual(expected)
    expect(JSON.parse(readFileSync(statusFile(), 'utf8'))).toEqual({
      format: 'stockflow-backup-status',
      formatVersion: 1,
      ...expected
    })
    expect(readdirSync(paths.backupsDir)).toEqual([BACKUP_STATUS_FILE_NAME])
    expect(log.entries).toEqual([])
  })

  it('shortens a long restore message so the file stays valid', () => {
    const store = new BackupStatusStore(paths, log)
    store.update({ lastRestore: { ...RESTORE, message: 'x'.repeat(600) } })
    expect(store.record.lastRestore?.message).toHaveLength(500)
    expect(new BackupStatusStore(paths, log).record.lastRestore?.message).toHaveLength(500)
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['another format', JSON.stringify({ format: 'other', formatVersion: 1 })],
    [
      'an invalid value',
      JSON.stringify({
        format: 'stockflow-backup-status',
        formatVersion: 1,
        lastManual: { ...MANUAL, at: 'yesterday' },
        lastAutomaticFailure: null,
        lastRestore: null
      })
    ],
    ['an oversized file', JSON.stringify({ pad: 'x'.repeat(70_000) })]
  ])('starts again from %s, with a warning', (_label, content) => {
    writeStatusFile(content)
    expect(new BackupStatusStore(paths, log).record).toEqual(EMPTY)
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]).toMatchObject({ level: 'WARN' })
  })

  it('keeps a change in memory, with a warning, when the file cannot be written', () => {
    replaceFolderWithFile(paths.backupsDir)
    const store = new BackupStatusStore(paths, log)
    expect(store.record).toEqual(EMPTY)
    store.update({ lastManual: MANUAL })
    expect(store.record.lastManual).toEqual(MANUAL)
    expect(log.entries.at(-1)).toMatchObject({
      level: 'WARN',
      message: '[backup] the backup status file could not be written',
      context: { code: expect.any(String) }
    })
  })
})

describe('listAutomaticBackups', () => {
  it('lists the automatic backups newest first, and ignores every other file', () => {
    const older = autoBackup(new Date(2026, 8, 12, 9, 0, 0))
    const newest = autoBackup(new Date(2026, 8, 14, 9, 0, 0))
    const middle = autoBackup(new Date(2026, 8, 13, 18, 30, 0))
    const folder = backupFolder(paths, 'auto')
    writeFileSync(win32.join(folder, `${newest}.tmp`), 'in progress')
    writeFileSync(win32.join(folder, newest.replace(/\.db$/, '.json')), '{}')
    writeFileSync(win32.join(folder, 'notes.txt'), 'notes')
    mkdirSync(win32.join(folder, formatBackupFileName(new Date(2026, 8, 15), '1.0.0', 1)))
    expect(listAutomaticBackups(paths).map((backup) => backup.fileName)).toEqual([
      newest,
      middle,
      older
    ])
  })

  it('is empty when the folder does not exist', () => {
    expect(listAutomaticBackups(paths)).toEqual([])
  })
})

describe('backupFailureMessage', () => {
  it('explains each backup failure in plain words, and anything else generically', () => {
    expect(backupFailureMessage('DESTINATION_UNAVAILABLE')).toMatch(/drive is connected/)
    expect(backupFailureMessage('DESTINATION_EXISTS')).toMatch(/never replaces a file/)
    expect(backupFailureMessage('VERIFICATION_FAILED')).toMatch(/integrity check/)
    for (const code of [null, 'UNEXPECTED', 'toString', '__proto__']) {
      expect(backupFailureMessage(code)).toBe('The backup could not be made. Try again.')
    }
  })
})

describe('describeBackupStatus', () => {
  const sources = {
    busy: false,
    appDataPath: 'C:\\Users\\owner\\AppData\\Roaming',
    homePath: 'C:\\Users\\owner'
  }

  it('is NONE before the first automatic backup', () => {
    expect(describeBackupStatus({ ...sources, paths, record: EMPTY })).toEqual({
      health: 'NONE',
      lastAutomatic: null,
      lastFailure: null,
      lastManual: null,
      lastRestore: null,
      folder: '…\\auto',
      busy: false
    })
  })

  it('is OK with the newest automatic backup', () => {
    autoBackup(new Date(2026, 8, 13, 9, 0, 0))
    const newest = new Date(2026, 8, 14, 9, 0, 0)
    const name = autoBackup(newest)
    expect(describeBackupStatus({ ...sources, paths, record: EMPTY })).toMatchObject({
      health: 'OK',
      lastAutomatic: { at: newest.toISOString(), fileName: name }
    })
  })

  it('is FAILED while the last automatic backup failed, with a plain message', () => {
    autoBackup(new Date(2026, 8, 13, 9, 0, 0))
    const status = describeBackupStatus({
      ...sources,
      paths,
      record: { ...EMPTY, lastAutomaticFailure: FAILURE }
    })
    expect(status).toMatchObject({
      health: 'FAILED',
      lastFailure: { at: FAILURE.at, message: backupFailureMessage('COPY_FAILED') }
    })
  })

  it('shows folders in display form only, and the last restore as recorded', () => {
    const inProfile = { ...MANUAL, folder: 'C:\\Users\\owner\\Documents\\Shop backups' }
    const onUsb = describeBackupStatus({
      ...sources,
      paths: resolveDataPaths('C:\\Users\\owner\\AppData\\Roaming\\StockFlow'),
      record: { ...EMPTY, lastManual: MANUAL, lastRestore: RESTORE }
    })
    expect(onUsb).toMatchObject({
      folder: '%APPDATA%\\StockFlow\\backups\\auto',
      lastManual: { at: MANUAL.at, fileName: MANUAL.fileName, location: 'E:\\Backups' },
      lastRestore: RESTORE
    })
    const status = describeBackupStatus({
      ...sources,
      paths,
      record: { ...EMPTY, lastManual: inProfile },
      busy: true
    })
    expect(status.lastManual?.location).toBe('%USERPROFILE%\\Documents\\Shop backups')
    expect(status.busy).toBe(true)
    expect(JSON.stringify(status)).not.toContain('owner')
  })
})
