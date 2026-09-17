import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Customer } from '@shared/customers'
import type { InvoiceCreateInput, InvoiceLineInput, InvoiceSaveResult } from '@shared/invoices'
import type { Product, ProductUnitInput } from '@shared/products'
import type { StockAdjustmentInput, StockReceiptDetail } from '@shared/stock'
import type { Db, SqlParams } from '../db/adapter'
import {
  runIntegrityCheck,
  type IntegrityCheckId,
  type IntegrityCheckResult,
  type IntegrityReport
} from '../db/integrity'
import { migrations } from '../db/migrations'
import { createSchemaDatabase, createTempDir, type TempDir } from '../db/test-utils'
import { adjustCustomerBalance, createCustomer } from './customers.service'
import { createExpense, voidExpense } from './expenses.service'
import { voidInvoice } from './invoice-void.service'
import { createInvoice } from './invoices.service'
import { createPayment, voidPayment } from './payments.service'
import { createProduct } from './products.service'
import { adjustStock, receiveStock, voidReceipt } from './stock.service'

// The document-level integrity checks (final V1 audit), against records written by the real services. Test data lives
// only in temporary databases; every corruption below is made on purpose, in that database only.

/** "Today" is Monday 14 Sep 2026. */
const NOW = new Date(2026, 8, 14, 10, 0, 0)

const DOCUMENT_CHECKS: IntegrityCheckId[] = [
  'invoices.totals',
  'invoices.stock',
  'invoices.accounts',
  'payments.ledger',
  'customers.walk-in',
  'receipts.stock',
  'adjustments.stock',
  'dates.future'
]

let temp: TempDir
let db: Db
let requests: number

let tea: Product
let sugar: Product
let ali: Customer
let bilal: Customer

/** The documents of the healthy shop, for the corruptions to aim at. */
interface Shop {
  readonly receipt: StockReceiptDetail
  readonly voidReceiptNo: string
  readonly i1: InvoiceSaveResult
  readonly walkIn: InvoiceSaveResult
  readonly voidedAccount: InvoiceSaveResult
  readonly voidedWalkIn: InvoiceSaveResult
  readonly paymentId: number
  readonly voidedPaymentId: number
}
let shop: Shop

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  requests = 0
  shop = buildShop()
})

afterEach(() => {
  temp.remove()
})

// --- The healthy shop, written by the services ------------------------------------------------------------------------

function requestId(): string {
  requests++
  return `integrity-request-${String(requests).padStart(4, '0')}`
}

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
    packingLabel: null,
    lowStockThresholdBase: 0,
    currencyMinorDigits: 2,
    units
  })
}

const unitOf = (item: Product, name: string): number =>
  item.units.find((candidate) => candidate.name === name)!.id

function customer(name: string, opening: number | null): Customer {
  return createCustomer(
    db,
    {
      name,
      shopName: null,
      phone: null,
      address: null,
      city: null,
      notes: null,
      opening: opening === null ? null : { side: 'DUE', amountMinor: opening, date: '2026-09-01' },
      currencyMinorDigits: 2
    },
    NOW
  )
}

function adjust(
  date: string,
  productId: number,
  fields: Partial<StockAdjustmentInput> & Pick<StockAdjustmentInput, 'reason'>
): void {
  adjustStock(
    db,
    {
      requestId: requestId(),
      adjustmentDate: date,
      productId,
      direction: null,
      unitId: null,
      quantity: null,
      unitCostMinor: null,
      receiptItemId: null,
      reasonNote: 'Checked',
      currencyMinorDigits: 2,
      ...fields
    },
    NOW
  )
}

function line(
  item: Product,
  quantities: Array<[unitName: string, quantity: number, price: number]>,
  overrides: Partial<InvoiceLineInput> = {}
): InvoiceLineInput {
  return {
    productId: item.id,
    quantities: quantities.map(([name, quantity, unitPriceMinor]) => ({
      unitId: unitOf(item, name),
      quantity,
      unitPriceMinor,
      priceOverride: false
    })),
    freeQuantities: [],
    discount: null,
    schemeMinor: 0,
    ctnCount: null,
    ...overrides
  }
}

