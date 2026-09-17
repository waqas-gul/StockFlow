import { addDays, localDateString } from '@shared/dates'
import { calculateInvoiceTotals, type LineDiscount } from '@shared/invoice-totals'
import type { PaymentMethod } from '@shared/payments'
import type { Db } from './adapter'
import { createCompany } from '../services/companies.service'
import { adjustCustomerBalance, createCustomer } from '../services/customers.service'
import {
  createExpenseCategory,
  listExpenseCategories
} from '../services/expense-categories.service'
import { createExpense, voidExpense } from '../services/expenses.service'
import { voidInvoice } from '../services/invoice-void.service'
import { createInvoice, updateInvoiceDispatch } from '../services/invoices.service'
import { createPayment, voidPayment } from '../services/payments.service'
import { createProduct } from '../services/products.service'
import { readSettings } from '../services/settings.service'
import { adjustStock, receiveStock, voidReceipt } from '../services/stock.service'

/*
 * Demo data for a development database (`npm run seed`). It is never part of the app: nothing in src/main
 * imports this file, and the seed script writes to %APPDATA%\StockFlow-dev unless it is told otherwise.
 *
 * Everything is written through the real services, so a seeded database obeys every rule the app enforces:
 * stock is never negative, document numbers come from `sequences`, the ledgers stay append-only, and the
 * invariants each service asserts before it commits all hold. Nothing here inserts a row directly.
 *
 * Two rules shape the generator:
 * - Posting floors (plan §11.5): a document may not be dated before the latest movement of its products or the
 *   latest ledger entry of its customer. So every document is generated with a date, collected, and posted in
 *   date order; within one day the order does not matter.
 * - Stock is never oversold. Invoice lines are chosen from the stock the database actually holds at the moment
 *   the invoice is posted, not from a plan made in advance.
 */

/** One document on the demo timeline. They are posted in date order. */
interface TimelineEvent {
  readonly date: string
  /** Breaks ties within a day, so a receipt lands before the invoices that sell what it brought in. */
  readonly order: number
  readonly post: (date: string) => void
}

export interface SeedSummary {
  readonly tables: ReadonlyArray<{ readonly table: string; readonly rows: number }>
  readonly firstDate: string
  readonly lastDate: string
  /** What the seed put in besides the ordinary documents, for the console. */
  readonly notes: readonly string[]
}

interface SeedUnit {
  readonly id: number
  readonly name: string
  readonly baseQty: number
  readonly retailPriceMinor: number
  readonly wholesalePriceMinor: number
}

interface SeedProduct {
  readonly id: number
  readonly code: string
  readonly name: string
  /** Smallest unit first. */
  readonly units: readonly SeedUnit[]
  readonly baseUnit: SeedUnit
  readonly largestUnit: SeedUnit
  /** Cost of one base unit, for receipts and opening stock. */
  readonly costMinor: number
}

interface SeedCustomer {
  readonly id: number
  readonly code: string
  readonly name: string
}

/** The same seed always produces the same demo database. */
const RANDOM_SEED = 20260917
/** How far back the demo history reaches. */
const HISTORY_DAYS = 120

// --- Master data -----------------------------------------------------------------------------------------

const COMPANIES = [
  'Unilever Pakistan',
  'Nestle Pakistan',
  'Tapal Tea',
  'National Foods',
  'Colgate-Palmolive'
] as const

interface PriceSet {
  readonly retail: number
  readonly wholesale: number
  readonly cost: number
}

interface UnitSpec {
  readonly name: string
  readonly shortName: string
  readonly baseQty: number
  /** The saving on the larger unit, in basis points of the base-unit price. */
  readonly bulkBps: number
}

interface ProductSpec {
  readonly code: string
  readonly name: string
  readonly company: string | null
  readonly packingLabel: string
  readonly lowStockThresholdBase: number
  /** The price of one base unit, in minor units (paisa). */
  readonly base: PriceSet
  /** The base unit first, then the larger ones; sizes must nest. */
  readonly units: readonly UnitSpec[]
}

const PIECE: UnitSpec = { name: 'Piece', shortName: 'Pcs', baseQty: 1, bulkBps: 0 }

