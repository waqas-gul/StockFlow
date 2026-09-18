import { z } from 'zod'
import { CurrencyDigitsSchema, OpeningBalanceSchema, PositiveAmountSchema } from './customers'
import { isCalendarDate } from './dates'
import { PAYMENT_METHODS, type PaymentMethod, type PaymentStatus } from './payments'
import {
  DateSchema,
  IdSchema,
  RequestIdSchema,
  optionalText,
  requiredText,
  wholeNumber
} from './validation'

/*
 * Suppliers and supplier payables (migration 0003). A supplier is someone the shop buys stock from; it is not a product
 * brand/company (`companies`). What the shop owes a supplier is never stored: it is Σ supplier_ledger.amount_minor,
 * where a positive balance is Due (the shop owes the supplier), zero Settled and a negative balance a supplier Advance
 * (the shop has paid more than it owes).
 *
 * Ledger signs: OPENING and ADJUSTMENT ±, PURCHASE + (a supplier-linked Stock In receipt's total), PURCHASE_VOID −,
 * PAYMENT − and PAYMENT_VOID +. Entries are append-only; a mistake is corrected by a void or an adjustment.
 *
 * Supplier payments settle what is owed. They are not expenses: the stock purchase already went into inventory, and
 * reaches profit only as the COGS of later sales. Neither a purchase nor a payment appears in the Profit & Loss.
 *
 * The same schemas validate the forms (renderer) and every IPC request (main process). The operator never types a
 * sign: the forms ask which way the amount goes, and the main process signs it.
 */

export const SUPPLIER_CODE_PREFIX = 'SUP-'
export const SUPPLIER_CODE_DIGITS = 5
export const SUPPLIER_PAYMENT_NUMBER_PREFIX = 'SPAY-'
export const SUPPLIER_NAME_MAX = 120
export const CONTACT_PERSON_MAX = 80
export const SUPPLIER_PHONE_MAX = 40
export const SUPPLIER_ADDRESS_MAX = 200
export const SUPPLIER_CITY_MAX = 60
export const SUPPLIER_NOTES_MAX = 500
export const SUPPLIER_REASON_MAX = 300
export const SUPPLIER_PAYMENT_REFERENCE_MAX = 60
export const SUPPLIER_PAYMENT_NOTE_MAX = 300
export const MAX_SUPPLIER_PAGE_SIZE = 100
export const MAX_SUPPLIER_SEARCH_LIMIT = 50

export const SUPPLIER_LEDGER_TYPES = [
  'OPENING',
  'PURCHASE',
  'PURCHASE_VOID',
  'PAYMENT',
  'PAYMENT_VOID',
  'ADJUSTMENT'
] as const
export type SupplierLedgerType = (typeof SUPPLIER_LEDGER_TYPES)[number]

/** The soft warning before saving a supplier payment that looks like one already posted. */
export const DUPLICATE_SUPPLIER_PAYMENT_WARNING =
  'A payment with the same supplier, date and amount already exists.'

/** Shown before voiding a supplier-linked receipt that has posted supplier payments. */
export const RECEIPT_PAYMENTS_VOID_WARNING =
  'This receipt has supplier payments. Voiding the receipt will keep those payments on the supplier account as advance. Void the payment separately if the money was returned.'

/** Shown on a stock correction of a supplier-linked receipt: inventory corrections never change the supplier account. */
export const SUPPLIER_CORRECTION_NOTE =
  'This correction changes inventory only. If the supplier bill or amount due also changed, adjust the supplier account separately.'

/** Shown before deactivating a supplier whose balance is not zero. */
export const SUPPLIER_BALANCE_DEACTIVATE_WARNING =
  'This supplier still has an outstanding balance. The account and history will remain available.'

/** 1 → 'SUP-00001'. */
export function formatSupplierCode(value: number): string {
  return `${SUPPLIER_CODE_PREFIX}${String(value).padStart(SUPPLIER_CODE_DIGITS, '0')}`
}

const PageSchema = wholeNumber(1, 1_000_000)

const profileFields = {
  name: requiredText('supplier name', SUPPLIER_NAME_MAX),
  contactPerson: optionalText(CONTACT_PERSON_MAX),
  phone: optionalText(SUPPLIER_PHONE_MAX),
  address: optionalText(SUPPLIER_ADDRESS_MAX),
  city: optionalText(SUPPLIER_CITY_MAX),
  notes: optionalText(SUPPLIER_NOTES_MAX)
}

/**
 * `window.api.suppliers.create(...)`: the profile and an optional opening balance, saved together. The opening side DUE
 * means the shop owes the supplier; ADVANCE means the supplier holds an advance of the shop's money. An amount of 0 is
 * no opening balance (no ledger entry).
 */
export const SupplierCreateSchema = z.strictObject({
  ...profileFields,
  opening: OpeningBalanceSchema.nullable(),
  currencyMinorDigits: CurrencyDigitsSchema
})
export type SupplierCreateInput = z.output<typeof SupplierCreateSchema>

