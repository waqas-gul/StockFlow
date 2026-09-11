import { DomainError } from './errors'
import {
  assertMinorDigits,
  assertNonNegativeInteger,
  assertSafeInteger,
  sumSafeIntegers,
  toSafeNumber
} from './guards'

export { MAX_MINOR_DIGITS } from './guards'

/**
 * Money is always an integer count of minor units (paisa for PKR: Rs 1.00 = 100). Floating-point rupee
 * values are never stored or used in arithmetic; they only ever exist as display text.
 */
export type MinorUnits = number

/** Percentages as integer basis points: 100 bps = 1%, 10 000 bps = 100%. */
export type BasisPoints = number

/** Basis points in 100%. */
export const BPS_PER_WHOLE = 10_000

export type DecimalParseError =
  'EMPTY' | 'INVALID_FORMAT' | 'TOO_MANY_DECIMALS' | 'NEGATIVE_NOT_ALLOWED' | 'OUT_OF_RANGE'

/** Outcome of parsing user-typed text. Invalid text is expected, so it is returned rather than thrown. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DecimalParseError }

/** Grouping of the whole part: 1,234,567 (international), 12,34,567 (South Asian) or 1234567 (none). */
export type DigitGrouping = 'international' | 'south-asian' | 'none'

export interface ParseMoneyOptions {
  /** Decimal places of the currency (PKR: 2). Input with more decimals is rejected, never rounded. */
  readonly minorDigits: number
  /** Accept a leading minus sign. Default `false`: amounts typed into forms are never negative. */
  readonly allowNegative?: boolean
}

export interface ParsePercentOptions {
  /** Upper limit in basis points. Default 10 000 (100%). */
  readonly maxBps?: BasisPoints
}

export interface FormatMoneyOptions {
  readonly minorDigits: number
  /** Default `'international'`. */
  readonly grouping?: DigitGrouping
  /** Text placed before the digits, e.g. `'Rs '`. A minus sign goes before it. Default `''`. */
  readonly prefix?: string
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)

/**
 * Accepted text: an optional minus sign, a whole part, and an optional fraction with at least one digit.
 * The whole part is plain digits, or comma-grouped in the international (1,234,567) or South Asian
 * (12,34,567) style. Everything else is rejected: letters, currency symbols, inner spaces, '+', exponents,
 * '.5', '5.', misplaced commas ('1,2,3', '12,34') and non-ASCII digits.
 */
const DECIMAL_PATTERN = /^(-?)(\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})(?:\.(\d+))?$/

/** Parses a decimal string into an integer scaled by 10^scaleDigits, using no floating-point steps. */
function parseScaledDecimal(
  input: string,
  scaleDigits: number,
  allowNegative: boolean
): ParseResult<number> {
  const text = input.trim()
  if (text === '') return { ok: false, error: 'EMPTY' }

  const match = DECIMAL_PATTERN.exec(text)
  if (!match) return { ok: false, error: 'INVALID_FORMAT' }

  const negative = match[1] === '-'
  const fraction = match[3] ?? ''
  if (negative && !allowNegative) return { ok: false, error: 'NEGATIVE_NOT_ALLOWED' }
  if (fraction.length > scaleDigits) return { ok: false, error: 'TOO_MANY_DECIMALS' }

  const magnitude = BigInt(match[2].replaceAll(',', '') + fraction.padEnd(scaleDigits, '0'))
  const value = negative ? -magnitude : magnitude
  if (value > MAX_SAFE || value < MIN_SAFE) return { ok: false, error: 'OUT_OF_RANGE' }
  return { ok: true, value: Number(value) }
}

/**
 * Parses a user-typed amount into integer minor units: "1,250.50" → 125050 (with 2 minor digits).
 * Extra decimal places are an error (TOO_MANY_DECIMALS), never silently rounded. An empty field is EMPTY;
 * callers with optional fields check for blank input themselves.
 */
export function parseMoney(input: string, options: ParseMoneyOptions): ParseResult<MinorUnits> {
  assertMinorDigits(options.minorDigits)
  return parseScaledDecimal(input, options.minorDigits, options.allowNegative ?? false)
}

