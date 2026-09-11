import { describe, expect, it } from 'vitest'
import { amountInWords, integerToWords, type NumberingSystem } from './amount-in-words'
import { createRandom, thrownCode } from './test-utils'

const MAX = Number.MAX_SAFE_INTEGER

describe('integerToWords (South Asian: thousand, lakh, crore)', () => {
  it.each<[number, string]>([
    [0, 'Zero'],
    [1, 'One'],
    [9, 'Nine'],
    [10, 'Ten'],
    [11, 'Eleven'],
    [19, 'Nineteen'],
    [20, 'Twenty'],
    [21, 'Twenty One'],
    [45, 'Forty Five'],
    [99, 'Ninety Nine'],
    [100, 'One Hundred'],
    [101, 'One Hundred One'],
    [110, 'One Hundred Ten'],
    [999, 'Nine Hundred Ninety Nine'],
    [1000, 'One Thousand'],
    [1001, 'One Thousand One'],
    [1250, 'One Thousand Two Hundred Fifty'],
    [10_000, 'Ten Thousand'],
    [99_999, 'Ninety Nine Thousand Nine Hundred Ninety Nine'],
    [1_00_000, 'One Lakh'],
    [1_00_001, 'One Lakh One'],
    [1_25_050, 'One Lakh Twenty Five Thousand Fifty'],
    [10_00_000, 'Ten Lakh'],
    [99_99_999, 'Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine'],
    [1_00_00_000, 'One Crore'],
    [1_23_45_678, 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight'],
    [10_00_00_000, 'Ten Crore'],
    [1_00_00_00_000, 'One Hundred Crore'],
    [10_00_00_00_000, 'One Thousand Crore'],
    [1_00_000_00_00_000, 'One Lakh Crore'],
    [
      MAX,
      'Ninety Crore Seven Lakh Nineteen Thousand Nine Hundred Twenty Five Crore Forty Seven Lakh Forty Thousand Nine Hundred Ninety One'
    ]
  ])('%i → "%s"', (value, expected) => {
    expect(integerToWords(value)).toBe(expected)
  })
})

describe('integerToWords (international)', () => {
  it.each<[number, string]>([
    [0, 'Zero'],
    [100_000, 'One Hundred Thousand'],
    [1_000_000, 'One Million'],
    [1_234_567, 'One Million Two Hundred Thirty Four Thousand Five Hundred Sixty Seven'],
    [1_000_000_000, 'One Billion'],
    [
      MAX,
      'Nine Quadrillion Seven Trillion One Hundred Ninety Nine Billion Two Hundred Fifty Four Million Seven Hundred Forty Thousand Nine Hundred Ninety One'
    ]
  ])('%i → "%s"', (value, expected) => {
    expect(integerToWords(value, 'international')).toBe(expected)
  })

  it('rejects negative, fractional or unsafe values and unknown systems', () => {
    expect(thrownCode(() => integerToWords(-1))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => integerToWords(1.5))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => integerToWords(MAX + 1))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => integerToWords(1, 'roman' as NumberingSystem))).toBe('INVALID_ARGUMENT')
  })
})

describe('amountInWords (defaults: Rupees / Paisa, 2 decimals, South Asian)', () => {
  it.each<[number, string]>([
    [0, 'Zero Rupees Only'],
    [100, 'One Rupee Only'],
    [200, 'Two Rupees Only'],
    [1, 'One Paisa Only'],
    [50, 'Fifty Paisa Only'],
    [150, 'One Rupee and Fifty Paisa Only'],
    [1905, 'Nineteen Rupees and Five Paisa Only'],
    [1_000_00, 'One Thousand Rupees Only'],
    [125_050, 'One Thousand Two Hundred Fifty Rupees and Fifty Paisa Only'],
    [1_00_000_00, 'One Lakh Rupees Only'],
    [10_00_000_00, 'Ten Lakh Rupees Only'],
    [1_00_00_000_00, 'One Crore Rupees Only'],
    [
      99_99_999_99,
      'Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine Rupees and Ninety Nine Paisa Only'
    ]
  ])('%i minor units → "%s"', (amount, expected) => {
    expect(amountInWords(amount)).toBe(expected)
  })
})

describe('amountInWords options', () => {
  it('uses configurable labels and suffix', () => {
    expect(
      amountInWords(125_050, {
        majorUnit: { singular: 'PKR', plural: 'PKR' },
        minorUnit: { singular: 'Paisa', plural: 'Paisa' },
        suffix: ''
      })
    ).toBe('One Thousand Two Hundred Fifty PKR and Fifty Paisa')
    expect(amountInWords(150, { majorUnit: { singular: '', plural: '' }, suffix: 'Only' })).toBe(
      'One and Fifty Paisa Only'
    )
  })

  it('supports the international numbering system', () => {
    expect(amountInWords(1_00_000_00, { numbering: 'international' })).toBe(
      'One Hundred Thousand Rupees Only'
    )
  })

  it('supports other currency precisions', () => {
    expect(amountInWords(1250, { minorDigits: 0 })).toBe(
      'One Thousand Two Hundred Fifty Rupees Only'
    )
    expect(
      amountInWords(1250, {
        minorDigits: 3,
        majorUnit: { singular: 'Dinar', plural: 'Dinars' },
        minorUnit: { singular: 'Fils', plural: 'Fils' }
      })
    ).toBe('One Dinar and Two Hundred Fifty Fils Only')
  })

  it('rejects negative or fractional amounts and invalid precision', () => {
    expect(thrownCode(() => amountInWords(-1))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => amountInWords(1.5))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => amountInWords(100, { minorDigits: 5 }))).toBe('INVALID_ARGUMENT')
  })
})

describe('invariants', () => {
  const VOCABULARY = new Set(
    (
      'Zero One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve Thirteen Fourteen Fifteen ' +
      'Sixteen Seventeen Eighteen Nineteen Twenty Thirty Forty Fifty Sixty Seventy Eighty Ninety ' +
      'Hundred Thousand Lakh Crore'
    ).split(' ')
  )

  it('produces distinct, well-formed words for every number from 0 to 20 000', () => {
    const seen = new Set<string>()
    for (let n = 0; n <= 20_000; n++) {
      const words = integerToWords(n)
      expect(words.split(' ').every((word) => VOCABULARY.has(word))).toBe(true)
      seen.add(words)
    }
    expect(seen.size).toBe(20_001)
  })

  it('never produces stray spaces for large amounts', () => {
    const random = createRandom(3)
    for (let i = 0; i < 2000; i++) {
      const text = amountInWords(random(MAX))
      expect(text).toBe(text.trim())
      expect(text).not.toContain('  ')
    }
  })
})
