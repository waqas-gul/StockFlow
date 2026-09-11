import { describe, expect, it } from 'vitest'
import {
  applyDeductions,
  calculateInvoice,
  calculateLine,
  calculateQuantityRow,
  type Deduction,
  type DeductionSpec,
  type InvoiceInput,
  type LineInput,
  type QuantityRowInput
} from './invoice-calc'
import { createRandom, thrownCode } from './test-utils'

// Rs 2,400 per Box of 24 base units and Rs 110 per Piece. Illustrative numbers only.
const twoBoxes: QuantityRowInput = { quantity: 2, unitBaseQty: 24, unitPriceMinor: 240_000 }
const fivePieces: QuantityRowInput = { quantity: 5, unitBaseQty: 1, unitPriceMinor: 11_000 }
const single = (unitPriceMinor: number): QuantityRowInput => ({
  quantity: 1,
  unitBaseQty: 1,
  unitPriceMinor
})
const percent = (key: string, bps: number, basis?: 'original' | 'remaining'): Deduction => ({
  key,
  spec: { type: 'percent', bps },
  basis
})
const amount = (key: string, amountMinor: number): Deduction => ({
  key,
  spec: { type: 'amount', amountMinor }
})

describe('calculateQuantityRow', () => {
  it('computes quantity × price and quantity × unit size', () => {
    expect(calculateQuantityRow({ quantity: 3, unitBaseQty: 24, unitPriceMinor: 240_000 })).toEqual(
      {
        quantity: 3,
        unitBaseQty: 24,
        unitPriceMinor: 240_000,
        qtyBase: 72,
        amountMinor: 720_000
      }
    )
  })

  it('handles zero quantities and zero prices (free goods count in qtyBase only)', () => {
    expect(
      calculateQuantityRow({ quantity: 0, unitBaseQty: 24, unitPriceMinor: 240_000 })
    ).toMatchObject({
      qtyBase: 0,
      amountMinor: 0
    })
    expect(calculateQuantityRow({ quantity: 1, unitBaseQty: 24, unitPriceMinor: 0 })).toMatchObject(
      {
        qtyBase: 24,
        amountMinor: 0
      }
    )
  })

  it('rejects invalid rows', () => {
    expect(thrownCode(() => calculateQuantityRow({ ...twoBoxes, unitPriceMinor: -1 }))).toBe(
      'INVALID_ARGUMENT'
    )
    expect(thrownCode(() => calculateQuantityRow({ ...twoBoxes, unitPriceMinor: 1.5 }))).toBe(
      'INVALID_ARGUMENT'
    )
    expect(thrownCode(() => calculateQuantityRow({ ...twoBoxes, quantity: 1.5 }))).toBe(
      'INVALID_ARGUMENT'
    )
    expect(thrownCode(() => calculateQuantityRow({ ...twoBoxes, unitBaseQty: 0 }))).toBe(
      'INVALID_ARGUMENT'
    )
  })
})

