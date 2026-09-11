/** Why a domain calculation refused its input. */
export type DomainErrorCode =
  'INVALID_ARGUMENT' | 'OUT_OF_RANGE' | 'DEDUCTION_EXCEEDS_BASE' | 'INSUFFICIENT_STOCK'

/**
 * Thrown by the pure domain calculators when their input breaks a rule: a non-integer amount, an overflow, a
 * discount larger than the amount it applies to, and so on.
 *
 * Parsers of user-typed text do not throw; invalid text is an expected outcome, so they return a result
 * instead. Later phases map this error to a VALIDATION error at the IPC boundary.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode

  constructor(code: DomainErrorCode, message: string) {
    super(message)
    this.name = 'DomainError'
    this.code = code
  }
}
