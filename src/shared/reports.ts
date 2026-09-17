import { z } from 'zod'
import type { BalanceState, ListPage } from './customers'
import type { Expense, ExpenseGroup } from './expenses'
import type { AdjustmentReason } from './stock'
import { DateSchema, wholeNumber } from './validation'

/*
 * Reports and Profit & Loss (Phase 11). Every figure is DERIVED on request from the saved business records: nothing is
 * stored, and no report total can be edited.
 *
 * - Sales come from POSTED invoices by invoice_date, at their saved values: goods revenue is the invoice net (after
 *   discounts and schemes, before freight), freight charged is freight income, and COGS is the cost frozen on the
 *   invoice when it was posted. VOID invoices contribute nothing. Money received is not revenue.
 * - Stock gains and losses are the signed values of the adjustments' own stock movements, by adjustment_date.
 * - Expenses are ACTIVE expenses by expense_date, by their category's group (locked once a category is used).
 * - Current-state reports (stock, customer balances) read the stock movement and customer ledgers.
 * All money is whole minor units.
 */

/**
 * The seeded "Purchase Cost Correction" expense category. Migration 0001 inserts the four seeded categories, in this
 * order, into the new empty table, so their ids are always 1–4; migration 0001 is frozen, categories are never deleted,
 * and ids never change. Its NAME may be renamed, so reports identify it only by this id.
 */
export const PURCHASE_COST_CORRECTION_CATEGORY_ID = 4

/** Limitation L1: shown on the P&L when the period has purchase-cost corrections. */
export const FROZEN_COGS_NOTE =
  'Historical COGS is frozen when an invoice is posted. Later purchase-cost corrections affect future inventory valuation and future COGS only.'

export const MAX_REPORT_PAGE_SIZE = 100

const RANGE_ERROR = { path: ['dateTo'], message: 'The end date cannot be before the start date.' }

const periodFields = {
  /** Inclusive business dates. */
  dateFrom: DateSchema,
  dateTo: DateSchema
}

function validPeriod(input: { dateFrom: string; dateTo: string }): boolean {
  return input.dateFrom <= input.dateTo
}

/** `window.api.reports.profitLoss(...)` and `productSales(...)`: an inclusive business-date range. */
export const ReportPeriodSchema = z.strictObject(periodFields).refine(validPeriod, RANGE_ERROR)
export type ReportPeriod = z.output<typeof ReportPeriodSchema>

const pageFields = {
  page: wholeNumber(1, 1_000_000),
  pageSize: wholeNumber(1, MAX_REPORT_PAGE_SIZE)
}

/** `window.api.reports.sales(...)`: totals of the period, and one page of its invoices. */
export const SalesReportInputSchema = z
  .strictObject({
    ...periodFields,
    ...pageFields,
    /** Which invoices the table lists. Totals always count POSTED invoices only. */
    status: z.enum(['POSTED', 'VOID', 'all'])
  })
  .refine(validPeriod, RANGE_ERROR)
export type SalesReportInput = z.output<typeof SalesReportInputSchema>

/** `window.api.reports.expenses(...)`: totals of the period, and one page of its expenses. */
export const ExpenseReportInputSchema = z
  .strictObject({
    ...periodFields,
    ...pageFields,
    /** Which expenses the table lists. Totals always count ACTIVE expenses only. */
    status: z.enum(['ACTIVE', 'VOID', 'all'])
  })
  .refine(validPeriod, RANGE_ERROR)
export type ExpenseReportInput = z.output<typeof ExpenseReportInputSchema>

// --- Profit & Loss ----------------------------------------------------------------------------------------------------

/** One adjustment reason's stock-movement values in the period. */
export interface AdjustmentValueTotal {
  readonly reason: AdjustmentReason
  readonly count: number
  /** Σ positive movement values. */
  readonly valueAddedMinor: number
  /** Σ |negative movement values|. */
  readonly valueRemovedMinor: number
  /** Σ signed movement values. */
  readonly netValueMinor: number
}