/** `window.api.suppliers.update(...)`: the profile only. The code and the ledger never change. */
export const SupplierUpdateSchema = z.strictObject({ id: IdSchema, ...profileFields })
export type SupplierUpdateInput = z.output<typeof SupplierUpdateSchema>

export type SupplierStatusFilter = 'active' | 'inactive' | 'all'

/** `window.api.suppliers.list(...)`: one page of the Suppliers table, by name. */
export const SupplierListInputSchema = z.strictObject({
  page: PageSchema,
  pageSize: wholeNumber(1, MAX_SUPPLIER_PAGE_SIZE),
  /** Words matched against the code, name, contact person, phone and city (every word must match one of them). */
  search: z.string().trim().max(100, 'Use at most 100 characters.'),
  status: z.enum(['active', 'inactive', 'all'])
})
export type SupplierListInput = z.output<typeof SupplierListInputSchema>

/** `window.api.suppliers.search(...)`: quick lookup for choosing a supplier. */
export const SupplierSearchInputSchema = z.strictObject({
  query: z.string().trim().max(100, 'Use at most 100 characters.'),
  limit: wholeNumber(1, MAX_SUPPLIER_SEARCH_LIMIT),
  includeInactive: z.boolean()
})
export type SupplierSearchInput = z.output<typeof SupplierSearchInputSchema>

/** `window.api.suppliers.ledger(...)`: one page of a supplier's ledger, oldest first; page null is the last page. */
export const SupplierLedgerInputSchema = z.strictObject({
  supplierId: IdSchema,
  page: PageSchema.nullable(),
  pageSize: wholeNumber(1, MAX_SUPPLIER_PAGE_SIZE)
})
export type SupplierLedgerInput = z.output<typeof SupplierLedgerInputSchema>

/**
 * `window.api.suppliers.adjustBalance(...)`: an account correction (an ADJUSTMENT entry). INCREASE: the shop owes the
 * supplier more. DECREASE: the shop owes less, or the supplier advance grows.
 */
export const SupplierBalanceAdjustmentInputSchema = z.strictObject({
  supplierId: IdSchema,
  entryDate: DateSchema,
  direction: z.enum(['INCREASE', 'DECREASE'], { error: 'Choose increase or decrease.' }),
  amountMinor: PositiveAmountSchema,
  reason: requiredText('reason', SUPPLIER_REASON_MAX),
  currencyMinorDigits: CurrencyDigitsSchema
})
export type SupplierBalanceAdjustmentInput = z.output<typeof SupplierBalanceAdjustmentInputSchema>

export const SupplierIdSchema = IdSchema

/** `window.api.supplierPayments.create(...)`: Pay Supplier (a repeated request id returns the saved payment). */
export const SupplierPaymentCreateSchema = z.strictObject({
  requestId: RequestIdSchema,
  supplierId: IdSchema,
  paymentDate: DateSchema,
  amountMinor: PositiveAmountSchema,
  method: z.enum(PAYMENT_METHODS, { error: 'Choose the payment method.' }),
  reference: optionalText(SUPPLIER_PAYMENT_REFERENCE_MAX),
  note: optionalText(SUPPLIER_PAYMENT_NOTE_MAX),
  currencyMinorDigits: CurrencyDigitsSchema
})
export type SupplierPaymentCreateInput = z.output<typeof SupplierPaymentCreateSchema>

/** `window.api.supplierPayments.checkDuplicate(...)`: posted payments with the same supplier, date and amount. */
export const SupplierPaymentDuplicateCheckSchema = z.strictObject({
  supplierId: IdSchema,
  paymentDate: DateSchema,
  amountMinor: PositiveAmountSchema
})
export type SupplierPaymentDuplicateCheckInput = z.output<
  typeof SupplierPaymentDuplicateCheckSchema
>

/** `window.api.supplierPayments.void(...)`. */
export const SupplierPaymentVoidInputSchema = z.strictObject({
  id: IdSchema,
  reason: requiredText('reason for voiding', SUPPLIER_PAYMENT_NOTE_MAX)
})
export type SupplierPaymentVoidInput = z.output<typeof SupplierPaymentVoidInputSchema>

const OptionalDateSchema = z.string().refine(isCalendarDate, 'Enter a valid date.').nullable()

/** `window.api.supplierPayments.list(...)`: newest first. */
export const SupplierPaymentListInputSchema = z
  .strictObject({
    page: PageSchema,
    pageSize: wholeNumber(1, MAX_SUPPLIER_PAGE_SIZE),
    /** Words matched against the payment number, reference and the supplier's code and name. */
    search: z.string().trim().max(100, 'Use at most 100 characters.'),
    status: z.enum(['all', 'POSTED', 'VOID']),
    method: z.enum(['all', ...PAYMENT_METHODS]),
    /** One supplier's payments; null for every supplier. */
    supplierId: IdSchema.nullable(),
    dateFrom: OptionalDateSchema,
    dateTo: OptionalDateSchema
  })
  .refine(
    (input) => input.dateFrom === null || input.dateTo === null || input.dateFrom <= input.dateTo,
    { path: ['dateTo'], message: 'The end date cannot be before the start date.' }
  )
