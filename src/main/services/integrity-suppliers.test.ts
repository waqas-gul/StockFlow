import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Product, ProductUnitInput } from '@shared/products'
import type { PaidNowInput, StockReceiptDetail } from '@shared/stock'
import type { Supplier } from '@shared/suppliers'
import type { Db, SqlParams } from '../db/adapter'
import {
  CHECK_FAILED_SUMMARY,
  runIntegrityCheck,
  type IntegrityCheckId,
  type IntegrityCheckResult,
  type IntegrityReport
} from '../db/integrity'
import { migrations } from '../db/migrations'
import { initialMigration } from '../db/migrations/0001_initial'
import { stockAdjustmentReceiptItemMigration } from '../db/migrations/0002_stock_adjustment_receipt_item'
import { createSchemaDatabase, createTempDir, type TempDir } from '../db/test-utils'
import { integrityCheckReport } from './maintenance.service'
import { createProduct } from './products.service'
import { receiveStock, voidReceipt } from './stock.service'
import { createSupplierPayment, voidSupplierPayment } from './supplier-payments.service'
import { adjustSupplierBalance, createSupplier, setSupplierActive } from './suppliers.service'
import { testContext } from '../db/test-utils'

// The supplier account integrity checks (migration 0003), against records written by the real services. Test data
// lives only in temporary databases; every corruption below is made on purpose, in that database only.

/** "Today" is Monday 14 Sep 2026. */
const NOW = new Date(2026, 8, 14, 10, 0, 0)

const SUPPLIER_CHECKS: IntegrityCheckId[] = [
  'suppliers.ledger',
  'suppliers.purchases',
  'suppliers.payments',
  'dates.future'
]

let temp: TempDir
let db: Db
let requests: number

