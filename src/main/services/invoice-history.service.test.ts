import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Customer, CustomerCreateInput } from '@shared/customers'
import type {
  InvoiceCreateInput,
  InvoiceDetail,
  InvoiceLineInput,
  InvoiceListInput,
  InvoiceSaveResult
} from '@shared/invoices'
import type { Product, ProductUnitInput } from '@shared/products'
import type { Db } from '../db/adapter'
import { createSchemaDatabase, createTempDir, thrown, type TempDir } from '../db/test-utils'
import { AppFailure } from '../errors'
import { createCompany, updateCompany } from './companies.service'
import { createCustomer, updateCustomer } from './customers.service'
import { voidInvoice } from './invoice-void.service'
import { createInvoice, getInvoice, listInvoices, updateInvoiceDispatch } from './invoices.service'
import { voidPayment } from './payments.service'
import { createProduct, updateProduct } from './products.service'
import { receiveStock } from './stock.service'

// Test data lives only in temporary databases.

const NOW = new Date(2026, 8, 16, 10, 30, 0)
const LATER = new Date(2026, 8, 16, 17, 45, 0)

let temp: TempDir
let db: Db
let requests: number
let tapalId: number
/** Piece (base; retail 110, wholesale 100) and Box of 24 (retail 2,400). 20 Box in stock. */
let tea: Product
/** C-00002 Ali Raza, Ali Traders. */
let ali: Customer
/** C-00003 Bilal Ahmed, Bilal Store. */
let bilal: Customer
let walkInId: number

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  requests = 0
  tapalId = createCompany(db, { name: 'Tapal' }).id
  tea = createProduct(db, {
    code: 'P-001',
    name: 'Tea 950g',
    companyId: tapalId,
    packingLabel: '1*12*18',
    lowStockThresholdBase: 0,
    currencyMinorDigits: 2,
    units: [
      unit({
        name: 'Piece',
        shortName: 'Pcs',
        retailPriceMinor: 11_000,
        wholesalePriceMinor: 10_000
      }),
      unit({ name: 'Box', baseQty: 24, isBase: false, retailPriceMinor: 240_000 })
    ]
  })
  receiveStock(
    db,
    {
      requestId: nextRequestId(),
      receiptDate: '2026-09-01',
      supplierName: null,
      reference: null,
      note: null,
      currencyMinorDigits: 2,
      lines: [{ productId: tea.id, unitId: box(), quantity: 20, unitCostMinor: 200_000 }]
    },
    NOW
  )
  ali = customer({ name: 'Ali Raza', shopName: 'Ali Traders' })
  bilal = customer({ name: 'Bilal Ahmed', shopName: 'Bilal Store' })
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

const piece = (): number => tea.units.find((item) => item.name === 'Piece')!.id
const box = (): number => tea.units.find((item) => item.name === 'Box')!.id

