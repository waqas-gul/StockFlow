import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Customer, CustomerCreateInput } from '@shared/customers'
import { calculateInvoiceTotals } from '@shared/invoice-totals'
import type {
  InvoiceCreateInput,
  InvoiceLineInput,
  InvoiceQuantityInput,
  InvoiceSaveResult
} from '@shared/invoices'
import type { Product, ProductUnitInput } from '@shared/products'
import type { Db } from '../db/adapter'
import { runIntegrityCheck } from '../db/integrity'
import { migrations } from '../db/migrations'
import { createSchemaDatabase, createTempDir, thrown, type TempDir } from '../db/test-utils'
import { AppFailure } from '../errors'
import { createCompany, updateCompany } from './companies.service'
import {
  adjustCustomerBalance,
  createCustomer,
  setCustomerActive,
  updateCustomer
} from './customers.service'
import { assertStockInvariants, stockPosition } from './inventory'
import { createInvoice, getInvoice } from './invoices.service'
import { createPayment, getPayment, listPayments } from './payments.service'
import { createProduct, setProductActive, updateProduct } from './products.service'
import { updateSettings } from './settings.service'
import { receiveStock } from './stock.service'
import { failingReads, failingWrites } from './test-utils'

// Test data lives only in temporary databases.

const NOW = new Date(2026, 8, 16, 10, 30, 0)
const TODAY = '2026-09-16'
const STOCK_DATE = '2026-09-10'

let temp: TempDir
let db: Db
let requests: number
let tapalId: number
/** Piece (base; retail 110, wholesale 100) and Box of 24 (retail 2,400, wholesale 2,300). Q 247, V 20,630.07. */
let tea: Product
/** Kg (base; retail 200, no wholesale price). Q 100, V 15,000.00. */
let sugar: Product
/** Bag (base; retail 1,500, wholesale 1,400). Q 20, V 24,000.00. */
let rice: Product
/** C-00002, owes Rs 1,000.00 since 10-Sep-2026. */
let ali: Customer
let walkInId: number

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  requests = 0
  tapalId = createCompany(db, { name: 'Tapal' }).id
  tea = product({ code: 'P-001', name: 'Tea 950g', companyId: tapalId }, [
    unit({
      name: 'Piece',
      shortName: 'Pcs',
      retailPriceMinor: 11_000,
      wholesalePriceMinor: 10_000
    }),
    unit({
      name: 'Box',
      shortName: 'Bx',
      baseQty: 24,
      isBase: false,
      retailPriceMinor: 240_000,
      wholesalePriceMinor: 230_000
    })
  ])
  sugar = product({ code: 'S-001', name: 'Sugar 1kg', packingLabel: null }, [
    unit({ name: 'Kg', retailPriceMinor: 20_000 })
  ])
  rice = product({ code: 'R-001', name: 'Rice 5kg' }, [
    unit({ name: 'Bag', retailPriceMinor: 150_000, wholesalePriceMinor: 140_000 })
  ])
  receive(STOCK_DATE, [
    [tea.id, box(), 10, 200_000],
    [tea.id, piece(), 7, 9_001],
    [sugar.id, kg(), 100, 15_000],
    [rice.id, bag(), 20, 120_000]
  ])
  ali = customer({
    opening: { side: 'DUE', amountMinor: 100_000, date: STOCK_DATE }
  })
  walkInId = db.get<{ id: number }>("SELECT id FROM customers WHERE code = 'C-00001'")!.id
})

afterEach(() => {
  temp.remove()
})

// --- Fixtures ---------------------------------------------------------------------------------------------------------

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

function product(fields: Record<string, unknown>, units: ProductUnitInput[]): Product {
  return createProduct(db, {
    code: 'X-001',
    name: 'Product',
    companyId: null,
    packingLabel: '1*12*18',
    lowStockThresholdBase: 0,
    currencyMinorDigits: 2,
    units,
    ...fields
  })
}

/** The saved product as update input, with `fields` and each unit changed by `change`. */
function productUpdate(
  item: Product,
  fields: Record<string, unknown>,
  change: (saved: Product['units'][number]) => Partial<ProductUnitInput> = () => ({})
): unknown {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    companyId: item.companyId,
    packingLabel: item.packingLabel,
    lowStockThresholdBase: item.lowStockThresholdBase,
    currencyMinorDigits: 2,
    units: item.units.map((saved) => ({
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
      isActive: saved.isActive,
      ...change(saved)
    })),
    ...fields
  }
}

function unitOf(item: Product, name: string): number {
  const found = item.units.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`No unit ${name}`)
  return found.id
}

const piece = (): number => unitOf(tea, 'Piece')
const box = (): number => unitOf(tea, 'Box')
const kg = (): number => unitOf(sugar, 'Kg')
const bag = (): number => unitOf(rice, 'Bag')

function receive(date: string, lines: Array<[number, number, number, number]>): void {
  receiveStock(
    db,
    {
      requestId: nextRequestId(),
      receiptDate: date,
      supplierName: null,
      reference: null,
      note: null,
      currencyMinorDigits: 2,
      lines: lines.map(([productId, unitId, quantity, unitCostMinor]) => ({
        productId,
        unitId,
        quantity,
        unitCostMinor
      }))
    },
    NOW
  )
}

function customer(overrides: Partial<CustomerCreateInput> = {}): Customer {
  return createCustomer(
    db,
    {
      name: 'Ali Raza',
      shopName: 'Ali Traders',
      phone: '0300-1234567',
      address: 'Main Bazar',
      city: 'Lahore',
      notes: null,
      opening: null,
      currencyMinorDigits: 2,
      ...overrides
    },
    NOW
  )
}

function nextRequestId(): string {
  requests++
  return `request-${String(requests).padStart(4, '0')}`
}

function qty(
  unitId: number,
  quantity: number,
  unitPriceMinor: number,
  priceOverride = false
): InvoiceQuantityInput {
  return { unitId, quantity, unitPriceMinor, priceOverride }
}

function line(
  productId: number,
  quantities: InvoiceQuantityInput[],
  overrides: Partial<InvoiceLineInput> = {}
): InvoiceLineInput {
  return {
    productId,
    quantities,
    freeQuantities: [],
    discount: null,
    schemeMinor: 0,
    ctnCount: null,
    ...overrides
  }
}

/** 2 Box + 5 Piece of tea at retail prices: Rs 5,350.00, 53 pieces. */
function teaLine(overrides: Partial<InvoiceLineInput> = {}): InvoiceLineInput {
  return line(tea.id, [qty(box(), 2, 240_000), qty(piece(), 5, 11_000)], overrides)
}

function invoiceInput(
  lines: InvoiceLineInput[],
  overrides: Partial<InvoiceCreateInput> = {}
): InvoiceCreateInput {
  return {
    requestId: nextRequestId(),
    invoiceDate: TODAY,
    customerId: ali.id,
    priceTier: 'RETAIL',
    invoiceCode: null,
    biltyNo: null,
    transportName: null,
    addaName: null,
    checkedBy: null,
    notes: null,
    lines,
    extraDiscountMinor: 0,
    freightMinor: 0,
    receivedMinor: 0,
    paymentMethod: null,
    paymentReference: null,
    currencyMinorDigits: 2,
    ...overrides
  }
}

