import { describe, expect, it } from 'vitest'
import {
  addMinor,
  basisPointsOf,
  divideRoundHalfUp,
  formatMoney,
  mulDivRoundHalfUp,
  multiplyMinor,
  parseMoney,
  parsePercentToBps,
  subtractMinor,
  sumMinor,
  type DigitGrouping
} from './money'
import { createRandom, thrownCode } from './test-utils'

const MAX = Number.MAX_SAFE_INTEGER
const PKR = { minorDigits: 2 }
const SIGNED = { minorDigits: 2, allowNegative: true }

describe('parseMoney', () => {
  it.each<[string, number]>([
    ['0', 0],
    ['1', 100],
    ['1.5', 150],
    ['1.50', 150],
    ['1,250.50', 125050],
    ['0.01', 1],
    ['0.10', 10],
    ['007', 700],
    ['  42  ', 4200],
    ['1000', 100000],
    ['1,234,567.89', 123456789],
    ['12,34,567.89', 123456789],
    ['1,25,050.50', 12505050],
    ['1,00,000', 10000000],
    ['90071992547409.91', MAX]
  ])('parses "%s" as %i minor units', (input, expected) => {
    expect(parseMoney(input, PKR)).toEqual({ ok: true, value: expected })
  })

  it.each([
    'abc',
    '1.2.3',
    '1,2,3',
    '1,2345',
    '12,34',
    ',123',
    '123,',
    '1,,000',
    '1..2',
    '.5',
    '5.',
    '+1',
    '1e3',
    'Rs 10',
    '1 000',
    '--1',
    '-',
    '0x10',
    'Infinity',
    'NaN',
    '١٢٣',
    '1,000.5.0',
    '1.5-'
  ])('rejects "%s" as INVALID_FORMAT', (input) => {
    expect(parseMoney(input, PKR)).toEqual({ ok: false, error: 'INVALID_FORMAT' })
  })

  it.each(['12.345', '0.001', '1,250.505'])(
    'rejects "%s" instead of rounding it (TOO_MANY_DECIMALS)',
    (input) => {
      expect(parseMoney(input, PKR)).toEqual({ ok: false, error: 'TOO_MANY_DECIMALS' })
    }
  )

  it.each(['', '   '])('rejects empty input "%s" (EMPTY)', (input) => {
    expect(parseMoney(input, PKR)).toEqual({ ok: false, error: 'EMPTY' })
  })

  it('rejects negative amounts unless they are allowed', () => {
    expect(parseMoney('-5', PKR)).toEqual({ ok: false, error: 'NEGATIVE_NOT_ALLOWED' })
    expect(parseMoney('-1,000', PKR)).toEqual({ ok: false, error: 'NEGATIVE_NOT_ALLOWED' })
    expect(parseMoney('-5', SIGNED)).toEqual({ ok: true, value: -500 })
    expect(parseMoney('-1,250.50', SIGNED)).toEqual({ ok: true, value: -125050 })
    expect(parseMoney('-0', SIGNED)).toEqual({ ok: true, value: 0 })
    expect(parseMoney('-90071992547409.91', SIGNED)).toEqual({ ok: true, value: -MAX })
  })

  it('honours the configured number of decimal places', () => {
    expect(parseMoney('12', { minorDigits: 0 })).toEqual({ ok: true, value: 12 })
    expect(parseMoney('1,234', { minorDigits: 0 })).toEqual({ ok: true, value: 1234 })
    expect(parseMoney('12.5', { minorDigits: 0 })).toEqual({
      ok: false,
      error: 'TOO_MANY_DECIMALS'
    })
    expect(parseMoney('12.0', { minorDigits: 0 })).toEqual({
      ok: false,
      error: 'TOO_MANY_DECIMALS'
    })
    expect(parseMoney('1.234', { minorDigits: 3 })).toEqual({ ok: true, value: 1234 })
    expect(parseMoney('1.5', { minorDigits: 3 })).toEqual({ ok: true, value: 1500 })
    expect(parseMoney('0.0001', { minorDigits: 4 })).toEqual({ ok: true, value: 1 })
  })

  it('rejects amounts beyond the exact integer range', () => {
    expect(parseMoney('90071992547409.92', PKR)).toEqual({ ok: false, error: 'OUT_OF_RANGE' })
    expect(parseMoney('99999999999999999999', PKR)).toEqual({ ok: false, error: 'OUT_OF_RANGE' })
    expect(parseMoney('-90071992547409.92', SIGNED)).toEqual({ ok: false, error: 'OUT_OF_RANGE' })
  })

  it.each([5, -1, 1.5, Number.NaN])(
    'treats minorDigits %s as a programming error',
    (minorDigits) => {
      expect(thrownCode(() => parseMoney('1', { minorDigits }))).toBe('INVALID_ARGUMENT')
    }
  )
})

