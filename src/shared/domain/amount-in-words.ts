import { DomainError } from './errors'
import { assertMinorDigits, assertNonNegativeInteger } from './guards'
import type { MinorUnits } from './money'

/**
 * Amount in words for printing (plan E2). It receives an amount and knows nothing about invoices: which
 * total is written in words is still a business decision (B6). The defaults, Pakistani rupees and paisa
 * in lakh/crore numbering, are provisional until E2 is confirmed, and every label can be configured.
 */

export type NumberingSystem = 'south-asian' | 'international'

export interface UnitLabel {
  readonly singular: string
  readonly plural: string
}

export interface AmountInWordsOptions {
  /** Decimal places of the currency. Default 2. */
  readonly minorDigits?: number
  /** 'south-asian' (thousand, lakh, crore) or 'international' (thousand, million, billion). Default 'south-asian'. */
  readonly numbering?: NumberingSystem
  /** Default Rupee / Rupees. */
  readonly majorUnit?: UnitLabel
  /** Default Paisa / Paisa. */
  readonly minorUnit?: UnitLabel
  /** Text appended at the end. Default 'Only'; '' omits it. */
  readonly suffix?: string
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen'
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

const INTERNATIONAL_SCALES: readonly (readonly [number, string])[] = [
  [1e15, 'Quadrillion'],
  [1e12, 'Trillion'],
  [1e9, 'Billion'],
  [1e6, 'Million'],
  [1e3, 'Thousand']
]

/**
 * Quotient and remainder without floating-point rounding. `n % d` is exact for safe integers, and so is
 * the division of the exact multiple `n − r`. By contrast, `Math.floor(n / d)` can round up for very large n.
 */
function divMod(n: number, d: number): [number, number] {
  const remainder = n % d
  return [(n - remainder) / d, remainder]
}

function underHundred(n: number): string {
  if (n < 20) return ONES[n]
  const [tens, ones] = divMod(n, 10)
  return ones === 0 ? TENS[tens] : `${TENS[tens]} ${ONES[ones]}`
}

function underThousand(n: number): string[] {
  const [hundreds, rest] = divMod(n, 100)
  const words: string[] = []
  if (hundreds > 0) words.push(ONES[hundreds], 'Hundred')
  if (rest > 0) words.push(underHundred(rest))
  return words
}

/** Lakh = 1,00,000; crore = 1,00,00,000. Beyond that the crore count is itself spelled out (e.g. "One Lakh Crore"). */
function southAsianWords(n: number): string[] {
  const words: string[] = []
  const [crores, belowCrore] = divMod(n, 10_000_000)
  if (crores > 0) words.push(...southAsianWords(crores), 'Crore')
  const [lakhs, belowLakh] = divMod(belowCrore, 100_000)
  if (lakhs > 0) words.push(underHundred(lakhs), 'Lakh')
  const [thousands, rest] = divMod(belowLakh, 1000)
  if (thousands > 0) words.push(underHundred(thousands), 'Thousand')
  words.push(...underThousand(rest))
  return words
}

function internationalWords(n: number): string[] {
  const words: string[] = []
  let rest = n
  for (const [scale, name] of INTERNATIONAL_SCALES) {
    const [count, remainder] = divMod(rest, scale)
    if (count > 0) words.push(...underThousand(count), name)
    rest = remainder
  }
  words.push(...underThousand(rest))
  return words
}

/** A whole number in words, e.g. 125050 → "One Lakh Twenty Five Thousand Fifty". */
export function integerToWords(value: number, numbering: NumberingSystem = 'south-asian'): string {
  assertNonNegativeInteger(value, 'Value')
  if (numbering !== 'south-asian' && numbering !== 'international') {
    throw new DomainError('INVALID_ARGUMENT', `Unknown numbering system "${String(numbering)}".`)
  }
  if (value === 0) return 'Zero'
  return (numbering === 'international' ? internationalWords(value) : southAsianWords(value)).join(
    ' '
  )
}

function withLabel(count: number, words: string, label: UnitLabel): string {
  const text = count === 1 ? label.singular : label.plural
  return text ? `${words} ${text}` : words
}

/**
 * An amount of minor units in words, e.g. 125050 → "One Thousand Two Hundred Fifty Rupees and Fifty
 * Paisa Only". A zero major part is left out when there are minor units ("Fifty Paisa Only"); zero is
 * "Zero Rupees Only". Amounts must not be negative.
 */
export function amountInWords(amountMinor: MinorUnits, options: AmountInWordsOptions = {}): string {
  const {
    minorDigits = 2,
    numbering = 'south-asian',
    majorUnit = { singular: 'Rupee', plural: 'Rupees' },
    minorUnit = { singular: 'Paisa', plural: 'Paisa' },
    suffix = 'Only'
  } = options
  assertMinorDigits(minorDigits)
  assertNonNegativeInteger(amountMinor, 'Amount')

  const [major, minor] = divMod(amountMinor, 10 ** minorDigits)
  const parts: string[] = []
  if (major > 0 || minor === 0)
    parts.push(withLabel(major, integerToWords(major, numbering), majorUnit))
  if (minor > 0) parts.push(withLabel(minor, integerToWords(minor, numbering), minorUnit))
  const text = parts.join(' and ')
  return suffix ? `${text} ${suffix}` : text
}
