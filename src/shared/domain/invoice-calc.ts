import { DomainError } from './errors'
import { assertNonNegativeInteger, assertSafeInteger } from './guards'
import {
  addMinor,
  basisPointsOf,
  BPS_PER_WHOLE,
  multiplyMinor,
  subtractMinor,
  sumMinor,
  type BasisPoints,
  type MinorUnits
} from './money'
import { toBaseQuantity } from './quantity'

/**
 * Pure invoice arithmetic (plan §11.2). It receives already-resolved numbers (quantities, unit sizes,
 * prices, balances) and returns exact integer results. It has no database, stock or product lookups.
 *
 * Several invoice meanings still await client confirmation: Sch (B3), the discount policy (B5), and which
 * total is "Current Invoice" or is written in words (B6). The calculator therefore hardcodes none of them:
 * - **Deductions** are an ordered list of caller-named entries (e.g. 'discount', 'scheme', 'extraDiscount'),
 *   each either a percentage or a fixed amount. A percentage applies to the original amount or to what
 *   remains after the earlier deductions.
 * - **Charges** (e.g. freight) are caller-named amounts added after the deductions.
 * - **Free goods**, if B3 confirms them, are a quantity row priced at 0. They count in `qtyBase` (and so
 *   later in stock and COGS) and add nothing to the gross.
 *
 * Once the rules are confirmed, a later phase composes these primitives with fixed keys and order; the
 * money arithmetic itself does not change.
 */

/** One quantity row of a line: a quantity entered in one unit, at the price charged for that unit. */
export interface QuantityRowInput {
  /** Whole number ≥ 0, in the row's unit. */
  readonly quantity: number
  /** Base units in one of the row's unit (a snapshot of the unit's size). */
  readonly unitBaseQty: number
  /** Price charged per unit of this row, in minor units (≥ 0; 0 = free of charge). */
  readonly unitPriceMinor: MinorUnits
}

export interface QuantityRowResult extends QuantityRowInput {
  /** quantity × unitBaseQty */
  readonly qtyBase: number
  /** quantity × unitPriceMinor */
  readonly amountMinor: MinorUnits
}

export type DeductionSpec =
  | { readonly type: 'percent'; readonly bps: BasisPoints }
  | { readonly type: 'amount'; readonly amountMinor: MinorUnits }

/** What a percentage deduction applies to: the group's original amount, or what remains at that point. */
export type DeductionBasis = 'original' | 'remaining'

export interface Deduction {
  /** Caller-defined name, unique within its list. The calculator attaches no meaning to it. */
  readonly key: string
  readonly spec: DeductionSpec
  /** Default `'original'`. Ignored for fixed amounts. */
  readonly basis?: DeductionBasis
}

export interface DeductionResult {
  readonly key: string
  readonly amountMinor: MinorUnits
  /** The percentage used, or null for a fixed amount. */
  readonly bps: BasisPoints | null
}

export interface DeductionsResult {
  readonly deductions: readonly DeductionResult[]
  readonly totalMinor: MinorUnits
  readonly remainingMinor: MinorUnits
}

export interface LineInput {
  readonly quantities: readonly QuantityRowInput[]
  readonly deductions?: readonly Deduction[]
}

export interface LineResult {
  readonly quantities: readonly QuantityRowResult[]
  /** Σ row qtyBase */
  readonly qtyBase: number
  /** Σ row amounts */
  readonly grossMinor: MinorUnits
  readonly deductions: readonly DeductionResult[]
  readonly totalDeductionMinor: MinorUnits
  /** gross − deductions (never negative) */
  readonly netMinor: MinorUnits
}

/** A caller-named amount, e.g. `{ key: 'freight', amountMinor: 50000 }`. */
export interface KeyedAmount {
  readonly key: string
  readonly amountMinor: MinorUnits
}