const PRODUCTS: readonly ProductSpec[] = [
  {
    code: 'P-1001',
    name: 'Lipton Yellow Label Tea 950g',
    company: 'Unilever Pakistan',
    packingLabel: '1*12',
    lowStockThresholdBase: 24,
    base: { retail: 145000, wholesale: 138000, cost: 120000 },
    units: [PIECE, { name: 'Carton', shortName: 'Ctn', baseQty: 12, bulkBps: 200 }]
  },
  {
    code: 'P-1002',
    name: 'Surf Excel Washing Powder 1kg',
    company: 'Unilever Pakistan',
    packingLabel: '1*9',
    lowStockThresholdBase: 18,
    base: { retail: 62500, wholesale: 59000, cost: 51000 },
    units: [PIECE, { name: 'Carton', shortName: 'Ctn', baseQty: 9, bulkBps: 150 }]
  },
  {
    code: 'P-1003',
    name: 'Nescafe Classic 200g',
    company: 'Nestle Pakistan',
    packingLabel: '1*6*4',
    lowStockThresholdBase: 12,
    base: { retail: 189000, wholesale: 180000, cost: 156000 },
    units: [
      PIECE,
      { name: 'Box', shortName: 'Box', baseQty: 6, bulkBps: 100 },
      { name: 'Carton', shortName: 'Ctn', baseQty: 24, bulkBps: 250 }
    ]
  },
  {
    code: 'P-1004',
    name: 'Nestle Milkpak 1 Litre',
    company: 'Nestle Pakistan',
    packingLabel: '1*12',
    lowStockThresholdBase: 48,
    base: { retail: 29000, wholesale: 27200, cost: 23600 },
    units: [PIECE, { name: 'Carton', shortName: 'Ctn', baseQty: 12, bulkBps: 150 }]
  },
  {
    code: 'P-1005',
    name: 'Nido Full Cream 900g',
    company: 'Nestle Pakistan',
    packingLabel: '1*6',
    lowStockThresholdBase: 12,
    base: { retail: 172500, wholesale: 165000, cost: 143000 },
    units: [PIECE, { name: 'Carton', shortName: 'Ctn', baseQty: 6, bulkBps: 200 }]
  },
  {
    code: 'P-1006',
    name: 'Tapal Danedar 450g',
    company: 'Tapal Tea',
    packingLabel: '1*24',
    lowStockThresholdBase: 24,
    base: { retail: 84000, wholesale: 79500, cost: 69000 },
    units: [PIECE, { name: 'Carton', shortName: 'Ctn', baseQty: 24, bulkBps: 300 }]
  },
  {
    code: 'P-1007',
    name: 'Tapal Green Tea 30 Bags',
    company: 'Tapal Tea',
    packingLabel: '1*12*2',
    lowStockThresholdBase: 24,
    base: { retail: 45000, wholesale: 42500, cost: 37000 },
    units: [
      PIECE,
      { name: 'Box', shortName: 'Box', baseQty: 12, bulkBps: 150 },
      { name: 'Carton', shortName: 'Ctn', baseQty: 24, bulkBps: 250 }
    ]
  },
  {
    code: 'P-1008',
    name: 'National Chilli Powder 200g',
    company: 'National Foods',
    packingLabel: '1*24',
    lowStockThresholdBase: 36,
    base: { retail: 32000, wholesale: 30000, cost: 26000 },
    units: [PIECE, { name: 'Carton', shortName: 'Ctn', baseQty: 24, bulkBps: 250 }]
  },
  {
    code: 'P-1009',
    name: 'National Biryani Masala 50g',
    company: 'National Foods',
    packingLabel: '1*6*12',
    lowStockThresholdBase: 72,
    base: { retail: 9500, wholesale: 8800, cost: 7600 },
    units: [
      PIECE,
      { name: 'Box', shortName: 'Box', baseQty: 6, bulkBps: 100 },
      { name: 'Carton', shortName: 'Ctn', baseQty: 72, bulkBps: 300 }
    ]
  },
  {
    code: 'P-1010',
    name: 'Colgate MaxFresh 125g',
    company: 'Colgate-Palmolive',
    packingLabel: '1*12*6',
    lowStockThresholdBase: 48,
    base: { retail: 38500, wholesale: 36000, cost: 31300 },
    units: [
      PIECE,
      { name: 'Box', shortName: 'Box', baseQty: 12, bulkBps: 150 },
      { name: 'Carton', shortName: 'Ctn', baseQty: 72, bulkBps: 300 }
    ]
  },
  {
    code: 'P-1011',
    name: 'Palmolive Shower Gel 250ml',
    company: 'Colgate-Palmolive',
    packingLabel: '1*12',
    lowStockThresholdBase: 24,
    base: { retail: 58000, wholesale: 54500, cost: 47400 },
    units: [PIECE, { name: 'Carton', shortName: 'Ctn', baseQty: 12, bulkBps: 200 }]
  },
  {
    code: 'P-1012',
    name: 'Sufi Cooking Oil 5 Litre',
    company: null,
    packingLabel: '1*4',
    lowStockThresholdBase: 8,
    base: { retail: 465000, wholesale: 448000, cost: 390000 },
    units: [PIECE, { name: 'Carton', shortName: 'Ctn', baseQty: 4, bulkBps: 100 }]
  }
]

