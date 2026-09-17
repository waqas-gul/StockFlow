import { formatMoney } from '@shared/domain'
import type { ProfitLossReport, StockLevel } from '@shared/reports'
import { ADJUSTMENT_REASON_INFO } from '@shared/stock'
import type { CurrencyFormat } from '../products/product-display'

/*
 * How the reports read. Amounts are always positive "Rs" figures in their line; the statement says whether a line adds
 * or deducts. A result (profit) that is below zero is written with a minus sign.
 */

/** 'Rs 1,250.00', or '−Rs 1,250.00' below zero. */
export function moneyText(minor: number, currency: CurrencyFormat): string {
  const text = formatMoney(Math.abs(minor), {
    minorDigits: currency.minorDigits,
    prefix: `${currency.symbol} `
  })
  return minor < 0 ? `−${text}` : text
}

export type StatementRowKind = 'section' | 'line' | 'subtotal' | 'result'

export interface StatementRow {
  readonly key: string
  readonly kind: StatementRowKind
  readonly label: string
  /** Null for a section heading. */
  readonly minor: number | null
  /** How the line counts toward the next subtotal: added, deducted, or neither (a subtotal or result). */
  readonly effect: 'add' | 'deduct' | null
  /** Explains a subtotal. */
  readonly hint?: string
}

const section = (key: string, label: string): StatementRow => ({
  key,
  kind: 'section',
  label,
  minor: null,
  effect: null
})

const line = (
  key: string,
  label: string,
  minor: number,
  effect: 'add' | 'deduct'
): StatementRow => ({ key, kind: 'line', label, minor, effect })

/**
 * The Profit & Loss statement rows. Revenue, COGS and the two expense groups are always shown; stock gain and loss
 * lines only when they are not zero; Data Corrections and Profit After Data Corrections only when there are any.
 */
export function profitLossRows(report: ProfitLossReport): StatementRow[] {
  const rows: StatementRow[] = [
    section('revenue', 'Revenue'),
    line('goods-revenue', 'Goods Revenue', report.goodsRevenueMinor, 'add'),
    line('freight-income', 'Freight Income', report.freightIncomeMinor, 'add'),
    section('cogs', 'Cost of Goods Sold'),
    line('cogs-line', 'COGS', report.cogsMinor, 'deduct'),
    {
      key: 'gross-profit',
      kind: 'subtotal',
      label: 'Gross Profit',
      minor: report.grossProfitMinor,
      effect: null,
      hint: 'Goods Revenue − COGS (freight excluded)'
    }
  ]
  if (report.stockGainsMinor !== 0) {
    rows.push(
      section('gains', 'Operating Gains'),
      line('count-surplus', 'Stock Count Surplus', report.stockGainsMinor, 'add')
    )
  }
  rows.push(
    section('expenses', 'Operating Expenses'),
    line('shop', 'Shop Expenses', report.shopExpensesMinor, 'deduct'),
    line('general', 'Monthly / General Expenses', report.generalExpensesMinor, 'deduct')
  )
  for (const [key, label, minor] of [
    ['damage', 'Stock Damage', report.stockDamageMinor],
    ['expiry', 'Stock Expiry', report.stockExpiryMinor],
    ['shortage', 'Stock Shortage', report.stockShortageMinor]
  ] as const) {
    if (minor !== 0) rows.push(line(key, label, minor, 'deduct'))
  }
  rows.push({
    key: 'net-operating-profit',
    kind: 'result',
    label: 'Net Operating Profit',
    minor: report.netOperatingProfitMinor,
    effect: null,
    hint: 'Gross Profit + Freight Income + Stock Gains − Operating Expenses − Stock Losses'
  })

  const hasCorrections =
    report.purchaseCostCorrectionsMinor !== 0 ||
    report.inventoryCorrections.some((total) => total.count > 0)
  if (hasCorrections) {
    rows.push(section('corrections', 'Data Corrections'))
    if (report.purchaseCostCorrectionsMinor !== 0) {
      rows.push(
        line(
          'purchase-cost',
          'Purchase Cost Corrections',
          report.purchaseCostCorrectionsMinor,
          'deduct'
        )
      )
    }
    if (report.inventoryCorrections.some((total) => total.count > 0)) {
      const net = report.inventoryCorrectionsNetMinor
      rows.push(
        line(
          'inventory-corrections',
          'Inventory Quantity / Value Corrections',
          Math.abs(net),
          net < 0 ? 'deduct' : 'add'
        )
      )
    }
    rows.push({
      key: 'profit-after-corrections',
      kind: 'result',
      label: 'Profit After Data Corrections',
      minor: report.profitAfterDataCorrectionsMinor,
      effect: null,
      hint: 'Net Operating Profit − Purchase Cost Corrections ± Inventory Corrections'
    })
  }
  return rows
}

/** "Receipt Quantity Correction" etc. */
export function reasonLabel(reason: keyof typeof ADJUSTMENT_REASON_INFO): string {
  return ADJUSTMENT_REASON_INFO[reason].label
}

export const STOCK_LEVEL_LABELS: Readonly<Record<StockLevel, string>> = Object.freeze({
  OUT_OF_STOCK: 'Out of stock',
  LOW: 'Low stock',
  OK: 'In stock'
})
