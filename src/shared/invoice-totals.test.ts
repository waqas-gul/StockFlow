import { describe, expect, it } from 'vitest'
import {
  calculateInvoiceTotals,
  type InvoiceTotals,
  type InvoiceTotalsInput,
  type InvoiceTotalsLineInput
} from './invoice-totals'

// Rs 2,400 per Box of 24 and Rs 110 per Piece (2 minor digits). Illustrative numbers only.
const box = (
  quantity: number,
  unitPriceMinor = 240_000
): InvoiceTotalsLineInput['quantities'][number] => ({
  quantity,
  unitBaseQty: 24,
  unitPriceMinor
})
const piece = (
  quantity: number,
  unitPriceMinor = 11_000
): InvoiceTotalsLineInput['quantities'][number] => ({
  quantity,
  unitBaseQty: 1,
  unitPriceMinor
})

function line(overrides: Partial<InvoiceTotalsLineInput> = {}): InvoiceTotalsLineInput {
  return {
    quantities: [piece(1)],
    freeQuantities: [],
    discount: null,
    schemeMinor: 0,
    ...overrides
  }
}

function input(
  lines: InvoiceTotalsLineInput[],
  overrides: Partial<InvoiceTotalsInput> = {}
): InvoiceTotalsInput {
  return {
    lines,
    extraDiscountMinor: 0,
    freightMinor: 0,
    receivedMinor: 0,
    previousBalanceMinor: 0,
    ...overrides
  }
}

function totals(value: InvoiceTotalsInput): InvoiceTotals {
  const result = calculateInvoiceTotals(value)
  if (!result.ok) throw new Error(`Unexpected issues: ${JSON.stringify(result.issues)}`)
  return result.totals
}

