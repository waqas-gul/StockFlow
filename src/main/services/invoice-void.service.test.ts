import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Customer, CustomerCreateInput } from '@shared/customers'
import {
  WALK_IN_VOID_MESSAGE,
  type InvoiceCreateInput,
  type InvoiceLineInput,
  type InvoiceQuantityInput,
  type InvoiceSaveResult
} from '@shared/invoices'
import type { Product, ProductUnitInput } from '@shared/products'
import type { Db, SqlValue } from '../db/adapter'
import { runIntegrityCheck } from '../db/integrity'
import { migrations } from '../db/migrations'
import { createSchemaDatabase, createTempDir, thrown, type TempDir } from '../db/test-utils'
import { AppFailure } from '../errors'
import { createCustomer, setCustomerActive } from './customers.service'
import { stockPosition } from './inventory'
import { voidInvoice } from './invoice-void.service'
import { createInvoice, getInvoice } from './invoices.service'
import { createPayment, getPayment, voidPayment } from './payments.service'
import { createProduct } from './products.service'
import { receiveStock } from './stock.service'
import { failingReads, failingWrites } from './test-utils'

// Test data lives only in temporary databases.

/** The void happens "now": 16 Sep 2026. */
const NOW = new Date(2026, 8, 16, 10, 30, 0)
const TODAY = '2026-09-16'
const STOCK_DATE = '2026-09-10'
const SALE_DATE = '2026-09-12'

let temp: TempDir
let db: Db
let requests: number
/** Piece (base; retail 110) and Box of 24 (retail 2,400). 10 Box at Rs 2,400.00 a box: Q 240, V 24,000.00. */
let tea: Product
/** Kg (base; retail 200). 100 Kg at Rs 150.07: Q 100, V 15,007.00. */
let sugar: Product
/** C-00002, owes Rs 1,000.00 since 10-Sep-2026. */
let ali: Customer
let walkInId: number

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  requests = 0
  tea = product('P-001', 'Tea 950g', [
    unit({ name: 'Piece', retailPriceMinor: 11_000 }),
    unit({ name: 'Box', baseQty: 24, isBase: false, retailPriceMinor: 240_000 })
  ])
  sugar = product('S-001', 'Sugar 1kg', [unit({ name: 'Kg', retailPriceMinor: 20_000 })])
  receive(STOCK_DATE, [
    [tea.id, box(), 10, 240_000],
    [sugar.id, kg(), 100, 15_007]
  ])
  ali = customer({ opening: { side: 'DUE', amountMinor: 100_000, date: STOCK_DATE } })
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

function product(code: string, name: string, units: ProductUnitInput[]): Product {
  return createProduct(db, {
    code,
    name,
    companyId: null,
    packingLabel: '1*24',
    lowStockThresholdBase: 0,
    currencyMinorDigits: 2,
    units
  })
}

function unitOf(item: Product, name: string): number {
  return item.units.find((candidate) => candidate.name === name)!.id
}

const piece = (): number => unitOf(tea, 'Piece')
const box = (): number => unitOf(tea, 'Box')
const kg = (): number => unitOf(sugar, 'Kg')

function receive(
  date: string,
  lines: Array<[number, number, number, number]>,
  now: Date = NOW
): void {
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
    now
  )
}