interface CustomerSpec {
  readonly name: string
  readonly shopName: string
  readonly phone: string
  readonly address: string
  readonly city: string
  readonly notes: string | null
  /** What the customer was carrying when the shop started using StockFlow. */
  readonly opening: { readonly side: 'DUE' | 'ADVANCE'; readonly amountMinor: number } | null
}

const CUSTOMERS: readonly CustomerSpec[] = [
  {
    name: 'Muhammad Aslam',
    shopName: 'Al-Madina Kiryana Store',
    phone: '0300-4412876',
    address: 'Shop 14, Anarkali Bazar',
    city: 'Lahore',
    notes: 'Pays on the 1st of every month.',
    opening: { side: 'DUE', amountMinor: 4850000 }
  },
  {
    name: 'Bilal Ahmed',
    shopName: 'Bismillah General Store',
    phone: '0321-7789043',
    address: 'Main Ferozepur Road',
    city: 'Lahore',
    notes: null,
    opening: { side: 'DUE', amountMinor: 1275000 }
  },
  {
    name: 'Abdul Rehman',
    shopName: 'Rehman Traders',
    phone: '0333-6612094',
    address: 'Circular Road, Ghanta Ghar',
    city: 'Faisalabad',
    notes: 'Wholesale rates agreed.',
    opening: { side: 'ADVANCE', amountMinor: 900000 }
  },
  {
    name: 'Sabir Hussain',
    shopName: 'New Sabir Store',
    phone: '0301-2234587',
    address: 'Hussain Agahi Road',
    city: 'Multan',
    notes: null,
    opening: null
  },
  {
    name: 'Hafiz Zubair',
    shopName: 'Hafiz Super Mart',
    phone: '0345-9081234',
    address: 'Block 6, Gulshan-e-Iqbal',
    city: 'Karachi',
    notes: 'Delivery via Kohistan Goods.',
    opening: { side: 'DUE', amountMinor: 7320000 }
  },
  {
    name: 'Chaudhry Nadeem',
    shopName: 'Chaudhry Kiryana',
    phone: '0312-4456781',
    address: 'GT Road, Rahwali',
    city: 'Gujranwala',
    notes: null,
    opening: null
  },
  {
    name: 'Imran Khalid',
    shopName: 'City Mart',
    phone: '0308-1123400',
    address: 'F-10 Markaz',
    city: 'Islamabad',
    notes: 'Pays by cheque.',
    opening: { side: 'DUE', amountMinor: 2140000 }
  },
  {
    name: 'Ali Raza',
    shopName: 'Ali Traders',
    phone: '0322-5567890',
    address: 'Kashmir Road',
    city: 'Sialkot',
    notes: null,
    opening: null
  }
]

const EXTRA_EXPENSE_CATEGORIES = [
  { name: 'Shop Rent', group: 'GENERAL' as const },
  { name: 'Electricity Bill', group: 'GENERAL' as const },
  { name: 'Staff Salaries', group: 'GENERAL' as const },
  { name: 'Fuel & Transport', group: 'SHOP' as const },
  { name: 'Packing Material', group: 'SHOP' as const },
  { name: 'Repairs & Maintenance', group: 'SHOP' as const }
]

const SUPPLIERS = [
  'Metro Cash & Carry',
  'Al-Fatah Distributors',
  'Shaheen Marketing',
  'Karachi Wholesale Depot',
  'Punjab Trading Company'
] as const

const TRANSPORTS = [
  'Kohistan Goods',
  'Shaheen Goods',
  'Faisal Movers Cargo',
  'NLC Logistics'
] as const

const ADDAS = ['Badami Bagh Adda', 'Thokar Niaz Baig', 'Pindi Adda', 'Sabzi Mandi Adda'] as const

const EXPENSE_NOTES: readonly string[] = [
  'Loader wages',
  'Rickshaw fare for a delivery',
  'Diesel for the delivery van',
  'Tape and cartons',
  'Shop cleaning',
  'Tea and refreshments',
  'Generator repair',
  'Freight paid to the transporter',
  'Mobile card for the shop number',
  'Bulb and wiring for the shop'
]

const PAYMENT_METHOD_LIST: readonly PaymentMethod[] = ['CASH', 'BANK', 'CHEQUE', 'OTHER']

// --- The seed --------------------------------------------------------------------------------------------

