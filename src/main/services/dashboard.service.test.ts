import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Customer } from '@shared/customers'
import type { InvoiceCreateInput, InvoiceLineInput, InvoiceSaveResult } from '@shared/invoices'
import type { Product, ProductUnitInput } from '@shared/products'
import { PURCHASE_COST_CORRECTION_CATEGORY_ID } from '@shared/expenses'
import type { Db } from '../db/adapter'
import { createSchemaDatabase, createTempDir, type TempDir } from '../db/test-utils'
import { createCustomer } from './customers.service'
import { dashboardData } from './dashboard.service'
import { createExpense, voidExpense } from './expenses.service'
import { voidInvoice } from './invoice-void.service'
import { createInvoice } from './invoices.service'
import { createPayment } from './payments.service'
import { createProduct, setProductActive } from './products.service'
import {
  customerBalancesReport,
  expenseReport,
  productSalesReport,
  salesReport,
  stockReport
} from './reports.service'
import { receiveStock } from './stock.service'

// Test data lives only in temporary databases. Every expected figure below is worked out by hand, then checked against
// the report it comes from.

/** "Today" is Thursday 17 Sep 2026. */
const NOW = new Date(2026, 8, 17, 10, 0, 0)
const SEPTEMBER = { dateFrom: '2026-09-01', dateTo: '2026-09-30' }
const SHOP = 1
const GENERAL = 2

let temp: TempDir
let db: Db
let requests: number

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  requests = 0
})

afterEach(() => {
  temp.remove()
})

function requestId(): string {
  requests++
  return `dashboard-request-${String(requests).padStart(4, '0')}`
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
    retailPriceMinor: 100_000,
    defaultCostMinor: null,
    isActive: true,
    ...overrides
  }
}

function product(
  code: string,
  name: string,
  lowStockThresholdBase: number,
  units: ProductUnitInput[] = [unit({})]
): Product {
  return createProduct(db, {
    code,
    name,
    companyId: null,
    packingLabel: null,
    lowStockThresholdBase,
    currencyMinorDigits: 2,
    units
  })
}

