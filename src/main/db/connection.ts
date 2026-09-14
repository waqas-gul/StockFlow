import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openSqlite, sqliteErrorCode, type Db, type SqlValue } from './adapter'

/**
 * Permanent SQLite `application_id` of every StockFlow database: the ASCII bytes "STFL" (0x5354464C =
 * 1398031948). It is a positive signed 32-bit integer and is not in SQLite's registry of assigned ids
 * (magic.txt). It marks a file as ours, so any other .db file is refused.
 *
 * Never change it: every existing StockFlow database and backup carries this value.
 */
export const STOCKFLOW_APPLICATION_ID = 0x5354464c

/** The settings every StockFlow connection must run with, as their PRAGMA read-back values. */
export const CONNECTION_PRAGMAS = Object.freeze({
  /** ON: foreign keys are enforced. */
  foreign_keys: 1,
  /** Write-ahead log. */
  journal_mode: 'wal',
  /** FULL (2): every commit is flushed to disk. */
  synchronous: 2,
  /** Wait up to 5 seconds for a lock before failing with SQLITE_BUSY. */
  busy_timeout: 5000,
  /**
   * ON: when INSERT OR REPLACE removes a conflicting row, that table's DELETE triggers fire. Without it, REPLACE
   * would silently bypass the append-only triggers of the ledgers.
   */
  recursive_triggers: 1
})

export type ConnectionPragma = keyof typeof CONNECTION_PRAGMAS

export type DatabaseOpenErrorCode = 'CONFIGURATION_FAILED' | 'NOT_STOCKFLOW_DATABASE'

export class DatabaseOpenError extends Error {
  readonly code: DatabaseOpenErrorCode

  constructor(code: DatabaseOpenErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DatabaseOpenError'
    this.code = code
  }
}

/**
 * Opens the StockFlow database at `file`, creating the folder and file if needed. It applies the connection
 * pragmas and reads them back, then checks that the file is a StockFlow database; a new, empty file is stamped
 * with STOCKFLOW_APPLICATION_ID. On any failure the connection is closed and the error thrown.
 */
export function openDatabase(file: string): Db {
  mkdirSync(dirname(file), { recursive: true })
  const db = openSqlite(file)
  try {
    applyConnectionPragmas(db)
    claimOrVerifyApplicationId(db, file)
    return db
  } catch (error) {
    db.close()
    if (sqliteErrorCode(error) === 'SQLITE_NOTADB') {
      throw new DatabaseOpenError(
        'NOT_STOCKFLOW_DATABASE',
        `${file} is not a StockFlow database.`,
        {
          cause: error
        }
      )
    }
    throw error
  }
}

/** The current values of the connection pragmas. */
export function readConnectionPragmas(db: Db): Record<ConnectionPragma, SqlValue> {
  return {
    foreign_keys: pragma(db, 'foreign_keys'),
    journal_mode: pragma(db, 'journal_mode'),
    synchronous: pragma(db, 'synchronous'),
    busy_timeout: pragma(db, 'busy_timeout'),
    recursive_triggers: pragma(db, 'recursive_triggers')
  }
}

export function readApplicationId(db: Db): number {
  return Number(pragma(db, 'application_id'))
}

/** The schema version (`PRAGMA user_version`); 0 for a new database. */
export function readUserVersion(db: Db): number {
  return Number(pragma(db, 'user_version'))
}

/** True for a database with no tables, indexes, views or triggers, still at schema version 0. */
export function isEmptyDatabase(db: Db): boolean {
  const objects = db.get<{ n: number }>('SELECT count(*) AS n FROM sqlite_schema')?.n
  return objects === 0 && readUserVersion(db) === 0
}

function applyConnectionPragmas(db: Db): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`PRAGMA busy_timeout = ${CONNECTION_PRAGMAS.busy_timeout}`)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA recursive_triggers = ON')

  const actual = readConnectionPragmas(db)
  for (const [name, expected] of Object.entries(CONNECTION_PRAGMAS)) {
    const value = actual[name as ConnectionPragma]
    if (value !== expected) {
      throw new DatabaseOpenError(
        'CONFIGURATION_FAILED',
        `PRAGMA ${name} is ${JSON.stringify(value)} but must be ${JSON.stringify(expected)}.`
      )
    }
  }
}

function claimOrVerifyApplicationId(db: Db, file: string): void {
  const id = readApplicationId(db)
  if (id === STOCKFLOW_APPLICATION_ID) return
  if (id === 0 && isEmptyDatabase(db)) {
    db.exec(`PRAGMA application_id = ${STOCKFLOW_APPLICATION_ID}`)
    return
  }
  throw new DatabaseOpenError(
    'NOT_STOCKFLOW_DATABASE',
    `${file} is not a StockFlow database (application_id ${id}).`
  )
}

type PragmaName = ConnectionPragma | 'application_id' | 'user_version'

/** Reads a single-value PRAGMA. `name` is always one of the fixed names above, never user input. */
function pragma(db: Db, name: PragmaName): SqlValue {
  const [row] = db.all<Record<string, SqlValue>>(`PRAGMA ${name}`)
  return Object.values(row)[0]
}
