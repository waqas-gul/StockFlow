import { balanceState, type ListPage } from '@shared/customers'
import { addDays } from '@shared/dates'
import {
  DomainError,
  addMinor,
  createUnitSet,
  formatQuantity,
  subtractMinor,
  sumMinor
} from '@shared/domain'
import type { ExpenseGroup } from '@shared/expenses'
import {
  ExpenseReportInputSchema,
  PURCHASE_COST_CORRECTION_CATEGORY_ID,
  ReportPeriodSchema,
  SalesReportInputSchema,
  type AdjustmentValueTotal,
  type CustomerBalancesReport,
  type DailySales,
  type ExpenseCategoryTotal,
  type ExpenseReport,
  type InventoryCorrectionDetail,
  type ProductSalesReport,
  type ProfitLossReport,
  type ReportPeriod,
  type SalesReport,
  type SalesReportInvoice,
  type StockLevel,
  type StockReport
} from '@shared/reports'
import { ADJUSTMENT_REASON_INFO, ADJUSTMENT_REASONS, type AdjustmentReason } from '@shared/stock'
import type { Db } from '../db/adapter'
import { AppFailure, parseInput } from '../errors'
import { listExpenses } from './expenses.service'

/*
 * Reports and Profit & Loss (Phase 11). Read-only: every figure is summed on request from the saved records, by their
 * business dates (invoice_date, adjustment_date, expense_date), never created_at. Nothing is stored.
 *
 * P&L:
 *   Goods Revenue (Σ POSTED invoices.net_minor) − COGS (Σ POSTED invoices.cogs_minor, frozen at posting) = Gross Profit
 *   + Freight Income (Σ POSTED invoices.freight_minor) + Stock Gains (COUNT_SURPLUS movement values)
 *   − Operating Expenses (ACTIVE Shop + Monthly / General expenses, Purchase Cost Correction excluded)
 *   − Stock Losses (value removed by DAMAGE, EXPIRY, SHORTAGE movements)
 *   = Net Operating Profit
 *   − Purchase Cost Corrections (ACTIVE expenses in that category, by id)
 *   + Inventory data corrections (signed movement values of receipt quantity/cost and other corrections)
 *   = Profit After Data Corrections
 * VOID invoices and VOID expenses contribute nothing; payments are never revenue; OPENING_STOCK, receipts and their
 * voids are not P&L; sales and their voids are represented by revenue and frozen COGS.
 *
 * Sums run in SQLite (exact 64-bit integers); every value is then checked to be a safe JavaScript integer, and the
 * derived figures use the checked money helpers. A total too large to show exactly is refused, never rounded.
 */

const TOO_LARGE = 'The report totals are too large to show exactly.'

/** Runs a report; an overflow anywhere becomes a VALIDATION failure instead of an inexact figure. */
function report<T>(build: () => T): T {
  try {
    return build()
  } catch (error) {
    if (
      error instanceof DomainError ||
      (error instanceof Error &&
        !(error instanceof AppFailure) &&
        /integer overflow/i.test(error.message))
    ) {
      throw new AppFailure({ code: 'VALIDATION', message: TOO_LARGE })
    }
    throw error
  }
}

/** A summed value, exactly as a JavaScript number. */
function exact(value: number | null | undefined): number {
  const number = value ?? 0
  if (!Number.isSafeInteger(number))
    throw new AppFailure({ code: 'VALIDATION', message: TOO_LARGE })
  return number
}

// --- Shared pieces -----------------------------------------------------------------------------------------------------

interface InvoiceTotals {
  count: number
  grossMinor: number
  lineDiscountMinor: number
  schemeMinor: number
  extraDiscountMinor: number
  netMinor: number
  freightMinor: number
  totalMinor: number
  cogsMinor: number
}

function postedInvoiceTotals(db: Db, period: ReportPeriod): InvoiceTotals {
  const row = db.get<Record<string, number | null>>(
    `SELECT count(*) AS n, sum(gross_minor) AS gross, sum(line_discount_minor) AS line_discount,
            sum(line_scheme_minor) AS scheme, sum(extra_discount_minor) AS extra_discount, sum(net_minor) AS net,
            sum(freight_minor) AS freight, sum(total_minor) AS total, sum(cogs_minor) AS cogs
     FROM invoices WHERE status = 'POSTED' AND invoice_date BETWEEN ? AND ?`,
    [period.dateFrom, period.dateTo]
  )!
  return {
    count: exact(row.n),
    grossMinor: exact(row.gross),
    lineDiscountMinor: exact(row.line_discount),
    schemeMinor: exact(row.scheme),
    extraDiscountMinor: exact(row.extra_discount),
    netMinor: exact(row.net),
    freightMinor: exact(row.freight),
    totalMinor: exact(row.total),
    cogsMinor: exact(row.cogs)
  }
}