describe('calculateLine', () => {
  it('has net = gross without deductions', () => {
    const line = calculateLine({ quantities: [twoBoxes] })
    expect(line).toMatchObject({
      qtyBase: 48,
      grossMinor: 480_000,
      deductions: [],
      totalDeductionMinor: 0,
      netMinor: 480_000
    })
  })

  it('totals mixed quantity rows: 2 Box + 5 Pcs = 53 base units, Rs 5,350', () => {
    const line = calculateLine({ quantities: [twoBoxes, fivePieces] })
    expect(line.qtyBase).toBe(53)
    expect(line.grossMinor).toBe(535_000)
    expect(line.quantities.map((row) => row.amountMinor)).toEqual([480_000, 55_000])
  })

  it('applies a percentage discount with half-up rounding', () => {
    expect(
      calculateLine({ quantities: [twoBoxes, fivePieces], deductions: [percent('discount', 500)] })
    ).toMatchObject({
      deductions: [{ key: 'discount', amountMinor: 26_750, bps: 500 }],
      netMinor: 508_250
    })
    // 2.5% of 1,999 = 49.975 → 50
    expect(
      calculateLine({ quantities: [single(1999)], deductions: [percent('discount', 250)] }).netMinor
    ).toBe(1949)
  })

  it('applies a fixed-amount discount', () => {
    expect(
      calculateLine({ quantities: [twoBoxes], deductions: [amount('discount', 300)] })
    ).toMatchObject({
      deductions: [{ key: 'discount', amountMinor: 300, bps: null }],
      totalDeductionMinor: 300,
      netMinor: 479_700
    })
  })

  it('allows a deduction of exactly the whole amount', () => {
    expect(
      calculateLine({ quantities: [single(10_000)], deductions: [percent('d', 10_000)] }).netMinor
    ).toBe(0)
    expect(
      calculateLine({ quantities: [single(10_000)], deductions: [amount('d', 10_000)] }).netMinor
    ).toBe(0)
  })

  it('applies several deductions on the original or the remaining amount', () => {
    const base = { quantities: [single(10_000)] }
    expect(
      calculateLine({
        ...base,
        deductions: [percent('discount', 1000), percent('scheme', 500)]
      }).deductions.map((d) => d.amountMinor)
    ).toEqual([1000, 500])
    expect(
      calculateLine({
        ...base,
        deductions: [percent('discount', 1000), percent('scheme', 500, 'remaining')]
      }).netMinor
    ).toBe(8550) // 10,000 − 1,000 − 5% of 9,000
    expect(
      calculateLine({
        ...base,
        deductions: [amount('discount', 1000), percent('scheme', 1000, 'remaining')]
      }).netMinor
    ).toBe(8100)
  })

  it('rejects discounts larger than what they apply to', () => {
    expect(
      thrownCode(() =>
        calculateLine({ quantities: [single(10_000)], deductions: [amount('d', 10_001)] })
      )
    ).toBe('DEDUCTION_EXCEEDS_BASE')
    expect(
      thrownCode(() =>
        calculateLine({
          quantities: [single(10_000)],
          deductions: [percent('discount', 6000), percent('scheme', 6000)]
        })
      )
    ).toBe('DEDUCTION_EXCEEDS_BASE')
    expect(
      thrownCode(() =>
        calculateLine({
          quantities: [single(10_000)],
          deductions: [amount('discount', 6000), amount('scheme', 5000)]
        })
      )
    ).toBe('DEDUCTION_EXCEEDS_BASE')
    expect(thrownCode(() => calculateLine({ quantities: [], deductions: [amount('d', 1)] }))).toBe(
      'DEDUCTION_EXCEEDS_BASE'
    )
  })

  it('rejects invalid deduction definitions', () => {
    const line = (deductions: Deduction[]): LineInput => ({
      quantities: [single(10_000)],
      deductions
    })
    expect(thrownCode(() => calculateLine(line([percent('d', 10_001)])))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => calculateLine(line([percent('d', -1)])))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => calculateLine(line([percent('d', 12.5)])))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => calculateLine(line([amount('d', -1)])))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => calculateLine(line([amount('d', 1), amount('d', 1)])))).toBe(
      'INVALID_ARGUMENT'
    )
    expect(thrownCode(() => calculateLine(line([amount(' ', 1)])))).toBe('INVALID_ARGUMENT')
    const unknownType = { type: 'free', amountMinor: 1 } as unknown as DeductionSpec
    expect(thrownCode(() => calculateLine(line([{ key: 'd', spec: unknownType }])))).toBe(
      'INVALID_ARGUMENT'
    )
    const unknownBasis = { ...percent('d', 100), basis: 'net' } as unknown as Deduction
    expect(thrownCode(() => calculateLine(line([unknownBasis])))).toBe('INVALID_ARGUMENT')
  })
})

describe('applyDeductions', () => {
  it('returns the total and the remaining amount', () => {
    expect(applyDeductions(10_000)).toEqual({
      deductions: [],
      totalMinor: 0,
      remainingMinor: 10_000
    })
    expect(applyDeductions(10_000, [amount('a', 2500), percent('b', 1000, 'remaining')])).toEqual({
      deductions: [
        { key: 'a', amountMinor: 2500, bps: null },
        { key: 'b', amountMinor: 750, bps: 1000 }
      ],
      totalMinor: 3250,
      remainingMinor: 6750
    })
  })

  it('rejects a negative or fractional base', () => {
    expect(thrownCode(() => applyDeductions(-1))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => applyDeductions(1.5))).toBe('INVALID_ARGUMENT')
  })
})

