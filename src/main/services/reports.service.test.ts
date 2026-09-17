import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Customer, CustomerCreateInput } from '@shared/customers'
import type { ExpenseCategory } from '@shared/expenses'
import type {
  InvoiceCreateInput,
  InvoiceLineInput,
  InvoiceQuantityInput,
  InvoiceSaveResult
} from '@shared/invoices'
import type { Product, ProductUnitInput } from '@shared/products'
import {
  PURCHASE_COST_CORRECTION_CATEGORY_ID,
  type ProfitLossReport,
  type ReportPeriod
} from '@shared/reports'
import type { StockAdjustmentInput, StockReceiptDetail } from '@shared/stock'
import type { Db } from '../db/adapter'
import { createSchemaDatabase, createTempDir, thrown, type TempDir } from '../db/test-utils'
import { AppFailure } from '../errors'
import { createCustomer } from './customers.service'
import {
  createExpenseCategory,
  listExpenseCategories,
  setExpenseCategoryActive,
  updateExpenseCategory
} from './expense-categories.service'
import { createExpense, voidExpense } from './expenses.service'
import { voidInvoice } from './invoice-void.service'
import { createInvoice } from './invoices.service'
import { createPayment } from './payments.service'
import { createProduct, setProductActive } from './products.service'
import {
  customerBalancesReport,
  expenseReport,
  productSalesReport,
  profitLossReport,
  salesReport,
  stockReport
} from './reports.service'
import { adjustStock, receiveStock, voidReceipt } from './stock.service'

// Test data lives only in temporary databases. Every expected figure below is worked out by hand.

/** "Today" is 17 Sep 2026. */
const NOW = new Date(2026, 8, 17, 10, 0, 0)

const SHOP_EXPENSES = 1
const GENERAL_EXPENSES = 2
const FREIGHT_PAID = 3

let temp: TempDir
let db: Db
let requests: number
/** Piece (base; retail Rs 1,000.00) and Box of 10 (retail Rs 10,000.00). */
let widget: Product
/** Kg (base; retail Rs 500.00). */
let gadget: Product
let ali: Customer
let bilal: Customer

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  requests = 0
  widget = product('W-001', 'Widget', [
    unit({ name: 'Piece', retailPriceMinor: 100_000 }),
    unit({ name: 'Box', baseQty: 10, isBase: false, retailPriceMinor: 1_000_000 })
  ])
  gadget = product('G-001', 'Gadget', [unit({ name: 'Kg', retailPriceMinor: 50_000 })])
  ali = customer({ name: 'Ali Raza', shopName: 'Ali Traders' })
  bilal = customer({ name: 'Bilal Khan', shopName: 'Bilal Store' })
})

afterEach(() => {
  temp.remove()
})

// --- Fixtures ---------------------------------------------------------------------------------------------------------

