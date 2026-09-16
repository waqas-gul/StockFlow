import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSqlite } from './adapter'
import { STOCKFLOW_APPLICATION_ID, openDatabase } from './connection'
import {
  LATEST_SCHEMA_VERSION,
  corruptIndex,
  createSchemaDatabase,
  createTempDir,
  editDatabaseFile,
  holdOpen,
  insertRow,
  thrown,
  violateCheckConstraint,
  type TempDir
} from './test-utils'
import {
  DatabaseFileError,
  foreignKeyViolations,
  integrityProblems,
  recordCounts,
  verifyDatabaseFile
} from './verify'

let temp: TempDir

beforeEach(() => {
  temp = createTempDir()
})

afterEach(() => {
  temp.remove()
})

/** A closed copy of a new schema-1 database, made by the online backup API (so WAL-flagged, like a fresh backup). */
async function schemaCopy(name = 'copy.db'): Promise<string> {
  const db = await createSchemaDatabase(temp)
  await db.backup(temp.file(name))
  return temp.file(name)
}

function problemOf(fn: () => unknown): DatabaseFileError {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(DatabaseFileError)
  return error as DatabaseFileError
}

/** File-format bytes 18 and 19: 1 = rollback journal, 2 = WAL. */
function journalBytes(file: string): number[] {
  const bytes = readFileSync(file)
  return [bytes[18], bytes[19]]
}

/** Inserts a unit of a product that does not exist, bypassing foreign-key enforcement. */
function addOrphanUnit(file: string): void {
  editDatabaseFile(
    file,
    "INSERT INTO product_units (product_id, name, base_qty, is_base) VALUES (999, 'Orphan', 1, 1)"
  )
}

describe('verifyDatabaseFile', () => {
  it('accepts a healthy StockFlow database and reports its schema, SQLite version and record counts', async () => {
    const file = await schemaCopy()
    expect(verifyDatabaseFile(file)).toEqual({
      applicationId: STOCKFLOW_APPLICATION_ID,
      schemaVersion: LATEST_SCHEMA_VERSION,
      sqliteVersion: expect.stringMatching(/^3\.\d+\.\d+$/),
      counts: { products: 0, customers: 1, invoices: 0 }
    })
  })

  it('makes the file self-contained: a WAL-flagged copy is switched to rollback-journal mode', async () => {
    const file = await schemaCopy()
    expect(journalBytes(file)).toEqual([2, 2])
    verifyDatabaseFile(file)
    expect(journalBytes(file)).toEqual([1, 1])
    expect(readdirSync(temp.path).filter((name) => name.startsWith('copy.db'))).toEqual(['copy.db'])
  })

  it('reports no count for a table the database does not have', () => {
    openDatabase(temp.file('empty.db')).close()
    expect(verifyDatabaseFile(temp.file('empty.db')).counts).toEqual({
      products: null,
      customers: null,
      invoices: null
    })
  })

  it('refuses a missing file or a folder, and creates nothing', () => {
    expect(problemOf(() => verifyDatabaseFile(temp.file('missing.db'))).code).toBe('MISSING')
    expect(existsSync(temp.file('missing.db'))).toBe(false)
    mkdirSync(temp.file('folder.db'))
    expect(problemOf(() => verifyDatabaseFile(temp.file('folder.db'))).code).toBe('MISSING')
  })

  it('refuses a file that is not a SQLite database', () => {
    writeFileSync(
      temp.file('notes.db'),
      'These are not the backups you are looking for. '.repeat(50)
    )
    expect(problemOf(() => verifyDatabaseFile(temp.file('notes.db'))).code).toBe('NOT_SQLITE')
  })

  it('refuses a SQLite database of another application, and an empty file', () => {
    editDatabaseFileAt('other.db', 'PRAGMA application_id = 42; CREATE TABLE t (v TEXT)')
    const other = problemOf(() => verifyDatabaseFile(temp.file('other.db')))
    expect(other.code).toBe('NOT_STOCKFLOW')
    expect(other.message).toMatch(/application_id 42/)
    writeFileSync(temp.file('empty.db'), '')
    expect(problemOf(() => verifyDatabaseFile(temp.file('empty.db'))).code).toBe('NOT_STOCKFLOW')
  })

  it('refuses a negative schema version', async () => {
    const file = await schemaCopy()
    editDatabaseFile(file, 'PRAGMA user_version = -1')
    expect(problemOf(() => verifyDatabaseFile(file)).code).toBe('INVALID_SCHEMA_VERSION')
  })

  it('refuses a schema newer than the given maximum, and reports that version', async () => {
    const file = await schemaCopy()
    editDatabaseFile(file, 'PRAGMA user_version = 7')
    const tooNew = problemOf(() => verifyDatabaseFile(file, { maxSchemaVersion: 1 }))
    expect(tooNew).toMatchObject({ code: 'SCHEMA_TOO_NEW', schemaVersion: 7 })
    expect(verifyDatabaseFile(file, { maxSchemaVersion: 7 }).schemaVersion).toBe(7)
  })

  it('refuses a damaged file whose integrity_check reports problems', async () => {
    const file = await schemaCopy()
    violateCheckConstraint(file)
    const damaged = problemOf(() => verifyDatabaseFile(file))
    expect(damaged.code).toBe('INTEGRITY_CHECK_FAILED')
    expect(damaged.message).toMatch(/integrity_check/)
  })

  it('refuses a file so damaged that integrity_check itself fails', async () => {
    const file = await schemaCopy()
    corruptIndex(file, 'idx_customers_name')
    expect(problemOf(() => verifyDatabaseFile(file)).code).toBe('INTEGRITY_CHECK_FAILED')
  })

  it('refuses a file with foreign key violations', async () => {
    const file = await schemaCopy()
    addOrphanUnit(file)
    const violated = problemOf(() => verifyDatabaseFile(file))
    expect(violated.code).toBe('FOREIGN_KEY_CHECK_FAILED')
    expect(violated.message).toMatch(/product_units/)
  })

  it('reports a file it cannot take over as unreadable, e.g. while another program has it open', async () => {
    const file = await schemaCopy()
    const other = holdOpen(temp, file)
    other.get('SELECT count(*) AS n FROM sqlite_schema')
    expect(problemOf(() => verifyDatabaseFile(file)).code).toBe('UNREADABLE')
  })

  it('closes the file after a success and after a failure', async () => {
    const file = await schemaCopy()
    verifyDatabaseFile(file)
    rmSync(file)
    writeFileSync(file, '')
    problemOf(() => verifyDatabaseFile(file))
    // Windows refuses to delete a file that is still open.
    rmSync(file)
  })
})