function customer(overrides: Partial<CustomerCreateInput>): Customer {
  return createCustomer(
    db,
    {
      name: 'Customer',
      shopName: null,
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

/** `pieces` pieces of tea at retail. */
function teaLine(pieces: number, overrides: Partial<InvoiceLineInput> = {}): InvoiceLineInput {
  return {
    productId: tea.id,
    quantities: [
      { unitId: piece(), quantity: pieces, unitPriceMinor: 11_000, priceOverride: false }
    ],
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
  overrides: Partial<InvoiceCreateInput> = {}
): InvoiceSaveResult {
  return createInvoice(
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
      lines: [teaLine(1)],
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

/**
 * Five invoices, oldest first:
 * INV-000001 05-Sep Ali (1 piece), INV-000002 08-Sep Bilal (2), INV-000003 10-Sep Ali (3),
 * INV-000004 12-Sep walk-in (4, paid), INV-000005 14-Sep Bilal (5, Rs 200 received).
 */
function seedHistory(): InvoiceSaveResult[] {
  return [
    post('2026-09-05', ali.id, { lines: [teaLine(1)] }),
    post('2026-09-08', bilal.id, { lines: [teaLine(2)] }),
    post('2026-09-10', ali.id, { lines: [teaLine(3)] }),
    post('2026-09-12', walkInId, {
      lines: [teaLine(4)],
      receivedMinor: 44_000,
      paymentMethod: 'CASH'
    }),
    post('2026-09-14', bilal.id, {
      lines: [teaLine(5)],
      receivedMinor: 20_000,
      paymentMethod: 'BANK'
    })
  ]
}

function list(overrides: Partial<InvoiceListInput> = {}): ReturnType<typeof listInvoices> {
  return listInvoices(db, {
    page: 1,
    pageSize: 25,
    search: '',
    status: 'all',
    dateFrom: null,
    dateTo: null,
    ...overrides
  })
}

function numbers(overrides: Partial<InvoiceListInput> = {}): string[] {
  return list(overrides).items.map((item) => item.invoiceNo)
}

function dispatch(
  id: number,
  fields: { biltyNo?: string | null; transportName?: string | null; addaName?: string | null },
  note: string | null = null,
  now: Date = LATER
): ReturnType<typeof updateInvoiceDispatch> {
  const current = getInvoice(db, id)
  return updateInvoiceDispatch(
    db,
    {
      id,
      biltyNo: current.biltyNo,
      transportName: current.transportName,
      addaName: current.addaName,
      note,
      ...fields
    },
    now
  )
}

function changeLog(invoiceId: number): Array<Record<string, unknown>> {
  return db.all(
    'SELECT field, old_value, new_value, changed_at, note FROM invoice_change_log WHERE invoice_id = ? ORDER BY id',
    [invoiceId]
  )
}

function failure(fn: () => unknown): AppFailure['error'] {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

/** The detail without what a dispatch change may change. */
function financial(invoice: InvoiceDetail): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...invoice }
  for (const key of [
    'biltyNo',
    'transportName',
    'addaName',
    'dispatchUpdatedAt',
    'changes',
    'changedFields'
  ]) {
    delete rest[key]
  }
  return rest
}

// --- History list ------------------------------------------------------------------------------------------------------

describe('listInvoices', () => {
  it('lists newest first with the saved amounts, one page at a time', () => {
    const invoices = seedHistory()

    const first = list({ pageSize: 2 })
    expect(first).toMatchObject({ total: 5, page: 1, pageSize: 2 })
    expect(first.items).toEqual([
      {
        id: invoices[4].id,
        invoiceNo: 'INV-000005',
        invoiceDate: '2026-09-14',
        customerId: bilal.id,
        customerCode: 'C-00003',
        customerName: 'Bilal Ahmed',
        customerShopName: 'Bilal Store',
        totalMinor: 55_000,
        receivedMinor: 20_000,
        netOutstandingMinor: 22_000 + 55_000 - 20_000,
        status: 'POSTED'
      },
      expect.objectContaining({
        invoiceNo: 'INV-000004',
        customerCode: 'C-00001',
        netOutstandingMinor: 0
      })
    ])
    expect(numbers({ pageSize: 2, page: 2 })).toEqual(['INV-000003', 'INV-000002'])
    expect(list({ pageSize: 2, page: 3 })).toMatchObject({
      total: 5,
      items: [{ invoiceNo: 'INV-000001' }]
    })
    expect(list({ pageSize: 2, page: 4 })).toMatchObject({ total: 5, items: [] })
  })

  it('orders invoices of the same date by number, newest first', () => {
    post('2026-09-05', ali.id)
    post('2026-09-05', bilal.id)
    post('2026-09-05', ali.id)
    expect(numbers()).toEqual(['INV-000003', 'INV-000002', 'INV-000001'])
  })

  it('finds an invoice by its number, in any letter case and in part', () => {
    seedHistory()
    expect(numbers({ search: 'INV-000003' })).toEqual(['INV-000003'])
    expect(numbers({ search: 'inv-000003' })).toEqual(['INV-000003'])
    expect(numbers({ search: '000004' })).toEqual(['INV-000004'])
    expect(numbers({ search: 'INV-9' })).toEqual([])
  })

  it('finds invoices by customer code, saved name and saved shop; every word must match', () => {
    seedHistory()
    expect(numbers({ search: 'bilal' })).toEqual(['INV-000005', 'INV-000002'])
    expect(numbers({ search: 'Ali Traders' })).toEqual(['INV-000003', 'INV-000001'])
    expect(numbers({ search: 'store' })).toEqual(['INV-000005', 'INV-000002'])
    expect(numbers({ search: 'C-00001' })).toEqual(['INV-000004'])
    expect(numbers({ search: 'Ali INV-000003' })).toEqual(['INV-000003'])
    expect(numbers({ search: 'Ali Store' })).toEqual([])
    // LIKE wildcards are matched literally.
    expect(numbers({ search: '%' })).toEqual([])
    expect(numbers({ search: '_' })).toEqual([])
  })

  it('searches and shows the names saved on the invoice, not the current profile', () => {
    const [invoice] = seedHistory()
    updateCustomer(db, {
      id: ali.id,
      name: 'Ali Khan',
      shopName: 'Khan Traders',
      phone: null,
      address: null,
      city: null,
      notes: null
    })
    expect(numbers({ search: 'Raza' })).toEqual(['INV-000003', 'INV-000001'])
    expect(numbers({ search: 'Khan' })).toEqual([])
    // The code never changes, so it still finds every invoice of the customer.
    expect(numbers({ search: 'C-00002' })).toEqual(['INV-000003', 'INV-000001'])
    expect(list({ search: 'INV-000001' }).items[0]).toMatchObject({
      id: invoice.id,
      customerName: 'Ali Raza',
      customerShopName: 'Ali Traders'
    })
  })

  it('filters by an inclusive date range and by status', () => {
    const invoices = seedHistory()
    expect(numbers({ dateFrom: '2026-09-08', dateTo: '2026-09-12' })).toEqual([
      'INV-000004',
      'INV-000003',
      'INV-000002'
    ])
    expect(numbers({ dateFrom: '2026-09-13' })).toEqual(['INV-000005'])
    expect(numbers({ dateTo: '2026-09-05' })).toEqual(['INV-000001'])

    voidInvoice(db, { id: invoices[1].id, reason: 'Wrong customer', moneyReturned: false }, NOW)
    expect(numbers({ status: 'VOID' })).toEqual(['INV-000002'])
    expect(list({ status: 'VOID' }).items[0]).toMatchObject({ status: 'VOID', totalMinor: 22_000 })
    expect(numbers({ status: 'POSTED' })).toEqual([
      'INV-000005',
      'INV-000004',
      'INV-000003',
      'INV-000001'
    ])
    expect(numbers({ status: 'POSTED', search: 'bilal', dateTo: '2026-09-13' })).toEqual([])
    expect(list({ status: 'POSTED' }).total).toBe(4)
  })

  it('refuses an invalid page, page size or date range', () => {
    expect(failure(() => list({ dateFrom: '2026-09-10', dateTo: '2026-09-09' }))).toEqual({
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors: { dateTo: ['The end date cannot be before the start date.'] }
    })
    expect(failure(() => list({ pageSize: 101 })).fieldErrors).toHaveProperty('pageSize')
    expect(failure(() => list({ page: 0 })).fieldErrors).toHaveProperty('page')
    expect(failure(() => list({ status: 'DRAFT' as never })).fieldErrors).toHaveProperty('status')
  })
})

// --- Detail ------------------------------------------------------------------------------------------------------------

describe('getInvoice: the saved snapshots', () => {
  it('shows what was saved, whatever the customer, company, product, units and prices say now', () => {
    const invoice = post('2026-09-10', ali.id, {
      priceTier: 'RETAIL',
      invoiceCode: 'B-17',
      biltyNo: 'BL-1',
      transportName: 'Daewoo',
      addaName: 'Badami Bagh',
      checkedBy: 'Waqas',
      notes: 'Fragile',
      lines: [
        {
          productId: tea.id,
          quantities: [
            { unitId: box(), quantity: 2, unitPriceMinor: 240_000, priceOverride: false },
            { unitId: piece(), quantity: 5, unitPriceMinor: 9_000, priceOverride: true }
          ],
          freeQuantities: [{ unitId: piece(), quantity: 2 }],
          discount: { type: 'PERCENT', bps: 500 },
          schemeMinor: 1_000,
          ctnCount: 2
        }
      ],
      extraDiscountMinor: 500,
      freightMinor: 15_000,
      receivedMinor: 100_000,
      paymentMethod: 'CASH'
    })
    const saved = getInvoice(db, invoice.id)
    const listed = list().items[0]

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
    const current = tea.units
    updateProduct(db, {
      id: tea.id,
      code: 'P-900',
      name: 'Tapal Danedar',
      companyId: tapalId,
      packingLabel: '1*6*24',
      lowStockThresholdBase: 0,
      currencyMinorDigits: 2,
      units: current.map((item) => ({
        id: item.id,
        name: item.name === 'Box' ? 'Carton' : 'Pack',
        shortName: null,
        baseQty: item.baseQty,
        isBase: item.isBase,
        canSell: item.canSell,
        canPurchase: item.canPurchase,
        wholesalePriceMinor: 888_888,
        retailPriceMinor: 999_999,
        defaultCostMinor: null,
        isActive: item.isActive
      }))
    })

    const reread = getInvoice(db, invoice.id)
    expect(reread).toEqual(saved)
    expect(list().items[0]).toEqual(listed)
    expect(reread).toMatchObject({
      invoiceNo: 'INV-000001',
      invoiceDate: '2026-09-10',
      status: 'POSTED',
      customerCode: 'C-00002',
      customerName: 'Ali Raza',
      customerShopName: 'Ali Traders',
      customerPhone: '0300-1234567',
      customerCity: 'Lahore',
      invoiceCode: 'B-17',
      biltyNo: 'BL-1',
      transportName: 'Daewoo',
      addaName: 'Badami Bagh',
      checkedBy: 'Waqas',
      notes: 'Fragile',
      // 480,000 + 45,000 = 525,000 gross; 5% = 26,250; scheme 1,000; extra 500; freight 15,000.
      grossMinor: 525_000,
      lineDiscountMinor: 26_250,
      lineSchemeMinor: 1_000,
      extraDiscountMinor: 500,
      netMinor: 497_250,
      freightMinor: 15_000,
      totalMinor: 512_250,
      previousBalanceMinor: 0,
      receivedMinor: 100_000,
      netOutstandingMinor: 412_250,
      payment: { paymentNo: 'RCP-000001', amountMinor: 100_000, method: 'CASH', status: 'POSTED' },
      lines: [
        {
          productCode: 'P-001',
          productName: 'Tea 950g',
          companyName: 'Tapal',
          packingLabel: '1*12*18',
          qtyBase: 55,
          schemeQtyBase: 2,
          discountBps: 500,
          discountMinor: 26_250,
          schemeMinor: 1_000,
          ctnCount: 2,
          netMinor: 497_750,
          quantities: [
            {
              unitName: 'Box',
              unitBaseQty: 24,
              quantity: 2,
              unitPriceMinor: 240_000,
              amountMinor: 480_000
            },
            {
              unitName: 'Piece',
              unitShortName: 'Pcs',
              quantity: 5,
              unitPriceMinor: 9_000,
              amountMinor: 45_000
            }
          ]
        }
      ],
      changes: []
    })
  })

  it('shows the counter payment with its current status: voided on its own, it shows VOID', () => {
    const invoice = post('2026-09-10', ali.id, { receivedMinor: 5_000, paymentMethod: 'CHEQUE' })
    voidPayment(db, { id: invoice.payment!.id, reason: 'Cheque bounced' }, NOW)
    expect(getInvoice(db, invoice.id)).toMatchObject({
      status: 'POSTED',
      receivedMinor: 5_000,
      payment: { paymentNo: 'RCP-000001', amountMinor: 5_000, method: 'CHEQUE', status: 'VOID' }
    })
  })

  it('refuses a missing invoice', () => {
    expect(failure(() => getInvoice(db, 99))).toEqual({
      code: 'NOT_FOUND',
      message: 'This invoice no longer exists.'
    })
  })
})

// --- Dispatch details ---------------------------------------------------------------------------------------------------

describe('updateInvoiceDispatch', () => {
  it('changes the Bilty No and logs the old and new value, the time and the note', () => {
    const invoice = post('2026-09-10', ali.id, { biltyNo: 'BL-1' })
    const before = getInvoice(db, invoice.id)

    const updated = dispatch(invoice.id, { biltyNo: ' BL-2 ' }, ' Bilty reissued ')

    expect(updated).toMatchObject({
      biltyNo: 'BL-2',
      dispatchUpdatedAt: LATER.toISOString(),
      changedFields: ['bilty_no'],
      changes: [
        {
          field: 'bilty_no',
          oldValue: 'BL-1',
          newValue: 'BL-2',
          changedAt: LATER.toISOString(),
          note: 'Bilty reissued'
        }
      ]
    })
    expect(changeLog(invoice.id)).toEqual([
      {
        field: 'bilty_no',
        old_value: 'BL-1',
        new_value: 'BL-2',
        changed_at: LATER.toISOString(),
        note: 'Bilty reissued'
      }
    ])
    expect(financial(getInvoice(db, invoice.id))).toEqual(financial(before))
  })

  it('changes the Transport, and then the Adda, each change logged in order', () => {
    const invoice = post('2026-09-10', ali.id)
    dispatch(invoice.id, { transportName: 'Daewoo Cargo' }, null, NOW)
    const updated = dispatch(invoice.id, { addaName: 'Badami Bagh' }, 'Moved to Badami Bagh')

    expect(updated).toMatchObject({
      transportName: 'Daewoo Cargo',
      addaName: 'Badami Bagh',
      dispatchUpdatedAt: LATER.toISOString(),
      changedFields: ['adda_name']
    })
    expect(changeLog(invoice.id)).toEqual([
      {
        field: 'transport_name',
        old_value: null,
        new_value: 'Daewoo Cargo',
        changed_at: NOW.toISOString(),
        note: null
      },
      {
        field: 'adda_name',
        old_value: null,
        new_value: 'Badami Bagh',
        changed_at: LATER.toISOString(),
        note: 'Moved to Badami Bagh'
      }
    ])
  })

  it('logs one row per changed field in one save, including a cleared field', () => {
    const invoice = post('2026-09-10', ali.id, {
      biltyNo: 'BL-1',
      transportName: 'Daewoo',
      addaName: 'Adda 1'
    })
    const updated = dispatch(invoice.id, { biltyNo: '', transportName: 'TCS', addaName: 'Adda 1' })
    expect(updated.changedFields).toEqual(['bilty_no', 'transport_name'])
    expect(updated).toMatchObject({ biltyNo: null, transportName: 'TCS', addaName: 'Adda 1' })
    expect(changeLog(invoice.id).map((row) => [row.field, row.old_value, row.new_value])).toEqual([
      ['bilty_no', 'BL-1', null],
      ['transport_name', 'Daewoo', 'TCS']
    ])
  })

  it('writes nothing when the details are already as sent', () => {
    const invoice = post('2026-09-10', ali.id, { biltyNo: 'BL-1' })
    const updated = dispatch(invoice.id, { biltyNo: '  BL-1 ' }, 'No real change')
    expect(updated).toMatchObject({ changedFields: [], dispatchUpdatedAt: null, changes: [] })
    expect(changeLog(invoice.id)).toEqual([])
  })

  it('accepts only the dispatch details: customer, date, items, amounts, received and cost are refused', () => {
    const invoice = post('2026-09-10', ali.id, { receivedMinor: 1_000, paymentMethod: 'CASH' })
    const before = getInvoice(db, invoice.id)
    const base = {
      id: invoice.id,
      biltyNo: 'BL-9',
      transportName: null,
      addaName: null,
      note: null
    }
    for (const extra of [
      { customerId: bilal.id },
      { invoiceDate: '2026-09-11' },
      { lines: [] },
      { unitPriceMinor: 1 },
      { discountMinor: 0 },
      { totalMinor: 1 },
      { receivedMinor: 0 },
      { cogsMinor: 0 },
      { notes: 'x' }
    ]) {
      expect(failure(() => updateInvoiceDispatch(db, { ...base, ...extra }, LATER)).code).toBe(
        'VALIDATION'
      )
    }
    expect(getInvoice(db, invoice.id)).toEqual(before)
    expect(changeLog(invoice.id)).toEqual([])
  })

  it('the database itself refuses changes to saved financial columns, and the change log is append-only', () => {
    const invoice = post('2026-09-10', ali.id)
    dispatch(invoice.id, { biltyNo: 'BL-1' })
    for (const sql of [
      'UPDATE invoices SET total_minor = total_minor + 1',
      'UPDATE invoices SET customer_id = ?',
      "UPDATE invoices SET invoice_date = '2026-09-11'",
      'UPDATE invoices SET received_minor = received_minor + 1, net_outstanding_minor = net_outstanding_minor - 1',
      'UPDATE invoices SET cogs_minor = 0',
      'UPDATE invoice_items SET net_minor = 0',
      'UPDATE invoice_item_quantities SET unit_price_minor = 0',
      "UPDATE invoice_change_log SET new_value = 'BL-X'",
      'DELETE FROM invoice_change_log'
    ]) {
      const params = sql.includes('?') ? [bilal.id] : []
      expect(() => db.transaction(() => db.run(sql, params)), sql).toThrow()
    }
    expect(changeLog(invoice.id)).toHaveLength(1)
    expect(getInvoice(db, invoice.id)).toMatchObject({ totalMinor: 11_000, customerId: ali.id })
  })

  it('refuses a void invoice, a missing invoice and invalid text', () => {
    const invoice = post('2026-09-10', ali.id)
    voidInvoice(db, { id: invoice.id, reason: 'Duplicate', moneyReturned: false }, NOW)
    expect(failure(() => dispatch(invoice.id, { biltyNo: 'BL-1' }))).toEqual({
      code: 'FORBIDDEN_STATE',
      message: 'Invoice INV-000001 is void, so its dispatch details can no longer be changed.'
    })
    expect(
      failure(() =>
        updateInvoiceDispatch(
          db,
          { id: 99, biltyNo: null, transportName: null, addaName: null, note: null },
          LATER
        )
      ).code
    ).toBe('NOT_FOUND')

    const posted = post('2026-09-16', ali.id)
    expect(failure(() => dispatch(posted.id, { biltyNo: 'B'.repeat(41) })).fieldErrors).toEqual({
      biltyNo: ['Use at most 40 characters.']
    })
    expect(failure(() => dispatch(posted.id, { addaName: 'Line\nbreak' })).fieldErrors).toEqual({
      addaName: ['Use a single line of text.']
    })
    expect(changeLog(posted.id)).toEqual([])
  })
})