function nextRequestId(): string {
  requests++
  return `report-request-${String(requests).padStart(4, '0')}`
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

function product(
  code: string,
  name: string,
  units: ProductUnitInput[],
  lowStockThresholdBase = 0
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

function unitId(item: Product, name: string): number {
  return item.units.find((candidate) => candidate.name === name)!.id
}

const piece = (): number => unitId(widget, 'Piece')
const box = (): number => unitId(widget, 'Box')
const kg = (): number => unitId(gadget, 'Kg')

function customer(overrides: Partial<CustomerCreateInput> = {}): Customer {
  return createCustomer(
    db,
    {
      name: 'Customer',
      shopName: null,
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

function receive(
  date: string,
  lines: Array<[productId: number, unitId: number, quantity: number, unitCostMinor: number]>
): StockReceiptDetail {
  return receiveStock(
    db,
    {
      requestId: nextRequestId(),
      receiptDate: date,
      supplierName: null,
      reference: null,
      note: null,
      currencyMinorDigits: 2,
      lines: lines.map(([productId, lineUnitId, quantity, unitCostMinor]) => ({
        productId,
        unitId: lineUnitId,
        quantity,
        unitCostMinor
      }))
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
      requestId: nextRequestId(),
      adjustmentDate: date,
      productId,
      direction: null,
      unitId: null,
      quantity: null,
      unitCostMinor: null,
      receiptItemId: null,
      reasonNote: 'Counted',
      currencyMinorDigits: 2,
      ...fields
    },
    NOW
  )
}

function qty(
  quantityUnitId: number,
  quantity: number,
  unitPriceMinor: number
): InvoiceQuantityInput {
  return { unitId: quantityUnitId, quantity, unitPriceMinor, priceOverride: false }
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

/** `count` pieces of widget at Rs 1,000.00. */
const pieces = (count: number, overrides: Partial<InvoiceLineInput> = {}): InvoiceLineInput =>
  line(widget.id, [qty(piece(), count, 100_000)], overrides)

/** `count` Kg of gadget at Rs 500.00. */
const kilos = (count: number): InvoiceLineInput => line(gadget.id, [qty(kg(), count, 50_000)])

function post(
  date: string,
  lines: InvoiceLineInput[],
  overrides: Partial<InvoiceCreateInput> = {}
): InvoiceSaveResult {
  return createInvoice(
    db,
    {
      requestId: nextRequestId(),
      invoiceDate: date,
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

function voidInvoiceNow(id: number): void {
  voidInvoice(db, { id, reason: 'Entered twice', moneyReturned: false }, NOW)
}

function pay(customerId: number, date: string, amountMinor: number): void {
  createPayment(
    db,
    {
      requestId: nextRequestId(),
      customerId,
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
      requestId: nextRequestId(),
      expenseDate: date,
      categoryId,
      amountMinor,
      description: null,
      currencyMinorDigits: 2
    },
    NOW
  ).id
}

function pl(dateFrom: string, dateTo: string): ProfitLossReport {
  return profitLossReport(db, { dateFrom, dateTo })
}

const AUGUST: ReportPeriod = { dateFrom: '2026-08-01', dateTo: '2026-08-31' }
const JULY: ReportPeriod = { dateFrom: '2026-07-01', dateTo: '2026-07-31' }

function failure(fn: () => unknown): AppFailure['error'] {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

/** The P&L lines that are zero unless a test sets them. */
const ZERO_PL = {
  goodsRevenueMinor: 0,
  cogsMinor: 0,
  grossProfitMinor: 0,
  freightIncomeMinor: 0,
  stockGainsMinor: 0,
  shopExpensesMinor: 0,
  generalExpensesMinor: 0,
  operatingExpensesMinor: 0,
  stockDamageMinor: 0,
  stockExpiryMinor: 0,
  stockShortageMinor: 0,
  stockLossesMinor: 0,
  netOperatingProfitMinor: 0,
  purchaseCostCorrectionsMinor: 0,
  inventoryCorrectionsNetMinor: 0,
  profitAfterDataCorrectionsMinor: 0
}

// --- Purchase Cost Correction category --------------------------------------------------------------------------------

describe('the Purchase Cost Correction category id', () => {
  it('is the seeded category of that name in a new database', () => {
    expect(
      listExpenseCategories(db).find((item) => item.id === PURCHASE_COST_CORRECTION_CATEGORY_ID)
    ).toMatchObject({ name: 'Purchase Cost Correction', group: 'GENERAL' })
    expect(listExpenseCategories(db).map((item): [number, string] => [item.id, item.name])).toEqual(
      expect.arrayContaining([
        [SHOP_EXPENSES, 'Shop Expenses'],
        [GENERAL_EXPENSES, 'Monthly / General Expenses'],
        [FREIGHT_PAID, 'Freight Paid']
      ])
    )
  })
})

// --- Profit & Loss ----------------------------------------------------------------------------------------------------

describe('profit and loss', () => {
  it('A: goods revenue − COGS = gross profit, less operating expenses', () => {
    receive('2026-08-01', [[widget.id, piece(), 20, 60_000]])
    post('2026-08-10', [pieces(10)])
    expense('2026-08-12', SHOP_EXPENSES, 100_000)
    expect(profitLossReport(db, AUGUST)).toMatchObject({
      ...ZERO_PL,
      dateFrom: '2026-08-01',
      dateTo: '2026-08-31',
      postedInvoiceCount: 1,
      goodsRevenueMinor: 1_000_000,
      cogsMinor: 600_000,
      grossProfitMinor: 400_000,
      shopExpensesMinor: 100_000,
      operatingExpensesMinor: 100_000,
      netOperatingProfitMinor: 300_000,
      profitAfterDataCorrectionsMinor: 300_000,
      showFrozenCogsNote: false
    })
  })

  it('B: freight charged is freight income; Freight Paid is a separate operating expense', () => {
    receive('2026-08-01', [[widget.id, piece(), 20, 60_000]])
    post('2026-08-10', [pieces(10)], { freightMinor: 50_000 })
    expense('2026-08-11', FREIGHT_PAID, 30_000)
    const report = profitLossReport(db, AUGUST)
    expect(report).toMatchObject({
      ...ZERO_PL,
      goodsRevenueMinor: 1_000_000,
      cogsMinor: 600_000,
      grossProfitMinor: 400_000,
      freightIncomeMinor: 50_000,
      shopExpensesMinor: 30_000,
      operatingExpensesMinor: 30_000,
      netOperatingProfitMinor: 420_000,
      profitAfterDataCorrectionsMinor: 420_000
    })
    expect(report.expenseCategories).toEqual([
      {
        categoryId: FREIGHT_PAID,
        name: 'Freight Paid',
        group: 'SHOP',
        isActive: true,
        isPurchaseCostCorrection: false,
        count: 1,
        amountMinor: 30_000
      }
    ])
  })

  it('C: damage, expiry and shortage are stock losses at the value their movements removed', () => {
    receive('2026-08-01', [[widget.id, piece(), 20, 60_000]])
    adjust('2026-08-05', widget.id, { reason: 'DAMAGE', unitId: piece(), quantity: 1 })
    adjust('2026-08-06', widget.id, { reason: 'EXPIRY', unitId: piece(), quantity: 1 })
    adjust('2026-08-07', widget.id, { reason: 'SHORTAGE', unitId: box(), quantity: 1 })
    expect(profitLossReport(db, AUGUST)).toMatchObject({
      ...ZERO_PL,
      stockDamageMinor: 60_000,
      stockExpiryMinor: 60_000,
      stockShortageMinor: 600_000,
      stockLossesMinor: 720_000,
      netOperatingProfitMinor: -720_000,
      profitAfterDataCorrectionsMinor: -720_000
    })
    // The same figures as the movement ledger.
    expect(
      db.get<{ v: number }>(
        "SELECT sum(value_minor) AS v FROM stock_movements WHERE type = 'ADJUST_OUT'"
      )!.v
    ).toBe(-720_000)
  })

  it('D: a count surplus is a stock gain that increases operating profit', () => {
    receive('2026-08-01', [[widget.id, piece(), 20, 60_000]])
    post('2026-08-10', [pieces(10)])
    adjust('2026-08-20', widget.id, { reason: 'COUNT_SURPLUS', unitId: piece(), quantity: 2 })
    expect(profitLossReport(db, AUGUST)).toMatchObject({
      ...ZERO_PL,
      goodsRevenueMinor: 1_000_000,
      cogsMinor: 600_000,
      grossProfitMinor: 400_000,
      stockGainsMinor: 120_000,
      netOperatingProfitMinor: 520_000,
      profitAfterDataCorrectionsMinor: 520_000
    })
  })

  it('E: a void invoice leaves revenue, COGS and freight', () => {
    receive('2026-08-01', [[widget.id, piece(), 20, 60_000]])
    post('2026-08-10', [pieces(10)], { freightMinor: 10_000 })
    const wrong = post('2026-08-11', [pieces(3)], { freightMinor: 5_000 })
    expect(profitLossReport(db, AUGUST)).toMatchObject({
      postedInvoiceCount: 2,
      goodsRevenueMinor: 1_300_000,
      cogsMinor: 780_000,
      freightIncomeMinor: 15_000
    })
    voidInvoiceNow(wrong.id)
    expect(profitLossReport(db, AUGUST)).toMatchObject({
      postedInvoiceCount: 1,
      goodsRevenueMinor: 1_000_000,
      cogsMinor: 600_000,
      grossProfitMinor: 400_000,
      freightIncomeMinor: 10_000,
      netOperatingProfitMinor: 410_000
    })
    // The void date (September) adds nothing to September either.
    expect(pl('2026-09-01', '2026-09-30')).toMatchObject(ZERO_PL)
  })

  it('F: a void expense leaves the expenses', () => {
    expense('2026-08-02', SHOP_EXPENSES, 10_000)
    const wrong = expense('2026-08-03', GENERAL_EXPENSES, 90_000)
    expect(profitLossReport(db, AUGUST).operatingExpensesMinor).toBe(100_000)
    voidExpense(db, wrong)
    expect(profitLossReport(db, AUGUST)).toMatchObject({
      ...ZERO_PL,
      shopExpensesMinor: 10_000,
      operatingExpensesMinor: 10_000,
      netOperatingProfitMinor: -10_000,
      profitAfterDataCorrectionsMinor: -10_000
    })
  })

  it('G: Purchase Cost Correction expenses are shown below Net Operating Profit, by category id', () => {
    expense('2026-08-02', SHOP_EXPENSES, 10_000)
    expense('2026-08-03', PURCHASE_COST_CORRECTION_CATEGORY_ID, 25_000)
    const expected = {
      ...ZERO_PL,
      shopExpensesMinor: 10_000,
      operatingExpensesMinor: 10_000,
      netOperatingProfitMinor: -10_000,
      purchaseCostCorrectionsMinor: 25_000,
      profitAfterDataCorrectionsMinor: -35_000,
      showFrozenCogsNote: true
    }
    expect(profitLossReport(db, AUGUST)).toMatchObject(expected)

    // Renamed, it is still the purchase cost correction category; a new category with the old name is not.
    updateExpenseCategory(db, {
      id: PURCHASE_COST_CORRECTION_CATEGORY_ID,
      name: 'Supplier Price Fixes',
      group: 'GENERAL'
    })
    const lookalike = createExpenseCategory(db, {
      name: 'Purchase Cost Correction',
      group: 'GENERAL'
    })
    expense('2026-08-04', lookalike.id, 5_000)
    const report = profitLossReport(db, AUGUST)
    expect(report).toMatchObject({
      ...expected,
      generalExpensesMinor: 5_000,
      operatingExpensesMinor: 15_000,
      netOperatingProfitMinor: -15_000,
      profitAfterDataCorrectionsMinor: -40_000
    })
    expect(
      report.expenseCategories.map((item) => [item.name, item.isPurchaseCostCorrection])
    ).toEqual([
      ['Supplier Price Fixes', true],
      ['Shop Expenses', false],
      ['Purchase Cost Correction', false]
    ])
  })

  it('H: inventory data corrections are shown separately, once, outside operating profit', () => {
    const receipt = receive('2026-08-01', [[widget.id, piece(), 20, 60_000]])
    const receiptItemId = receipt.lines[0].id
    // Cost 60,000 → 61,000 on 20 pieces: +20,000. Stock Q 20, V 1,220,000.
    adjust('2026-08-02', widget.id, {
      reason: 'RECEIPT_COST_CORRECTION',
      receiptItemId,
      unitCostMinor: 61_000
    })
    // 2 pieces too many received, at the average 61,000: −122,000.
    adjust('2026-08-03', widget.id, {
      reason: 'RECEIPT_QTY_CORRECTION',
      direction: 'OUT',
      receiptItemId,
      unitId: piece(),
      quantity: 2
    })
    // 2 pieces missed at 50,000: +100,000.
    adjust('2026-08-04', widget.id, {
      reason: 'OTHER_CORRECTION',
      direction: 'IN',
      unitId: piece(),
      quantity: 2,
      unitCostMinor: 50_000
    })
    const report = profitLossReport(db, AUGUST)
    expect(report).toMatchObject({
      ...ZERO_PL,
      inventoryCorrectionsNetMinor: -2_000,
      profitAfterDataCorrectionsMinor: -2_000,
      showFrozenCogsNote: true
    })
    expect(report.inventoryCorrections).toEqual([
      {
        reason: 'RECEIPT_QTY_CORRECTION',
        count: 1,
        valueAddedMinor: 0,
        valueRemovedMinor: 122_000,
        netValueMinor: -122_000
      },
      {
        reason: 'RECEIPT_COST_CORRECTION',
        count: 1,
        valueAddedMinor: 20_000,
        valueRemovedMinor: 0,
        netValueMinor: 20_000
      },
      {
        reason: 'OTHER_CORRECTION',
        count: 1,
        valueAddedMinor: 100_000,
        valueRemovedMinor: 0,
        netValueMinor: 100_000
      }
    ])
    expect(
      report.inventoryCorrectionDetails.map((item) => [
        item.adjustmentDate,
        item.reason,
        item.productCode,
        item.qtyBase,
        item.quantityText,
        item.valueMinor
      ])
    ).toEqual([
      ['2026-08-02', 'RECEIPT_COST_CORRECTION', 'W-001', 0, null, 20_000],
      ['2026-08-03', 'RECEIPT_QTY_CORRECTION', 'W-001', -2, '−2 Piece', -122_000],
      ['2026-08-04', 'OTHER_CORRECTION', 'W-001', 2, '+2 Piece', 100_000]
    ])
    // Counted once: the corrections plus the receipt are exactly the inventory value.
    expect(stockReport(db).totalValueMinor).toBe(1_200_000 - 2_000)
  })

  it('I and J: opening stock, receipts and receipt voids are not profit', () => {
    adjust('2026-08-01', gadget.id, {
      reason: 'OPENING_STOCK',
      unitId: kg(),
      quantity: 10,
      unitCostMinor: 40_000
    })
    const receipt = receive('2026-08-02', [[widget.id, piece(), 20, 60_000]])
    receive('2026-08-03', [[gadget.id, kg(), 5, 45_000]])
    voidReceipt(db, { id: receipt.id, reason: 'Wrong supplier' }, NOW)
    const report = pl('2026-08-01', '2026-09-30')
    expect(report).toMatchObject({
      ...ZERO_PL,
      postedInvoiceCount: 0,
      openingStockValueMinor: 400_000
    })
    expect(report.inventoryCorrections.every((item) => item.count === 0)).toBe(true)
    expect(report.expenseCategories).toEqual([])
    expect(stockReport(db).totalValueMinor).toBe(400_000 + 225_000)
  })

  it('payments are not revenue, and customer payment voids do not touch the P&L', () => {
    receive('2026-08-01', [[widget.id, piece(), 20, 60_000]])
    post('2026-08-10', [pieces(10)], { receivedMinor: 400_000, paymentMethod: 'CASH' })
    pay(ali.id, '2026-08-11', 300_000)
    expect(profitLossReport(db, AUGUST)).toMatchObject({
      goodsRevenueMinor: 1_000_000,
      netOperatingProfitMinor: 400_000
    })
  })
})

// --- Periods ----------------------------------------------------------------------------------------------------------

describe('report periods', () => {
  beforeEach(() => {
    receive('2026-07-01', [[widget.id, piece(), 100, 60_000]])
    for (const date of ['2026-07-31', '2026-08-01', '2026-08-31', '2026-09-01']) {
      post(date, [pieces(1)])
      adjust(date, widget.id, { reason: 'DAMAGE', unitId: piece(), quantity: 1 })
      expense(date, SHOP_EXPENSES, 1_000)
    }
  })

  it('includes both ends of the range and stops at month boundaries', () => {
    expect(profitLossReport(db, AUGUST)).toMatchObject({
      postedInvoiceCount: 2,
      goodsRevenueMinor: 200_000,
      cogsMinor: 120_000,
      stockDamageMinor: 120_000,
      shopExpensesMinor: 2_000
    })
    expect(pl('2026-08-31', '2026-08-31')).toMatchObject({
      postedInvoiceCount: 1,
      goodsRevenueMinor: 100_000,
      stockDamageMinor: 60_000,
      shopExpensesMinor: 1_000
    })
    expect(pl('2026-07-01', '2026-07-30')).toMatchObject({ ...ZERO_PL, postedInvoiceCount: 0 })
    expect(pl('2026-07-01', '2026-09-30')).toMatchObject({
      postedInvoiceCount: 4,
      goodsRevenueMinor: 400_000,
      stockDamageMinor: 240_000,
      shopExpensesMinor: 4_000
    })
  })

  it('uses business dates, not when a record was created', () => {
    // Every record was created today (September or later), yet July holds its July-dated records.
    const createdDates = db.all<{ d: string }>(
      `SELECT substr(created_at, 1, 10) AS d FROM invoices
       UNION ALL SELECT substr(created_at, 1, 10) FROM expenses
       UNION ALL SELECT substr(created_at, 1, 10) FROM stock_adjustments`
    )
    expect(createdDates.every((row) => row.d > '2026-08-31')).toBe(true)
    expect(profitLossReport(db, JULY)).toMatchObject({
      postedInvoiceCount: 1,
      goodsRevenueMinor: 100_000,
      stockDamageMinor: 60_000,
      shopExpensesMinor: 1_000
    })
    expect(salesReport(db, { ...JULY, page: 1, pageSize: 10, status: 'all' })).toMatchObject({
      invoiceCount: 1
    })
    expect(expenseReport(db, { ...JULY, page: 1, pageSize: 10, status: 'all' })).toMatchObject({
      shopMinor: 1_000,
      expenses: { total: 1 }
    })
  })

  it('refuses an end date before the start date, and dates that do not exist', () => {
    expect(
      failure(() => profitLossReport(db, { dateFrom: '2026-08-31', dateTo: '2026-08-01' }))
    ).toEqual({
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors: { dateTo: ['The end date cannot be before the start date.'] }
    })
    expect(
      failure(() => productSalesReport(db, { dateFrom: '2026-02-30', dateTo: '2026-03-01' }))
    ).toMatchObject({ code: 'VALIDATION', fieldErrors: { dateFrom: ['Enter a valid date.'] } })
    expect(failure(() => profitLossReport(db, { dateFrom: '2026-08-01' }))).toMatchObject({
      code: 'VALIDATION'
    })
    expect(
      failure(() => salesReport(db, { ...AUGUST, page: 1, pageSize: 500, status: 'POSTED' }))
    ).toMatchObject({ code: 'VALIDATION' })
    expect(
      failure(() => expenseReport(db, { ...AUGUST, page: 1, pageSize: 10, status: 'POSTED' }))
    ).toMatchObject({ code: 'VALIDATION' })
  })
})

// --- Sales --------------------------------------------------------------------------------------------------------------

describe('sales report', () => {
  it('totals posted invoices with discounts, schemes, freight and COGS; void invoices only for information', () => {
    receive('2026-08-01', [[widget.id, piece(), 50, 60_000]])
    // Gross 1,000,000 − discount 10,000 − scheme 5,000 − extra 20,000 = net 965,000; freight 30,000 → 995,000.
    // 10 sold + 1 free piece: COGS 660,000.
    const first = post(
      '2026-08-10',
      [
        pieces(10, {
          discount: { type: 'AMOUNT', amountMinor: 10_000 },
          schemeMinor: 5_000,
          freeQuantities: [{ unitId: piece(), quantity: 1 }]
        })
      ],
      { extraDiscountMinor: 20_000, freightMinor: 30_000 }
    )
    const second = post('2026-08-12', [pieces(2)], { customerId: bilal.id })
    const wrong = post('2026-08-13', [pieces(5)], { freightMinor: 1_000 })
    voidInvoiceNow(wrong.id)

    const report = salesReport(db, { ...AUGUST, page: 1, pageSize: 25, status: 'POSTED' })
    expect(report).toMatchObject({
      invoiceCount: 2,
      grossSalesMinor: 1_200_000,
      lineDiscountMinor: 10_000,
      extraDiscountMinor: 20_000,
      discountMinor: 30_000,
      schemeDiscountMinor: 5_000,
      netGoodsSalesMinor: 1_165_000,
      freightChargedMinor: 30_000,
      totalBilledMinor: 1_195_000,
      cogsMinor: 780_000,
      grossProfitMinor: 385_000,
      voidInvoiceCount: 1,
      voidTotalMinor: 501_000
    })
    expect(report.invoices).toEqual({
      items: [
        {
          id: first.id,
          invoiceNo: first.invoiceNo,
          invoiceDate: '2026-08-10',
          customerName: 'Ali Raza',
          customerShopName: 'Ali Traders',
          status: 'POSTED',
          grossMinor: 1_000_000,
          discountMinor: 30_000,
          schemeMinor: 5_000,
          netMinor: 965_000,
          freightMinor: 30_000,
          totalMinor: 995_000,
          cogsMinor: 660_000,
          grossProfitMinor: 305_000
        },
        expect.objectContaining({ id: second.id, netMinor: 200_000, cogsMinor: 120_000 })
      ],
      total: 2,
      page: 1,
      pageSize: 25
    })
    // The P&L agrees.
    expect(profitLossReport(db, AUGUST)).toMatchObject({
      goodsRevenueMinor: report.netGoodsSalesMinor,
      cogsMinor: report.cogsMinor,
      freightIncomeMinor: report.freightChargedMinor
    })

    const voids = salesReport(db, { ...AUGUST, page: 1, pageSize: 25, status: 'VOID' })
    expect(voids.invoiceCount).toBe(2)
    expect(voids.invoices.items.map((item) => [item.id, item.status])).toEqual([[wrong.id, 'VOID']])
    const all = salesReport(db, { ...AUGUST, page: 2, pageSize: 2, status: 'all' })
    expect(all.invoices).toMatchObject({ total: 3, page: 2, pageSize: 2 })
    expect(all.invoices.items.map((item) => item.id)).toEqual([wrong.id])
  })
})

// --- Product sales ------------------------------------------------------------------------------------------------------

describe('product sales report', () => {
  it('groups by product: base quantity with free goods, line revenue, frozen COGS and profit', () => {
    receive('2026-08-01', [
      [widget.id, piece(), 50, 60_000],
      [gadget.id, kg(), 20, 30_000]
    ])
    // 1 Box + 5 Piece = 1,500,000 for 15 pieces, plus 1 free piece: 16 pieces, COGS 960,000.
    post(
      '2026-08-10',
      [
        line(widget.id, [qty(box(), 1, 1_000_000), qty(piece(), 5, 100_000)], {
          freeQuantities: [{ unitId: piece(), quantity: 1 }]
        }),
        kilos(3)
      ],
      { extraDiscountMinor: 20_000 }
    )
    post('2026-08-11', [kilos(1)], { customerId: bilal.id })
    const wrong = post('2026-08-12', [pieces(4)])
    // Outside the period.
    post('2026-09-01', [pieces(1)])
    voidInvoiceNow(wrong.id)

    const report = productSalesReport(db, AUGUST)
    expect(report.rows).toEqual([
      {
        productId: widget.id,
        code: 'W-001',
        name: 'Widget',
        companyName: null,
        invoiceCount: 1,
        qtyBase: 16,
        quantityText: '1 Box + 6 Piece',
        schemeQtyBase: 1,
        revenueMinor: 1_500_000,
        cogsMinor: 960_000,
        grossProfitMinor: 540_000
      },
      {
        productId: gadget.id,
        code: 'G-001',
        name: 'Gadget',
        companyName: null,
        invoiceCount: 2,
        qtyBase: 4,
        quantityText: '4 Kg',
        schemeQtyBase: 0,
        revenueMinor: 200_000,
        cogsMinor: 120_000,
        grossProfitMinor: 80_000
      }
    ])
    expect(report).toMatchObject({
      revenueMinor: 1_700_000,
      cogsMinor: 1_080_000,
      grossProfitMinor: 620_000,
      extraDiscountMinor: 20_000,
      netGoodsSalesMinor: 1_680_000
    })
    // Reconciles with the sales report and the P&L.
    const sales = salesReport(db, { ...AUGUST, page: 1, pageSize: 25, status: 'POSTED' })
    expect(report.netGoodsSalesMinor).toBe(sales.netGoodsSalesMinor)
    expect(report.cogsMinor).toBe(sales.cogsMinor)
  })

  it('keeps old revenue when a price changes later', () => {
    receive('2026-08-01', [[widget.id, piece(), 5, 60_000]])
    post('2026-08-10', [pieces(2)])
    db.run('UPDATE product_units SET retail_price_minor = 999_999 WHERE id = ?', [piece()])
    expect(productSalesReport(db, AUGUST).rows[0].revenueMinor).toBe(200_000)
  })
})

// --- Stock ---------------------------------------------------------------------------------------------------------------

describe('stock report', () => {
  it('reads quantity and value from the movement ledger, with zero stock, low stock and inactive products', () => {
    const lowItem = product('L-001', 'Lamp', [unit({ name: 'Piece', retailPriceMinor: 10_000 })], 5)
    const retired = product('R-001', 'Retired', [unit({ name: 'Piece' })])
    setProductActive(db, { id: retired.id, active: false })
    receive('2026-08-01', [
      [widget.id, box(), 2, 500_000],
      [widget.id, piece(), 3, 50_000],
      [lowItem.id, unitId(lowItem, 'Piece'), 3, 7_000],
      [gadget.id, kg(), 2, 30_000]
    ])
    post('2026-08-02', [kilos(2)])

    const report = stockReport(db)
    expect(report.rows).toEqual([
      expect.objectContaining({
        code: 'G-001',
        qtyBase: 0,
        quantityText: '0 Kg',
        valueMinor: 0,
        level: 'OUT_OF_STOCK',
        isActive: true
      }),
      expect.objectContaining({
        code: 'L-001',
        qtyBase: 3,
        quantityText: '3 Piece',
        valueMinor: 21_000,
        lowStockThresholdBase: 5,
        level: 'LOW'
      }),
      expect.objectContaining({
        code: 'R-001',
        qtyBase: 0,
        valueMinor: 0,
        level: 'OUT_OF_STOCK',
        isActive: false
      }),
      {
        productId: widget.id,
        code: 'W-001',
        name: 'Widget',
        companyName: null,
        isActive: true,
        qtyBase: 23,
        quantityText: '2 Box + 3 Piece',
        valueMinor: 1_150_000,
        lowStockThresholdBase: 0,
        level: 'OK'
      }
    ])
    expect(report).toMatchObject({
      totalValueMinor: 1_171_000,
      lowStockCount: 1,
      outOfStockCount: 2
    })
    const ledger = db.get<{ v: number }>('SELECT sum(value_minor) AS v FROM stock_movements')!.v
    expect(report.totalValueMinor).toBe(ledger)
  })
})

// --- Customer balances ----------------------------------------------------------------------------------------------------

describe('customer balances report', () => {
  it('shows due, advance and settled balances from the ledger, with receivables and advances apart', () => {
    receive('2026-08-01', [[widget.id, piece(), 10, 60_000]])
    const due = customer({
      name: 'Dawood',
      opening: { side: 'DUE', amountMinor: 100_000, date: '2026-08-01' }
    })
    const advance = customer({
      name: 'Ehsan',
      opening: { side: 'ADVANCE', amountMinor: 50_000, date: '2026-08-01' }
    })
    // Ali: invoiced 200,000 then paid in full: settled. Bilal: a void invoice leaves him settled.
    post('2026-08-02', [pieces(2)])
    pay(ali.id, '2026-08-03', 200_000)
    voidInvoiceNow(post('2026-08-04', [pieces(1)], { customerId: bilal.id }).id)

    const report = customerBalancesReport(db)
    expect(report.rows.map((row) => [row.code, row.name, row.balanceMinor, row.state])).toEqual([
      ['C-00001', 'Cash / Walk-in', 0, 'SETTLED'],
      ['C-00002', 'Ali Raza', 0, 'SETTLED'],
      ['C-00003', 'Bilal Khan', 0, 'SETTLED'],
      ['C-00004', 'Dawood', 100_000, 'DUE'],
      ['C-00005', 'Ehsan', -50_000, 'ADVANCE']
    ])
    expect(report.rows[1]).toEqual({
      customerId: ali.id,
      code: 'C-00002',
      name: 'Ali Raza',
      shopName: 'Ali Traders',
      city: null,
      isActive: true,
      balanceMinor: 0,
      state: 'SETTLED'
    })
    expect(report).toMatchObject({
      receivablesMinor: 100_000,
      advancesMinor: 50_000,
      netMinor: 50_000,
      dueCount: 1,
      advanceCount: 1,
      settledCount: 3
    })
    expect(due.id).toBeGreaterThan(0)
    expect(advance.id).toBeGreaterThan(0)
  })
})

// --- Expenses -----------------------------------------------------------------------------------------------------------

describe('expense report', () => {
  function category(name: string): ExpenseCategory {
    return listExpenseCategories(db).find((item) => item.name === name)!
  }

  it('totals Shop and Monthly / General apart from purchase cost corrections, with void rows only on request', () => {
    const rent = createExpenseCategory(db, { name: 'Rent', group: 'GENERAL' })
    expense('2026-08-01', SHOP_EXPENSES, 10_000)
    expense('2026-08-02', FREIGHT_PAID, 4_000)
    expense('2026-08-03', rent.id, 50_000)
    expense('2026-08-04', GENERAL_EXPENSES, 6_000)
    expense('2026-08-05', PURCHASE_COST_CORRECTION_CATEGORY_ID, 3_000)
    voidExpense(db, expense('2026-08-06', SHOP_EXPENSES, 99_000))
    expense('2026-09-01', SHOP_EXPENSES, 77_000)

    const report = expenseReport(db, { ...AUGUST, page: 1, pageSize: 25, status: 'ACTIVE' })
    expect(report).toMatchObject({
      shopMinor: 14_000,
      generalMinor: 56_000,
      operatingMinor: 70_000,
      purchaseCostCorrectionsMinor: 3_000,
      totalActiveMinor: 73_000,
      voidCount: 1,
      voidMinor: 99_000
    })
    expect(
      report.categories.map((item) => [item.name, item.group, item.count, item.amountMinor])
    ).toEqual([
      ['Rent', 'GENERAL', 1, 50_000],
      ['Shop Expenses', 'SHOP', 1, 10_000],
      ['Monthly / General Expenses', 'GENERAL', 1, 6_000],
      ['Freight Paid', 'SHOP', 1, 4_000],
      ['Purchase Cost Correction', 'GENERAL', 1, 3_000]
    ])
    expect(report.expenses.total).toBe(5)
    expect(report.expenses.items.every((item) => item.status === 'ACTIVE')).toBe(true)
    const voids = expenseReport(db, { ...AUGUST, page: 1, pageSize: 25, status: 'VOID' })
    expect(voids.expenses.items.map((item) => item.amountMinor)).toEqual([99_000])
    // The totals never include void expenses, whichever rows are listed.
    expect(voids.totalActiveMinor).toBe(73_000)
    expect(
      expenseReport(db, { ...AUGUST, page: 1, pageSize: 25, status: 'all' }).expenses.total
    ).toBe(6)

    // The P&L uses the same split.
    expect(profitLossReport(db, AUGUST)).toMatchObject({
      shopExpensesMinor: 14_000,
      generalExpensesMinor: 56_000,
      operatingExpensesMinor: 70_000,
      purchaseCostCorrectionsMinor: 3_000
    })
  })

  it('keeps historical classification: inactive and renamed categories stay in their locked group', () => {
    const rent = createExpenseCategory(db, { name: 'Rent', group: 'GENERAL' })
    expense('2026-08-03', rent.id, 50_000)
    expense('2026-08-04', SHOP_EXPENSES, 10_000)
    const before = expenseReport(db, { ...AUGUST, page: 1, pageSize: 25, status: 'ACTIVE' })

    setExpenseCategoryActive(db, { id: rent.id, active: false })
    updateExpenseCategory(db, { id: SHOP_EXPENSES, name: 'Counter Costs', group: 'SHOP' })
    expect(
      thrown(() => updateExpenseCategory(db, { id: rent.id, name: 'Rent', group: 'SHOP' }))
    ).toBeInstanceOf(AppFailure)

    const after = expenseReport(db, { ...AUGUST, page: 1, pageSize: 25, status: 'ACTIVE' })
    expect(after).toMatchObject({
      shopMinor: before.shopMinor,
      generalMinor: before.generalMinor,
      operatingMinor: 60_000
    })
    expect(after.categories).toEqual([
      expect.objectContaining({
        name: 'Rent',
        group: 'GENERAL',
        isActive: false,
        amountMinor: 50_000
      }),
      expect.objectContaining({ name: 'Counter Costs', group: 'SHOP', amountMinor: 10_000 })
    ])
    expect(category('Rent').group).toBe('GENERAL')
    expect(after.expenses.items.map((item) => [item.categoryName, item.categoryGroup])).toEqual([
      ['Counter Costs', 'SHOP'],
      ['Rent', 'GENERAL']
    ])
  })
})

// --- Money safety -------------------------------------------------------------------------------------------------------

describe('report money safety', () => {
  it('refuses totals too large to show exactly instead of rounding them', () => {
    // Two amounts whose sum passes Number.MAX_SAFE_INTEGER (written directly: no form accepts them).
    db.run(
      `INSERT INTO expenses (request_id, expense_date, category_id, amount_minor) VALUES
         ('big-1', '2026-08-01', 1, 9007199254740000), ('big-2', '2026-08-02', 1, 9007199254740000)`
    )
    const tooLarge = {
      code: 'VALIDATION',
      message: 'The report totals are too large to show exactly.'
    }
    expect(failure(() => profitLossReport(db, AUGUST))).toEqual(tooLarge)
    expect(
      failure(() => expenseReport(db, { ...AUGUST, page: 1, pageSize: 25, status: 'ACTIVE' }))
    ).toEqual(tooLarge)
  })

  it('refuses a too-large total that no later arithmetic would catch (the void expense total)', () => {
    db.run(
      `INSERT INTO expenses (request_id, expense_date, category_id, amount_minor, status) VALUES
         ('big-1', '2026-08-01', 1, 9007199254740000, 'VOID'), ('big-2', '2026-08-02', 1, 9007199254740000, 'VOID')`
    )
    expect(
      failure(() => expenseReport(db, { ...AUGUST, page: 1, pageSize: 25, status: 'ACTIVE' }))
    ).toEqual({ code: 'VALIDATION', message: 'The report totals are too large to show exactly.' })
  })
})

// --- Cross-check ----------------------------------------------------------------------------------------------------------

describe('integrated scenario', () => {
  it('agrees with the stock movement and customer ledgers', () => {
    // Opening stock: gadget 10 Kg @ 30,000 (V 300,000). Receipt: widget 20 Piece @ 60,000 (V 1,200,000).
    adjust('2026-07-01', gadget.id, {
      reason: 'OPENING_STOCK',
      unitId: kg(),
      quantity: 10,
      unitCostMinor: 30_000
    })
    receive('2026-07-02', [[widget.id, piece(), 20, 60_000]])
    // Sale 1 to Ali: 5 Piece = 500,000, COGS 300,000. Partial payment 200,000.
    post('2026-07-05', [pieces(5)])
    pay(ali.id, '2026-07-06', 200_000)
    // Sale 2 to Bilal: 2 Kg (100,000; COGS 60,000) + 3 Piece (300,000; COGS 180,000), freight 20,000.
    post('2026-07-08', [kilos(2), pieces(3)], { customerId: bilal.id, freightMinor: 20_000 })
    // Damage 1 Piece (−60,000). Count surplus 1 Kg at the gadget average 30,000 (+30,000).
    adjust('2026-07-10', widget.id, { reason: 'DAMAGE', unitId: piece(), quantity: 1 })
    adjust('2026-07-11', gadget.id, { reason: 'COUNT_SURPLUS', unitId: kg(), quantity: 1 })
    expense('2026-07-12', SHOP_EXPENSES, 15_000)
    expense('2026-07-12', GENERAL_EXPENSES, 40_000)
    expense('2026-07-13', PURCHASE_COST_CORRECTION_CATEGORY_ID, 5_000)
    // Sale 3 to Ali (2 Piece, 200,000), voided today; Ali's payment stays posted.
    voidInvoiceNow(post('2026-07-14', [pieces(2)]).id)
    voidExpense(db, expense('2026-07-15', SHOP_EXPENSES, 7_000))

    // Independently from the ledgers.
    const stock = (productId: number): { q: number; v: number } =>
      db.get<{ q: number; v: number }>(
        'SELECT sum(qty_base) AS q, sum(value_minor) AS v FROM stock_movements WHERE product_id = ?',
        [productId]
      )!
    const balance = (customerId: number): number =>
      db.get<{ b: number }>(
        'SELECT coalesce(sum(amount_minor), 0) AS b FROM customer_ledger WHERE customer_id = ?',
        [customerId]
      )!.b
    expect(stock(widget.id)).toEqual({ q: 11, v: 660_000 })
    expect(stock(gadget.id)).toEqual({ q: 9, v: 270_000 })
    expect(balance(ali.id)).toBe(300_000)
    expect(balance(bilal.id)).toBe(420_000)

    expect(profitLossReport(db, JULY)).toMatchObject({
      postedInvoiceCount: 2,
      goodsRevenueMinor: 900_000,
      cogsMinor: 540_000,
      grossProfitMinor: 360_000,
      freightIncomeMinor: 20_000,
      stockGainsMinor: 30_000,
      shopExpensesMinor: 15_000,
      generalExpensesMinor: 40_000,
      operatingExpensesMinor: 55_000,
      stockDamageMinor: 60_000,
      stockExpiryMinor: 0,
      stockShortageMinor: 0,
      stockLossesMinor: 60_000,
      netOperatingProfitMinor: 295_000,
      purchaseCostCorrectionsMinor: 5_000,
      inventoryCorrectionsNetMinor: 0,
      profitAfterDataCorrectionsMinor: 290_000,
      openingStockValueMinor: 300_000,
      showFrozenCogsNote: true
    })
    // COGS agrees with the frozen line costs and the sale movements of the posted invoices.
    expect(
      db.get<{ c: number }>(
        `SELECT -sum(m.value_minor) AS c FROM stock_movements AS m
         JOIN invoice_items AS ii ON ii.id = m.invoice_item_id JOIN invoices AS i ON i.id = ii.invoice_id
         WHERE m.type = 'SALE' AND i.status = 'POSTED'`
      )!.c
    ).toBe(540_000)

    expect(salesReport(db, { ...JULY, page: 1, pageSize: 25, status: 'POSTED' })).toMatchObject({
      invoiceCount: 2,
      grossSalesMinor: 900_000,
      discountMinor: 0,
      schemeDiscountMinor: 0,
      netGoodsSalesMinor: 900_000,
      freightChargedMinor: 20_000,
      totalBilledMinor: 920_000,
      cogsMinor: 540_000,
      grossProfitMinor: 360_000,
      voidInvoiceCount: 1,
      voidTotalMinor: 200_000
    })
    expect(productSalesReport(db, JULY)).toMatchObject({
      revenueMinor: 900_000,
      cogsMinor: 540_000,
      netGoodsSalesMinor: 900_000
    })
    expect(expenseReport(db, { ...JULY, page: 1, pageSize: 25, status: 'ACTIVE' })).toMatchObject({
      shopMinor: 15_000,
      generalMinor: 40_000,
      operatingMinor: 55_000,
      purchaseCostCorrectionsMinor: 5_000,
      totalActiveMinor: 60_000,
      voidCount: 1,
      voidMinor: 7_000
    })

    const stockNow = stockReport(db)
    expect(
      stockNow.rows.map((row) => [row.code, row.qtyBase, row.valueMinor, row.quantityText])
    ).toEqual([
      ['G-001', 9, 270_000, '9 Kg'],
      ['W-001', 11, 660_000, '1 Box + 1 Piece']
    ])
    expect(stockNow.totalValueMinor).toBe(930_000)

    const balances = customerBalancesReport(db)
    expect(balances.rows.map((row) => [row.code, row.balanceMinor, row.state])).toEqual([
      ['C-00001', 0, 'SETTLED'],
      ['C-00002', 300_000, 'DUE'],
      ['C-00003', 420_000, 'DUE']
    ])
    expect(balances).toMatchObject({
      receivablesMinor: 720_000,
      advancesMinor: 0,
      netMinor: 720_000
    })
  })
})
