import type { z } from 'zod'
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

/** Zod issues as form field errors, keyed by input path (e.g. `lines.0.quantity`); whole-input issues go under `root`. */
export function fieldErrorsOf(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {}
  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? 'root' : issue.path.map(String).join('.')
    ;(fieldErrors[key] ??= []).push(issue.message)
  }
  return fieldErrors
}