describe('parsePercentToBps', () => {
  it.each<[string, number]>([
    ['0', 0],
    ['5', 500],
    ['12.5', 1250],
    ['12.5%', 1250],
    ['12.5 %', 1250],
    ['0.01', 1],
    ['100', 10000],
    ['100%', 10000]
  ])('parses "%s" as %i basis points', (input, expected) => {
    expect(parsePercentToBps(input)).toEqual({ ok: true, value: expected })
  })

  it('rejects invalid percentages', () => {
    expect(parsePercentToBps('100.01')).toEqual({ ok: false, error: 'OUT_OF_RANGE' })
    expect(parsePercentToBps('12.345')).toEqual({ ok: false, error: 'TOO_MANY_DECIMALS' })
    expect(parsePercentToBps('-1')).toEqual({ ok: false, error: 'NEGATIVE_NOT_ALLOWED' })
    expect(parsePercentToBps('')).toEqual({ ok: false, error: 'EMPTY' })
    expect(parsePercentToBps('%')).toEqual({ ok: false, error: 'EMPTY' })
    expect(parsePercentToBps('abc')).toEqual({ ok: false, error: 'INVALID_FORMAT' })
    expect(parsePercentToBps('1%%')).toEqual({ ok: false, error: 'INVALID_FORMAT' })
  })

  it('supports a custom upper limit', () => {
    expect(parsePercentToBps('150', { maxBps: 20000 })).toEqual({ ok: true, value: 15000 })
    expect(parsePercentToBps('50', { maxBps: 2500 })).toEqual({ ok: false, error: 'OUT_OF_RANGE' })
    expect(thrownCode(() => parsePercentToBps('5', { maxBps: -1 }))).toBe('INVALID_ARGUMENT')
  })
})

