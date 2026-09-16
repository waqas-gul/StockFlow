import {
  DomainError,
  applyDeductions,
  calculateInvoice,
  calculateLine,
  totalBaseQuantity,
  type Deduction,
  type LineResult
} from './domain'

/*
 * The invoice totals (plan §11.2), in integer minor units, built on the Phase 2 calculator with fixed keys and order:
 *
 *   per line:  gross = Σ quantity × unit price;  discount (a percentage of gross, rounded half-up, or an amount);
 *              scheme (an amount);  net = gross − discount − scheme  (never below zero)
 *              qtyBase = paid base quantity + free scheme base quantity  (free goods leave stock, add no revenue)
 *   invoice:   net = Σ line net − extra discount;  total = net + freight
 *              netOutstanding = previous balance + total − received
 *
 * Pure: it receives already-resolved unit sizes and prices. The billing form uses it as a preview; the main process
 * resolves sizes and prices from the database and runs the same calculation again when an invoice is posted.
 */

export type LineDiscount =
  | { readonly type: 'PERCENT'; readonly bps: number }
  | { readonly type: 'AMOUNT'; readonly amountMinor: number }

export interface InvoiceTotalsLineInput {
  readonly quantities: readonly {
    readonly quantity: number
    readonly unitBaseQty: number
    readonly unitPriceMinor: number
  }[]
  /** Free scheme goods: stock leaves, nothing is charged. */
  readonly freeQuantities: readonly { readonly quantity: number; readonly unitBaseQty: number }[]
  readonly discount: LineDiscount | null
  readonly schemeMinor: number
}

export interface InvoiceTotalsInput {
  readonly lines: readonly InvoiceTotalsLineInput[]
  readonly extraDiscountMinor: number
  readonly freightMinor: number
  readonly receivedMinor: number
  /** The customer's balance before the invoice (negative: an advance). */
  readonly previousBalanceMinor: number
}

export interface InvoiceLineTotals {
  readonly quantities: LineResult['quantities']
  /** Σ quantity rows, in base units. */
  readonly paidQtyBase: number
  /** Free scheme goods, in base units. */
  readonly schemeQtyBase: number
  /** paid + scheme: everything that leaves stock. */
  readonly qtyBase: number
  readonly grossMinor: number
  /** The percentage entered, or null for a fixed amount or no discount. */
  readonly discountBps: number | null
  readonly discountMinor: number
  readonly schemeMinor: number
  readonly netMinor: number
}

export interface InvoiceTotals {
  readonly lines: readonly InvoiceLineTotals[]
  readonly grossMinor: number
  readonly lineDiscountMinor: number
  readonly lineSchemeMinor: number
  readonly extraDiscountMinor: number
  readonly netMinor: number
  readonly freightMinor: number
  readonly totalMinor: number
  readonly receivedMinor: number
  readonly previousBalanceMinor: number
  readonly netOutstandingMinor: number
}

/** A field the totals cannot be calculated for, keyed like a form field error (`lines.0.discount`). */
export interface InvoiceTotalsIssue {
  readonly path: string
  readonly message: string
}

export type InvoiceTotalsResult =
  | { readonly ok: true; readonly totals: InvoiceTotals }
  | { readonly ok: false; readonly issues: readonly InvoiceTotalsIssue[] }

const DISCOUNT = 'discount'
const SCHEME = 'scheme'
const EXTRA_DISCOUNT = 'extraDiscount'
const FREIGHT = 'freight'

/**
 * The invoice totals, or the fields that make them impossible: a deduction larger than what it applies to, or amounts
 * too large to calculate exactly. Invalid numbers (negative, fractional) are the caller's error and still throw.
 */