/** Each adjustment reason's movement values in the period (every reason, zero when absent). */
function adjustmentValues(
  db: Db,
  period: ReportPeriod
): Map<AdjustmentReason, AdjustmentValueTotal> {
  const rows = db.all<{
    reason_code: AdjustmentReason
    n: number
    added: number | null
    removed: number | null
    net: number | null
  }>(
    `SELECT a.reason_code, count(*) AS n,
            sum(CASE WHEN m.value_minor > 0 THEN m.value_minor ELSE 0 END) AS added,
            sum(CASE WHEN m.value_minor < 0 THEN -m.value_minor ELSE 0 END) AS removed,
            sum(m.value_minor) AS net
     FROM stock_adjustments AS a JOIN stock_movements AS m ON m.adjustment_id = a.id
     WHERE a.adjustment_date BETWEEN ? AND ?
     GROUP BY a.reason_code`,
    [period.dateFrom, period.dateTo]
  )
  const totals = new Map<AdjustmentReason, AdjustmentValueTotal>(
    ADJUSTMENT_REASONS.map((reason) => [
      reason,
      { reason, count: 0, valueAddedMinor: 0, valueRemovedMinor: 0, netValueMinor: 0 }
    ])
  )
  for (const row of rows) {
    totals.set(row.reason_code, {
      reason: row.reason_code,
      count: exact(row.n),
      valueAddedMinor: exact(row.added),
      valueRemovedMinor: exact(row.removed),
      netValueMinor: exact(row.net)
    })
  }
  return totals
}

/** ACTIVE expenses per category in the period, largest first. */
function expenseCategoryTotals(db: Db, period: ReportPeriod): ExpenseCategoryTotal[] {
  return db
    .all<{
      id: number
      name: string
      grp: ExpenseGroup
      is_active: number
      n: number
      amount: number | null
    }>(
      `SELECT c.id, c.name, c.grp, c.is_active, count(*) AS n, sum(e.amount_minor) AS amount
       FROM expenses AS e JOIN expense_categories AS c ON c.id = e.category_id
       WHERE e.status = 'ACTIVE' AND e.expense_date BETWEEN ? AND ?
       GROUP BY c.id
       ORDER BY amount DESC, c.name COLLATE NOCASE, c.id`,
      [period.dateFrom, period.dateTo]
    )
    .map((row) => ({
      categoryId: row.id,
      name: row.name,
      group: row.grp,
      isActive: row.is_active === 1,
      isPurchaseCostCorrection: row.id === PURCHASE_COST_CORRECTION_CATEGORY_ID,
      count: exact(row.n),
      amountMinor: exact(row.amount)
    }))
}

interface ExpenseSplit {
  shopMinor: number
  generalMinor: number
  purchaseCostCorrectionsMinor: number
}

function splitExpenses(categories: readonly ExpenseCategoryTotal[]): ExpenseSplit {
  const pick = (test: (category: ExpenseCategoryTotal) => boolean): number =>
    sumMinor(categories.filter(test).map((category) => category.amountMinor))
  return {
    shopMinor: pick((category) => !category.isPurchaseCostCorrection && category.group === 'SHOP'),
    generalMinor: pick(
      (category) => !category.isPurchaseCostCorrection && category.group === 'GENERAL'
    ),
    purchaseCostCorrectionsMinor: pick((category) => category.isPurchaseCostCorrection)
  }
}

