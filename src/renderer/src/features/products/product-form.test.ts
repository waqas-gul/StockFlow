import { describe, expect, it } from 'vitest'
import type { Product } from '@shared/products'
import {
  NO_COMPANY,
  canRemoveUnitRow,
  chooseBaseRow,
  emptyProductForm,
  newUnitRow,
  productFormSchema,
  productToFormValues,
  serverFieldErrors,
  toCreateInput,
  toUpdateInput,
  type ProductFormValues,
  type UnitFormRow
} from './product-form'

function row(overrides: Partial<UnitFormRow> = {}): UnitFormRow {
  return { ...newUnitRow(), name: 'Piece', baseQty: '1', ...overrides }
}

function form(overrides: Partial<ProductFormValues> = {}): ProductFormValues {
  const base = row({ rowKey: 'base' })
  return {
    code: 'P-001',
    name: 'Tea 950g',
    companyId: NO_COMPANY,
    packingLabel: '1*12*18',
    lowStockThresholdBase: '0',
    baseRowKey: 'base',
    units: [base],
    ...overrides
  }
}

function errorsOf(values: ProductFormValues, minorDigits = 2): Record<string, string[]> {
  const result = productFormSchema(minorDigits).safeParse(values)
  if (result.success) return {}
  const errors: Record<string, string[]> = {}
  for (const issue of result.error.issues) (errors[issue.path.join('.')] ??= []).push(issue.message)
  return errors
}

