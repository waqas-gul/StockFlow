import type { PaymentDetail, PaymentStatus } from '@shared/payments'
import { customerLabel } from '../customers/customer-display'
import { formatAmount, type CurrencyFormat } from '../products/product-display'

export const PAYMENT_STATUS_LABELS: Readonly<Record<PaymentStatus, string>> = {
  POSTED: 'Posted',
  VOID: 'Void'
}

/** What a void does, shown before it is confirmed. */
export function voidConfirmationText(
  payment: Pick<PaymentDetail, 'paymentNo' | 'amountMinor' | 'customerCode' | 'customerName'>,
  currency: CurrencyFormat
): string {
  return `Voiding ${payment.paymentNo} adds ${formatAmount(payment.amountMinor, currency)} back to the balance of ${payment.customerCode} ${payment.customerName}. The payment stays in the history as void.`
}

/** 'C-00002 Ali Raza (Ali Traders)' for a payment's customer. */
export function paymentCustomerLabel(
  payment: Pick<PaymentDetail, 'customerCode' | 'customerName' | 'shopName'>
): string {
  return customerLabel({
    code: payment.customerCode,
    name: payment.customerName,
    shopName: payment.shopName
  })
}
