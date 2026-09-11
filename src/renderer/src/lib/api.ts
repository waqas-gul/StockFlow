import type { AppError, AppErrorCode, Result } from '@shared/types/result'

/** The AppError of a failed `window.api` call, thrown so TanStack Query and forms can handle it. */
export class ApiError extends Error {
  readonly code: AppErrorCode
  readonly fieldErrors?: AppError['fieldErrors']
  readonly details?: unknown
  readonly ref?: string

  constructor(error: AppError) {
    super(error.message)
    this.name = 'ApiError'
    this.code = error.code
    this.fieldErrors = error.fieldErrors
    this.details = error.details
    this.ref = error.ref
  }
}

/**
 * The data of a `window.api` call, or its AppError thrown as an ApiError. If the IPC itself failed and no
 * Result arrived, an INTERNAL ApiError is thrown instead; the raw message is not shown.
 */
export async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  let result: Result<T>
  try {
    result = await call
  } catch {
    throw new ApiError({ code: 'INTERNAL', message: 'The request could not be completed.' })
  }
  if (result.ok) return result.data
  throw new ApiError(result.error)
}
