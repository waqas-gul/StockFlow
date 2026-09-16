import type {
  DuplicatePaymentCheck,
  PaymentCreateInput,
  PaymentDuplicateCheckInput,
  PaymentSaveResult,
  PaymentSummary,
  PaymentVoidInput,
  PaymentVoidResult
} from '@shared/payments'
import type { Result } from '@shared/types/result'
import { balanceText } from '../customers/customer-display'
import type { CurrencyFormat } from '../products/product-display'
import { serverPaymentErrors } from './payment-form'

export interface PaymentNotifier {
  success(message: string): void
  error(message: string): void
  warning(message: string): void
}

export interface PaymentSubmitHandlers {
  /**
   * Asked when posted payments with the same customer, date and amount exist: resolves true to save anyway
   * (Continue), false to save nothing (Cancel).
   */
  confirmDuplicate(duplicates: readonly PaymentSummary[]): Promise<boolean>
  onSaved(payment: PaymentSaveResult): void
  /** A main-process error for a form field (a form path such as `amount` or `paymentDate`). */
  onFieldError(path: string, message: string): void
  readonly notify: PaymentNotifier
  readonly currency: CurrencyFormat
}

export type PaymentSubmitOutcome = 'saved' | 'cancelled' | 'failed'

/**
 * Receives a payment: first the soft duplicate check (the operator may continue), then the payment itself. The request
 * id stays the same for a retry, so a lost answer never posts the payment twice.
 */
export async function submitPayment(
  api: {
    checkDuplicate(input: PaymentDuplicateCheckInput): Promise<Result<DuplicatePaymentCheck>>
    create(input: PaymentCreateInput): Promise<Result<PaymentSaveResult>>
  },
  input: PaymentCreateInput,
  handlers: PaymentSubmitHandlers
): Promise<PaymentSubmitOutcome> {
  let result: Result<PaymentSaveResult>
  try {
    const check = await api.checkDuplicate({
      customerId: input.customerId,
      paymentDate: input.paymentDate,
      amountMinor: input.amountMinor
    })
    // A refused check (e.g. a date the main process cannot read) is reported by the save itself.
    if (check.ok && check.data.duplicates.length > 0) {
      if (!(await handlers.confirmDuplicate(check.data.duplicates))) return 'cancelled'
    }
    result = await api.create(input)
  } catch {
    handlers.notify.error('The payment could not be saved. Try again.')
    return 'failed'
  }
  if (result.ok) {
    handlers.onSaved(result.data)
    const balance = balanceText(result.data.balanceAfterMinor, handlers.currency)
    handlers.notify.success(
      result.data.replayed
        ? `Payment ${result.data.paymentNo} was already saved. Balance now: ${balance}.`
        : `Payment ${result.data.paymentNo} saved. Balance now: ${balance}.`
    )
    return 'saved'
  }
  for (const [path, message] of serverPaymentErrors(result.error.fieldErrors)) {
    handlers.onFieldError(path, message)
  }
  handlers.notify.error(result.error.message)
  return 'failed'
}

/** Voids a payment. Returns the void payment, or null when it was refused. */
export async function submitPaymentVoid(
  api: { void(input: PaymentVoidInput): Promise<Result<PaymentVoidResult>> },
  input: PaymentVoidInput,
  notify: PaymentNotifier,
  currency: CurrencyFormat
): Promise<PaymentVoidResult | null> {
  let result: Result<PaymentVoidResult>
  try {
    result = await api.void(input)
  } catch {
    notify.error('The payment could not be voided. Try again.')
    return null
  }
  if (!result.ok) {
    notify.error(result.error.message)
    return null
  }
  notify.success(
    `Payment ${result.data.paymentNo} voided. Balance now: ${balanceText(result.data.balanceAfterMinor, currency)}.`
  )
  return result.data
}
