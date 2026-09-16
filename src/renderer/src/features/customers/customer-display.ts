import { balanceState, type LedgerEntryType, type LedgerRow } from '@shared/customers'
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@shared/payments'
import { formatAmount, type CurrencyFormat } from '../products/product-display'

/*
 * How balances and ledger entries read to the operator. A balance is never shown as a signed number: positive is
 * "Due" (the customer owes the shop), zero "Settled", negative "Advance" (the shop holds money for the customer).
 */

/** 'Rs 5,000.00 Due', 'Rs 750.00 Advance' or 'Settled'. */
export function balanceText(balanceMinor: number, currency: CurrencyFormat): string {
  switch (balanceState(balanceMinor)) {
    case 'DUE':
      return `${formatAmount(balanceMinor, currency)} Due`
    case 'ADVANCE':
      return `${formatAmount(-balanceMinor, currency)} Advance`
    default:
      return 'Settled'
  }
}

export function balanceDescription(balanceMinor: number): string {
  switch (balanceState(balanceMinor)) {
    case 'DUE':
      return 'The customer owes the shop.'
    case 'ADVANCE':
      return 'The shop holds an advance for the customer.'
    default:
      return 'Nothing is owed either way.'
  }
}

/** Text colour for a balance: amber when due, green for an advance, muted when settled. */
export function balanceClassName(balanceMinor: number): string {
  switch (balanceState(balanceMinor)) {
    case 'DUE':
      return 'text-amber-700'
    case 'ADVANCE':
      return 'text-emerald-700'
    default:
      return 'text-muted-foreground'
  }
}

export const LEDGER_TYPE_LABELS: Readonly<Record<LedgerEntryType, string>> = {
  OPENING: 'Opening balance',
  INVOICE: 'Invoice',
  INVOICE_VOID: 'Invoice voided',
  PAYMENT: 'Payment received',
  PAYMENT_VOID: 'Payment voided',
  ADJUSTMENT: 'Balance adjustment'
}

/** 'Payment received · Cash', 'Opening balance (due)', 'Balance adjustment'. */
export function ledgerTypeLabel(row: LedgerRow): string {
  const label = LEDGER_TYPE_LABELS[row.type]
  if (row.type === 'OPENING') return `${label} (${row.amountMinor > 0 ? 'due' : 'advance'})`
  if (row.type === 'PAYMENT' && row.paymentMethod !== null) {
    return `${label} · ${PAYMENT_METHOD_LABELS[row.paymentMethod as PaymentMethod] ?? row.paymentMethod}`
  }
  return label
}

/** The document an entry belongs to: 'RCP-000001', an invoice number, or ''. */
export function ledgerReference(row: LedgerRow): string {
  return row.paymentNo ?? row.invoiceNo ?? ''
}

/** A ledger amount in its column: an increase (the customer owes more) or a decrease (owes less). */
export function ledgerAmounts(row: Pick<LedgerRow, 'amountMinor'>): {
  increaseMinor: number | null
  decreaseMinor: number | null
} {
  return row.amountMinor > 0
    ? { increaseMinor: row.amountMinor, decreaseMinor: null }
    : { increaseMinor: null, decreaseMinor: -row.amountMinor }
}

/** The deactivate confirmation: what changes, and the balance and history that stay. */
export function deactivateText(balance: string): string {
  return `New payments will need the customer to be reactivated. The balance (${balance}) and the account history stay, and you can reactivate at any time.`
}

/** 'C-00002 Ali Raza (Ali Traders)'. */
export function customerLabel(customer: {
  readonly code: string
  readonly name: string
  readonly shopName: string | null
}): string {
  return `${customer.code} ${customer.name}${customer.shopName === null ? '' : ` (${customer.shopName})`}`
}
