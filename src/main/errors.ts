import type { AppError } from '@shared/types/result'

/**
 * Thrown by main-process services for an expected failure that the renderer receives as-is (for example
 * NOT_FOUND). Anything else thrown becomes INTERNAL or DB_ERROR at the IPC boundary.
 */
export class AppFailure extends Error {
  readonly error: AppError

  constructor(error: AppError) {
    super(error.message)
    this.name = 'AppFailure'
    this.error = error
  }
}