export function calculateInvoiceTotals(input: InvoiceTotalsInput): InvoiceTotalsResult {
  const issues: InvoiceTotalsIssue[] = []
  const lines = input.lines.map((line, index) => lineTotals(line, index, issues))
  if (issues.length > 0) return { ok: false, issues }

  try {
    const invoice = calculateInvoice({
      lines: input.lines.map(toLineInput),
      deductions: [
        { key: EXTRA_DISCOUNT, spec: { type: 'amount', amountMinor: input.extraDiscountMinor } }
      ],
      charges: [{ key: FREIGHT, amountMinor: input.freightMinor }],
      previousBalanceMinor: input.previousBalanceMinor,
      receivedMinor: input.receivedMinor
    })
    const deducted = (key: string): number =>
      invoice.lineDeductionTotals.find((total) => total.key === key)?.amountMinor ?? 0
    return {
      ok: true,
      totals: {
        lines: lines as InvoiceLineTotals[],
        grossMinor: invoice.grossMinor,
        lineDiscountMinor: deducted(DISCOUNT),
        lineSchemeMinor: deducted(SCHEME),
        extraDiscountMinor: invoice.invoiceDeductionMinor,
        netMinor: invoice.netMinor,
        freightMinor: invoice.chargesMinor,
        totalMinor: invoice.totalMinor,
        receivedMinor: invoice.receivedMinor,
        previousBalanceMinor: invoice.previousBalanceMinor,
        netOutstandingMinor: invoice.outstandingMinor
      }
    }
  } catch (error) {
    if (isDomainError(error, 'DEDUCTION_EXCEEDS_BASE')) {
      return {
        ok: false,
        issues: [
          {
            path: 'extraDiscountMinor',
            message:
              'The extra discount cannot be more than the invoice amount after line discounts.'
          }
        ]
      }
    }
    if (isDomainError(error, 'OUT_OF_RANGE')) {
      return {
        ok: false,
        issues: [{ path: 'root', message: 'The invoice amounts are too large.' }]
      }
    }
    throw error
  }
}

function lineTotals(
  line: InvoiceTotalsLineInput,
  index: number,
  issues: InvoiceTotalsIssue[]
): InvoiceLineTotals | null {
  try {
    const gross = calculateLine({ quantities: line.quantities })
    const discount = discountDeduction(line.discount)
    try {
      applyDeductions(gross.grossMinor, discount === null ? [] : [discount])
    } catch (error) {
      if (!isDomainError(error, 'DEDUCTION_EXCEEDS_BASE')) throw error
      issues.push({
        path: `lines.${index}.discount`,
        message: 'The discount cannot be more than the line amount.'
      })
      return null
    }
    let result: LineResult
    try {
      result = calculateLine(toLineInput(line))
    } catch (error) {
      if (!isDomainError(error, 'DEDUCTION_EXCEEDS_BASE')) throw error
      issues.push({
        path: `lines.${index}.schemeMinor`,
        message: 'The scheme cannot be more than the line amount after the discount.'
      })
      return null
    }
    const schemeQtyBase = totalBaseQuantity(line.freeQuantities)
    const amountOf = (key: string): number =>
      result.deductions.find((deduction) => deduction.key === key)?.amountMinor ?? 0
    return {
      quantities: result.quantities,
      paidQtyBase: result.qtyBase,
      schemeQtyBase,
      qtyBase: totalBaseQuantity([...line.quantities, ...line.freeQuantities]),
      grossMinor: result.grossMinor,
      discountBps: line.discount?.type === 'PERCENT' ? line.discount.bps : null,
      discountMinor: amountOf(DISCOUNT),
      schemeMinor: amountOf(SCHEME),
      netMinor: result.netMinor
    }
  } catch (error) {
    if (!isDomainError(error, 'OUT_OF_RANGE')) throw error
    issues.push({ path: `lines.${index}`, message: 'The amounts on this line are too large.' })
    return null
  }
}

function toLineInput(line: InvoiceTotalsLineInput): {
  quantities: InvoiceTotalsLineInput['quantities']
  deductions: Deduction[]
} {
  const discount = discountDeduction(line.discount)
  return {
    quantities: line.quantities,
    deductions: [
      ...(discount === null ? [] : [discount]),
      { key: SCHEME, spec: { type: 'amount', amountMinor: line.schemeMinor } }
    ]
  }
}

function discountDeduction(discount: LineDiscount | null): Deduction | null {
  if (discount === null) return null
  return discount.type === 'PERCENT'
    ? { key: DISCOUNT, spec: { type: 'percent', bps: discount.bps } }
    : { key: DISCOUNT, spec: { type: 'amount', amountMinor: discount.amountMinor } }
}

function isDomainError(error: unknown, code: DomainError['code']): boolean {
  return error instanceof DomainError && error.code === code
}
