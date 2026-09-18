import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEACTIVATE_WITH_STOCK_WARNING,
  type ProductUnit,
  type ProductUnitInput
} from '@shared/products'
import type { Db } from '../db/adapter'
import {
  createSchemaDatabase,
  createTempDir,
  insertRow,
  rows,
  thrown,
  type TempDir
} from '../db/test-utils'
import { AppFailure } from '../errors'
import { createCompany, setCompanyActive } from './companies.service'
import {
  createProduct,
  getProduct,
  listProducts,
  searchProducts,
  setProductActive,
  updateProduct
} from './products.service'
import { hasMonetaryData, readSettings, updateEditableSettings } from './settings.service'

let temp: TempDir
let db: Db

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
})

afterEach(() => {
  temp.remove()
})

type AnyInput = Record<string, unknown>

function unit(overrides: Partial<ProductUnitInput> = {}): ProductUnitInput {
  return {
    id: null,
    name: 'Piece',
    shortName: 'Pcs',
    baseQty: 1,
    isBase: true,
    canSell: true,
    canPurchase: true,
    wholesalePriceMinor: null,
    retailPriceMinor: null,
    defaultCostMinor: null,
    isActive: true,
    ...overrides
  }
}

const box = (overrides: Partial<ProductUnitInput> = {}): ProductUnitInput =>
  unit({ name: 'Box', shortName: 'Box', baseQty: 24, isBase: false, ...overrides })

function input(overrides: AnyInput = {}): AnyInput {
  return {
    code: 'P-001',
    name: 'Tea 950g',
    companyId: null,
    packingLabel: '1*12*18',
    lowStockThresholdBase: 0,
    currencyMinorDigits: 2,
    units: [unit()],
    ...overrides
  }
}

function failure(fn: () => unknown): AppFailure['error'] {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

function counts(): { products: number; units: number } {
  return {
    products: db.get<{ n: number }>('SELECT count(*) AS n FROM products')!.n,
    units: db.get<{ n: number }>('SELECT count(*) AS n FROM product_units')!.n
  }
}

function unitRows(productId: number): unknown[] {
  return db.all(
    `SELECT id, name, short_name, base_qty, is_base, can_sell, can_purchase, wholesale_price_minor,
            retail_price_minor, default_cost_minor, sort_order, is_active
     FROM product_units WHERE product_id = ? ORDER BY sort_order`,
    [productId]
  )
}

let documents = 0

/** A posted stock receipt line of `qtyBase` base units, with its STOCK_IN movement. */
function recordStockIn(productId: number, unitId: number, qtyBase: number): void {
  documents++
  const receiptId = insertRow(
    db,
    'stock_receipts',
    rows.receipt({
      receipt_no: `GRN-${documents}`,
      request_id: `request-${documents}`,
      total_cost_minor: 0
    })
  )
  const itemId = insertRow(db, 'stock_receipt_items', {
    receipt_id: receiptId,
    line_no: 1,
    product_id: productId,
    unit_id: unitId,
    unit_name: 'Piece',
    unit_base_qty: 1,
    quantity: qtyBase,
    qty_base: qtyBase,
    unit_cost_minor: 0,
    line_cost_minor: 0
  })
  insertRow(db, 'stock_movements', {
    product_id: productId,
    movement_date: '2026-09-01',
    type: 'STOCK_IN',
    qty_base: qtyBase,
    value_minor: 0,
    receipt_item_id: itemId
  })
}

/** The update input of a saved product, as the edit form would send it back unchanged. */
function asUpdate(productId: number, overrides: AnyInput = {}): AnyInput {
  const product = getProduct(db, productId)
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    companyId: product.companyId,
    packingLabel: product.packingLabel,
    lowStockThresholdBase: product.lowStockThresholdBase,
    currencyMinorDigits: 2,
    units: product.units.map(unitOf),
    ...overrides
  }
}

function pieceAndBox(): number {
  return createProduct(
    db,
    input({
      units: [
        unit({ retailPriceMinor: 1100 }),
        box({ wholesalePriceMinor: 24000, retailPriceMinor: 25000, defaultCostMinor: 21600 })
      ]
    })
  ).id
}