export interface InvoiceInput {
  readonly lines: readonly LineInput[]
  /** Invoice-level deductions (e.g. an extra discount), applied to Σ line net. */
  readonly deductions?: readonly Deduction[]
  /** Amounts added after the deductions (e.g. freight). Each ≥ 0. */
  readonly charges?: readonly KeyedAmount[]
  /** Customer balance before this invoice. Negative means the customer is in credit. Default 0. */
  readonly previousBalanceMinor?: MinorUnits
  /** Paid together with this invoice (≥ 0). Default 0. */
  readonly receivedMinor?: MinorUnits
}

export interface InvoiceResult {
  readonly lines: readonly LineResult[]
  /** Σ line gross */
  readonly grossMinor: MinorUnits
  /** Line deductions totalled per key across all lines, in order of first appearance. */
  readonly lineDeductionTotals: readonly KeyedAmount[]
  /** Σ line deductions */
  readonly lineDeductionMinor: MinorUnits
  /** Σ line net */
  readonly linesNetMinor: MinorUnits
  /** Invoice-level deductions */
  readonly deductions: readonly DeductionResult[]
  readonly invoiceDeductionMinor: MinorUnits
  /** linesNet − invoice-level deductions */
  readonly netMinor: MinorUnits
  readonly charges: readonly KeyedAmount[]
  readonly chargesMinor: MinorUnits
  /** net + charges */
  readonly totalMinor: MinorUnits
  readonly previousBalanceMinor: MinorUnits
  readonly receivedMinor: MinorUnits
  /** previousBalance + total − received. Negative means the customer is in credit. */
  readonly outstandingMinor: MinorUnits
}

function assertKeys(keys: readonly string[], kind: string): void {
  const seen = new Set<string>()
  for (const key of keys) {
    if (key.trim() === '') throw new DomainError('INVALID_ARGUMENT', `Every ${kind} needs a key.`)
    if (seen.has(key)) {
      throw new DomainError('INVALID_ARGUMENT', `The ${kind} "${key}" is listed more than once.`)
    }
    seen.add(key)
  }
}

function deductionAmount(
  deduction: Deduction,
  originalMinor: MinorUnits,
  remainingMinor: MinorUnits
): MinorUnits {
  const { key, spec } = deduction
  const basis = deduction.basis ?? 'original'
  if (basis !== 'original' && basis !== 'remaining') {
    throw new DomainError('INVALID_ARGUMENT', `Deduction "${key}" has an unknown basis.`)
  }
  if (spec.type === 'amount') {
    assertNonNegativeInteger(spec.amountMinor, `Deduction "${key}" amount`)
    return spec.amountMinor
  }
  if (spec.type === 'percent') {
    assertNonNegativeInteger(spec.bps, `Deduction "${key}" percentage`)
    if (spec.bps > BPS_PER_WHOLE) {
      throw new DomainError('INVALID_ARGUMENT', `Deduction "${key}" cannot be more than 100%.`)
    }
    return basisPointsOf(basis === 'remaining' ? remainingMinor : originalMinor, spec.bps)
  }
  throw new DomainError('INVALID_ARGUMENT', `Deduction "${key}" has an unknown type.`)
}

/**
 * Applies deductions in order to a non-negative amount. Each deduction may take at most what remains, so
 * the result never goes below zero; a larger one throws DEDUCTION_EXCEEDS_BASE. Percentages are rounded
 * half-up once per deduction.
 */
export function applyDeductions(
  baseMinor: MinorUnits,
  deductions: readonly Deduction[] = []
): DeductionsResult {
  assertNonNegativeInteger(baseMinor, 'Amount before deductions')
  assertKeys(
    deductions.map((deduction) => deduction.key),
    'deduction'
  )
  let remaining = baseMinor
  const results = deductions.map((deduction): DeductionResult => {
    const amountMinor = deductionAmount(deduction, baseMinor, remaining)
    if (amountMinor > remaining) {
      throw new DomainError(
        'DEDUCTION_EXCEEDS_BASE',
        `Deduction "${deduction.key}" (${amountMinor}) is more than the remaining amount (${remaining}).`
      )
    }
    remaining -= amountMinor
    const bps = deduction.spec.type === 'percent' ? deduction.spec.bps : null
    return { key: deduction.key, amountMinor, bps }
  })
  return { deductions: results, totalMinor: baseMinor - remaining, remainingMinor: remaining }
}

