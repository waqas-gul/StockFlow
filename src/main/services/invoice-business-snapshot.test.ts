import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Customer } from '@shared/customers'
import type {
  InvoiceBusinessDetails,
  InvoiceCreateInput,
  InvoiceLineInput,
  InvoiceSaveResult
} from '@shared/invoices'
import type { Product } from '@shared/products'
import type { Db } from '../db/adapter'
import { initializeDatabase } from '../db/index'
import { migrations } from '../db/migrations'
import {
  createSchemaDatabase,
  createTempDir,
  insertDocuments,
  insertMasters,
  testContext,
  thrown,
  type TempDir
} from '../db/test-utils'
import { AppFailure } from '../errors'
import { createCustomer } from './customers.service'
import { voidInvoice } from './invoice-void.service'
import { readPrintableInvoice } from './invoice-print.service'
import { createInvoice, getInvoice, listInvoices, updateInvoiceDispatch } from './invoices.service'
import { createProduct } from './products.service'
import { readSettings, updateSettings } from './settings.service'
import { receiveStock } from './stock.service'

// Test data lives only in temporary databases. The shop and salesman of a new database are the 0004 defaults.

const NOW = new Date(2026, 8, 16, 10, 30, 0)
const LATER = new Date(2026, 8, 17, 9, 0, 0)

const DEFAULT_BUSINESS: InvoiceBusinessDetails = {
  shopName: 'Iftikhar and Arshad Traders',
  shopAddress: null,
  salesmanName: 'Mansoor Iqbal',
  salesmanPhone1: '03179927633',
  salesmanPhone2: '03463820629'
}

let temp: TempDir
/** Other temporary folders a test made (removed after it). */
let others: TempDir[] = []
let db: Db
let requests: number
/** Kg (base, retail Rs 160), 100 Kg in stock. */
let sugar: Product
let ali: Customer

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  requests = 0
  sugar = createProduct(db, {
    code: 'P-002',
    name: 'Sugar',
    companyId: null,
    packingLabel: null,
    lowStockThresholdBase: 0,
    currencyMinorDigits: 2,
    units: [
      {
        id: null,
        name: 'Kg',
        shortName: null,
        baseQty: 1,
        isBase: true,
        canSell: true,
        canPurchase: true,
        wholesalePriceMinor: null,
        retailPriceMinor: 16_000,
        defaultCostMinor: null,
        isActive: true
      }
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
      lines: [{ productId: sugar.id, unitId: kg(), quantity: 100, unitCostMinor: 12_000 }]
    },
    NOW
  )
  ali = createCustomer(
    db,
    {
      name: 'Ali Raza',
      shopName: 'Ali Traders',
      phone: '0300-1234567',
      address: 'Main Bazar',
      city: 'Lahore',
      notes: null,
      opening: null,
      currencyMinorDigits: 2
    },
    NOW
  )
})

afterEach(() => {
  for (const other of others) other.remove()
  others = []
  temp.remove()
})

function kg(): number {
  return sugar.units[0].id
}

function nextRequestId(): string {
  requests++
  return `request-${String(requests).padStart(4, '0')}`
}

function sugarLine(quantity: number): InvoiceLineInput {
  return {
    productId: sugar.id,
    quantities: [{ unitId: kg(), quantity, unitPriceMinor: 16_000, priceOverride: false }],
    freeQuantities: [],
    discount: null,
    schemeMinor: 0,
    ctnCount: null
  }
}

function invoiceInput(overrides: Partial<InvoiceCreateInput> = {}): InvoiceCreateInput {
  return {
    requestId: nextRequestId(),
    invoiceDate: '2026-09-12',
    customerId: ali.id,
    priceTier: 'RETAIL',
    invoiceCode: null,
    biltyNo: null,
    transportName: null,
    addaName: null,
    checkedBy: null,
    notes: null,
    lines: [sugarLine(1)],
    extraDiscountMinor: 0,
    freightMinor: 0,
    receivedMinor: 0,
    paymentMethod: null,
    paymentReference: null,
    currencyMinorDigits: 2,
    ...overrides
  }
}

function post(overrides: Partial<InvoiceCreateInput> = {}): InvoiceSaveResult {
  return createInvoice(db, invoiceInput(overrides), NOW)
}

/** The five snapshot columns exactly as stored. */
function storedSnapshot(id: number): Record<string, string | null> {
  return db.get(
    `SELECT shop_name_snapshot, shop_address_snapshot, salesman_name_snapshot, salesman_phone1_snapshot,
            salesman_phone2_snapshot
     FROM invoices WHERE id = ?`,
    [id]
  )!
}

