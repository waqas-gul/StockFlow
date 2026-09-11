import { DomainError } from './errors'

/** Largest supported number of currency decimal places. */
export const MAX_MINOR_DIGITS = 4

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)

export function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${label} must be a whole number within the safe range (received ${String(value)}).`
    )
  }
}

export function assertNonNegativeInteger(value: number, label: string): void {
  assertSafeInteger(value, label)
  if (value < 0) {
    throw new DomainError('INVALID_ARGUMENT', `${label} must not be negative (received ${value}).`)
  }
}

export function assertPositiveInteger(value: number, label: string): void {
  assertSafeInteger(value, label)
  if (value < 1) {
    throw new DomainError('INVALID_ARGUMENT', `${label} must be at least 1 (received ${value}).`)
  }
}

export function assertMinorDigits(minorDigits: number): void {
  if (!Number.isInteger(minorDigits) || minorDigits < 0 || minorDigits > MAX_MINOR_DIGITS) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `minorDigits must be a whole number from 0 to ${MAX_MINOR_DIGITS} (received ${String(minorDigits)}).`
    )
  }
}

/** Converts a BigInt result back to a number, throwing OUT_OF_RANGE if it is not a safe integer. */
export function toSafeNumber(value: bigint, label: string): number {
  if (value > MAX_SAFE || value < MIN_SAFE) {
    throw new DomainError('OUT_OF_RANGE', `${label} is too large to represent exactly.`)
  }
  return Number(value)
}

/**
 * Adds safe integers, throwing OUT_OF_RANGE instead of silently losing precision. Checking each step is
 * enough: the exact sum of two safe integers is below 2^54, so a sum past the safe range always lands on a
 * float of at least 2^53, which `Number.isSafeInteger` rejects.
 */
export function sumSafeIntegers(values: readonly number[], label: string): number {
  let total = 0
  for (const value of values) {
    assertSafeInteger(value, label)
    total += value
    if (!Number.isSafeInteger(total)) {
      throw new DomainError('OUT_OF_RANGE', `${label} total is too large to represent exactly.`)
    }
  }
  return total
}
