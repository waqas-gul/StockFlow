import type { Db } from '../db/adapter'
import { AppFailure } from '../errors'

export type LiveDatabaseState = 'OPEN' | 'RESTORING' | 'RESTARTING' | 'CLOSED'

/**
 * The app's database connection as the IPC handlers and the automatic backups reach it. While a restore runs, the
 * restore engine owns (and closes) the connection, and after a restore StockFlow restarts: in both cases every
 * request is refused with a user-safe FORBIDDEN_STATE failure, never run against a closed or uncertain database.
 */
export class LiveDatabase {
  #db: Db | null
  #state: LiveDatabaseState = 'OPEN'

  constructor(db: Db) {
    this.#db = db
  }

  get state(): LiveDatabaseState {
    return this.#state
  }

  /** The open connection. Throws FORBIDDEN_STATE while a restore runs, and once StockFlow restarts or closes. */
  get(): Db {
    if (this.#state === 'RESTORING') {
      throw unavailable('A restore is in progress. Wait until it is finished.')
    }
    if (this.#state === 'RESTARTING') throw unavailable('StockFlow is restarting.')
    if (this.#state === 'CLOSED' || this.#db === null) throw unavailable('StockFlow is closing.')
    return this.#db
  }

  /** Hands the connection to the restore engine. Requests are refused until the restore has ended. */
  beginRestore(): Db {
    const db = this.get()
    this.#state = 'RESTORING'
    return db
  }

  /** The restore changed nothing: requests continue on this connection (the one the restore engine returned). */
  continueWith(db: Db): void {
    this.#db = db
    this.#state = 'OPEN'
  }

  /** StockFlow restarts: `db` (the restored or the previous database) and the old connection are closed. */
  restart(db: Db | null): void {
    db?.close()
    this.#db?.close()
    this.#db = null
    this.#state = 'RESTARTING'
  }

  /** At quit: closes the connection, which checkpoints the WAL into shop.db. */
  close(): void {
    this.#db?.close()
    this.#db = null
    if (this.#state !== 'RESTARTING') this.#state = 'CLOSED'
  }
}

function unavailable(message: string): AppFailure {
  return new AppFailure({ code: 'FORBIDDEN_STATE', message })
}
