import { balanceState } from '@shared/customers'
import { PAYMENT_METHOD_LABELS } from '@shared/payments'
import type { SupplierLedgerRow, SupplierLedgerType } from '@shared/suppliers'
import { formatAmount, type CurrencyFormat } from '../products/product-display'

/*
 * How supplier balances and ledger entries read to the owner. A balance is never shown as a signed number: positive is
 * "Due" (the shop owes the supplier), zero "Settled", negative "Advance" (the shop has paid the supplier more than it
 * owes). The wording mirrors the customer screens, with the direction of the debt reversed.
 */

/** 'Rs 5,000.00 Due', 'Rs 750.00 Advance' or 'Settled'. */
export function supplierBalanceText(balanceMinor: number, currency: CurrencyFormat): string {
  switch (balanceState(balanceMinor)) {
    case 'DUE':
      return `${formatAmount(balanceMinor, currency)} Due`
    case 'ADVANCE':
      return `${formatAmount(-balanceMinor, currency)} Advance`
    default:
      return 'Settled'
  }
}

export function supplierBalanceDescription(balanceMinor: number): string {
  switch (balanceState(balanceMinor)) {
    case 'DUE':
      return 'The shop owes the supplier.'
    case 'ADVANCE':
      return 'The supplier holds an advance of the shop’s money.'
    default:
      return 'Nothing is owed either way.'
  }
}

/** Text colour for a supplier balance: amber when the shop owes, green for an advance, muted when settled. */
export function supplierBalanceClassName(balanceMinor: number): string {
  switch (balanceState(balanceMinor)) {
    case 'DUE':
      return 'text-amber-700'
    case 'ADVANCE':
      return 'text-emerald-700'
    default:
      return 'text-muted-foreground'
  }
}

export const SUPPLIER_LEDGER_LABELS: Readonly<Record<SupplierLedgerType, string>> = {
  OPENING: 'Opening balance',
  PURCHASE: 'Stock purchase',
  PURCHASE_VOID: 'Purchase voided',
  PAYMENT: 'Payment',
  PAYMENT_VOID: 'Payment voided',
  ADJUSTMENT: 'Balance adjustment'
}

/** 'Payment · Bank', 'Opening balance (due)', 'Stock purchase'. */
export function supplierLedgerLabel(row: SupplierLedgerRow): string {
  const label = SUPPLIER_LEDGER_LABELS[row.type]
  if (row.type === 'OPENING') return `${label} (${row.amountMinor > 0 ? 'due' : 'advance'})`
  if (row.type === 'PAYMENT' && row.paymentMethod !== null) {
    return `${label} · ${PAYMENT_METHOD_LABELS[row.paymentMethod]}`
  }
  return label
}

/** The document an entry belongs to: 'GRN-000001 · Bill ABC-101', 'SPAY-000001', or ''. */
export function supplierLedgerReference(row: SupplierLedgerRow): string {
  if (row.receiptNo !== null) {
    return row.supplierBillNo === null
      ? row.receiptNo
      : `${row.receiptNo} · Bill ${row.supplierBillNo}`
  }
  return row.paymentNo ?? ''
}

/** A signed ledger amount as the owner reads it: '+Rs 50,000.00' (owes more) or '−Rs 20,000.00' (owes less). */
export function supplierLedgerAmount(amountMinor: number, currency: CurrencyFormat): string {
  return amountMinor > 0
    ? `+${formatAmount(amountMinor, currency)}`
    : `−${formatAmount(-amountMinor, currency)}`
}

/** 'SUP-00001 ABC Distributors'. */
export function supplierLabel(supplier: { readonly code: string; readonly name: string }): string {
  return `${supplier.code} ${supplier.name}`
}

/** The deactivate confirmation: what changes, and the balance and history that stay. */
export function supplierDeactivateText(balance: string): string {
  return `New stock purchases will need the supplier to be reactivated. Payments, payment voids and balance adjustments stay available, and the balance (${balance}) and history stay. You can reactivate at any time.`
}
