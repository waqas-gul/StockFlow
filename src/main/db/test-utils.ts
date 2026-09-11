// Test-only helpers for the database tests. Excluded from coverage and never imported by application code.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Db } from './adapter'

export interface TempDir {
  readonly path: string
  file(name: string): string
  /** Closes every tracked database, then deletes the directory (Windows cannot delete open files). */
  remove(): void
  /** Registers a database to be closed by `remove()`. */
  track<T extends Db>(db: T): T
}

/** A fresh folder under the OS temp directory. Tests never touch %APPDATA%\StockFlow or StockFlow-dev. */
export function createTempDir(): TempDir {
  const path = mkdtempSync(join(tmpdir(), 'stockflow-test-'))
  const opened: Db[] = []
  return {
    path,
    file: (name) => join(path, name),
    track: (db) => {
      opened.push(db)
      return db
    },
    remove: () => {
      for (const db of opened.splice(0)) db.close()
      rmSync(path, { recursive: true, force: true })
    }
  }
}

/** The error thrown by `fn`. Fails the test if nothing is thrown. */
export function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('Expected the function to throw.')
}
