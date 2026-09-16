import { createUnitSet, formatMoney, formatQuantity } from '@shared/domain'
import type { ProductUnit } from '@shared/products'

/** How amounts are shown: the Settings currency symbol and decimal places. */
export interface CurrencyFormat {
  readonly minorDigits: number
  readonly symbol: string
}

export function formatAmount(minor: number, currency: CurrencyFormat): string {
  return formatMoney(minor, { minorDigits: currency.minorDigits, prefix: `${currency.symbol} ` })
}

export interface PriceSummary {
  /** The price of the first sellable unit that has one. */
  readonly text: string
  /** That unit's short name (or name). */
  readonly unit: string
  /** How many other sellable units have a price for this tier. */
  readonly others: number
  /** Every price of the tier, for a tooltip. */
  readonly title: string
}

/**
 * A compact price for the Products table: the first active, sellable unit (in display order) with a price for the
 * tier, plus how many more units have one. Null when no unit has a price for the tier.
 */
export function priceSummary(
  units: readonly ProductUnit[],
  tier: 'wholesale' | 'retail',
  currency: CurrencyFormat
): PriceSummary | null {
  const priced = units.flatMap((unit) => {
    const price = tier === 'wholesale' ? unit.wholesalePriceMinor : unit.retailPriceMinor
    return unit.isActive && unit.canSell && price !== null
      ? [{ label: unit.shortName ?? unit.name, text: formatAmount(price, currency) }]
      : []
  })
  if (priced.length === 0) return null
  return {
    text: priced[0].text,
    unit: priced[0].label,
    others: priced.length - 1,
    title: priced.map((entry) => `${entry.label}: ${entry.text}`).join(' · ')
  }
}

/** Stock in the product's units ("2 Box + 5 Piece"); the plain base count when the units cannot be read. */
export function stockText(product: {
  readonly stockQtyBase: number
  readonly units: readonly ProductUnit[]
}): string {
  const unitSet = createUnitSet(
    product.units.map((unit) => ({
      id: unit.id,
      name: unit.name,
      shortName: unit.shortName ?? undefined,
      baseQty: unit.baseQty,
      isBase: unit.isBase
    }))
  )
  if (!unitSet.ok || product.stockQtyBase < 0) return product.stockQtyBase.toLocaleString('en-US')
  return formatQuantity(product.stockQtyBase, unitSet.unitSet)
}