export interface SeedOptions {
  /** The clock the services see. Every date is generated relative to this day. */
  readonly now?: () => Date
  /** Progress for the console. */
  readonly onProgress?: (message: string) => void
}

/** True when the database already holds business data, so seeding would mix demo rows into real ones. */
export function hasBusinessData(db: Db): boolean {
  const counts = db.get<{ n: number }>(
    `SELECT (SELECT count(*) FROM products) + (SELECT count(*) FROM invoices)
          + (SELECT count(*) FROM stock_receipts) + (SELECT count(*) FROM expenses)
          + (SELECT count(*) FROM companies) AS n`
  )
  return (counts?.n ?? 0) > 0
}

export function seedDemoData(db: Db, options: SeedOptions = {}): SeedSummary {
  const now = options.now ?? ((): Date => new Date())
  const report = options.onProgress ?? ((): void => {})
  const random = createRandom(RANDOM_SEED)
  const today = localDateString(now())
  const day = (offset: number): string => addDays(today, -offset)
  const minorDigits = readSettings(db)['currency.minorDigits']
  const notes: string[] = []

  report('companies and products')
  const companyIds = new Map<string, number>(
    COMPANIES.map((name) => [name, createCompany(db, { name }).id])
  )
  const products = PRODUCTS.map((spec) => createSeedProduct(db, spec, companyIds, minorDigits))
  const productByCode = new Map(products.map((product) => [product.code, product]))

  report('customers and their opening balances')
  const openingDate = day(HISTORY_DAYS)
  const accounts: SeedCustomer[] = CUSTOMERS.map((spec) => {
    const created = createCustomer(
      db,
      {
        name: spec.name,
        shopName: spec.shopName,
        phone: spec.phone,
        address: spec.address,
        city: spec.city,
        notes: spec.notes,
        opening:
          spec.opening === null
            ? null
            : { side: spec.opening.side, amountMinor: spec.opening.amountMinor, date: openingDate },
        currencyMinorDigits: minorDigits
      },
      now()
    )
    return { id: created.id, code: created.code, name: created.name }
  })
  const walkIn = db.get<SeedCustomer & { code: string }>(
    "SELECT id, code, name FROM customers WHERE code = 'C-00001'"
  )!

  report('expense categories')
  for (const category of EXTRA_EXPENSE_CATEGORIES) {
    createExpenseCategory(db, { name: category.name, group: category.group })
  }
  const categories = listExpenseCategories(db)
  const categoryId = (name: string): number =>
    categories.find((category) => category.name === name)!.id

  // The timeline is built first and posted in date order, so every document clears its posting floor.
  const events: TimelineEvent[] = []
  const at = (date: string, order: number, post: (date: string) => void): void => {
    events.push({ date, order, post })
  }

  // Opening stock, counted the day the shop started on StockFlow.
  products.forEach((product, index) => {
    const cartons = 6 + Math.floor(random() * 10)
    at(openingDate, 0, (date) =>
      adjustStock(
        db,
        {
          requestId: requestId('open', String(index)),
          adjustmentDate: date,
          productId: product.id,
          reason: 'OPENING_STOCK',
          direction: null,
          unitId: product.largestUnit.id,
          quantity: cartons,
          unitCostMinor: product.costMinor * product.largestUnit.baseQty,
          receiptItemId: null,
          reasonNote: 'Opening stock counted when StockFlow was set up.',
          currencyMinorDigits: minorDigits
        },
        now()
      )
    )
  })

  // Stock In: a purchase roughly every nine days, three to six products at a time.
  let receiptNumber = 0
  for (let offset = HISTORY_DAYS - 6; offset >= 3; offset -= 9) {
    const chosen = sample(products, 3 + Math.floor(random() * 4), random)
    const supplier = SUPPLIERS[Math.floor(random() * SUPPLIERS.length)]
    const index = ++receiptNumber
    const lines = chosen.map((product) => ({
      productId: product.id,
      unitId: product.largestUnit.id,
      quantity: 3 + Math.floor(random() * 12),
      unitCostMinor: Math.round(
        product.costMinor * product.largestUnit.baseQty * (0.97 + random() * 0.08)
      )
    }))
    at(day(offset), 1, (date) =>
      receiveStock(
        db,
        {
          requestId: requestId('grn', String(index)),
          receiptDate: date,
          supplierName: supplier,
          reference: `Bill ${4200 + index * 7}`,
          note: index % 3 === 0 ? 'Goods checked and counted at the shop.' : null,
          currencyMinorDigits: minorDigits,
          lines
        },
        now()
      )
    )
  }

  // Sales: one to three invoices on most days of the last four months.
  let invoiceNumber = 0
  const posted: Array<{ id: number; walkIn: boolean }> = []
  for (let offset = HISTORY_DAYS - 8; offset >= 1; offset--) {
    if (random() < 0.25) continue
    const perDay = 1 + Math.floor(random() * 3)
    for (let n = 0; n < perDay; n++) {
      const index = ++invoiceNumber
      const cash = random() < 0.25
      const customer = cash ? walkIn : accounts[Math.floor(random() * accounts.length)]
      at(day(offset), 2, (date) => {
        const saved = postInvoice(db, {
          index,
          date,
          customerId: customer.id,
          walkIn: cash,
          products,
          random,
          minorDigits,
          now: now()
        })
        if (saved !== null) posted.push({ id: saved.id, walkIn: cash })
      })
    }
  }

  // Payments on the running account, every third day.
  let paymentNumber = 0
  for (let offset = HISTORY_DAYS - 20; offset >= 1; offset -= 3) {
    const customer = accounts[Math.floor(random() * accounts.length)]
    const index = ++paymentNumber
    const method = PAYMENT_METHOD_LIST[Math.floor(random() * PAYMENT_METHOD_LIST.length)]
    const share = 0.3 + random() * 0.6
    const withNote = random() < 0.3
    at(day(offset), 3, (date) => {
      const balance = customerBalanceOf(db, customer.id)
      if (balance <= 0) return
      // Customers pay a round part of what they owe, never more than the balance.
      const amount = Math.min(
        balance,
        roundTo(Math.max(100000, Math.floor(balance * share)), 50000)
      )
      createPayment(
        db,
        {
          requestId: requestId('pay', String(index)),
          customerId: customer.id,
          paymentDate: date,
          amountMinor: amount,
          method,
          reference:
            method === 'CHEQUE'
              ? `CHQ-${480000 + index * 13}`
              : method === 'BANK'
                ? `TRF-${770000 + index * 29}`
                : null,
          note: withNote ? 'Received at the shop.' : null,
          currencyMinorDigits: minorDigits
        },
        now()
      )
    })
  }

  // Stock corrections: damage, expiry, a shortage and a surplus found in the store room.
  const corrections = [
    { reason: 'DAMAGE' as const, note: 'Cartons soaked in the rain.', offset: HISTORY_DAYS - 30 },
    {
      reason: 'EXPIRY' as const,
      note: 'The expiry date passed on the shelf stock.',
      offset: HISTORY_DAYS - 52
    },
    {
      reason: 'SHORTAGE' as const,
      note: 'Short against the physical count.',
      offset: HISTORY_DAYS - 68
    },
    { reason: 'DAMAGE' as const, note: 'Broken in handling at the counter.', offset: 20 },
    { reason: 'COUNT_SURPLUS' as const, note: 'Found extra in the store room.', offset: 14 }
  ]
  corrections.forEach((correction, index) => {
    const product = products[(index * 3 + 1) % products.length]
    at(day(correction.offset), 4, (date) => {
      const available = stockOf(db, product.id)
      const quantity = correction.reason === 'COUNT_SURPLUS' ? 2 : Math.min(3, available)
      if (quantity < 1) return
      adjustStock(
        db,
        {
          requestId: requestId('adj', String(index)),
          adjustmentDate: date,
          productId: product.id,
          reason: correction.reason,
          direction: null,
          unitId: product.baseUnit.id,
          quantity,
          // Stock leaves at its current average cost, and a surplus takes it too while the product has stock.
          unitCostMinor: null,
          receiptItemId: null,
          reasonNote: correction.note,
          currencyMinorDigits: minorDigits
        },
        now()
      )
    })
  })

  // Expenses: rent and salaries on the 1st, running costs through the week.
  let expenseNumber = 0
  const expenseIds: number[] = []
  for (let offset = HISTORY_DAYS; offset >= 1; offset--) {
    const date = day(offset)
    if (date.endsWith('-01')) {
      const monthly = [
        { category: 'Shop Rent', amount: 4500000, description: 'Monthly shop rent' },
        { category: 'Staff Salaries', amount: 7800000, description: 'Salaries for the month' }
      ]
      for (const item of monthly) {
        const index = ++expenseNumber
        at(date, 5, (on) => {
          expenseIds.push(
            createExpense(
              db,
              {
                requestId: requestId('exp', String(index)),
                expenseDate: on,
                categoryId: categoryId(item.category),
                amountMinor: item.amount,
                description: item.description,
                currencyMinorDigits: minorDigits
              },
              now()
            ).id
          )
        })
      }
    }
    if (random() < 0.45) {
      const index = ++expenseNumber
      const category = categories[Math.floor(random() * categories.length)]
      const description = EXPENSE_NOTES[Math.floor(random() * EXPENSE_NOTES.length)]
      const amount = roundTo(50000 + Math.floor(random() * 850000), 5000)
      at(date, 5, (on) => {
        expenseIds.push(
          createExpense(
            db,
            {
              requestId: requestId('exp', String(index)),
              expenseDate: on,
              categoryId: category.id,
              amountMinor: amount,
              description,
              currencyMinorDigits: minorDigits
            },
            now()
          ).id
        )
      })
    }
  }

  report(`posting ${events.length} documents in date order`)
  events.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1))
  for (const event of events) event.post(event.date)

  // --- Later changes, all dated today so they clear every posting floor ---------------------------------

  report('dispatch details, voids and a balance correction')

  // Dispatch details filled in once the goods had left (this writes invoice_change_log).
  const dispatched = posted.filter((invoice) => !invoice.walkIn).slice(-6)
  dispatched.forEach((invoice, index) => {
    updateInvoiceDispatch(
      db,
      {
        id: invoice.id,
        biltyNo: `BL-${90210 + index * 17}`,
        transportName: TRANSPORTS[index % TRANSPORTS.length],
        addaName: ADDAS[index % ADDAS.length],
        note: 'Bilty received from the transporter.'
      },
      now()
    )
  })
  notes.push(`${dispatched.length} invoices carry dispatch details and a change log`)

  // A receipt entered by mistake. A receipt can only be voided while it is still the last stock activity of
  // its products, so it is posted and reversed here, after every other document.
  const mistake = productByCode.get('P-1011')!
  const mistakenReceipt = receiveStock(
    db,
    {
      requestId: requestId('grn', 'mistake'),
      receiptDate: today,
      supplierName: 'Shaheen Marketing',
      reference: 'Bill 4999',
      note: 'Entered against the wrong shop.',
      currencyMinorDigits: minorDigits,
      lines: [
        {
          productId: mistake.id,
          unitId: mistake.largestUnit.id,
          quantity: 4,
          unitCostMinor: mistake.costMinor * mistake.largestUnit.baseQty
        }
      ]
    },
    now()
  )
  voidReceipt(
    db,
    {
      id: mistakenReceipt.id,
      reason: 'Entered against the wrong shop; the goods were never received.'
    },
    now()
  )
  notes.push(`receipt ${mistakenReceipt.receiptNo} is void`)

  // An order a customer sent back, and a counter sale where the money was handed back.
  const credit = posted.filter((invoice) => !invoice.walkIn).at(-1)
  if (credit !== undefined) {
    voidInvoice(
      db,
      { id: credit.id, reason: 'The customer returned the whole order.', moneyReturned: false },
      now()
    )
    notes.push('one credit invoice is void, with its stock and balance reversed')
  }
  const cash = posted.filter((invoice) => invoice.walkIn).at(-1)
  if (cash !== undefined) {
    voidInvoice(
      db,
      { id: cash.id, reason: 'Wrong items billed at the counter.', moneyReturned: true },
      now()
    )
    notes.push('one walk-in invoice is void and its payment was returned')
  }

  // A payment entered twice. Payments taken with an invoice are left alone.
  const duplicate = db.get<{ id: number; payment_no: string }>(
    `SELECT id, payment_no FROM payments
     WHERE status = 'POSTED' AND invoice_id IS NULL ORDER BY id DESC LIMIT 1`
  )
  if (duplicate !== undefined) {
    voidPayment(db, { id: duplicate.id, reason: 'Entered twice by mistake.' }, now())
    notes.push(`payment ${duplicate.payment_no} is void`)
  }

  if (expenseIds.length > 0) {
    voidExpense(db, expenseIds[expenseIds.length - 1])
    notes.push('one expense is void')
  }

  // A balance correction on the account of whoever owes the most.
  const owing = db.get<{ customer_id: number }>(
    `SELECT customer_id FROM v_customer_balance WHERE balance_minor > 0
     ORDER BY balance_minor DESC LIMIT 1`
  )
  if (owing !== undefined) {
    adjustCustomerBalance(
      db,
      {
        customerId: owing.customer_id,
        entryDate: today,
        direction: 'DECREASE',
        amountMinor: 250000,
        reason: 'Freight agreed with the customer and written off.',
        currencyMinorDigits: minorDigits
      },
      now()
    )
    notes.push('one customer balance carries an adjustment')
  }

  return { tables: countRows(db), firstDate: openingDate, lastDate: today, notes }
}

