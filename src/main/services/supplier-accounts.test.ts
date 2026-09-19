import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Customer } from '@shared/customers'
import type { InvoiceLineInput } from '@shared/invoices'
import type { Product, ProductUnitInput } from '@shared/products'
import {
  RECEIPT_LOCKED_MESSAGE,
  type PaidNowInput,
  type StockReceiptDetail,
  type StockReceiptInput
} from '@shared/stock'
import type { Supplier, SupplierCreateInput } from '@shared/suppliers'
import type { Db } from '../db/adapter'
import { createSchemaDatabase, createTempDir, thrown, type TempDir } from '../db/test-utils'
import { AppFailure } from '../errors'
import { createCustomer, getCustomer } from './customers.service'
import { createInvoice } from './invoices.service'
import { createProduct } from './products.service'
import { dashboardData } from './dashboard.service'
import { expenseReport, profitLossReport, supplierBalancesReport } from './reports.service'
import { hasMonetaryData } from './settings.service'
import {
  adjustStock,
  getReceipt,
  listReceipts,
  postingFloor,
  receiveStock,
  stockSummary,
  voidReceipt
} from './stock.service'
import {
  checkDuplicateSupplierPayment,
  createSupplierPayment,
  getSupplierPayment,
  listSupplierPayments,
  voidSupplierPayment
} from './supplier-payments.service'
import {
  adjustSupplierBalance,
  createSupplier,
  getSupplier,
  listSuppliers,
  postSupplierOpeningBalance,
  searchSuppliers,
  setSupplierActive,
  supplierLedger,
  updateSupplier
} from './suppliers.service'
import { failingWrites } from './test-utils'

// Test data lives only in temporary databases.

const NOW = new Date(2026, 8, 16, 10, 30, 0)
const TODAY = '2026-09-16'

let temp: TempDir
let db: Db
let requests: number
/** Product A: Piece (base) and Box of 10. */
let productA: Product
/** Product B: Piece (base) and Box of 5. */
let productB: Product

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  requests = 0
  productA = product('A-001', 'Product A', [
    unit({ name: 'Piece', retailPriceMinor: 400_000 }),
    unit({ name: 'Box', baseQty: 10, isBase: false, retailPriceMinor: 4_000_000 })
  ])
  productB = product('B-001', 'Product B', [
    unit({ name: 'Piece', retailPriceMinor: 500_000 }),
    unit({ name: 'Box', baseQty: 5, isBase: false, retailPriceMinor: 2_500_000 })
  ])
})

afterEach(() => {
  temp.remove()
})

// --- Fixtures ---------------------------------------------------------------------------------------------------------

