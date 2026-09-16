import type { ProductUnit } from '@shared/products'
import {
  ADJUSTMENT_REASON_INFO,
  type AdjustmentReason,
  type StockAdjustmentSummary,
  type StockMovementType
} from '@shared/stock'
import { formatAmount, stockText, type CurrencyFormat } from '../products/product-display'

/** Plain names of the stock movement types, for the stock card. */
export const MOVEMENT_TYPE_LABELS: Readonly<Record<StockMovementType, string>> = {
  OPENING: 'Opening stock',
  STOCK_IN: 'Stock In',
  STOCK_IN_VOID: 'Stock In voided',
  SALE: 'Sale',
  SALE_VOID: 'Sale voided',
  SALE_RETURN: 'Sale return',
  ADJUST_IN: 'Adjustment in',
  ADJUST_OUT: 'Adjustment out',
  COST_CORRECTION: 'Cost correction'
}

/** What a stock card row is: the adjustment reason when it has one ("Damage"), otherwise its movement type. */
export function movementLabel(row: {
  readonly type: StockMovementType
  readonly reason: AdjustmentReason | null
}): string {
  return row.reason === null
    ? MOVEMENT_TYPE_LABELS[row.type]
    : ADJUSTMENT_REASON_INFO[row.reason].label
}

/** A base quantity in the product's units: 187 with Box = 24 → "7 Box + 19 Piece". */
export function quantityInUnits(qtyBase: number, units: readonly ProductUnit[]): string {
  return stockText({ stockQtyBase: qtyBase, units })
}

/** Low stock: a level is set (above 0) and the stock is at or below it. */
export function isLowStock(product: {
  readonly stockQtyBase: number
  readonly lowStockThresholdBase: number
}): boolean {
  return product.lowStockThresholdBase > 0 && product.stockQtyBase <= product.lowStockThresholdBase
}

/** "+3 Box", "−5 Piece", or "—" for a value-only correction. */
export function adjustmentQuantityText(adjustment: StockAdjustmentSummary): string {
  if (adjustment.direction === 'VALUE' || adjustment.quantity === null) return '—'
  const sign = adjustment.direction === 'OUT' ? '−' : '+'
  return `${sign}${adjustment.quantity.toLocaleString('en-US')} ${adjustment.unitName ?? ''}`.trim()
}

/** "+Rs 10.00", "−Rs 10.00", "Rs 0.00". */
export function signedAmount(minor: number, currency: CurrencyFormat): string {
  if (minor === 0) return formatAmount(0, currency)
  return `${minor > 0 ? '+' : '−'}${formatAmount(Math.abs(minor), currency)}`
}

/** The average cost of one unit of `baseQty` base units: round(V × baseQty / Q); null without stock. */
export function averageUnitCost(
  position: { readonly qtyBase: number; readonly valueMinor: number },
  baseQty: number
): number | null {
  if (position.qtyBase <= 0) return null
  const scaled = BigInt(position.valueMinor) * BigInt(baseQty)
  const q = BigInt(position.qtyBase)
  return Number((2n * scaled + q) / (2n * q))
}