describe('the product form', () => {
  it('starts with one base unit row and no company', () => {
    const values = emptyProductForm()
    expect(values.units).toHaveLength(1)
    expect(values.baseRowKey).toBe(values.units[0].rowKey)
    expect(values.units[0]).toMatchObject({
      baseQty: '1',
      name: '',
      canSell: true,
      canPurchase: true,
      isActive: true
    })
    expect(values.companyId).toBe(NO_COMPANY)
  })

  it('turns typed amounts into integer minor units, blank into "not set", and keeps the packing text exactly', () => {
    const values = form({
      companyId: '7',
      packingLabel: ' 1*12*18 ',
      lowStockThresholdBase: '1,200',
      units: [
        row({
          rowKey: 'base',
          wholesalePriceMinor: '1250',
          retailPriceMinor: '1,250.50',
          defaultCostMinor: '0'
        }),
        row({
          rowKey: 'box',
          name: 'Box',
          baseQty: '24',
          wholesalePriceMinor: ' ',
          retailPriceMinor: '30000.5'
        })
      ]
    })
    const parsed = productFormSchema(2).parse(values)
    expect(parsed).toEqual({
      code: 'P-001',
      name: 'Tea 950g',
      companyId: 7,
      packingLabel: '1*12*18',
      lowStockThresholdBase: 1200,
      units: [
        expect.objectContaining({
          isBase: true,
          baseQty: 1,
          wholesalePriceMinor: 125000,
          retailPriceMinor: 125050,
          defaultCostMinor: 0
        }),
        expect.objectContaining({
          isBase: false,
          baseQty: 24,
          wholesalePriceMinor: null,
          retailPriceMinor: 3000050,
          defaultCostMinor: null
        })
      ]
    })
    expect(toCreateInput(parsed, 2)).toMatchObject({
      currencyMinorDigits: 2,
      units: [{ id: null }, { id: null }]
    })
  })

  it.each<[string, Partial<ProductFormValues>, string, string]>([
    ['a missing code', { code: ' ' }, 'code', 'Enter the product code.'],
    ['a missing name', { name: '' }, 'name', 'Enter the product name.'],
    [
      'a threshold that is not a whole number',
      { lowStockThresholdBase: '2.5' },
      'lowStockThresholdBase',
      'Enter a whole number from 0 to 1,000,000,000.'
    ],
    [
      'a price with letters',
      { units: [row({ rowKey: 'base', retailPriceMinor: 'Rs 10' })] },
      'units.0.retailPriceMinor',
      'Enter an amount such as 1250 or 1,250.50.'
    ],
    [
      'a price with too many decimals',
      { units: [row({ rowKey: 'base', wholesalePriceMinor: '10.505' })] },
      'units.0.wholesalePriceMinor',
      'Use at most 2 decimal places.'
    ],
    [
      'a negative cost',
      { units: [row({ rowKey: 'base', defaultCostMinor: '-5' })] },
      'units.0.defaultCostMinor',
      'The amount cannot be negative.'
    ],
    [
      'a unit without a name',
      { units: [row({ rowKey: 'base', name: '' })] },
      'units.0.name',
      'Enter the unit name.'
    ],
    [
      'a base quantity that is not a whole number',
      { units: [row({ rowKey: 'base' }), row({ name: 'Box', baseQty: '2.5' })] },
      'units.1.baseQty',
      'Enter a whole number from 1 to 1,000,000.'
    ]
  ])('explains %s next to the field', (_label, overrides, path, message) => {
    expect(errorsOf(form(overrides))[path]).toEqual([message])
  })

  it('asks for whole amounts when the currency has no decimal places', () => {
    expect(
      errorsOf(form({ units: [row({ rowKey: 'base', retailPriceMinor: '10.5' })] }), 0)
    ).toEqual({
      'units.0.retailPriceMinor': ['Enter a whole amount.']
    })
  })

  it('checks the unit structure with the shared rules', () => {
    expect(
      errorsOf(
        form({
          units: [
            row({ rowKey: 'base' }),
            row({ name: 'Pack', baseQty: '4' }),
            row({ name: 'Box', baseQty: '6' })
          ]
        })
      )
    ).toEqual({ 'units.2.baseQty': ['Must be a whole multiple of 4 (Pack).'] })
    expect(
      errorsOf(form({ units: [row({ rowKey: 'base' }), row({ name: 'piece', baseQty: '12' })] }))
    ).toEqual({
      'units.0.name': ['Each unit needs a different name.'],
      'units.1.name': ['Each unit needs a different name.']
    })
    expect(errorsOf(form({ baseRowKey: 'gone' }))).toEqual({
      units: ['Choose the base unit: the smallest unit stock is counted in.']
    })
  })

  it('choosing a base unit makes its base quantity 1', () => {
    const values = form({
      units: [row({ rowKey: 'base' }), row({ rowKey: 'box', name: 'Box', baseQty: '24' })]
    })
    const next = chooseBaseRow(values.units, 'box')
    expect(next.map((unit) => unit.baseQty)).toEqual(['1', '1'])
  })

  it('lets a new row or an unused saved unit be removed, but never the base unit or a unit with stock history', () => {
    const saved = row({ rowKey: 'saved', unitId: 5, name: 'Box', baseQty: '24' })
    const fresh = row({ rowKey: 'fresh', name: 'Carton', baseQty: '240' })
    expect(canRemoveUnitRow(fresh, 'base', false)).toBe(true)
    expect(canRemoveUnitRow(saved, 'base', false)).toBe(true)
    expect(canRemoveUnitRow(fresh, 'base', true)).toBe(true)
    expect(canRemoveUnitRow(saved, 'base', true)).toBe(false)
    expect(canRemoveUnitRow(row({ rowKey: 'base' }), 'base', false)).toBe(false)
  })

  it('fills the edit form from a saved product, showing amounts as typed text', () => {
    const product: Product = {
      id: 3,
      code: 'P-003',
      name: 'Rice',
      companyId: null,
      companyName: null,
      companyActive: null,
      packingLabel: null,
      lowStockThresholdBase: 10,
      isActive: true,
      stockQtyBase: 0,
      hasStockMovements: false,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
      units: [
        {
          id: 11,
          name: 'Bag',
          shortName: null,
          baseQty: 10,
          isBase: false,
          canSell: true,
          canPurchase: true,
          wholesalePriceMinor: 125050,
          retailPriceMinor: null,
          defaultCostMinor: 0,
          sortOrder: 0,
          isActive: true
        },
        {
          id: 10,
          name: 'Kg',
          shortName: 'kg',
          baseQty: 1,
          isBase: true,
          canSell: true,
          canPurchase: false,
          wholesalePriceMinor: null,
          retailPriceMinor: 13000,
          defaultCostMinor: null,
          sortOrder: 1,
          isActive: true
        }
      ]
    }
    const values = productToFormValues(product, 2)
    expect(values).toMatchObject({
      code: 'P-003',
      companyId: NO_COMPANY,
      packingLabel: '',
      lowStockThresholdBase: '10'
    })
    expect(
      values.units.map((unit) => [
        unit.unitId,
        unit.name,
        unit.shortName,
        unit.baseQty,
        unit.wholesalePriceMinor,
        unit.retailPriceMinor,
        unit.defaultCostMinor
      ])
    ).toEqual([
      [11, 'Bag', '', '10', '1250.50', '', '0.00'],
      [10, 'Kg', 'kg', '1', '', '130.00', '']
    ])
    expect(values.baseRowKey).toBe(values.units[1].rowKey)
    const parsed = productFormSchema(2).parse(values)
    expect(toUpdateInput(3, parsed, 2)).toMatchObject({
      id: 3,
      units: [
        { id: 11, wholesalePriceMinor: 125050, defaultCostMinor: 0 },
        { id: 10, isBase: true, retailPriceMinor: 13000 }
      ]
    })
  })

  it('places the main process field errors on the form fields', () => {
    expect(
      serverFieldErrors({
        code: ['Another product already uses the code "P-001".'],
        'units.1.baseQty': ['Locked: stock has already been recorded for this product.'],
        'units.0.isBase': ['Locked: stock has already been recorded for this product.'],
        units: ['Box: make the unit inactive instead of removing it.'],
        currencyMinorDigits: ['Invalid']
      })
    ).toEqual([
      ['code', 'Another product already uses the code "P-001".'],
      ['units.1.baseQty', 'Locked: stock has already been recorded for this product.'],
      ['units.root', 'Locked: stock has already been recorded for this product.'],
      ['units.root', 'Box: make the unit inactive instead of removing it.'],
      ['root', 'Invalid']
    ])
    expect(serverFieldErrors(undefined)).toEqual([])
  })
})
