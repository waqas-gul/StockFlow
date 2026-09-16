/**
 * Error codes the main process returns to the renderer, which switches on `code`. The business codes
 * (stock, prices, posting dates) are produced by the services of later phases.
 *
 * - BACKUP_FAILED: a manual backup was not made (nothing was written or replaced).
 * - RESTORE_REJECTED: the chosen backup cannot be restored, or the confirmation is no longer valid.
 * - RESTORE_FAILED: the restore stopped before it changed anything; StockFlow keeps running on the current data.
 * - FORBIDDEN_STATE also covers a backup or restore that is already running, and a restart in progress.
 * - SETTING_LOCKED: a setting that can no longer change (currency decimal places once financial data exists).
 * - UNIT_LOCKED: a product unit change that stock history forbids (base quantity, base unit, removing a unit).
 * - DUPLICATE: a name or code that is already used (company name, product code).
 */
export type AppErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'PRICE_CHANGED'
  | 'DUPLICATE'
  | 'FORBIDDEN_STATE'
  | 'DATE_NOT_ALLOWED'
  | 'FORBIDDEN'
  | 'BACKUP_FAILED'
  | 'RESTORE_REJECTED'
  | 'RESTORE_FAILED'
  | 'SETTING_LOCKED'
  | 'UNIT_LOCKED'
  | 'DB_ERROR'
  | 'INTERNAL'

/** A failure the renderer can show and act on. It never carries a stack trace. */
export interface AppError {
  readonly code: AppErrorCode
  /** Safe to show to the user. */
  readonly message: string
  /** Validation messages per input path (e.g. `lines.0.quantity`), for form fields. */
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>
  /** Structured, user-safe details (e.g. required/available stock per product). */
  readonly details?: unknown
  /** Short reference to the full error logged by the main process (unexpected errors only). */
  readonly ref?: string
}

/** The outcome of every IPC call. Handlers never throw across IPC; they return one of these. */
export type Result<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: AppError }

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function fail(error: AppError): Result<never> {
  return { ok: false, error }
}