function nextRequestId(): string {
  requests++
  return `supplier-request-${String(requests).padStart(4, '0')}`
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

function unitId(item: Product, name: string): number {
  return item.units.find((candidate) => candidate.name === name)!.id
}

function supplierInput(overrides: Partial<SupplierCreateInput> = {}): SupplierCreateInput {
  return {
    name: 'ABC Distributors',
    contactPerson: 'Imran',
    phone: '0300-1112233',
    address: 'Circular Road',
    city: 'Lahore',
    notes: null,
    opening: null,
    currencyMinorDigits: 2,
    ...overrides
  }
}

function supplier(overrides: Partial<SupplierCreateInput> = {}): Supplier {
  return createSupplier(db, supplierInput(overrides), NOW)
}

type Line = [item: Product, unitName: string, quantity: number, unitCostMinor: number]

function receiptInput(
  date: string,
  supplierId: number | null,
  lines: Line[],
  extra: Partial<StockReceiptInput> = {}
): StockReceiptInput {
  return {
    requestId: nextRequestId(),
    receiptDate: date,
    supplierId,
    supplierName: null,
    supplierBillNo: null,
    reference: null,
    note: null,
    paidNow: null,
    currencyMinorDigits: 2,
    lines: lines.map(([item, unitName, quantity, unitCostMinor]) => ({
      productId: item.id,
      unitId: unitId(item, unitName),
      quantity,
      unitCostMinor
    })),
    ...extra
  }
}

function purchase(
  date: string,
  supplierId: number | null,
  lines: Line[],
  extra: Partial<StockReceiptInput> = {},
  on: Db = db
): StockReceiptDetail {
  return receiveStock(on, receiptInput(date, supplierId, lines, extra), NOW)
}

function paid(amountMinor: number, method: PaidNowInput['method'] = 'CASH'): PaidNowInput {
  return { amountMinor, method, reference: null }
}

/** 10 Box A at Rs 3,000 and 5 Box B at Rs 4,000: Rs 50,000. */
function abcLines(): Line[] {
  return [
    [productA, 'Box', 10, 300_000],
    [productB, 'Box', 5, 400_000]
  ]
}

function pay(
  supplierId: number,
  date: string,
  amountMinor: number,
  extra: { requestId?: string; method?: PaidNowInput['method']; on?: Db } = {}
): ReturnType<typeof createSupplierPayment> {
  return createSupplierPayment(
    extra.on ?? db,
    {
      requestId: extra.requestId ?? nextRequestId(),
      supplierId,
      paymentDate: date,
      amountMinor,
      method: extra.method ?? 'CASH',
      reference: null,
      note: null,
      currencyMinorDigits: 2
    },
    NOW
  )
}

function balance(supplierId: number): number {
  return getSupplier(db, supplierId).balanceMinor
}

function ledger(supplierId: number): Array<[string, string, number]> {
  return supplierLedger(db, { supplierId, page: 1, pageSize: 100 }).rows.map((row) => [
    row.entryDate,
    row.type,
    row.amountMinor
  ])
}

function sequence(name: string): number {
  return db.get<{ next_value: number }>('SELECT next_value FROM sequences WHERE name = ?', [name])!
    .next_value
}

function count(table: string): number {
  return db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n
}

function failure(fn: () => unknown): AppFailure['error'] {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

function customer(): Customer {
  return createCustomer(
    db,
    {
      name: 'Bilal Khan',
      shopName: 'Bilal Store',
      phone: null,
      address: null,
      city: null,
      notes: null,
      opening: null,
      currencyMinorDigits: 2
    },
    NOW
  )
}

function sellPieces(
  customerId: number,
  date: string,
  item: Product,
  pieces: number,
  priceMinor: number
): void {
  const line: InvoiceLineInput = {
    productId: item.id,
    quantities: [
      {
        unitId: unitId(item, 'Piece'),
        quantity: pieces,
        unitPriceMinor: priceMinor,
        priceOverride: false
      }
    ],
    freeQuantities: [],
    discount: null,
    schemeMinor: 0,
    ctnCount: null
  }
  createInvoice(
    db,
    {
      requestId: nextRequestId(),
      invoiceDate: date,
      customerId,
      priceTier: 'RETAIL',
      invoiceCode: null,
      biltyNo: null,
      transportName: null,
      addaName: null,
      checkedBy: null,
      notes: null,
      lines: [line],
      extraDiscountMinor: 0,
      freightMinor: 0,
      receivedMinor: 0,
      paymentMethod: null,
      paymentReference: null,
      currencyMinorDigits: 2
    },
    NOW
  )
}

// --- Suppliers ------------------------------------------------------------------------------------------------------------

describe('suppliers: create, search, edit and deactivate', () => {
  it('gives each new supplier the next SUP code and allows repeated names', () => {
    const first = supplier()
    const second = supplier()
    expect([first.code, second.code]).toEqual(['SUP-00001', 'SUP-00002'])
    expect(second).toMatchObject({
      name: 'ABC Distributors',
      contactPerson: 'Imran',
      phone: '0300-1112233',
      address: 'Circular Road',
      city: 'Lahore',
      notes: null,
      isActive: true,
      balanceMinor: 0,
      latestEntryDate: null,
      totalPurchasesMinor: 0,
      purchaseCount: 0,
      totalPaidMinor: 0,
      paymentCount: 0,
      lastPurchaseDate: null,
      lastPaymentDate: null,
      productsPurchased: []
    })
    expect(sequence('supplier')).toBe(3)
  })

  it('uses no code when a create fails, and saves nothing of it', () => {
    const error = failure(() =>
      supplier({ opening: { side: 'DUE', amountMinor: 100_000, date: '2026-09-17' } })
    )
    expect(error.code).toBe('DATE_NOT_ALLOWED')
    expect(error.fieldErrors).toHaveProperty(['opening.date'])
    expect(count('suppliers')).toBe(0)
    expect(count('supplier_ledger')).toBe(0)
    expect(sequence('supplier')).toBe(1)
    expect(supplier().code).toBe('SUP-00001')
  })

  it('refuses amounts entered with other currency decimal places', () => {
    expect(failure(() => supplier({ currencyMinorDigits: 0 })).code).toBe('CONFLICT')
    expect(count('suppliers')).toBe(0)
  })

  it('searches by code, name, contact person, phone (spaces and dashes ignored) and city', () => {
    const abc = supplier()
    const xyz = supplier({
      name: 'XYZ Traders',
      contactPerson: 'Naveed',
      phone: '042 3555 7788',
      city: 'Karachi'
    })
    const names = (query: string, includeInactive = false): string[] =>
      searchSuppliers(db, { query, limit: 10, includeInactive }).map((item) => item.code)
    expect(names('SUP-00002')).toEqual([xyz.code])
    expect(names('abc')).toEqual([abc.code])
    expect(names('naveed')).toEqual([xyz.code])
    expect(names('03001112233')).toEqual([abc.code])
    expect(names('35557788')).toEqual([xyz.code])
    expect(names('karachi')).toEqual([xyz.code])
    expect(names('traders karachi')).toEqual([xyz.code])
    // Nothing typed browses them all, by name.
    expect(names('')).toEqual([abc.code, xyz.code])
    expect(names('  ')).toEqual([abc.code, xyz.code])
    setSupplierActive(db, { id: xyz.id, active: false })
    expect(names('karachi')).toEqual([])
    expect(names('karachi', true)).toEqual([xyz.code])
    expect(names('')).toEqual([abc.code])
    expect(names('', true)).toEqual([abc.code, xyz.code])
  })

  it('lists suppliers by name, with balances, a status filter and pages', () => {
    const b = supplier({
      name: 'B Supplier',
      opening: { side: 'DUE', amountMinor: 700_000, date: TODAY }
    })
    const a = supplier({ name: 'A Supplier' })
    const c = supplier({ name: 'C Supplier' })
    setSupplierActive(db, { id: c.id, active: false })
    const page = listSuppliers(db, { page: 1, pageSize: 25, search: '', status: 'active' })
    expect(page.total).toBe(2)
    expect(page.items.map((item) => [item.name, item.balanceMinor])).toEqual([
      ['A Supplier', 0],
      ['B Supplier', 700_000]
    ])
    expect(
      listSuppliers(db, { page: 1, pageSize: 25, search: '', status: 'inactive' }).items.map(
        (item) => item.id
      )
    ).toEqual([c.id])
    const all = listSuppliers(db, { page: 2, pageSize: 2, search: '', status: 'all' })
    expect(all.total).toBe(3)
    expect(all.items.map((item) => item.id)).toEqual([c.id])
    expect(
      listSuppliers(db, { page: 1, pageSize: 25, search: 'b supp', status: 'all' }).items.map(
        (item) => item.id
      )
    ).toEqual([b.id])
    expect(a.code).toBe('SUP-00002')
  })

  it('edits the profile only: the code, ledger and old receipts stay as they were', () => {
    const abc = supplier()
    const receipt = purchase('2026-09-10', abc.id, [[productA, 'Box', 1, 3_000_000]])
    const before = ledger(abc.id)
    const edited = updateSupplier(db, {
      id: abc.id,
      name: 'ABC Distributors (Pvt) Ltd',
      contactPerson: null,
      phone: '0300-9998877',
      address: null,
      city: 'Faisalabad',
      notes: 'Delivers on Mondays'
    })
    expect(edited).toMatchObject({
      code: 'SUP-00001',
      name: 'ABC Distributors (Pvt) Ltd',
      contactPerson: null,
      city: 'Faisalabad',
      balanceMinor: 3_000_000
    })
    expect(ledger(abc.id)).toEqual(before)
    // The receipt keeps the name it was saved with, and links to the supplier's current code.
    expect(getReceipt(db, receipt.id)).toMatchObject({
      supplierName: 'ABC Distributors',
      supplierId: abc.id,
      supplierCode: 'SUP-00001'
    })
    expect(
      failure(() =>
        updateSupplier(db, {
          id: 99,
          name: 'X',
          contactPerson: null,
          phone: null,
          address: null,
          city: null,
          notes: null
        })
      ).code
    ).toBe('NOT_FOUND')
  })

  it('deactivates and reactivates a supplier, keeping its balance and history', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: TODAY } })
    const inactive = setSupplierActive(db, { id: abc.id, active: false })
    expect(inactive).toMatchObject({ isActive: false, balanceMinor: 1_000_000 })
    expect(setSupplierActive(db, { id: abc.id, active: false }).isActive).toBe(false)
    expect(ledger(abc.id)).toEqual([[TODAY, 'OPENING', 1_000_000]])
    expect(setSupplierActive(db, { id: abc.id, active: true })).toMatchObject({
      isActive: true,
      balanceMinor: 1_000_000
    })
    expect(failure(() => setSupplierActive(db, { id: 99, active: true })).code).toBe('NOT_FOUND')
    expect(failure(() => getSupplier(db, 99)).code).toBe('NOT_FOUND')
  })
})

// --- Opening balances ----------------------------------------------------------------------------------------------------

