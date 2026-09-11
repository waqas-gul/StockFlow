import { DomainError } from './errors'
import { assertNonNegativeInteger } from './guards'
import { mulDivRoundHalfUp, type MinorUnits } from './money'

/**
 * Moving weighted-average valuation (plan §8.4). Stock is tracked as a quantity Q (base units) and a total
 * value V (minor units). The average cost V / Q is implicit: never stored and never rounded.
 */
export interface StockPosition {
  readonly qtyBase: number
  readonly valueMinor: MinorUnits
}

export interface OutflowResult {
  /** Value leaving stock (the COGS of a sale line). */
  readonly outValueMinor: MinorUnits
  readonly remaining: StockPosition
}

/**
 * Value of `outQtyBase` base units leaving stock: round_half_up(V × n ÷ Q), with a BigInt intermediate.
 *
 * When n = Q the entire remaining value leaves, exactly. That keeps the invariant "Q = 0 ⇒ V = 0", so
 * rounding differences can never pile up. For 0 < n < Q the result is always between 0 and V.
 */
export function weightedAverageOutflowValue(
  position: StockPosition,
  outQtyBase: number
): MinorUnits {
  const { qtyBase, valueMinor } = position
  assertNonNegativeInteger(qtyBase, 'Stock quantity')
  assertNonNegativeInteger(valueMinor, 'Stock value')
  assertNonNegativeInteger(outQtyBase, 'Outgoing quantity')
  if (qtyBase === 0 && valueMinor !== 0) {
    throw new DomainError('INVALID_ARGUMENT', 'Stock with zero quantity must have zero value.')
  }
  if (outQtyBase > qtyBase) {
    throw new DomainError(
      'INSUFFICIENT_STOCK',
      `Cannot take ${outQtyBase} base units out of stock; only ${qtyBase} are available.`
    )
  }
  if (outQtyBase === 0) return 0
  if (outQtyBase === qtyBase) return valueMinor
  return mulDivRoundHalfUp(valueMinor, outQtyBase, qtyBase)
}

/** Takes `outQtyBase` units out of stock and returns the value removed and the stock that remains. */
export function applyOutflow(position: StockPosition, outQtyBase: number): OutflowResult {
  const outValueMinor = weightedAverageOutflowValue(position, outQtyBase)
  return {
    outValueMinor,
    remaining: {
      qtyBase: position.qtyBase - outQtyBase,
      valueMinor: position.valueMinor - outValueMinor
    }
  }
}