function customer(overrides: Partial<CustomerCreateInput> = {}): Customer {
  return createCustomer(
    db,
    {
      name: 'Ali Raza',
      shopName: 'Ali Traders',
      phone: null,
      address: null,
      city: null,
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

function qty(unitId: number, quantity: number, unitPriceMinor: number): InvoiceQuantityInput {
  return { unitId, quantity, unitPriceMinor, priceOverride: false }
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

/** 2 Box + 5 Piece of tea: Rs 5,350.00, 53 pieces. */
function teaLine(overrides: Partial<InvoiceLineInput> = {}): InvoiceLineInput {
  return line(tea.id, [qty(box(), 2, 240_000), qty(piece(), 5, 11_000)], overrides)
}

function post(
  lines: InvoiceLineInput[],
  overrides: Partial<InvoiceCreateInput> = {}
): InvoiceSaveResult {
  return createInvoice(
    db,
    {
      requestId: nextRequestId(),
      invoiceDate: SALE_DATE,
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
    },
    NOW
  )
}

/** A walk-in cash sale of the tea line, paid in full (Rs 5,350.00). */
function postWalkIn(): InvoiceSaveResult {
  return post([teaLine()], { customerId: walkInId, receivedMinor: 535_000, paymentMethod: 'CASH' })
}

function voidIt(
  id: number,
  overrides: { reason?: string; moneyReturned?: boolean } = {},
  target: Db = db,
  now: Date = NOW
): ReturnType<typeof voidInvoice> {
  return voidInvoice(
    target,
    {
      id,
      reason: overrides.reason ?? 'Wrong customer',
      moneyReturned: overrides.moneyReturned ?? false
    },
    now
  )
}

function failure(fn: () => unknown): AppFailure['error'] {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

function balance(customerId: number): number {
  return db.get<{ total: number }>(
    'SELECT coalesce(sum(amount_minor), 0) AS total FROM customer_ledger WHERE customer_id = ?',
    [customerId]
  )!.total
}

function ledger(customerId: number): Array<[string, string, number]> {
  return db
    .all<{ entry_date: string; type: string; amount_minor: number }>(
      'SELECT entry_date, type, amount_minor FROM customer_ledger WHERE customer_id = ? ORDER BY id',
      [customerId]
    )
    .map((row) => [row.entry_date, row.type, row.amount_minor])
}

function movements(invoiceId: number): Array<Record<string, unknown>> {
  return db.all(
    `SELECT m.id, m.product_id, m.movement_date, m.type, m.qty_base, m.value_minor, m.invoice_item_id
     FROM stock_movements AS m JOIN invoice_items AS ii ON ii.id = m.invoice_item_id
     WHERE ii.invoice_id = ? ORDER BY m.id`,
    [invoiceId]
  )
}

/** Everything a void may change: rows, statuses, stock and balances. */
function state(): Record<string, unknown> {
  return {
    invoices: db.all(
      'SELECT id, status, void_reason, void_date, voided_at FROM invoices ORDER BY id'
    ),
    payments: db.all('SELECT id, status, void_reason, void_date FROM payments ORDER BY id'),
    movements: db.all('SELECT * FROM stock_movements ORDER BY id'),
    ledger: db.all('SELECT * FROM customer_ledger ORDER BY id'),
    stock: [tea, sugar].map((item) => stockPosition(db, item.id)),
    sequences: db.all('SELECT name, next_value FROM sequences ORDER BY name')
  }
}

/** Test-only: lets the test damage an append-only or saved row, to prove the void refuses inconsistent records. */
function withoutTrigger(name: string, sql: string, params: SqlValue[] = []): void {
  const trigger = db.get<{ sql: string }>('SELECT sql FROM sqlite_master WHERE name = ?', [name])!
  db.transaction(() => {
    db.run(`DROP TRIGGER ${name}`)
    db.run(sql, params)
    db.run(trigger.sql)
  })
}

/** An invoice detail without the fields a void sets. */
function withoutVoid(invoice: object): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...invoice }
  for (const key of ['status', 'voidReason', 'voidDate', 'voidedAt', 'balanceAfterMinor'])
    delete rest[key]
  return rest
}

// --- Stock -------------------------------------------------------------------------------------------------------------

describe('voidInvoice: stock comes back at the frozen cost of the sale', () => {
  it('a sale reduces Q and V by its frozen cost, and the void adds exactly that back, dated today', () => {
    const before = stockPosition(db, tea.id)
    expect(before).toEqual({ qtyBase: 240, valueMinor: 2_400_000 })
    const invoice = post([teaLine()])
    const [sale] = invoice.lines
    expect(sale.costMinor).toBe(530_000)
    expect(stockPosition(db, tea.id)).toEqual({ qtyBase: 187, valueMinor: 1_870_000 })

    const voided = voidIt(invoice.id, { reason: '  Customer cancelled  ' }, db, NOW)

    expect(voided).toMatchObject({
      id: invoice.id,
      status: 'VOID',
      voidReason: 'Customer cancelled',
      voidDate: TODAY,
      voidedAt: NOW.toISOString(),
      invoiceDate: SALE_DATE,
      totalMinor: invoice.totalMinor
    })
    expect(movements(invoice.id)).toEqual([
      expect.objectContaining({
        type: 'SALE',
        movement_date: SALE_DATE,
        qty_base: -53,
        value_minor: -530_000
      }),
      expect.objectContaining({
        type: 'SALE_VOID',
        movement_date: TODAY,
        qty_base: 53,
        value_minor: 530_000,
        invoice_item_id: sale.id
      })
    ])
    expect(stockPosition(db, tea.id)).toEqual(before)
  })

  it('uses the frozen cost, not the weighted average after a later receipt at a different cost', () => {
    const invoice = post([teaLine()])
    // 10 more boxes at double the cost: the average is now about Rs 156.21 a piece.
    receive('2026-09-14', [[tea.id, box(), 10, 480_000]])
    const afterReceipt = stockPosition(db, tea.id)
    expect(afterReceipt).toEqual({ qtyBase: 427, valueMinor: 6_670_000 })
    const average = Math.round((afterReceipt.valueMinor * 53) / afterReceipt.qtyBase)
    expect(average).toBe(827_892)

    voidIt(invoice.id)

    const reversal = movements(invoice.id).find((row) => row.type === 'SALE_VOID')
    expect(reversal).toMatchObject({ qty_base: 53, value_minor: 530_000 })
    expect(stockPosition(db, tea.id)).toEqual({ qtyBase: 480, valueMinor: 7_200_000 })
  })

  it('reverses every line of a multi-product invoice: a Box + Piece line with free scheme goods, and another product', () => {
    const before = [tea, sugar].map((item) => stockPosition(db, item.id))
    const invoice = post([
      teaLine({ freeQuantities: [{ unitId: piece(), quantity: 3 }], schemeMinor: 500 }),
      line(sugar.id, [qty(kg(), 7, 20_000)])
    ])
    expect(invoice.lines.map((item) => [item.qtyBase, item.schemeQtyBase])).toEqual([
      [56, 3],
      [7, 0]
    ])
    const costs = invoice.lines.map((item) => item.costMinor)
    // 7 Kg of 100 Kg worth Rs 15,007.00: round-half-up of 105,049.
    expect(costs).toEqual([560_000, 105_049])

    voidIt(invoice.id)

    const reversals = movements(invoice.id).filter((row) => row.type === 'SALE_VOID')
    expect(reversals.map((row) => [row.product_id, row.qty_base, row.value_minor])).toEqual([
      [tea.id, 56, 560_000],
      [sugar.id, 7, 105_049]
    ])
    expect([tea, sugar].map((item) => stockPosition(db, item.id))).toEqual(before)
    expect(
      runIntegrityCheck(db, { migrations }).checks.filter((check) => check.status !== 'OK')
    ).toEqual([])
  })

  it('restores zero-value goods with a zero value', () => {
    const free = product('F-001', 'Sample sachet', [unit({ name: 'Sachet', retailPriceMinor: 0 })])
    receive(STOCK_DATE, [[free.id, unitOf(free, 'Sachet'), 50, 0]])
    const invoice = post([line(free.id, [qty(unitOf(free, 'Sachet'), 50, 0)])])
    expect(invoice.lines[0].costMinor).toBe(0)
    expect(stockPosition(db, free.id)).toEqual({ qtyBase: 0, valueMinor: 0 })

    voidIt(invoice.id)

    expect(movements(invoice.id).map((row) => [row.type, row.qty_base, row.value_minor])).toEqual([
      ['SALE', -50, 0],
      ['SALE_VOID', 50, 0]
    ])
    expect(stockPosition(db, free.id)).toEqual({ qtyBase: 50, valueMinor: 0 })
  })

  it('never changes the original sale rows: only the status and void details of the invoice change', () => {
    const invoice = post([teaLine()], { biltyNo: 'B-1' })
    const saleRows = movements(invoice.id)
    const items = db.all('SELECT * FROM invoice_items ORDER BY id')
    const quantities = db.all('SELECT * FROM invoice_item_quantities ORDER BY id')
    const saved = getInvoice(db, invoice.id)

    const voided = voidIt(invoice.id)

    expect(movements(invoice.id).slice(0, saleRows.length)).toEqual(saleRows)
    expect(db.all('SELECT * FROM invoice_items ORDER BY id')).toEqual(items)
    expect(db.all('SELECT * FROM invoice_item_quantities ORDER BY id')).toEqual(quantities)
    expect(voided).toMatchObject({ status: 'VOID', voidReason: 'Wrong customer', voidDate: TODAY })
    expect(withoutVoid(voided)).toEqual(withoutVoid(saved))
    expect(withoutVoid(getInvoice(db, invoice.id))).toEqual(withoutVoid(saved))
  })

  it('a double void is refused and writes nothing more', () => {
    const invoice = post([teaLine()])
    voidIt(invoice.id)
    const after = state()

    expect(failure(() => voidIt(invoice.id))).toEqual({
      code: 'FORBIDDEN_STATE',
      message: `Invoice ${invoice.invoiceNo} is already void.`
    })
    expect(state()).toEqual(after)
  })

  it('refuses, with INVENTORY_INVARIANT, when the sale movement no longer matches the frozen line', () => {
    const invoice = post([teaLine()])
    withoutTrigger(
      'trg_stock_movements_no_update',
      "UPDATE stock_movements SET value_minor = value_minor - 1 WHERE type = 'SALE'"
    )
    const before = state()

    expect(failure(() => voidIt(invoice.id))).toEqual({
      code: 'INVENTORY_INVARIANT',
      message: `Invoice ${invoice.invoiceNo} cannot be voided: its saved stock records do not match the invoice, so the stock could not be restored exactly. Nothing was changed.`
    })
    expect(state()).toEqual(before)
  })

  it('refuses a missing invoice and an invalid request', () => {
    expect(failure(() => voidIt(999)).code).toBe('NOT_FOUND')
    const invoice = post([teaLine()])
    expect(
      failure(() => voidInvoice(db, { id: invoice.id, reason: '  ', moneyReturned: false }, NOW))
    ).toEqual({
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors: { reason: ['Enter the reason for voiding.'] }
    })
    expect(
      failure(() => voidInvoice(db, { id: invoice.id, reason: 'x' }, NOW)).fieldErrors
    ).toEqual({
      moneyReturned: ['Say whether the money was returned.']
    })
    expect(getInvoice(db, invoice.id).status).toBe('POSTED')
  })
})

// --- Dates -------------------------------------------------------------------------------------------------------------

describe('voidInvoice: the void is dated today', () => {
  it('refuses when a product on the invoice has stock activity after today (the computer clock is behind)', () => {
    const invoice = post([teaLine()])
    receive('2026-09-18', [[tea.id, box(), 1, 240_000]], new Date(2026, 8, 18, 9, 0, 0))
    const before = state()

    const error = failure(() => voidIt(invoice.id))
    expect(error.code).toBe('DATE_NOT_ALLOWED')
    expect(error.message).toBe(
      'P-001 Tea 950g has stock activity on 18-Sep-2026. Use that date or later.'
    )
    expect(state()).toEqual(before)
  })

  it('refuses when the customer has account activity after today', () => {
    const invoice = post([teaLine()])
    createPayment(
      db,
      {
        requestId: nextRequestId(),
        customerId: ali.id,
        paymentDate: '2026-09-18',
        amountMinor: 1_000,
        method: 'CASH',
        reference: null,
        note: null,
        currencyMinorDigits: 2
      },
      new Date(2026, 8, 18, 9, 0, 0)
    )
    expect(failure(() => voidIt(invoice.id)).code).toBe('DATE_NOT_ALLOWED')
    expect(getInvoice(db, invoice.id).status).toBe('POSTED')
  })

  it('the reversal becomes the product posting floor: nothing can be backdated before it', () => {
    const invoice = post([teaLine()])
    voidIt(invoice.id)
    const error = thrown(() => receive('2026-09-15', [[tea.id, box(), 1, 240_000]]))
    expect((error as AppFailure).error).toMatchObject({
      code: 'DATE_NOT_ALLOWED',
      message: 'P-001 Tea 950g has stock activity on 16-Sep-2026. Use that date or later.'
    })
  })
})

// --- Customer account ----------------------------------------------------------------------------------------------

describe('voidInvoice: the customer account', () => {
  it('appends INVOICE_VOID of −total; the counter payment stays posted, so the balance keeps it', () => {
    const invoice = post([teaLine()], { receivedMinor: 100_000, paymentMethod: 'BANK' })
    expect(balance(ali.id)).toBe(100_000 + 535_000 - 100_000)

    const voided = voidIt(invoice.id)

    expect(ledger(ali.id)).toEqual([
      [STOCK_DATE, 'OPENING', 100_000],
      [SALE_DATE, 'INVOICE', 535_000],
      [SALE_DATE, 'PAYMENT', -100_000],
      [TODAY, 'INVOICE_VOID', -535_000]
    ])
    expect(
      db.get("SELECT invoice_id, note FROM customer_ledger WHERE type = 'INVOICE_VOID'")
    ).toEqual({ invoice_id: invoice.id, note: 'Wrong customer' })
    expect(voided.balanceAfterMinor).toBe(0)
    expect(voided.payment).toMatchObject({ paymentNo: 'RCP-000001', status: 'POSTED' })
    expect(getPayment(db, invoice.payment!.id).status).toBe('POSTED')
  })

  it('a fully paid invoice leaves the payment as an advance', () => {
    const bilal = customer({ name: 'Bilal Ahmed', shopName: null })
    const invoice = post(
      [
        line(tea.id, [
          { unitId: piece(), quantity: 10, unitPriceMinor: 10_000, priceOverride: true }
        ])
      ],
      { customerId: bilal.id, receivedMinor: 100_000, paymentMethod: 'CASH' }
    )
    expect([invoice.totalMinor, balance(bilal.id)]).toEqual([100_000, 0])

    expect(voidIt(invoice.id).balanceAfterMinor).toBe(-100_000)
    expect(ledger(bilal.id).map(([, type, amount]) => [type, amount])).toEqual([
      ['INVOICE', 100_000],
      ['PAYMENT', -100_000],
      ['INVOICE_VOID', -100_000]
    ])
  })

  it('a zero-total invoice gets no INVOICE_VOID entry, and its stock still comes back', () => {
    const invoice = post([
      line(tea.id, [{ unitId: piece(), quantity: 4, unitPriceMinor: 0, priceOverride: true }])
    ])
    expect(invoice.totalMinor).toBe(0)
    const entries = ledger(ali.id)

    const voided = voidIt(invoice.id)

    expect(ledger(ali.id)).toEqual(entries)
    expect(
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM customer_ledger WHERE type = 'INVOICE_VOID'"
      )!.n
    ).toBe(0)
    expect(voided.balanceAfterMinor).toBe(100_000)
    expect(stockPosition(db, tea.id)).toEqual({ qtyBase: 240, valueMinor: 2_400_000 })
  })

  it('works after the counter payment was voided on its own, and the balance is still exact', () => {
    const invoice = post([teaLine()], { receivedMinor: 100_000, paymentMethod: 'CASH' })
    voidPayment(db, { id: invoice.payment!.id, reason: 'Cheque bounced' }, NOW)
    expect(balance(ali.id)).toBe(100_000 + 535_000)

    const voided = voidIt(invoice.id)

    expect(voided.balanceAfterMinor).toBe(100_000)
    expect(voided.payment).toMatchObject({ status: 'VOID' })
    expect(ledger(ali.id).map(([, type, amount]) => [type, amount])).toEqual([
      ['OPENING', 100_000],
      ['INVOICE', 535_000],
      ['PAYMENT', -100_000],
      ['PAYMENT_VOID', 100_000],
      ['INVOICE_VOID', -535_000]
    ])
  })

  it('refuses "money returned" for an account customer: the payment is voided separately', () => {
    const invoice = post([teaLine()], { receivedMinor: 100_000, paymentMethod: 'CASH' })
    const before = state()
    const message =
      "Voiding this invoice keeps payment RCP-000001 on the customer's account as credit. Void the payment separately if the money was also returned."
    expect(failure(() => voidIt(invoice.id, { moneyReturned: true }))).toEqual({
      code: 'VALIDATION',
      message,
      fieldErrors: { moneyReturned: [message] }
    })
    expect(state()).toEqual(before)

    const unpaid = post([line(sugar.id, [qty(kg(), 1, 20_000)])])
    expect(failure(() => voidIt(unpaid.id, { moneyReturned: true })).message).toBe(
      'No money was received with this invoice, so there is nothing to return.'
    )
    expect(getInvoice(db, unpaid.id).status).toBe('POSTED')
  })

  it('voids the invoice of an inactive customer, who stays inactive', () => {
    const invoice = post([teaLine()])
    setCustomerActive(db, { id: ali.id, active: false })
    expect(voidIt(invoice.id).status).toBe('VOID')
    expect(
      db.get<{ is_active: number }>('SELECT is_active FROM customers WHERE id = ?', [ali.id])!
        .is_active
    ).toBe(0)
  })

  it('refuses when the payment saved with the invoice is missing', () => {
    const invoice = post([teaLine()], { receivedMinor: 100_000, paymentMethod: 'CASH' })
    withoutTrigger('trg_payments_guard_update', 'UPDATE payments SET invoice_id = NULL')
    const before = state()
    expect(failure(() => voidIt(invoice.id))).toEqual({
      code: 'FORBIDDEN_STATE',
      message: `Invoice ${invoice.invoiceNo} cannot be voided: its saved account records do not match the invoice (the payment received with it is missing or different). Nothing was changed.`
    })
    expect(state()).toEqual(before)
  })
})

// --- Walk-in ---------------------------------------------------------------------------------------------------------

describe('voidInvoice: the walk-in customer', () => {
  it('posts fully paid with a zero balance', () => {
    const invoice = postWalkIn()
    expect([invoice.receivedMinor, invoice.totalMinor, balance(walkInId)]).toEqual([
      535_000, 535_000, 0
    ])
    expect(invoice.payment).toMatchObject({ status: 'POSTED', amountMinor: 535_000 })
  })

  it('refuses a void without "money returned", and changes nothing', () => {
    const invoice = postWalkIn()
    const before = state()
    expect(failure(() => voidIt(invoice.id))).toEqual({
      code: 'VALIDATION',
      message: `${WALK_IN_VOID_MESSAGE} Confirm that the money was returned.`,
      fieldErrors: { moneyReturned: [WALK_IN_VOID_MESSAGE] }
    })
    expect(state()).toEqual(before)
  })

  it('with "money returned", voids the invoice and its payment together; the walk-in balance stays exactly zero', () => {
    const stockBefore = stockPosition(db, tea.id)
    const invoice = postWalkIn()

    const voided = voidIt(invoice.id, { reason: 'Returned at the counter', moneyReturned: true })

    expect(voided).toMatchObject({ status: 'VOID', balanceAfterMinor: 0 })
    expect(voided.payment).toMatchObject({ id: invoice.payment!.id, status: 'VOID' })
    expect(getPayment(db, invoice.payment!.id)).toMatchObject({
      status: 'VOID',
      voidReason: 'Returned at the counter',
      voidDate: TODAY,
      voidedAt: NOW.toISOString()
    })
    expect(ledger(walkInId)).toEqual([
      [SALE_DATE, 'INVOICE', 535_000],
      [SALE_DATE, 'PAYMENT', -535_000],
      [TODAY, 'INVOICE_VOID', -535_000],
      [TODAY, 'PAYMENT_VOID', 535_000]
    ])
    expect(balance(walkInId)).toBe(0)
    expect(stockPosition(db, tea.id)).toEqual(stockBefore)
  })

  it('a standalone void of a walk-in counter payment is refused while its invoice is posted', () => {
    const invoice = postWalkIn()
    const before = state()
    expect(
      failure(() => voidPayment(db, { id: invoice.payment!.id, reason: 'Refund' }, NOW))
    ).toEqual({
      code: 'FORBIDDEN_STATE',
      message: `Payment ${invoice.payment!.paymentNo} was received with walk-in invoice ${invoice.invoiceNo}. Void the invoice instead: that returns the payment too and keeps the walk-in account at zero.`
    })
    expect(state()).toEqual(before)
    expect(getPayment(db, invoice.payment!.id)).toMatchObject({
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      invoiceStatus: 'POSTED'
    })
  })

  it('a payment an older version voided on its own needs no second void: the balance returns to zero', () => {
    const invoice = postWalkIn()
    const payment = invoice.payment!
    db.transaction(() => {
      db.run(
        "UPDATE payments SET status = 'VOID', void_reason = 'Older version', voided_at = ?, void_date = ? WHERE id = ?",
        [NOW.toISOString(), TODAY, payment.id]
      )
      db.run(
        `INSERT INTO customer_ledger (customer_id, entry_date, type, amount_minor, payment_id)
         VALUES (?, ?, 'PAYMENT_VOID', ?, ?)`,
        [walkInId, TODAY, payment.amountMinor, payment.id]
      )
    })
    expect(balance(walkInId)).toBe(535_000)
    expect(failure(() => voidIt(invoice.id, { moneyReturned: true })).message).toBe(
      `Payment ${payment.paymentNo} is already void, so there is nothing more to return.`
    )

    expect(voidIt(invoice.id).balanceAfterMinor).toBe(0)
    expect(
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM customer_ledger WHERE type = 'PAYMENT_VOID'"
      )!.n
    ).toBe(1)
  })

  it('a zero-total walk-in invoice has no payment and voids without "money returned"', () => {
    const invoice = post(
      [line(tea.id, [{ unitId: piece(), quantity: 2, unitPriceMinor: 0, priceOverride: true }])],
      { customerId: walkInId }
    )
    expect(invoice.payment).toBeNull()
    expect(voidIt(invoice.id)).toMatchObject({ status: 'VOID', balanceAfterMinor: 0 })
    expect(ledger(walkInId)).toEqual([])
  })

  it('refuses as inconsistent when the payment that should exist is missing', () => {
    const invoice = postWalkIn()
    withoutTrigger(
      'trg_payments_guard_update',
      'UPDATE payments SET invoice_id = NULL WHERE id = ?',
      [invoice.payment!.id]
    )
    const before = state()
    expect(failure(() => voidIt(invoice.id, { moneyReturned: true })).code).toBe('FORBIDDEN_STATE')
    expect(state()).toEqual(before)
  })
})

// --- Atomicity -------------------------------------------------------------------------------------------------------

describe('voidInvoice: atomicity', () => {
  /** SELECT of the stock invariants check, which runs after the last reversal is written. */
  const INVARIANTS_READ = /sum\(qty_base\) AS qty_base/

  it.each<[string, (target: Db) => Db]>([
    [
      'after the invoice status update',
      (target) => failingWrites(target, /INSERT INTO stock_movements/)
    ],
    [
      'after the first SALE_VOID movement',
      (target) => failingWrites(target, /INSERT INTO stock_movements/, 2)
    ],
    ['after the INVOICE_VOID entry', (target) => failingReads(target, INVARIANTS_READ)],
    ['after the balance check', (target) => failingReads(target, /FROM invoice_change_log/)]
  ])(
    'an account invoice: a failure %s leaves the invoice, stock, balance and payment unchanged',
    (_point, wrap) => {
      const invoice = post([teaLine(), line(sugar.id, [qty(kg(), 3, 20_000)])], {
        receivedMinor: 50_000,
        paymentMethod: 'CASH'
      })
      const before = state()

      expect(() => voidIt(invoice.id, {}, wrap(db))).toThrow(/simulated (write|read) failure/)
      expect(state()).toEqual(before)
      expect(voidIt(invoice.id).status).toBe('VOID')
    }
  )

  it.each<[string, (target: Db) => Db]>([
    [
      'after the invoice status update',
      (target) => failingWrites(target, /INSERT INTO stock_movements/)
    ],
    [
      'after the SALE_VOID movement',
      (target) => failingWrites(target, /INSERT INTO customer_ledger/)
    ],
    ['after the INVOICE_VOID entry', (target) => failingWrites(target, /UPDATE payments/)],
    [
      'after the payment status update',
      (target) => failingWrites(target, /INSERT INTO customer_ledger/, 2)
    ],
    ['after the PAYMENT_VOID entry', (target) => failingReads(target, INVARIANTS_READ)]
  ])(
    'a walk-in invoice: a failure %s rolls back both the invoice and the payment void',
    (_point, wrap) => {
      const invoice = postWalkIn()
      const before = state()

      expect(() => voidIt(invoice.id, { moneyReturned: true }, wrap(db))).toThrow(
        /simulated (write|read) failure/
      )
      expect(state()).toEqual(before)
      expect(getPayment(db, invoice.payment!.id).status).toBe('POSTED')
      expect(balance(walkInId)).toBe(0)
      expect(voidIt(invoice.id, { moneyReturned: true }).balanceAfterMinor).toBe(0)
    }
  )
})