describe('suppliers: opening balance', () => {
  it('records what the shop owes the supplier as a positive OPENING entry', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-01' } })
    expect(abc).toMatchObject({ balanceMinor: 1_000_000, latestEntryDate: '2026-09-01' })
    expect(ledger(abc.id)).toEqual([['2026-09-01', 'OPENING', 1_000_000]])
  })

  it('records a supplier advance as a negative OPENING entry', () => {
    const abc = supplier({ opening: { side: 'ADVANCE', amountMinor: 250_000, date: '2026-09-01' } })
    expect(abc.balanceMinor).toBe(-250_000)
    expect(ledger(abc.id)).toEqual([['2026-09-01', 'OPENING', -250_000]])
  })

  it('writes no entry for a zero opening balance', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 0, date: '2026-09-01' } })
    expect(abc.balanceMinor).toBe(0)
    expect(ledger(abc.id)).toEqual([])
  })

  it('is the supplier’s first entry only: a later second opening balance is refused', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-01' } })
    const error = failure(() =>
      db.transaction(() =>
        postSupplierOpeningBalance(db, abc.id, { side: 'DUE', amountMinor: 5, date: TODAY }, TODAY)
      )
    )
    expect(error.code).toBe('FORBIDDEN_STATE')
    expect(error.message).toContain('Use Adjust Balance instead')
    expect(ledger(abc.id)).toEqual([['2026-09-01', 'OPENING', 1_000_000]])
  })

  it('locks the currency settings once a supplier balance or payment exists, not for a supplier alone', async () => {
    // A database without the priced products of the other tests.
    const other = createTempDir()
    try {
      const fresh = await createSchemaDatabase(other)
      const plain = createSupplier(
        fresh,
        supplierInput({ opening: { side: 'DUE', amountMinor: 0, date: TODAY } }),
        NOW
      )
      expect(hasMonetaryData(fresh)).toBe(false)
      createSupplierPayment(
        fresh,
        {
          requestId: 'lock-check-0001',
          supplierId: plain.id,
          paymentDate: TODAY,
          amountMinor: 1,
          method: 'CASH',
          reference: null,
          note: null,
          currencyMinorDigits: 2
        },
        NOW
      )
      expect(hasMonetaryData(fresh)).toBe(true)
      const again = createTempDir()
      try {
        const opening = await createSchemaDatabase(again)
        createSupplier(
          opening,
          supplierInput({ opening: { side: 'ADVANCE', amountMinor: 1, date: TODAY } }),
          NOW
        )
        expect(hasMonetaryData(opening)).toBe(true)
      } finally {
        again.remove()
      }
    } finally {
      other.remove()
    }
  })
})

// --- Stock purchases ------------------------------------------------------------------------------------------------------