// --- Building blocks -------------------------------------------------------------------------------------

function createSeedProduct(
  db: Db,
  spec: ProductSpec,
  companyIds: ReadonlyMap<string, number>,
  minorDigits: number
): SeedProduct {
  const created = createProduct(db, {
    code: spec.code,
    name: spec.name,
    companyId: spec.company === null ? null : (companyIds.get(spec.company) ?? null),
    packingLabel: spec.packingLabel,
    lowStockThresholdBase: spec.lowStockThresholdBase,
    currencyMinorDigits: minorDigits,
    units: spec.units.map((unit) => {
      const prices = scalePrices(spec.base, unit.baseQty, unit.bulkBps)
      return {
        id: null,
        name: unit.name,
        shortName: unit.shortName,
        baseQty: unit.baseQty,
        isBase: unit.baseQty === 1,
        canSell: true,
        canPurchase: true,
        wholesalePriceMinor: prices.wholesale,
        retailPriceMinor: prices.retail,
        defaultCostMinor: prices.cost,
        isActive: true
      }
    })
  })
  const units: SeedUnit[] = created.units
    .map((unit) => ({
      id: unit.id,
      name: unit.name,
      baseQty: unit.baseQty,
      retailPriceMinor: unit.retailPriceMinor!,
      wholesalePriceMinor: unit.wholesalePriceMinor!
    }))
    .sort((a, b) => a.baseQty - b.baseQty)
  return {
    id: created.id,
    code: created.code,
    name: created.name,
    units,
    baseUnit: units[0],
    largestUnit: units[units.length - 1],
    costMinor: spec.base.cost
  }
}