/** Formats base quantities in each product's units ("2 Box + 5 Piece"), loading the units once. */
export function quantityFormatter(db: Db): (productId: number, qtyBase: number) => string {
  const units = new Map<
    number,
    Array<{ id: number; name: string; baseQty: number; isBase: boolean }>
  >()
  for (const row of db.all<{
    id: number
    product_id: number
    name: string
    base_qty: number
    is_base: number
  }>(
    'SELECT id, product_id, name, base_qty, is_base FROM product_units ORDER BY product_id, base_qty DESC'
  )) {
    const list = units.get(row.product_id) ?? []
    list.push({ id: row.id, name: row.name, baseQty: row.base_qty, isBase: row.is_base === 1 })
    units.set(row.product_id, list)
  }
  return (productId, qtyBase) => {
    const unitSet = createUnitSet(units.get(productId) ?? [])
    if (!unitSet.ok || qtyBase < 0) return qtyBase.toLocaleString('en-US')
    return formatQuantity(qtyBase, unitSet.unitSet)
  }
}

const INVENTORY_CORRECTION_REASONS = ADJUSTMENT_REASONS.filter(
  (reason) => ADJUSTMENT_REASON_INFO[reason].pnl === 'INVENTORY_DATA_CORRECTION'
)

// --- Profit & Loss ------------------------------------------------------------------------------------------------------

export function profitLossReport(db: Db, input: unknown): ProfitLossReport {
  const period = parseInput(ReportPeriodSchema, input)
  return report(() => {
    const invoices = postedInvoiceTotals(db, period)
    const adjustments = adjustmentValues(db, period)
    const categories = expenseCategoryTotals(db, period)
    const expenses = splitExpenses(categories)

    const removed = (reason: AdjustmentReason): number =>
      subtractMinor(0, adjustments.get(reason)!.netValueMinor)
    const stockDamageMinor = removed('DAMAGE')
    const stockExpiryMinor = removed('EXPIRY')
    const stockShortageMinor = removed('SHORTAGE')
    const stockLossesMinor = sumMinor([stockDamageMinor, stockExpiryMinor, stockShortageMinor])
    const stockGainsMinor = adjustments.get('COUNT_SURPLUS')!.netValueMinor

    const grossProfitMinor = subtractMinor(invoices.netMinor, invoices.cogsMinor)
    const operatingExpensesMinor = addMinor(expenses.shopMinor, expenses.generalMinor)
    const netOperatingProfitMinor = subtractMinor(
      sumMinor([grossProfitMinor, invoices.freightMinor, stockGainsMinor]),
      addMinor(operatingExpensesMinor, stockLossesMinor)
    )

    const inventoryCorrections = INVENTORY_CORRECTION_REASONS.map((reason) =>
      adjustments.get(reason)!
    )
    const inventoryCorrectionsNetMinor = sumMinor(
      inventoryCorrections.map((total) => total.netValueMinor)
    )
    const profitAfterDataCorrectionsMinor = addMinor(
      subtractMinor(netOperatingProfitMinor, expenses.purchaseCostCorrectionsMinor),
      inventoryCorrectionsNetMinor
    )

    return {
      dateFrom: period.dateFrom,
      dateTo: period.dateTo,
      postedInvoiceCount: invoices.count,
      goodsRevenueMinor: invoices.netMinor,
      cogsMinor: invoices.cogsMinor,
      grossProfitMinor,
      freightIncomeMinor: invoices.freightMinor,
      stockGainsMinor,
      shopExpensesMinor: expenses.shopMinor,
      generalExpensesMinor: expenses.generalMinor,
      operatingExpensesMinor,
      stockDamageMinor,
      stockExpiryMinor,
      stockShortageMinor,
      stockLossesMinor,
      netOperatingProfitMinor,
      purchaseCostCorrectionsMinor: expenses.purchaseCostCorrectionsMinor,
      inventoryCorrections,
      inventoryCorrectionsNetMinor,
      inventoryCorrectionDetails: inventoryCorrectionDetails(db, period),
      profitAfterDataCorrectionsMinor,
      expenseCategories: categories,
      openingStockValueMinor: adjustments.get('OPENING_STOCK')!.netValueMinor,
      showFrozenCogsNote:
        adjustments.get('RECEIPT_COST_CORRECTION')!.count > 0 ||
        expenses.purchaseCostCorrectionsMinor > 0
    }
  })
}

