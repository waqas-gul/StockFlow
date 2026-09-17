import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Customer, CustomerCreateInput } from '@shared/customers'
import type { InvoiceCreateInput, InvoiceLineInput, InvoiceSaveResult } from '@shared/invoices'
import type { PrintableInvoice } from '@shared/invoice-print'
import type { Product, ProductUnitInput } from '@shared/products'
import type { Db } from '../db/adapter'
import { createMemoryLogger, createSchemaDatabase, createTempDir, thrown } from '../db/test-utils'
import type { MemoryLogger, TempDir } from '../db/test-utils'
import { AppFailure } from '../errors'
import { createCompany, updateCompany } from './companies.service'
import { createCustomer, updateCustomer } from './customers.service'
import { voidInvoice } from './invoice-void.service'
import { InvoicePrintService, readPrintableInvoice, type PdfDialogs } from './invoice-print.service'
import { createInvoice, updateInvoiceDispatch } from './invoices.service'
import { LiveDatabase } from './live-database'
import { createProduct, updateProduct } from './products.service'
import { updateSettings } from './settings.service'
import { receiveStock } from './stock.service'
import { fakePrintTarget, type FakePrintTarget } from './test-utils'

// Test data lives only in temporary databases and folders.

const NOW = new Date(2026, 8, 16, 10, 30, 0)
const LATER = new Date(2026, 8, 17, 9, 0, 0)