describe('Stock In with a supplier account', () => {
  it('adds the stock and the purchase total to what the shop owes the supplier', () => {
    const abc = supplier()
    const receipt = purchase('2026-09-10', abc.id, abcLines(), {
      supplierBillNo: 'ABC-101',
      reference: 'Truck 7'
    })
    expect(receipt).toMatchObject({
      receiptNo: 'GRN-000001',
      supplierId: abc.id,
      supplierCode: 'SUP-00001',
      supplierName: 'ABC Distributors',
      supplierBillNo: 'ABC-101',
      reference: 'Truck 7',
      totalCostMinor: 5_000_000,
      status: 'POSTED',
      supplierPayments: [],
      supplierBalanceMinor: 5_000_000
    })
    expect(stockSummary(db, productA.id)).toMatchObject({ qtyBase: 100, valueMinor: 3_000_000 })
    expect(stockSummary(db, productB.id)).toMatchObject({ qtyBase: 25, valueMinor: 2_000_000 })
    expect(ledger(abc.id)).toEqual([['2026-09-10', 'PURCHASE', 5_000_000]])
    const [entry] = supplierLedger(db, { supplierId: abc.id, page: null, pageSize: 50 }).rows
    expect(entry).toMatchObject({
      receiptId: receipt.id,
      receiptNo: 'GRN-000001',
      supplierBillNo: 'ABC-101',
      paymentId: null,
      runningBalanceMinor: 5_000_000
    })
    // Nothing paid now: no payment and no payment number used.
    expect(count('supplier_payments')).toBe(0)
    expect(sequence('supplier_payment')).toBe(1)
    expect(getSupplier(db, abc.id)).toMatchObject({
      totalPurchasesMinor: 5_000_000,
      purchaseCount: 1,
      totalPaidMinor: 0,
      lastPurchaseDate: '2026-09-10',
      lastPaymentDate: null
    })
  })

  it('records money paid now as a real supplier payment that reduces the due', () => {
    const abc = supplier()
    const receipt = purchase('2026-09-10', abc.id, abcLines(), {
      paidNow: { amountMinor: 2_000_000, method: 'BANK', reference: 'TT-55' }
    })
    expect(receipt.supplierBalanceMinor).toBe(3_000_000)
    expect(receipt.supplierPayments).toEqual([
      expect.objectContaining({
        paymentNo: 'SPAY-000001',
        paymentDate: '2026-09-10',
        amountMinor: 2_000_000,
        method: 'BANK',
        reference: 'TT-55',
        status: 'POSTED',
        receiptId: receipt.id,
        receiptNo: 'GRN-000001'
      })
    ])
    expect(ledger(abc.id)).toEqual([
      ['2026-09-10', 'PURCHASE', 5_000_000],
      ['2026-09-10', 'PAYMENT', -2_000_000]
    ])
    const payment = getSupplierPayment(db, receipt.supplierPayments[0].id)
    expect(payment).toMatchObject({ receiptStatus: 'POSTED', supplierActive: true, note: null })
    expect(getSupplier(db, abc.id)).toMatchObject({
      totalPaidMinor: 2_000_000,
      paymentCount: 1,
      lastPaymentDate: '2026-09-10'
    })
  })

  it('settles the purchase when it is paid in full', () => {
    const abc = supplier()
    expect(
      purchase('2026-09-10', abc.id, abcLines(), { paidNow: paid(5_000_000) }).supplierBalanceMinor
    ).toBe(0)
  })

  it('keeps an overpayment as a supplier advance', () => {
    const abc = supplier()
    const receipt = purchase('2026-09-10', abc.id, abcLines(), { paidNow: paid(5_500_000) })
    expect(receipt.supplierBalanceMinor).toBe(-500_000)
  })

  it('handles the same product on several lines, in different units and costs', () => {
    const abc = supplier()
    const receipt = purchase('2026-09-10', abc.id, [
      [productA, 'Box', 1, 3_000_000],
      [productA, 'Piece', 5, 310_000]
    ])
    expect(receipt.totalCostMinor).toBe(4_550_000)
    expect(stockSummary(db, productA.id)).toMatchObject({ qtyBase: 15, valueMinor: 4_550_000 })
    expect(balance(abc.id)).toBe(4_550_000)
    expect(getSupplier(db, abc.id).productsPurchased).toEqual([
      {
        productId: productA.id,
        code: 'A-001',
        name: 'Product A',
        lastPurchaseDate: '2026-09-10',
        lastUnitCostMinor: 310_000,
        lastUnitName: 'Piece',
        totalQtyBase: 15,
        totalQuantityText: '1 Box + 5 Piece'
      }
    ])
  })

  it('adds zero-cost stock without a purchase entry', () => {
    const abc = supplier()
    const receipt = purchase('2026-09-10', abc.id, [[productA, 'Piece', 5, 0]])
    expect(receipt.totalCostMinor).toBe(0)
    expect(stockSummary(db, productA.id)).toMatchObject({ qtyBase: 5, valueMinor: 0 })
    expect(ledger(abc.id)).toEqual([])
    expect(balance(abc.id)).toBe(0)
  })

  it('lists and searches receipts by supplier account and supplier bill number', () => {
    const abc = supplier()
    const xyz = supplier({ name: 'XYZ Traders' })
    const first = purchase('2026-09-10', abc.id, [[productA, 'Box', 1, 3_000_000]], {
      supplierBillNo: 'ABC-101'
    })
    const second = purchase('2026-09-11', xyz.id, [[productB, 'Box', 1, 4_000_000]], {
      supplierBillNo: 'XYZ-9'
    })
    const third = purchase('2026-09-12', abc.id, [[productA, 'Box', 1, 3_000_000]], {
      supplierBillNo: 'ABC-102'
    })
    const unlinked = purchase('2026-09-12', null, [[productB, 'Piece', 1, 800_000]], {
      supplierName: 'Walk-in seller'
    })
    const ids = (input: { search?: string; supplierId?: number | null }): number[] =>
      listReceipts(db, {
        page: 1,
        pageSize: 25,
        search: input.search ?? '',
        supplierId: input.supplierId ?? null
      }).items.map((item) => item.id)
    expect(ids({ supplierId: abc.id })).toEqual([third.id, first.id])
    expect(ids({ supplierId: xyz.id })).toEqual([second.id])
    expect(ids({ search: 'ABC-10' })).toEqual([third.id, first.id])
    expect(ids({ search: 'xyz-9' })).toEqual([second.id])
    expect(ids({})).toEqual([unlinked.id, third.id, second.id, first.id])
    // A receipt without a supplier account keeps its free-text name and no account.
    expect(getReceipt(db, unlinked.id)).toMatchObject({
      supplierName: 'Walk-in seller',
      supplierId: null,
      supplierCode: null,
      supplierBalanceMinor: null,
      supplierPayments: []
    })
  })

  it('refuses an inactive or missing supplier, and saves nothing', () => {
    const abc = supplier()
    setSupplierActive(db, { id: abc.id, active: false })
    const inactive = failure(() => purchase('2026-09-10', abc.id, abcLines()))
    expect(inactive).toMatchObject({
      code: 'FORBIDDEN_STATE',
      fieldErrors: { supplierId: ['This supplier is inactive.'] }
    })
    expect(inactive.message).toContain('Reactivate the supplier')
    expect(failure(() => purchase('2026-09-10', 999, abcLines())).code).toBe('NOT_FOUND')
    expect(count('stock_receipts')).toBe(0)
    expect(count('stock_movements')).toBe(0)
    expect(sequence('receipt')).toBe(1)
  })

  it('refuses paid now without a supplier account, and a free-text name with one', () => {
    const abc = supplier()
    const noSupplier = failure(() =>
      purchase('2026-09-10', null, abcLines(), { paidNow: paid(100) })
    )
    expect(noSupplier.code).toBe('VALIDATION')
    expect(noSupplier.fieldErrors).toHaveProperty('paidNow')
    const withName = failure(() =>
      purchase('2026-09-10', abc.id, abcLines(), { supplierName: 'Other' })
    )
    expect(withName.fieldErrors).toHaveProperty('supplierName')
    expect(
      failure(() => purchase('2026-09-10', abc.id, abcLines(), { paidNow: paid(0) })).code
    ).toBe('VALIDATION')
    expect(count('stock_receipts')).toBe(0)
  })

  it('returns the saved receipt for a repeated request id, posting nothing twice', () => {
    const abc = supplier()
    const input = receiptInput('2026-09-10', abc.id, abcLines(), { paidNow: paid(2_000_000) })
    const first = receiveStock(db, input, NOW)
    const again = receiveStock(db, input, NOW)
    expect(again).toEqual(first)
    expect(count('stock_receipts')).toBe(1)
    expect(count('supplier_payments')).toBe(1)
    expect(ledger(abc.id)).toHaveLength(2)
    expect(balance(abc.id)).toBe(3_000_000)
    expect(stockSummary(db, productA.id).qtyBase).toBe(100)
  })

  it.each([
    ['the purchase entry', /INSERT INTO supplier_ledger/, 1],
    ['the paid-now payment', /INSERT INTO supplier_payments/, 1],
    ['the paid-now payment entry', /INSERT INTO supplier_ledger/, 2]
  ])('rolls back everything when %s cannot be written', (_what, pattern, failAt) => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-01' } })
    const failing = failingWrites(db, pattern, failAt)
    expect(() =>
      purchase('2026-09-10', abc.id, abcLines(), { paidNow: paid(2_000_000) }, failing)
    ).toThrow('simulated write failure')
    expect(count('stock_receipts')).toBe(0)
    expect(count('stock_receipt_items')).toBe(0)
    expect(count('stock_movements')).toBe(0)
    expect(count('supplier_payments')).toBe(0)
    expect(ledger(abc.id)).toEqual([['2026-09-01', 'OPENING', 1_000_000]])
    // The numbers taken inside the failed transaction are returned.
    expect(sequence('receipt')).toBe(1)
    expect(sequence('supplier_payment')).toBe(1)
    const saved = purchase('2026-09-10', abc.id, abcLines(), { paidNow: paid(2_000_000) })
    expect(saved.receiptNo).toBe('GRN-000001')
    expect(saved.supplierPayments[0].paymentNo).toBe('SPAY-000001')
    expect(saved.supplierBalanceMinor).toBe(4_000_000)
  })
})

// --- Dates --------------------------------------------------------------------------------------------------------------