describe('integrityProblems', () => {
  it('is empty for a healthy database', async () => {
    expect(integrityProblems(await createSchemaDatabase(temp))).toEqual([])
  })

  it('lists the problems integrity_check reports', async () => {
    const file = await schemaCopy()
    violateCheckConstraint(file)
    expect(integrityProblems(temp.track(openSqlite(file)))).toEqual([
      'CHECK constraint failed in settings'
    ])
  })

  it('returns the failure itself when the damage makes integrity_check fail', async () => {
    const file = await schemaCopy()
    corruptIndex(file, 'idx_customers_name')
    const problems = integrityProblems(temp.track(openSqlite(file)))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/malformed|corrupt/i)
  })

  it('rethrows failures that are not about the file, such as a closed connection', async () => {
    const db = await createSchemaDatabase(temp)
    db.close()
    expect(() => integrityProblems(db)).toThrow(/not open/)
  })
})

describe('foreignKeyViolations', () => {
  it('lists each row whose parent row is missing', async () => {
    const file = await schemaCopy()
    expect(foreignKeyViolations(temp.track(openSqlite(file)))).toEqual([])
    addOrphanUnit(file)
    expect(foreignKeyViolations(temp.track(openSqlite(file)))).toEqual([
      { table: 'product_units', rowid: 1, parent: 'products' }
    ])
  })
})

describe('recordCounts', () => {
  it('counts products, customers and invoices', async () => {
    const db = await createSchemaDatabase(temp)
    insertRow(db, 'products', { code: 'P-001', name: 'Tea' })
    insertRow(db, 'customers', { code: 'C-00002', name: 'Ali' })
    expect(recordCounts(db)).toEqual({ products: 1, customers: 2, invoices: 0 })
  })
})

function editDatabaseFileAt(name: string, script: string): void {
  const db = openSqlite(temp.file(name))
  db.exec(script)
  db.close()
}
