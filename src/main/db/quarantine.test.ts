import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSqlite } from './adapter'
import { parseBackupFileName } from './backup-files'
import {
  formatRecoveryFileName,
  freeRecoveryFile,
  isRecoveryFileName,
  quarantineDatabaseFiles,
  reinstateQuarantined
} from './quarantine'
import { TEST_TIME, createTempDir, fileHash, thrown, type TempDir } from './test-utils'

const SUFFIXES = ['', '-wal', '-shm', '-journal'] as const

let temp: TempDir

beforeEach(() => {
  temp = createTempDir()
  mkdirSync(temp.file('data'))
  mkdirSync(temp.file('recovery'))
})

afterEach(() => {
  temp.remove()
})

function database(): string {
  return temp.file('data\\shop.db')
}

function target(): string {
  return temp.file('recovery\\damaged-live-db_2026-09-14_153045.db')
}

describe('recovery file names', () => {
  it('names a preserved database after the local time, never like a backup', () => {
    expect(formatRecoveryFileName(TEST_TIME)).toBe('damaged-live-db_2026-09-14_153045.db')
    expect(formatRecoveryFileName(TEST_TIME, 2)).toBe('damaged-live-db_2026-09-14_153045_2.db')
    expect(isRecoveryFileName('damaged-live-db_2026-09-14_153045.db')).toBe(true)
    expect(isRecoveryFileName('damaged-live-db_2026-09-14_153045_2.db')).toBe(true)
    expect(parseBackupFileName('damaged-live-db_2026-09-14_153045.db')).toBeNull()
    for (const name of [
      'stockflow-backup_2026-09-14_153045_v1.0.0_s1.db',
      'damaged-live-db_2026-09-14_153045.db-wal',
      '..\\damaged-live-db_2026-09-14_153045.db',
      'damaged-live-db_2026-9-14_153045.db',
      'shop.db'
    ]) {
      expect(isRecoveryFileName(name)).toBe(false)
    }
  })

  it('picks a name that neither the database file nor any of its companions already has', () => {
    const folder = temp.file('recovery')
    expect(freeRecoveryFile(folder, TEST_TIME)).toBe(
      win32.join(folder, 'damaged-live-db_2026-09-14_153045.db')
    )
    writeFileSync(win32.join(folder, 'damaged-live-db_2026-09-14_153045.db-wal'), 'x')
    expect(freeRecoveryFile(folder, TEST_TIME)).toBe(
      win32.join(folder, 'damaged-live-db_2026-09-14_153045_2.db')
    )
  })

  it('refuses when every name for that second is taken', () => {
    const folder = temp.file('recovery')
    for (let sequence = 1; sequence <= 99; sequence++) {
      writeFileSync(win32.join(folder, formatRecoveryFileName(TEST_TIME, sequence)), 'x')
    }
    expect(thrown(() => freeRecoveryFile(folder, TEST_TIME))).toBeInstanceOf(Error)
  })
})

describe('quarantineDatabaseFiles', () => {
  it('moves the database file and every companion byte for byte, under one name, the database file last', () => {
    for (const suffix of SUFFIXES) writeFileSync(`${database()}${suffix}`, `content${suffix}`)
    const hashes = SUFFIXES.map((suffix) => fileHash(`${database()}${suffix}`))
    expect(quarantineDatabaseFiles(database(), target())).toEqual(
      ['-wal', '-shm', '-journal', ''].map((suffix) => `${target()}${suffix}`)
    )
    expect(readdirSync(temp.file('data'))).toEqual([])
    expect(SUFFIXES.map((suffix) => fileHash(`${target()}${suffix}`))).toEqual(hashes)
  })

  it('moves only the files that exist', () => {
    writeFileSync(database(), 'damaged')
    expect(quarantineDatabaseFiles(database(), target())).toEqual([target()])
    expect(
      quarantineDatabaseFiles(temp.file('data\\missing.db'), temp.file('recovery\\other.db'))
    ).toEqual([])
  })

  it('never replaces a file: it stops at the first name that is taken', () => {
    writeFileSync(database(), 'damaged')
    writeFileSync(`${database()}-wal`, 'wal')
    writeFileSync(target(), 'already here')
    expect(() => quarantineDatabaseFiles(database(), target())).toThrow('already exists')
    expect(readFileSync(target(), 'utf8')).toBe('already here')
    expect(readFileSync(database(), 'utf8')).toBe('damaged')
    // The companion moved before the database file was refused; reinstateQuarantined puts it back.
    expect(existsSync(`${target()}-wal`)).toBe(true)
  })
})

describe('reinstateQuarantined', () => {
  it('puts every preserved file back under the database name, byte for byte', () => {
    for (const suffix of SUFFIXES) writeFileSync(`${database()}${suffix}`, `content${suffix}`)
    const hashes = SUFFIXES.map((suffix) => fileHash(`${database()}${suffix}`))
    quarantineDatabaseFiles(database(), target())

    expect(reinstateQuarantined(database(), target())).toBe(true)

    expect(SUFFIXES.map((suffix) => fileHash(`${database()}${suffix}`))).toEqual(hashes)
    expect(readdirSync(temp.file('recovery'))).toEqual([])
  })

  it('moves back what was moved when the database file itself never left, and removes nothing', () => {
    writeFileSync(database(), 'damaged')
    writeFileSync(`${database()}-wal`, 'wal')
    // Interrupted after the WAL was moved, before the database file.
    renameSync(`${database()}-wal`, `${target()}-wal`)
    expect(reinstateQuarantined(database(), target())).toBe(true)
    expect(readdirSync(temp.file('data')).sort()).toEqual(['shop.db', 'shop.db-wal'])
    expect(readFileSync(database(), 'utf8')).toBe('damaged')
    expect(readFileSync(`${database()}-wal`, 'utf8')).toBe('wal')
  })

  it('reports false when nothing had been moved', () => {
    writeFileSync(database(), 'damaged')
    expect(reinstateQuarantined(database(), target())).toBe(false)
    expect(readFileSync(database(), 'utf8')).toBe('damaged')
  })

  it('never replaces a file: it throws and keeps both', () => {
    writeFileSync(target(), 'preserved')
    const installed = temp.track(openSqlite(database()))
    installed.exec('CREATE TABLE installed (id INTEGER PRIMARY KEY)')
    expect(() => reinstateQuarantined(database(), target())).toThrow('already exists')
    expect(readFileSync(target(), 'utf8')).toBe('preserved')
    expect(existsSync(database())).toBe(true)
  })
})