describe('supplier posting dates', () => {
  it('refuses a purchase before the supplier’s latest account entry, naming the supplier', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-10' } })
    const error = failure(() => purchase('2026-09-05', abc.id, abcLines()))
    expect(error).toMatchObject({
      code: 'DATE_NOT_ALLOWED',
      details: { earliestDate: '2026-09-10', supplierId: abc.id, supplierCode: 'SUP-00001' },
      fieldErrors: {
        receiptDate: [expect.stringContaining('SUP-00001 ABC Distributors has account activity on')]
      }
    })
    expect(purchase('2026-09-10', abc.id, abcLines()).status).toBe('POSTED')
  })

  it('refuses a purchase before a product’s latest stock movement, naming the product', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-08' } })
    purchase('2026-09-12', null, [[productA, 'Piece', 1, 300_000]])
    const error = failure(() => purchase('2026-09-11', abc.id, abcLines()))
    expect(error).toMatchObject({
      code: 'DATE_NOT_ALLOWED',
      details: { earliestDate: '2026-09-12', productId: productA.id }
    })
    expect(error.message).toContain('A-001 Product A has stock activity on')
  })

  it('reports the later floor when both the product and the supplier block the date', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-12' } })
    purchase('2026-09-08', null, [[productA, 'Piece', 1, 300_000]])
    expect(failure(() => purchase('2026-09-07', abc.id, abcLines())).details).toMatchObject({
      earliestDate: '2026-09-12',
      supplierId: abc.id
    })
    expect(postingFloor(db, { productIds: [productA.id], supplierId: abc.id }, NOW)).toEqual({
      today: TODAY,
      earliestDate: '2026-09-12',
      setBy: null,
      supplierSetBy: {
        supplierId: abc.id,
        supplierCode: 'SUP-00001',
        supplierName: 'ABC Distributors'
      }
    })
    purchase('2026-09-14', null, [[productA, 'Piece', 1, 300_000]])
    expect(failure(() => purchase('2026-09-13', abc.id, abcLines())).details).toMatchObject({
      earliestDate: '2026-09-14',
      productId: productA.id
    })
    expect(postingFloor(db, { productIds: [productA.id], supplierId: abc.id }, NOW)).toEqual({
      today: TODAY,
      earliestDate: '2026-09-14',
      setBy: { productId: productA.id, productCode: 'A-001', productName: 'Product A' },
      supplierSetBy: null
    })
  })

  it('is not blocked by another supplier or another product', () => {
    const abc = supplier()
    const xyz = supplier({
      name: 'XYZ Traders',
      opening: { side: 'DUE', amountMinor: 100, date: '2026-09-15' }
    })
    purchase('2026-09-15', null, [[productB, 'Piece', 1, 800_000]])
    expect(purchase('2026-09-10', abc.id, [[productA, 'Box', 1, 3_000_000]]).status).toBe('POSTED')
    expect(pay(abc.id, '2026-09-10', 100).status).toBe('POSTED')
    expect(balance(xyz.id)).toBe(100)
  })

  it('refuses a purchase or a supplier payment dated after today', () => {
    const abc = supplier()
    expect(failure(() => purchase('2026-09-17', abc.id, abcLines())).code).toBe('DATE_NOT_ALLOWED')
    expect(failure(() => pay(abc.id, '2026-09-17', 100))).toMatchObject({
      code: 'DATE_NOT_ALLOWED',
      fieldErrors: { paymentDate: [expect.stringContaining('later than today')] }
    })
    expect(count('stock_receipts')).toBe(0)
    expect(count('supplier_payments')).toBe(0)
  })
})

// --- Supplier payments ----------------------------------------------------------------------------------------------------

describe('Pay Supplier', () => {
  it('reduces what the shop owes, numbers payments SPAY-000001 on, and reports the new balance', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 4_000_000, date: '2026-09-10' } })
    const first = pay(abc.id, '2026-09-11', 1_500_000)
    expect(first).toMatchObject({
      paymentNo: 'SPAY-000001',
      supplierCode: 'SUP-00001',
      amountMinor: 1_500_000,
      status: 'POSTED',
      receiptId: null,
      balanceAfterMinor: 2_500_000,
      replayed: false
    })
    expect(pay(abc.id, '2026-09-11', 500_000).paymentNo).toBe('SPAY-000002')
    expect(ledger(abc.id)).toEqual([
      ['2026-09-10', 'OPENING', 4_000_000],
      ['2026-09-11', 'PAYMENT', -1_500_000],
      ['2026-09-11', 'PAYMENT', -500_000]
    ])
  })

  it('keeps an overpayment as a supplier advance', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-10' } })
    expect(pay(abc.id, TODAY, 1_500_000).balanceAfterMinor).toBe(-500_000)
  })

  it.each(['CASH', 'BANK', 'CHEQUE', 'OTHER'] as const)('accepts the %s method', (method) => {
    const abc = supplier()
    expect(pay(abc.id, TODAY, 100, { method }).method).toBe(method)
  })

  it('returns the saved payment for a repeated request id', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-10' } })
    const first = pay(abc.id, TODAY, 400_000, { requestId: 'pay-once-0001' })
    const again = pay(abc.id, TODAY, 400_000, { requestId: 'pay-once-0001' })
    expect(again).toEqual({ ...first, replayed: true })
    expect(count('supplier_payments')).toBe(1)
    expect(balance(abc.id)).toBe(600_000)
  })

  it('finds posted payments with the same supplier, date and amount for the duplicate warning', () => {
    const abc = supplier()
    const xyz = supplier({ name: 'XYZ Traders' })
    const first = pay(abc.id, TODAY, 400_000)
    pay(abc.id, TODAY, 400_001)
    pay(xyz.id, TODAY, 400_000)
    const check = (): number[] =>
      checkDuplicateSupplierPayment(db, {
        supplierId: abc.id,
        paymentDate: TODAY,
        amountMinor: 400_000
      }).duplicates.map((payment) => payment.id)
    expect(check()).toEqual([first.id])
    voidSupplierPayment(db, { id: first.id, reason: 'Entered twice' }, NOW)
    expect(check()).toEqual([])
  })

  it('voids a payment: the due comes back, the PAYMENT entry stays, and a second void is refused', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-10' } })
    const payment = pay(abc.id, '2026-09-12', 400_000)
    const voided = voidSupplierPayment(db, { id: payment.id, reason: 'Cheque bounced' }, NOW)
    expect(voided).toMatchObject({
      status: 'VOID',
      voidReason: 'Cheque bounced',
      voidDate: TODAY,
      voidedAt: NOW.toISOString(),
      balanceAfterMinor: 1_000_000
    })
    expect(ledger(abc.id)).toEqual([
      ['2026-09-10', 'OPENING', 1_000_000],
      ['2026-09-12', 'PAYMENT', -400_000],
      [TODAY, 'PAYMENT_VOID', 400_000]
    ])
    const rows = supplierLedger(db, { supplierId: abc.id, page: 1, pageSize: 10 }).rows
    expect(rows[1]).toMatchObject({
      paymentNo: 'SPAY-000001',
      paymentStatus: 'VOID',
      paymentMethod: 'CASH'
    })
    expect(rows[2]).toMatchObject({ note: 'Cheque bounced' })
    expect(getSupplier(db, abc.id)).toMatchObject({ totalPaidMinor: 0, paymentCount: 0 })
    expect(
      failure(() => voidSupplierPayment(db, { id: payment.id, reason: 'Again' }, NOW)).code
    ).toBe('FORBIDDEN_STATE')
    expect(failure(() => voidSupplierPayment(db, { id: 999, reason: 'Again' }, NOW)).code).toBe(
      'NOT_FOUND'
    )
    expect(count('supplier_ledger')).toBe(3)
  })

  it('lets an inactive supplier be paid and a payment of it be voided', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-10' } })
    setSupplierActive(db, { id: abc.id, active: false })
    const payment = pay(abc.id, TODAY, 1_000_000)
    expect(payment).toMatchObject({ balanceAfterMinor: 0, supplierActive: false })
    expect(
      voidSupplierPayment(db, { id: payment.id, reason: 'Wrong supplier' }, NOW).balanceAfterMinor
    ).toBe(1_000_000)
    expect(getSupplier(db, abc.id).isActive).toBe(false)
  })

  it('refuses a date before the supplier’s latest entry and an unknown supplier', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-10' } })
    expect(failure(() => pay(abc.id, '2026-09-09', 100))).toMatchObject({
      code: 'DATE_NOT_ALLOWED',
      details: { earliestDate: '2026-09-10' }
    })
    expect(failure(() => pay(999, TODAY, 100))).toMatchObject({
      code: 'NOT_FOUND',
      fieldErrors: { supplierId: ['This supplier no longer exists.'] }
    })
    expect(failure(() => pay(abc.id, TODAY, 0)).code).toBe('VALIDATION')
  })

  it('saves nothing when the ledger entry cannot be written', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-10' } })
    expect(() =>
      pay(abc.id, TODAY, 400_000, { on: failingWrites(db, /INSERT INTO supplier_ledger/) })
    ).toThrow('simulated write failure')
    expect(count('supplier_payments')).toBe(0)
    expect(sequence('supplier_payment')).toBe(1)
    expect(balance(abc.id)).toBe(1_000_000)
  })

  it('lists payments newest first, by supplier, status, method, date range and search', () => {
    const abc = supplier()
    const xyz = supplier({ name: 'XYZ Traders' })
    const a1 = pay(abc.id, '2026-09-10', 100, { method: 'BANK' })
    const x1 = pay(xyz.id, '2026-09-11', 200)
    const a2 = pay(abc.id, '2026-09-12', 300)
    voidSupplierPayment(db, { id: a2.id, reason: 'Wrong' }, NOW)
    const ids = (filters: Partial<Parameters<typeof listSupplierPayments>[1] & object>): number[] =>
      listSupplierPayments(db, {
        page: 1,
        pageSize: 25,
        search: '',
        status: 'all',
        method: 'all',
        supplierId: null,
        dateFrom: null,
        dateTo: null,
        ...filters
      }).items.map((payment) => payment.id)
    expect(ids({})).toEqual([a2.id, x1.id, a1.id])
    expect(ids({ supplierId: abc.id })).toEqual([a2.id, a1.id])
    expect(ids({ status: 'VOID' })).toEqual([a2.id])
    expect(ids({ method: 'BANK' })).toEqual([a1.id])
    expect(ids({ dateFrom: '2026-09-11', dateTo: '2026-09-11' })).toEqual([x1.id])
    expect(ids({ search: 'xyz' })).toEqual([x1.id])
    expect(ids({ search: 'SPAY-000001' })).toEqual([a1.id])
  })
})

