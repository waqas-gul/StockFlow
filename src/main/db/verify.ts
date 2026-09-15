import { statSync } from 'node:fs'
import { openSqlite, sqliteErrorCode, type Db } from './adapter'
import { STOCKFLOW_APPLICATION_ID, readApplicationId, readUserVersion } from './connection'

export type DatabaseFileProblem =
  | 'MISSING'
  | 'NOT_SQLITE'
  | 'NOT_STOCKFLOW'
  | 'INVALID_SCHEMA_VERSION'
  | 'SCHEMA_TOO_NEW'
  | 'INTEGRITY_CHECK_FAILED'
  | 'FOREIGN_KEY_CHECK_FAILED'
  | 'UNREADABLE'

/** Why a database file failed verification. The message is technical (for the log), not for the user. */
export class DatabaseFileError extends Error {
  readonly code: DatabaseFileProblem
  /** The file's schema version, when it was read before the failure. */
  readonly schemaVersion?: number

  constructor(
    code: DatabaseFileProblem,
    message: string,
    options: { cause?: unknown; schemaVersion?: number } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'DatabaseFileError'
    this.code = code
    this.schemaVersion = options.schemaVersion
  }
}

/** Record counts for a backup's summary; null when the database has no such table (schema 0). */
export interface RecordCounts {
  readonly products: number | null
  readonly customers: number | null
  readonly invoices: number | null
}

export interface DatabaseFileReport {
  readonly applicationId: number
  readonly schemaVersion: number
  readonly sqliteVersion: string
  readonly counts: RecordCounts
}

export interface VerifyFileOptions {
  /** The newest schema accepted: the app's latest for a restore candidate. */
  readonly maxSchemaVersion?: number
}

/**
 * Verifies a closed database file that StockFlow owns: a new backup, or the private copy of a restore candidate.
 * Never call it on someone else's file: it first switches the file to rollback-journal mode, so that the file is
 * complete on its own (an online backup of a WAL database is WAL-flagged). Then it checks, in order: the StockFlow
 * application_id, the schema version, PRAGMA integrity_check and PRAGMA foreign_key_check. The first failure is
 * thrown as a DatabaseFileError; the connection is always closed.
 */
export function verifyDatabaseFile(
  file: string,
  options: VerifyFileOptions = {}
): DatabaseFileReport {
  if (!isFile(file)) throw new DatabaseFileError('MISSING', 'The file does not exist.')
  let db: Db | undefined
  try {
    db = openSqlite(file, { mustExist: true })
    const [{ journal_mode: mode }] = db.all<{ journal_mode: string }>(
      'PRAGMA journal_mode = DELETE'
    )
    if (mode !== 'delete') {
      throw new DatabaseFileError('UNREADABLE', `The file stayed in journal mode ${mode}.`)
    }
    const applicationId = readApplicationId(db)
    if (applicationId !== STOCKFLOW_APPLICATION_ID) {
      throw new DatabaseFileError(
        'NOT_STOCKFLOW',
        `The file is not a StockFlow database (application_id ${applicationId}).`
      )
    }
    const schemaVersion = readUserVersion(db)
    if (schemaVersion < 0) {
      throw new DatabaseFileError(
        'INVALID_SCHEMA_VERSION',
        `The file has an invalid schema version (${schemaVersion}).`,
        { schemaVersion }
      )
    }
    const { maxSchemaVersion } = options
    if (maxSchemaVersion !== undefined && schemaVersion > maxSchemaVersion) {
      throw new DatabaseFileError(
        'SCHEMA_TOO_NEW',
        `The file uses schema ${schemaVersion}; this version of StockFlow supports schemas up to ${maxSchemaVersion}.`,
        { schemaVersion }
      )
    }
    const problems = integrityProblems(db)
    if (problems.length > 0) {
      throw new DatabaseFileError(
        'INTEGRITY_CHECK_FAILED',
        `PRAGMA integrity_check reported: ${problems.slice(0, 3).join('; ')}`,
        { schemaVersion }
      )
    }
    const violations = foreignKeyViolations(db)
    if (violations.length > 0) {
      throw new DatabaseFileError(
        'FOREIGN_KEY_CHECK_FAILED',
        `PRAGMA foreign_key_check found ${violations.length} violation(s), the first in table ${violations[0].table}.`,
        { schemaVersion }
      )
    }
    const [{ version }] = db.all<{ version: string }>('SELECT sqlite_version() AS version')
    return { applicationId, schemaVersion, sqliteVersion: version, counts: recordCounts(db) }
  } catch (error) {
    throw asFileError(error)
  } finally {
    db?.close()
  }
}

/**
 * The problems PRAGMA integrity_check reports; empty when it reports "ok". Damage can also make the check itself
 * fail: that failure is returned as the only problem. Any other failure (e.g. a closed connection) is thrown.
 */
export function integrityProblems(db: Db): string[] {
  try {
    const messages = db
      .all<{ integrity_check: string }>('PRAGMA integrity_check')
      .map((row) => row.integrity_check)
    return messages.length === 1 && messages[0] === 'ok' ? [] : messages
  } catch (error) {
    if (isDamage(error)) return [(error as Error).message]
    throw error
  }
}

export interface ForeignKeyViolation {
  /** The table holding the row whose parent row is missing. */
  readonly table: string
  readonly rowid: number | null
  /** The table the missing parent row belongs to. */
  readonly parent: string
}

/** PRAGMA foreign_key_check: every row whose parent row is missing. */
export function foreignKeyViolations(db: Db): ForeignKeyViolation[] {
  return db
    .all<ForeignKeyViolation>('PRAGMA foreign_key_check')
    .map(({ table, rowid, parent }) => ({ table, rowid, parent }))
}

/** The number of products, customers and invoices (null for a table the database does not have). */
export function recordCounts(db: Db): RecordCounts {
  return {
    products: countRows(db, 'products'),
    customers: countRows(db, 'customers'),
    invoices: countRows(db, 'invoices')
  }
}

/** `table` is one of the fixed names above, never input. */
function countRows(db: Db, table: 'products' | 'customers' | 'invoices'): number | null {
  const exists = db.get("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ?", [
    table
  ])
  if (exists === undefined) return null
  const [{ n }] = db.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)
  return n
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function isDamage(error: unknown): boolean {
  const code = sqliteErrorCode(error)
  return code !== undefined && (code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT'))
}

function asFileError(error: unknown): DatabaseFileError {
  if (error instanceof DatabaseFileError) return error
  const code = sqliteErrorCode(error)
  if (code === 'SQLITE_NOTADB') {
    return new DatabaseFileError('NOT_SQLITE', 'The file is not a SQLite database.', {
      cause: error
    })
  }
  if (isDamage(error)) {
    return new DatabaseFileError('INTEGRITY_CHECK_FAILED', 'The database file is damaged.', {
      cause: error
    })
  }
  return new DatabaseFileError('UNREADABLE', 'The file could not be read as a database.', {
    cause: error
  })
}