/** A new shop name, address and salesman, with the second phone left empty. */
const CHANGED_SETTINGS = {
  'business.name': 'Iftikhar & Arshad Traders (Main Branch)',
  'business.address': 'Shop 12, Main Bazar, Mingora',
  'salesman.name': 'Imran Khan',
  'salesman.phone1': '0300-1112223',
  'salesman.phone2': ''
}

const CHANGED_BUSINESS: InvoiceBusinessDetails = {
  shopName: 'Iftikhar & Arshad Traders (Main Branch)',
  shopAddress: 'Shop 12, Main Bazar, Mingora',
  salesmanName: 'Imran Khan',
  salesmanPhone1: '0300-1112223',
  salesmanPhone2: null
}

describe('posting an invoice keeps the shop and salesman of Settings', () => {
  it('saves the shop name, address, salesman and both phones with the invoice', () => {
    updateSettings(db, { 'business.address': 'Shop 4, Saddar Road' })
    const saved = post()
    const business = { ...DEFAULT_BUSINESS, shopAddress: 'Shop 4, Saddar Road' }
    expect(saved.business).toEqual(business)
    expect(getInvoice(db, saved.id).business).toEqual(business)
    expect(storedSnapshot(saved.id)).toEqual({
      shop_name_snapshot: 'Iftikhar and Arshad Traders',
      shop_address_snapshot: 'Shop 4, Saddar Road',
      salesman_name_snapshot: 'Mansoor Iqbal',
      salesman_phone1_snapshot: '03179927633',
      salesman_phone2_snapshot: '03463820629'
    })
  })

  it('saves an empty address or phone as NULL', () => {
    updateSettings(db, { 'salesman.phone1': '', 'salesman.phone2': '' })
    const saved = post()
    expect(saved.business).toEqual({
      ...DEFAULT_BUSINESS,
      salesmanPhone1: null,
      salesmanPhone2: null
    })
    expect(storedSnapshot(saved.id)).toMatchObject({
      shop_address_snapshot: null,
      salesman_phone1_snapshot: null,
      salesman_phone2_snapshot: null
    })
  })

  it('never changes a posted invoice when Settings change later; the next invoice gets the new values', () => {
    const first = post()
    const printedBefore = readPrintableInvoice(db, first.id)
    updateSettings(db, CHANGED_SETTINGS)

    expect(getInvoice(db, first.id).business).toEqual(DEFAULT_BUSINESS)
    expect(storedSnapshot(first.id)).toMatchObject({
      shop_name_snapshot: 'Iftikhar and Arshad Traders',
      shop_address_snapshot: null
    })
    expect(readPrintableInvoice(db, first.id)).toEqual(printedBefore)

    const second = post()
    expect(second.business).toEqual(CHANGED_BUSINESS)
    expect(getInvoice(db, second.id).business).toEqual(CHANGED_BUSINESS)
    expect(getInvoice(db, first.id).business).toEqual(DEFAULT_BUSINESS)
  })

  it('a retried request returns the saved invoice with the snapshot it was posted with', () => {
    const input = invoiceInput()
    const saved = createInvoice(db, input, NOW)
    updateSettings(db, CHANGED_SETTINGS)
    const replayed = createInvoice(db, input, NOW)
    expect(replayed).toMatchObject({ id: saved.id, replayed: true, business: DEFAULT_BUSINESS })
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM invoices')!.n).toBe(1)
  })

  it('keeps the snapshot when the invoice is voided or its dispatch details change', () => {
    const saved = post()
    updateSettings(db, CHANGED_SETTINGS)
    updateInvoiceDispatch(
      db,
      { id: saved.id, biltyNo: 'BL-1', transportName: null, addaName: null, note: null },
      LATER
    )
    const voided = voidInvoice(
      db,
      { id: saved.id, reason: 'Wrong customer', moneyReturned: false },
      LATER
    )
    expect(voided.business).toEqual(DEFAULT_BUSINESS)
    expect(getInvoice(db, saved.id)).toMatchObject({ status: 'VOID', business: DEFAULT_BUSINESS })
  })

  it('stays atomic: a failure after the header is written saves no invoice, snapshot or number', () => {
    db.exec(`CREATE TRIGGER fixture_fail_ledger BEFORE INSERT ON customer_ledger
      BEGIN SELECT RAISE(ABORT, 'simulated ledger failure'); END`)
    const stockBefore = db.all('SELECT * FROM stock_movements ORDER BY id')
    expect(() => post()).toThrow(/simulated ledger failure/)
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM invoices')!.n).toBe(0)
    expect(db.all('SELECT * FROM stock_movements ORDER BY id')).toEqual(stockBefore)
    expect(db.get("SELECT next_value FROM sequences WHERE name = 'invoice'")).toEqual({
      next_value: 1
    })
    expect(db.inTransaction).toBe(false)

    db.exec('DROP TRIGGER fixture_fail_ledger')
    const saved = post()
    expect(saved).toMatchObject({ invoiceNo: 'INV-000001', business: DEFAULT_BUSINESS })
  })

  it('reads the Settings inside the posting transaction: the values saved are the ones in Settings at that moment', () => {
    updateSettings(db, { 'salesman.name': 'Imran Khan' })
    expect(post().business?.salesmanName).toBe('Imran Khan')
    updateSettings(db, { 'salesman.name': 'Mansoor Iqbal' })
    expect(post().business?.salesmanName).toBe('Mansoor Iqbal')
  })
})