// --- Receipt voids ------------------------------------------------------------------------------------------------------

describe('voiding a supplier-linked receipt', () => {
  it('reverses the exact stock and the purchase, and keeps the paid-now payment as an advance', () => {
    const abc = supplier()
    const receipt = purchase('2026-09-10', abc.id, abcLines(), { paidNow: paid(2_000_000) })
    const voided = voidReceipt(db, { id: receipt.id, reason: 'Wrong supplier bill' }, NOW)
    expect(voided).toMatchObject({
      status: 'VOID',
      voidDate: TODAY,
      supplierBalanceMinor: -2_000_000
    })
    expect(voided.supplierPayments.map((payment) => payment.status)).toEqual(['POSTED'])
    expect(stockSummary(db, productA.id)).toMatchObject({ qtyBase: 0, valueMinor: 0 })
    expect(stockSummary(db, productB.id)).toMatchObject({ qtyBase: 0, valueMinor: 0 })
    expect(
      db.all(
        `SELECT m.type, m.qty_base, m.value_minor FROM stock_movements AS m
         JOIN stock_receipt_items AS ri ON ri.id = m.receipt_item_id ORDER BY m.id`
      )
    ).toEqual([
      { type: 'STOCK_IN', qty_base: 100, value_minor: 3_000_000 },
      { type: 'STOCK_IN', qty_base: 25, value_minor: 2_000_000 },
      { type: 'STOCK_IN_VOID', qty_base: -100, value_minor: -3_000_000 },
      { type: 'STOCK_IN_VOID', qty_base: -25, value_minor: -2_000_000 }
    ])
    expect(ledger(abc.id)).toEqual([
      ['2026-09-10', 'PURCHASE', 5_000_000],
      ['2026-09-10', 'PAYMENT', -2_000_000],
      [TODAY, 'PURCHASE_VOID', -5_000_000]
    ])
    expect(getSupplier(db, abc.id)).toMatchObject({
      totalPurchasesMinor: 0,
      purchaseCount: 0,
      totalPaidMinor: 2_000_000
    })
    // The money returned: the payment is voided separately.
    const refund = voidSupplierPayment(
      db,
      { id: receipt.supplierPayments[0].id, reason: 'Money returned' },
      NOW
    )
    expect(refund).toMatchObject({ balanceAfterMinor: 0, receiptStatus: 'VOID' })
    expect(failure(() => voidReceipt(db, { id: receipt.id, reason: 'Again' }, NOW)).code).toBe(
      'FORBIDDEN_STATE'
    )
  })

  it('keeps the existing lock: a receipt with later stock activity cannot be voided, and nothing changes', () => {
    const abc = supplier()
    const receipt = purchase('2026-09-10', abc.id, abcLines())
    purchase('2026-09-11', null, [[productA, 'Piece', 1, 300_000]])
    const error = failure(() => voidReceipt(db, { id: receipt.id, reason: 'Wrong' }, NOW))
    expect(error).toMatchObject({ code: 'FORBIDDEN_STATE', message: RECEIPT_LOCKED_MESSAGE })
    expect(ledger(abc.id)).toEqual([['2026-09-10', 'PURCHASE', 5_000_000]])
    expect(getReceipt(db, receipt.id).status).toBe('POSTED')
  })

  it('rolls back the stock reversal when the supplier entry cannot be written', () => {
    const abc = supplier()
    const receipt = purchase('2026-09-10', abc.id, abcLines())
    const failing = failingWrites(db, /INSERT INTO supplier_ledger/)
    expect(() => voidReceipt(failing, { id: receipt.id, reason: 'Wrong' }, NOW)).toThrow(
      'simulated write failure'
    )
    expect(getReceipt(db, receipt.id).status).toBe('POSTED')
    expect(stockSummary(db, productA.id)).toMatchObject({ qtyBase: 100, valueMinor: 3_000_000 })
    expect(count('stock_movements')).toBe(2)
    expect(ledger(abc.id)).toEqual([['2026-09-10', 'PURCHASE', 5_000_000]])
  })

  it('writes no supplier entry for a receipt without a supplier account or with a zero total', () => {
    const abc = supplier()
    const unlinked = purchase('2026-09-10', null, [[productA, 'Piece', 1, 300_000]])
    const free = purchase('2026-09-10', abc.id, [[productB, 'Piece', 1, 0]])
    voidReceipt(db, { id: unlinked.id, reason: 'Wrong' }, NOW)
    voidReceipt(db, { id: free.id, reason: 'Wrong' }, NOW)
    expect(count('supplier_ledger')).toBe(0)
  })

  it('can be voided while the supplier is inactive', () => {
    const abc = supplier()
    const receipt = purchase('2026-09-10', abc.id, abcLines())
    setSupplierActive(db, { id: abc.id, active: false })
    expect(voidReceipt(db, { id: receipt.id, reason: 'Wrong' }, NOW).supplierBalanceMinor).toBe(0)
  })
})