function inventoryCorrectionDetails(db: Db, period: ReportPeriod): InventoryCorrectionDetail[] {
  const quantityText = quantityFormatter(db)
  return db
    .all<{
      id: number
      adjustment_no: string
      adjustment_date: string
      reason_code: AdjustmentReason
      direction: 'IN' | 'OUT' | 'VALUE'
      product_id: number
      code: string
      name: string
      qty_base: number
      value_minor: number
    }>(
      `SELECT a.id, a.adjustment_no, a.adjustment_date, a.reason_code, a.direction, a.product_id, p.code, p.name,
              m.qty_base, m.value_minor
       FROM stock_adjustments AS a
       JOIN stock_movements AS m ON m.adjustment_id = a.id
       JOIN products AS p ON p.id = a.product_id
       WHERE a.adjustment_date BETWEEN ? AND ?
         AND a.reason_code IN (${INVENTORY_CORRECTION_REASONS.map(() => '?').join(', ')})
       ORDER BY a.adjustment_date, a.id`,
      [period.dateFrom, period.dateTo, ...INVENTORY_CORRECTION_REASONS]
    )
    .map((row) => ({
      adjustmentId: row.id,
      adjustmentNo: row.adjustment_no,
      adjustmentDate: row.adjustment_date,
      reason: row.reason_code,
      direction: row.direction,
      productCode: row.code,
      productName: row.name,
      qtyBase: row.qty_base,
      quantityText:
        row.direction === 'VALUE'
          ? null
          : `${row.qty_base < 0 ? '−' : '+'}${quantityText(row.product_id, Math.abs(row.qty_base))}`,
      valueMinor: row.value_minor
    }))
}

// --- Sales --------------------------------------------------------------------------------------------------------------

export function salesReport(db: Db, input: unknown): SalesReport {
  const filters = parseInput(SalesReportInputSchema, input)
  return report(() => {
    const invoices = postedInvoiceTotals(db, filters)
    const voided = db.get<{ n: number; total: number | null }>(
      `SELECT count(*) AS n, sum(total_minor) AS total FROM invoices
       WHERE status = 'VOID' AND invoice_date BETWEEN ? AND ?`,
      [filters.dateFrom, filters.dateTo]
    )!
    return {
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      invoiceCount: invoices.count,
      grossSalesMinor: invoices.grossMinor,
      lineDiscountMinor: invoices.lineDiscountMinor,
      extraDiscountMinor: invoices.extraDiscountMinor,
      discountMinor: addMinor(invoices.lineDiscountMinor, invoices.extraDiscountMinor),
      schemeDiscountMinor: invoices.schemeMinor,
      netGoodsSalesMinor: invoices.netMinor,
      freightChargedMinor: invoices.freightMinor,
      totalBilledMinor: invoices.totalMinor,
      cogsMinor: invoices.cogsMinor,
      grossProfitMinor: subtractMinor(invoices.netMinor, invoices.cogsMinor),
      voidInvoiceCount: exact(voided.n),
      voidTotalMinor: exact(voided.total),
      invoices: salesInvoicePage(db, filters)
    }
  })
}

function salesInvoicePage(
  db: Db,
  filters: ReturnType<typeof SalesReportInputSchema.parse>
): ListPage<SalesReportInvoice> {
  const where =
    filters.status === 'all'
      ? 'invoice_date BETWEEN ? AND ?'
      : 'invoice_date BETWEEN ? AND ? AND status = ?'
  const params =
    filters.status === 'all'
      ? [filters.dateFrom, filters.dateTo]
      : [filters.dateFrom, filters.dateTo, filters.status]
  const total = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM invoices WHERE ${where}`,
    params
  )!.n
  const rows = db.all<{
    id: number
    invoice_no: string
    invoice_date: string
    cust_name: string
    cust_shop_name: string | null
    status: 'POSTED' | 'VOID'
    gross_minor: number
    line_discount_minor: number
    extra_discount_minor: number
    line_scheme_minor: number
    net_minor: number
    freight_minor: number
    total_minor: number
    cogs_minor: number
  }>(
    `SELECT id, invoice_no, invoice_date, cust_name, cust_shop_name, status, gross_minor, line_discount_minor,
            extra_discount_minor, line_scheme_minor, net_minor, freight_minor, total_minor, cogs_minor
     FROM invoices WHERE ${where}
     ORDER BY invoice_date, seq_no LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, (filters.page - 1) * filters.pageSize]
  )
  return {
    items: rows.map((row) => ({
      id: row.id,
      invoiceNo: row.invoice_no,
      invoiceDate: row.invoice_date,
      customerName: row.cust_name,
      customerShopName: row.cust_shop_name,
      status: row.status,
      grossMinor: row.gross_minor,
      discountMinor: addMinor(row.line_discount_minor, row.extra_discount_minor),
      schemeMinor: row.line_scheme_minor,
      netMinor: row.net_minor,
      freightMinor: row.freight_minor,
      totalMinor: row.total_minor,
      cogsMinor: row.cogs_minor,
      grossProfitMinor: subtractMinor(row.net_minor, row.cogs_minor)
    })),
    total,
    page: filters.page,
    pageSize: filters.pageSize
  }
}

