import { existsSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSqlite, sqliteErrorCode, type Db } from './adapter'
import { createTempDir, thrown, type TempDir } from './test-utils'

let temp: TempDir

beforeEach(() => {
  temp = createTempDir()
})

afterEach(() => {
  temp.remove()
})

function open(name = 'test.db', options?: { readonly?: boolean }): Db {
  return temp.track(openSqlite(temp.file(name), options))
}

/** A database with one technical test table (never a business table). */
function openWithTable(name = 'test.db'): Db {
  const db = open(name)
  db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE) STRICT')
  return db
}

function count(db: Db): number {
  return db.get<{ n: number }>('SELECT count(*) AS n FROM probe')?.n ?? -1
}

describe('openSqlite', () => {
  it('opens a file database with the better-sqlite3 driver', () => {
    const db = open()
    expect(db.driver).toBe('better-sqlite3')
    expect(db.isOpen).toBe(true)
    expect(db.inTransaction).toBe(false)
    expect(db.get<{ one: number }>('SELECT 1 AS one')).toEqual({ one: 1 })
    expect(existsSync(temp.file('test.db'))).toBe(true)
  })

  it('opens read-only on request and refuses writes', () => {
    openWithTable('shared.db')
    const readOnly = open('shared.db', { readonly: true })
    expect(readOnly.all('SELECT * FROM probe')).toEqual([])
    const error = thrown(() => readOnly.run('INSERT INTO probe (label) VALUES (?)', ['x']))
    expect(sqliteErrorCode(error)).toBe('SQLITE_READONLY')
  })

  it('never creates a missing file when opening read-only', () => {
    expect(() => open('missing.db', { readonly: true })).toThrow()
    expect(existsSync(temp.file('missing.db'))).toBe(false)
  })
})

describe('run, get, all and exec', () => {
  it('runs a statement and reports the changes and the inserted rowid', () => {
    const db = openWithTable()
    expect(db.run('INSERT INTO probe (label) VALUES (?)', ['a'])).toEqual({
      changes: 1,
      lastInsertRowid: 1
    })
    expect(db.run('UPDATE probe SET label = label || ?', ['!'])).toMatchObject({ changes: 1 })
  })

  it('binds positional and named parameters', () => {
    const db = openWithTable()
    db.run('INSERT INTO probe (id, label) VALUES (?, ?)', [7, 'positional'])
    db.run('INSERT INTO probe (id, label) VALUES (@id, @label)', { id: 8, label: 'named' })
    expect(db.get('SELECT label FROM probe WHERE id = ?', [7])).toEqual({ label: 'positional' })
    expect(db.get('SELECT label FROM probe WHERE id = @id', { id: 8 })).toEqual({ label: 'named' })
  })

  it('returns undefined from get when no row matches', () => {
    const db = openWithTable()
    expect(db.get('SELECT * FROM probe WHERE id = ?', [99])).toBeUndefined()
  })

  it('returns every row from all, in query order', () => {
    const db = openWithTable()
    for (const label of ['b', 'c', 'a']) db.run('INSERT INTO probe (label) VALUES (?)', [label])
    expect(db.all<{ label: string }>('SELECT label FROM probe ORDER BY label')).toEqual([
      { label: 'a' },
      { label: 'b' },
      { label: 'c' }
    ])
    expect(db.all('SELECT * FROM probe WHERE id > ?', [100])).toEqual([])
  })

  it('runs multi-statement scripts with exec', () => {
    const db = open()
    db.exec(`
      CREATE TABLE probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT;
      INSERT INTO probe (label) VALUES ('one');
      INSERT INTO probe (label) VALUES ('two');
    `)
    expect(count(db)).toBe(2)
  })

  it('refuses more than one statement outside exec', () => {
    const db = openWithTable()
    expect(() => db.run("INSERT INTO probe (label) VALUES ('a'); DELETE FROM probe")).toThrow(
      /more than one statement/
    )
    expect(count(db)).toBe(0)
  })

  it('refuses values that SQLite cannot store', () => {
    const db = open()
    // @ts-expect-error booleans are not SQLite values; the schema stores 0/1 integers instead
    expect(() => db.get('SELECT ? AS value', [true])).toThrow()
  })
})

