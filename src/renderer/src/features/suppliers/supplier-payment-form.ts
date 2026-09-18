import { z } from 'zod'
import { isCalendarDate } from '@shared/dates'
import { parseMoney } from '@shared/domain'
import { PAYMENT_METHODS, type PaymentMethod } from '@shared/payments'
import {
  SUPPLIER_PAYMENT_NOTE_MAX,
  SUPPLIER_PAYMENT_REFERENCE_MAX,
  type SupplierPaymentCreateInput
} from '@shared/suppliers'
import { optionalText, positiveMoneyText } from '@renderer/lib/form-text'
import { fieldPairs } from '../customers/customer-form'
import { supplierLabel } from './supplier-display'

/*
 * Pay Supplier. The amount is typed as text and parsed with the Phase 2 money parser. The balance preview is only a
 * preview: the main process posts the payment against the balance as it is then.
 */

export interface SupplierPaymentFormValues {
  /** The chosen supplier; null until one is picked. */
  supplierId: number | null
  /** "SUP-00001 ABC Distributors", shown in the picker. */
  supplierLabel: string
  paymentDate: string
  amount: string
  method: PaymentMethod
  reference: string
  note: string
}

export type SupplierPaymentDraft = Omit<
  SupplierPaymentCreateInput,
  'requestId' | 'currencyMinorDigits'
>

export function emptySupplierPaymentForm(today: string): SupplierPaymentFormValues {
  return {
    supplierId: null,
    supplierLabel: '',
    paymentDate: today,
    amount: '',
    method: 'CASH',
    reference: '',
    note: ''
  }
}

export function withSupplier(
  values: SupplierPaymentFormValues,
  supplier: { readonly id: number; readonly code: string; readonly name: string }
): SupplierPaymentFormValues {
  return { ...values, supplierId: supplier.id, supplierLabel: supplierLabel(supplier) }
}

export function supplierPaymentFormSchema(
  minorDigits: number
): z.ZodType<SupplierPaymentDraft, SupplierPaymentFormValues> {
  return z
    .object({
      supplierId: z
        .number()
        .nullable()
        .refine((id) => id !== null, 'Choose the supplier.'),
      supplierLabel: z.string(),
      paymentDate: z.string().refine(isCalendarDate, 'Enter a valid date.'),
      amount: positiveMoneyText(minorDigits, 'Enter the amount paid.'),
      method: z.enum(PAYMENT_METHODS, { error: 'Choose the payment method.' }),
      reference: optionalText(SUPPLIER_PAYMENT_REFERENCE_MAX),
      note: optionalText(SUPPLIER_PAYMENT_NOTE_MAX)
    })
    .transform((values): SupplierPaymentDraft => ({
      supplierId: values.supplierId ?? 0,
      paymentDate: values.paymentDate,
      amountMinor: values.amount,
      method: values.method,
      reference: values.reference,
      note: values.note
    }))
}

export function toSupplierPaymentInput(
  draft: SupplierPaymentDraft,
  requestId: string,
  minorDigits: number
): SupplierPaymentCreateInput {
  return { requestId, ...draft, currencyMinorDigits: minorDigits }
}

export interface SupplierPaymentPreview {
  /** The typed amount; null while it is not a valid amount above zero. */
  readonly amountMinor: number | null
  readonly balanceAfterMinor: number | null
  /** The part of the payment that becomes (or adds to) a supplier advance; null when none does. */
  readonly advanceMinor: number | null
}

/** The supplier balance after the payment as typed so far, and the advance an overpayment creates. */
export function supplierPaymentPreview(
  balanceMinor: number,
  amountText: string,
  minorDigits: number
): SupplierPaymentPreview {
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

export function serverSupplierPaymentErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Array<[string, string]> {
  return fieldPairs(fieldErrors, {
    supplierId: 'supplierId',
    paymentDate: 'paymentDate',
    amountMinor: 'amount',
    method: 'method',
    reference: 'reference',
    note: 'note'
  })
}
