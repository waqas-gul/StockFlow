import { describe, expect, it } from 'vitest'
import type { ProductUnit } from '@shared/products'
import { formatAmount, priceSummary, stockText } from './product-display'

const RS = { minorDigits: 2, symbol: 'Rs' }

function unit(overrides: Partial<ProductUnit>): ProductUnit {
  return {
    id: 1,
    name: 'Piece',
    shortName: null,
    baseQty: 1,
    isBase: true,
    canSell: true,
    canPurchase: true,
    wholesalePriceMinor: null,
    retailPriceMinor: null,
    defaultCostMinor: null,
    sortOrder: 0,
    isActive: true,
    ...overrides
  }
}

const piece = unit({ id: 1, retailPriceMinor: 1100, wholesalePriceMinor: 1000 })
const box = unit({
  id: 2,
  name: 'Box',
  shortName: 'Bx',
  baseQty: 24,
  isBase: false,
  wholesalePriceMinor: 24000,
  sortOrder: 1
})
const carton = unit({ id: 3, name: 'Carton', baseQty: 240, isBase: false, sortOrder: 2 })

describe('product display', () => {
  it('formats amounts with the currency symbol and decimal places', () => {
    expect(formatAmount(125050, RS)).toBe('Rs 1,250.50')
    expect(formatAmount(0, RS)).toBe('Rs 0.00')
    expect(formatAmount(1250, { minorDigits: 0, symbol: '$' })).toBe('$ 1,250')
  })

  it('shows the first sellable unit with a price, and how many other units have one', () => {
    expect(priceSummary([piece, box, carton], 'wholesale', RS)).toEqual({
      text: 'Rs 10.00',
      unit: 'Piece',
      others: 1,
      title: 'Piece: Rs 10.00 · Bx: Rs 240.00'
    })
    expect(priceSummary([piece, box, carton], 'retail', RS)).toEqual({
      text: 'Rs 11.00',
      unit: 'Piece',
      others: 0,
      title: 'Piece: Rs 11.00'
    })
  })

  it('skips units that are inactive, not for sale or without that price, and shows a zero price', () => {
    const units = [
      { ...piece, canSell: false },
      { ...box, isActive: false },
      unit({ id: 4, name: 'Pack', baseQty: 6, isBase: false, wholesalePriceMinor: 0 })
    ]
    expect(priceSummary(units, 'wholesale', RS)).toMatchObject({
      text: 'Rs 0.00',
      unit: 'Pack',
      others: 0
    })
    expect(priceSummary(units, 'retail', RS)).toBeNull()
    expect(priceSummary([], 'retail', RS)).toBeNull()
  })

  it('writes stock in the product units, largest first', () => {
    expect(stockText({ stockQtyBase: 0, units: [piece, box] })).toBe('0 Piece')
    expect(stockText({ stockQtyBase: 53, units: [piece, box, carton] })).toBe('2 Box + 5 Piece')
    expect(stockText({ stockQtyBase: 7, units: [] })).toBe('7')
  })
})