/**
 * Every day of the period, oldest first, with the count and net goods sales of its POSTED invoices: the Sales report's
 * figures split by invoice_date (a day without sales is zero).
 */
export function dailySalesReport(db: Db, input: unknown): DailySales[] {
  const period = parseInput(ReportPeriodSchema, input)
  return report(() => {
    const rows = new Map(
      db
        .all<{ invoice_date: string; n: number; net: number | null }>(
          `SELECT invoice_date, count(*) AS n, sum(net_minor) AS net
           FROM invoices WHERE status = 'POSTED' AND invoice_date BETWEEN ? AND ?
           GROUP BY invoice_date`,
          [period.dateFrom, period.dateTo]
        )
        .map((row) => [row.invoice_date, row])
    )
    const days: DailySales[] = []
    for (let date = period.dateFrom; date <= period.dateTo; date = addDays(date, 1)) {
      const row = rows.get(date)
      days.push({ date, invoiceCount: exact(row?.n), netGoodsSalesMinor: exact(row?.net) })
    }
    return days
  })
}

// --- Product sales ------------------------------------------------------------------------------------------------------

export function productSalesReport(db: Db, input: unknown): ProductSalesReport {
  const period = parseInput(ReportPeriodSchema, input)
  return report(() => {
    const quantityText = quantityFormatter(db)
    const rows = db
      .all<{
        product_id: number
        code: string
        name: string
        company_name: string | null
        invoices: number
        qty: number | null
        scheme_qty: number | null
        revenue: number | null
        cogs: number | null
      }>(
        `SELECT ii.product_id, p.code, p.name, co.name AS company_name, count(DISTINCT i.id) AS invoices,
                sum(ii.qty_base) AS qty, sum(ii.scheme_qty_base) AS scheme_qty, sum(ii.net_minor) AS revenue,
                sum(ii.cost_minor) AS cogs
         FROM invoice_items AS ii
         JOIN invoices AS i ON i.id = ii.invoice_id
         JOIN products AS p ON p.id = ii.product_id
         LEFT JOIN companies AS co ON co.id = p.company_id
         WHERE i.status = 'POSTED' AND i.invoice_date BETWEEN ? AND ?
         GROUP BY ii.product_id
         ORDER BY revenue DESC, p.code COLLATE NOCASE`,
        [period.dateFrom, period.dateTo]
      )
      .map((row) => {
        const revenueMinor = exact(row.revenue)
        const cogsMinor = exact(row.cogs)
        const qtyBase = exact(row.qty)
        return {
          productId: row.product_id,
          code: row.code,
          name: row.name,
          companyName: row.company_name,
          invoiceCount: exact(row.invoices),
          qtyBase,
          quantityText: quantityText(row.product_id, qtyBase),
          schemeQtyBase: exact(row.scheme_qty),
          revenueMinor,
          cogsMinor,
          grossProfitMinor: subtractMinor(revenueMinor, cogsMinor)
        }
      })
    const invoices = postedInvoiceTotals(db, period)
    const revenueMinor = sumMinor(rows.map((row) => row.revenueMinor))
    const cogsMinor = sumMinor(rows.map((row) => row.cogsMinor))
    return {
      dateFrom: period.dateFrom,
      dateTo: period.dateTo,
      rows,
      revenueMinor,
      cogsMinor,
      grossProfitMinor: subtractMinor(revenueMinor, cogsMinor),
      extraDiscountMinor: invoices.extraDiscountMinor,
      netGoodsSalesMinor: subtractMinor(revenueMinor, invoices.extraDiscountMinor)
    }
  })
}

// --- Stock --------------------------------------------------------------------------------------------------------------