// --- Stock corrections --------------------------------------------------------------------------------------------------

describe('stock corrections of a supplier-linked receipt', () => {
  it('change inventory only, never the supplier account', () => {
    const abc = supplier()
    const receipt = purchase('2026-09-10', abc.id, abcLines())
    const lineA = receipt.lines[0]
    const correction = {
      adjustmentDate: TODAY,
      productId: productA.id,
      receiptItemId: lineA.id,
      reasonNote: 'Supplier bill differs',
      currencyMinorDigits: 2
    }
    adjustStock(
      db,
      {
        ...correction,
        requestId: nextRequestId(),
        reason: 'RECEIPT_COST_CORRECTION',
        direction: null,
        unitId: null,
        quantity: null,
        unitCostMinor: 3_200_000
      },
      NOW
    )
    adjustStock(
      db,
      {
        ...correction,
        requestId: nextRequestId(),
        reason: 'RECEIPT_QTY_CORRECTION',
        direction: 'OUT',
        unitId: unitId(productA, 'Piece'),
        quantity: 2,
        unitCostMinor: null
      },
      NOW
    )
    expect(stockSummary(db, productA.id).qtyBase).toBe(98)
    expect(ledger(abc.id)).toEqual([['2026-09-10', 'PURCHASE', 5_000_000]])
    // The owner records the changed bill deliberately.
    adjustSupplierBalance(
      db,
      {
        supplierId: abc.id,
        entryDate: TODAY,
        direction: 'INCREASE',
        amountMinor: 200_000,
        reason: 'Bill ABC-101 revised',
        currencyMinorDigits: 2
      },
      NOW
    )
    expect(balance(abc.id)).toBe(5_200_000)
  })
})

// --- Balance adjustments -------------------------------------------------------------------------------------------------

describe('Adjust Supplier Balance', () => {
  const adjust = (
    supplierId: number,
    fields: Record<string, unknown> = {}
  ): ReturnType<typeof adjustSupplierBalance> =>
    adjustSupplierBalance(
      db,
      {
        supplierId,
        entryDate: TODAY,
        direction: 'INCREASE',
        amountMinor: 500_000,
        reason: 'Freight added to bill',
        currencyMinorDigits: 2,
        ...fields
      },
      NOW
    )

  it('appends a positive or negative ADJUSTMENT with its reason', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-10' } })
    const up = adjust(abc.id)
    expect(up.entry).toMatchObject({
      type: 'ADJUSTMENT',
      amountMinor: 500_000,
      note: 'Freight added to bill',
      runningBalanceMinor: 1_500_000
    })
    expect(up.supplier.balanceMinor).toBe(1_500_000)
    const down = adjust(abc.id, {
      direction: 'DECREASE',
      amountMinor: 2_000_000,
      reason: 'Discount agreed'
    })
    expect(down.supplier.balanceMinor).toBe(-500_000)
    expect(ledger(abc.id)).toEqual([
      ['2026-09-10', 'OPENING', 1_000_000],
      [TODAY, 'ADJUSTMENT', 500_000],
      [TODAY, 'ADJUSTMENT', -2_000_000]
    ])
    // Append-only: the earlier entries are untouched and cannot be changed.
    expect(() => db.run('UPDATE supplier_ledger SET amount_minor = 1')).toThrow()
    expect(() => db.run('DELETE FROM supplier_ledger')).toThrow()
    expect(count('supplier_ledger')).toBe(3)
  })

  it('refuses a zero amount, a missing reason and a date before the floor', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-10' } })
    expect(failure(() => adjust(abc.id, { amountMinor: 0 })).fieldErrors).toHaveProperty(
      'amountMinor'
    )
    expect(failure(() => adjust(abc.id, { reason: '  ' })).fieldErrors).toHaveProperty('reason')
    expect(failure(() => adjust(abc.id, { entryDate: '2026-09-09' })).code).toBe('DATE_NOT_ALLOWED')
    expect(failure(() => adjust(abc.id, { entryDate: '2026-09-17' })).code).toBe('DATE_NOT_ALLOWED')
    expect(failure(() => adjust(999)).code).toBe('NOT_FOUND')
    expect(count('supplier_ledger')).toBe(1)
  })

  it('is allowed for an inactive supplier, who stays inactive', () => {
    const abc = supplier()
    setSupplierActive(db, { id: abc.id, active: false })
    expect(adjust(abc.id).supplier).toMatchObject({ isActive: false, balanceMinor: 500_000 })
  })
})

// --- Supplier Balances report and Dashboard -------------------------------------------------------------------------------

describe('Supplier Balances report and the Dashboard', () => {
  /** Due Rs 4,000 (ABC), Rs 1,500 (XYZ, inactive) and Rs 9,000 (MNO); an advance of Rs 700 (PQR); settled (STU). */
  function balances(): Record<string, Supplier> {
    const abc = supplier({ name: 'ABC Distributors' })
    purchase('2026-09-10', abc.id, abcLines(), { paidNow: paid(1_000_000) })
    const xyz = supplier({
      name: 'XYZ Traders',
      opening: { side: 'DUE', amountMinor: 150_000, date: '2026-09-01' }
    })
    setSupplierActive(db, { id: xyz.id, active: false })
    const pqr = supplier({
      name: 'PQR Foods',
      opening: { side: 'ADVANCE', amountMinor: 70_000, date: '2026-09-01' }
    })
    const stu = supplier({
      name: 'STU Mills',
      opening: { side: 'DUE', amountMinor: 20_000, date: '2026-09-01' }
    })
    pay(stu.id, '2026-09-11', 20_000)
    const mno = supplier({
      name: 'MNO Agencies',
      opening: { side: 'DUE', amountMinor: 900_000, date: '2026-09-01' }
    })
    return { abc, xyz, pqr, stu, mno }
  }

  it('shows payables and advances apart, every supplier included, inactive ones too', () => {
    const { abc, xyz, pqr, stu, mno } = balances()
    const report = supplierBalancesReport(db)
    expect(
      report.rows.map((row) => [row.code, row.name, row.balanceMinor, row.state, row.isActive])
    ).toEqual([
      [abc.code, 'ABC Distributors', 4_000_000, 'DUE', true],
      [xyz.code, 'XYZ Traders', 150_000, 'DUE', false],
      [pqr.code, 'PQR Foods', -70_000, 'ADVANCE', true],
      [stu.code, 'STU Mills', 0, 'SETTLED', true],
      [mno.code, 'MNO Agencies', 900_000, 'DUE', true]
    ])
    expect(report.rows[0]).toMatchObject({
      phone: '0300-1112233',
      lastPurchaseDate: '2026-09-10',
      lastPaymentDate: '2026-09-10'
    })
    expect(report.rows[3]).toMatchObject({ lastPurchaseDate: null, lastPaymentDate: '2026-09-11' })
    expect(report).toMatchObject({
      payablesMinor: 5_050_000,
      advancesMinor: 70_000,
      dueCount: 3,
      advanceCount: 1,
      settledCount: 1
    })
  })

  it('shows supplier payables on the Dashboard, never reduced by advances, with the largest dues first', () => {
    const { abc, xyz, mno } = balances()
    const data = dashboardData(db, NOW)
    expect(data.summary).toMatchObject({
      supplierPayablesMinor: 5_050_000,
      dueSupplierCount: 3,
      supplierAdvancesMinor: 70_000,
      advanceSupplierCount: 1
    })
    expect(data.suppliersDue).toEqual([
      { supplierId: abc.id, code: abc.code, name: 'ABC Distributors', balanceMinor: 4_000_000 },
      { supplierId: mno.id, code: mno.code, name: 'MNO Agencies', balanceMinor: 900_000 },
      { supplierId: xyz.id, code: xyz.code, name: 'XYZ Traders', balanceMinor: 150_000 }
    ])
    // The other Dashboard figures are those without any supplier data: inventory only.
    expect(data.summary).toMatchObject({
      todaySalesMinor: 0,
      monthSalesMinor: 0,
      receivablesMinor: 0,
      advancesMinor: 0,
      inventoryValueMinor: 5_000_000
    })
    expect(data.expenseBreakdown.operatingMinor).toBe(0)
  })

  it('lists at most five suppliers due', () => {
    for (let index = 1; index <= 7; index++) {
      supplier({
        name: `Supplier ${index}`,
        opening: { side: 'DUE', amountMinor: index * 1000, date: TODAY }
      })
    }
    const due = dashboardData(db, NOW).suppliersDue
    expect(due.map((row) => row.balanceMinor)).toEqual([7000, 6000, 5000, 4000, 3000])
    expect(dashboardData(db, NOW).summary.dueSupplierCount).toBe(7)
  })
})