describe('calculateInvoice', () => {
  // Line 1: 2 Box + 5 Pcs, gross 535,000, 5% discount 26,750 → net 508,250
  // Line 2: 3 Box, gross 720,000, fixed discount 20,000 → net 700,000
  const lines: LineInput[] = [
    { quantities: [twoBoxes, fivePieces], deductions: [percent('discount', 500)] },
    { quantities: [{ ...twoBoxes, quantity: 3 }], deductions: [amount('discount', 20_000)] }
  ]

  it('adds up lines, extra discount, freight, previous balance and received amount', () => {
    const invoice = calculateInvoice({
      lines,
      deductions: [amount('extraDiscount', 8250)],
      charges: [{ key: 'freight', amountMinor: 50_000 }],
      previousBalanceMinor: 300_000,
      receivedMinor: 500_000
    })
    expect(invoice).toMatchObject({
      grossMinor: 1_255_000,
      lineDeductionTotals: [{ key: 'discount', amountMinor: 46_750 }],
      lineDeductionMinor: 46_750,
      linesNetMinor: 1_208_250,
      deductions: [{ key: 'extraDiscount', amountMinor: 8250, bps: null }],
      invoiceDeductionMinor: 8250,
      netMinor: 1_200_000,
      charges: [{ key: 'freight', amountMinor: 50_000 }],
      chargesMinor: 50_000,
      totalMinor: 1_250_000,
      previousBalanceMinor: 300_000,
      receivedMinor: 500_000,
      outstandingMinor: 1_050_000
    })
    expect(invoice.lines.map((line) => line.netMinor)).toEqual([508_250, 700_000])
  })

  it('supports a percentage extra discount on the sum of line nets', () => {
    // 1% of 1,208,250 = 12,082.5 → 12,083
    const invoice = calculateInvoice({ lines, deductions: [percent('extraDiscount', 100)] })
    expect(invoice.invoiceDeductionMinor).toBe(12_083)
    expect(invoice.netMinor).toBe(1_196_167)
    expect(invoice.totalMinor).toBe(1_196_167)
    expect(invoice.outstandingMinor).toBe(1_196_167)
  })

  it('totals line deductions per key, e.g. discount and scheme separately', () => {
    const invoice = calculateInvoice({
      lines: [
        {
          quantities: [single(10_000)],
          deductions: [percent('discount', 1000), amount('scheme', 200)]
        },
        { quantities: [single(5000)], deductions: [amount('scheme', 300)] },
        { quantities: [single(2000)] }
      ]
    })
    expect(invoice.lineDeductionTotals).toEqual([
      { key: 'discount', amountMinor: 1000 },
      { key: 'scheme', amountMinor: 500 }
    ])
    expect(invoice.linesNetMinor).toBe(15_500)
  })

  it('accepts several charges', () => {
    const invoice = calculateInvoice({
      lines,
      charges: [
        { key: 'freight', amountMinor: 50_000 },
        { key: 'loading', amountMinor: 5000 }
      ]
    })
    expect(invoice.chargesMinor).toBe(55_000)
    expect(invoice.totalMinor).toBe(1_208_250 + 55_000)
  })

  it('handles customer credit and overpayment (negative balances)', () => {
    const credit = calculateInvoice({ lines, previousBalanceMinor: -100_000 })
    expect(credit.outstandingMinor).toBe(1_108_250)
    const overpaid = calculateInvoice({ lines, receivedMinor: 2_000_000 })
    expect(overpaid.outstandingMinor).toBe(-791_750)
  })

  it('returns zeros for an empty invoice', () => {
    expect(
      calculateInvoice({ lines: [], previousBalanceMinor: 1000, receivedMinor: 400 })
    ).toMatchObject({
      grossMinor: 0,
      lineDeductionTotals: [],
      linesNetMinor: 0,
      netMinor: 0,
      totalMinor: 0,
      outstandingMinor: 600
    })
  })

  it('rejects invalid invoice-level input', () => {
    const base: InvoiceInput = { lines }
    expect(
      thrownCode(() => calculateInvoice({ ...base, deductions: [amount('extra', 1_208_251)] }))
    ).toBe('DEDUCTION_EXCEEDS_BASE')
    expect(
      thrownCode(() =>
        calculateInvoice({ ...base, charges: [{ key: 'freight', amountMinor: -1 }] })
      )
    ).toBe('INVALID_ARGUMENT')
    expect(
      thrownCode(() =>
        calculateInvoice({
          ...base,
          charges: [
            { key: 'freight', amountMinor: 1 },
            { key: 'freight', amountMinor: 2 }
          ]
        })
      )
    ).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => calculateInvoice({ ...base, receivedMinor: -1 }))).toBe(
      'INVALID_ARGUMENT'
    )
    expect(thrownCode(() => calculateInvoice({ ...base, previousBalanceMinor: 0.5 }))).toBe(
      'INVALID_ARGUMENT'
    )
  })

  it('reconciles every total exactly for random invoices', () => {
    const random = createRandom(31)
    const sizes = [1, 6, 24, 60]
    for (let run = 0; run < 300; run++) {
      const invoiceLines: LineInput[] = Array.from({ length: random(5) }, () => {
        const quantities = Array.from({ length: 1 + random(2) }, () => ({
          quantity: random(50),
          unitBaseQty: sizes[random(3)],
          unitPriceMinor: random(500_000)
        }))
        const gross = quantities.reduce((sum, row) => sum + row.quantity * row.unitPriceMinor, 0)
        const deductions: Deduction[] = []
        if (random(1) === 1) {
          deductions.push(
            random(1) === 1
              ? percent('discount', random(3000))
              : amount('discount', random(Math.floor(gross / 3)))
          )
        }
        if (random(1) === 1) deductions.push(percent('scheme', random(2000), 'remaining'))
        return { quantities, deductions }
      })
      const linesNet = calculateInvoice({ lines: invoiceLines }).linesNetMinor
      const input: InvoiceInput = {
        lines: invoiceLines,
        deductions: [
          random(1) === 1
            ? percent('extraDiscount', random(1000))
            : amount('extraDiscount', random(Math.floor(linesNet / 10)))
        ],
        charges: [{ key: 'freight', amountMinor: random(100_000) }],
        previousBalanceMinor: random(2_000_000) - 1_000_000,
        receivedMinor: random(2_000_000)
      }
      const invoice = calculateInvoice(input)

      invoice.lines.forEach((line, i) => {
        const rows = invoiceLines[i].quantities
        expect(line.grossMinor).toBe(
          rows.reduce((sum, row) => sum + row.quantity * row.unitPriceMinor, 0)
        )
        expect(line.qtyBase).toBe(
          rows.reduce((sum, row) => sum + row.quantity * row.unitBaseQty, 0)
        )
        expect(line.netMinor).toBeGreaterThanOrEqual(0)
        expect(line.grossMinor - line.totalDeductionMinor).toBe(line.netMinor)
        expect(line.deductions.reduce((sum, d) => sum + d.amountMinor, 0)).toBe(
          line.totalDeductionMinor
        )
      })
      expect(invoice.grossMinor - invoice.lineDeductionMinor).toBe(invoice.linesNetMinor)
      expect(invoice.lineDeductionTotals.reduce((sum, d) => sum + d.amountMinor, 0)).toBe(
        invoice.lineDeductionMinor
      )
      expect(
        invoice.grossMinor -
          invoice.lineDeductionMinor -
          invoice.invoiceDeductionMinor +
          invoice.chargesMinor
      ).toBe(invoice.totalMinor)
      expect(invoice.previousBalanceMinor + invoice.totalMinor - invoice.receivedMinor).toBe(
        invoice.outstandingMinor
      )
    }
  })
})