export function stockReport(db: Db): StockReport {
  return report(() => {
    const quantityText = quantityFormatter(db)
    const rows = db
      .all<{
        id: number
        code: string
        name: string
        company_name: string | null
        is_active: number
        qty_base: number
        value_minor: number
        low_stock_threshold_base: number
      }>(
        `SELECT p.id, p.code, p.name, co.name AS company_name, p.is_active, s.qty_base, s.value_minor,
                p.low_stock_threshold_base
         FROM products AS p
         JOIN v_product_stock AS s ON s.product_id = p.id
         LEFT JOIN companies AS co ON co.id = p.company_id
         ORDER BY p.code COLLATE NOCASE, p.id`
      )
      .map((row) => {
        const qtyBase = exact(row.qty_base)
        const level: StockLevel =
          qtyBase <= 0
            ? 'OUT_OF_STOCK'
            : row.low_stock_threshold_base > 0 && qtyBase <= row.low_stock_threshold_base
              ? 'LOW'
              : 'OK'
        return {
          productId: row.id,
          code: row.code,
          name: row.name,
          companyName: row.company_name,
          isActive: row.is_active === 1,
          qtyBase,
          quantityText: quantityText(row.id, qtyBase),
          valueMinor: exact(row.value_minor),
          lowStockThresholdBase: row.low_stock_threshold_base,
          level
        }
      })
    return {
      rows,
      totalValueMinor: sumMinor(rows.map((row) => row.valueMinor)),
      lowStockCount: rows.filter((row) => row.level === 'LOW').length,
      outOfStockCount: rows.filter((row) => row.level === 'OUT_OF_STOCK').length
    }
  })
}

// --- Customer balances ----------------------------------------------------------------------------------------------------

export function customerBalancesReport(db: Db): CustomerBalancesReport {
  return report(() => {
    const rows = db
      .all<{
        id: number
        code: string
        name: string
        shop_name: string | null
        city: string | null
        is_active: number
        balance_minor: number
      }>(
        `SELECT c.id, c.code, c.name, c.shop_name, c.city, c.is_active, b.balance_minor
         FROM customers AS c JOIN v_customer_balance AS b ON b.customer_id = c.id
         ORDER BY c.code COLLATE NOCASE, c.id`
      )
      .map((row) => {
        const balanceMinor = exact(row.balance_minor)
        return {
          customerId: row.id,
          code: row.code,
          name: row.name,
          shopName: row.shop_name,
          city: row.city,
          isActive: row.is_active === 1,
          balanceMinor,
          state: balanceState(balanceMinor)
        }
      })
    const receivablesMinor = sumMinor(
      rows.filter((row) => row.balanceMinor > 0).map((row) => row.balanceMinor)
    )
    const advancesMinor = sumMinor(
      rows.filter((row) => row.balanceMinor < 0).map((row) => -row.balanceMinor)
    )
    return {
      rows,
      receivablesMinor,
      advancesMinor,
      netMinor: subtractMinor(receivablesMinor, advancesMinor),
      dueCount: rows.filter((row) => row.state === 'DUE').length,
      advanceCount: rows.filter((row) => row.state === 'ADVANCE').length,
      settledCount: rows.filter((row) => row.state === 'SETTLED').length
    }
  })
}

// --- Expenses -----------------------------------------------------------------------------------------------------------

export function expenseReport(db: Db, input: unknown): ExpenseReport {
  const filters = parseInput(ExpenseReportInputSchema, input)
  return report(() => {
    const categories = expenseCategoryTotals(db, filters)
    const split = splitExpenses(categories)
    const voided = db.get<{ n: number; amount: number | null }>(
      `SELECT count(*) AS n, sum(amount_minor) AS amount FROM expenses
       WHERE status = 'VOID' AND expense_date BETWEEN ? AND ?`,
      [filters.dateFrom, filters.dateTo]
    )!
    const operatingMinor = addMinor(split.shopMinor, split.generalMinor)
    return {
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      shopMinor: split.shopMinor,
      generalMinor: split.generalMinor,
      operatingMinor,
      purchaseCostCorrectionsMinor: split.purchaseCostCorrectionsMinor,
      totalActiveMinor: addMinor(operatingMinor, split.purchaseCostCorrectionsMinor),
      voidCount: exact(voided.n),
      voidMinor: exact(voided.amount),
      categories,
      expenses: listExpenses(db, {
        page: filters.page,
        pageSize: filters.pageSize,
        search: '',
        group: 'all',
        status: filters.status,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo
      })
    }
  })
}