describe('formatMoney', () => {
  it.each<[number, string]>([
    [0, '0.00'],
    [1, '0.01'],
    [10, '0.10'],
    [150, '1.50'],
    [125050, '1,250.50'],
    [100000000, '1,000,000.00'],
    [-1, '-0.01'],
    [MAX, '90,071,992,547,409.91'],
    [-MAX, '-90,071,992,547,409.91']
  ])('formats %i as "%s"', (amount, expected) => {
    expect(formatMoney(amount, PKR)).toBe(expected)
  })

  it('groups digits in the South Asian style when asked', () => {
    const southAsian = { minorDigits: 2, grouping: 'south-asian' } as const
    expect(formatMoney(99999, southAsian)).toBe('999.99')
    expect(formatMoney(100000, southAsian)).toBe('1,000.00')
    expect(formatMoney(12505050, southAsian)).toBe('1,25,050.50')
    expect(formatMoney(1234567800, southAsian)).toBe('1,23,45,678.00')
    expect(formatMoney(MAX, southAsian)).toBe('9,00,71,99,25,47,409.91')
  })

  it('supports no grouping, a prefix and other precisions', () => {
    expect(formatMoney(1234567800, { minorDigits: 2, grouping: 'none' })).toBe('12345678.00')
    expect(formatMoney(125050, { minorDigits: 2, prefix: 'Rs ' })).toBe('Rs 1,250.50')
    expect(formatMoney(-125050, { minorDigits: 2, prefix: 'Rs ' })).toBe('-Rs 1,250.50')
    expect(formatMoney(1234, { minorDigits: 0 })).toBe('1,234')
    expect(formatMoney(0, { minorDigits: 0 })).toBe('0')
    expect(formatMoney(1234, { minorDigits: 3 })).toBe('1.234')
    expect(formatMoney(5, { minorDigits: 4 })).toBe('0.0005')
  })

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX + 1])(
    'rejects the non-integer or unsafe amount %s',
    (amount) => {
      expect(thrownCode(() => formatMoney(amount, PKR))).toBe('INVALID_ARGUMENT')
    }
  )

  it('round-trips every formatted amount through parseMoney', () => {
    const random = createRandom(7)
    const values = [0, 1, -1, 99, 100, 125050, MAX, -MAX]
    for (let i = 0; i < 500; i++) values.push(random(1) === 1 ? -random(MAX) : random(MAX))
    const groupings: DigitGrouping[] = ['international', 'south-asian', 'none']
    for (const grouping of groupings) {
      for (const value of values) {
        const text = formatMoney(value, { minorDigits: 2, grouping })
        expect(parseMoney(text, SIGNED)).toEqual({ ok: true, value })
      }
    }
  })
})

describe('addMinor, subtractMinor, sumMinor, multiplyMinor', () => {
  it('adds, subtracts and sums exactly', () => {
    expect(addMinor(150, 250)).toBe(400)
    expect(subtractMinor(100, 250)).toBe(-150)
    expect(sumMinor([])).toBe(0)
    expect(sumMinor([125050, 1, -50])).toBe(125001)
    expect(addMinor(MAX - 1, 1)).toBe(MAX)
    expect(subtractMinor(-MAX + 1, 1)).toBe(-MAX)
  })

  it('multiplies a price by a quantity exactly', () => {
    expect(multiplyMinor(240000, 3)).toBe(720000)
    expect(multiplyMinor(-5, 3)).toBe(-15)
    expect(multiplyMinor(MAX, 1)).toBe(MAX)
    expect(multiplyMinor(0, MAX)).toBe(0)
  })

  it('throws OUT_OF_RANGE instead of losing precision', () => {
    expect(thrownCode(() => addMinor(MAX, 1))).toBe('OUT_OF_RANGE')
    expect(thrownCode(() => subtractMinor(-MAX, 1))).toBe('OUT_OF_RANGE')
    expect(thrownCode(() => subtractMinor(MAX, -1))).toBe('OUT_OF_RANGE')
    expect(thrownCode(() => sumMinor([MAX, 1]))).toBe('OUT_OF_RANGE')
    expect(thrownCode(() => sumMinor([MAX, MAX, -MAX]))).toBe('OUT_OF_RANGE')
    expect(thrownCode(() => multiplyMinor(MAX, 2))).toBe('OUT_OF_RANGE')
  })

  it('rejects non-integer amounts', () => {
    expect(thrownCode(() => addMinor(0.1, 0.2))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => subtractMinor(1, 0.5))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => subtractMinor(0.5, 1))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => sumMinor([1, Number.NaN]))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => multiplyMinor(2.5, 2))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => multiplyMinor(2, 1.5))).toBe('INVALID_ARGUMENT')
  })
})