function post(
  lines: InvoiceLineInput[],
  overrides: Partial<InvoiceCreateInput> = {},
  target: Db = db
): InvoiceSaveResult {
  return createInvoice(target, invoiceInput(lines, overrides), NOW)
}

function failure(fn: () => unknown): AppFailure['error'] {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

function count(table: string, where = ''): number {
  return db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} ${where}`)!.n
}

function nextSequence(name: string): number {
  return db.get<{ next_value: number }>('SELECT next_value FROM sequences WHERE name = ?', [name])!
    .next_value
}

function balance(customerId: number): number {
  return db.get<{ total: number }>(
    'SELECT coalesce(sum(amount_minor), 0) AS total FROM customer_ledger WHERE customer_id = ?',
    [customerId]
  )!.total
}

function ledger(customerId: number): Array<Record<string, unknown>> {
  return db.all(
    `SELECT entry_date, type, amount_minor, invoice_id, payment_id FROM customer_ledger
     WHERE customer_id = ? ORDER BY id`,
    [customerId]
  )
}

function saleMovements(): Array<Record<string, unknown>> {
  return db.all(
    `SELECT product_id, movement_date, qty_base, value_minor, invoice_item_id FROM stock_movements
     WHERE type = 'SALE' ORDER BY id`
  )
}

/** Everything an invoice writes or reads: rows, counters, stock and balances. */
function state(): Record<string, unknown> {
  return {
    rows: [
      'invoices',
      'invoice_items',
      'invoice_item_quantities',
      'stock_movements',
      'customer_ledger',
      'payments'
    ].map((table) => [table, count(table)]),
    sequences: db.all('SELECT name, next_value FROM sequences ORDER BY name'),
    stock: [tea, sugar, rice].map((item) => stockPosition(db, item.id)),
    balances: db.all(
      'SELECT customer_id, balance_minor FROM v_customer_balance ORDER BY customer_id'
    )
  }
}

function withoutResult(invoice: InvoiceSaveResult): Record<string, unknown> {
  const detail: Record<string, unknown> = { ...invoice }
  delete detail.balanceAfterMinor
  delete detail.replayed
  return detail
}

// --- Posting ---------------------------------------------------------------------------------------------------------

describe('createInvoice: one transaction for the whole sale', () => {
  it('posts one product in one unit: header, line, quantity row, SALE movement and INVOICE entry', () => {
    const invoice = post([line(tea.id, [qty(piece(), 3, 11_000)])], {
      invoiceCode: ' B-17 ',
      biltyNo: 'BL-221',
      transportName: 'Daewoo Cargo',
      addaName: 'Badami Bagh',
      checkedBy: 'Waqas',
      notes: 'Deliver before noon'
    })

    // Cost: round_half_up(2,063,007 × 3 ÷ 247) = 25,057.
    expect(invoice).toEqual({
      id: expect.any(Number),
      invoiceNo: 'INV-000001',
      invoiceDate: TODAY,
      invoiceCode: 'B-17',
      status: 'POSTED',
      customerId: ali.id,
      customerCode: 'C-00002',
      customerName: 'Ali Raza',
      customerShopName: 'Ali Traders',
      customerPhone: '0300-1234567',
      customerAddress: 'Main Bazar',
      customerCity: 'Lahore',
      priceTier: 'RETAIL',
      grossMinor: 33_000,
      lineDiscountMinor: 0,
      lineSchemeMinor: 0,
      extraDiscountMinor: 0,
      netMinor: 33_000,
      freightMinor: 0,
      totalMinor: 33_000,
      receivedMinor: 0,
      previousBalanceMinor: 100_000,
      netOutstandingMinor: 133_000,
      cogsMinor: 25_057,
      biltyNo: 'BL-221',
      transportName: 'Daewoo Cargo',
      addaName: 'Badami Bagh',
      checkedBy: 'Waqas',
      notes: 'Deliver before noon',
      payment: null,
      lines: [
        {
          id: expect.any(Number),
          lineNo: 1,
          productId: tea.id,
          productCode: 'P-001',
          productName: 'Tea 950g',
          companyName: 'Tapal',
          packingLabel: '1*12*18',
          qtyBase: 3,
          schemeQtyBase: 0,
          grossMinor: 33_000,
          discountBps: null,
          discountMinor: 0,
          schemeMinor: 0,
          ctnCount: null,
          netMinor: 33_000,
          costMinor: 25_057,
          quantities: [
            {
              id: expect.any(Number),
              unitId: piece(),
              unitName: 'Piece',
              unitShortName: 'Pcs',
              unitBaseQty: 1,
              quantity: 3,
              unitPriceMinor: 11_000,
              amountMinor: 33_000,
              qtyBase: 3
            }
          ]
        }
      ],
      voidReason: null,
      voidDate: null,
      voidedAt: null,
      createdAt: expect.any(String),
      balanceAfterMinor: 133_000,
      replayed: false
    })
    expect(saleMovements()).toEqual([
      {
        product_id: tea.id,
        movement_date: TODAY,
        qty_base: -3,
        value_minor: -25_057,
        invoice_item_id: invoice.lines[0].id
      }
    ])
    expect(ledger(ali.id)).toEqual([
      {
        entry_date: STOCK_DATE,
        type: 'OPENING',
        amount_minor: 100_000,
        invoice_id: null,
        payment_id: null
      },
      {
        entry_date: TODAY,
        type: 'INVOICE',
        amount_minor: 33_000,
        invoice_id: invoice.id,
        payment_id: null
      }
    ])
    expect(getInvoice(db, invoice.id)).toEqual(withoutResult(invoice))
    expect(nextSequence('invoice')).toBe(2)
    expect(nextSequence('payment')).toBe(1)
  })

  it('keeps Box and Piece of one product on one line with two quantity rows, and one movement for the line', () => {
    const invoice = post([teaLine({ ctnCount: 2 })])

    expect(count('invoice_items')).toBe(1)
    expect(invoice.lines[0]).toMatchObject({ qtyBase: 53, grossMinor: 535_000, ctnCount: 2 })
    expect(
      invoice.lines[0].quantities.map((row) => [
        row.unitName,
        row.unitBaseQty,
        row.quantity,
        row.qtyBase,
        row.amountMinor
      ])
    ).toEqual([
      ['Box', 24, 2, 48, 480_000],
      ['Piece', 1, 5, 5, 55_000]
    ])
    // The line is costed once on 53 pieces: round_half_up(2,063,007 × 53 ÷ 247) = 442,670. Costing each row
    // separately would give 400,908 + 41,761 = 442,669.
    expect(invoice.cogsMinor).toBe(442_670)
    expect(saleMovements()).toEqual([
      expect.objectContaining({ product_id: tea.id, qty_base: -53, value_minor: -442_670 })
    ])
    expect(stockPosition(db, tea.id)).toEqual({ qtyBase: 194, valueMinor: 2_063_007 - 442_670 })
  })

  it('posts several products, each line numbered, costed and moved against its own stock', () => {
    const invoice = post([
      line(tea.id, [qty(box(), 2, 240_000)]),
      line(sugar.id, [qty(kg(), 10, 20_000)]),
      line(rice.id, [qty(bag(), 1, 150_000)])
    ])

    expect(
      invoice.lines.map((item) => [
        item.lineNo,
        item.productCode,
        item.qtyBase,
        item.grossMinor,
        item.costMinor
      ])
    ).toEqual([
      [1, 'P-001', 48, 480_000, 400_908],
      [2, 'S-001', 10, 200_000, 150_000],
      [3, 'R-001', 1, 150_000, 120_000]
    ])
    expect(invoice).toMatchObject({ grossMinor: 830_000, totalMinor: 830_000, cogsMinor: 670_908 })
    expect(saleMovements().map((row) => [row.product_id, row.qty_base, row.value_minor])).toEqual([
      [tea.id, -48, -400_908],
      [sugar.id, -10, -150_000],
      [rice.id, -1, -120_000]
    ])
    expect(stockPosition(db, sugar.id)).toEqual({ qtyBase: 90, valueMinor: 1_350_000 })
    expect(stockPosition(db, rice.id)).toEqual({ qtyBase: 19, valueMinor: 2_280_000 })
  })

  it('saves the same totals as the shared preview calculates for the same prices', () => {
    const lines = [
      teaLine({
        discount: { type: 'PERCENT', bps: 333 },
        schemeMinor: 2_000,
        freeQuantities: [{ unitId: piece(), quantity: 2 }]
      }),
      line(sugar.id, [qty(kg(), 10, 20_000)], { discount: { type: 'AMOUNT', amountMinor: 5_000 } })
    ]
    const invoice = post(lines, {
      extraDiscountMinor: 30_000,
      freightMinor: 15_000,
      receivedMinor: 50_000,
      paymentMethod: 'CASH'
    })
    const preview = calculateInvoiceTotals({
      lines: [
        {
          quantities: [
            { quantity: 2, unitBaseQty: 24, unitPriceMinor: 240_000 },
            { quantity: 5, unitBaseQty: 1, unitPriceMinor: 11_000 }
          ],
          freeQuantities: [{ quantity: 2, unitBaseQty: 1 }],
          discount: { type: 'PERCENT', bps: 333 },
          schemeMinor: 2_000
        },
        {
          quantities: [{ quantity: 10, unitBaseQty: 1, unitPriceMinor: 20_000 }],
          freeQuantities: [],
          discount: { type: 'AMOUNT', amountMinor: 5_000 },
          schemeMinor: 0
        }
      ],
      extraDiscountMinor: 30_000,
      freightMinor: 15_000,
      receivedMinor: 50_000,
      previousBalanceMinor: 100_000
    })
    if (!preview.ok) throw new Error('The preview failed.')
    const { lines: previewLines, ...previewTotals } = preview.totals
    expect(invoice).toMatchObject(previewTotals)
    expect(
      invoice.lines.map((item) => [
        item.qtyBase,
        item.schemeQtyBase,
        item.grossMinor,
        item.discountBps,
        item.discountMinor,
        item.schemeMinor,
        item.netMinor
      ])
    ).toEqual(
      previewLines.map((item) => [
        item.qtyBase,
        item.schemeQtyBase,
        item.grossMinor,
        item.discountBps,
        item.discountMinor,
        item.schemeMinor,
        item.netMinor
      ])
    )
  })

  it('keeps the database consistent: the integrity check stays OK after invoices and counter payments', () => {
    post([teaLine()], { receivedMinor: 100_000, paymentMethod: 'CASH' })
    post([line(sugar.id, [qty(kg(), 3, 0, true)])], { customerId: walkInId })
    const report = runIntegrityCheck(db, { migrations })
    expect(report.checks.filter((check) => check.status !== 'OK')).toEqual([])
    expect(() => assertStockInvariants(db, [tea.id, sugar.id, rice.id])).not.toThrow()
  })
})

// --- Pricing ---------------------------------------------------------------------------------------------------------

describe('prices', () => {
  it('charges the retail prices on a retail invoice', () => {
    const invoice = post([teaLine()])
    expect(invoice).toMatchObject({ priceTier: 'RETAIL', grossMinor: 535_000 })
  })

  it('charges the wholesale prices on a wholesale invoice', () => {
    const invoice = post([line(tea.id, [qty(box(), 2, 230_000), qty(piece(), 5, 10_000)])], {
      priceTier: 'WHOLESALE'
    })
    expect(invoice).toMatchObject({ priceTier: 'WHOLESALE', grossMinor: 510_000 })
    expect(invoice.lines[0].quantities.map((row) => row.unitPriceMinor)).toEqual([230_000, 10_000])
    expect(db.get('SELECT price_tier FROM invoices')).toEqual({ price_tier: 'WHOLESALE' })
  })

  it('refuses a price that is not the configured price of the tier, unless it is marked as an override', () => {
    const before = state()
    // The retail price sent on a wholesale invoice, and a price the operator did not mark as typed.
    const error = failure(() =>
      post([line(tea.id, [qty(box(), 2, 240_000), qty(piece(), 5, 10_000)])], {
        priceTier: 'WHOLESALE'
      })
    )
    expect(error).toEqual({
      code: 'PRICE_CHANGED',
      message:
        'The wholesale price of Box for P-001 Tea 950g is Rs 2,300.00, not Rs 2,400.00. Check the price and save again.',
      fieldErrors: {
        'lines.0.quantities.0.unitPriceMinor': ['The wholesale price is Rs 2,300.00.']
      },
      details: {
        prices: [
          {
            lineIndex: 0,
            quantityIndex: 0,
            productId: tea.id,
            unitId: box(),
            enteredPriceMinor: 240_000,
            configuredPriceMinor: 230_000
          }
        ]
      }
    })
    expect(state()).toEqual(before)
  })

  it('refuses a configured price that changed after it was entered', () => {
    updateProduct(
      db,
      productUpdate(tea, {}, (saved) => (saved.name === 'Box' ? { retailPriceMinor: 250_000 } : {}))
    )
    updateProduct(
      db,
      productUpdate(sugar, {}, () => ({ retailPriceMinor: 21_000 }))
    )
    const before = state()
    const error = failure(() => post([teaLine(), line(sugar.id, [qty(kg(), 1, 20_000)])]))
    expect(error.code).toBe('PRICE_CHANGED')
    expect(error.message).toBe(
      'Some prices are no longer the configured prices. Check the highlighted prices and save again.'
    )
    expect(error.fieldErrors).toEqual({
      'lines.0.quantities.0.unitPriceMinor': ['The retail price is Rs 2,500.00.'],
      'lines.1.quantities.0.unitPriceMinor': ['The retail price is Rs 210.00.']
    })
    expect(state()).toEqual(before)
  })

  it('accepts an explicit override and saves only the price actually charged, zero included', () => {
    const invoice = post([
      line(tea.id, [qty(box(), 2, 225_000, true), qty(piece(), 5, 11_000)]),
      line(sugar.id, [qty(kg(), 2, 0, true)])
    ])
    expect(invoice.lines[0].quantities.map((row) => [row.unitPriceMinor, row.amountMinor])).toEqual(
      [
        [225_000, 450_000],
        [11_000, 55_000]
      ]
    )
    expect(invoice.lines[1]).toMatchObject({
      grossMinor: 0,
      netMinor: 0,
      qtyBase: 2,
      costMinor: 30_000
    })
    expect(invoice.grossMinor).toBe(505_000)
    expect(db.all('SELECT unit_price_minor FROM invoice_item_quantities ORDER BY id')).toEqual([
      { unit_price_minor: 225_000 },
      { unit_price_minor: 11_000 },
      { unit_price_minor: 0 }
    ])
  })

  it('never falls back to the other tier: a unit without a price for the tier needs an override', () => {
    const before = state()
    const error = failure(() =>
      post([line(sugar.id, [qty(kg(), 1, 20_000)])], { priceTier: 'WHOLESALE' })
    )
    expect(error).toEqual({
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors: {
        'lines.0.quantities.0.unitPriceMinor': [
          'Kg of S-001 Sugar 1kg has no wholesale price. Enter the price for this sale.'
        ]
      }
    })
    expect(state()).toEqual(before)

    const invoice = post([line(sugar.id, [qty(kg(), 1, 18_000, true)])], { priceTier: 'WHOLESALE' })
    expect(invoice.grossMinor).toBe(18_000)
  })
})

// --- Discounts, schemes, freight, received ---------------------------------------------------------------------------

describe('line and invoice amounts', () => {
  it('stores a percentage discount with its basis points and the amount rounded half-up', () => {
    // 5 Piece = 55,000 × 3.33% = 1,831.5 → 1,832.
    const invoice = post([
      line(tea.id, [qty(piece(), 5, 11_000)], { discount: { type: 'PERCENT', bps: 333 } })
    ])
    expect(invoice.lines[0]).toMatchObject({
      grossMinor: 55_000,
      discountBps: 333,
      discountMinor: 1_832,
      netMinor: 53_168
    })
    expect(invoice).toMatchObject({
      lineDiscountMinor: 1_832,
      netMinor: 53_168,
      totalMinor: 53_168
    })
    expect(db.get('SELECT discount_bps, discount_minor, net_minor FROM invoice_items')).toEqual({
      discount_bps: 333,
      discount_minor: 1_832,
      net_minor: 53_168
    })
  })

  it('stores a fixed discount without basis points, and a scheme amount deducted after it', () => {
    const invoice = post([
      teaLine({ discount: { type: 'AMOUNT', amountMinor: 35_000 }, schemeMinor: 10_000 }),
      line(sugar.id, [qty(kg(), 10, 20_000)], { schemeMinor: 5_000 })
    ])
    expect(
      invoice.lines.map((item) => [
        item.grossMinor,
        item.discountBps,
        item.discountMinor,
        item.schemeMinor,
        item.netMinor
      ])
    ).toEqual([
      [535_000, null, 35_000, 10_000, 490_000],
      [200_000, null, 0, 5_000, 195_000]
    ])
    expect(invoice).toMatchObject({
      grossMinor: 735_000,
      lineDiscountMinor: 35_000,
      lineSchemeMinor: 15_000,
      netMinor: 685_000
    })
    // A scheme amount has no stock effect.
    expect(invoice.lines.map((item) => item.schemeQtyBase)).toEqual([0, 0])
  })

  it('refuses a discount, scheme or extra discount that would make an amount negative', () => {
    const before = state()
    expect(
      failure(() => post([teaLine({ discount: { type: 'AMOUNT', amountMinor: 535_001 } })]))
        .fieldErrors
    ).toEqual({
      'lines.0.discount': ['The discount cannot be more than the line amount.']
    })
    expect(
      failure(() =>
        post([teaLine({ discount: { type: 'PERCENT', bps: 5_000 }, schemeMinor: 267_501 })])
      ).fieldErrors
    ).toEqual({
      'lines.0.schemeMinor': ['The scheme cannot be more than the line amount after the discount.']
    })
    expect(failure(() => post([teaLine()], { extraDiscountMinor: 535_001 }))).toEqual({
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors: {
        extraDiscountMinor: [
          'The extra discount cannot be more than the invoice amount after line discounts.'
        ]
      }
    })
    expect(state()).toEqual(before)
  })

  it('takes free scheme quantity out of stock and into the cost, with no revenue', () => {
    const invoice = post([
      line(tea.id, [qty(box(), 2, 240_000)], { freeQuantities: [{ unitId: box(), quantity: 1 }] })
    ])
    // 48 paid + 24 free = 72: round_half_up(2,063,007 × 72 ÷ 247) = 601,362.
    expect(invoice.lines[0]).toMatchObject({
      qtyBase: 72,
      schemeQtyBase: 24,
      grossMinor: 480_000,
      netMinor: 480_000,
      costMinor: 601_362
    })
    expect(invoice.lines[0].quantities).toHaveLength(1)
    expect(invoice).toMatchObject({ totalMinor: 480_000, cogsMinor: 601_362 })
    expect(saleMovements()).toEqual([
      expect.objectContaining({ qty_base: -72, value_minor: -601_362 })
    ])
    expect(stockPosition(db, tea.id)).toEqual({ qtyBase: 175, valueMinor: 2_063_007 - 601_362 })
  })

  it('takes the extra discount off Σ line net and adds freight to the total and the balance', () => {
    const invoice = post([teaLine(), line(sugar.id, [qty(kg(), 10, 20_000)])], {
      extraDiscountMinor: 35_000,
      freightMinor: 15_000
    })
    expect(invoice).toMatchObject({
      grossMinor: 735_000,
      extraDiscountMinor: 35_000,
      netMinor: 700_000,
      freightMinor: 15_000,
      totalMinor: 715_000,
      previousBalanceMinor: 100_000,
      netOutstandingMinor: 815_000,
      balanceAfterMinor: 815_000
    })
    expect(ledger(ali.id).at(-1)).toMatchObject({ type: 'INVOICE', amount_minor: 715_000 })
  })

  it('saves money received with the invoice as a real payment with its own PAYMENT entry', () => {
    const invoice = post([teaLine()], {
      receivedMinor: 200_000,
      paymentMethod: 'BANK',
      paymentReference: ' TT-55 '
    })
    const payment = db.get<Record<string, unknown>>('SELECT * FROM payments')!
    expect(payment).toMatchObject({
      payment_no: 'RCP-000001',
      request_id: `invoice:${db.get<{ request_id: string }>('SELECT request_id FROM invoices')!.request_id}`,
      customer_id: ali.id,
      payment_date: TODAY,
      amount_minor: 200_000,
      method: 'BANK',
      reference: 'TT-55',
      invoice_id: invoice.id,
      status: 'POSTED',
      note: null
    })
    expect(invoice.payment).toEqual({
      id: payment.id,
      paymentNo: 'RCP-000001',
      paymentDate: TODAY,
      amountMinor: 200_000,
      method: 'BANK',
      reference: 'TT-55',
      status: 'POSTED'
    })
    expect(ledger(ali.id).slice(1)).toEqual([
      {
        entry_date: TODAY,
        type: 'INVOICE',
        amount_minor: 535_000,
        invoice_id: invoice.id,
        payment_id: null
      },
      {
        entry_date: TODAY,
        type: 'PAYMENT',
        amount_minor: -200_000,
        invoice_id: null,
        payment_id: payment.id
      }
    ])
    expect(invoice).toMatchObject({
      receivedMinor: 200_000,
      netOutstandingMinor: 435_000,
      balanceAfterMinor: 435_000
    })
    // It is an ordinary payment: listed, readable, numbered with the other payments.
    expect(getPayment(db, payment.id as number)).toMatchObject({
      paymentNo: 'RCP-000001',
      amountMinor: 200_000
    })
    expect(
      listPayments(db, {
        page: 1,
        pageSize: 25,
        search: '',
        status: 'all',
        method: 'all',
        dateFrom: null,
        dateTo: null
      }).total
    ).toBe(1)
    expect(nextSequence('payment')).toBe(2)
  })

  it('creates no payment when nothing is received, even with a payment method chosen', () => {
    const invoice = post([teaLine()], { receivedMinor: 0, paymentMethod: 'CASH' })
    expect(invoice.payment).toBeNull()
    expect(count('payments')).toBe(0)
    expect(nextSequence('payment')).toBe(1)
  })

  it('writes no zero INVOICE entry for a zero total, but still moves stock and records the cost', () => {
    const invoice = post([line(tea.id, [qty(piece(), 3, 0, true)])])
    expect(invoice).toMatchObject({
      totalMinor: 0,
      cogsMinor: 25_057,
      previousBalanceMinor: 100_000,
      netOutstandingMinor: 100_000
    })
    expect(count('customer_ledger', "WHERE type = 'INVOICE'")).toBe(0)
    expect(saleMovements()).toEqual([
      expect.objectContaining({ qty_base: -3, value_minor: -25_057 })
    ])
    expect(balance(ali.id)).toBe(100_000)

    // Money received with a zero invoice is still a payment.
    const paid = post([line(tea.id, [qty(piece(), 1, 0, true)])], {
      receivedMinor: 5_000,
      paymentMethod: 'CASH'
    })
    expect(ledger(ali.id).slice(1)).toEqual([
      {
        entry_date: TODAY,
        type: 'PAYMENT',
        amount_minor: -5_000,
        invoice_id: null,
        payment_id: paid.payment!.id
      }
    ])
    expect(paid.balanceAfterMinor).toBe(95_000)
  })

  it('turns an overpayment into an advance: a negative balance', () => {
    const invoice = post([line(tea.id, [qty(piece(), 3, 11_000)])], {
      receivedMinor: 200_000,
      paymentMethod: 'CASH'
    })
    expect(invoice).toMatchObject({
      previousBalanceMinor: 100_000,
      totalMinor: 33_000,
      receivedMinor: 200_000,
      netOutstandingMinor: -67_000,
      balanceAfterMinor: -67_000
    })
    expect(balance(ali.id)).toBe(-67_000)
  })
})

// --- Customers -------------------------------------------------------------------------------------------------------

describe('the customer and the ledger', () => {
  it('sells to the walk-in customer, copying its details', () => {
    const invoice = post([line(rice.id, [qty(bag(), 1, 150_000)])], {
      customerId: walkInId,
      receivedMinor: 150_000,
      paymentMethod: 'CASH'
    })
    expect(invoice).toMatchObject({
      customerCode: 'C-00001',
      customerName: 'Cash / Walk-in',
      customerShopName: null,
      previousBalanceMinor: 0,
      netOutstandingMinor: 0,
      balanceAfterMinor: 0
    })
  })

  it('refuses an inactive customer and a missing one, saving nothing', () => {
    setCustomerActive(db, { id: ali.id, active: false })
    const before = state()
    expect(failure(() => post([teaLine()]))).toEqual({
      code: 'FORBIDDEN_STATE',
      message: 'C-00002 Ali Raza is inactive. Reactivate the customer to make an invoice.',
      fieldErrors: { customerId: ['This customer is inactive.'] }
    })
    expect(failure(() => post([teaLine()], { customerId: 999 }))).toEqual({
      code: 'NOT_FOUND',
      message: 'This customer no longer exists.',
      fieldErrors: { customerId: ['This customer no longer exists.'] }
    })
    expect(state()).toEqual(before)
  })

  it('snapshots the balance just before the invoice, including entries made earlier the same day', () => {
    createPayment(
      db,
      {
        requestId: nextRequestId(),
        customerId: ali.id,
        paymentDate: TODAY,
        amountMinor: 30_000,
        method: 'CASH',
        reference: null,
        note: null,
        currencyMinorDigits: 2
      },
      NOW
    )
    adjustCustomerBalance(
      db,
      {
        customerId: ali.id,
        entryDate: TODAY,
        direction: 'INCREASE',
        amountMinor: 5_000,
        reason: 'Old bill',
        currencyMinorDigits: 2
      },
      NOW
    )
    const first = post([line(tea.id, [qty(piece(), 1, 11_000)])])
    const second = post([line(tea.id, [qty(piece(), 2, 11_000)])], {
      receivedMinor: 10_000,
      paymentMethod: 'CASH'
    })
    expect([first.previousBalanceMinor, first.netOutstandingMinor]).toEqual([75_000, 86_000])
    expect([second.previousBalanceMinor, second.netOutstandingMinor]).toEqual([86_000, 98_000])
    expect(balance(ali.id)).toBe(98_000)
  })

  it('only appends ledger entries: earlier entries stay exactly as they were', () => {
    const bilal = customer({
      name: 'Bilal Ahmed',
      shopName: null,
      opening: { side: 'ADVANCE', amountMinor: 20_000, date: STOCK_DATE }
    })
    const before = db.all('SELECT * FROM customer_ledger ORDER BY id')
    post([teaLine()], { receivedMinor: 100_000, paymentMethod: 'CASH' })
    post([line(sugar.id, [qty(kg(), 1, 20_000)])], { customerId: bilal.id })
    const after = db.all('SELECT * FROM customer_ledger ORDER BY id')
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.slice(before.length).map((row) => (row as { type: string }).type)).toEqual([
      'INVOICE',
      'PAYMENT',
      'INVOICE'
    ])
    expect(balance(bilal.id)).toBe(0)
  })
})

// --- Stock and COGS --------------------------------------------------------------------------------------------------

describe('stock and cost of goods sold', () => {
  it('lowers the quantity and the value of stock by the sale', () => {
    const before = stockPosition(db, tea.id)
    const invoice = post([teaLine()])
    const after = stockPosition(db, tea.id)
    expect(before.qtyBase - after.qtyBase).toBe(53)
    expect(before.valueMinor - after.valueMinor).toBe(invoice.cogsMinor)
  })

  it('refuses more than the stock, naming the product with the quantity in stock and the quantity needed', () => {
    const before = state()
    const error = failure(() => post([line(tea.id, [qty(box(), 11, 240_000)])]))
    expect(error).toEqual({
      code: 'INSUFFICIENT_STOCK',
      message: 'Not enough stock of P-001 Tea 950g: 10 Box + 7 Piece in stock, 11 Box needed.',
      fieldErrors: { 'lines.0.quantities': ['Only 10 Box + 7 Piece in stock.'] },
      details: {
        shortages: [
          {
            lineIndex: 0,
            productId: tea.id,
            productCode: 'P-001',
            productName: 'Tea 950g',
            availableQtyBase: 247,
            requestedQtyBase: 264
          }
        ]
      }
    })
    expect(state()).toEqual(before)

    const both = failure(() =>
      post([line(tea.id, [qty(box(), 11, 240_000)]), line(rice.id, [qty(bag(), 21, 150_000)])])
    )
    expect(both.message).toBe('Not enough stock for 2 products. Check the highlighted lines.')
    expect(Object.keys(both.fieldErrors ?? {})).toEqual([
      'lines.0.quantities',
      'lines.1.quantities'
    ])
    expect(state()).toEqual(before)
  })

  it('counts free scheme quantity against the stock too', () => {
    const before = state()
    const error = failure(() =>
      post([
        line(tea.id, [qty(box(), 10, 240_000)], {
          freeQuantities: [{ unitId: box(), quantity: 1 }]
        })
      ])
    )
    expect(error.code).toBe('INSUFFICIENT_STOCK')
    expect(error.details).toMatchObject({
      shortages: [{ availableQtyBase: 247, requestedQtyBase: 264 }]
    })
    expect(state()).toEqual(before)

    // Exactly the stock: 240 paid + 7 free leaves nothing, and exactly no value.
    const invoice = post([
      line(tea.id, [qty(box(), 10, 240_000)], {
        freeQuantities: [{ unitId: piece(), quantity: 7 }]
      })
    ])
    expect(invoice.cogsMinor).toBe(2_063_007)
    expect(stockPosition(db, tea.id)).toEqual({ qtyBase: 0, valueMinor: 0 })
  })

  it('costs at the moving weighted average, and the last units take exactly the value left', () => {
    const first = post([teaLine()])
    expect(first.cogsMinor).toBe(442_670)
    expect(stockPosition(db, tea.id)).toEqual({ qtyBase: 194, valueMinor: 1_620_337 })

    // 194 = 8 Box + 2 Piece: everything left.
    const last = post([line(tea.id, [qty(box(), 8, 240_000), qty(piece(), 2, 11_000)])])
    expect(last.cogsMinor).toBe(1_620_337)
    expect(stockPosition(db, tea.id)).toEqual({ qtyBase: 0, valueMinor: 0 })
    expect(failure(() => post([line(tea.id, [qty(piece(), 1, 11_000)])])).code).toBe(
      'INSUFFICIENT_STOCK'
    )

    // New stock starts a new average.
    receive(TODAY, [[tea.id, piece(), 3, 10_000]])
    expect(post([line(tea.id, [qty(piece(), 1, 11_000)])]).cogsMinor).toBe(10_000)
  })

  it('sells stock that cost nothing at zero cost', () => {
    const sample = product({ code: 'Z-001', name: 'Sample sachet' }, [
      unit({ name: 'Piece', retailPriceMinor: 5_000 })
    ])
    receive(STOCK_DATE, [[sample.id, unitOf(sample, 'Piece'), 10, 0]])
    const invoice = post([line(sample.id, [qty(unitOf(sample, 'Piece'), 4, 5_000)])])
    expect(invoice).toMatchObject({ grossMinor: 20_000, cogsMinor: 0 })
    expect(saleMovements()).toEqual([
      expect.objectContaining({ product_id: sample.id, qty_base: -4, value_minor: 0 })
    ])
    expect(Object.is(saleMovements()[0].value_minor, -0)).toBe(false)
    expect(stockPosition(db, sample.id)).toEqual({ qtyBase: 6, valueMinor: 0 })
  })

  it('leaves products that are not on the invoice untouched', () => {
    const riceBefore = stockPosition(db, rice.id)
    post([teaLine(), line(sugar.id, [qty(kg(), 25, 20_000)])])
    expect(stockPosition(db, rice.id)).toEqual(riceBefore)
    expect(stockPosition(db, sugar.id)).toEqual({ qtyBase: 75, valueMinor: 1_125_000 })
  })

  it('keeps each historical cost frozen when later stock arrives at another cost', () => {
    const first = post([teaLine()])
    receive(TODAY, [[tea.id, box(), 5, 300_000]])
    post([line(tea.id, [qty(box(), 1, 240_000)])])
    expect(getInvoice(db, first.id)).toMatchObject({
      cogsMinor: 442_670,
      lines: [{ costMinor: 442_670 }]
    })
  })
})

// --- Products and units ----------------------------------------------------------------------------------------------

describe('products and units', () => {
  it('refuses a missing or inactive product, and units that do not belong, are inactive or are not sold', () => {
    const coffee = product({ code: 'C-100', name: 'Coffee' }, [
      unit({ name: 'Jar', retailPriceMinor: 90_000 }),
      unit({
        name: 'Carton',
        baseQty: 12,
        isBase: false,
        canSell: false,
        retailPriceMinor: 1_000_000
      }),
      unit({ name: 'Tray', baseQty: 6, isBase: false, isActive: false, retailPriceMinor: 500_000 })
    ])
    receive(STOCK_DATE, [[coffee.id, unitOf(coffee, 'Jar'), 50, 50_000]])
    setProductActive(db, { id: rice.id, active: false })
    const before = state()

    const error = failure(() =>
      post([
        line(999, [qty(1, 1, 0, true)]),
        line(rice.id, [qty(bag(), 1, 150_000)]),
        line(tea.id, [qty(kg(), 1, 20_000)], { freeQuantities: [{ unitId: bag(), quantity: 1 }] }),
        line(
          coffee.id,
          [qty(unitOf(coffee, 'Carton'), 1, 1_000_000), qty(unitOf(coffee, 'Tray'), 1, 500_000)],
          {
            freeQuantities: [{ unitId: unitOf(coffee, 'Carton'), quantity: 1 }]
          }
        )
      ])
    )
    expect(error).toEqual({
      code: 'VALIDATION',
      message: 'Check the highlighted lines.',
      fieldErrors: {
        'lines.0.productId': ['This product no longer exists.'],
        'lines.1.productId': ['R-001 Rice 5kg is inactive.'],
        'lines.2.quantities.0.unitId': ['This unit does not belong to the product.'],
        'lines.2.freeQuantities.0.unitId': ['This unit does not belong to the product.'],
        'lines.3.quantities.0.unitId': ['Carton cannot be sold. Choose a unit that can be sold.'],
        'lines.3.quantities.1.unitId': ['Tray is inactive.'],
        'lines.3.freeQuantities.0.unitId': [
          'Carton cannot be sold. Choose a unit that can be sold.'
        ]
      }
    })
    expect(state()).toEqual(before)
  })

  it('takes unit sizes from the database: a size in the request is refused', () => {
    const input = invoiceInput([teaLine()]) as unknown as {
      lines: Array<{ quantities: Array<Record<string, unknown>> }>
    }
    input.lines[0].quantities[0].unitBaseQty = 1
    const error = failure(() => createInvoice(db, input, NOW))
    expect(error.code).toBe('VALIDATION')
    expect(Object.keys(error.fieldErrors ?? {})).toEqual(['lines.0.quantities.0'])
    expect(count('invoices')).toBe(0)
  })

  it('refuses the same product on two lines', () => {
    const error = failure(() => post([teaLine(), line(tea.id, [qty(piece(), 1, 11_000)])]))
    expect(error.fieldErrors).toEqual({
      'lines.1.productId': [
        'This product is already on line 1. Enter all its quantities on that line.'
      ]
    })
    expect(count('invoices')).toBe(0)
  })

  it('refuses amounts too large to keep exactly, before writing anything', () => {
    const before = state()
    expect(
      failure(() => post([line(tea.id, [qty(piece(), 2, Number.MAX_SAFE_INTEGER, true)])]))
    ).toEqual({
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors: { 'lines.0': ['The amounts on this line are too large.'] }
    })
    expect(state()).toEqual(before)

    adjustCustomerBalance(
      db,
      {
        customerId: ali.id,
        entryDate: TODAY,
        direction: 'INCREASE',
        amountMinor: Number.MAX_SAFE_INTEGER - 100_000,
        reason: 'Test',
        currencyMinorDigits: 2
      },
      NOW
    )
    const afterAdjustment = state()
    expect(failure(() => post([teaLine()]))).toEqual({
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors: { root: ['The invoice amounts are too large.'] }
    })
    expect(state()).toEqual(afterAdjustment)
  })

  it('refuses amounts entered with other currency decimal places', () => {
    expect(failure(() => post([teaLine()], { currencyMinorDigits: 3 })).code).toBe('CONFLICT')
    expect(count('invoices')).toBe(0)
  })
})

// --- Posting dates ---------------------------------------------------------------------------------------------------

describe('posting dates', () => {
  it('refuses a future date', () => {
    expect(failure(() => post([teaLine()], { invoiceDate: '2026-09-17' }))).toEqual({
      code: 'DATE_NOT_ALLOWED',
      message: 'The date cannot be later than today (16-Sep-2026).',
      fieldErrors: { invoiceDate: ['The date cannot be later than today (16-Sep-2026).'] },
      details: { latestDate: TODAY }
    })
  })

  it("refuses a date before a product's latest stock movement", () => {
    receive('2026-09-14', [[rice.id, bag(), 1, 120_000]])
    const error = failure(() =>
      post([teaLine(), line(rice.id, [qty(bag(), 1, 150_000)])], { invoiceDate: '2026-09-12' })
    )
    expect(error).toEqual({
      code: 'DATE_NOT_ALLOWED',
      message: 'R-001 Rice 5kg has stock activity on 14-Sep-2026. Use that date or later.',
      fieldErrors: {
        invoiceDate: ['R-001 Rice 5kg has stock activity on 14-Sep-2026. Use that date or later.']
      },
      details: { earliestDate: '2026-09-14', productId: rice.id }
    })
    expect(
      post([teaLine(), line(rice.id, [qty(bag(), 1, 150_000)])], { invoiceDate: '2026-09-14' })
        .invoiceNo
    ).toBe('INV-000001')
  })

  it("refuses a date before the customer's latest ledger entry", () => {
    adjustCustomerBalance(
      db,
      {
        customerId: ali.id,
        entryDate: '2026-09-14',
        direction: 'DECREASE',
        amountMinor: 1_000,
        reason: 'Rounding',
        currencyMinorDigits: 2
      },
      NOW
    )
    const error = failure(() => post([teaLine()], { invoiceDate: '2026-09-12' }))
    expect(error).toEqual({
      code: 'DATE_NOT_ALLOWED',
      message:
        'C-00002 Ali Raza (Ali Traders) has account activity on 14-Sep-2026. Use that date or later.',
      fieldErrors: {
        invoiceDate: [
          'C-00002 Ali Raza (Ali Traders) has account activity on 14-Sep-2026. Use that date or later.'
        ]
      },
      details: { earliestDate: '2026-09-14', customerId: ali.id, customerCode: 'C-00002' }
    })
  })

  it('names whichever floor is later when both the customer and a product block the date', () => {
    receive('2026-09-13', [[tea.id, piece(), 1, 9_000]])
    adjustCustomerBalance(
      db,
      {
        customerId: ali.id,
        entryDate: '2026-09-14',
        direction: 'DECREASE',
        amountMinor: 1_000,
        reason: 'Rounding',
        currencyMinorDigits: 2
      },
      NOW
    )
    expect(failure(() => post([teaLine()], { invoiceDate: '2026-09-12' })).details).toMatchObject({
      earliestDate: '2026-09-14',
      customerId: ali.id
    })

    receive('2026-09-15', [[tea.id, piece(), 1, 9_000]])
    expect(failure(() => post([teaLine()], { invoiceDate: '2026-09-12' })).details).toEqual({
      earliestDate: '2026-09-15',
      productId: tea.id
    })
    expect(post([teaLine()], { invoiceDate: '2026-09-15' }).invoiceDate).toBe('2026-09-15')
  })

  it('is not blocked by later activity of other products or other customers', () => {
    receive(TODAY, [[rice.id, bag(), 1, 120_000]])
    const bilal = customer({
      name: 'Bilal Ahmed',
      opening: { side: 'DUE', amountMinor: 1_000, date: TODAY }
    })
    const invoice = post([teaLine()], {
      invoiceDate: '2026-09-12',
      receivedMinor: 1_000,
      paymentMethod: 'CASH'
    })
    expect(invoice.invoiceDate).toBe('2026-09-12')
    expect(invoice.payment?.paymentDate).toBe('2026-09-12')
    expect(saleMovements()[0]).toMatchObject({ movement_date: '2026-09-12' })
    expect(
      ledger(ali.id)
        .slice(1)
        .map((row) => row.entry_date)
    ).toEqual(['2026-09-12', '2026-09-12'])
    expect(balance(bilal.id)).toBe(1_000)
  })
})

// --- Idempotency -----------------------------------------------------------------------------------------------------

describe('request idempotency', () => {
  it('returns the saved invoice for a repeated request id and writes nothing again', () => {
    const input = invoiceInput([teaLine(), line(sugar.id, [qty(kg(), 2, 20_000)])], {
      receivedMinor: 100_000,
      paymentMethod: 'CASH'
    })
    const first = createInvoice(db, input, NOW)
    const saved = state()
    const second = createInvoice(db, input, NOW)

    expect(second).toEqual({ ...first, replayed: true })
    expect(state()).toEqual(saved)
    expect(count('invoices')).toBe(1)
    expect(count('invoice_items')).toBe(2)
    expect(count('invoice_item_quantities')).toBe(3)
    expect(count('stock_movements', "WHERE type = 'SALE'")).toBe(2)
    expect(count('customer_ledger', "WHERE type = 'INVOICE'")).toBe(1)
    expect(count('payments')).toBe(1)
    expect(nextSequence('invoice')).toBe(2)
    expect(nextSequence('payment')).toBe(2)
  })

  it('returns the saved invoice even if prices, stock or the input changed since', () => {
    const input = invoiceInput([teaLine()])
    const first = createInvoice(db, input, NOW)
    updateProduct(
      db,
      productUpdate(tea, {}, () => ({ retailPriceMinor: 1 }))
    )
    const again = createInvoice(
      db,
      { ...input, lines: [line(tea.id, [qty(box(), 50, 240_000)])] },
      NOW
    )
    expect(again).toMatchObject({
      id: first.id,
      invoiceNo: 'INV-000001',
      grossMinor: 535_000,
      replayed: true
    })
    expect(count('invoices')).toBe(1)
  })
})

// --- Invoice numbers -------------------------------------------------------------------------------------------------

describe('invoice numbers', () => {
  it('numbers invoices from the invoice sequence; counter payments share the payment numbers', () => {
    createPayment(
      db,
      {
        requestId: nextRequestId(),
        customerId: ali.id,
        paymentDate: TODAY,
        amountMinor: 1_000,
        method: 'CASH',
        reference: null,
        note: null,
        currencyMinorDigits: 2
      },
      NOW
    )
    expect(post([teaLine()]).invoiceNo).toBe('INV-000001')
    const second = post([line(rice.id, [qty(bag(), 1, 150_000)])], {
      receivedMinor: 150_000,
      paymentMethod: 'CASH'
    })
    expect([second.invoiceNo, second.payment?.paymentNo]).toEqual(['INV-000002', 'RCP-000002'])
    expect(db.all('SELECT seq_no, invoice_no FROM invoices ORDER BY id')).toEqual([
      { seq_no: 1, invoice_no: 'INV-000001' },
      { seq_no: 2, invoice_no: 'INV-000002' }
    ])
  })

  it('uses the invoice prefix and padding settings', () => {
    updateSettings(db, { 'invoice.prefix': 'SF-', 'invoice.padding': 4 })
    expect(post([teaLine()]).invoiceNo).toBe('SF-0001')
    updateSettings(db, { 'invoice.prefix': '', 'invoice.padding': 1 })
    expect(post([line(sugar.id, [qty(kg(), 1, 20_000)])]).invoiceNo).toBe('2')
  })

  it('starts at invoice.startNumber while no invoice number has been used, and never renumbers later', () => {
    updateSettings(db, { 'invoice.startNumber': 501 })
    // A failed invoice uses no number, so the start still applies afterwards.
    expect(() => post([teaLine()], {}, failingWrites(db, /INSERT INTO invoice_items/))).toThrow(
      'simulated write failure'
    )
    expect(nextSequence('invoice')).toBe(1)

    expect(post([teaLine()]).invoiceNo).toBe('INV-000501')
    updateSettings(db, { 'invoice.startNumber': 900 })
    expect(post([line(sugar.id, [qty(kg(), 1, 20_000)])]).invoiceNo).toBe('INV-000502')
    updateSettings(db, { 'invoice.startNumber': 1 })
    expect(post([line(rice.id, [qty(bag(), 1, 150_000)])]).invoiceNo).toBe('INV-000503')
  })

  it('refuses to reuse a number that is already taken, saving nothing', () => {
    post([teaLine()])
    db.run("UPDATE sequences SET next_value = 1 WHERE name = 'invoice'")
    const before = state()
    expect(failure(() => post([line(sugar.id, [qty(kg(), 1, 20_000)])]))).toEqual({
      code: 'CONFLICT',
      message: 'The next invoice number, INV-000001, is already used, so the invoice was not saved.'
    })
    expect(state()).toEqual(before)
  })
})

// --- Atomicity -------------------------------------------------------------------------------------------------------

describe('atomicity', () => {
  it.each<[string, (target: Db) => Db]>([
    ['after the invoice header', (target) => failingWrites(target, /INSERT INTO invoice_items/)],
    [
      'after an invoice item',
      (target) => failingWrites(target, /INSERT INTO invoice_item_quantities/)
    ],
    ['after the quantity rows', (target) => failingWrites(target, /INSERT INTO stock_movements/)],
    [
      'after the first stock movement',
      (target) => failingWrites(target, /INSERT INTO stock_movements/, 2)
    ],
    ['after the INVOICE ledger entry', (target) => failingWrites(target, /INSERT INTO payments/)],
    ['after the payment row', (target) => failingWrites(target, /INSERT INTO customer_ledger/, 2)],
    [
      'after the PAYMENT ledger entry',
      (target) => failingReads(target, /FROM invoice_item_quantities/)
    ]
  ])('a failure %s leaves no invoice, stock, balance, payment or number behind', (_point, wrap) => {
    const lines = [teaLine(), line(sugar.id, [qty(kg(), 10, 20_000)])]
    const input = invoiceInput(lines, { receivedMinor: 100_000, paymentMethod: 'CASH' })
    const before = state()

    expect(() => createInvoice(wrap(db), input, NOW)).toThrow(/simulated (write|read) failure/)
    expect(state()).toEqual(before)

    // Nothing was used up: the same request saves normally with the first numbers.
    const saved = createInvoice(db, input, NOW)
    expect([saved.invoiceNo, saved.payment?.paymentNo, saved.replayed]).toEqual([
      'INV-000001',
      'RCP-000001',
      false
    ])
    expect(saved.balanceAfterMinor).toBe(100_000 + 735_000 - 100_000)
  })
})

// --- Snapshots -------------------------------------------------------------------------------------------------------

describe('historical snapshots', () => {
  it('keeps the saved customer, product, company, packing, unit and price details after they change', () => {
    const invoice = post([teaLine()], { receivedMinor: 50_000, paymentMethod: 'CASH' })
    const saved = getInvoice(db, invoice.id)

    updateCustomer(db, {
      id: ali.id,
      name: 'Ali Raza Khan',
      shopName: 'Khan Traders',
      phone: '0321-0000000',
      address: 'Anarkali',
      city: 'Karachi',
      notes: null
    })
    updateCompany(db, { id: tapalId, name: 'Tapal Tea' })
    updateProduct(
      db,
      productUpdate(
        tea,
        { code: 'P-900', name: 'Tapal Danedar', packingLabel: '1*6*24' },
        (unitRow) => ({
          name: unitRow.name === 'Box' ? 'Carton' : 'Pack',
          shortName: null,
          retailPriceMinor: 999_999,
          wholesalePriceMinor: 888_888
        })
      )
    )

    const reread = getInvoice(db, invoice.id)
    expect(reread).toEqual(saved)
    expect(reread).toMatchObject({
      customerName: 'Ali Raza',
      customerShopName: 'Ali Traders',
      customerPhone: '0300-1234567',
      customerAddress: 'Main Bazar',
      customerCity: 'Lahore',
      lines: [
        {
          productCode: 'P-001',
          productName: 'Tea 950g',
          companyName: 'Tapal',
          packingLabel: '1*12*18',
          quantities: [
            { unitName: 'Box', unitShortName: 'Bx', unitPriceMinor: 240_000 },
            { unitName: 'Piece', unitShortName: 'Pcs', unitPriceMinor: 11_000 }
          ]
        }
      ]
    })
  })
})