/** One inventory data correction (receipt quantity / cost correction, other correction) in the period. */
export interface InventoryCorrectionDetail {
  readonly adjustmentId: number
  readonly adjustmentNo: string
  readonly adjustmentDate: string
  readonly reason: AdjustmentReason
  readonly direction: 'IN' | 'OUT' | 'VALUE'
  readonly productCode: string
  readonly productName: string
  /** Signed base units (0 for a value-only correction). */
  readonly qtyBase: number
  /** The quantity in the product's units ("2 Box"), or null for a value-only correction. */
  readonly quantityText: string | null
  /** The signed value of its stock movement. */
  readonly valueMinor: number
}

/** ACTIVE expenses of one category in the period. */
export interface ExpenseCategoryTotal {
  readonly categoryId: number
  /** The category's current name. */
  readonly name: string
  readonly group: ExpenseGroup
  readonly isActive: boolean
  /** True for the seeded Purchase Cost Correction category (by id), shown below Net Operating Profit. */
  readonly isPurchaseCostCorrection: boolean
  readonly count: number
  readonly amountMinor: number
}

export interface ProfitLossReport {
  readonly dateFrom: string
  readonly dateTo: string
  readonly postedInvoiceCount: number
  /** Σ invoices.net_minor: goods after discounts and schemes, freight excluded. */
  readonly goodsRevenueMinor: number
  /** Σ invoices.cogs_minor, frozen at posting. */
  readonly cogsMinor: number
  /** Goods revenue − COGS. */
  readonly grossProfitMinor: number
  /** Σ invoices.freight_minor: freight charged to customers. */
  readonly freightIncomeMinor: number
  /** COUNT_SURPLUS movement values. */
  readonly stockGainsMinor: number
  /** ACTIVE Shop expenses, Purchase Cost Correction excluded. */
  readonly shopExpensesMinor: number
  /** ACTIVE Monthly / General expenses, Purchase Cost Correction excluded. */
  readonly generalExpensesMinor: number
  /** Shop + Monthly / General. */
  readonly operatingExpensesMinor: number
  /** Positive amounts: the value removed by DAMAGE, EXPIRY and SHORTAGE movements. */
  readonly stockDamageMinor: number
  readonly stockExpiryMinor: number
  readonly stockShortageMinor: number
  readonly stockLossesMinor: number
  /** Gross profit + freight income + stock gains − operating expenses − stock losses. */
  readonly netOperatingProfitMinor: number
  /** ACTIVE expenses in the Purchase Cost Correction category (positive; reduces profit after corrections). */
  readonly purchaseCostCorrectionsMinor: number
  /** RECEIPT_QTY_CORRECTION, RECEIPT_COST_CORRECTION and OTHER_CORRECTION, by reason. */
  readonly inventoryCorrections: readonly AdjustmentValueTotal[]
  /** Σ signed movement values of the inventory data corrections. */
  readonly inventoryCorrectionsNetMinor: number
  readonly inventoryCorrectionDetails: readonly InventoryCorrectionDetail[]
  /** Net operating profit − purchase cost corrections + inventory corrections net value. */
  readonly profitAfterDataCorrectionsMinor: number
  /** Expense categories with ACTIVE expenses in the period (the drill-down), largest first. */
  readonly expenseCategories: readonly ExpenseCategoryTotal[]
  /** Not profit: opening stock value added in the period (for information). */
  readonly openingStockValueMinor: number
  /** True when the period has a receipt cost correction or a purchase cost correction expense (FROZEN_COGS_NOTE). */
  readonly showFrozenCogsNote: boolean
}

// --- Sales --------------------------------------------------------------------------------------------------------------

export interface SalesReportInvoice {
  readonly id: number
  readonly invoiceNo: string
  readonly invoiceDate: string
  readonly customerName: string
  readonly customerShopName: string | null
  readonly status: 'POSTED' | 'VOID'
  readonly grossMinor: number
  /** Line discounts + extra discount. */
  readonly discountMinor: number
  readonly schemeMinor: number
  readonly netMinor: number
  readonly freightMinor: number
  readonly totalMinor: number
  readonly cogsMinor: number
  readonly grossProfitMinor: number
}