export type SupplierPaymentListInput = z.output<typeof SupplierPaymentListInputSchema>

export const SupplierPaymentIdSchema = IdSchema

/** A row of the Suppliers table, and a quick-search result. */
export interface SupplierListItem {
  readonly id: number
  readonly code: string
  readonly name: string
  readonly contactPerson: string | null
  readonly phone: string | null
  readonly city: string | null
  readonly isActive: boolean
  /** Σ ledger: positive Due (the shop owes the supplier), negative Advance. */
  readonly balanceMinor: number
}

/** A product bought from the supplier: history from its posted receipts, never a source of stock figures. */
export interface SupplierProductRow {
  readonly productId: number
  readonly code: string
  readonly name: string
  readonly lastPurchaseDate: string
  /** The unit cost and unit of the latest posted receipt line of the product. */
  readonly lastUnitCostMinor: number
  readonly lastUnitName: string
  /** Σ base quantity over the supplier's posted receipts. */
  readonly totalQtyBase: number
  /** totalQtyBase in the product's units ("12 Box + 3 Piece"). */
  readonly totalQuantityText: string
}

export interface Supplier extends SupplierListItem {
  readonly address: string | null
  readonly notes: string | null
  /** The latest ledger entry date: the supplier's posting-date floor. Null without ledger entries. */
  readonly latestEntryDate: string | null
  /** Σ total cost of the supplier's POSTED receipts (void receipts excluded). */
  readonly totalPurchasesMinor: number
  readonly purchaseCount: number
  /** Σ amount of the supplier's POSTED payments (void payments excluded). */
  readonly totalPaidMinor: number
  readonly paymentCount: number
  readonly lastPurchaseDate: string | null
  readonly lastPaymentDate: string | null
  /** By product code. */
  readonly productsPurchased: readonly SupplierProductRow[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SupplierLedgerRow {
  readonly id: number
  readonly entryDate: string
  readonly type: SupplierLedgerType
  /** Signed: positive increases what the shop owes, negative decreases it. */
  readonly amountMinor: number
  /** Σ of this entry and every earlier one, in (entry date, id) order. */
  readonly runningBalanceMinor: number
  readonly receiptId: number | null
  readonly receiptNo: string | null
  readonly supplierBillNo: string | null
  readonly paymentId: number | null
  readonly paymentNo: string | null
  readonly paymentMethod: PaymentMethod | null
  /** The payment's current status (a PAYMENT row whose payment was voided later shows VOID). */
  readonly paymentStatus: PaymentStatus | null
  /** The adjustment reason, or the void reason of a PAYMENT_VOID. */
  readonly note: string | null
  readonly createdAt: string
}

export interface SupplierLedger {
  readonly supplier: Supplier
  readonly rows: readonly SupplierLedgerRow[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

export interface SupplierBalanceAdjustmentResult {
  readonly entry: SupplierLedgerRow
  /** The supplier after the adjustment, with the new balance. */
  readonly supplier: Supplier
}

export interface SupplierPaymentSummary {
  readonly id: number
  readonly paymentNo: string
  readonly paymentDate: string
  readonly supplierId: number
  /** The supplier's current code and name. */
  readonly supplierCode: string
  readonly supplierName: string
  readonly amountMinor: number
  readonly method: PaymentMethod
  readonly reference: string | null
  readonly status: PaymentStatus
  /** The Stock In receipt the payment was made with ("paid now"), if any. */
  readonly receiptId: number | null
  readonly receiptNo: string | null
  readonly createdAt: string
}

/** A supplier payment as saved. There is no edit: a mistake is voided. */
export interface SupplierPaymentDetail extends SupplierPaymentSummary {
  readonly supplierActive: boolean
  readonly note: string | null
  readonly receiptStatus: 'POSTED' | 'VOID' | null
  readonly voidReason: string | null
  readonly voidDate: string | null
  readonly voidedAt: string | null
}

export interface SupplierPaymentSaveResult extends SupplierPaymentDetail {
  /** The supplier's balance now, after the payment. */
  readonly balanceAfterMinor: number
  /** True when the request id had already been saved: this is that payment, and nothing new was posted. */
  readonly replayed: boolean
}

export interface SupplierPaymentVoidResult extends SupplierPaymentDetail {
  /** The supplier's balance now, after the void. */
  readonly balanceAfterMinor: number
}

export interface DuplicateSupplierPaymentCheck {
  readonly duplicates: readonly SupplierPaymentSummary[]
}
