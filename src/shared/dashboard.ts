import type { Expense } from './expenses'
import type { InvoiceSummary } from './invoices'
import type { PaymentSummary } from './payments'
import type { DailySales, ProductSalesRow, ReportPeriod } from './reports'

/*
 * The Dashboard: a read-only overview of the shop, answered by one call (`window.api.dashboard.get()`). Every figure
 * comes from the existing reports and lists (Reports → Sales, Products, Stock, Customer Balances, Expenses; Invoice
 * History, Payments, Expenses), so the Dashboard adds no accounting rule of its own. "Today" is the main process's
 * business date. All money is whole minor units.
 */

/** The sales trend covers the last 30 days, today included; the Dashboard shows the last 7 or all 30. */
export const DASHBOARD_TREND_DAYS = 30

/** How many rows each Dashboard list shows. */
export const DASHBOARD_LIST_SIZE = 5

export interface DashboardSummary {
  /** Net goods sales of today's POSTED invoices (Reports → Sales for today). */
  readonly todaySalesMinor: number
  readonly todayInvoiceCount: number
  /** Net goods sales of this month's POSTED invoices (Reports → Sales for this month). */
  readonly monthSalesMinor: number
  readonly monthInvoiceCount: number
  /** Σ positive customer balances (Reports → Customer Balances). */
  readonly receivablesMinor: number
  readonly dueCustomerCount: number
  /** Σ |negative customer balances|. */
  readonly advancesMinor: number
  readonly advanceCustomerCount: number
  /** Current value of all stock (Reports → Stock). */
  readonly inventoryValueMinor: number
  readonly activeProductCount: number
  /** Active products at or below their low-stock level (the Products page rule); lowStock lists the first five. */
  readonly lowStockCount: number
}

/** An active product at or below its low-stock level. */
export interface DashboardLowStockItem {
  readonly productId: number
  readonly code: string
  readonly name: string
  readonly qtyBase: number
  /** The current stock in the product's units ("3 Box + 2 Piece"). */
  readonly quantityText: string
  readonly lowStockThresholdBase: number
  /** The low-stock level in the product's units ("5 Box"). */
  readonly thresholdText: string
}

/** This month's ACTIVE expenses (Reports → Expenses for this month). */
export interface DashboardExpenseBreakdown extends ReportPeriod {
  readonly shopMinor: number
  readonly generalMinor: number
  /** Shop + Monthly / General. */
  readonly operatingMinor: number
  /** Kept apart, as in Reports: not part of the operating total. */
  readonly purchaseCostCorrectionsMinor: number
}

export interface DashboardData {
  /** The business date the figures were read for. */
  readonly today: string
  /** This calendar month. */
  readonly month: ReportPeriod
  readonly summary: DashboardSummary
  /** The last DASHBOARD_TREND_DAYS days, oldest first, days without sales included as zero. */
  readonly salesTrend: readonly DailySales[]
  readonly expenseBreakdown: DashboardExpenseBreakdown
  /** Most urgent first: the lowest stock relative to the low-stock level. */
  readonly lowStock: readonly DashboardLowStockItem[]
  /** This month's best-selling products by revenue (Reports → Products). */
  readonly topProducts: readonly ProductSalesRow[]
  /** Newest first by business date, void ones included with their status. */
  readonly recentInvoices: readonly InvoiceSummary[]
  readonly recentPayments: readonly PaymentSummary[]
  readonly recentExpenses: readonly Expense[]
  /** True while the shop has no stock on hand and no invoice: the Dashboard suggests where to start. */
  readonly gettingStarted: boolean
}
