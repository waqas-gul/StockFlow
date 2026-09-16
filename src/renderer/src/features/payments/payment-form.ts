import { z } from 'zod'
import { isCalendarDate } from '@shared/dates'
import { parseMoney } from '@shared/domain'
import {
  PAYMENT_METHODS,
  PAYMENT_NOTE_MAX,
  PAYMENT_REFERENCE_MAX,
  type PaymentCreateInput,
  type PaymentMethod
} from '@shared/payments'
import { optionalText, positiveMoneyText } from '@renderer/lib/form-text'
import { customerLabel } from '../customers/customer-display'
import { fieldPairs } from '../customers/customer-form'

/*
 * Receive Payment. The amount is typed as text and parsed with the Phase 2 money parser. The balance preview is only a
 * preview: the main process posts the payment against the balance as it is then.
 */

export interface PaymentFormValues {
  /** The chosen customer; null until one is picked. */
  customerId: number | null
  /** "C-00002 Ali Raza (Ali Traders)", shown in the picker. */
  customerLabel: string
  paymentDate: string
  amount: string
  method: PaymentMethod
  reference: string
  note: string
}

/** What the form produces: the payment input without the request id and the currency check. */
export type PaymentDraft = Omit<PaymentCreateInput, 'requestId' | 'currencyMinorDigits'>

export function emptyPaymentForm(today: string): PaymentFormValues {
  return {
    customerId: null,
    customerLabel: '',
    paymentDate: today,
    amount: '',
    method: 'CASH',
    reference: '',
    note: ''
  }
}

export function withCustomer(
  values: PaymentFormValues,
  customer: {
    readonly id: number
    readonly code: string
    readonly name: string
    readonly shopName: string | null
  }
): PaymentFormValues {
  return { ...values, customerId: customer.id, customerLabel: customerLabel(customer) }
}

export function paymentFormSchema(minorDigits: number): z.ZodType<PaymentDraft, PaymentFormValues> {
  return z
    .object({
      customerId: z
        .number()
        .nullable()
        .refine((id) => id !== null, 'Choose the customer.'),
      customerLabel: z.string(),
      paymentDate: z.string().refine(isCalendarDate, 'Enter a valid date.'),
      amount: positiveMoneyText(minorDigits, 'Enter the amount received.'),
      method: z.enum(PAYMENT_METHODS, { error: 'Choose the payment method.' }),
      reference: optionalText(PAYMENT_REFERENCE_MAX),
      note: optionalText(PAYMENT_NOTE_MAX)
    })
    .transform((values): PaymentDraft => {
      return {
        customerId: values.customerId ?? 0,
        paymentDate: values.paymentDate,
        amountMinor: values.amount,
        method: values.method,
        reference: values.reference,
        note: values.note
      }
    })
}

export function toPaymentInput(
  draft: PaymentDraft,
  requestId: string,
  minorDigits: number
): PaymentCreateInput {
  return { requestId, ...draft, currencyMinorDigits: minorDigits }
}

export interface PaymentPreview {
  /** The typed amount; null while it is not a valid amount above zero. */
  readonly amountMinor: number | null
  readonly balanceAfterMinor: number | null
  /** The part of the payment that becomes (or adds to) an advance; null when none does. */
  readonly advanceMinor: number | null
}

/** The customer's balance after the payment as typed so far, and the advance an overpayment creates. */
export function paymentPreview(
  balanceMinor: number,
  amountText: string,
  minorDigits: number
): PaymentPreview {
  const parsed = parseMoney(amountText, { minorDigits })
  if (!parsed.ok || parsed.value === 0) {
    return { amountMinor: null, balanceAfterMinor: null, advanceMinor: null }
  }
  const advance = parsed.value - Math.max(balanceMinor, 0)
  return {
    amountMinor: parsed.value,
    balanceAfterMinor: balanceMinor - parsed.value,
    advanceMinor: advance > 0 ? advance : null
  }
}

/** The main process's field errors as [form path, message] pairs. */
export function serverPaymentErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Array<[string, string]> {
  return fieldPairs(fieldErrors, {
    customerId: 'customerId',
    paymentDate: 'paymentDate',
    amountMinor: 'amount',
    method: 'method',
    reference: 'reference',
    note: 'note'
  })
}
