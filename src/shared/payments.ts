import { z } from 'zod'
import { CurrencyDigitsSchema, PositiveAmountSchema } from './customers'
import { isCalendarDate } from './dates'
import {
  DateSchema,
  IdSchema,
  RequestIdSchema,
  optionalText,
  requiredText,
  wholeNumber
} from './validation'

/*
 * Customer payment receipts (plan §7.3, §10). Posting a payment writes the payments row and a PAYMENT ledger entry of
 * −amount in one transaction; voiding it writes a PAYMENT_VOID entry of +amount. A saved payment is never edited.
 * V1 keeps a running account: a payment is not allocated to invoices, and it may exceed what the customer owes (the
 * rest becomes an advance).
 */

export const PAYMENT_NUMBER_PREFIX = 'RCP-'
export const PAYMENT_REFERENCE_MAX = 60
export const PAYMENT_NOTE_MAX = 300
export const MAX_PAYMENT_PAGE_SIZE = 100

export const PAYMENT_METHODS = ['CASH', 'BANK', 'CHEQUE', 'OTHER'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = Object.freeze({
  CASH: 'Cash',
  BANK: 'Bank',
  CHEQUE: 'Cheque',
  OTHER: 'Other'
})

export type PaymentStatus = 'POSTED' | 'VOID'

/** The soft warning before saving a payment that looks like one already posted. */
export const DUPLICATE_PAYMENT_WARNING =
  'A payment with the same customer, date and amount already exists.'

/** `window.api.payments.create(...)`: one payment receipt (a repeated request id returns the saved payment). */
export const PaymentCreateSchema = z.strictObject({
  requestId: RequestIdSchema,
  customerId: IdSchema,
  paymentDate: DateSchema,
  amountMinor: PositiveAmountSchema,
  method: z.enum(PAYMENT_METHODS, { error: 'Choose the payment method.' }),
  reference: optionalText(PAYMENT_REFERENCE_MAX),
  note: optionalText(PAYMENT_NOTE_MAX),
  currencyMinorDigits: CurrencyDigitsSchema
})
export type PaymentCreateInput = z.output<typeof PaymentCreateSchema>

/** `window.api.payments.checkDuplicate(...)`: posted payments with the same customer, date and amount. */
export const PaymentDuplicateCheckSchema = z.strictObject({
  customerId: IdSchema,
  paymentDate: DateSchema,
  amountMinor: PositiveAmountSchema
})
export type PaymentDuplicateCheckInput = z.output<typeof PaymentDuplicateCheckSchema>

/** `window.api.payments.void(...)`. */
export const PaymentVoidInputSchema = z.strictObject({
  id: IdSchema,
  reason: requiredText('reason for voiding', PAYMENT_NOTE_MAX)
})
export type PaymentVoidInput = z.output<typeof PaymentVoidInputSchema>

const OptionalDateSchema = z.string().refine(isCalendarDate, 'Enter a valid date.').nullable()

/** `window.api.payments.list(...)`: newest first. */
export const PaymentListInputSchema = z
  .strictObject({
    page: wholeNumber(1, 1_000_000),
    pageSize: wholeNumber(1, MAX_PAYMENT_PAGE_SIZE),
    /** Words matched against the payment number, reference and the customer's code, name and shop name. */
    search: z.string().trim().max(100, 'Use at most 100 characters.'),
    status: z.enum(['all', 'POSTED', 'VOID']),
    method: z.enum(['all', ...PAYMENT_METHODS]),
    /** Inclusive payment date range; null leaves that side open. */
    dateFrom: OptionalDateSchema,
    dateTo: OptionalDateSchema
  })
  .refine(
    (input) => input.dateFrom === null || input.dateTo === null || input.dateFrom <= input.dateTo,
    {
      path: ['dateTo'],
      message: 'The end date cannot be before the start date.'
    }
  )
export type PaymentListInput = z.output<typeof PaymentListInputSchema>

export const PaymentIdSchema = IdSchema

export interface PaymentSummary {
  readonly id: number
  readonly paymentNo: string
  readonly paymentDate: string
  readonly customerId: number
  /** The customer's current code, name and shop name (payments keep no copy of the profile). */
  readonly customerCode: string
  readonly customerName: string
  readonly shopName: string | null
  readonly amountMinor: number
  readonly method: PaymentMethod
  readonly reference: string | null
  readonly status: PaymentStatus
  readonly createdAt: string
}

/** A payment as saved. There is no edit: a mistake is voided. */
export interface PaymentDetail extends PaymentSummary {
  readonly customerActive: boolean
  readonly note: string | null
  readonly voidReason: string | null
  readonly voidDate: string | null
  readonly voidedAt: string | null
}

export interface PaymentSaveResult extends PaymentDetail {
  /** The customer's balance now, after the payment. */
  readonly balanceAfterMinor: number
  /** True when the request id had already been saved: this is that payment, and nothing new was posted. */
  readonly replayed: boolean
}

export interface PaymentVoidResult extends PaymentDetail {
  /** The customer's balance now, after the void. */
  readonly balanceAfterMinor: number
}

export interface DuplicatePaymentCheck {
  readonly duplicates: readonly PaymentSummary[]
}