let temp: TempDir
let db: Db
let requests: number
let companyId: number
/** Piece (base, short name Pc, retail 110) and Box of 24 (retail 2,400). */
let tea: Product
/** Kg (base, retail 160). */
let sugar: Product
/** C-00002 Ali Raza, Ali Traders, owes Rs 1,000.00. */
let ali: Customer
let walkInId: number

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  requests = 0
  companyId = createCompany(db, { name: 'Tapal' }).id
  tea = createProduct(db, {
    code: 'P-001',
    name: 'Tea 950g',
    companyId,
    packingLabel: '1*12*18',
    lowStockThresholdBase: 0,
    currencyMinorDigits: 2,
    units: [
      unit({ name: 'Piece', shortName: 'Pc', retailPriceMinor: 11_000 }),
      unit({ name: 'Box', baseQty: 24, isBase: false, retailPriceMinor: 240_000 })
    ]
  })
  sugar = createProduct(db, {
    code: 'P-002',
    name: 'Sugar',
    companyId: null,
    packingLabel: null,
    lowStockThresholdBase: 0,
    currencyMinorDigits: 2,
    units: [unit({ name: 'Kg', retailPriceMinor: 16_000 })]
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
      lines: [
        { productId: tea.id, unitId: unitId(tea, 'Box'), quantity: 20, unitCostMinor: 200_000 },
        { productId: sugar.id, unitId: unitId(sugar, 'Kg'), quantity: 100, unitCostMinor: 12_000 }
      ]
    },
    NOW
  )
  ali = customer({
    name: 'Ali Raza',
    shopName: 'Ali Traders',
    opening: { side: 'DUE', amountMinor: 100_000, date: '2026-09-01' }
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

function unitId(product: Product, name: string): number {
  return product.units.find((item) => item.name === name)!.id
}

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

function post(overrides: Partial<InvoiceCreateInput> = {}): InvoiceSaveResult {
  return createInvoice(
    db,
    {
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
    },
    NOW
  )
}

function sugarLine(kg: number, overrides: Partial<InvoiceLineInput> = {}): InvoiceLineInput {
  return {
    productId: sugar.id,
    quantities: [
      { unitId: unitId(sugar, 'Kg'), quantity: kg, unitPriceMinor: 16_000, priceOverride: false }
    ],
    freeQuantities: [],
    discount: null,
    schemeMinor: 0,
    ctnCount: null,
    ...overrides
  }
}

/**
 * INV-000001 for Ali: 2 Box + 5 Piece of tea (5% discount, Rs 100 scheme, 3 Piece free, 2 Ctn), 10 Kg of sugar (Rs 50
 * off), Rs 32.50 extra discount, Rs 200 freight and Rs 2,000 received, with every optional field filled in.
 */
function postFullInvoice(): InvoiceSaveResult {
  return post({
    invoiceCode: 'IC-7',
    biltyNo: 'BL-1',
    transportName: 'Daewoo Cargo',
    addaName: 'Badami Bagh',
    checkedBy: 'Hamid',
    notes: 'Paper bill 42',
    lines: [
      {
        productId: tea.id,
        quantities: [
          {
            unitId: unitId(tea, 'Box'),
            quantity: 2,
            unitPriceMinor: 240_000,
            priceOverride: false
          },
          {
            unitId: unitId(tea, 'Piece'),
            quantity: 5,
            unitPriceMinor: 11_000,
            priceOverride: false
          }
        ],
        freeQuantities: [{ unitId: unitId(tea, 'Piece'), quantity: 3 }],
        discount: { type: 'PERCENT', bps: 500 },
        schemeMinor: 10_000,
        ctnCount: 2
      },
      sugarLine(10, { discount: { type: 'AMOUNT', amountMinor: 5_000 } })
    ],
    extraDiscountMinor: 3_250,
    freightMinor: 20_000,
    receivedMinor: 200_000,
    paymentMethod: 'BANK'
  })
}

function failure(fn: () => unknown): AppFailure['error'] {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

async function rejection(promise: Promise<unknown>): Promise<AppFailure['error']> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

/** Rows written by this connection so far. */
function writes(): number {
  return db.get<{ n: number }>('SELECT total_changes() AS n')!.n
}

// --- The printable invoice -------------------------------------------------------------------------------------------

describe('readPrintableInvoice', () => {
  it('builds the printed invoice from the saved snapshots and stored totals', () => {
    const invoice = postFullInvoice()
    expect(readPrintableInvoice(db, invoice.id)).toEqual({
      id: invoice.id,
      invoiceNo: 'INV-000001',
      invoiceCode: 'IC-7',
      invoiceDate: '2026-09-12',
      status: 'POSTED',
      voidDate: null,
      voidReason: null,
      businessName: 'StockFlow',
      currency: { code: 'PKR', symbol: 'Rs', minorDigits: 2 },
      paperSize: 'A4',
      customer: {
        name: 'Ali Raza',
        shopName: 'Ali Traders',
        phone: '0300-1234567',
        address: 'Main Bazar',
        city: 'Lahore'
      },
      dispatch: { biltyNo: 'BL-1', transportName: 'Daewoo Cargo', addaName: 'Badami Bagh' },
      checkedBy: 'Hamid',
      lines: [
        {
          lineNo: 1,
          productName: 'Tea 950g',
          packingLabel: '1*12*18',
          quantities: [
            {
              unitName: 'Box',
              unitShortName: null,
              unitBaseQty: 24,
              quantity: 2,
              unitPriceMinor: 240_000,
              amountMinor: 480_000
            },
            {
              unitName: 'Piece',
              unitShortName: 'Pc',
              unitBaseQty: 1,
              quantity: 5,
              unitPriceMinor: 11_000,
              amountMinor: 55_000
            }
          ],
          schemeQtyBase: 3,
          grossMinor: 535_000,
          discountBps: 500,
          discountMinor: 26_750,
          schemeMinor: 10_000,
          ctnCount: 2,
          netMinor: 498_250
        },
        {
          lineNo: 2,
          productName: 'Sugar',
          packingLabel: null,
          quantities: [
            {
              unitName: 'Kg',
              unitShortName: null,
              unitBaseQty: 1,
              quantity: 10,
              unitPriceMinor: 16_000,
              amountMinor: 160_000
            }
          ],
          schemeQtyBase: 0,
          grossMinor: 160_000,
          discountBps: null,
          discountMinor: 5_000,
          schemeMinor: 0,
          ctnCount: null,
          netMinor: 155_000
        }
      ],
      totals: {
        grossMinor: 695_000,
        lineDiscountMinor: 31_750,
        lineSchemeMinor: 10_000,
        extraDiscountMinor: 3_250,
        netMinor: 650_000,
        freightMinor: 20_000,
        totalMinor: 670_000,
        previousBalanceMinor: 100_000,
        receivedMinor: 200_000,
        netOutstandingMinor: 570_000
      },
      amountInWords: 'Rupees Six Thousand Seven Hundred Only',
      pdfFileName: 'INV-000001.pdf'
    } satisfies PrintableInvoice)
  })

  it('prints the same invoice after the customer, company, product, units and prices change', () => {
    const invoice = postFullInvoice()
    const printed = readPrintableInvoice(db, invoice.id)

    updateCustomer(db, {
      id: ali.id,
      name: 'Ali Raza Khan',
      shopName: 'Khan Traders',
      phone: '0321-0000000',
      address: 'Anarkali',
      city: 'Karachi',
      notes: null
    })
    updateCompany(db, { id: companyId, name: 'Tapal Tea' })
    updateProduct(db, {
      id: tea.id,
      code: 'P-900',
      name: 'Tapal Danedar',
      companyId,
      packingLabel: '1*6*24',
      lowStockThresholdBase: 0,
      currencyMinorDigits: 2,
      units: tea.units.map((item) => ({
        id: item.id,
        name: item.name === 'Box' ? 'Carton' : 'Pack',
        shortName: item.name === 'Box' ? 'Ctn' : 'Pk',
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

    expect(readPrintableInvoice(db, invoice.id)).toEqual(printed)
  })

  it('shows the dispatch details as they are now, and nothing else changes', () => {
    const invoice = postFullInvoice()
    const printed = readPrintableInvoice(db, invoice.id)
    updateInvoiceDispatch(
      db,
      {
        id: invoice.id,
        biltyNo: 'BL-2',
        transportName: null,
        addaName: 'Lari Adda',
        note: 'Sent by another transport'
      },
      LATER
    )
    expect(readPrintableInvoice(db, invoice.id)).toEqual({
      ...printed,
      dispatch: { biltyNo: 'BL-2', transportName: null, addaName: 'Lari Adda' }
    })
  })

  it('uses the current business name, currency symbol and paper size for presentation only', () => {
    const invoice = postFullInvoice()
    const printed = readPrintableInvoice(db, invoice.id)
    updateSettings(db, {
      'business.name': 'Madina Traders',
      'currency.symbol': 'PKR',
      'invoice.paperSize': 'A5'
    })
    expect(readPrintableInvoice(db, invoice.id)).toEqual({
      ...printed,
      businessName: 'Madina Traders',
      currency: { code: 'PKR', symbol: 'PKR', minorDigits: 2 },
      paperSize: 'A5'
    })
  })

  it('marks a void invoice and keeps its saved amounts, including Received after its payment was voided', () => {
    const invoice = post({
      customerId: walkInId,
      lines: [sugarLine(2)],
      receivedMinor: 32_000,
      paymentMethod: 'CASH'
    })
    const printed = readPrintableInvoice(db, invoice.id)
    voidInvoice(
      db,
      { id: invoice.id, reason: 'Customer returned the goods', moneyReturned: true },
      LATER
    )

    expect(readPrintableInvoice(db, invoice.id)).toEqual({
      ...printed,
      status: 'VOID',
      voidDate: '2026-09-17',
      voidReason: 'Customer returned the goods'
    })
    expect(printed.totals).toMatchObject({
      totalMinor: 32_000,
      previousBalanceMinor: 0,
      receivedMinor: 32_000,
      netOutstandingMinor: 0
    })
    expect(printed.customer.name).toBe('Cash / Walk-in')
  })

  it('leaves empty optional fields empty and writes a zero total in words', () => {
    const plain = customer({ name: 'Bilal', phone: null, address: null, city: null })
    const invoice = post({
      customerId: plain.id,
      lines: [
        sugarLine(1, {
          quantities: [
            { unitId: unitId(sugar, 'Kg'), quantity: 1, unitPriceMinor: 0, priceOverride: true }
          ]
        })
      ]
    })
    const printed = readPrintableInvoice(db, invoice.id)
    expect(printed).toMatchObject({
      invoiceCode: null,
      customer: { name: 'Bilal', shopName: null, phone: null, address: null, city: null },
      dispatch: { biltyNo: null, transportName: null, addaName: null },
      checkedBy: null,
      totals: {
        grossMinor: 0,
        lineDiscountMinor: 0,
        lineSchemeMinor: 0,
        extraDiscountMinor: 0,
        netMinor: 0,
        freightMinor: 0,
        totalMinor: 0,
        previousBalanceMinor: 0,
        receivedMinor: 0,
        netOutstandingMinor: 0
      },
      amountInWords: 'Rupees Zero Only'
    })
    expect(printed.lines[0]).toMatchObject({
      packingLabel: null,
      discountBps: null,
      discountMinor: 0,
      schemeMinor: 0,
      schemeQtyBase: 0,
      ctnCount: null
    })
  })

  it('refuses a missing invoice or an invalid id, and never writes', () => {
    postFullInvoice()
    const before = writes()
    expect(failure(() => readPrintableInvoice(db, 999))).toMatchObject({
      code: 'NOT_FOUND',
      message: 'This invoice no longer exists.'
    })
    expect(failure(() => readPrintableInvoice(db, '1'))).toMatchObject({ code: 'VALIDATION' })
    readPrintableInvoice(db, 1)
    expect(writes()).toBe(before)
  })
})

// --- Printing and PDF ------------------------------------------------------------------------------------------------

describe('InvoicePrintService', () => {
  let target: FakePrintTarget
  let dialogs: PdfDialogs & { requests: string[]; answers: Array<string | null> }
  let log: MemoryLogger
  let service: InvoicePrintService
  let documentsDir: string
  let invoice: InvoiceSaveResult

  beforeEach(() => {
    invoice = postFullInvoice()
    target = fakePrintTarget()
    target.shown = {
      route: `/invoices/${invoice.id}/print`,
      invoiceNo: 'INV-000001',
      paperSize: 'A4'
    }
    dialogs = {
      requests: [],
      answers: [],
      choosePdfFile: async (defaultPath) => {
        dialogs.requests.push(defaultPath)
        return dialogs.answers.shift() ?? null
      }
    }
    log = createMemoryLogger()
    documentsDir = temp.file('Documents')
    mkdirSync(documentsDir, { recursive: true })
    service = new InvoicePrintService({
      database: new LiveDatabase(db),
      log,
      target: () => (target.available ? target : null),
      dialogs,
      documentsDir,
      appDataPath: 'C:\\Elsewhere\\AppData\\Roaming',
      homePath: 'C:\\Elsewhere'
    })
  })

  it('prints the open print preview through the system print dialog, on the chosen paper', async () => {
    const before = writes()
    await expect(service.print({ id: invoice.id, paperSize: 'A4' })).resolves.toEqual({
      status: 'SENT'
    })
    target.shown = { ...target.shown, paperSize: 'A5' }
    target.printOutcome = 'CANCELLED'
    await expect(service.print({ id: invoice.id, paperSize: 'A5' })).resolves.toEqual({
      status: 'CANCELLED'
    })
    expect(target.printed).toEqual(['A4', 'A5'])
    expect(writes()).toBe(before)
    expect(log.entries).toContainEqual({
      level: 'INFO',
      message: '[print] invoice sent to the printer',
      context: { invoiceNo: 'INV-000001', paperSize: 'A4' }
    })
  })

  it('prints only the print preview of that invoice on that paper', async () => {
    const refused = {
      code: 'FORBIDDEN_STATE',
      message: 'Open the print preview of INV-000001 to print it or save it as a PDF.'
    }
    target.shown = { route: '/invoices/1', invoiceNo: null, paperSize: null }
    expect(await rejection(service.print({ id: invoice.id, paperSize: 'A4' }))).toEqual(refused)

    // Another screen, even one that marks the same invoice and paper, is not the print preview.
    target.shown = { route: `/invoices/${invoice.id}`, invoiceNo: 'INV-000001', paperSize: 'A4' }
    expect(await rejection(service.print({ id: invoice.id, paperSize: 'A4' }))).toEqual(refused)

    target.shown = { route: `/invoices/${invoice.id}/print`, invoiceNo: null, paperSize: null }
    expect(await rejection(service.print({ id: invoice.id, paperSize: 'A4' }))).toEqual(refused)

    target.shown = {
      route: `/invoices/${invoice.id}/print`,
      invoiceNo: 'INV-000001',
      paperSize: 'A5'
    }
    expect(await rejection(service.savePdf({ id: invoice.id, paperSize: 'A4' }))).toEqual(refused)

    const other = post()
    target.shown = {
      route: `/invoices/${invoice.id}/print`,
      invoiceNo: 'INV-000001',
      paperSize: 'A4'
    }
    expect(await rejection(service.print({ id: other.id, paperSize: 'A4' }))).toEqual({
      ...refused,
      message: 'Open the print preview of INV-000002 to print it or save it as a PDF.'
    })

    target.available = false
    expect(await rejection(service.print({ id: invoice.id, paperSize: 'A4' }))).toEqual(refused)

    expect(target.printed).toEqual([])
    expect(target.pdfs).toEqual([])
    expect(dialogs.requests).toEqual([])
  })

  it('refuses a missing invoice or an invalid request before opening any dialog', async () => {
    expect(await rejection(service.print({ id: 999, paperSize: 'A4' }))).toMatchObject({
      code: 'NOT_FOUND'
    })
    expect(await rejection(service.savePdf({ id: invoice.id, paperSize: 'Letter' }))).toMatchObject(
      { code: 'VALIDATION' }
    )
    expect(
      await rejection(service.savePdf({ id: invoice.id, paperSize: 'A4', path: 'C:\\x.pdf' }))
    ).toMatchObject({ code: 'VALIDATION' })
    expect(target.printed).toEqual([])
    expect(dialogs.requests).toEqual([])
  })

  it('reports a printer failure in plain words and logs it', async () => {
    target.printOutcome = new Error('Invalid printer settings')
    expect(await rejection(service.print({ id: invoice.id, paperSize: 'A4' }))).toEqual({
      code: 'PRINT_FAILED',
      message: 'INV-000001 could not be printed. Check the printer and try again.'
    })
    expect(log.entries.at(-1)).toMatchObject({
      level: 'ERROR',
      message: '[print] the invoice could not be printed'
    })
  })

  it('saves the PDF where the user chooses, suggesting the invoice number in Documents', async () => {
    const before = writes()
    const file = win32.join(documentsDir, 'INV-000001.pdf')
    dialogs.answers.push(file)
    await expect(service.savePdf({ id: invoice.id, paperSize: 'A4' })).resolves.toEqual({
      status: 'SAVED',
      fileName: 'INV-000001.pdf',
      location: documentsDir
    })
    expect(dialogs.requests).toEqual([file])
    expect(target.pdfs).toEqual(['A4'])
    expect(readFileSync(file).toString()).toBe('%PDF-A4')
    expect(readdirSync(documentsDir)).toEqual(['INV-000001.pdf'])
    expect(writes()).toBe(before)
  })

  it('opens the next Save dialog in the folder the last PDF went to, and shows user folders safely', async () => {
    const service2 = new InvoicePrintService({
      database: new LiveDatabase(db),
      log,
      target: () => target,
      dialogs,
      documentsDir,
      appDataPath: temp.file('AppData'),
      homePath: temp.path
    })
    const folder = temp.file('Invoices')
    mkdirSync(folder)
    dialogs.answers.push(win32.join(folder, 'Ali.pdf'))
    await expect(service2.savePdf({ id: invoice.id, paperSize: 'A4' })).resolves.toEqual({
      status: 'SAVED',
      fileName: 'Ali.pdf',
      location: '%USERPROFILE%\\Invoices'
    })
    await service2.savePdf({ id: invoice.id, paperSize: 'A4' })
    expect(dialogs.requests).toEqual([
      win32.join(documentsDir, 'INV-000001.pdf'),
      win32.join(folder, 'INV-000001.pdf')
    ])
  })

  it('does nothing when the Save dialog is cancelled', async () => {
    await expect(service.savePdf({ id: invoice.id, paperSize: 'A4' })).resolves.toEqual({
      status: 'CANCELLED'
    })
    expect(target.pdfs).toEqual([])
    expect(readdirSync(documentsDir)).toEqual([])
  })

  it('adds .pdf to a name without it, but never replaces a file the dialog did not ask about', async () => {
    target.shown = { ...target.shown, paperSize: 'A5' }
    dialogs.answers.push(win32.join(documentsDir, 'Ali bill'))
    await expect(service.savePdf({ id: invoice.id, paperSize: 'A5' })).resolves.toMatchObject({
      status: 'SAVED',
      fileName: 'Ali bill.pdf'
    })
    dialogs.answers.push(win32.join(documentsDir, 'Ali bill'))
    expect(await rejection(service.savePdf({ id: invoice.id, paperSize: 'A5' }))).toEqual({
      code: 'PRINT_FAILED',
      message: 'Ali bill.pdf already exists. Save the PDF again and choose another name.'
    })
    expect(readFileSync(win32.join(documentsDir, 'Ali bill.pdf')).toString()).toBe('%PDF-A5')
  })

  it('refuses a location that is not a full path', async () => {
    dialogs.answers.push('INV-000001.pdf')
    expect(await rejection(service.savePdf({ id: invoice.id, paperSize: 'A4' }))).toEqual({
      code: 'PRINT_FAILED',
      message: 'This location cannot be used. Choose another folder.'
    })
    expect(target.pdfs).toEqual([])
  })

  it('reports a PDF that could not be created or written, and leaves no partial file', async () => {
    target.pdfOutcome = new Error('Printing failed')
    dialogs.answers.push(win32.join(documentsDir, 'INV-000001.pdf'))
    expect(await rejection(service.savePdf({ id: invoice.id, paperSize: 'A4' }))).toEqual({
      code: 'PRINT_FAILED',
      message: 'The PDF of INV-000001 could not be created. Try again.'
    })

    target.pdfOutcome = undefined
    // A folder with the chosen name: the file cannot be written there.
    const blocked = win32.join(documentsDir, 'Blocked.pdf')
    mkdirSync(blocked)
    dialogs.answers.push(blocked)
    expect(await rejection(service.savePdf({ id: invoice.id, paperSize: 'A4' }))).toEqual({
      code: 'PRINT_FAILED',
      message:
        'Blocked.pdf could not be saved. Check that the folder can be written to and that the file is not open in another program, then try again.'
    })
    expect(readdirSync(documentsDir)).toEqual(['Blocked.pdf'])

    dialogs.answers.push(win32.join(temp.file('Missing folder'), 'INV-000001.pdf'))
    expect(await rejection(service.savePdf({ id: invoice.id, paperSize: 'A4' }))).toMatchObject({
      code: 'PRINT_FAILED'
    })
    expect(existsSync(temp.file('Missing folder'))).toBe(false)
  })

  it('runs one print or PDF at a time', async () => {
    let release: () => void = () => undefined
    target.printGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = service.print({ id: invoice.id, paperSize: 'A4' })
    expect(await rejection(service.savePdf({ id: invoice.id, paperSize: 'A4' }))).toEqual({
      code: 'FORBIDDEN_STATE',
      message: 'An invoice is already being printed or saved as a PDF. Finish that first.'
    })
    release()
    await expect(first).resolves.toEqual({ status: 'SENT' })
    target.printGate = null
    await expect(service.print({ id: invoice.id, paperSize: 'A4' })).resolves.toEqual({
      status: 'SENT'
    })
  })
})
