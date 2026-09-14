import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSqlite, sqliteErrorCode, type Db } from './adapter'
import {
  CONNECTION_PRAGMAS,
  DatabaseOpenError,
  STOCKFLOW_APPLICATION_ID,
  isEmptyDatabase,
  openDatabase,
  readApplicationId,
  readConnectionPragmas,
  readUserVersion
} from './connection'
import { createTempDir, thrown, type TempDir } from './test-utils'

let temp: TempDir

beforeEach(() => {
  temp = createTempDir()
})

afterEach(() => {
  temp.remove()
})

function openApp(name = 'data/shop.db'): Db {
  return temp.track(openDatabase(temp.file(name)))
}

/** A plain SQLite file made by "another application" (raw driver, no StockFlow configuration). */
function createForeignFile(name: string, script: string): string {
  const db = openSqlite(temp.file(name))
  db.exec(script)
  db.close()
  return temp.file(name)
}

describe('STOCKFLOW_APPLICATION_ID', () => {
  it('is the ASCII tag "STFL" as a positive signed 32-bit integer', () => {
    expect(STOCKFLOW_APPLICATION_ID).toBe(0x5354464c)
    expect(STOCKFLOW_APPLICATION_ID).toBe(1_398_031_948)
    const bytes = [24, 16, 8, 0].map((shift) => (STOCKFLOW_APPLICATION_ID >>> shift) & 0xff)
    expect(String.fromCharCode(...bytes)).toBe('STFL')
    expect(STOCKFLOW_APPLICATION_ID).toBeLessThanOrEqual(0x7fff_ffff)
  })
})

describe('openDatabase', () => {
  it('creates the folder and the file of a new database', () => {
    const db = openApp('nested/data/shop.db')
    expect(db.isOpen).toBe(true)
    expect(existsSync(temp.file('nested/data/shop.db'))).toBe(true)
  })

  it('applies the connection pragmas and reads them back', () => {
    expect(CONNECTION_PRAGMAS).toEqual({
      foreign_keys: 1,
      journal_mode: 'wal',
      synchronous: 2,
      busy_timeout: 5000,
      recursive_triggers: 1
    })
    expect(readConnectionPragmas(openApp())).toEqual(CONNECTION_PRAGMAS)
  })

  it('enforces foreign keys', () => {
    const db = openApp()
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent (id)) STRICT;
    `)
    const error = thrown(() => db.run('INSERT INTO child (parent_id) VALUES (?)', [1]))
    expect(sqliteErrorCode(error)).toBe('SQLITE_CONSTRAINT_FOREIGNKEY')
  })

  it('writes through the write-ahead log', () => {
    const db = openApp()
    db.exec('CREATE TABLE probe (v TEXT) STRICT')
    expect(existsSync(temp.file('data/shop.db-wal'))).toBe(true)
  })

  it('refuses a connection whose pragmas do not take effect', () => {
    // An in-memory database cannot use WAL, so the read-back check must fail.
    const error = thrown(() => openDatabase(':memory:'))
    expect(error).toBeInstanceOf(DatabaseOpenError)
    expect(error).toMatchObject({ code: 'CONFIGURATION_FAILED' })
    expect((error as Error).message).toMatch(/journal_mode/)
  })

  it('stamps a new, empty database with the StockFlow application_id at schema version 0', () => {
    const db = openApp()
    expect(readApplicationId(db)).toBe(STOCKFLOW_APPLICATION_ID)
    expect(readUserVersion(db)).toBe(0)
    expect(db.all('SELECT name FROM sqlite_schema')).toEqual([])
  })

  it('reopens an existing StockFlow database with its data and version', () => {
    const first = openApp()
    first.exec("CREATE TABLE probe (v TEXT) STRICT; INSERT INTO probe VALUES ('kept')")
    first.exec('PRAGMA user_version = 4')
    first.close()

    const again = openApp()
    expect(readApplicationId(again)).toBe(STOCKFLOW_APPLICATION_ID)
    expect(readUserVersion(again)).toBe(4)
    expect(again.all('SELECT v FROM probe')).toEqual([{ v: 'kept' }])
  })

  it('refuses a SQLite file of another application and leaves it unchanged', () => {
    const file = createForeignFile(
      'other.db',
      'PRAGMA application_id = 42; CREATE TABLE t (v TEXT)'
    )
    const error = thrown(() => openDatabase(file))
    expect(error).toBeInstanceOf(DatabaseOpenError)
    expect(error).toMatchObject({ code: 'NOT_STOCKFLOW_DATABASE' })
    const check = temp.track(openSqlite(file, { readonly: true }))
    expect(readApplicationId(check)).toBe(42)
  })

  it('refuses an unmarked SQLite file that already has tables', () => {
    const file = createForeignFile('unmarked.db', 'CREATE TABLE t (v TEXT)')
    expect(thrown(() => openDatabase(file))).toMatchObject({ code: 'NOT_STOCKFLOW_DATABASE' })
    const check = temp.track(openSqlite(file, { readonly: true }))
    expect(readApplicationId(check)).toBe(0)
  })

  it('refuses a file that is not a SQLite database, and releases it', () => {
    const file = temp.file('notes.db')
    writeFileSync(file, 'This is not a database. '.repeat(100))
    expect(thrown(() => openDatabase(file))).toMatchObject({ code: 'NOT_STOCKFLOW_DATABASE' })
    // Windows refuses to delete a file that is still open.
    rmSync(file)
  })
})

describe('isEmptyDatabase', () => {
  it('is true only with no schema objects and schema version 0', () => {
    const db = temp.track(openSqlite(temp.file('empty.db')))
    expect(isEmptyDatabase(db)).toBe(true)
    db.exec('PRAGMA user_version = 1')
    expect(isEmptyDatabase(db)).toBe(false)
    db.exec('PRAGMA user_version = 0; CREATE TABLE t (v TEXT)')
    expect(isEmptyDatabase(db)).toBe(false)
  })
})