describe('divideRoundHalfUp', () => {
  it.each<[bigint, bigint, bigint]>([
    [5n, 2n, 3n],
    [3n, 2n, 2n],
    [4n, 2n, 2n],
    [7n, 3n, 2n],
    [8n, 3n, 3n],
    [1n, 3n, 0n],
    [2n, 3n, 1n],
    [1n, 2n, 1n],
    [0n, 7n, 0n],
    [0n, -7n, 0n],
    [-5n, 2n, -3n],
    [-3n, 2n, -2n],
    [5n, -2n, -3n],
    [-5n, -2n, 3n],
    [-7n, 3n, -2n],
    [-8n, 3n, -3n]
  ])('%s ÷ %s rounds to %s (half away from zero)', (numerator, denominator, expected) => {
    expect(divideRoundHalfUp(numerator, denominator)).toBe(expected)
  })

  it('is exact for numbers far beyond the float range', () => {
    expect(divideRoundHalfUp(10n ** 40n + 5n, 10n)).toBe(10n ** 39n + 1n)
    expect(divideRoundHalfUp(10n ** 40n + 4n, 10n)).toBe(10n ** 39n)
  })

  it('refuses to divide by zero', () => {
    expect(thrownCode(() => divideRoundHalfUp(1n, 0n))).toBe('INVALID_ARGUMENT')
  })
})

describe('mulDivRoundHalfUp', () => {
  it('rounds half-up with an exact BigInt intermediate', () => {
    expect(mulDivRoundHalfUp(1999, 250, 10000)).toBe(50)
    expect(mulDivRoundHalfUp(1, 1, 2)).toBe(1)
    expect(mulDivRoundHalfUp(-1, 1, 2)).toBe(-1)
    expect(mulDivRoundHalfUp(-1999, 250, 10000)).toBe(-50)
    // MAX × MAX is about 8.1e31, far beyond the exact float range.
    expect(mulDivRoundHalfUp(MAX, MAX, MAX)).toBe(MAX)
    expect(mulDivRoundHalfUp(MAX, 10000, 10000)).toBe(MAX)
    // MAX ÷ 3 = 3002399751580330.33…; a float division would land on …330.5 and round up to …331.
    expect(mulDivRoundHalfUp(MAX, 1, 3)).toBe(3002399751580330)
  })

  it('rejects an unsafe result, a zero divisor and non-integers', () => {
    expect(thrownCode(() => mulDivRoundHalfUp(MAX, 2, 1))).toBe('OUT_OF_RANGE')
    expect(thrownCode(() => mulDivRoundHalfUp(1, 1, 0))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => mulDivRoundHalfUp(1.5, 1, 1))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => mulDivRoundHalfUp(1, 1.5, 1))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => mulDivRoundHalfUp(1, 1, 1.5))).toBe('INVALID_ARGUMENT')
  })
})

describe('basisPointsOf', () => {
  it.each<[number, number, number]>([
    [10000, 500, 500],
    [1999, 250, 50],
    [1999, 500, 100],
    [1, 5000, 1],
    [1, 4999, 0],
    [3, 5000, 2],
    [123456, 10000, 123456],
    [123456, 0, 0],
    [0, 1234, 0],
    [1000, 15000, 1500],
    [-1999, 250, -50]
  ])('%i × %i bps = %i', (amount, bps, expected) => {
    expect(basisPointsOf(amount, bps)).toBe(expected)
  })

  it('rejects negative or fractional basis points', () => {
    expect(thrownCode(() => basisPointsOf(100, -1))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => basisPointsOf(100, 1.5))).toBe('INVALID_ARGUMENT')
  })

  it('is always within half a minor unit of the exact value, with halves rounded up', () => {
    const random = createRandom(11)
    for (let i = 0; i < 5000; i++) {
      const amount = random(1_000_000_000)
      const bps = random(10_000)
      const result = basisPointsOf(amount, bps)
      // −10 000 ≤ 2 × (amount × bps − result × 10 000) < 10 000
      const twiceError = 2n * BigInt(amount) * BigInt(bps) - 20_000n * BigInt(result)
      expect(twiceError >= -10_000n && twiceError < 10_000n).toBe(true)
    }
  })
})