interface InvoicePlan {
  readonly index: number
  readonly date: string
  readonly customerId: number
  readonly walkIn: boolean
  readonly products: readonly SeedProduct[]
  readonly random: () => number
  readonly minorDigits: number
  readonly now: Date
}

interface DraftQuantity {
  readonly unitId: number
  readonly unitBaseQty: number
  readonly quantity: number
  readonly unitPriceMinor: number
  readonly priceOverride: boolean
}

interface DraftLine {
  readonly productId: number
  readonly quantities: readonly DraftQuantity[]
  readonly freeQuantities: ReadonlyArray<{ unitId: number; unitBaseQty: number; quantity: number }>
  readonly discount: LineDiscount | null
  readonly schemeMinor: number
  readonly ctnCount: number | null
}

/**
 * One invoice, built from the stock the database holds right now, so no line ever asks for stock that is not
 * there. Returns null when nothing sellable was left that day.
 */
function postInvoice(db: Db, plan: InvoicePlan): { id: number } | null {
  const { random } = plan
  const tier = plan.walkIn || random() < 0.3 ? 'RETAIL' : 'WHOLESALE'
  const candidates = plan.products.filter((product) => stockOf(db, product.id) >= 4)
  if (candidates.length === 0) return null
  const chosen = sample(
    candidates,
    1 + Math.floor(random() * Math.min(4, candidates.length)),
    random
  )

  const lines = chosen
    .map((product) => draftLine(db, product, tier, random))
    .filter((line): line is DraftLine => line !== null)
  if (lines.length === 0) return null

  const freightMinor = random() < 0.35 ? roundTo(20000 + Math.floor(random() * 60000), 5000) : 0
  const invoiceCode = random() < 0.4 ? `SO-${3100 + plan.index}` : null
  const checkedBy = random() < 0.5 ? 'Waqas' : null
  const notes = random() < 0.15 ? 'Delivered to the shop the same evening.' : null

  // A walk-in sale must be paid in full, so the total is worked out first, exactly as the billing screen
  // does before it enables Save. An account customer pays part of it, or nothing.
  const totals = calculateInvoiceTotals({
    lines,
    extraDiscountMinor: 0,
    freightMinor,
    receivedMinor: 0,
    previousBalanceMinor: 0
  })
  if (!totals.ok) return null
  const totalMinor = totals.totals.totalMinor
  const receivedMinor = plan.walkIn
    ? totalMinor
    : random() < 0.4
      ? Math.min(totalMinor, roundTo(Math.floor(totalMinor * (0.2 + random() * 0.5)), 50000))
      : 0

  const saved = createInvoice(
    db,
    {
      requestId: requestId('inv', String(plan.index)),
      invoiceDate: plan.date,
      customerId: plan.customerId,
      priceTier: tier,
      invoiceCode,
      biltyNo: null,
      transportName: null,
      addaName: null,
      checkedBy,
      notes,
      lines: lines.map((line) => ({
        productId: line.productId,
        quantities: line.quantities.map((row) => ({
          unitId: row.unitId,
          quantity: row.quantity,
          unitPriceMinor: row.unitPriceMinor,
          priceOverride: row.priceOverride
        })),
        freeQuantities: line.freeQuantities.map((row) => ({
          unitId: row.unitId,
          quantity: row.quantity
        })),
        discount: line.discount,
        schemeMinor: line.schemeMinor,
        ctnCount: line.ctnCount
      })),
      extraDiscountMinor: 0,
      freightMinor,
      receivedMinor,
      paymentMethod: receivedMinor > 0 ? (plan.walkIn ? 'CASH' : 'BANK') : null,
      paymentReference: null,
      currencyMinorDigits: plan.minorDigits
    },
    plan.now
  )
  return { id: saved.id }
}