describe('createProduct', () => {
  it('creates a product with one base unit; the packing text is kept exactly and nothing is derived from it', () => {
    const product = createProduct(
      db,
      input({ packingLabel: '  1*12*18  ', lowStockThresholdBase: 12 })
    )

    expect(product).toEqual({
      id: expect.any(Number),
      code: 'P-001',
      name: 'Tea 950g',
      companyId: null,
      companyName: null,
      companyActive: null,
      packingLabel: '1*12*18',
      lowStockThresholdBase: 12,
      isActive: true,
      stockQtyBase: 0,
      hasStockMovements: false,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      units: [
        {
          id: expect.any(Number),
          name: 'Piece',
          shortName: 'Pcs',
          baseQty: 1,
          isBase: true,
          canSell: true,
          canPurchase: true,
          wholesalePriceMinor: null,
          retailPriceMinor: null,
          defaultCostMinor: null,
          sortOrder: 0,
          isActive: true
        }
      ]
    })
    expect(counts()).toEqual({ products: 1, units: 1 })
  })

  it('creates a multi-unit product with integer minor-unit prices, in the order given', () => {
    const product = createProduct(
      db,
      input({
        packingLabel: null,
        units: [
          unit({ name: 'Carton', shortName: null, baseQty: 240, isBase: false, canSell: false }),
          box({ wholesalePriceMinor: 24000, retailPriceMinor: 0, defaultCostMinor: 21600 }),
          unit({ retailPriceMinor: 1100, canPurchase: false })
        ]
      })
    )

    expect(unitRows(product.id)).toEqual([
      expect.objectContaining({
        name: 'Carton',
        short_name: null,
        base_qty: 240,
        is_base: 0,
        can_sell: 0,
        sort_order: 0
      }),
      expect.objectContaining({
        name: 'Box',
        base_qty: 24,
        wholesale_price_minor: 24000,
        retail_price_minor: 0,
        default_cost_minor: 21600,
        sort_order: 1
      }),
      expect.objectContaining({
        name: 'Piece',
        base_qty: 1,
        is_base: 1,
        retail_price_minor: 1100,
        can_purchase: 0,
        sort_order: 2
      })
    ])
    expect(product.packingLabel).toBeNull()
  })

  it('links an active company', () => {
    const acme = createCompany(db, { name: 'Acme Foods' })
    expect(createProduct(db, input({ companyId: acme.id }))).toMatchObject({
      companyId: acme.id,
      companyName: 'Acme Foods',
      companyActive: true
    })
  })

  it('rejects a duplicate product code in any letter case, and writes nothing', () => {
    createProduct(db, input())
    expect(failure(() => createProduct(db, input({ code: ' p-001 ', name: 'Other' })))).toEqual({
      code: 'DUPLICATE',
      message: 'Another product already uses the code "p-001".',
      fieldErrors: { code: ['Another product already uses the code "p-001".'] }
    })
    expect(counts()).toEqual({ products: 1, units: 1 })
  })

  it.each<[string, ProductUnitInput[], string, string]>([
    [
      'sizes that do not nest (1, 4, 6)',
      [unit(), box({ name: 'Pack', baseQty: 4 }), box({ baseQty: 6 })],
      'units.2.baseQty',
      'Must be a whole multiple of 4 (Pack).'
    ],
    [
      'two units with one name',
      [unit(), box({ name: ' piece ' })],
      'units.1.name',
      'Each unit needs a different name.'
    ],
    [
      'two units of one size',
      [unit(), box(), box({ name: 'Pack' })],
      'units.2.baseQty',
      'Each unit needs a different base quantity.'
    ],
    [
      'no base unit',
      [unit({ isBase: false, baseQty: 2 }), box()],
      'units',
      'Choose the base unit: the smallest unit stock is counted in.'
    ],
    [
      'two base units',
      [unit(), box({ isBase: true, baseQty: 1, name: 'Loose' })],
      'units',
      'Only one unit can be the base unit.'
    ],
    [
      'a base unit of size 24',
      [unit({ baseQty: 24 })],
      'units.0.baseQty',
      'The base unit always has base quantity 1.'
    ],
    [
      'an inactive base unit',
      [unit({ isActive: false })],
      'units.0.isActive',
      'The base unit is always active.'
    ],
    ['no unit at all', [], 'units', 'Add at least one unit.'],
    [
      'a base quantity of 0',
      [unit(), box({ baseQty: 0 })],
      'units.1.baseQty',
      'Enter a whole number from 1 to 1,000,000.'
    ],
    [
      'a fractional base quantity',
      [unit(), box({ baseQty: 2.5 })],
      'units.1.baseQty',
      'Enter a whole number from 1 to 1,000,000.'
    ],
    [
      'a negative price',
      [unit({ retailPriceMinor: -1 })],
      'units.0.retailPriceMinor',
      'The amount cannot be negative.'
    ],
    [
      'a fractional minor-unit price',
      [unit({ wholesalePriceMinor: 10.5 })],
      'units.0.wholesalePriceMinor',
      'Enter a valid amount.'
    ],
    ['a blank unit name', [unit({ name: '  ' })], 'units.0.name', 'Enter the unit name.']
  ])('rejects %s with a clear message, and writes nothing', (_label, units, path, message) => {
    const error = failure(() => createProduct(db, input({ units })))
    expect(error.code).toBe('VALIDATION')
    expect(error.fieldErrors?.[path]).toContain(message)
    expect(counts()).toEqual({ products: 0, units: 0 })
  })

  it('is atomic: when a unit fails in the database, neither the product nor any unit is saved', () => {
    db.exec(
      "CREATE TRIGGER test_unit_failure BEFORE INSERT ON product_units WHEN NEW.name = 'Carton' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END"
    )
    expect(() =>
      createProduct(db, input({ units: [unit(), box(), box({ name: 'Carton', baseQty: 240 })] }))
    ).toThrow('simulated failure')
    expect(counts()).toEqual({ products: 0, units: 0 })
  })

  it('refuses a company that does not exist or is inactive', () => {
    expect(failure(() => createProduct(db, input({ companyId: 999 })))).toEqual({
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors: { companyId: ['This company no longer exists.'] }
    })
    const old = createCompany(db, { name: 'Old Brand' })
    setCompanyActive(db, { id: old.id, active: false })
    expect(failure(() => createProduct(db, input({ companyId: old.id }))).fieldErrors).toEqual({
      companyId: ['This company is inactive. Choose an active company or none.']
    })
    expect(counts()).toEqual({ products: 0, units: 0 })
  })

  it('refuses amounts entered with other currency decimal places than the current setting', () => {
    expect(failure(() => createProduct(db, input({ currencyMinorDigits: 3 })))).toEqual({
      code: 'CONFLICT',
      message:
        'The currency settings changed while the form was open. Close the form and try again.'
    })
    expect(counts()).toEqual({ products: 0, units: 0 })
  })

  it('refuses unit ids in a new product, and input that is not exactly the expected shape', () => {
    expect(
      failure(() => createProduct(db, input({ units: [unit({ id: 5 })] }))).fieldErrors
    ).toEqual({
      'units.0.id': ['A new product has only new units.']
    })
    expect(failure(() => createProduct(db, input({ isActive: false }))).code).toBe('VALIDATION')
    expect(
      failure(() => createProduct(db, input({ units: [{ ...unit(), sortOrder: 3 }] }))).code
    ).toBe('VALIDATION')
  })
})

