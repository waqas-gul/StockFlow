import {
  DASHBOARD_LIST_SIZE,
  DASHBOARD_TREND_DAYS,
  type DashboardData,
  type DashboardLowStockItem
} from '@shared/dashboard'
import { addDays, localDateString } from '@shared/dates'
import type { ReportPeriod, StockReportRow } from '@shared/reports'
import type { Db } from '../db/adapter'
import { listExpenses } from './expenses.service'
import { listInvoices } from './invoices.service'
import { listPayments } from './payments.service'
import {
  customerBalancesReport,
  dailySalesReport,
  expenseReport,
  productSalesReport,
  quantityFormatter,
  salesReport,
  stockReport
} from './reports.service'

/*
 * The Dashboard (read-only). It is assembled from the existing reports and lists, with their own rules, so every
 * figure matches Reports → Sales, Products, Stock, Customer Balances and Expenses, and the Invoice History, Payments
 * and Expenses pages. The only choices made here are which period, which rows and how many.
 */

/** The calendar month of a business date. */
function monthOf(today: string): ReportPeriod {
  const [year, month] = today.split('-').map(Number)
  const yearMonth = today.slice(0, 7)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { dateFrom: `${yearMonth}-01`, dateTo: `${yearMonth}-${String(lastDay).padStart(2, '0')}` }
}

/** The Products page rule: an active product with a low-stock level, at or below it. */
function isLowStock(row: StockReportRow): boolean {
  return row.isActive && row.lowStockThresholdBase > 0 && row.qtyBase <= row.lowStockThresholdBase
}

export function dashboardData(db: Db, now: Date): DashboardData {
  const today = localDateString(now)
  const month = monthOf(today)
  const postedSales = (period: ReportPeriod): ReturnType<typeof salesReport> =>
    salesReport(db, { ...period, page: 1, pageSize: 1, status: 'POSTED' })
  const todaySales = postedSales({ dateFrom: today, dateTo: today })
  const monthSales = postedSales(month)
  const balances = customerBalancesReport(db)
  const stock = stockReport(db)
  const expenses = expenseReport(db, { ...month, page: 1, pageSize: 1, status: 'ACTIVE' })

  // Most urgent first: the least stock relative to the level (the stable sort keeps code order for ties).
  const lowStockRows = stock.rows
    .filter(isLowStock)
    .sort((a, b) => a.qtyBase / a.lowStockThresholdBase - b.qtyBase / b.lowStockThresholdBase)
  const quantityText = quantityFormatter(db)
  const lowStock = lowStockRows.slice(0, DASHBOARD_LIST_SIZE).map((row): DashboardLowStockItem => ({
    productId: row.productId,
    code: row.code,
    name: row.name,
    qtyBase: row.qtyBase,
    quantityText: row.quantityText,
    lowStockThresholdBase: row.lowStockThresholdBase,
    thresholdText: quantityText(row.productId, row.lowStockThresholdBase)
  }))

  const recent = {
    page: 1,
    pageSize: DASHBOARD_LIST_SIZE,
    search: '',
    dateFrom: null,
    dateTo: null
  }
  const recentInvoices = listInvoices(db, { ...recent, status: 'all' }).items

  return {
    today,
    month,
    summary: {
      todaySalesMinor: todaySales.netGoodsSalesMinor,
      todayInvoiceCount: todaySales.invoiceCount,
      monthSalesMinor: monthSales.netGoodsSalesMinor,
      monthInvoiceCount: monthSales.invoiceCount,
      receivablesMinor: balances.receivablesMinor,
      dueCustomerCount: balances.dueCount,
      advancesMinor: balances.advancesMinor,
      advanceCustomerCount: balances.advanceCount,
      inventoryValueMinor: stock.totalValueMinor,
      activeProductCount: stock.rows.filter((row) => row.isActive).length,
      lowStockCount: lowStockRows.length
    },
    salesTrend: dailySalesReport(db, {
      dateFrom: addDays(today, 1 - DASHBOARD_TREND_DAYS),
      dateTo: today
    }),
    expenseBreakdown: {
      ...month,
      shopMinor: expenses.shopMinor,
      generalMinor: expenses.generalMinor,
      operatingMinor: expenses.operatingMinor,
      purchaseCostCorrectionsMinor: expenses.purchaseCostCorrectionsMinor
    },
    lowStock,
    topProducts: productSalesReport(db, month).rows.slice(0, DASHBOARD_LIST_SIZE),
    recentInvoices,
    recentPayments: listPayments(db, { ...recent, status: 'all', method: 'all' }).items,
    recentExpenses: listExpenses(db, { ...recent, group: 'all', status: 'all' }).items,
    gettingStarted: recentInvoices.length === 0 && !stock.rows.some((row) => row.qtyBase > 0)
  }
}