function post(
  date: string,
  customerId: number,
  lines: InvoiceLineInput[],
  overrides: Partial<InvoiceCreateInput> = {}
): InvoiceSaveResult {
  return createInvoice(
    db,
    {
      requestId: requestId(),
      invoiceDate: date,
      customerId,
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

function pay(customerId: number, date: string, amountMinor: number): number {
  return createPayment(
    db,
    {
      requestId: requestId(),
      customerId,
      paymentDate: date,
      amountMinor,
      method: 'CASH',
      reference: null,
      note: null,
      currencyMinorDigits: 2
    },
    NOW
  ).id
}

/** Every kind of document V1 writes: receipts (one voided), every adjustment reason, invoices (discount, scheme, free
 * goods, extra discount, freight, money received; account and walk-in; voided), payments (one voided), an opening
 * balance, a balance adjustment and expenses. */
function buildShop(): Shop {
  tea = product('P-001', 'Tea 950g', [
    unit({ name: 'Piece', retailPriceMinor: 11_000 }),
    unit({ name: 'Box', baseQty: 24, isBase: false, retailPriceMinor: 250_000 })
  ])
  sugar = product('P-002', 'Sugar 1kg', [unit({ name: 'Kg', retailPriceMinor: 16_000 })])
  const oil = product('P-003', 'Oil 1L', [unit({ name: 'Litre', retailPriceMinor: 50_000 })])
  const rice = product('P-004', 'Rice', [unit({ name: 'Bag', retailPriceMinor: 150_000 })])
  ali = customer('Ali Raza', 10_000)
  bilal = customer('Bilal Khan', null)

  // The same product on two lines, in two units.
  const receipt = receiveStock(
    db,
    {
      requestId: requestId(),
      receiptDate: '2026-09-01',
      supplierName: 'Metro',
      reference: null,
      note: null,
      currencyMinorDigits: 2,
      lines: [
        { productId: tea.id, unitId: unitOf(tea, 'Box'), quantity: 2, unitCostMinor: 216_000 },
        { productId: tea.id, unitId: unitOf(tea, 'Piece'), quantity: 20, unitCostMinor: 9_000 },
        { productId: sugar.id, unitId: unitOf(sugar, 'Kg'), quantity: 50, unitCostMinor: 14_000 }
      ]
    },
    NOW
  )
  const oilReceipt = receiveStock(
    db,
    {
      requestId: requestId(),
      receiptDate: '2026-09-01',
      supplierName: null,
      reference: null,
      note: null,
      currencyMinorDigits: 2,
      lines: [
        { productId: oil.id, unitId: unitOf(oil, 'Litre'), quantity: 10, unitCostMinor: 40_000 }
      ]
    },
    NOW
  )
  adjust('2026-09-01', rice.id, {
    reason: 'OPENING_STOCK',
    unitId: unitOf(rice, 'Bag'),
    quantity: 5,
    unitCostMinor: 120_000
  })

  const i1 = post(
    '2026-09-02',
    ali.id,
    [
      line(
        tea,
        [
          ['Box', 1, 250_000],
          ['Piece', 2, 11_000]
        ],
        {
          discount: { type: 'PERCENT', bps: 500 },
          schemeMinor: 2_000,
          freeQuantities: [{ unitId: unitOf(tea, 'Piece'), quantity: 2 }]
        }
      ),
      line(sugar, [['Kg', 3, 16_000]], { discount: { type: 'AMOUNT', amountMinor: 1_000 } })
    ],
    { extraDiscountMinor: 5_000, freightMinor: 3_000, receivedMinor: 50_000, paymentMethod: 'CASH' }
  )
  const walkIn = post('2026-09-03', 1, [line(sugar, [['Kg', 2, 16_000]])], {
    receivedMinor: 32_000,
    paymentMethod: 'CASH'
  })
  const voidedAccount = post('2026-09-04', bilal.id, [line(tea, [['Piece', 5, 11_000]])])
  const voidedWalkIn = post('2026-09-05', 1, [line(sugar, [['Kg', 1, 16_000]])], {
    receivedMinor: 16_000,
    paymentMethod: 'CASH'
  })
  const paymentId = pay(ali.id, '2026-09-06', 20_000)
  const voidedPaymentId = pay(bilal.id, '2026-09-06', 10_000)

  const [boxLine, pieceLine, sugarLine] = receipt.lines
  adjust('2026-09-07', tea.id, { reason: 'DAMAGE', unitId: unitOf(tea, 'Piece'), quantity: 1 })
  adjust('2026-09-07', sugar.id, { reason: 'EXPIRY', unitId: unitOf(sugar, 'Kg'), quantity: 1 })
  adjust('2026-09-08', sugar.id, { reason: 'SHORTAGE', unitId: unitOf(sugar, 'Kg'), quantity: 1 })
  adjust('2026-09-08', tea.id, {
    reason: 'COUNT_SURPLUS',
    unitId: unitOf(tea, 'Piece'),
    quantity: 1
  })
  adjust('2026-09-09', tea.id, {
    reason: 'RECEIPT_QTY_CORRECTION',
    direction: 'IN',
    receiptItemId: pieceLine.id,
    unitId: unitOf(tea, 'Piece'),
    quantity: 2
  })
  adjust('2026-09-09', sugar.id, {
    reason: 'RECEIPT_QTY_CORRECTION',
    direction: 'OUT',
    receiptItemId: sugarLine.id,
    unitId: unitOf(sugar, 'Kg'),
    quantity: 1
  })
  adjust('2026-09-10', tea.id, {
    reason: 'RECEIPT_COST_CORRECTION',
    receiptItemId: boxLine.id,
    unitCostMinor: 220_000
  })
  adjust('2026-09-10', sugar.id, {
    reason: 'OTHER_CORRECTION',
    direction: 'IN',
    unitId: unitOf(sugar, 'Kg'),
    quantity: 1,
    unitCostMinor: 15_000
  })
  adjust('2026-09-11', tea.id, {
    reason: 'OTHER_CORRECTION',
    direction: 'OUT',
    unitId: unitOf(tea, 'Piece'),
    quantity: 1
  })
  adjustCustomerBalance(
    db,
    {
      customerId: ali.id,
      entryDate: '2026-09-11',
      direction: 'INCREASE',
      amountMinor: 1_000,
      reason: 'Delivery charge',
      currencyMinorDigits: 2
    },
    NOW
  )
  const expense = (amountMinor: number): number =>
    createExpense(
      db,
      {
        requestId: requestId(),
        expenseDate: '2026-09-12',
        categoryId: 1,
        amountMinor,
        description: null,
        currencyMinorDigits: 2
      },
      NOW
    ).id
  expense(1_500)
  voidExpense(db, expense(999))

  // Today: voids.
  voidInvoice(db, { id: voidedAccount.id, reason: 'Wrong customer', moneyReturned: false }, NOW)
  voidInvoice(db, { id: voidedWalkIn.id, reason: 'Returned', moneyReturned: true }, NOW)
  voidPayment(db, { id: voidedPaymentId, reason: 'Cheque bounced' }, NOW)
  voidReceipt(db, { id: oilReceipt.id, reason: 'Wrong supplier' }, NOW)

  return {
    receipt,
    voidReceiptNo: oilReceipt.receiptNo,
    i1,
    walkIn,
    voidedAccount,
    voidedWalkIn,
    paymentId,
    voidedPaymentId
  }
}

// --- Helpers ------------------------------------------------------------------------------------------------------------

function report(now: Date = NOW): IntegrityReport {
  return runIntegrityCheck(db, { migrations, now: () => now })
}

function check(result: IntegrityReport, id: IntegrityCheckId): IntegrityCheckResult {
  const found = result.checks.find((item) => item.id === id)
  if (!found) throw new Error(`No ${id} check in the report.`)
  return found
}

/** Writes a corruption the triggers and CHECK constraints would refuse: only for these fixtures. */
function corrupt(sql: string, params?: SqlParams): void {
  for (const { name } of db.all<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'trg_%'"
  )) {
    db.exec(`DROP TRIGGER ${name}`)
  }
  db.exec('PRAGMA ignore_check_constraints = ON')
  try {
    db.run(sql, params)
  } finally {
    db.exec('PRAGMA ignore_check_constraints = OFF')
  }
}

/** Runs the check and returns one check's result, proving the run changed nothing. */
function checkOnly(id: IntegrityCheckId, now: Date = NOW): IntegrityCheckResult {
  const before = db.get<{ n: number }>('SELECT total_changes() AS n')!.n
  const result = check(report(now), id)
  expect(db.get<{ n: number }>('SELECT total_changes() AS n')!.n).toBe(before)
  return result
}

const firstItem = (invoiceId: number): { id: number; qty_base: number; cost_minor: number } =>
  db.get(
    'SELECT id, qty_base, cost_minor FROM invoice_items WHERE invoice_id = ? AND line_no = 1',
    [invoiceId]
  )!

// --- Tests ------------------------------------------------------------------------------------------------------------

describe('document integrity: a healthy shop', () => {
  it('reports every check OK for records written by the services, voids and corrections included', () => {
    const result = report()
    expect(result.checks.map((item) => item.id)).toEqual(expect.arrayContaining(DOCUMENT_CHECKS))
    expect(
      result.checks.filter((item) => item.status !== 'OK').map((item) => [item.id, item.issues])
    ).toEqual([])
    expect(result.status).toBe('OK')
    expect(check(result, 'invoices.totals').summary).toBe(
      '4 invoice(s) checked: their lines and totals add up.'
    )
  })

  it('never changes the database it checks', () => {
    const before = db.get<{ n: number }>('SELECT total_changes() AS n')!.n
    report()
    expect(db.get<{ n: number }>('SELECT total_changes() AS n')!.n).toBe(before)
  })
})

describe('document integrity: invoice lines and totals', () => {
  it('detects a line gross that is not the sum of its quantities', () => {
    const item = firstItem(shop.i1.id)
    corrupt(
      'UPDATE invoice_items SET gross_minor = gross_minor + 100, net_minor = net_minor + 100 WHERE id = ?',
      [item.id]
    )
    const result = checkOnly('invoices.totals')
    expect(result.status).toBe('ERROR')
    expect(result.issues).toContain(
      `Invoice ${shop.i1.invoiceNo} line 1: the saved gross 272100 is not the sum of its quantities (272000).`
    )
  })

  it('detects a total that does not match the lines', () => {
    corrupt(
      'UPDATE invoices SET total_minor = total_minor + 500, net_outstanding_minor = net_outstanding_minor + 500 WHERE id = ?',
      [shop.i1.id]
    )
    expect(checkOnly('invoices.totals')).toMatchObject({
      status: 'ERROR',
      issues: expect.arrayContaining([
        `Invoice ${shop.i1.invoiceNo}: the saved total ${shop.i1.totalMinor + 500} does not match its lines (${shop.i1.totalMinor}).`
      ])
    })
  })

  it('detects a line quantity that is not the paid quantity plus the free quantity', () => {
    const item = firstItem(shop.i1.id)
    corrupt('UPDATE invoice_items SET qty_base = qty_base + 1 WHERE id = ?', [item.id])
    expect(checkOnly('invoices.totals').issues).toContain(
      `Invoice ${shop.i1.invoiceNo} line 1: the saved quantity 29 base units is not the paid 26 plus the free 2.`
    )
  })

  it('detects a line discount that the saved percentage does not give', () => {
    const item = firstItem(shop.i1.id)
    corrupt(
      'UPDATE invoice_items SET discount_minor = discount_minor - 100, net_minor = net_minor + 100 WHERE id = ?',
      [item.id]
    )
    expect(checkOnly('invoices.totals').issues).toEqual(
      expect.arrayContaining([
        `Invoice ${shop.i1.invoiceNo} line 1: the saved discount 13500 does not match the recalculated 13600.`
      ])
    )
  })

  it('detects COGS that is not the sum of the frozen line costs', () => {
    corrupt('UPDATE invoices SET cogs_minor = cogs_minor + 1 WHERE id = ?', [shop.walkIn.id])
    expect(checkOnly('invoices.totals').issues).toEqual([
      `Invoice ${shop.walkIn.invoiceNo}: the saved COGS ${shop.walkIn.cogsMinor + 1} does not match its lines (${shop.walkIn.cogsMinor}).`
    ])
  })
})

describe('document integrity: invoice stock movements', () => {
  it('detects a missing SALE movement', () => {
    const item = firstItem(shop.walkIn.id)
    corrupt("DELETE FROM stock_movements WHERE invoice_item_id = ? AND type = 'SALE'", [item.id])
    expect(checkOnly('invoices.stock')).toMatchObject({
      status: 'ERROR',
      issues: [`Invoice ${shop.walkIn.invoiceNo} line 1 has no sale stock movement.`]
    })
  })

  it('detects a SALE movement whose value is not the frozen cost, or whose quantity is not the line quantity', () => {
    const item = firstItem(shop.i1.id)
    corrupt(
      "UPDATE stock_movements SET value_minor = value_minor - 7, qty_base = qty_base - 1 WHERE invoice_item_id = ? AND type = 'SALE'",
      [item.id]
    )
    expect(checkOnly('invoices.stock').issues).toEqual([
      `Invoice ${shop.i1.invoiceNo} line 1: its sale movement takes ${item.qty_base + 1} base units, but the line has ${item.qty_base}.`,
      `Invoice ${shop.i1.invoiceNo} line 1: its sale movement is valued at ${-item.cost_minor - 7}, but the line's frozen cost is ${item.cost_minor}.`
    ])
  })

  it('detects a SALE movement linked to another product', () => {
    const item = firstItem(shop.walkIn.id)
    corrupt(
      "UPDATE stock_movements SET product_id = ? WHERE invoice_item_id = ? AND type = 'SALE'",
      [tea.id, item.id]
    )
    expect(checkOnly('invoices.stock').issues).toContain(
      `Invoice ${shop.walkIn.invoiceNo} line 1: its sale movement is for another product or date.`
    )
  })

  it('detects a void invoice without its SALE_VOID reversal', () => {
    const item = firstItem(shop.voidedAccount.id)
    corrupt("DELETE FROM stock_movements WHERE invoice_item_id = ? AND type = 'SALE_VOID'", [
      item.id
    ])
    expect(checkOnly('invoices.stock').issues).toEqual([
      `Void invoice ${shop.voidedAccount.invoiceNo} line 1 has no reversal stock movement.`
    ])
  })

  it('detects a reversal that does not return the frozen cost', () => {
    const item = firstItem(shop.voidedWalkIn.id)
    corrupt(
      "UPDATE stock_movements SET value_minor = value_minor + 1 WHERE invoice_item_id = ? AND type = 'SALE_VOID'",
      [item.id]
    )
    expect(checkOnly('invoices.stock').issues).toEqual([
      `Void invoice ${shop.voidedWalkIn.invoiceNo} line 1: its reversal is valued at ${item.cost_minor + 1}, but the line's frozen cost is ${item.cost_minor}.`
    ])
  })

  it('detects a reversal on a posted invoice', () => {
    const item = firstItem(shop.walkIn.id)
    corrupt(
      `INSERT INTO stock_movements (product_id, movement_date, type, qty_base, value_minor, invoice_item_id)
       VALUES (?, '2026-09-14', 'SALE_VOID', ?, ?, ?)`,
      [sugar.id, item.qty_base, item.cost_minor, item.id]
    )
    expect(checkOnly('invoices.stock').issues).toEqual([
      `Posted invoice ${shop.walkIn.invoiceNo} line 1 has a void reversal stock movement.`
    ])
  })
})

describe('document integrity: invoice customer accounts', () => {
  it('detects a missing INVOICE entry', () => {
    corrupt("DELETE FROM customer_ledger WHERE invoice_id = ? AND type = 'INVOICE'", [shop.i1.id])
    expect(checkOnly('invoices.accounts')).toMatchObject({
      status: 'ERROR',
      issues: [`Invoice ${shop.i1.invoiceNo} has no account entry for its total.`]
    })
  })

  it('detects an INVOICE_VOID entry that does not reverse the total', () => {
    corrupt(
      "UPDATE customer_ledger SET amount_minor = amount_minor + 100 WHERE invoice_id = ? AND type = 'INVOICE_VOID'",
      [shop.voidedAccount.id]
    )
    expect(checkOnly('invoices.accounts').issues).toEqual([
      `Void invoice ${shop.voidedAccount.invoiceNo}: its account void entry is ${-shop.voidedAccount.totalMinor + 100}, but it should be ${-shop.voidedAccount.totalMinor}.`
    ])
  })

  it('detects a void invoice without its INVOICE_VOID entry', () => {
    corrupt("DELETE FROM customer_ledger WHERE invoice_id = ? AND type = 'INVOICE_VOID'", [
      shop.voidedAccount.id
    ])
    expect(checkOnly('invoices.accounts').issues).toEqual([
      `Void invoice ${shop.voidedAccount.invoiceNo} has no account entry reversing its total.`
    ])
  })

  it('detects money received without its payment, and accepts a counter payment voided later', () => {
    // The walk-in invoice voided with its money returned keeps its (void) payment: that is expected.
    expect(checkOnly('invoices.accounts').status).toBe('OK')
    corrupt('UPDATE payments SET invoice_id = NULL WHERE invoice_id = ?', [shop.i1.id])
    expect(checkOnly('invoices.accounts').issues).toEqual([
      `Invoice ${shop.i1.invoiceNo}: the 50000 received has no payment.`
    ])
  })
})

describe('document integrity: payment account entries', () => {
  it('detects a PAYMENT entry of another amount', () => {
    corrupt(
      "UPDATE customer_ledger SET amount_minor = -19000 WHERE payment_id = ? AND type = 'PAYMENT'",
      [shop.paymentId]
    )
    const payment = db.get<{ payment_no: string }>('SELECT payment_no FROM payments WHERE id = ?', [
      shop.paymentId
    ])!
    expect(checkOnly('payments.ledger')).toMatchObject({
      status: 'ERROR',
      issues: [
        `Payment ${payment.payment_no}: its account entry is -19000, but it should be -20000.`
      ]
    })
  })

  it('detects a void payment without its PAYMENT_VOID entry', () => {
    corrupt("DELETE FROM customer_ledger WHERE payment_id = ? AND type = 'PAYMENT_VOID'", [
      shop.voidedPaymentId
    ])
    const payment = db.get<{ payment_no: string }>('SELECT payment_no FROM payments WHERE id = ?', [
      shop.voidedPaymentId
    ])!
    expect(checkOnly('payments.ledger').issues).toEqual([
      `Void payment ${payment.payment_no} has no account entry reversing it.`
    ])
  })
})

describe('document integrity: the walk-in customer', () => {
  it('detects a walk-in balance that is not zero', () => {
    corrupt(
      "INSERT INTO customer_ledger (customer_id, entry_date, type, amount_minor, note) VALUES (1, '2026-09-12', 'ADJUSTMENT', 2500, 'Mistake')"
    )
    expect(checkOnly('customers.walk-in')).toMatchObject({
      status: 'ERROR',
      issues: ['The walk-in customer (C-00001) has a balance of 2500; it should be 0.']
    })
  })
})

describe('document integrity: stock receipts', () => {
  it('checks repeated product lines independently: a STOCK_IN of another quantity is found on its own line', () => {
    const [boxLine, pieceLine] = shop.receipt.lines
    corrupt(
      "UPDATE stock_movements SET qty_base = 47 WHERE receipt_item_id = ? AND type = 'STOCK_IN'",
      [boxLine.id]
    )
    const result = checkOnly('receipts.stock')
    expect(result.issues).toEqual([
      `Receipt ${shop.receipt.receiptNo} line 1: its stock-in movement adds 47 base units, but the line has 48.`
    ])
    expect(result.issues.join(' ')).not.toContain('line 2')
    expect(pieceLine.lineNo).toBe(2)
  })

  it('detects a STOCK_IN of another value, and a void receipt without its reversal', () => {
    const [, pieceLine] = shop.receipt.lines
    corrupt(
      "UPDATE stock_movements SET value_minor = value_minor + 10 WHERE receipt_item_id = ? AND type = 'STOCK_IN'",
      [pieceLine.id]
    )
    corrupt(
      "DELETE FROM stock_movements WHERE type = 'STOCK_IN_VOID' AND receipt_item_id IN (SELECT ri.id FROM stock_receipt_items AS ri JOIN stock_receipts AS r ON r.id = ri.receipt_id WHERE r.receipt_no = ?)",
      [shop.voidReceiptNo]
    )
    expect(checkOnly('receipts.stock').issues).toEqual([
      `Receipt ${shop.receipt.receiptNo} line 2: its stock-in movement is valued at 180010, but the line cost is 180000.`,
      `Void receipt ${shop.voidReceiptNo} line 1 has no reversal stock movement.`
    ])
  })
})

describe('document integrity: stock adjustments', () => {
  it('detects an adjustment movement of another kind, quantity or value', () => {
    const damage = db.get<{ id: number; adjustment_no: string }>(
      "SELECT id, adjustment_no FROM stock_adjustments WHERE reason_code = 'DAMAGE'"
    )!
    corrupt('UPDATE stock_movements SET value_minor = value_minor - 1 WHERE adjustment_id = ?', [
      damage.id
    ])
    const surplus = db.get<{ id: number; adjustment_no: string }>(
      "SELECT id, adjustment_no FROM stock_adjustments WHERE reason_code = 'COUNT_SURPLUS'"
    )!
    corrupt("UPDATE stock_movements SET type = 'OPENING' WHERE adjustment_id = ?", [surplus.id])
    const cost = db.get<{ id: number; adjustment_no: string }>(
      "SELECT id, adjustment_no FROM stock_adjustments WHERE reason_code = 'RECEIPT_COST_CORRECTION'"
    )!
    corrupt('UPDATE stock_movements SET qty_base = 1 WHERE adjustment_id = ?', [cost.id])
    const issues = checkOnly('adjustments.stock').issues
    expect(issues).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Adjustment ${damage.adjustment_no}: its stock movement changes the value by -\\d+, but the adjustment says -\\d+\\.$`
        )
      ),
      `Adjustment ${surplus.adjustment_no}: its stock movement is OPENING, but a COUNT_SURPLUS adjustment makes ADJUST_IN.`,
      `Adjustment ${cost.adjustment_no}: its stock movement changes stock by 1 base units, but the adjustment says 0.`
    ])
  })

  it('detects an adjustment without its movement', () => {
    const shortage = db.get<{ id: number; adjustment_no: string }>(
      "SELECT id, adjustment_no FROM stock_adjustments WHERE reason_code = 'SHORTAGE'"
    )!
    corrupt('DELETE FROM stock_movements WHERE adjustment_id = ?', [shortage.id])
    expect(checkOnly('adjustments.stock')).toMatchObject({
      status: 'ERROR',
      issues: [`Adjustment ${shortage.adjustment_no} has no stock movement.`]
    })
  })
})

describe('document integrity: business dates after today', () => {
  it('detects a future-dated expense, and nothing else, with today by the main process clock', () => {
    corrupt("UPDATE expenses SET expense_date = '2026-10-01' WHERE status = 'ACTIVE'")
    const result = checkOnly('dates.future')
    expect(result).toMatchObject({
      status: 'ERROR',
      issues: [
        'Expenses: 1 dated after today (14-Sep-2026); the first is expense 1, dated 01-Oct-2026.'
      ]
    })
  })

  it('detects future-dated invoices, payments, receipts, adjustments, stock movements, ledger entries and voids', () => {
    // Checked as if today were 4 Sep 2026: everything dated later is "after today".
    const issues = checkOnly('dates.future', new Date(2026, 8, 4, 12, 0, 0)).issues
    for (const label of [
      'Invoices:',
      'Invoice voids:',
      'Payments:',
      'Payment voids:',
      'Expenses:',
      'Stock receipt voids:',
      'Stock adjustments:',
      'Stock movements:',
      'Customer ledger entries:'
    ]) {
      expect(
        issues.some((issue) => issue.startsWith(label)),
        label
      ).toBe(true)
    }
    expect(issues.some((issue) => issue.startsWith('Stock receipts:'))).toBe(false)
    expect(issues).toContain(
      `Invoices: 1 dated after today (04-Sep-2026); the first is ${shop.voidedWalkIn.invoiceNo}, dated 05-Sep-2026.`
    )
  })
})

describe('document integrity: every other finding', () => {
  const counterPayment = (invoiceId: number): { id: number; payment_no: string } =>
    db.get('SELECT id, payment_no FROM payments WHERE invoice_id = ?', [invoiceId])!
  const adjustmentOf = (reason: string): { id: number; adjustment_no: string } =>
    db.get('SELECT id, adjustment_no FROM stock_adjustments WHERE reason_code = ?', [reason])!

  /** A zero-total VOID invoice header with no lines (every CHECK of the table holds). */
  function emptyVoidInvoice(): number {
    corrupt(
      `INSERT INTO invoices (invoice_no, seq_no, request_id, invoice_date, customer_id, cust_name, price_tier,
         gross_minor, net_minor, total_minor, previous_balance_minor, net_outstanding_minor, cogs_minor, status,
         void_reason, voided_at, void_date)
       VALUES ('INV-EMPTY', 99, 'empty-invoice-request', '2026-09-12', 1, 'Cash / Walk-in', 'RETAIL', 0, 0, 0, 0, 0, 0,
         'VOID', 'Test', '2026-09-14T05:00:00.000Z', '2026-09-14')`
    )
    return db.get<{ id: number }>("SELECT id FROM invoices WHERE invoice_no = 'INV-EMPTY'")!.id
  }

  it('invoice lines and totals: no lines, no quantities, a quantity row that does not add up, totals that cannot be recalculated', () => {
    emptyVoidInvoice()
    const walkInItem = firstItem(shop.walkIn.id)
    corrupt('DELETE FROM invoice_item_quantities WHERE invoice_item_id = ?', [walkInItem.id])
    const i1Item = firstItem(shop.i1.id)
    corrupt(
      'UPDATE invoice_item_quantities SET amount_minor = amount_minor + 1 WHERE invoice_item_id = ? AND quantity = 1',
      [i1Item.id]
    )
    corrupt('UPDATE invoices SET extra_discount_minor = 900000000 WHERE id = ?', [
      shop.voidedAccount.id
    ])
    const issues = checkOnly('invoices.totals').issues
    expect(issues).toContain('Invoice INV-EMPTY has no lines.')
    expect(issues).toContain(`Invoice ${shop.walkIn.invoiceNo} line 1 has no quantities.`)
    expect(issues).toContain(
      `Invoice ${shop.i1.invoiceNo} line 1: a quantity row's amount or base quantity does not match its quantity.`
    )
    expect(issues).toContain(
      `Invoice ${shop.voidedAccount.invoiceNo}: its totals cannot be recalculated from its saved lines.`
    )
  })

  it('invoice lines and totals: an amount the invoice calculation refuses outright', () => {
    corrupt('UPDATE invoice_items SET scheme_minor = -5 WHERE id = ?', [
      firstItem(shop.walkIn.id).id
    ])
    expect(checkOnly('invoices.totals').issues).toContain(
      `Invoice ${shop.walkIn.invoiceNo}: its totals cannot be recalculated from its saved lines.`
    )
  })

  it('invoice stock: a duplicated sale movement and a movement of an unexpected kind', () => {
    const walkInItem = firstItem(shop.walkIn.id)
    db.exec('DROP INDEX ux_stock_movements_invoice_item')
    corrupt(
      `INSERT INTO stock_movements (product_id, movement_date, type, qty_base, value_minor, invoice_item_id)
       VALUES (?, '2026-09-03', 'SALE', ?, ?, ?)`,
      [sugar.id, -walkInItem.qty_base, -walkInItem.cost_minor, walkInItem.id]
    )
    const i1Line2 = db.get<{ id: number }>(
      'SELECT id FROM invoice_items WHERE invoice_id = ? AND line_no = 2',
      [shop.i1.id]
    )!
    corrupt(
      `INSERT INTO stock_movements (product_id, movement_date, type, qty_base, value_minor, invoice_item_id)
       VALUES (?, '2026-09-02', 'SALE_RETURN', 1, 1, ?)`,
      [sugar.id, i1Line2.id]
    )
    expect(checkOnly('invoices.stock').issues).toEqual([
      `Invoice ${shop.i1.invoiceNo} line 2 has a stock movement of an unexpected kind.`,
      `Invoice ${shop.walkIn.invoiceNo} line 1 has 2 sale movements; one is expected.`
    ])
  })

  it('invoice accounts: duplicated, misdated and unexpected entries, and payments that do not belong', () => {
    const emptyId = emptyVoidInvoice()
    db.exec('DROP INDEX ux_customer_ledger_invoice')
    const entry = (type: string, amount: number, invoiceId: number, date = '2026-09-12'): void =>
      corrupt(
        `INSERT INTO customer_ledger (customer_id, entry_date, type, amount_minor, invoice_id) VALUES (
           (SELECT customer_id FROM invoices WHERE id = ?), ?, ?, ?, ?)`,
        [invoiceId, date, type, amount, invoiceId]
      )
    entry('INVOICE', shop.i1.totalMinor, shop.i1.id, '2026-09-02')
    corrupt(
      "UPDATE customer_ledger SET entry_date = '2026-09-04' WHERE invoice_id = ? AND type = 'INVOICE'",
      [shop.walkIn.id]
    )
    entry('INVOICE_VOID', -shop.walkIn.totalMinor, shop.walkIn.id)
    entry('INVOICE_VOID', -shop.voidedAccount.totalMinor, shop.voidedAccount.id, '2026-09-14')
    corrupt(
      "UPDATE customer_ledger SET entry_date = '2026-09-13' WHERE invoice_id = ? AND type = 'INVOICE_VOID'",
      [shop.voidedWalkIn.id]
    )
    entry('INVOICE', 100, emptyId)
    entry('INVOICE_VOID', -100, emptyId)
    // Ali's own payment linked to invoice 1, Bilal's to the unpaid invoice, and the walk-in counter payment changed.
    corrupt('UPDATE payments SET invoice_id = ? WHERE id = ?', [shop.i1.id, shop.paymentId])
    corrupt('UPDATE payments SET invoice_id = ? WHERE id = ?', [
      shop.voidedAccount.id,
      shop.voidedPaymentId
    ])
    corrupt('UPDATE payments SET amount_minor = 31000 WHERE invoice_id = ?', [shop.walkIn.id])
    expect(checkOnly('invoices.accounts').issues).toEqual([
      `Invoice ${shop.i1.invoiceNo} has 2 account entries for its total; one is expected.`,
      `Invoice ${shop.i1.invoiceNo} has 2 payments for the money received; one is expected.`,
      `Invoice ${shop.walkIn.invoiceNo}: its account entry is not dated on the invoice date.`,
      `Posted invoice ${shop.walkIn.invoiceNo} has an account void entry.`,
      `Invoice ${shop.walkIn.invoiceNo}: its payment does not match the amount received, the customer or the invoice date.`,
      `Void invoice ${shop.voidedAccount.invoiceNo} has 2 account void entries; one is expected.`,
      `Invoice ${shop.voidedAccount.invoiceNo} received nothing but has a payment.`,
      `Void invoice ${shop.voidedWalkIn.invoiceNo}: its account void entry is not dated on the void date.`,
      'Invoice INV-EMPTY has a total of zero but an account entry.',
      'Void invoice INV-EMPTY has a total of zero but an account void entry.'
    ])
  })

  it('payment entries: missing, duplicated, misdated, unexpected void entries, and void entries of another amount', () => {
    const extra = pay(ali.id, '2026-09-14', 5_000)
    voidPayment(db, { id: extra, reason: 'Entered twice' }, NOW)
    const i1Payment = counterPayment(shop.i1.id)
    const walkInPayment = counterPayment(shop.walkIn.id)
    const voidedWalkInPayment = counterPayment(shop.voidedWalkIn.id)
    const number = (id: number): string =>
      db.get<{ payment_no: string }>('SELECT payment_no FROM payments WHERE id = ?', [id])!
        .payment_no
    db.exec('DROP INDEX ux_customer_ledger_payment')
    corrupt("DELETE FROM customer_ledger WHERE payment_id = ? AND type = 'PAYMENT'", [
      shop.paymentId
    ])
    corrupt(
      "INSERT INTO customer_ledger (customer_id, entry_date, type, amount_minor, payment_id) VALUES (?, '2026-09-14', 'PAYMENT_VOID', 20000, ?)",
      [ali.id, shop.paymentId]
    )
    corrupt(
      "INSERT INTO customer_ledger (customer_id, entry_date, type, amount_minor, payment_id) VALUES (1, '2026-09-03', 'PAYMENT', -32000, ?)",
      [walkInPayment.id]
    )
    corrupt(
      "UPDATE customer_ledger SET entry_date = '2026-09-05' WHERE payment_id = ? AND type = 'PAYMENT'",
      [i1Payment.id]
    )
    corrupt(
      "INSERT INTO customer_ledger (customer_id, entry_date, type, amount_minor, payment_id) VALUES (1, '2026-09-14', 'PAYMENT_VOID', 16000, ?)",
      [voidedWalkInPayment.id]
    )
    corrupt(
      "UPDATE customer_ledger SET amount_minor = 4000 WHERE payment_id = ? AND type = 'PAYMENT_VOID'",
      [extra]
    )
    corrupt(
      "UPDATE customer_ledger SET entry_date = '2026-09-13' WHERE payment_id = ? AND type = 'PAYMENT_VOID'",
      [shop.voidedPaymentId]
    )
    expect(checkOnly('payments.ledger').issues).toEqual([
      `Payment ${i1Payment.payment_no}: its account entry is not dated on the payment date.`,
      `Payment ${walkInPayment.payment_no} has 2 account entries; one is expected.`,
      `Void payment ${voidedWalkInPayment.payment_no} has 2 account void entries; one is expected.`,
      `Payment ${number(shop.paymentId)} has no account entry.`,
      `Posted payment ${number(shop.paymentId)} has an account void entry.`,
      `Void payment ${number(shop.voidedPaymentId)}: its account void entry is not dated on the void date.`,
      `Void payment ${number(extra)}: its account void entry is 4000, but it should be 5000.`
    ])
  })

  it('walk-in: a missing walk-in customer', () => {
    db.run("UPDATE customers SET code = 'C-99999' WHERE code = 'C-00001'")
    expect(checkOnly('customers.walk-in').issues).toEqual([
      'The walk-in customer (C-00001) is missing.'
    ])
  })

  it('receipts: no lines, a total that is not its lines, a reversal on a posted receipt, a movement of an unexpected kind', () => {
    corrupt(
      "INSERT INTO stock_receipts (receipt_no, request_id, receipt_date, total_cost_minor) VALUES ('GRN-EMPTY', 'empty-receipt', '2026-09-02', 0)"
    )
    corrupt('UPDATE stock_receipts SET total_cost_minor = total_cost_minor + 1 WHERE id = ?', [
      shop.receipt.id
    ])
    const [, pieceLine, sugarLine] = shop.receipt.lines
    corrupt(
      `INSERT INTO stock_movements (product_id, movement_date, type, qty_base, value_minor, receipt_item_id)
       VALUES (?, '2026-09-14', 'STOCK_IN_VOID', -1, -1, ?)`,
      [sugar.id, sugarLine.id]
    )
    corrupt(
      `INSERT INTO stock_movements (product_id, movement_date, type, qty_base, value_minor, receipt_item_id)
       VALUES (?, '2026-09-02', 'ADJUST_IN', 1, 1, ?)`,
      [tea.id, pieceLine.id]
    )
    expect(checkOnly('receipts.stock').issues).toEqual([
      `Receipt ${shop.receipt.receiptNo}: its total cost ${shop.receipt.totalCostMinor + 1} is not the sum of its lines (${shop.receipt.totalCostMinor}).`,
      `Receipt ${shop.receipt.receiptNo} line 2 has a stock movement of an unexpected kind.`,
      `Posted receipt ${shop.receipt.receiptNo} line 3 has a void reversal stock movement.`,
      'Receipt GRN-EMPTY has no lines.'
    ])
  })

  it('adjustments: two movements, a movement on another date, and a cost correction of no value', () => {
    const expiry = adjustmentOf('EXPIRY')
    const otherOut = db.get<{ id: number; adjustment_no: string }>(
      "SELECT id, adjustment_no FROM stock_adjustments WHERE reason_code = 'OTHER_CORRECTION' AND direction = 'OUT'"
    )!
    const cost = adjustmentOf('RECEIPT_COST_CORRECTION')
    db.exec('DROP INDEX ux_stock_movements_adjustment')
    corrupt(
      `INSERT INTO stock_movements (product_id, movement_date, type, qty_base, value_minor, adjustment_id)
       SELECT product_id, movement_date, type, qty_base, value_minor, adjustment_id FROM stock_movements
       WHERE adjustment_id = ?`,
      [expiry.id]
    )
    corrupt("UPDATE stock_movements SET movement_date = '2026-09-12' WHERE adjustment_id = ?", [
      otherOut.id
    ])
    corrupt('UPDATE stock_movements SET value_minor = 0 WHERE adjustment_id = ?', [cost.id])
    expect(checkOnly('adjustments.stock').issues).toEqual([
      `Adjustment ${expiry.adjustment_no} has 2 stock movements; one is expected.`,
      `Adjustment ${cost.adjustment_no}: its stock movement changes the value by 0, but the adjustment says ±8000.`,
      `Adjustment ${otherOut.adjustment_no}: its stock movement is for another product or date.`
    ])
  })
})