/** qtyBase = quantity × unitBaseQty; amount = quantity × unitPrice. */
export function calculateQuantityRow(row: QuantityRowInput): QuantityRowResult {
  assertNonNegativeInteger(row.unitPriceMinor, 'Unit price')
  return {
    quantity: row.quantity,
    unitBaseQty: row.unitBaseQty,
    unitPriceMinor: row.unitPriceMinor,
    qtyBase: toBaseQuantity(row.quantity, row.unitBaseQty),
    amountMinor: multiplyMinor(row.unitPriceMinor, row.quantity)
  }
}

/** One product line: gross = Σ row amounts, then the line's deductions, giving net. */
export function calculateLine(line: LineInput): LineResult {
  const quantities = line.quantities.map(calculateQuantityRow)
  const grossMinor = sumMinor(quantities.map((row) => row.amountMinor))
  const { deductions, totalMinor, remainingMinor } = applyDeductions(grossMinor, line.deductions)
  return {
    quantities,
    qtyBase: sumMinor(quantities.map((row) => row.qtyBase)),
    grossMinor,
    deductions,
    totalDeductionMinor: totalMinor,
    netMinor: remainingMinor
  }
}

function totalsByKey(items: readonly KeyedAmount[]): KeyedAmount[] {
  const totals = new Map<string, MinorUnits>()
  for (const item of items)
    totals.set(item.key, addMinor(totals.get(item.key) ?? 0, item.amountMinor))
  return [...totals].map(([key, amountMinor]) => ({ key, amountMinor }))
}

/**
 * Whole-invoice totals. The identities below always hold exactly:
 *
 *   gross − lineDeductions − invoiceDeductions + charges = total
 *   previousBalance + total − received = outstanding
 *
 * Which of `netMinor` / `totalMinor` is printed as "Current Invoice", and which amount is written in words,
 * is left to the caller (B6).
 */
export function calculateInvoice(input: InvoiceInput): InvoiceResult {
  const lines = input.lines.map(calculateLine)
  const grossMinor = sumMinor(lines.map((line) => line.grossMinor))
  const lineDeductionMinor = sumMinor(lines.map((line) => line.totalDeductionMinor))
  const linesNetMinor = sumMinor(lines.map((line) => line.netMinor))
  const invoiceDeductions = applyDeductions(linesNetMinor, input.deductions)

  const charges = input.charges ?? []
  assertKeys(
    charges.map((charge) => charge.key),
    'charge'
  )
  for (const charge of charges)
    assertNonNegativeInteger(charge.amountMinor, `Charge "${charge.key}"`)
  const chargesMinor = sumMinor(charges.map((charge) => charge.amountMinor))

  const netMinor = invoiceDeductions.remainingMinor
  const totalMinor = addMinor(netMinor, chargesMinor)

  const previousBalanceMinor = input.previousBalanceMinor ?? 0
  const receivedMinor = input.receivedMinor ?? 0
  assertSafeInteger(previousBalanceMinor, 'Previous balance')
  assertNonNegativeInteger(receivedMinor, 'Received amount')
  const outstandingMinor = subtractMinor(addMinor(previousBalanceMinor, totalMinor), receivedMinor)

  return {
    lines,
    grossMinor,
    lineDeductionTotals: totalsByKey(lines.flatMap((line) => line.deductions)),
    lineDeductionMinor,
    linesNetMinor,
    deductions: invoiceDeductions.deductions,
    invoiceDeductionMinor: invoiceDeductions.totalMinor,
    netMinor,
    charges: charges.map((charge) => ({ key: charge.key, amountMinor: charge.amountMinor })),
    chargesMinor,
    totalMinor,
    previousBalanceMinor,
    receivedMinor,
    outstandingMinor
  }
}
