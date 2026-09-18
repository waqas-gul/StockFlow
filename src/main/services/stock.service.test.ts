import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Product, ProductUnitInput } from '@shared/products'
import {
  LATE_COST_CORRECTION_WARNING,
  RECEIPT_LOCKED_MESSAGE,
  type StockAdjustmentInput,
  type StockReceiptLineInput
} from '@shared/stock'
import type { Db, SqlParams } from '../db/adapter'
import {
  createSchemaDatabase,
  createTempDir,
  insertRow,
  rows,
  thrown,
  type Masters,
  type TempDir
} from '../db/test-utils'
import { AppFailure } from '../errors'
import { assertStockInvariants } from './inventory'
import { createProduct, getProduct, listProducts, updateProduct } from './products.service'
import {
  adjustStock,
  getReceipt,
  listAdjustments,
  listReceipts,
  postingFloor,
  receiveStock,
  stockCard,
  stockSummary,
  voidReceipt
} from './stock.service'

// Test data lives only in temporary databases.

const NOW = new Date(2026, 8, 16, 10, 30, 0)
const TODAY = '2026-09-16'

let temp: TempDir
let db: Db
let requests: number
/** Tea: Piece (base) and Box of 24, both purchasable. */
let tea: Product
/** Sugar: Kg (base) only. */
let sugar: Product
/** Rice: Bag (base) only. */
let rice: Product
let sales: number

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  requests = 0
  sales = 0
  tea = product('P-001', 'Tea 950g', [
    unit({ name: 'Piece', shortName: 'Pcs', defaultCostMinor: 10000 }),
    unit({ name: 'Box', shortName: 'Box', baseQty: 24, isBase: false, defaultCostMinor: 240000 })
  ])
  sugar = product('S-001', 'Sugar 1kg', [unit({ name: 'Kg', shortName: null })])
  rice = product('R-001', 'Rice 5kg', [unit({ name: 'Bag', shortName: null })])
})

afterEach(() => {
  temp.remove()
})