describe('calculateInvoiceTotals', () => {
  it('prices one line of Box and Piece rows: gross = Σ rows, one paid base quantity', () => {
    const result = totals(input([line({ quantities: [box(2), piece(5)] })]))

    expect(result.lines).toEqual([
      {
        quantities: [
          {
            quantity: 2,
            unitBaseQty: 24,
            unitPriceMinor: 240_000,
            qtyBase: 48,
            amountMinor: 480_000
          },
          { quantity: 5, unitBaseQty: 1, unitPriceMinor: 11_000, qtyBase: 5, amountMinor: 55_000 }
        ],
        paidQtyBase: 53,
        schemeQtyBase: 0,
        qtyBase: 53,
        grossMinor: 535_000,
        discountBps: null,
        discountMinor: 0,
        schemeMinor: 0,
        netMinor: 535_000
      }
    ])
    expect(result).toMatchObject({
      grossMinor: 535_000,
      lineDiscountMinor: 0,
      lineSchemeMinor: 0,
      extraDiscountMinor: 0,
      netMinor: 535_000,
      freightMinor: 0,
      totalMinor: 535_000,
      receivedMinor: 0,
      previousBalanceMinor: 0,
      netOutstandingMinor: 535_000
    })
  })

  it('rounds a percentage discount half-up on the line gross and keeps the basis points', () => {
    // 12,345 × 12.5% = 1,543.125 → 1,543
    const result = totals(
      input([line({ quantities: [piece(1, 12_345)], discount: { type: 'PERCENT', bps: 1250 } })])
    )
    expect(result.lines[0]).toMatchObject({
      grossMinor: 12_345,
      discountBps: 1250,
      discountMinor: 1543,
      netMinor: 10_802
    })

    // 1,999 × 5% = 99.95 → 100
    const up = totals(
      input([line({ quantities: [piece(1, 1999)], discount: { type: 'PERCENT', bps: 500 } })])
    )
    expect(up.lines[0]).toMatchObject({ discountMinor: 100, netMinor: 1899 })
  })

  it('takes a fixed discount and a scheme amount off the gross: net = gross − discount − scheme', () => {
    const result = totals(
      input([
        line({
          quantities: [box(1)],
          discount: { type: 'AMOUNT', amountMinor: 10_000 },
          schemeMinor: 5_000
        }),
        line({ quantities: [piece(10)], schemeMinor: 1_000 })
      ])
    )
    expect(
      result.lines.map((item) => [
        item.grossMinor,
        item.discountBps,
        item.discountMinor,
        item.schemeMinor,
        item.netMinor
      ])
    ).toEqual([
      [240_000, null, 10_000, 5_000, 225_000],
      [110_000, null, 0, 1_000, 109_000]
    ])
    expect(result).toMatchObject({
      grossMinor: 350_000,
      lineDiscountMinor: 10_000,
      lineSchemeMinor: 6_000,
      netMinor: 334_000,
      totalMinor: 334_000
    })
  })

  it('counts free scheme quantity in the stock quantity only: no revenue', () => {
    const result = totals(
      input([
        line({
          quantities: [box(2)],
          freeQuantities: [
            { quantity: 1, unitBaseQty: 24 },
            { quantity: 3, unitBaseQty: 1 }
          ]
        })
      ])
    )
    expect(result.lines[0]).toMatchObject({
      paidQtyBase: 48,
      schemeQtyBase: 27,
      qtyBase: 75,
      grossMinor: 480_000,
      netMinor: 480_000
    })
    expect(result.totalMinor).toBe(480_000)
  })

  it('applies the extra discount to Σ line net, adds freight, and works out the outstanding balance', () => {
    const result = totals(
      input([line({ quantities: [piece(10)] }), line({ quantities: [box(1)] })], {
        extraDiscountMinor: 20_000,
        freightMinor: 15_000,
        receivedMinor: 100_000,
        previousBalanceMinor: 50_000
      })
    )
    expect(result).toMatchObject({
      grossMinor: 350_000,
      extraDiscountMinor: 20_000,
      netMinor: 330_000,
      freightMinor: 15_000,
      totalMinor: 345_000,
      receivedMinor: 100_000,
      previousBalanceMinor: 50_000,
      netOutstandingMinor: 295_000
    })
  })

  it('allows a zero total, and an overpayment or advance gives a negative outstanding balance', () => {
    const free = totals(
      input([line({ quantities: [piece(3, 0)] })], {
        receivedMinor: 5_000,
        previousBalanceMinor: -1_000
      })
    )
    expect(free).toMatchObject({
      grossMinor: 0,
      netMinor: 0,
      totalMinor: 0,
      netOutstandingMinor: -6_000
    })

    const over = totals(
      input([line({ quantities: [piece(1)] })], {
        receivedMinor: 20_000,
        previousBalanceMinor: 3_000
      })
    )
    expect(over.netOutstandingMinor).toBe(-6_000)
  })

  it('reports every deduction larger than what it applies to, at its field, instead of a negative amount', () => {
    const result = calculateInvoiceTotals(
      input([
        line({ quantities: [piece(1)], discount: { type: 'AMOUNT', amountMinor: 11_001 } }),
        line({
          quantities: [piece(1)],
          discount: { type: 'AMOUNT', amountMinor: 6_000 },
          schemeMinor: 5_001
        }),
        line({ quantities: [piece(1)] })
      ])
    )
    expect(result).toEqual({
      ok: false,
      issues: [
        { path: 'lines.0.discount', message: 'The discount cannot be more than the line amount.' },
        {
          path: 'lines.1.schemeMinor',
          message: 'The scheme cannot be more than the line amount after the discount.'
        }
      ]
    })

    expect(
      calculateInvoiceTotals(
        input([line({ quantities: [piece(2)], schemeMinor: 1_000 })], {
          extraDiscountMinor: 21_001
        })
      )
    ).toEqual({
      ok: false,
      issues: [
        {
          path: 'extraDiscountMinor',
          message: 'The extra discount cannot be more than the invoice amount after line discounts.'
        }
      ]
    })
    // Exactly the whole amount is allowed.
    expect(
      totals(
        input([line({ quantities: [piece(2)], schemeMinor: 1_000 })], {
          extraDiscountMinor: 21_000
        })
      ).netMinor
    ).toBe(0)
  })

  it('reports amounts too large to calculate exactly instead of losing precision', () => {
    const huge = Number.MAX_SAFE_INTEGER
    expect(calculateInvoiceTotals(input([line({ quantities: [piece(2, huge)] })]))).toEqual({
      ok: false,
      issues: [{ path: 'lines.0', message: 'The amounts on this line are too large.' }]
    })
    expect(
      calculateInvoiceTotals(input([line({ quantities: [piece(1, huge)] })], { freightMinor: 1 }))
    ).toEqual({
      ok: false,
      issues: [{ path: 'root', message: 'The invoice amounts are too large.' }]
    })
    expect(
      calculateInvoiceTotals(
        input([line({ quantities: [piece(1, 10)] })], { previousBalanceMinor: huge })
      )
    ).toEqual({
      ok: false,
      issues: [{ path: 'root', message: 'The invoice amounts are too large.' }]
    })
  })
})