describe('transaction', () => {
  it('commits when the callback returns, and returns its value', () => {
    const db = openWithTable()
    const result = db.transaction(() => {
      expect(db.inTransaction).toBe(true)
      db.run('INSERT INTO probe (label) VALUES (?)', ['a'])
      db.run('INSERT INTO probe (label) VALUES (?)', ['b'])
      return 'saved'
    })
    expect(result).toBe('saved')
    expect(db.inTransaction).toBe(false)
    // Another connection sees the rows, so they were committed to the file.
    expect(count(open())).toBe(2)
  })

  it('takes the write lock as soon as it begins (BEGIN IMMEDIATE)', () => {
    const db = openWithTable()
    const other = open()
    other.exec('PRAGMA busy_timeout = 0')
    db.transaction(() => {
      // No write has happened yet, but a second writer is already locked out.
      expect(sqliteErrorCode(thrown(() => other.exec('BEGIN IMMEDIATE')))).toBe('SQLITE_BUSY')
    })
    other.exec('BEGIN IMMEDIATE')
    other.exec('ROLLBACK')
  })

  it('rolls back and rethrows when the callback throws, leaving no partial writes', () => {
    const db = openWithTable()
    db.run('INSERT INTO probe (label) VALUES (?)', ['before'])
    const failure = new Error('simulated failure after three writes')
    const error = thrown(() =>
      db.transaction(() => {
        db.run('INSERT INTO probe (label) VALUES (?)', ['x'])
        db.run('INSERT INTO probe (label) VALUES (?)', ['y'])
        db.run("UPDATE probe SET label = 'changed' WHERE label = 'before'")
        throw failure
      })
    )
    expect(error).toBe(failure)
    expect(db.inTransaction).toBe(false)
    expect(db.all('SELECT label FROM probe')).toEqual([{ label: 'before' }])
    expect(open().all('SELECT label FROM probe')).toEqual([{ label: 'before' }])
  })

  it('rolls back when a statement inside fails', () => {
    const db = openWithTable()
    const error = thrown(() =>
      db.transaction(() => {
        db.run('INSERT INTO probe (label) VALUES (?)', ['dup'])
        db.run('INSERT INTO probe (label) VALUES (?)', ['dup'])
      })
    )
    expect(sqliteErrorCode(error)).toBe('SQLITE_CONSTRAINT_UNIQUE')
    expect(count(db)).toBe(0)
  })

  it('refuses a nested transaction and rolls back the outer one', () => {
    const db = openWithTable()
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO probe (label) VALUES (?)', ['outer'])
        db.transaction(() => db.run('INSERT INTO probe (label) VALUES (?)', ['inner']))
      })
    ).toThrow(/nested/i)
    expect(db.inTransaction).toBe(false)
    expect(count(db)).toBe(0)
  })

  it('refuses an async callback and rolls back what it wrote', () => {
    const db = openWithTable()
    expect(() =>
      db.transaction(async () => {
        db.run('INSERT INTO probe (label) VALUES (?)', ['async'])
      })
    ).toThrow(/synchronous/)
    expect(db.inTransaction).toBe(false)
    expect(count(db)).toBe(0)
  })

  it('does not leave an unhandled rejection when a refused async callback fails later', async () => {
    const db = openWithTable()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      expect(() =>
        db.transaction(async () => {
          throw new Error('fails after the synchronous check')
        })
      ).toThrow(/synchronous/)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('rethrows the original error when the transaction has already ended', () => {
    const db = openWithTable()
    const failure = new Error('original failure')
    const error = thrown(() =>
      db.transaction(() => {
        db.run('INSERT INTO probe (label) VALUES (?)', ['x'])
        db.exec('ROLLBACK')
        throw failure
      })
    )
    expect(error).toBe(failure)
    expect(db.inTransaction).toBe(false)
    expect(count(db)).toBe(0)
  })

  it('works again after a rollback', () => {
    const db = openWithTable()
    expect(() =>
      db.transaction(() => {
        throw new Error('first attempt fails')
      })
    ).toThrow('first attempt fails')
    db.transaction(() => db.run('INSERT INTO probe (label) VALUES (?)', ['second']))
    expect(count(db)).toBe(1)
  })
})

describe('backup', () => {
  it('writes a copy of the committed data, including data still in the WAL', async () => {
    const db = openWithTable()
    db.exec('PRAGMA journal_mode = WAL')
    db.run('INSERT INTO probe (label) VALUES (?)', ['in-wal'])
    expect(existsSync(temp.file('test.db-wal'))).toBe(true)

    await db.backup(temp.file('copy.db'))

    const copy = open('copy.db', { readonly: true })
    expect(copy.all('SELECT label FROM probe')).toEqual([{ label: 'in-wal' }])
  })

  it('rejects when the destination folder does not exist', async () => {
    const db = openWithTable()
    await expect(db.backup(temp.file('no-such-folder/copy.db'))).rejects.toThrow(
      /directory does not exist/
    )
  })
})

describe('close', () => {
  it('checkpoints the WAL, releases the file and can be called twice', () => {
    const db = openWithTable()
    db.exec('PRAGMA journal_mode = WAL')
    db.run('INSERT INTO probe (label) VALUES (?)', ['x'])
    db.close()
    expect(db.isOpen).toBe(false)
    expect(existsSync(temp.file('test.db-wal'))).toBe(false)
    expect(existsSync(temp.file('test.db-shm'))).toBe(false)
    // Windows refuses to delete a file that is still open.
    rmSync(temp.file('test.db'))
    expect(() => db.close()).not.toThrow()
  })

  it('refuses statements after close', () => {
    const db = openWithTable()
    db.close()
    expect(() => db.get('SELECT 1')).toThrow(/not open/)
  })
})

describe('sqliteErrorCode', () => {
  it('returns the SQLite result code of a driver error', () => {
    const db = openWithTable()
    expect(sqliteErrorCode(thrown(() => db.run('SELEC 1')))).toBe('SQLITE_ERROR')
    db.run('INSERT INTO probe (id, label) VALUES (1, ?)', ['a'])
    const duplicateKey = thrown(() => db.run('INSERT INTO probe (id, label) VALUES (1, ?)', ['b']))
    expect(sqliteErrorCode(duplicateKey)).toBe('SQLITE_CONSTRAINT_PRIMARYKEY')
  })

  it('returns undefined for anything else', () => {
    expect(sqliteErrorCode(new Error('plain'))).toBeUndefined()
    expect(sqliteErrorCode('text')).toBeUndefined()
    expect(sqliteErrorCode(undefined)).toBeUndefined()
  })
})