function unit(overrides: Partial<ProductUnitInput>): ProductUnitInput {
  return {
    id: null,
    name: 'Piece',
    shortName: null,
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

function product(code: string, name: string, units: ProductUnitInput[]): Product {
  return createProduct(db, {
    code,
    name,
    companyId: null,
    packingLabel: '1*12*18',
    lowStockThresholdBase: 0,
    currencyMinorDigits: 2,
    units
  })
}

function unitId(item: Product, name: string): number {
  const found = item.units.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`No unit ${name}`)
  return found.id
}

/** The saved units of `item` as update input, each changed by `change`. */
function unitInputs(
  item: Product,
  change: (unitInput: ProductUnitInput) => Partial<ProductUnitInput>
): ProductUnitInput[] {
  return item.units.map((saved) => {
    const input: ProductUnitInput = {
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
    return { ...input, ...change(input) }
  })
}

const piece = (): number => unitId(tea, 'Piece')
const box = (): number => unitId(tea, 'Box')
const kg = (): number => unitId(sugar, 'Kg')
const bag = (): number => unitId(rice, 'Bag')

function nextRequestId(): string {
  requests++
  return `request-${String(requests).padStart(4, '0')}`
}

function line(
  productId: number,
  unitIdValue: number,
  quantity: number,
  unitCostMinor: number
): StockReceiptLineInput {
  return { productId, unitId: unitIdValue, quantity, unitCostMinor }
}

function receiptInput(
  lines: StockReceiptLineInput[],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    requestId: nextRequestId(),
    receiptDate: TODAY,
    supplierName: 'Acme Distributor',
    reference: 'Bill 77',
    note: null,
    currencyMinorDigits: 2,
    lines,
    ...overrides
  }
}

function receive(
  lines: StockReceiptLineInput[],
  overrides: Record<string, unknown> = {}
): ReturnType<typeof receiveStock> {
  return receiveStock(db, receiptInput(lines, overrides), NOW)
}

function adjustmentInput(overrides: Partial<StockAdjustmentInput>): StockAdjustmentInput {
  return {
    requestId: nextRequestId(),
    adjustmentDate: TODAY,
    productId: tea.id,
    reason: 'DAMAGE',
    direction: null,
    unitId: piece(),
    quantity: 1,
    unitCostMinor: null,
    receiptItemId: null,
    reasonNote: 'Checked on the shelf',
    currencyMinorDigits: 2,
    ...overrides
  }
}

function adjust(overrides: Partial<StockAdjustmentInput>): ReturnType<typeof adjustStock> {
  return adjustStock(db, adjustmentInput(overrides), NOW)
}

function failure(fn: () => unknown): AppFailure['error'] {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

/** Q and V from v_product_stock. */
function position(productId: number): { qtyBase: number; valueMinor: number } {
  const row = db.get<{ qty_base: number; value_minor: number }>(
    'SELECT qty_base, value_minor FROM v_product_stock WHERE product_id = ?',
    [productId]
  )!
  return { qtyBase: row.qty_base, valueMinor: row.value_minor }
}

function count(table: string): number {
  return db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n
}

function nextSequence(name: string): number {
  return db.get<{ next_value: number }>('SELECT next_value FROM sequences WHERE name = ?', [name])!
    .next_value
}

function movements(productId: number): Array<Record<string, unknown>> {
  return db.all(
    'SELECT movement_date, type, qty_base, value_minor FROM stock_movements WHERE product_id = ? ORDER BY id',
    [productId]
  )
}

/** A posted invoice line of `qtyBase` base units of `productId` with its SALE movement: a Phase 8 stand-in. */
function simulateSale(productId: number, qtyBase: number, valueMinor: number, date = TODAY): void {
  sales++
  const masters = { customerId: 1, productId } as Masters
  const invoiceId = insertRow(
    db,
    'invoices',
    rows.invoice(masters, {
      invoice_no: `INV-T${sales}`,
      seq_no: sales,
      request_id: `sale-request-${sales}`,
      invoice_date: date,
      cogs_minor: valueMinor
    })
  )
  const itemId = insertRow(
    db,
    'invoice_items',
    rows.invoiceItem(masters, invoiceId, {
      qty_base: qtyBase,
      scheme_qty_base: 0,
      cost_minor: valueMinor
    })
  )
  insertRow(db, 'stock_movements', {
    product_id: productId,
    movement_date: date,
    type: 'SALE',
    qty_base: -qtyBase,
    value_minor: -valueMinor,
    invoice_item_id: itemId
  })
}

/** `db`, except that the `failAt`-th statement matching `pattern` throws, as a disk failure would. */
function failingDb(pattern: RegExp, failAt = 1): Db {
  let seen = 0
  return new Proxy(db, {
    get(target, property) {
      if (property === 'run') {
        return (sql: string, params?: SqlParams) => {
          if (pattern.test(sql) && ++seen === failAt) throw new Error('simulated write failure')
          return target.run(sql, params)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

describe('receiveStock', () => {
  it('posts a one-line receipt: numbered, dated, converted to base units, with one STOCK_IN movement', () => {
    const receipt = receive([line(tea.id, box(), 10, 240000)])

    expect(receipt).toMatchObject({
      receiptNo: 'GRN-000001',
      receiptDate: TODAY,
      supplierName: 'Acme Distributor',
      reference: 'Bill 77',
      note: null,
      totalCostMinor: 2400000,
      status: 'POSTED',
      lineCount: 1,
      voidable: true,
      voidReason: null,
      voidDate: null,
      corrections: []
    })
    expect(receipt.lines).toEqual([
      {
        id: expect.any(Number),
        lineNo: 1,
        productId: tea.id,
        productCode: 'P-001',
        productName: 'Tea 950g',
        unitId: box(),
        unitName: 'Box',
        unitBaseQty: 24,
        quantity: 10,
        qtyBase: 240,
        unitCostMinor: 240000,
        lineCostMinor: 2400000,
        correctedLineCostMinor: 2400000,
        laterActivity: false
      }
    ])
    expect(movements(tea.id)).toEqual([
      { movement_date: TODAY, type: 'STOCK_IN', qty_base: 240, value_minor: 2400000 }
    ])
    expect(position(tea.id)).toEqual({ qtyBase: 240, valueMinor: 2400000 })
    expect(nextSequence('receipt')).toBe(2)
  })

  it('posts several lines, including the same product twice in different purchasable units', () => {
    const receipt = receive([
      line(tea.id, box(), 2, 240000),
      line(sugar.id, kg(), 10, 15000),
      line(tea.id, piece(), 5, 11000),
      line(tea.id, box(), 1, 250000)
    ])
    expect(
      receipt.lines.map((item) => [
        item.lineNo,
        item.productCode,
        item.unitName,
        item.qtyBase,
        item.lineCostMinor
      ])
    ).toEqual([
      [1, 'P-001', 'Box', 48, 480000],
      [2, 'S-001', 'Kg', 10, 150000],
      [3, 'P-001', 'Piece', 5, 55000],
      [4, 'P-001', 'Box', 24, 250000]
    ])
    expect(receipt.totalCostMinor).toBe(935000)
    expect(movements(tea.id).map((row) => row.qty_base)).toEqual([48, 5, 24])
    expect(position(tea.id)).toEqual({ qtyBase: 77, valueMinor: 785000 })
    expect(position(sugar.id)).toEqual({ qtyBase: 10, valueMinor: 150000 })
    expect(position(rice.id)).toEqual({ qtyBase: 0, valueMinor: 0 })
  })

  it('accepts zero-cost stock: positive quantity with zero value is valid', () => {
    const receipt = receive([line(tea.id, piece(), 12, 0)], { supplierName: 'Supplier bonus' })
    expect(receipt.totalCostMinor).toBe(0)
    expect(position(tea.id)).toEqual({ qtyBase: 12, valueMinor: 0 })
  })

  it('keeps the entered supplier, reference and note as text, trimmed, blank as none', () => {
    const receipt = receive([line(tea.id, piece(), 1, 100)], {
      supplierName: '  Ali Traders ',
      reference: '',
      note: 'Paid cash'
    })
    expect(receipt).toMatchObject({
      supplierName: 'Ali Traders',
      reference: null,
      note: 'Paid cash'
    })
  })

  it('refuses units that are not active, purchasable units of the product, and inactive or missing products', () => {
    const noPurchase = updateProduct(db, {
      id: tea.id,
      code: tea.code,
      name: tea.name,
      companyId: null,
      packingLabel: tea.packingLabel,
      lowStockThresholdBase: 0,
      currencyMinorDigits: 2,
      units: unitInputs(tea, (item) => ({ canPurchase: item.name !== 'Box' }))
    })
    const boxId = unitId(noPurchase, 'Box')
    db.run('UPDATE product_units SET is_active = 0 WHERE id = ?', [kg()])
    db.run('UPDATE products SET is_active = 0 WHERE id = ?', [rice.id])

    const error = failure(() =>
      receive([
        line(tea.id, boxId, 1, 100),
        line(sugar.id, kg(), 1, 100),
        line(tea.id, bag(), 1, 100),
        line(rice.id, bag(), 1, 100),
        line(9999, piece(), 1, 100)
      ])
    )
    expect(error).toMatchObject({ code: 'VALIDATION' })
    expect(error.fieldErrors).toEqual({
      'lines.0.unitId': ['Box cannot be purchased. Choose a purchasable unit.'],
      'lines.1.unitId': ['This unit is inactive.'],
      'lines.2.unitId': ['This unit does not belong to the product.'],
      'lines.3.productId': ['Rice 5kg is inactive.'],
      'lines.4.productId': ['This product no longer exists.']
    })
    expect(count('stock_receipts')).toBe(0)
    expect(nextSequence('receipt')).toBe(1)
  })

  it('validates the request again in the main process', () => {
    expect(failure(() => receiveStock(db, { ...receiptInput([]), lines: [] }, NOW))).toMatchObject({
      code: 'VALIDATION',
      fieldErrors: { lines: ['Add at least one product line.'] }
    })
    expect(failure(() => receive([{ ...line(tea.id, piece(), 0, -1) }])).fieldErrors).toEqual({
      'lines.0.quantity': ['Enter a whole number from 1 to 1,000,000.'],
      'lines.0.unitCostMinor': ['The amount cannot be negative.']
    })
    expect(
      failure(() => receive([line(tea.id, piece(), 1, 1)], { receiptDate: '2026-02-30' }))
        .fieldErrors
    ).toEqual({
      receiptDate: ['Enter a valid date.']
    })
  })

  it('refuses costs entered with other currency decimal places than the current setting', () => {
    expect(
      failure(() => receive([line(tea.id, piece(), 1, 1)], { currencyMinorDigits: 3 }))
    ).toMatchObject({
      code: 'CONFLICT'
    })
    expect(count('stock_receipts')).toBe(0)
  })

  it('rolls everything back when a write fails part-way: no header, lines, movements or number are left', () => {
    const failing = failingDb(/INSERT INTO stock_movements/, 2)
    expect(() =>
      receiveStock(
        failing,
        receiptInput([line(tea.id, box(), 1, 100), line(sugar.id, kg(), 1, 100)]),
        NOW
      )
    ).toThrow('simulated write failure')
    expect([
      count('stock_receipts'),
      count('stock_receipt_items'),
      count('stock_movements')
    ]).toEqual([0, 0, 0])
    expect(nextSequence('receipt')).toBe(1)
    // The number the failed receipt had allocated is used by the next one.
    expect(receive([line(tea.id, box(), 1, 100)]).receiptNo).toBe('GRN-000001')
  })

  it('saves one receipt for a repeated request id and returns it again', () => {
    const input = receiptInput([line(tea.id, box(), 3, 240000)])
    const first = receiveStock(db, input, NOW)
    const again = receiveStock(db, input, NOW)
    const changed = receiveStock(db, { ...input, lines: [line(sugar.id, kg(), 9, 1)] }, NOW)
    expect(again).toEqual(first)
    expect(changed).toEqual(first)
    expect([count('stock_receipts'), count('stock_movements')]).toEqual([1, 1])
    expect(position(tea.id)).toEqual({ qtyBase: 72, valueMinor: 720000 })
    expect(nextSequence('receipt')).toBe(2)
  })

  it('numbers receipts in sequence', () => {
    expect(receive([line(tea.id, piece(), 1, 1)]).receiptNo).toBe('GRN-000001')
    expect(receive([line(tea.id, piece(), 1, 1)]).receiptNo).toBe('GRN-000002')
  })
})

describe('posting dates (per-product floor)', () => {
  it('refuses a future date', () => {
    expect(
      failure(() => receive([line(tea.id, piece(), 1, 1)], { receiptDate: '2026-09-17' }))
    ).toMatchObject({
      code: 'DATE_NOT_ALLOWED',
      message: 'The date cannot be later than today (16-Sep-2026).',
      fieldErrors: { receiptDate: ['The date cannot be later than today (16-Sep-2026).'] }
    })
  })

  it('allows a backdated document while only unrelated products have later activity', () => {
    receive([line(tea.id, piece(), 5, 100)], { receiptDate: '2026-09-15' })
    expect(receive([line(sugar.id, kg(), 5, 100)], { receiptDate: '2026-09-10' }).receiptDate).toBe(
      '2026-09-10'
    )
    expect(
      adjust({ productId: sugar.id, unitId: kg(), adjustmentDate: '2026-09-12' }).adjustmentDate
    ).toBe('2026-09-12')
  })

  it('refuses a date before the latest activity of an affected product, naming the product and date', () => {
    receive([line(tea.id, piece(), 5, 100)], { receiptDate: '2026-09-15' })
    const message = 'P-001 Tea 950g has stock activity on 15-Sep-2026. Use that date or later.'
    expect(
      failure(() =>
        receive([line(sugar.id, kg(), 1, 1), line(tea.id, piece(), 1, 1)], {
          receiptDate: '2026-09-14'
        })
      )
    ).toEqual({
      code: 'DATE_NOT_ALLOWED',
      message,
      fieldErrors: { receiptDate: [message] },
      details: { earliestDate: '2026-09-15', productId: tea.id }
    })
    expect(failure(() => adjust({ adjustmentDate: '2026-09-14' }))).toMatchObject({
      code: 'DATE_NOT_ALLOWED',
      fieldErrors: { adjustmentDate: [message] }
    })
    expect(receive([line(tea.id, piece(), 1, 1)], { receiptDate: '2026-09-15' }).receiptDate).toBe(
      '2026-09-15'
    )
  })

  it('reports the posting floor for the chosen products', () => {
    expect(postingFloor(db, { productIds: [tea.id, sugar.id] }, NOW)).toEqual({
      today: TODAY,
      earliestDate: null,
      setBy: null,
      supplierSetBy: null
    })
    receive([line(sugar.id, kg(), 1, 1)], { receiptDate: '2026-09-12' })
    receive([line(tea.id, piece(), 1, 1)], { receiptDate: '2026-09-14' })
    expect(postingFloor(db, { productIds: [tea.id, sugar.id, rice.id] }, NOW)).toEqual({
      today: TODAY,
      earliestDate: '2026-09-14',
      setBy: { productId: tea.id, productCode: 'P-001', productName: 'Tea 950g' },
      supplierSetBy: null
    })
    expect(postingFloor(db, { productIds: [rice.id] }, NOW).earliestDate).toBeNull()
  })
})

describe('inventory valuation (moving weighted average)', () => {
  it('sums quantity and value over the movements, and takes OUT value at the average', () => {
    receive([line(tea.id, piece(), 10, 100)])
    receive([line(tea.id, piece(), 10, 150)])
    expect(position(tea.id)).toEqual({ qtyBase: 20, valueMinor: 2500 })

    const damage = adjust({ reason: 'DAMAGE', unitId: piece(), quantity: 3 })
    // round_half_up(2,500 × 3 / 20) = 375
    expect(damage).toMatchObject({ direction: 'OUT', qtyBase: 3, valueMinor: -375, warning: null })
    expect(position(tea.id)).toEqual({ qtyBase: 17, valueMinor: 2125 })
  })

  it('rounds half up per outflow, and the final outflow removes exactly the remaining value', () => {
    receive([line(tea.id, piece(), 1, 0), line(tea.id, piece(), 1, 67)])
    // Q 2, V 67: one out = round_half_up(33.5) = 34, never 33
    expect(adjust({ reason: 'EXPIRY', quantity: 1 }).valueMinor).toBe(-34)
    // Q 1, V 33: the last one takes exactly what is left
    expect(adjust({ reason: 'SHORTAGE', quantity: 1 }).valueMinor).toBe(-33)
    expect(position(tea.id)).toEqual({ qtyBase: 0, valueMinor: 0 })

    receive([line(tea.id, piece(), 7, 0), line(tea.id, piece(), 1, 151)])
    // Q 8, V 151: 3 out = round(56.625) = 57; then Q 5, V 94: all 5 out = exactly 94
    expect(adjust({ reason: 'DAMAGE', quantity: 3 }).valueMinor).toBe(-57)
    expect(adjust({ reason: 'DAMAGE', quantity: 5 }).valueMinor).toBe(-94)
    expect(position(tea.id)).toEqual({ qtyBase: 0, valueMinor: 0 })
  })

  it('keeps zero-value inventory at zero value through outflows', () => {
    receive([line(tea.id, box(), 1, 0)])
    expect(adjust({ reason: 'DAMAGE', quantity: 4 }).valueMinor).toBe(0)
    expect(position(tea.id)).toEqual({ qtyBase: 20, valueMinor: 0 })
  })

  it('never lets stock go negative: INSUFFICIENT_STOCK, nothing written, no number used', () => {
    receive([line(tea.id, box(), 1, 240000)])
    const error = failure(() => adjust({ reason: 'SHORTAGE', unitId: box(), quantity: 2 }))
    expect(error).toEqual({
      code: 'INSUFFICIENT_STOCK',
      message: 'Only 1 Box of P-001 Tea 950g is in stock; 2 Box cannot be removed.',
      fieldErrors: { quantity: ['Only 1 Box is in stock.'] },
      details: { productId: tea.id, requiredQtyBase: 48, availableQtyBase: 24 }
    })
    expect(failure(() => adjust({ productId: sugar.id, unitId: kg(), quantity: 1 })).code).toBe(
      'INSUFFICIENT_STOCK'
    )
    expect(count('stock_adjustments')).toBe(0)
    expect(nextSequence('adjustment')).toBe(1)
    expect(position(tea.id)).toEqual({ qtyBase: 24, valueMinor: 240000 })
  })

  it('assertStockInvariants refuses Q < 0, V < 0 and value left without stock', () => {
    receive([line(tea.id, piece(), 2, 100), line(sugar.id, kg(), 2, 100)])
    simulateSale(tea.id, 3, 200)
    expect(failure(() => assertStockInvariants(db, [tea.id]))).toMatchObject({
      code: 'INSUFFICIENT_STOCK'
    })
    simulateSale(sugar.id, 2, 150)
    expect(failure(() => assertStockInvariants(db, [sugar.id]))).toMatchObject({
      code: 'FORBIDDEN_STATE',
      message:
        'This change would leave the stock value of S-001 Sugar 1kg inconsistent, so nothing was saved.'
    })
    expect(() => assertStockInvariants(db, [rice.id])).not.toThrow()
  })
})

describe('voidReceipt', () => {
  function voidIt(id: number, reason = 'Keyed twice'): ReturnType<typeof voidReceipt> {
    return voidReceipt(db, { id, reason }, NOW)
  }

  it('reverses a fresh receipt exactly: one STOCK_IN_VOID per line, back to the prior Q and V', () => {
    receive([line(tea.id, piece(), 7, 130)])
    const before = [position(tea.id), position(sugar.id)]
    const receipt = receive([
      line(tea.id, box(), 2, 240000),
      line(sugar.id, kg(), 10, 15000),
      line(tea.id, piece(), 5, 11000)
    ])

    const voided = voidIt(receipt.id)

    expect(voided).toMatchObject({
      status: 'VOID',
      voidReason: 'Keyed twice',
      voidDate: TODAY,
      voidable: false
    })
    expect([position(tea.id), position(sugar.id)]).toEqual(before)
    expect(movements(tea.id).slice(1)).toEqual([
      { movement_date: TODAY, type: 'STOCK_IN', qty_base: 48, value_minor: 480000 },
      { movement_date: TODAY, type: 'STOCK_IN', qty_base: 5, value_minor: 55000 },
      { movement_date: TODAY, type: 'STOCK_IN_VOID', qty_base: -48, value_minor: -480000 },
      { movement_date: TODAY, type: 'STOCK_IN_VOID', qty_base: -5, value_minor: -55000 }
    ])
  })

  it('restores the prior position exactly even when the average changed in between (never voids at the current average)', () => {
    receive([line(tea.id, piece(), 3, 100)])
    const receipt = receive([line(tea.id, piece(), 7, 333)])
    voidIt(receipt.id)
    expect(position(tea.id)).toEqual({ qtyBase: 3, valueMinor: 300 })
  })

  it('a receipt with the same product on several lines stays voidable: its own lines never lock it', () => {
    const r7 = receive([
      line(tea.id, box(), 2, 2400),
      line(sugar.id, kg(), 10, 50),
      line(tea.id, piece(), 5, 110)
    ])
    expect(getReceipt(db, r7.id).voidable).toBe(true)
    expect(voidIt(r7.id).status).toBe('VOID')
    expect(position(tea.id)).toEqual({ qtyBase: 0, valueMinor: 0 })
  })

  it('stays voidable when only an unrelated product has later activity', () => {
    const receipt = receive([line(tea.id, piece(), 5, 100), line(sugar.id, kg(), 5, 100)])
    receive([line(rice.id, bag(), 5, 100)])
    adjust({ productId: rice.id, unitId: bag(), quantity: 1 })
    simulateSale(rice.id, 1, 100)
    expect(getReceipt(db, receipt.id).voidable).toBe(true)
    expect(voidIt(receipt.id).status).toBe('VOID')
  })

  it.each([
    [
      'a later receipt of one of its products',
      (): void => void receive([line(sugar.id, kg(), 1, 1)])
    ],
    [
      'a later adjustment of one of its products',
      (): void => void adjust({ productId: tea.id, unitId: piece(), quantity: 1 })
    ],
    ['a later sale of one of its products', (): void => simulateSale(sugar.id, 1, 100)]
  ])('is locked by %s', (_, laterActivity) => {
    const receipt = receive([line(tea.id, piece(), 5, 100), line(sugar.id, kg(), 5, 100)])
    laterActivity()
    const detail = getReceipt(db, receipt.id)
    expect(detail.voidable).toBe(false)
    const before = [position(tea.id), position(sugar.id)]
    expect(failure(() => voidIt(receipt.id))).toMatchObject({
      code: 'FORBIDDEN_STATE',
      message: RECEIPT_LOCKED_MESSAGE
    })
    expect([position(tea.id), position(sugar.id)]).toEqual(before)
    expect(getReceipt(db, receipt.id).status).toBe('POSTED')
  })

  it('is locked by a correction linked to it, and shows which lines had later activity', () => {
    const receipt = receive([line(tea.id, piece(), 5, 100), line(sugar.id, kg(), 5, 100)])
    adjust({
      reason: 'RECEIPT_QTY_CORRECTION',
      direction: 'OUT',
      unitId: kg(),
      productId: sugar.id,
      quantity: 1,
      receiptItemId: receipt.lines[1].id
    })
    const detail = getReceipt(db, receipt.id)
    expect(detail.voidable).toBe(false)
    expect(detail.lines.map((item) => item.laterActivity)).toEqual([false, true])
  })

  it('rejects the plan §8.5 counter-example: void after the stock was sold and received again', () => {
    const r1 = receive([line(tea.id, piece(), 10, 100)])
    simulateSale(tea.id, 10, 1000)
    receive([line(tea.id, piece(), 10, 150)])
    expect(failure(() => voidIt(r1.id)).code).toBe('FORBIDDEN_STATE')
    expect(position(tea.id)).toEqual({ qtyBase: 10, valueMinor: 1500 })
  })

  it('rejects a second void and an unknown receipt, and needs a reason', () => {
    const receipt = receive([line(tea.id, piece(), 5, 100)])
    voidIt(receipt.id)
    expect(failure(() => voidIt(receipt.id))).toMatchObject({
      code: 'FORBIDDEN_STATE',
      message: 'Receipt GRN-000001 is already void.'
    })
    expect(failure(() => voidIt(9999))).toMatchObject({ code: 'NOT_FOUND' })
    expect(failure(() => voidReceipt(db, { id: receipt.id, reason: ' ' }, NOW)).code).toBe(
      'VALIDATION'
    )
    expect(movements(tea.id)).toHaveLength(2)
  })

  it('makes the product ledgers of a voided receipt start from the void date', () => {
    const receipt = receive([line(tea.id, piece(), 5, 100)], { receiptDate: '2026-09-10' })
    voidIt(receipt.id)
    expect(
      failure(() => receive([line(tea.id, piece(), 1, 1)], { receiptDate: '2026-09-15' })).code
    ).toBe('DATE_NOT_ALLOWED')
  })
})

describe('adjustStock: opening stock', () => {
  it('adds opening stock at quantity × cost with an OPENING movement', () => {
    const result = adjust({
      reason: 'OPENING_STOCK',
      unitId: box(),
      quantity: 3,
      unitCostMinor: 230000,
      reasonNote: 'Go-live count'
    })
    expect(result).toMatchObject({
      adjustmentNo: 'ADJ-000001',
      adjustmentDate: TODAY,
      productId: tea.id,
      productCode: 'P-001',
      reason: 'OPENING_STOCK',
      direction: 'IN',
      unitName: 'Box',
      quantity: 3,
      qtyBase: 72,
      valueMinor: 690000,
      receiptId: null,
      receiptItemId: null,
      reasonNote: 'Go-live count',
      warning: null
    })
    expect(movements(tea.id)).toEqual([
      { movement_date: TODAY, type: 'OPENING', qty_base: 72, value_minor: 690000 }
    ])
    expect(
      adjust({
        reason: 'OPENING_STOCK',
        productId: sugar.id,
        unitId: kg(),
        quantity: 5,
        unitCostMinor: 0
      }).valueMinor
    ).toBe(0)
  })

  it('is refused once the product has any stock movement', () => {
    adjust({ reason: 'OPENING_STOCK', quantity: 1, unitCostMinor: 1 })
    const repeated = failure(() =>
      adjust({ reason: 'OPENING_STOCK', quantity: 1, unitCostMinor: 1 })
    )
    expect(repeated).toMatchObject({
      code: 'FORBIDDEN_STATE',
      message:
        'P-001 Tea 950g already has stock history, so opening stock can no longer be entered. Use Count Surplus or Other Correction instead.'
    })
    receive([line(sugar.id, kg(), 1, 1)])
    expect(
      failure(() =>
        adjust({
          reason: 'OPENING_STOCK',
          productId: sugar.id,
          unitId: kg(),
          quantity: 1,
          unitCostMinor: 1
        })
      ).code
    ).toBe('FORBIDDEN_STATE')
    expect(count('stock_adjustments')).toBe(1)
  })

  it('requires the unit, quantity, cost and a reason note', () => {
    expect(
      failure(() =>
        adjust({
          reason: 'OPENING_STOCK',
          unitId: null,
          quantity: null,
          unitCostMinor: null,
          reasonNote: ''
        })
      ).fieldErrors
    ).toEqual({
      unitId: ['Choose the unit.'],
      quantity: ['Enter the quantity.'],
      unitCostMinor: ['Enter the unit cost.'],
      reasonNote: ['Enter the reason note.']
    })
  })

  it('accepts any active unit of the product, and refuses a unit of another product or an inactive one', () => {
    expect(
      failure(() =>
        adjust({ reason: 'OPENING_STOCK', unitId: kg(), quantity: 1, unitCostMinor: 1 })
      )
    ).toMatchObject({
      code: 'VALIDATION',
      fieldErrors: { unitId: ['This unit does not belong to the product.'] }
    })
    db.run('UPDATE product_units SET is_active = 0 WHERE id = ?', [box()])
    expect(
      failure(() =>
        adjust({ reason: 'OPENING_STOCK', unitId: box(), quantity: 1, unitCostMinor: 1 })
      ).fieldErrors
    ).toEqual({
      unitId: ['This unit is inactive.']
    })
    expect(failure(() => adjust({ productId: 9999 })).fieldErrors).toEqual({
      productId: ['This product no longer exists.']
    })
  })
})

describe('adjustStock: damage, expiry, shortage and count surplus', () => {
  beforeEach(() => {
    receive([line(tea.id, piece(), 10, 100), line(tea.id, piece(), 5, 160)])
    // Q 15, V 1,800 (average 120)
  })

  it.each(['DAMAGE', 'EXPIRY', 'SHORTAGE'] as const)(
    '%s removes stock at the average cost with ADJUST_OUT',
    (reason) => {
      const result = adjust({ reason, quantity: 4 })
      expect(result).toMatchObject({ reason, direction: 'OUT', qtyBase: 4, valueMinor: -480 })
      expect(movements(tea.id).at(-1)).toEqual({
        movement_date: TODAY,
        type: 'ADJUST_OUT',
        qty_base: -4,
        value_minor: -480
      })
      expect(position(tea.id)).toEqual({ qtyBase: 11, valueMinor: 1320 })
    }
  )

  it('an OUT reason takes no cost and no direction', () => {
    expect(
      failure(() => adjust({ reason: 'DAMAGE', unitCostMinor: 100, direction: 'IN' })).fieldErrors
    ).toEqual({
      direction: ['Not used for this reason.'],
      unitCostMinor: ['Not used: stock leaves at its current average cost.']
    })
  })

  it('COUNT_SURPLUS with stock adds at the current average cost (rounded half up)', () => {
    adjust({ reason: 'DAMAGE', quantity: 2 })
    // Q 13, V 1,560
    const result = adjust({ reason: 'COUNT_SURPLUS', quantity: 3 })
    expect(result).toMatchObject({ direction: 'IN', qtyBase: 3, valueMinor: 360 })
    expect(movements(tea.id).at(-1)).toMatchObject({
      type: 'ADJUST_IN',
      qty_base: 3,
      value_minor: 360
    })
    receive([line(tea.id, piece(), 1, 1)])
    // Q 17, V 1,921: 2 × 1,921 / 17 = 226.0 → 226
    expect(adjust({ reason: 'COUNT_SURPLUS', quantity: 2 }).valueMinor).toBe(226)
  })

  it('COUNT_SURPLUS with stock refuses an entered cost: the average is used', () => {
    expect(
      failure(() => adjust({ reason: 'COUNT_SURPLUS', quantity: 1, unitCostMinor: 999 }))
    ).toMatchObject({
      code: 'VALIDATION',
      fieldErrors: {
        unitCostMinor: [
          'This product has stock, so the surplus is valued at its average cost. Leave the cost empty.'
        ]
      }
    })
  })

  it('COUNT_SURPLUS from zero stock requires a cost', () => {
    expect(
      failure(() =>
        adjust({ reason: 'COUNT_SURPLUS', productId: sugar.id, unitId: kg(), quantity: 2 })
      )
    ).toMatchObject({
      code: 'VALIDATION',
      fieldErrors: {
        unitCostMinor: ['This product has no stock, so enter the unit cost of the surplus.']
      }
    })
    expect(
      adjust({
        reason: 'COUNT_SURPLUS',
        productId: sugar.id,
        unitId: kg(),
        quantity: 2,
        unitCostMinor: 7000
      })
    ).toMatchObject({ qtyBase: 2, valueMinor: 14000 })
  })
})

describe('adjustStock: other corrections', () => {
  it('IN requires and uses the entered cost; OUT uses the average', () => {
    receive([line(tea.id, piece(), 4, 100)])
    expect(
      failure(() => adjust({ reason: 'OTHER_CORRECTION', direction: 'IN', quantity: 1 }))
        .fieldErrors
    ).toEqual({
      unitCostMinor: ['Enter the unit cost.']
    })
    expect(failure(() => adjust({ reason: 'OTHER_CORRECTION', quantity: 1 })).fieldErrors).toEqual({
      direction: ['Choose whether stock is added or removed.']
    })
    expect(
      adjust({
        reason: 'OTHER_CORRECTION',
        direction: 'IN',
        unitId: box(),
        quantity: 1,
        unitCostMinor: 2400
      })
    ).toMatchObject({
      direction: 'IN',
      qtyBase: 24,
      valueMinor: 2400
    })
    // Q 28, V 2,800
    expect(adjust({ reason: 'OTHER_CORRECTION', direction: 'OUT', quantity: 7 })).toMatchObject({
      qtyBase: 7,
      valueMinor: -700
    })
  })
})

describe('adjustStock: receipt quantity corrections', () => {
  it('IN adds at the cost of the exact receipt line, even with the same product on several lines', () => {
    const receipt = receive([line(tea.id, box(), 2, 2400), line(tea.id, piece(), 5, 110)])
    const result = adjust({
      reason: 'RECEIPT_QTY_CORRECTION',
      direction: 'IN',
      unitId: piece(),
      quantity: 3,
      receiptItemId: receipt.lines[1].id,
      reasonNote: 'Three pieces were not counted'
    })
    expect(result).toMatchObject({
      reason: 'RECEIPT_QTY_CORRECTION',
      direction: 'IN',
      qtyBase: 3,
      valueMinor: 330,
      receiptId: receipt.id,
      receiptNo: 'GRN-000001',
      receiptItemId: receipt.lines[1].id,
      receiptLineNo: 2
    })
    // One Box more on line 1 (Box @ 2,400).
    expect(
      adjust({
        reason: 'RECEIPT_QTY_CORRECTION',
        direction: 'IN',
        unitId: box(),
        quantity: 1,
        receiptItemId: receipt.lines[0].id
      }).valueMinor
    ).toBe(2400)
    // Pieces on the Box line: 2,400 per 24 pieces → 100 each.
    expect(
      adjust({
        reason: 'RECEIPT_QTY_CORRECTION',
        direction: 'IN',
        unitId: piece(),
        quantity: 6,
        receiptItemId: receipt.lines[0].id
      }).valueMinor
    ).toBe(600)
    expect(
      db.get('SELECT receipt_id, receipt_item_id FROM stock_adjustments WHERE id = ?', [result.id])
    ).toEqual({
      receipt_id: receipt.id,
      receipt_item_id: receipt.lines[1].id
    })
  })

  it('OUT removes at the current average cost, never more than the line recorded', () => {
    const receipt = receive([line(tea.id, piece(), 10, 100)])
    receive([line(tea.id, piece(), 10, 150)])
    // Q 20, V 2,500
    const result = adjust({
      reason: 'RECEIPT_QTY_CORRECTION',
      direction: 'OUT',
      quantity: 2,
      receiptItemId: receipt.lines[0].id
    })
    expect(result).toMatchObject({ direction: 'OUT', qtyBase: 2, valueMinor: -250 })
    expect(
      failure(() =>
        adjust({
          reason: 'RECEIPT_QTY_CORRECTION',
          direction: 'OUT',
          quantity: 9,
          receiptItemId: receipt.lines[0].id
        })
      )
    ).toMatchObject({
      code: 'VALIDATION',
      fieldErrors: { quantity: ['This receipt line has 8 Piece left to correct.'] }
    })
  })

  it('refuses a line of another product, a missing line, a void receipt, and a cost', () => {
    const receipt = receive([line(tea.id, piece(), 10, 100), line(sugar.id, kg(), 1, 100)])
    expect(
      failure(() =>
        adjust({
          reason: 'RECEIPT_QTY_CORRECTION',
          direction: 'IN',
          quantity: 1,
          receiptItemId: receipt.lines[1].id
        })
      ).fieldErrors
    ).toEqual({ receiptItemId: ['This receipt line is for S-001 Sugar 1kg, not this product.'] })
    expect(
      failure(() =>
        adjust({
          reason: 'RECEIPT_QTY_CORRECTION',
          direction: 'IN',
          quantity: 1,
          receiptItemId: 9999
        })
      ).fieldErrors
    ).toEqual({ receiptItemId: ['This receipt line no longer exists.'] })
    expect(
      failure(() =>
        adjust({
          reason: 'RECEIPT_QTY_CORRECTION',
          direction: 'IN',
          quantity: 1,
          unitCostMinor: 5,
          receiptItemId: receipt.lines[0].id
        })
      ).fieldErrors
    ).toEqual({ unitCostMinor: ["Not used: stock is added at the receipt line's cost."] })

    voidReceipt(db, { id: receipt.id, reason: 'Wrong supplier' }, NOW)
    expect(
      failure(() =>
        adjust({
          reason: 'RECEIPT_QTY_CORRECTION',
          direction: 'IN',
          quantity: 1,
          receiptItemId: receipt.lines[0].id
        })
      )
    ).toMatchObject({
      code: 'FORBIDDEN_STATE',
      message: 'Receipt GRN-000001 is void, so it cannot be corrected.'
    })
  })
})

describe('adjustStock: receipt cost corrections', () => {
  it('changes only the value by (correct − recorded) × line quantity, with a COST_CORRECTION movement', () => {
    const receipt = receive([line(tea.id, box(), 10, 1500)])
    // Q 240, V 15,000
    const up = adjust({
      reason: 'RECEIPT_COST_CORRECTION',
      unitId: null,
      quantity: null,
      unitCostMinor: 1700,
      receiptItemId: receipt.lines[0].id
    })
    expect(up).toMatchObject({
      direction: 'VALUE',
      unitName: null,
      quantity: null,
      qtyBase: 0,
      valueMinor: 2000,
      warning: null
    })
    expect(movements(tea.id).at(-1)).toEqual({
      movement_date: TODAY,
      type: 'COST_CORRECTION',
      qty_base: 0,
      value_minor: 2000
    })
    expect(position(tea.id)).toEqual({ qtyBase: 240, valueMinor: 17000 })
    expect(getReceipt(db, receipt.id).lines[0]).toMatchObject({
      lineCostMinor: 15000,
      correctedLineCostMinor: 17000
    })

    // A second correction is measured from the corrected cost, not the original one.
    const down = adjust({
      reason: 'RECEIPT_COST_CORRECTION',
      unitId: null,
      quantity: null,
      unitCostMinor: 1600,
      receiptItemId: receipt.lines[0].id
    })
    expect(down.valueMinor).toBe(-1000)
    expect(movements(tea.id).at(-1)).toMatchObject({ type: 'COST_CORRECTION', value_minor: -1000 })
    expect(position(tea.id)).toEqual({ qtyBase: 240, valueMinor: 16000 })
    expect(
      db.get('SELECT direction, value_minor, qty_base FROM stock_adjustments WHERE id = ?', [
        down.id
      ])
    ).toEqual({
      direction: 'VALUE',
      value_minor: 1000,
      qty_base: 0
    })
  })

  it('refuses a correction to the cost already recorded', () => {
    const receipt = receive([line(tea.id, piece(), 10, 150)])
    expect(
      failure(() =>
        adjust({
          reason: 'RECEIPT_COST_CORRECTION',
          unitId: null,
          quantity: null,
          unitCostMinor: 150,
          receiptItemId: receipt.lines[0].id
        })
      ).fieldErrors
    ).toEqual({ unitCostMinor: ['This is already the recorded cost.'] })
  })

  it('is blocked when the product has no stock left', () => {
    const receipt = receive([line(tea.id, piece(), 10, 150)])
    simulateSale(tea.id, 10, 1500)
    expect(
      failure(() =>
        adjust({
          reason: 'RECEIPT_COST_CORRECTION',
          unitId: null,
          quantity: null,
          unitCostMinor: 170,
          receiptItemId: receipt.lines[0].id
        })
      )
    ).toMatchObject({
      code: 'FORBIDDEN_STATE',
      message:
        'No stock of P-001 Tea 950g is left, so its inventory cost cannot be corrected. Record the difference as an expense instead.'
    })
    expect(count('stock_adjustments')).toBe(0)
  })

  it('cannot make the inventory value negative', () => {
    const receipt = receive([line(tea.id, piece(), 10, 150)])
    simulateSale(tea.id, 9, 1350)
    // Q 1, V 150: correcting 150 → 0 would remove 1,500
    expect(
      failure(() =>
        adjust({
          reason: 'RECEIPT_COST_CORRECTION',
          unitId: null,
          quantity: null,
          unitCostMinor: 0,
          receiptItemId: receipt.lines[0].id
        })
      )
    ).toMatchObject({
      code: 'FORBIDDEN_STATE',
      message:
        'This correction would make the stock value of P-001 Tea 950g negative, so it cannot be saved.'
    })
    expect(position(tea.id)).toEqual({ qtyBase: 1, valueMinor: 150 })
  })

  it('warns (L1) when later stock activity followed the receipt, and still applies the correction to current inventory', () => {
    const receipt = receive([line(tea.id, piece(), 10, 150)])
    simulateSale(tea.id, 4, 600)
    expect(getReceipt(db, receipt.id).lines[0].laterActivity).toBe(true)
    const result = adjust({
      reason: 'RECEIPT_COST_CORRECTION',
      unitId: null,
      quantity: null,
      unitCostMinor: 170,
      receiptItemId: receipt.lines[0].id
    })
    expect(result.warning).toBe(LATE_COST_CORRECTION_WARNING)
    expect(position(tea.id)).toEqual({ qtyBase: 6, valueMinor: 1100 })
    // Plan L1 example: lifetime COGS + remaining value = the true total cost (10 × 170).
    simulateSale(tea.id, 6, 1100)
    expect(600 + 1100 + position(tea.id).valueMinor).toBe(1700)
  })
})

describe('adjustStock: idempotency and rollback', () => {
  it('saves one adjustment for a repeated request id', () => {
    receive([line(tea.id, piece(), 10, 100)])
    const input = adjustmentInput({ quantity: 2 })
    const first = adjustStock(db, input, NOW)
    expect(adjustStock(db, input, NOW)).toEqual({ ...first, warning: null })
    expect(count('stock_adjustments')).toBe(1)
    expect(position(tea.id)).toEqual({ qtyBase: 8, valueMinor: 800 })
    expect(nextSequence('adjustment')).toBe(2)
  })

  it('rolls back the adjustment and its number when a write fails', () => {
    receive([line(tea.id, piece(), 10, 100)])
    expect(() =>
      adjustStock(failingDb(/INSERT INTO stock_movements/), adjustmentInput({ quantity: 2 }), NOW)
    ).toThrow()
    expect(count('stock_adjustments')).toBe(0)
    expect(nextSequence('adjustment')).toBe(1)
    expect(adjust({ quantity: 2 }).adjustmentNo).toBe('ADJ-000001')
  })
})

describe('Phase 5 unit locks follow the first stock movement', () => {
  function resizeBox(size: number): unknown {
    const current = getProduct(db, tea.id)
    return updateProduct(db, {
      id: tea.id,
      code: current.code,
      name: current.name,
      companyId: null,
      packingLabel: current.packingLabel,
      lowStockThresholdBase: 0,
      currencyMinorDigits: 2,
      units: unitInputs(current, (item) => ({
        baseQty: item.name === 'Box' ? size : item.baseQty,
        retailPriceMinor: 99
      }))
    })
  }

  it('allows resizing before stock, and locks it after opening stock, while prices stay editable', () => {
    expect(() => resizeBox(12)).not.toThrow()
    expect(getProduct(db, tea.id).hasStockMovements).toBe(false)
    adjust({ reason: 'OPENING_STOCK', quantity: 5, unitCostMinor: 100 })
    expect(getProduct(db, tea.id).hasStockMovements).toBe(true)
    expect(failure(() => resizeBox(24)).code).toBe('UNIT_LOCKED')
    expect(() => resizeBox(12)).not.toThrow()
    expect(getProduct(db, tea.id).packingLabel).toBe('1*12*18')
  })

  it('locks after a first Stock In receipt too, and a void does not unlock it (the history remains)', () => {
    const receipt = receive([line(tea.id, box(), 1, 100)])
    expect(failure(() => resizeBox(12)).code).toBe('UNIT_LOCKED')
    voidReceipt(db, { id: receipt.id, reason: 'Keyed twice' }, NOW)
    expect(failure(() => resizeBox(12)).code).toBe('UNIT_LOCKED')
  })
})

describe('random stock activity (property check)', () => {
  it('never breaks Q ≥ 0, V ≥ 0, Q = 0 ⇒ V = 0, and the ledger sums always match an independent model', () => {
    // A small deterministic generator, so a failure can be replayed.
    let seed = 20260916
    const next = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % limit
    }
    const model = new Map<number, { qtyBase: number; valueMinor: number }>(
      [tea.id, sugar.id].map((id) => [id, { qtyBase: 0, valueMinor: 0 }])
    )
    const receipts: Array<{
      id: number
      lines: Array<{ productId: number; qtyBase: number; lineCostMinor: number }>
    }> = []
    for (let step = 0; step < 150; step++) {
      const productId = next(2) === 0 ? tea.id : sugar.id
      const unitIdValue = productId === tea.id ? (next(2) === 0 ? piece() : box()) : kg()
      const size = unitIdValue === box() ? 24 : 1
      const quantity = 1 + next(5)
      const current = model.get(productId)!
      const action = next(4)
      if (action === 0) {
        const cost = next(3) === 0 ? 0 : 1 + next(999)
        const saved = receive([line(productId, unitIdValue, quantity, cost)])
        current.qtyBase += quantity * size
        current.valueMinor += quantity * cost
        receipts.push({
          id: saved.id,
          lines: [{ productId, qtyBase: quantity * size, lineCostMinor: quantity * cost }]
        })
      } else if (action === 1) {
        const qtyBase = quantity * size
        const attempt = (): unknown =>
          adjust({ reason: 'SHORTAGE', productId, unitId: unitIdValue, quantity })
        if (qtyBase > current.qtyBase) {
          expect(failure(attempt).code).toBe('INSUFFICIENT_STOCK')
        } else {
          const out =
            qtyBase === current.qtyBase
              ? current.valueMinor
              : Math.floor(
                  (2 * current.valueMinor * qtyBase + current.qtyBase) / (2 * current.qtyBase)
                )
          expect((attempt() as { valueMinor: number }).valueMinor).toBe(out === 0 ? 0 : -out)
          current.qtyBase -= qtyBase
          current.valueMinor -= out
        }
      } else if (action === 2) {
        const qtyBase = quantity * size
        const cost = current.qtyBase === 0 ? next(500) : null
        const added =
          current.qtyBase === 0
            ? quantity * (cost ?? 0)
            : Math.floor(
                (2 * current.valueMinor * qtyBase + current.qtyBase) / (2 * current.qtyBase)
              )
        adjust({
          reason: 'COUNT_SURPLUS',
          productId,
          unitId: unitIdValue,
          quantity,
          unitCostMinor: cost
        })
        current.qtyBase += qtyBase
        current.valueMinor += added
      } else if (receipts.length > 0) {
        const target = receipts[next(receipts.length)]
        const detail = getReceipt(db, target.id)
        if (detail.voidable) {
          voidReceipt(db, { id: target.id, reason: 'Random void' }, NOW)
          for (const saved of target.lines) {
            model.get(saved.productId)!.qtyBase -= saved.qtyBase
            model.get(saved.productId)!.valueMinor -= saved.lineCostMinor
          }
        } else {
          expect(
            failure(() => voidReceipt(db, { id: target.id, reason: 'Random void' }, NOW)).code
          ).toBe('FORBIDDEN_STATE')
        }
        receipts.splice(receipts.indexOf(target), 1)
      }
      for (const [id, expected] of model) {
        const actual = position(id)
        expect(actual).toEqual(expected)
        expect(actual.qtyBase).toBeGreaterThanOrEqual(0)
        expect(actual.valueMinor).toBeGreaterThanOrEqual(0)
        if (actual.qtyBase === 0) expect(actual.valueMinor).toBe(0)
      }
    }
    expect(() => assertStockInvariants(db, [tea.id, sugar.id])).not.toThrow()
  })
})

describe('stock views, stock card, summary and lists', () => {
  it('the product list and stock summary show the ledger sums', () => {
    receive([line(tea.id, box(), 7, 2400), line(tea.id, piece(), 19, 100)])
    adjust({ reason: 'DAMAGE', quantity: 5 })
    const sums = db.get(
      'SELECT sum(qty_base) AS q, sum(value_minor) AS v FROM stock_movements WHERE product_id = ?',
      [tea.id]
    )
    expect(sums).toEqual({ q: 182, v: expect.any(Number) })
    expect(position(tea.id)).toEqual({ qtyBase: 182, valueMinor: (sums as { v: number }).v })
    const listed = listProducts(db, {
      page: 1,
      pageSize: 10,
      search: 'P-001',
      companyId: null,
      status: 'all'
    })
    expect(listed.items[0].stockQtyBase).toBe(182)
    expect(stockSummary(db, tea.id)).toEqual({
      productId: tea.id,
      qtyBase: 182,
      valueMinor: (sums as { v: number }).v,
      hasMovements: true,
      latestMovementDate: TODAY
    })
    expect(stockSummary(db, rice.id)).toEqual({
      productId: rice.id,
      qtyBase: 0,
      valueMinor: 0,
      hasMovements: false,
      latestMovementDate: null
    })
    expect(failure(() => stockSummary(db, 9999)).code).toBe('NOT_FOUND')
  })

  it('the stock card lists every movement with in/out columns and a running quantity and value', () => {
    const receipt = receive([line(tea.id, box(), 1, 2400), line(tea.id, piece(), 6, 100)], {
      receiptDate: '2026-09-14'
    })
    adjust({ reason: 'DAMAGE', quantity: 10, adjustmentDate: '2026-09-15' })
    adjust({
      reason: 'RECEIPT_COST_CORRECTION',
      unitId: null,
      quantity: null,
      unitCostMinor: 2640,
      receiptItemId: receipt.lines[0].id
    })
    receive([line(sugar.id, kg(), 1, 1)])

    const card = stockCard(db, { productId: tea.id, page: 1, pageSize: 50 })
    expect(card.product).toMatchObject({
      id: tea.id,
      code: 'P-001',
      name: 'Tea 950g',
      packingLabel: '1*12*18'
    })
    expect(card.product.units.map((item) => item.name)).toEqual(['Piece', 'Box'])
    expect([card.qtyBase, card.valueMinor, card.total, card.page]).toEqual([20, 2240, 4, 1])
    expect(card.rows).toMatchObject([
      {
        date: '2026-09-14',
        type: 'STOCK_IN',
        reason: null,
        reference: 'GRN-000001 (line 1)',
        qtyInBase: 24,
        qtyOutBase: 0,
        valueInMinor: 2400,
        valueOutMinor: 0,
        runningQtyBase: 24,
        runningValueMinor: 2400
      },
      {
        date: '2026-09-14',
        type: 'STOCK_IN',
        reason: null,
        reference: 'GRN-000001 (line 2)',
        qtyInBase: 6,
        qtyOutBase: 0,
        valueInMinor: 600,
        valueOutMinor: 0,
        runningQtyBase: 30,
        runningValueMinor: 3000
      },
      {
        date: '2026-09-15',
        type: 'ADJUST_OUT',
        reason: 'DAMAGE',
        reference: 'ADJ-000001',
        qtyInBase: 0,
        qtyOutBase: 10,
        valueInMinor: 0,
        valueOutMinor: 1000,
        runningQtyBase: 20,
        runningValueMinor: 2000
      },
      {
        date: TODAY,
        type: 'COST_CORRECTION',
        reason: 'RECEIPT_COST_CORRECTION',
        reference: 'ADJ-000002',
        qtyInBase: 0,
        qtyOutBase: 0,
        valueInMinor: 240,
        valueOutMinor: 0,
        runningQtyBase: 20,
        runningValueMinor: 2240
      }
    ])
  })

  it('the stock card pages from the oldest; page null is the last page, with running totals over all rows', () => {
    for (let index = 0; index < 5; index++) receive([line(tea.id, piece(), index + 1, 10)])
    simulateSale(tea.id, 2, 20)
    const last = stockCard(db, { productId: tea.id, page: null, pageSize: 2 })
    expect([last.page, last.total]).toEqual([3, 6])
    expect(
      last.rows.map((row) => [row.type, row.runningQtyBase, row.runningValueMinor, row.reference])
    ).toEqual([
      ['STOCK_IN', 15, 150, 'GRN-000005 (line 1)'],
      ['SALE', 13, 130, 'INV-T1']
    ])
    expect(
      stockCard(db, { productId: tea.id, page: 1, pageSize: 2 }).rows.map(
        (row) => row.runningQtyBase
      )
    ).toEqual([1, 3])
    const empty = stockCard(db, { productId: rice.id, page: null, pageSize: 2 })
    expect([empty.page, empty.total, empty.rows]).toEqual([1, 0, []])
    expect(failure(() => stockCard(db, { productId: 9999, page: 1, pageSize: 2 })).code).toBe(
      'NOT_FOUND'
    )
  })

  it('lists receipts newest first with search, paging and whether each can still be voided', () => {
    const first = receive([line(tea.id, piece(), 1, 1)], {
      supplierName: 'Ali Traders',
      reference: 'B-1'
    })
    receive([line(sugar.id, kg(), 1, 1)], { supplierName: 'Acme', reference: 'B-2' })
    receive([line(tea.id, piece(), 1, 1)], { supplierName: 'Acme', reference: 'B-3' })
    const page = listReceipts(db, { page: 1, pageSize: 2, search: '' })
    expect(page.total).toBe(3)
    expect(page.items.map((item) => [item.receiptNo, item.voidable, item.lineCount])).toEqual([
      ['GRN-000003', true, 1],
      ['GRN-000002', true, 1]
    ])
    expect(
      listReceipts(db, { page: 2, pageSize: 2, search: '' }).items.map((item) => [
        item.id,
        item.voidable
      ])
    ).toEqual([[first.id, false]])
    expect(
      listReceipts(db, { page: 1, pageSize: 10, search: 'ali' }).items.map((item) => item.receiptNo)
    ).toEqual(['GRN-000001'])
    expect(listReceipts(db, { page: 1, pageSize: 10, search: 'grn-000002' }).total).toBe(1)
    expect(listReceipts(db, { page: 1, pageSize: 10, search: 'B-3' }).total).toBe(1)
    expect(listReceipts(db, { page: 1, pageSize: 10, search: '%' }).total).toBe(0)
  })

  it('shows a receipt with its corrections, and lists adjustments newest first, optionally for one product', () => {
    const receipt = receive([line(tea.id, piece(), 10, 100)])
    const correction = adjust({
      reason: 'RECEIPT_QTY_CORRECTION',
      direction: 'OUT',
      quantity: 1,
      receiptItemId: receipt.lines[0].id
    })
    adjust({
      reason: 'OPENING_STOCK',
      productId: sugar.id,
      unitId: kg(),
      quantity: 1,
      unitCostMinor: 1
    })
    expect(getReceipt(db, receipt.id).corrections.map((item) => item.adjustmentNo)).toEqual([
      correction.adjustmentNo
    ])
    expect(failure(() => getReceipt(db, 9999))).toMatchObject({
      code: 'NOT_FOUND',
      message: 'This receipt no longer exists.'
    })

    const all = listAdjustments(db, { page: 1, pageSize: 10, productId: null })
    expect(all.items.map((item) => item.adjustmentNo)).toEqual(['ADJ-000002', 'ADJ-000001'])
    expect(all.total).toBe(2)
    expect(
      listAdjustments(db, { page: 1, pageSize: 10, productId: sugar.id }).items.map(
        (item) => item.reason
      )
    ).toEqual(['OPENING_STOCK'])
  })
})