export interface SalesReport {
  readonly dateFrom: string
  readonly dateTo: string
  /** POSTED invoices only. */
  readonly invoiceCount: number
  readonly grossSalesMinor: number
  readonly lineDiscountMinor: number
  readonly extraDiscountMinor: number
  /** Line + extra discounts. */
  readonly discountMinor: number
  readonly schemeDiscountMinor: number
  readonly netGoodsSalesMinor: number
  readonly freightChargedMinor: number
  readonly totalBilledMinor: number
  readonly cogsMinor: number
  readonly grossProfitMinor: number
  /** For transparency only: never part of the totals above. */
  readonly voidInvoiceCount: number
  readonly voidTotalMinor: number
  readonly invoices: ListPage<SalesReportInvoice>
}

// --- Product sales ------------------------------------------------------------------------------------------------------

export interface ProductSalesRow {
  readonly productId: number
  /** The product's current code, name and company (products are never deleted). */
  readonly code: string
  readonly name: string
  readonly companyName: string | null
  readonly invoiceCount: number
  /** All base units that left stock, free scheme goods included. */
  readonly qtyBase: number
  readonly quantityText: string
  /** Free scheme goods: in the quantity and COGS, no revenue. */
  readonly schemeQtyBase: number
  /** Σ invoice line net (after line discount and scheme money; before the invoice extra discount). */
  readonly revenueMinor: number
  readonly cogsMinor: number
  readonly grossProfitMinor: number
}

export interface ProductSalesReport {
  readonly dateFrom: string
  readonly dateTo: string
  /** Largest revenue first. */
  readonly rows: readonly ProductSalesRow[]
  readonly revenueMinor: number
  readonly cogsMinor: number
  readonly grossProfitMinor: number
  /** Invoice-level extra discounts: not allocated to products. Line revenue − this = net goods sales. */
  readonly extraDiscountMinor: number
  readonly netGoodsSalesMinor: number
}

// --- Stock ---------------------------------------------------------------------------------------------------------------

export type StockLevel = 'OUT_OF_STOCK' | 'LOW' | 'OK'

export interface StockReportRow {
  readonly productId: number
  readonly code: string
  readonly name: string
  readonly companyName: string | null
  readonly isActive: boolean
  /** Σ stock_movements.qty_base. */
  readonly qtyBase: number
  readonly quantityText: string
  /** Σ stock_movements.value_minor. */
  readonly valueMinor: number
  readonly lowStockThresholdBase: number
  /** OUT_OF_STOCK at 0; LOW at or below a threshold above 0; otherwise OK. */
  readonly level: StockLevel
}

export interface StockReport {
  /** By code. */
  readonly rows: readonly StockReportRow[]
  readonly totalValueMinor: number
  readonly lowStockCount: number
  readonly outOfStockCount: number
}

// --- Customer balances ---------------------------------------------------------------------------------------------------

export interface CustomerBalanceRow {
  readonly customerId: number
  readonly code: string
  readonly name: string
  readonly shopName: string | null
  readonly city: string | null
  readonly isActive: boolean
  /** Σ customer_ledger.amount_minor: positive Due, negative Advance. */
  readonly balanceMinor: number
  readonly state: BalanceState
}

export interface CustomerBalancesReport {
  /** By code. */
  readonly rows: readonly CustomerBalanceRow[]
  /** Σ positive balances. */
  readonly receivablesMinor: number
  /** Σ |negative balances|. */
  readonly advancesMinor: number
  /** Receivables − advances. */
  readonly netMinor: number
  readonly dueCount: number
  readonly advanceCount: number
  readonly settledCount: number
}

// --- Expenses -----------------------------------------------------------------------------------------------------------

export interface ExpenseReport {
  readonly dateFrom: string
  readonly dateTo: string
  /** ACTIVE only; Purchase Cost Correction excluded from the groups. */
  readonly shopMinor: number
  readonly generalMinor: number
  readonly operatingMinor: number
  readonly purchaseCostCorrectionsMinor: number
  /** Operating + purchase cost corrections. */
  readonly totalActiveMinor: number
  readonly voidCount: number
  readonly voidMinor: number
  readonly categories: readonly ExpenseCategoryTotal[]
  readonly expenses: ListPage<Expense>
}