// --- The separate ledgers, and the P&L --------------------------------------------------------------------------------------

describe('stock, customer and supplier ledgers stay separate', () => {
  it('follows the ABC Distributors example end to end', () => {
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-01' } })
    // Bill ABC-101: 10 Box A + 5 Box B = Rs 50,000, Rs 20,000 paid now.
    purchase('2026-09-10', abc.id, abcLines(), {
      supplierBillNo: 'ABC-101',
      paidNow: paid(2_000_000)
    })
    expect(balance(abc.id)).toBe(4_000_000)
    pay(abc.id, '2026-09-11', 1_500_000)
    expect(balance(abc.id)).toBe(2_500_000)
    purchase('2026-09-12', abc.id, [[productA, 'Box', 10, 300_000]], { supplierBillNo: 'ABC-102' })
    expect(balance(abc.id)).toBe(5_500_000)

    // A customer sale: stock goes down, the customer owes more, the supplier account does not move.
    const bilal = customer()
    const stockBefore = stockSummary(db, productA.id)
    sellPieces(bilal.id, '2026-09-13', productA, 20, 400_000)
    expect(stockSummary(db, productA.id).qtyBase).toBe(stockBefore.qtyBase - 20)
    expect(getCustomer(db, bilal.id).balanceMinor).toBe(8_000_000)
    expect(balance(abc.id)).toBe(5_500_000)

    // A supplier payment: the supplier account moves, stock and the customer do not.
    const stockAfterSale = [stockSummary(db, productA.id), stockSummary(db, productB.id)]
    pay(abc.id, TODAY, 1_000_000)
    expect([stockSummary(db, productA.id), stockSummary(db, productB.id)]).toEqual(stockAfterSale)
    expect(getCustomer(db, bilal.id).balanceMinor).toBe(8_000_000)
    expect(balance(abc.id)).toBe(4_500_000)

    expect(ledger(abc.id)).toEqual([
      ['2026-09-01', 'OPENING', 1_000_000],
      ['2026-09-10', 'PURCHASE', 5_000_000],
      ['2026-09-10', 'PAYMENT', -2_000_000],
      ['2026-09-11', 'PAYMENT', -1_500_000],
      ['2026-09-12', 'PURCHASE', 3_000_000],
      [TODAY, 'PAYMENT', -1_000_000]
    ])
    expect(
      supplierLedger(db, { supplierId: abc.id, page: 1, pageSize: 50 }).rows.map(
        (row) => row.runningBalanceMinor
      )
    ).toEqual([1_000_000, 6_000_000, 4_000_000, 2_500_000, 5_500_000, 4_500_000])
    expect(getSupplier(db, abc.id)).toMatchObject({
      totalPurchasesMinor: 8_000_000,
      purchaseCount: 2,
      totalPaidMinor: 4_500_000,
      paymentCount: 3,
      lastPurchaseDate: '2026-09-12',
      lastPaymentDate: TODAY
    })
    expect(
      getSupplier(db, abc.id).productsPurchased.map((row) => [
        row.code,
        row.lastUnitCostMinor,
        row.totalQuantityText
      ])
    ).toEqual([
      ['A-001', 300_000, '20 Box'],
      ['B-001', 400_000, '5 Box']
    ])
  })

  it('keeps supplier purchases and payments out of the Profit & Loss: only the sale and its frozen COGS count', () => {
    const period = { dateFrom: '2026-09-01', dateTo: '2026-09-30' }
    const abc = supplier({ opening: { side: 'DUE', amountMinor: 1_000_000, date: '2026-09-01' } })
    // 10 Box A at Rs 30,000: Rs 3,000 a piece.
    purchase('2026-09-10', abc.id, [[productA, 'Box', 10, 3_000_000]], { paidNow: paid(1_000_000) })
    const afterPurchase = profitLossReport(db, period)
    expect(afterPurchase).toMatchObject({
      goodsRevenueMinor: 0,
      cogsMinor: 0,
      grossProfitMinor: 0,
      operatingExpensesMinor: 0,
      netOperatingProfitMinor: 0,
      profitAfterDataCorrectionsMinor: 0
    })
    pay(abc.id, '2026-09-11', 2_000_000)
    adjustSupplierBalance(
      db,
      {
        supplierId: abc.id,
        entryDate: '2026-09-11',
        direction: 'DECREASE',
        amountMinor: 100_000,
        reason: 'Discount',
        currencyMinorDigits: 2
      },
      NOW
    )
    expect(profitLossReport(db, period)).toEqual(afterPurchase)
    expect(
      expenseReport(db, { ...period, page: 1, pageSize: 10, status: 'all' }).totalActiveMinor
    ).toBe(0)

    // 20 pieces at Rs 4,000: revenue Rs 80,000, COGS 20 × Rs 3,000 = Rs 60,000.
    const bilal = customer()
    sellPieces(bilal.id, '2026-09-12', productA, 20, 400_000)
    expect(profitLossReport(db, period)).toMatchObject({
      goodsRevenueMinor: 8_000_000,
      cogsMinor: 6_000_000,
      grossProfitMinor: 2_000_000,
      operatingExpensesMinor: 0,
      netOperatingProfitMinor: 2_000_000,
      profitAfterDataCorrectionsMinor: 2_000_000
    })
    // A later supplier payment still changes no profit figure.
    const beforePayment = profitLossReport(db, period)
    pay(abc.id, TODAY, 500_000)
    expect(profitLossReport(db, period)).toEqual(beforePayment)
  })
})