function customer(name: string): Customer {
  return createCustomer(
    db,
    {
      name,
      shopName: null,
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

function baseUnit(item: Product): number {
  return item.units.find((candidate) => candidate.isBase)!.id
}

function receive(date: string, item: Product, quantity: number, unitCostMinor: number): void {
  receiveStock(
    db,
    {
      requestId: requestId(),
      receiptDate: date,
      supplierName: null,
      reference: null,
      note: null,
      currencyMinorDigits: 2,
      lines: [{ productId: item.id, unitId: baseUnit(item), quantity, unitCostMinor }]
    },
    NOW
  )
}

function sell(item: Product, quantity: number, unitPriceMinor: number): InvoiceLineInput {
  return {
    productId: item.id,
    quantities: [{ unitId: baseUnit(item), quantity, unitPriceMinor, priceOverride: false }],
    freeQuantities: [],
    discount: null,
    schemeMinor: 0,
    ctnCount: null
  }
}

function post(
  date: string,
  buyer: Customer,
  lines: InvoiceLineInput[],
  overrides: Partial<InvoiceCreateInput> = {}
): InvoiceSaveResult {
  return createInvoice(
    db,
    {
      requestId: requestId(),
      invoiceDate: date,
      customerId: buyer.id,
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

function pay(payer: Customer, date: string, amountMinor: number): void {
  createPayment(
    db,
    {
      requestId: requestId(),
      customerId: payer.id,
      paymentDate: date,
      amountMinor,
      method: 'CASH',
      reference: null,
      note: null,
      currencyMinorDigits: 2
    },
    NOW
  )
}

function expense(date: string, categoryId: number, amountMinor: number): number {
  return createExpense(
    db,
    {
      requestId: requestId(),
      expenseDate: date,
      categoryId,
      amountMinor,
      description: null,
      currencyMinorDigits: 2
    },
    NOW
  ).id
}

/** The 30 business dates ending on `last`. */
function trendDates(first: string, last: string): string[] {
  const dates: string[] = []
  for (let day = new Date(`${first}T00:00:00Z`); ; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10)
    dates.push(date)
    if (date === last) return dates
  }
}

describe('dashboard data', () => {
  it('is all zero and empty for a new shop, which is getting started', () => {
    const data = dashboardData(db, NOW)
    expect(data).toMatchObject({
      today: '2026-09-17',
      month: SEPTEMBER,
      summary: {
        todaySalesMinor: 0,
        todayInvoiceCount: 0,
        monthSalesMinor: 0,
        monthInvoiceCount: 0,
        receivablesMinor: 0,
        dueCustomerCount: 0,
        advancesMinor: 0,
        advanceCustomerCount: 0,
        inventoryValueMinor: 0,
        activeProductCount: 0,
        lowStockCount: 0
      },
      expenseBreakdown: {
        ...SEPTEMBER,
        shopMinor: 0,
        generalMinor: 0,
        operatingMinor: 0,
        purchaseCostCorrectionsMinor: 0
      },
      lowStock: [],
      topProducts: [],
      recentInvoices: [],
      recentPayments: [],
      recentExpenses: [],
      gettingStarted: true
    })
    // No fake points: 30 real days, each without sales.
    expect(data.salesTrend.map((day) => day.date)).toEqual(trendDates('2026-08-19', '2026-09-17'))
    expect(
      data.salesTrend.every((day) => day.invoiceCount === 0 && day.netGoodsSalesMinor === 0)
    ).toBe(true)
  })

  it('reads today, this month, balances, stock, expenses and recent activity from the reports and lists', () => {
    // Widget: 38 pieces left against a low-stock level of 40 (4 Box). Gadget: no level. Lamp: none left, level 5.
    const widget = product('W-001', 'Widget', 40, [
      unit({ name: 'Piece' }),
      unit({ name: 'Box', baseQty: 10, isBase: false, retailPriceMinor: 1_000_000 })
    ])
    const gadget = product('G-001', 'Gadget', 0, [unit({ name: 'Kg', retailPriceMinor: 50_000 })])
    const lamp = product('L-001', 'Lamp', 5)
    const retired = product('R-001', 'Retired', 5)
    setProductActive(db, { id: retired.id, active: false })
    const ali = customer('Ali Raza')
    const bilal = customer('Bilal Khan')

    receive('2026-08-01', widget, 50, 60_000)
    receive('2026-08-01', gadget, 20, 30_000)
    // Outside the 30-day trend.
    post('2026-08-01', ali, [sell(widget, 2, 100_000)])
    // In the trend, not this month.
    post('2026-08-25', bilal, [sell(gadget, 2, 50_000)])
    // Net goods 200,000; freight is not goods sales.
    const tenth = post('2026-09-10', bilal, [sell(gadget, 4, 50_000)], { freightMinor: 5_000 })
    // Today: net goods 1,000,000 − extra discount 10,000 = 990,000.
    const today = post('2026-09-17', ali, [sell(widget, 10, 100_000)], {
      extraDiscountMinor: 10_000
    })
    const wrong = post('2026-09-17', ali, [sell(widget, 3, 100_000)])
    // Payments are not sales. Bilal was billed 305,000 and paid 400,000: an advance of 95,000.
    pay(bilal, '2026-09-17', 400_000)
    // Ali was billed 200,000 + 990,000 (the void one is reversed) and paid 100,000: 1,090,000 due.
    pay(ali, '2026-09-17', 100_000)
    expense('2026-07-01', SHOP, 3_000)
    expense('2026-08-30', SHOP, 7_000)
    expense('2026-09-05', SHOP, 10_000)
    expense('2026-09-06', GENERAL, 40_000)
    expense('2026-09-07', PURCHASE_COST_CORRECTION_CATEGORY_ID, 5_000)
    voidExpense(db, expense('2026-09-08', SHOP, 99_900))
    voidInvoice(db, { id: wrong.id, reason: 'Entered twice', moneyReturned: false }, NOW)

    const data = dashboardData(db, NOW)
    expect(data.summary).toEqual({
      todaySalesMinor: 990_000,
      todayInvoiceCount: 1,
      monthSalesMinor: 1_190_000,
      monthInvoiceCount: 2,
      receivablesMinor: 1_090_000,
      dueCustomerCount: 1,
      advancesMinor: 95_000,
      advanceCustomerCount: 1,
      // Widget 38 × 600.00 + gadget 14 × 300.00.
      inventoryValueMinor: 2_700_000,
      activeProductCount: 3,
      lowStockCount: 2
    })

    // The same figures as Reports.
    const todaySales = salesReport(db, {
      dateFrom: '2026-09-17',
      dateTo: '2026-09-17',
      page: 1,
      pageSize: 1,
      status: 'POSTED'
    })
    const monthSales = salesReport(db, { ...SEPTEMBER, page: 1, pageSize: 1, status: 'POSTED' })
    const balances = customerBalancesReport(db)
    const expenses = expenseReport(db, { ...SEPTEMBER, page: 1, pageSize: 1, status: 'ACTIVE' })
    expect(data.summary).toMatchObject({
      todaySalesMinor: todaySales.netGoodsSalesMinor,
      todayInvoiceCount: todaySales.invoiceCount,
      monthSalesMinor: monthSales.netGoodsSalesMinor,
      monthInvoiceCount: monthSales.invoiceCount,
      receivablesMinor: balances.receivablesMinor,
      dueCustomerCount: balances.dueCount,
      advancesMinor: balances.advancesMinor,
      advanceCustomerCount: balances.advanceCount,
      inventoryValueMinor: stockReport(db).totalValueMinor
    })
    expect(data.expenseBreakdown).toEqual({
      ...SEPTEMBER,
      shopMinor: 10_000,
      generalMinor: 40_000,
      operatingMinor: 50_000,
      purchaseCostCorrectionsMinor: 5_000
    })
    expect(data.expenseBreakdown).toMatchObject({
      shopMinor: expenses.shopMinor,
      generalMinor: expenses.generalMinor,
      operatingMinor: expenses.operatingMinor,
      purchaseCostCorrectionsMinor: expenses.purchaseCostCorrectionsMinor
    })

    expect(data.salesTrend).toHaveLength(30)
    expect(data.salesTrend.filter((day) => day.invoiceCount > 0)).toEqual([
      { date: '2026-08-25', invoiceCount: 1, netGoodsSalesMinor: 100_000 },
      { date: '2026-09-10', invoiceCount: 1, netGoodsSalesMinor: 200_000 },
      { date: '2026-09-17', invoiceCount: 1, netGoodsSalesMinor: 990_000 }
    ])

    // Active products at or below their level, the emptiest first; inactive ones need no attention.
    expect(data.lowStock).toEqual([
      {
        productId: lamp.id,
        code: 'L-001',
        name: 'Lamp',
        qtyBase: 0,
        quantityText: '0 Piece',
        lowStockThresholdBase: 5,
        thresholdText: '5 Piece'
      },
      {
        productId: widget.id,
        code: 'W-001',
        name: 'Widget',
        qtyBase: 38,
        quantityText: '3 Box + 8 Piece',
        lowStockThresholdBase: 40,
        thresholdText: '4 Box'
      }
    ])

    expect(data.topProducts).toEqual(productSalesReport(db, SEPTEMBER).rows)
    expect(data.topProducts.map((row) => [row.code, row.revenueMinor])).toEqual([
      ['W-001', 1_000_000],
      ['G-001', 200_000]
    ])

    // Newest first by business date; the void invoice and expense are listed with their status.
    expect(data.recentInvoices.map((item) => [item.invoiceNo, item.status])).toEqual([
      [wrong.invoiceNo, 'VOID'],
      [today.invoiceNo, 'POSTED'],
      [tenth.invoiceNo, 'POSTED'],
      [expect.any(String), 'POSTED'],
      [expect.any(String), 'POSTED']
    ])
    expect(data.recentInvoices.map((item) => item.invoiceDate)).toEqual([
      '2026-09-17',
      '2026-09-17',
      '2026-09-10',
      '2026-08-25',
      '2026-08-01'
    ])
    expect(data.recentPayments.map((item) => [item.customerName, item.amountMinor])).toEqual([
      ['Ali Raza', 100_000],
      ['Bilal Khan', 400_000]
    ])
    expect(
      data.recentExpenses.map((item) => [item.expenseDate, item.amountMinor, item.status])
    ).toEqual([
      ['2026-09-08', 99_900, 'VOID'],
      ['2026-09-07', 5_000, 'ACTIVE'],
      ['2026-09-06', 40_000, 'ACTIVE'],
      ['2026-09-05', 10_000, 'ACTIVE'],
      ['2026-08-30', 7_000, 'ACTIVE']
    ])
    expect(data.gettingStarted).toBe(false)
  })

  it('counts every low-stock product but lists only the five most urgent', () => {
    for (const [code, stock] of [
      ['P-7', 0],
      ['P-6', 1],
      ['P-5', 0],
      ['P-4', 3],
      ['P-3', 0],
      ['P-2', 2],
      ['P-1', 0]
    ] as const) {
      const item = product(code, `Product ${code}`, 4)
      if (stock > 0) receive('2026-09-01', item, stock, 1_000)
    }
    const data = dashboardData(db, NOW)
    expect(data.summary.lowStockCount).toBe(7)
    expect(data.lowStock.map((item) => item.code)).toEqual(['P-1', 'P-3', 'P-5', 'P-7', 'P-6'])
  })

  it('lists at most five recent invoices, payments and expenses', () => {
    const item = product('W-001', 'Widget', 0)
    const buyer = customer('Ali Raza')
    receive('2026-09-01', item, 100, 1_000)
    for (let day = 1; day <= 7; day++) {
      const date = `2026-09-0${day}`
      post(date, buyer, [sell(item, 1, 100_000)])
      pay(buyer, date, 1_000)
      expense(date, SHOP, 500)
    }
    const data = dashboardData(db, NOW)
    for (const list of [data.recentInvoices, data.recentPayments, data.recentExpenses]) {
      expect(list).toHaveLength(5)
    }
    expect(data.recentPayments.map((payment) => payment.paymentDate)).toEqual([
      '2026-09-07',
      '2026-09-06',
      '2026-09-05',
      '2026-09-04',
      '2026-09-03'
    ])
  })

  it('stops getting started once there is stock on hand', () => {
    const item = product('W-001', 'Widget', 0)
    expect(dashboardData(db, NOW).gettingStarted).toBe(true)
    receive('2026-09-01', item, 1, 1_000)
    expect(dashboardData(db, NOW).gettingStarted).toBe(false)
  })

  it('uses the calendar month and the 30 days before today across month and leap-year ends', () => {
    const data = dashboardData(db, new Date(2028, 1, 10, 23, 59, 0))
    expect(data.today).toBe('2028-02-10')
    expect(data.month).toEqual({ dateFrom: '2028-02-01', dateTo: '2028-02-29' })
    expect(data.salesTrend[0].date).toBe('2028-01-12')
    expect(data.salesTrend.at(-1)!.date).toBe('2028-02-10')
    expect(dashboardData(db, new Date(2026, 11, 31, 8, 0, 0)).month).toEqual({
      dateFrom: '2026-12-01',
      dateTo: '2026-12-31'
    })
  })
})