describe('the currency decimal places lock (Phase 4C) follows the prices', () => {
  it('stays unlocked for products whose units have no price or cost', () => {
    createProduct(db, input({ units: [unit(), box()] }))
    expect(hasMonetaryData(db)).toBe(false)
    expect(updateEditableSettings(db, { 'currency.minorDigits': 0 })['currency.minorDigits']).toBe(
      0
    )
  })

  it.each(['wholesalePriceMinor', 'retailPriceMinor', 'defaultCostMinor'] as const)(
    'locks once a unit has a %s, even 0',
    (field) => {
      createProduct(db, input({ units: [unit({ [field]: 0 })] }))
      expect(hasMonetaryData(db)).toBe(true)
      expect(failure(() => updateEditableSettings(db, { 'currency.minorDigits': 0 })).code).toBe(
        'SETTING_LOCKED'
      )
      expect(readSettings(db)['currency.minorDigits']).toBe(2)
    }
  )

  it('locks when a price is added later by editing the product', () => {
    const id = createProduct(db, input()).id
    expect(hasMonetaryData(db)).toBe(false)
    const [piece] = getProduct(db, id).units
    updateProduct(db, asUpdate(id, { units: [{ ...unitOf(piece), retailPriceMinor: 5000 }] }))
    expect(hasMonetaryData(db)).toBe(true)
  })
})