/** One product line: whole cartons first, then loose pieces, out of a share of the stock on hand. */
function draftLine(
  db: Db,
  product: SeedProduct,
  tier: 'RETAIL' | 'WHOLESALE',
  random: () => number
): DraftLine | null {
  // Never sell more than a share of what is on hand, so there is stock left for the following days.
  let budget = Math.max(1, Math.floor(stockOf(db, product.id) * 0.35))
  const quantities: DraftQuantity[] = []
  for (const unit of [...product.units].reverse()) {
    if (unit.baseQty > budget) continue
    const possible = Math.floor(budget / unit.baseQty)
    const quantity = Math.max(1, Math.min(possible, 1 + Math.floor(random() * 6)))
    quantities.push({
      unitId: unit.id,
      unitBaseQty: unit.baseQty,
      quantity,
      unitPriceMinor: tier === 'RETAIL' ? unit.retailPriceMinor : unit.wholesalePriceMinor,
      priceOverride: false
    })
    budget -= quantity * unit.baseQty
    if (quantities.length === 2 || budget < 1) break
  }
  if (quantities.length === 0) return null

  // Free scheme goods: a piece or two given with the order. They leave stock too, so they share the budget.
  const freeQuantities =
    random() < 0.18 && budget >= 2
      ? [{ unitId: product.baseUnit.id, unitBaseQty: product.baseUnit.baseQty, quantity: 2 }]
      : []

  const roll = random()
  const discount: LineDiscount | null =
    roll < 0.3
      ? { type: 'PERCENT', bps: [250, 500, 750, 1000][Math.floor(random() * 4)] }
      : roll < 0.4
        ? { type: 'AMOUNT', amountMinor: roundTo(20000 + Math.floor(random() * 60000), 5000) }
        : null
  const cartons = quantities.find((row) => row.unitId === product.largestUnit.id)
  return {
    productId: product.id,
    quantities,
    freeQuantities,
    discount,
    schemeMinor: random() < 0.12 ? roundTo(10000 + Math.floor(random() * 30000), 5000) : 0,
    ctnCount: cartons?.quantity ?? null
  }
}

