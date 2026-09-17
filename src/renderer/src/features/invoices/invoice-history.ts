import { isWalkInCustomer } from '@shared/customers'
import {
  INVOICE_DISPATCH_FIELD_LABELS,
  type InvoiceDetail,
  type InvoiceDispatchField,
  type InvoiceDispatchResult,
  type InvoiceDispatchUpdateInput,
  type InvoiceLine,
  type InvoiceQuantity,
  type InvoiceStatus,
  type InvoiceVoidInput,
  type InvoiceVoidResult
} from '@shared/invoices'
import type { Result } from '@shared/types/result'
import { balanceText } from '../customers/customer-display'
import { formatAmount, type CurrencyFormat } from '../products/product-display'

/*
 * Invoice History and Detail (Phase 9A): what the saved invoice shows, what voiding it does to its payment, and the
 * void and dispatch-change calls with their messages. Everything shown comes from the invoice's own saved copies.
 */

export const INVOICE_STATUS_LABELS: Readonly<Record<InvoiceStatus, string>> = Object.freeze({
  POSTED: 'Posted',
  VOID: 'Void'
})

export interface InvoiceNotifier {
  success(message: string): void
  error(message: string): void
}

/** What a void does to the payment received with the invoice. */
export interface VoidPlan {
  /**
   * A walk-in invoice whose payment is still posted: the operator must confirm the money was returned, and that payment
   * is voided with the invoice.
   */
  readonly moneyReturnedRequired: boolean
  /** Shown in the confirmation; null when the invoice has no posted payment. */
  readonly paymentWarning: string | null
}

export function voidPlan(invoice: InvoiceDetail, currency: CurrencyFormat): VoidPlan {
  const payment = invoice.payment
  if (payment === null || payment.status === 'VOID') {
    return { moneyReturnedRequired: false, paymentWarning: null }
  }
  const amount = formatAmount(payment.amountMinor, currency)
  if (isWalkInCustomer(invoice.customerCode)) {
    return {
      moneyReturnedRequired: true,
      paymentWarning: `This cash sale was paid ${amount} (${payment.paymentNo}). The walk-in account stays at zero, so the invoice can be voided only if the money is returned: payment ${payment.paymentNo} is voided with it.`
    }
  }
  return {
    moneyReturnedRequired: false,
    paymentWarning: `This invoice has a payment of ${amount}. Voiding the invoice will keep that payment on the customer's account as credit. Void the payment separately if the money was also returned.`
  }
}

/** The void can be sent once a reason is entered and, for a walk-in sale, the money is confirmed returned. */
export function canConfirmVoid(plan: VoidPlan, reason: string, moneyReturned: boolean): boolean {
  return reason.trim() !== '' && (!plan.moneyReturnedRequired || moneyReturned)
}

/**
 * A base quantity in the units saved on the line, largest first ("1 Box + 2 Piece"). Free scheme goods are saved as a
 * base quantity only, so what the line's saved units cannot express is given in base units.
 */
export function savedQuantityText(qtyBase: number, quantities: readonly InvoiceQuantity[]): string {
  const units = [...new Map(quantities.map((row) => [row.unitBaseQty, row])).values()].sort(
    (a, b) => b.unitBaseQty - a.unitBaseQty
  )
  const parts: string[] = []
  let rest = qtyBase
  for (const unit of units) {
    const count = Math.floor(rest / unit.unitBaseQty)
    if (count > 0) {
      parts.push(`${count.toLocaleString('en-US')} ${unit.unitName}`)
      rest -= count * unit.unitBaseQty
    }
  }
  if (rest > 0) parts.push(`${rest.toLocaleString('en-US')} base ${rest === 1 ? 'unit' : 'units'}`)
  return parts.length === 0 ? '0' : parts.join(' + ')
}

/** '2 Box × Rs 2,400.00 = Rs 4,800.00'. */
export function quantityRowText(row: InvoiceQuantity, currency: CurrencyFormat): string {
  return `${row.quantity.toLocaleString('en-US')} ${row.unitName} × ${formatAmount(row.unitPriceMinor, currency)} = ${formatAmount(row.amountMinor, currency)}`
}

/** 'Rs 262.50 (5%)', or the amount alone for a fixed discount; '—' without one. */
export function lineDiscountText(line: InvoiceLine, currency: CurrencyFormat): string {
  if (line.discountMinor === 0 && (line.discountBps === null || line.discountBps === 0)) return '—'
  const amount = formatAmount(line.discountMinor, currency)
  if (line.discountBps === null) return amount
  const percent = (line.discountBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })
  return `${amount} (${percent}%)`
}

export function dispatchFieldLabel(field: string): string {
  return INVOICE_DISPATCH_FIELD_LABELS[field as InvoiceDispatchField] ?? field
}

/** The first message of each field error. */
function firstMessages(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fieldErrors ?? {}).map(([path, messages]) => [path, messages[0] ?? ''])
  )
}

export type VoidOutcome =
  | { readonly voided: InvoiceVoidResult }
  | { readonly voided: null; readonly fieldErrors: Readonly<Record<string, string>> }

/** Voids an invoice: a success message with the balance now, or the refusal as a message and field errors. */
export async function submitInvoiceVoid(
  api: { void(input: InvoiceVoidInput): Promise<Result<InvoiceVoidResult>> },
  input: InvoiceVoidInput,
  notify: InvoiceNotifier,
  currency: CurrencyFormat
): Promise<VoidOutcome> {
  let result: Result<InvoiceVoidResult>
  try {
    result = await api.void(input)
  } catch {
    notify.error('The invoice could not be voided. Try again.')
    return { voided: null, fieldErrors: {} }
  }
  if (!result.ok) {
    notify.error(result.error.message)
    return { voided: null, fieldErrors: firstMessages(result.error.fieldErrors) }
  }
  const { invoiceNo, payment, balanceAfterMinor } = result.data
  const returned =
    input.moneyReturned && payment !== null
      ? ` Payment ${payment.paymentNo} was voided with it.`
      : ''
  notify.success(
    `Invoice ${invoiceNo} voided.${returned} Balance now: ${balanceText(balanceAfterMinor, currency)}.`
  )
  return { voided: result.data }
}

export type DispatchOutcome =
  | { readonly saved: InvoiceDispatchResult }
  | { readonly saved: null; readonly fieldErrors: Readonly<Record<string, string>> }

/** Saves the dispatch details: says whether anything changed, or returns the refusal's field errors. */
export async function submitDispatchUpdate(
  api: {
    updateDispatch(input: InvoiceDispatchUpdateInput): Promise<Result<InvoiceDispatchResult>>
  },
  input: InvoiceDispatchUpdateInput,
  notify: InvoiceNotifier
): Promise<DispatchOutcome> {
  let result: Result<InvoiceDispatchResult>
  try {
    result = await api.updateDispatch(input)
  } catch {
    notify.error('The dispatch details could not be saved. Try again.')
    return { saved: null, fieldErrors: {} }
  }
  if (!result.ok) {
    notify.error(result.error.message)
    return { saved: null, fieldErrors: firstMessages(result.error.fieldErrors) }
  }
  notify.success(
    result.data.changedFields.length === 0
      ? 'Nothing changed: the dispatch details were already as entered.'
      : `Dispatch details of ${result.data.invoiceNo} saved.`
  )
  return { saved: result.data }
}
