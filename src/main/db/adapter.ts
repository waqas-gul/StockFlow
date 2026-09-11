import Database from 'better-sqlite3'
import type { DatabaseDriver } from '@shared/types/app-info'

/** A value SQLite stores and returns. Booleans are not SQLite values: the schema stores 0/1 integers. */
export type SqlValue = number | bigint | string | null

/** Positional (`?`) or named (`@name`) statement parameters. */
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>

export interface RunResult {
  /** Rows inserted, updated or deleted by the statement. */
  readonly changes: number
  /** Rowid of the most recent INSERT on this connection. */
  readonly lastInsertRowid: number | bigint
}

/**
 * The only way the main process talks to SQLite. Services depend on this interface and never import the driver,
 * so the driver can be swapped (e.g. for node:sqlite) in this one file.
 *
 * Synchronous by design: the main process owns the single connection, so statements never interleave.
 */
export interface Db {
  readonly driver: DatabaseDriver
  readonly isOpen: boolean
  readonly inTransaction: boolean
  /** Runs one statement that returns no rows (INSERT, UPDATE, DELETE, DDL). */
  run(sql: string, params?: SqlParams): RunResult
  /** The first row of a query, or undefined. The row type is the caller's claim; it is not checked. */
  get<Row = unknown>(sql: string, params?: SqlParams): Row | undefined
  /** Every row of a query. */
  all<Row = unknown>(sql: string, params?: SqlParams): Row[]
  /** Runs a script of one or more statements without parameters (migrations, pragmas). */
  exec(sql: string): void
  /**
   * Runs `fn` between BEGIN IMMEDIATE and COMMIT, so the write lock is held from the start. If `fn` throws, or
   * COMMIT fails, everything is rolled back and the error is rethrown. `fn` must be synchronous, and
   * transactions cannot be nested.
   */
  transaction<T>(fn: () => T): T
  /** Writes a consistent online copy (including WAL content) to `destinationFile`. Its folder must exist. */
  backup(destinationFile: string): Promise<void>
  /** Closes the connection, checkpointing the WAL. Safe to call more than once. */
  close(): void
}

export interface OpenOptions {
  /** Open without write access. The file must already exist. */
  readonly readonly?: boolean
}

/** Opens a SQLite file with the selected driver and no StockFlow configuration (see connection.ts). */
export function openSqlite(file: string, options: OpenOptions = {}): Db {
  const readonly = options.readonly === true
  return new BetterSqlite3Db(new Database(file, { readonly, fileMustExist: readonly }))
}

/** The SQLite result code of a driver error (e.g. `SQLITE_CONSTRAINT_UNIQUE`); undefined for other errors. */
export function sqliteErrorCode(error: unknown): string | undefined {
  return error instanceof Database.SqliteError ? error.code : undefined
}

class BetterSqlite3Db implements Db {
  readonly driver = 'better-sqlite3'
  readonly #native: Database.Database

  constructor(native: Database.Database) {
    this.#native = native
  }

  get isOpen(): boolean {
    return this.#native.open
  }

  get inTransaction(): boolean {
    return this.#native.inTransaction
  }

  run(sql: string, params?: SqlParams): RunResult {
    const { changes, lastInsertRowid } = this.#native.prepare(sql).run(...toArgs(params))
    return { changes, lastInsertRowid }
  }

  get<Row = unknown>(sql: string, params?: SqlParams): Row | undefined {
    return this.#native.prepare(sql).get(...toArgs(params)) as Row | undefined
  }

  all<Row = unknown>(sql: string, params?: SqlParams): Row[] {
    return this.#native.prepare(sql).all(...toArgs(params)) as Row[]
  }

  exec(sql: string): void {
    this.#native.exec(sql)
  }

  transaction<T>(fn: () => T): T {
    if (this.#native.inTransaction) {
      throw new Error('A transaction is already open. Nested transactions are not supported.')
    }
    this.#native.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      if (isPromiseLike(result)) {
        // Whatever the callback does after its first await would run outside the transaction.
        Promise.resolve(result).catch(() => undefined)
        throw new Error('Transaction callbacks must be synchronous.')
      }
      this.#native.exec('COMMIT')
      return result
    } catch (error) {
      // SQLite may already have rolled back (e.g. on SQLITE_FULL); a second ROLLBACK would fail.
      if (this.#native.inTransaction) this.#native.exec('ROLLBACK')
      throw error
    }
  }

  async backup(destinationFile: string): Promise<void> {
    await this.#native.backup(destinationFile)
  }

  close(): void {
    if (this.#native.open) this.#native.close()
  }
}

function toArgs(params: SqlParams | undefined): unknown[] {
  if (params === undefined) return []
  return Array.isArray(params) ? [...params] : [params]
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