/** The documents of the healthy supplier shop, for the corruptions to aim at. */
interface Shop {
  readonly abc: Supplier
  readonly xyz: Supplier
  /** abc: tea and sugar, Rs 5,720.00, Rs 2,000.00 paid now. */
  readonly purchase: StockReceiptDetail
  /** abc: free goods, total 0. */
  readonly freeGoods: StockReceiptDetail
  /** No supplier account: a free-text supplier name, as every receipt before 0003. */
  readonly legacy: StockReceiptDetail
  /** xyz: oil, Rs 2,000.00, Rs 500.00 paid now; voided today, and its payment voided too. */
  readonly voided: StockReceiptDetail
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

// --- The healthy supplier shop, written by the services ----------------------------------------------------------------

function requestId(): string {
  requests++
  return `supplier-integrity-${String(requests).padStart(4, '0')}`
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

function receive(
  date: string,
  supplierId: number | null,
  lines: Array<[item: Product, unitName: string, quantity: number, unitCostMinor: number]>,
  paidNow: PaidNowInput | null = null
): StockReceiptDetail {
  return receiveStock(
    db,
    {
      requestId: requestId(),
      receiptDate: date,
      supplierId,
      supplierName: supplierId === null ? 'Metro' : null,
      supplierBillNo: supplierId === null ? null : `BILL-${requests}`,
      reference: null,
      note: null,
      paidNow,
      currencyMinorDigits: 2,
      lines: lines.map(([item, unitName, quantity, unitCostMinor]) => ({
        productId: item.id,
        unitId: unitOf(item, unitName),
        quantity,
        unitCostMinor
      }))
    },
    NOW
  )
}

function pay(supplierId: number, date: string, amountMinor: number): number {
  return createSupplierPayment(
    db,
    {
      requestId: requestId(),
      supplierId,
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

/** Every kind of supplier record: opening balances (due and advance), purchases (paid now, free goods, voided), a
 * receipt without a supplier account, payments (one voided), an adjustment and an inactive supplier. */
function buildShop(): Shop {
  const tea = product('P-001', 'Tea 950g', [
    unit({ name: 'Piece' }),
    unit({ name: 'Box', baseQty: 24, isBase: false })
  ])
  const sugar = product('P-002', 'Sugar 1kg', [unit({ name: 'Kg' })])
  const oil = product('P-003', 'Oil 1L', [unit({ name: 'Litre' })])
  const supplierOf = (name: string, side: 'DUE' | 'ADVANCE', amountMinor: number): Supplier =>
    createSupplier(
      db,
      {
        name,
        contactPerson: null,
        phone: null,
        address: null,
        city: null,
        notes: null,
        opening: { side, amountMinor, date: '2026-09-01' },
        currencyMinorDigits: 2
      },
      NOW
    )
  const abc = supplierOf('ABC Distributors', 'DUE', 1_000_000)
  const xyz = supplierOf('XYZ Traders', 'ADVANCE', 50_000)

  const purchase = receive(
    '2026-09-02',
    abc.id,
    [
      [tea, 'Box', 2, 216_000],
      [sugar, 'Kg', 10, 14_000]
    ],
    { amountMinor: 200_000, method: 'BANK', reference: 'TT-1' }
  )
  const freeGoods = receive('2026-09-03', abc.id, [[sugar, 'Kg', 2, 0]])
  const legacy = receive('2026-09-03', null, [[tea, 'Piece', 10, 9_000]])
  const voided = receive('2026-09-04', xyz.id, [[oil, 'Litre', 5, 40_000]], {
    amountMinor: 50_000,
    method: 'CASH',
    reference: null
  })
  const paymentId = pay(abc.id, '2026-09-05', 100_000)
  const voidedPaymentId = pay(abc.id, '2026-09-05', 30_000)
  adjustSupplierBalance(
    db,
    {
      supplierId: xyz.id,
      entryDate: '2026-09-06',
      direction: 'INCREASE',
      amountMinor: 10_000,
      reason: 'Bill revised',
      currencyMinorDigits: 2
    },
    NOW
  )
  setSupplierActive(db, { id: xyz.id, active: false })

  // Today: voids.
  voidReceipt(db, { id: voided.id, reason: 'Wrong delivery' }, NOW)
  voidSupplierPayment(db, { id: voided.supplierPayments[0].id, reason: 'Money returned' }, NOW)
  voidSupplierPayment(db, { id: voidedPaymentId, reason: 'Entered twice' }, NOW)

  return { abc, xyz, purchase, freeGoods, legacy, voided, paymentId, voidedPaymentId }
}

// --- Helpers ------------------------------------------------------------------------------------------------------------

function report(now: Date = NOW): IntegrityReport {
  return runIntegrityCheck(db, { migrations, now: () => now })
}

/** Writes a corruption the triggers, indexes and CHECK constraints would refuse: only for these fixtures. */
function corrupt(sql: string, params?: SqlParams): void {
  for (const { name } of db.all<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'trg_%'"
  )) {
    db.exec(`DROP TRIGGER ${name}`)
  }
  for (const name of [
    'ux_supplier_ledger_receipt',
    'ux_supplier_ledger_payment',
    'ux_supplier_ledger_opening'
  ]) {
    db.exec(`DROP INDEX IF EXISTS ${name}`)
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
  const found = report(now).checks.find((item) => item.id === id)!
  expect(db.get<{ n: number }>('SELECT total_changes() AS n')!.n).toBe(before)
  return found
}

function entryId(type: string, source: { receiptId?: number; paymentId?: number }): number {
  return db.get<{ id: number }>(
    `SELECT id FROM supplier_ledger WHERE type = ? AND (stock_receipt_id IS ? AND supplier_payment_id IS ?)`,
    [type, source.receiptId ?? null, source.paymentId ?? null]
  )!.id
}

const paymentNo = (id: number): string =>
  db.get<{ payment_no: string }>('SELECT payment_no FROM supplier_payments WHERE id = ?', [id])!
    .payment_no

// --- Tests ------------------------------------------------------------------------------------------------------------

describe('supplier integrity: a healthy shop', () => {
  it('reports every check OK for supplier records written by the services, voids included', () => {
    const result = report()
    expect(result.checks.map((item) => item.id)).toEqual(expect.arrayContaining(SUPPLIER_CHECKS))
    expect(
      result.checks.filter((item) => item.status !== 'OK').map((item) => [item.id, item.issues])
    ).toEqual([])
    expect(result.status).toBe('OK')
    const summary = (id: IntegrityCheckId): string =>
      result.checks.find((item) => item.id === id)!.summary
    expect(summary('suppliers.ledger')).toBe(
      '2 supplier(s) checked: their account entries and balances are consistent.'
    )
    // The receipt without a supplier account is not a supplier purchase.
    expect(summary('suppliers.purchases')).toBe(
      '3 supplier receipt(s) checked: each purchase, and each void, is on the supplier account exactly.'
    )
    expect(summary('suppliers.payments')).toBe(
      '4 supplier payment(s) checked: each is on the supplier account as expected.'
    )
  })

  it('shows the supplier checks in plain language, OK, from Settings → Run Integrity Check', () => {
    const view = integrityCheckReport(db, { ...testContext(temp), now: () => NOW })
    expect(view.status).toBe('OK')
    expect(
      view.checks
        .filter((item) => item.id.startsWith('suppliers.'))
        .map((item) => [item.title, item.status])
    ).toEqual([
      ['Supplier accounts', 'OK'],
      ['Supplier purchases', 'OK'],
      ['Supplier payments', 'OK']
    ])
  })
})

describe('supplier integrity: purchases', () => {
  it('detects a missing purchase entry', () => {
    corrupt('DELETE FROM supplier_ledger WHERE id = ?', [
      entryId('PURCHASE', { receiptId: shop.purchase.id })
    ])
    expect(checkOnly('suppliers.purchases')).toMatchObject({
      status: 'ERROR',
      issues: [`Receipt ${shop.purchase.receiptNo} has no supplier purchase entry.`]
    })
  })

  it('detects a purchase entry of the wrong amount', () => {
    corrupt('UPDATE supplier_ledger SET amount_minor = 500000 WHERE id = ?', [
      entryId('PURCHASE', { receiptId: shop.purchase.id })
    ])
    expect(checkOnly('suppliers.purchases').issues).toEqual([
      `Receipt ${shop.purchase.receiptNo}: its supplier purchase entry is 500000, but the receipt total is 572000.`
    ])
  })

  it('detects a purchase entry on the wrong supplier or date', () => {
    const id = entryId('PURCHASE', { receiptId: shop.purchase.id })
    corrupt("UPDATE supplier_ledger SET supplier_id = ?, entry_date = '2026-09-03' WHERE id = ?", [
      shop.xyz.id,
      id
    ])
    expect(checkOnly('suppliers.purchases').issues).toEqual([
      `Receipt ${shop.purchase.receiptNo}: its supplier purchase entry is on another supplier.`,
      `Receipt ${shop.purchase.receiptNo}: its supplier purchase entry is not dated on the receipt date.`
    ])
  })

  it('detects a void receipt without its purchase reversal, or with a reversal of the wrong amount', () => {
    const id = entryId('PURCHASE_VOID', { receiptId: shop.voided.id })
    corrupt('UPDATE supplier_ledger SET amount_minor = -1 WHERE id = ?', [id])
    expect(checkOnly('suppliers.purchases').issues).toEqual([
      `Void receipt ${shop.voided.receiptNo}: its supplier purchase void entry is -1, but it should be -200000.`
    ])
    corrupt('DELETE FROM supplier_ledger WHERE id = ?', [id])
    expect(checkOnly('suppliers.purchases').issues).toEqual([
      `Void receipt ${shop.voided.receiptNo} has no supplier entry reversing its purchase.`
    ])
  })

  it('never expects entries for a receipt without a supplier account, and reports any it has', () => {
    corrupt(
      `INSERT INTO supplier_ledger (supplier_id, entry_date, type, amount_minor, stock_receipt_id)
       VALUES (?, '2026-09-03', 'PURCHASE', 90000, ?)`,
      [shop.abc.id, shop.legacy.id]
    )
    expect(checkOnly('suppliers.purchases').issues).toEqual([
      `Receipt ${shop.legacy.receiptNo} has no supplier account, but has supplier account entries.`
    ])
  })

  it('reports duplicated, unexpected and zero-total entries', () => {
    corrupt(
      `INSERT INTO supplier_ledger (supplier_id, entry_date, type, amount_minor, stock_receipt_id)
       VALUES (?, '2026-09-02', 'PURCHASE', 572000, ?)`,
      [shop.abc.id, shop.purchase.id]
    )
    corrupt(
      `INSERT INTO supplier_ledger (supplier_id, entry_date, type, amount_minor, stock_receipt_id)
       VALUES (?, '2026-09-03', 'PURCHASE', 1, ?)`,
      [shop.abc.id, shop.freeGoods.id]
    )
    corrupt(
      `INSERT INTO supplier_ledger (supplier_id, entry_date, type, amount_minor, stock_receipt_id)
       VALUES (?, '2026-09-14', 'PURCHASE_VOID', -572000, ?)`,
      [shop.abc.id, shop.purchase.id]
    )
    corrupt(
      `INSERT INTO supplier_ledger (supplier_id, entry_date, type, amount_minor, stock_receipt_id, note)
       VALUES (?, '2026-09-14', 'ADJUSTMENT', 5, ?, 'x')`,
      [shop.abc.id, shop.purchase.id]
    )
    expect(checkOnly('suppliers.purchases').issues).toEqual([
      `Receipt ${shop.purchase.receiptNo} has a supplier account entry of an unexpected kind.`,
      `Receipt ${shop.purchase.receiptNo} has 2 supplier purchase entries; one is expected.`,
      `Posted receipt ${shop.purchase.receiptNo} has a supplier purchase void entry.`,
      `Receipt ${shop.freeGoods.receiptNo} has a total of 0, so it should have no supplier account entry.`
    ])
  })
})

describe('supplier integrity: payments', () => {
  it('detects a missing payment entry', () => {
    corrupt('DELETE FROM supplier_ledger WHERE id = ?', [
      entryId('PAYMENT', { paymentId: shop.paymentId })
    ])
    expect(checkOnly('suppliers.payments')).toMatchObject({
      status: 'ERROR',
      issues: [`Supplier payment ${paymentNo(shop.paymentId)} has no supplier account entry.`]
    })
  })

  it('detects a payment entry of the wrong amount, supplier or date', () => {
    corrupt(
      "UPDATE supplier_ledger SET amount_minor = -99999, supplier_id = ?, entry_date = '2026-09-06' WHERE id = ?",
      [shop.xyz.id, entryId('PAYMENT', { paymentId: shop.paymentId })]
    )
    const label = `Supplier payment ${paymentNo(shop.paymentId)}`
    expect(checkOnly('suppliers.payments').issues).toEqual([
      `${label}: its supplier account entry is -99999, but it should be -100000.`,
      `${label}: its supplier account entry is on another supplier.`,
      `${label}: its supplier account entry is not dated on the payment date.`
    ])
  })

  it('detects a void payment without its reversing entry, or with one of the wrong amount', () => {
    const id = entryId('PAYMENT_VOID', { paymentId: shop.voidedPaymentId })
    const label = `Void supplier payment ${paymentNo(shop.voidedPaymentId)}`
    corrupt(
      "UPDATE supplier_ledger SET amount_minor = 1, supplier_id = ?, entry_date = '2026-09-13' WHERE id = ?",
      [shop.xyz.id, id]
    )
    expect(checkOnly('suppliers.payments').issues).toEqual([
      `${label}: its supplier void entry is 1, but it should be 30000.`,
      `${label}: its supplier void entry is on another supplier.`,
      `${label}: its supplier void entry is not dated on the void date.`
    ])
    corrupt('DELETE FROM supplier_ledger WHERE id = ?', [id])
    expect(checkOnly('suppliers.payments').issues).toEqual([
      `${label} has no supplier account entry reversing it.`
    ])
  })

  it('reports duplicated entries, a void entry on a posted payment and a receipt of another supplier', () => {
    corrupt(
      `INSERT INTO supplier_ledger (supplier_id, entry_date, type, amount_minor, supplier_payment_id)
       VALUES (?, '2026-09-05', 'PAYMENT', -100000, ?)`,
      [shop.abc.id, shop.paymentId]
    )
    corrupt(
      `INSERT INTO supplier_ledger (supplier_id, entry_date, type, amount_minor, supplier_payment_id)
       VALUES (?, '2026-09-14', 'PAYMENT_VOID', 100000, ?)`,
      [shop.abc.id, shop.paymentId]
    )
    corrupt(
      `INSERT INTO supplier_ledger (supplier_id, entry_date, type, amount_minor, supplier_payment_id)
       VALUES (?, '2026-09-14', 'PAYMENT_VOID', 30000, ?)`,
      [shop.abc.id, shop.voidedPaymentId]
    )
    corrupt('UPDATE supplier_payments SET stock_receipt_id = ? WHERE id = ?', [
      shop.voided.id,
      shop.paymentId
    ])
    const posted = paymentNo(shop.paymentId)
    expect(checkOnly('suppliers.payments').issues).toEqual([
      `Supplier payment ${posted} names receipt ${shop.voided.receiptNo} of another supplier.`,
      `Supplier payment ${posted} has 2 supplier account entries; one is expected.`,
      `Posted supplier payment ${posted} has a void entry.`,
      `Void supplier payment ${paymentNo(shop.voidedPaymentId)} has 2 supplier void entries; one is expected.`
    ])
  })
})

describe('supplier integrity: ledger entries and balances', () => {
  it('detects a balance that does not match the supplier’s entries', () => {
    corrupt('DROP VIEW v_supplier_balance')
    corrupt(
      `CREATE VIEW v_supplier_balance AS
       SELECT s.id AS supplier_id, CASE WHEN s.code = 'SUP-00001' THEN 7 ELSE (
         SELECT coalesce(sum(amount_minor), 0) FROM supplier_ledger WHERE supplier_id = s.id) END AS balance_minor
       FROM suppliers AS s`
    )
    expect(checkOnly('suppliers.ledger')).toMatchObject({
      status: 'ERROR',
      // 10,000.00 opening + 5,720.00 purchase − 2,000.00 paid now − 1,000.00 − 300.00 + 300.00 (void).
      issues: [
        'Supplier SUP-00001: the balance shows 7, but its account entries add up to 1272000.'
      ]
    })
  })

  it('reports an error, never a crash, when the balance view is missing', () => {
    corrupt('DROP VIEW v_supplier_balance')
    expect(checkOnly('suppliers.ledger')).toMatchObject({
      status: 'ERROR',
      summary: CHECK_FAILED_SUMMARY
    })
  })

  it('detects entries whose sign or references do not match their type, and a second opening balance', () => {
    const payment = entryId('PAYMENT', { paymentId: shop.paymentId })
    corrupt('UPDATE supplier_ledger SET amount_minor = 100000 WHERE id = ?', [payment])
    corrupt(
      `INSERT INTO supplier_ledger (supplier_id, entry_date, type, amount_minor, note)
       VALUES (?, '2026-09-14', 'ADJUSTMENT', 5, NULL)`,
      [shop.abc.id]
    )
    const adjustment = db.get<{ id: number }>('SELECT max(id) AS id FROM supplier_ledger')!.id
    corrupt(
      `INSERT INTO supplier_ledger (supplier_id, entry_date, type, amount_minor)
       VALUES (?, '2026-09-14', 'OPENING', 5)`,
      [shop.abc.id]
    )
    expect(checkOnly('suppliers.ledger').issues).toEqual([
      `Supplier ledger entry ${payment} (PAYMENT, 100000): the amount sign or references do not match the entry type.`,
      `Supplier ledger entry ${adjustment} (ADJUSTMENT, 5): the amount sign or references do not match the entry type.`,
      'Supplier SUP-00001 has 2 opening balances; at most one is expected.'
    ])
  })
})

describe('supplier integrity: business dates after today', () => {
  it('detects future-dated supplier entries, payments and payment voids', () => {
    corrupt("UPDATE supplier_ledger SET entry_date = '2026-10-01' WHERE type = 'ADJUSTMENT'")
    corrupt("UPDATE supplier_payments SET payment_date = '2026-10-02' WHERE id = ?", [
      shop.paymentId
    ])
    corrupt("UPDATE supplier_payments SET void_date = '2026-10-03' WHERE id = ?", [
      shop.voidedPaymentId
    ])
    const issues = checkOnly('dates.future').issues
    expect(issues).toEqual([
      'Supplier ledger entries: 1 dated after today (14-Sep-2026); the first is supplier entry 9, dated 01-Oct-2026.',
      `Supplier payments: 1 dated after today (14-Sep-2026); the first is ${paymentNo(shop.paymentId)}, dated 02-Oct-2026.`,
      `Supplier payment voids: 1 dated after today (14-Sep-2026); the first is ${paymentNo(shop.voidedPaymentId)}, dated 03-Oct-2026.`
    ])
  })

  it('reports the corrupted database as a whole as ERROR', () => {
    corrupt('DELETE FROM supplier_ledger WHERE id = ?', [
      entryId('PAYMENT', { paymentId: shop.paymentId })
    ])
    corrupt("UPDATE supplier_payments SET payment_date = '2026-10-02' WHERE id = ?", [
      shop.paymentId
    ])
    const result = report()
    expect(result.status).toBe('ERROR')
    expect(result.checks.filter((item) => item.status === 'ERROR').map((item) => item.id)).toEqual([
      'suppliers.payments',
      'dates.future'
    ])
  })
})

describe('supplier integrity: a database from before supplier accounts', () => {
  it('reports the supplier checks as not applicable, and still checks every other business date', async () => {
    const other = createTempDir()
    try {
      const old = await createSchemaDatabase(other, [
        initialMigration,
        stockAdjustmentReceiptItemMigration
      ])
      const result = runIntegrityCheck(old, {
        migrations: [initialMigration, stockAdjustmentReceiptItemMigration],
        now: () => NOW
      })
      expect(result.status).toBe('OK')
      for (const id of ['suppliers.ledger', 'suppliers.purchases', 'suppliers.payments'] as const) {
        expect(result.checks.find((item) => item.id === id)).toMatchObject({
          status: 'OK',
          summary: 'Not applicable: the database has no supplier accounts yet.'
        })
      }
      expect(result.checks.find((item) => item.id === 'dates.future')!.summary).toMatch(/checked/)
    } finally {
      other.remove()
    }
  })
})