function unitOf(saved: ProductUnit): ProductUnitInput {
  return {
    id: saved.id,
    name: saved.name,
    shortName: saved.shortName,
    baseQty: saved.baseQty,
    isBase: saved.isBase,
    canSell: saved.canSell,
    canPurchase: saved.canPurchase,
    wholesalePriceMinor: saved.wholesalePriceMinor,
    retailPriceMinor: saved.retailPriceMinor,
    defaultCostMinor: saved.defaultCostMinor,
    isActive: saved.isActive
  }
}

describe('updateProduct', () => {
  it('edits the basic fields and prices, and stamps updated_at', () => {
    const acme = createCompany(db, { name: 'Acme' })
    const id = pieceAndBox()
    db.run("UPDATE products SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [id])
    const [piece, boxUnit] = getProduct(db, id).units

    const updated = updateProduct(
      db,
      asUpdate(id, {
        code: 'P-001-A',
        name: 'Tea 900g',
        companyId: acme.id,
        packingLabel: '1*24',
        lowStockThresholdBase: 48,
        units: [
          { ...unitOf(piece), retailPriceMinor: 1150, wholesalePriceMinor: 0 },
          { ...unitOf(boxUnit), name: 'Dozen Box', retailPriceMinor: null, defaultCostMinor: 22000 }
        ]
      })
    )

    expect(updated).toMatchObject({
      code: 'P-001-A',
      name: 'Tea 900g',
      companyName: 'Acme',
      packingLabel: '1*24',
      lowStockThresholdBase: 48
    })
    expect(updated.updatedAt).not.toBe('2020-01-01T00:00:00.000Z')
    expect(
      updated.units.map((u) => [
        u.id,
        u.name,
        u.wholesalePriceMinor,
        u.retailPriceMinor,
        u.defaultCostMinor
      ])
    ).toEqual([
      [piece.id, 'Piece', 0, 1150, null],
      [boxUnit.id, 'Dozen Box', 24000, null, 22000]
    ])
  })

  it('allows its own code in another letter case, but not the code of another product', () => {
    const id = pieceAndBox()
    createProduct(db, input({ code: 'P-002' }))
    expect(updateProduct(db, asUpdate(id, { code: 'p-001' })).code).toBe('p-001')
    expect(failure(() => updateProduct(db, asUpdate(id, { code: 'P-002' }))).code).toBe('DUPLICATE')
  })

  it('reports a product that does not exist, and a unit of another product', () => {
    const id = pieceAndBox()
    const other = createProduct(db, input({ code: 'P-002' }))
    expect(failure(() => updateProduct(db, asUpdate(id, { id: 999 })))).toEqual({
      code: 'NOT_FOUND',
      message: 'This product no longer exists.'
    })
    const [piece, boxUnit] = getProduct(db, id).units
    const error = failure(() =>
      updateProduct(
        db,
        asUpdate(id, { units: [unitOf(piece), { ...unitOf(boxUnit), id: other.units[0].id }] })
      )
    )
    expect(error).toMatchObject({
      code: 'VALIDATION',
      fieldErrors: { 'units.1.id': ['This unit no longer exists.'] }
    })
  })

  it('keeps an inactive company it already has, but refuses switching to another inactive one', () => {
    const acme = createCompany(db, { name: 'Acme' })
    const old = createCompany(db, { name: 'Old' })
    const id = createProduct(db, input({ companyId: acme.id })).id
    setCompanyActive(db, { id: acme.id, active: false })
    setCompanyActive(db, { id: old.id, active: false })

    expect(updateProduct(db, asUpdate(id, { name: 'Renamed' }))).toMatchObject({
      companyId: acme.id,
      companyActive: false
    })
    expect(
      failure(() => updateProduct(db, asUpdate(id, { companyId: old.id }))).fieldErrors
    ).toEqual({
      companyId: ['This company is inactive. Choose an active company or none.']
    })
  })

  describe('before any stock movement', () => {
    it('may change a base quantity, the base unit, remove units and add units', () => {
      const id = pieceAndBox()
      const [piece, boxUnit] = getProduct(db, id).units

      const resized = updateProduct(
        db,
        asUpdate(id, { units: [unitOf(piece), { ...unitOf(boxUnit), baseQty: 12 }] })
      )
      expect(resized.units.map((u) => u.baseQty)).toEqual([1, 12])

      // The loose piece is dropped: the box becomes the base unit.
      const rebased = updateProduct(
        db,
        asUpdate(id, { units: [{ ...unitOf(boxUnit), baseQty: 1, isBase: true }] })
      )
      expect(rebased.units).toEqual([
        expect.objectContaining({ id: boxUnit.id, baseQty: 1, isBase: true })
      ])
      expect(counts().units).toBe(1)

      const grown = updateProduct(
        db,
        asUpdate(id, {
          units: [unitOf(rebased.units[0]), unit({ name: 'Carton', baseQty: 10, isBase: false })]
        })
      )
      expect(grown.units.map((u) => [u.name, u.baseQty, u.isBase])).toEqual([
        ['Box', 1, true],
        ['Carton', 10, false]
      ])
    })

    it('can swap names, sizes and the base unit between two units in one save', () => {
      const id = createProduct(
        db,
        input({ units: [unit({ name: 'Small' }), box({ name: 'Large', baseQty: 6 })] })
      ).id
      const [small, large] = getProduct(db, id).units

      const swapped = updateProduct(
        db,
        asUpdate(id, {
          units: [
            { ...unitOf(small), name: 'Large', baseQty: 6, isBase: false },
            { ...unitOf(large), name: 'Small', baseQty: 1, isBase: true }
          ]
        })
      )

      expect(swapped.units.map((u) => [u.id, u.name, u.baseQty, u.isBase])).toEqual([
        [small.id, 'Large', 6, false],
        [large.id, 'Small', 1, true]
      ])
    })
  })

  describe('after a stock movement', () => {
    function stocked(): { id: number; piece: ProductUnitInput; boxUnit: ProductUnitInput } {
      const id = pieceAndBox()
      const [piece, boxUnit] = getProduct(db, id).units
      recordStockIn(id, piece.id, 48)
      return { id, piece: unitOf(piece), boxUnit: unitOf(boxUnit) }
    }

    it('reports the lock on the product', () => {
      const { id } = stocked()
      expect(getProduct(db, id)).toMatchObject({ hasStockMovements: true, stockQtyBase: 48 })
    })

    it('rejects a change of an existing base quantity, and writes nothing', () => {
      const { id, piece, boxUnit } = stocked()
      const before = unitRows(id)
      expect(
        failure(() =>
          updateProduct(db, asUpdate(id, { units: [piece, { ...boxUnit, baseQty: 12 }] }))
        )
      ).toEqual({
        code: 'UNIT_LOCKED',
        message:
          'This product already has stock history, so the base quantity of its units cannot change.',
        fieldErrors: {
          'units.1.baseQty': ['Locked: stock has already been recorded for this product.']
        }
      })
      expect(unitRows(id)).toEqual(before)
    })

    it('rejects a change of the base unit', () => {
      const { id, piece, boxUnit } = stocked()
      const error = failure(() =>
        updateProduct(
          db,
          asUpdate(id, {
            units: [
              { ...piece, isBase: false, baseQty: 1, name: 'Piece' },
              { ...boxUnit, isBase: true }
            ]
          })
        )
      )
      // The structure check runs first when the new set is not even valid; a valid set that moves the base is locked.
      expect(['VALIDATION', 'UNIT_LOCKED']).toContain(error.code)

      const loose = unit({ name: 'Loose', baseQty: 1, isBase: true })
      const moved = failure(() =>
        updateProduct(
          db,
          asUpdate(id, { units: [{ ...piece, isBase: false, baseQty: 2 }, loose, boxUnit] })
        )
      )
      expect(moved.code).toBe('UNIT_LOCKED')
      expect(moved.message).toBe(
        'This product already has stock history, so its base unit cannot change.'
      )
    })

    it('rejects removing a unit, and suggests making it inactive', () => {
      const { id, piece } = stocked()
      expect(failure(() => updateProduct(db, asUpdate(id, { units: [piece] })))).toEqual({
        code: 'UNIT_LOCKED',
        message:
          'This product already has stock history, so its units cannot be removed. Make the unit inactive instead.',
        fieldErrors: { units: ['Box: make the unit inactive instead of removing it.'] }
      })
      expect(counts().units).toBe(2)
    })

    it('still allows names, short names, prices, costs, flags and active status to change', () => {
      const { id, piece, boxUnit } = stocked()
      const updated = updateProduct(
        db,
        asUpdate(id, {
          units: [
            {
              ...piece,
              name: 'Single',
              shortName: 'Sgl',
              retailPriceMinor: 1200,
              canPurchase: false
            },
            {
              ...boxUnit,
              wholesalePriceMinor: 25000,
              defaultCostMinor: null,
              canSell: false,
              isActive: false
            }
          ]
        })
      )
      expect(
        updated.units.map((u) => [
          u.name,
          u.shortName,
          u.baseQty,
          u.isBase,
          u.retailPriceMinor,
          u.wholesalePriceMinor,
          u.defaultCostMinor,
          u.canSell,
          u.canPurchase,
          u.isActive
        ])
      ).toEqual([
        ['Single', 'Sgl', 1, true, 1200, null, null, true, false, true],
        ['Box', 'Box', 24, false, 25000, 25000, null, false, true, false]
      ])
      expect(getProduct(db, id).stockQtyBase).toBe(48)
    })

    it('allows adding a larger compatible unit, but not an incompatible one', () => {
      const { id, piece, boxUnit } = stocked()
      const added = updateProduct(
        db,
        asUpdate(id, {
          units: [piece, boxUnit, unit({ name: 'Carton', baseQty: 240, isBase: false })]
        })
      )
      expect(added.units.map((u) => u.baseQty)).toEqual([1, 24, 240])

      const refreshed = getProduct(db, id).units.map(unitOf)
      const error = failure(() =>
        updateProduct(
          db,
          asUpdate(id, {
            units: [...refreshed, unit({ name: 'Crate', baseQty: 250, isBase: false })]
          })
        )
      )
      expect(error.code).toBe('VALIDATION')
      expect(error.fieldErrors?.['units.3.baseQty']).toEqual([
        'Must be a whole multiple of 240 (Carton).'
      ])
    })
  })
})

describe('setProductActive', () => {
  it('deactivates and reactivates a product without stock, with no warning', () => {
    const id = pieceAndBox()
    expect(setProductActive(db, { id, active: false })).toEqual({
      id,
      isActive: false,
      stockQtyBase: 0,
      warning: null
    })
    expect(getProduct(db, id).isActive).toBe(false)
    expect(setProductActive(db, { id, active: true })).toEqual({
      id,
      isActive: true,
      stockQtyBase: 0,
      warning: null
    })
  })

  it('allows deactivating a product with stock, with the warning, and keeps its stock and history', () => {
    const id = pieceAndBox()
    recordStockIn(id, getProduct(db, id).units[0].id, 30)
    expect(setProductActive(db, { id, active: false })).toEqual({
      id,
      isActive: false,
      stockQtyBase: 30,
      warning: DEACTIVATE_WITH_STOCK_WARNING
    })
    expect(getProduct(db, id)).toMatchObject({ isActive: false, stockQtyBase: 30 })
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM stock_movements')!.n).toBe(1)
  })

  it('reports a product that does not exist', () => {
    expect(failure(() => setProductActive(db, { id: 404, active: false })).code).toBe('NOT_FOUND')
  })
})

describe('listProducts and searchProducts', () => {
  let acme: number
  let bolt: number

  beforeEach(() => {
    acme = createCompany(db, { name: 'Acme Foods' }).id
    bolt = createCompany(db, { name: 'Bolt Traders' }).id
    const make = (code: string, name: string, companyId: number | null): number =>
      createProduct(db, input({ code, name, companyId, units: [unit({ retailPriceMinor: 100 })] }))
        .id
    make('TEA-01', 'Green Tea 100g', acme)
    make('TEA-02', 'Black Tea 250g', acme)
    make('SUG-01', 'Sugar 1kg', bolt)
    make('RICE_5', '50% Rice Mix', null)
    const old = make('OLD-01', 'Old Biscuit', bolt)
    setProductActive(db, { id: old, active: false })
  })

  const list = (overrides: AnyInput = {}): ReturnType<typeof listProducts> =>
    listProducts(db, {
      page: 1,
      pageSize: 25,
      search: '',
      companyId: null,
      status: 'all',
      ...overrides
    })
  const codes = (overrides: AnyInput = {}): string[] =>
    list(overrides).items.map((item) => item.code)

  it('lists by name, with company, stock from v_product_stock and units', () => {
    const page = list()
    expect(page.total).toBe(5)
    expect(page.items.map((item) => item.name)).toEqual([
      '50% Rice Mix',
      'Black Tea 250g',
      'Green Tea 100g',
      'Old Biscuit',
      'Sugar 1kg'
    ])
    expect(page.items[1]).toMatchObject({
      code: 'TEA-02',
      companyName: 'Acme Foods',
      companyActive: true,
      stockQtyBase: 0,
      units: [expect.objectContaining({ name: 'Piece', retailPriceMinor: 100 })]
    })
  })

  it('shows the stock of a product with movements', () => {
    const tea = list({ search: 'TEA-01' }).items[0]
    recordStockIn(tea.id, tea.units[0].id, 72)
    expect(list({ search: 'TEA-01' }).items[0].stockQtyBase).toBe(72)
  })

  it.each<[string, string, string[]]>([
    ['a code', 'sug-01', ['SUG-01']],
    ['part of a code', 'tea-0', ['TEA-02', 'TEA-01']],
    ['a product name in any case', 'GREEN tea', ['TEA-01']],
    ['a company name', 'acme', ['TEA-02', 'TEA-01']],
    ['words from company and product', 'bolt sugar', ['SUG-01']],
    ['% and _ as plain characters', '50%', ['RICE_5']],
    ['an underscore', 'e_', ['RICE_5']],
    ['nothing that matches', 'coffee', []]
  ])('searches by %s', (_label, search, expected) => {
    expect(codes({ search })).toEqual(expected)
  })

  it('filters by status and company', () => {
    expect(codes({ status: 'active' })).not.toContain('OLD-01')
    expect(codes({ status: 'inactive' })).toEqual(['OLD-01'])
    expect(codes({ companyId: bolt })).toEqual(['OLD-01', 'SUG-01'])
    expect(codes({ companyId: bolt, status: 'active' })).toEqual(['SUG-01'])
  })

  it('pages the results with the total', () => {
    expect(list({ pageSize: 2, page: 1 })).toMatchObject({ total: 5, page: 1, pageSize: 2 })
    expect(codes({ pageSize: 2, page: 2 })).toEqual(['TEA-01', 'OLD-01'])
    expect(codes({ pageSize: 2, page: 3 })).toEqual(['SUG-01'])
    expect(codes({ pageSize: 2, page: 4 })).toEqual([])
  })

  it('refuses a page size above 100 and unknown filters', () => {
    expect(failure(() => list({ pageSize: 101 })).code).toBe('VALIDATION')
    expect(failure(() => list({ sql: 'DROP TABLE products' })).code).toBe('VALIDATION')
  })

  it('search puts an exact code first, skips inactive products unless asked, and respects the limit', () => {
    const find = (query: string, overrides: AnyInput = {}): string[] =>
      searchProducts(db, { query, limit: 10, includeInactive: false, ...overrides }).map(
        (item) => item.code
      )
    createProduct(db, input({ code: 'TEA', name: 'Assorted Tea' }))
    expect(find('tea')).toEqual(['TEA', 'TEA-01', 'TEA-02'])
    expect(find('biscuit')).toEqual([])
    expect(find('biscuit', { includeInactive: true })).toEqual(['OLD-01'])
    expect(find('tea', { limit: 1 })).toEqual(['TEA'])
    expect(searchProducts(db, { query: 'sug', limit: 5, includeInactive: false })).toEqual([
      {
        id: expect.any(Number),
        code: 'SUG-01',
        name: 'Sugar 1kg',
        companyName: 'Bolt Traders',
        packingLabel: '1*12*18',
        isActive: true
      }
    ])
  })

  it('search with nothing typed browses the whole catalogue by name', () => {
    const browse = (overrides: AnyInput = {}): string[] =>
      searchProducts(db, { query: '', limit: 10, includeInactive: false, ...overrides }).map(
        (item) => item.code
      )
    expect(browse()).toEqual(['RICE_5', 'TEA-02', 'TEA-01', 'SUG-01'])
    expect(browse({ includeInactive: true })).toEqual([
      'RICE_5',
      'TEA-02',
      'TEA-01',
      'OLD-01',
      'SUG-01'
    ])
    expect(browse({ limit: 2 })).toEqual(['RICE_5', 'TEA-02'])
  })

  it('getProduct reports a product that does not exist', () => {
    expect(failure(() => getProduct(db, 12345))).toEqual({
      code: 'NOT_FOUND',
      message: 'This product no longer exists.'
    })
  })
})