/** Parses a percentage such as "12.5" or "12.5%" into basis points (1250). At most 2 decimals. */
export function parsePercentToBps(
  input: string,
  options: ParsePercentOptions = {}
): ParseResult<BasisPoints> {
  const maxBps = options.maxBps ?? BPS_PER_WHOLE
  assertNonNegativeInteger(maxBps, 'maxBps')
  const text = input.trim()
  const number = text.endsWith('%') ? text.slice(0, -1).trimEnd() : text
  const result = parseScaledDecimal(number, 2, false)
  if (result.ok && result.value > maxBps) return { ok: false, error: 'OUT_OF_RANGE' }
  return result
}

function groupDigits(whole: string, grouping: DigitGrouping): string {
  if (grouping === 'none' || whole.length <= 3) return whole
  if (grouping === 'international') return whole.replace(/\B(?=(\d{3})+$)/g, ',')
  const head = whole.slice(0, -3).replace(/\B(?=(\d{2})+$)/g, ',')
  return `${head},${whole.slice(-3)}`
}

/**
 * Formats minor units for display: 125050 → "1,250.50". Deterministic string arithmetic, not
 * `Intl`, so the main process and the renderer always produce the same text.
 */
export function formatMoney(amount: MinorUnits, options: FormatMoneyOptions): string {
  assertSafeInteger(amount, 'Amount')
  assertMinorDigits(options.minorDigits)
  const { minorDigits, grouping = 'international', prefix = '' } = options

  const digits = String(Math.abs(amount)).padStart(minorDigits + 1, '0')
  const whole = digits.slice(0, digits.length - minorDigits)
  const fraction = minorDigits > 0 ? `.${digits.slice(digits.length - minorDigits)}` : ''
  const sign = amount < 0 ? '-' : ''
  return `${sign}${prefix}${groupDigits(whole, grouping)}${fraction}`
}

/** a + b, throwing OUT_OF_RANGE on overflow. */
export function addMinor(a: MinorUnits, b: MinorUnits): MinorUnits {
  return sumSafeIntegers([a, b], 'Amount')
}

/** a − b, throwing OUT_OF_RANGE on overflow. */
export function subtractMinor(a: MinorUnits, b: MinorUnits): MinorUnits {
  assertSafeInteger(a, 'Amount')
  assertSafeInteger(b, 'Amount')
  return toSafeNumber(BigInt(a) - BigInt(b), 'Difference')
}

/** Σ amounts (0 for an empty list), throwing OUT_OF_RANGE on overflow. */
export function sumMinor(amounts: readonly MinorUnits[]): MinorUnits {
  return sumSafeIntegers(amounts, 'Amount')
}

/** amount × integer factor (e.g. unit price × quantity), exact via BigInt. */
export function multiplyMinor(amount: MinorUnits, factor: number): MinorUnits {
  assertSafeInteger(amount, 'Amount')
  assertSafeInteger(factor, 'Factor')
  return toSafeNumber(BigInt(amount) * BigInt(factor), 'Product')
}

/**
 * Integer division rounded half away from zero. For the non-negative amounts the application stores this
 * is ordinary half-up rounding: 2.5 → 3, 2.4999 → 2. Negative results are symmetric: −2.5 → −3.
 */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new DomainError('INVALID_ARGUMENT', 'Cannot divide by zero.')
  const sign = numerator < 0n !== denominator < 0n ? -1n : 1n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  return sign * ((2n * n + d) / (2n * d))
}

/**
 * round_half_up(a × b ÷ divisor) with a BigInt intermediate, so a × b may exceed Number.MAX_SAFE_INTEGER
 * without losing precision. Only the final result must be a safe integer.
 */
export function mulDivRoundHalfUp(a: number, b: number, divisor: number): number {
  assertSafeInteger(a, 'Multiplicand')
  assertSafeInteger(b, 'Multiplier')
  assertSafeInteger(divisor, 'Divisor')
  return toSafeNumber(divideRoundHalfUp(BigInt(a) * BigInt(b), BigInt(divisor)), 'Result')
}

/** The given share of an amount: round_half_up(amount × bps ÷ 10 000). 500 bps of 1,999 → 100 (99.95). */
export function basisPointsOf(amount: MinorUnits, bps: BasisPoints): MinorUnits {
  assertSafeInteger(amount, 'Amount')
  assertNonNegativeInteger(bps, 'Basis points')
  return mulDivRoundHalfUp(amount, bps, BPS_PER_WHOLE)
}