function scalePrices(base: PriceSet, baseQty: number, bulkBps: number): PriceSet {
  const apply = (value: number): number => Math.round((value * baseQty * (10000 - bulkBps)) / 10000)
  return { retail: apply(base.retail), wholesale: apply(base.wholesale), cost: apply(base.cost) }
}

function stockOf(db: Db, productId: number): number {
  return (
    db.get<{ qty_base: number }>('SELECT qty_base FROM v_product_stock WHERE product_id = ?', [
      productId
    ])?.qty_base ?? 0
  )
}

function customerBalanceOf(db: Db, customerId: number): number {
  return (
    db.get<{ balance_minor: number }>(
      'SELECT balance_minor FROM v_customer_balance WHERE customer_id = ?',
      [customerId]
    )?.balance_minor ?? 0
  )
}

/** Every table with its row count, so a seeded database can be checked at a glance. */
function countRows(db: Db): ReadonlyArray<{ table: string; rows: number }> {
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )
  return tables.map(({ name }) => ({
    table: name,
    // The name comes from sqlite_schema, never from input.
    rows: db.get<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`)!.n
  }))
}

/** A stable request id per document, so running the seed twice on one database adds nothing twice. */
function requestId(kind: string, key: string): string {
  return `seed-${kind}-${key.replace(/[^A-Za-z0-9-]/g, '')}`
}

function roundTo(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step)
}

/** `count` distinct members of `items`, chosen with `random`. */
function sample<T>(items: readonly T[], count: number, random: () => number): T[] {
  const pool = [...items]
  const chosen: T[] = []
  const wanted = Math.min(count, pool.length)
  while (chosen.length < wanted) chosen.push(...pool.splice(Math.floor(random() * pool.length), 1))
  return chosen
}

/** A small linear congruential generator: the same seed always produces the same demo database. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}
