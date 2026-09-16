import { AppFailure } from '../errors'

/** The data-safety operations that must never overlap. A restore also covers choosing and validating its backup. */
export type DataSafetyOperation = 'MANUAL_BACKUP' | 'AUTOMATIC_BACKUP' | 'RESTORE'

const BUSY_MESSAGES: Readonly<Record<DataSafetyOperation, string>> = {
  MANUAL_BACKUP: 'A backup is already being made. Wait until it is finished.',
  AUTOMATIC_BACKUP: 'An automatic backup is being made. Try again in a moment.',
  RESTORE: 'A restore is in progress. Wait until it is finished.'
}

/**
 * Runs one data-safety operation at a time: two backups, or a backup and a restore, never overlap (the engine's
 * steps are asynchronous). A second request is refused at once, which also stops a double click from starting an
 * operation twice; nothing waits in a queue.
 */
export class OperationLock {
  #current: DataSafetyOperation | null = null
  #waiting: Array<() => void> = []

  /** The operation running now, or null. */
  get current(): DataSafetyOperation | null {
    return this.#current
  }

  /** Throws FORBIDDEN_STATE, with a user-safe message, while an operation runs. */
  assertIdle(): void {
    if (this.#current !== null) {
      throw new AppFailure({ code: 'FORBIDDEN_STATE', message: BUSY_MESSAGES[this.#current] })
    }
  }

  /** Runs `task` as `operation`; refused at once (FORBIDDEN_STATE) while another operation runs. */
  async run<T>(operation: DataSafetyOperation, task: () => Promise<T>): Promise<T> {
    this.assertIdle()
    this.#current = operation
    try {
      return await task()
    } finally {
      this.#current = null
      for (const resolve of this.#waiting.splice(0)) resolve()
    }
  }

  /** Resolves once no operation is running. */
  whenIdle(): Promise<void> {
    if (this.#current === null) return Promise.resolve()
    return new Promise((resolve) => this.#waiting.push(resolve))
  }
}