describe('the printed invoice uses the saved snapshot', () => {
  it('prints the saved shop name, address and salesman, not the current Settings', () => {
    updateSettings(db, { 'business.address': 'Shop 4, Saddar Road' })
    const saved = post()
    updateSettings(db, { ...CHANGED_SETTINGS, 'invoice.paperSize': 'A5' })
    expect(readPrintableInvoice(db, saved.id)).toMatchObject({
      businessName: 'Iftikhar and Arshad Traders',
      businessAddress: 'Shop 4, Saddar Road',
      salesman: { name: 'Mansoor Iqbal', phone1: '03179927633', phone2: '03463820629' },
      // The paper size is presentation only: it follows Settings.
      paperSize: 'A5'
    })
    expect(readPrintableInvoice(db, post().id)).toMatchObject({
      businessName: 'Iftikhar & Arshad Traders (Main Branch)',
      businessAddress: 'Shop 12, Main Bazar, Mingora',
      salesman: { name: 'Imran Khan', phone1: '0300-1112223', phone2: null }
    })
  })

  it('leaves the address out when none was saved', () => {
    const saved = post()
    expect(readPrintableInvoice(db, saved.id)).toMatchObject({
      businessName: 'Iftikhar and Arshad Traders',
      businessAddress: null
    })
  })
})

describe('an invoice saved before the shop and salesman were kept (schema 3)', () => {
  /** A schema 3 database with one invoice, upgraded to the current schema; returns the invoice id. */
  async function legacyInvoice(): Promise<{ legacy: Db; invoiceId: number }> {
    const other = createTempDir()
    others.push(other)
    const old = await initializeDatabase(testContext(other, { migrations: migrations.slice(0, 3) }))
    let invoiceId: number
    try {
      invoiceId = insertDocuments(old, insertMasters(old)).invoiceId
    } finally {
      old.close()
    }
    const legacy = other.track(await initializeDatabase(testContext(other)))
    return { legacy, invoiceId }
  }

  it('opens with no shop or salesman: nothing is invented', async () => {
    const { legacy, invoiceId } = await legacyInvoice()
    const invoice = getInvoice(legacy, invoiceId)
    expect(invoice).toMatchObject({ invoiceNo: 'INV-000001', customerName: 'Ali', business: null })
    expect(
      listInvoices(legacy, {
        page: 1,
        pageSize: 10,
        search: '',
        status: 'all',
        dateFrom: null,
        dateTo: null
      }).items
    ).toHaveLength(1)
  })

  it('prints as before: the current shop name at the top, and no address or salesman', async () => {
    const { legacy, invoiceId } = await legacyInvoice()
    updateSettings(legacy, { 'business.name': 'Madina Traders', 'business.address': 'Shop 9' })
    expect(readPrintableInvoice(legacy, invoiceId)).toMatchObject({
      invoiceNo: 'INV-000001',
      businessName: 'Madina Traders',
      businessAddress: null,
      salesman: null
    })
    expect(readSettings(legacy)['salesman.name']).toBe('Mansoor Iqbal')
  })

  it('still takes a dispatch change, and is never given a snapshot by it', async () => {
    const { legacy, invoiceId } = await legacyInvoice()
    const updated = updateInvoiceDispatch(
      legacy,
      { id: invoiceId, biltyNo: 'BL-9', transportName: null, addaName: null, note: 'Sent' },
      LATER
    )
    expect(updated).toMatchObject({ biltyNo: 'BL-9', business: null })
  })
})

describe('the snapshot at the database level', () => {
  it('refuses to change a saved snapshot', () => {
    const saved = post()
    const error = thrown(() =>
      db.run("UPDATE invoices SET salesman_name_snapshot = 'Other' WHERE id = ?", [saved.id])
    )
    expect(error).not.toBeInstanceOf(AppFailure)
    expect(String(error)).toMatch(/A saved invoice cannot be changed/)
  })
})
