import { z } from 'zod'
import { MAX_MINOR_DIGITS } from './domain/guards'
import { DateSchema, IdSchema, optionalText, requiredText, wholeNumber } from './validation'

/*
 * Customers and their running account (plan §7.3, §10). A customer's balance is never stored: it is
 * Σ customer_ledger.amount_minor, where a positive balance means the customer owes the shop (Due), zero is Settled and a
 * negative balance is an advance the shop holds for the customer. Ledger entries are append-only: an opening balance
 * is entered once, when the customer is created; later corrections are ADJUSTMENT entries and payment mistakes are
 * voided.
 *
 * The same schemas validate the forms (renderer) and every IPC request (main process). The operator never types a
 * sign: the form asks whether the customer owes the shop or has an advance, and the main process signs the amount.
 */

export const CUSTOMER_CODE_PREFIX = 'C-'
export const CUSTOMER_CODE_DIGITS = 5
export const CUSTOMER_NAME_MAX = 120
export const SHOP_NAME_MAX = 120
export const PHONE_MAX = 40
export const ADDRESS_MAX = 200
export const CITY_MAX = 60
export const CUSTOMER_NOTES_MAX = 500
export const LEDGER_REASON_MAX = 300
export const MAX_CUSTOMER_PAGE_SIZE = 100
export const MAX_CUSTOMER_SEARCH_LIMIT = 50

export const LEDGER_ENTRY_TYPES = [
  'OPENING',
  'INVOICE',
  'INVOICE_VOID',
  'PAYMENT',
  'PAYMENT_VOID',
  'ADJUSTMENT'
] as const
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number]

/** DUE: the customer owes the shop. ADVANCE: the shop holds money for the customer. */
export type BalanceSide = 'DUE' | 'ADVANCE'
export type BalanceState = 'DUE' | 'SETTLED' | 'ADVANCE'

/** What a balance means: positive Due, zero Settled, negative Advance. */
export function balanceState(balanceMinor: number): BalanceState {
  if (balanceMinor > 0) return 'DUE'
  return balanceMinor < 0 ? 'ADVANCE' : 'SETTLED'
}

/**
 * The seeded "Cash / Walk-in" customer for counter sales. Codes never change, so the code identifies it. It is always
 * active and keeps its name; it is the only walk-in customer.
 */
export const WALK_IN_CUSTOMER_CODE = 'C-00001'

export function isWalkInCustomer(code: string): boolean {
  return code === WALK_IN_CUSTOMER_CODE
}

/** 2 → 'C-00002'. */
export function formatCustomerCode(value: number): string {
  return `${CUSTOMER_CODE_PREFIX}${String(value).padStart(CUSTOMER_CODE_DIGITS, '0')}`
}

/** An amount of money the operator entered, in minor units: above zero. */
export const PositiveAmountSchema = z
  .number({ error: 'Enter the amount.' })
  .int('Enter a valid amount.')
  .min(1, 'Enter an amount greater than zero.')
  .max(Number.MAX_SAFE_INTEGER, 'The amount is too large.')

/** The currency decimal places the amounts were entered with; must match the current setting. */
export const CurrencyDigitsSchema = z.number().int().min(0).max(MAX_MINOR_DIGITS)

const PageSchema = wholeNumber(1, 1_000_000)

const profileFields = {
  name: requiredText('customer name', CUSTOMER_NAME_MAX),
  shopName: optionalText(SHOP_NAME_MAX),
  phone: optionalText(PHONE_MAX),
  address: optionalText(ADDRESS_MAX),
  city: optionalText(CITY_MAX),
  notes: optionalText(CUSTOMER_NOTES_MAX)
}

/** The balance a customer starts with. An amount of 0 means none: no ledger entry is written. */
export const OpeningBalanceSchema = z.strictObject({
  side: z.enum(['DUE', 'ADVANCE'], { error: 'Choose who owes whom.' }),
  amountMinor: z
    .number({ error: 'Enter the amount.' })
    .int('Enter a valid amount.')
    .min(0, 'The amount cannot be negative.')
    .max(Number.MAX_SAFE_INTEGER, 'The amount is too large.'),
  date: DateSchema
})
export type OpeningBalanceInput = z.output<typeof OpeningBalanceSchema>

/** `window.api.customers.create(...)`: the profile and an optional opening balance, saved together. */
export const CustomerCreateSchema = z.strictObject({
  ...profileFields,
  opening: OpeningBalanceSchema.nullable(),
  currencyMinorDigits: CurrencyDigitsSchema
})
export type CustomerCreateInput = z.output<typeof CustomerCreateSchema>

/** `window.api.customers.update(...)`: the profile only. The code and the ledger never change. */
export const CustomerUpdateSchema = z.strictObject({ id: IdSchema, ...profileFields })
export type CustomerUpdateInput = z.output<typeof CustomerUpdateSchema>

export type CustomerStatusFilter = 'active' | 'inactive' | 'all'

/** `window.api.customers.list(...)`: one page of the Customers table, by name. */
export const CustomerListInputSchema = z.strictObject({
  page: PageSchema,
  pageSize: wholeNumber(1, MAX_CUSTOMER_PAGE_SIZE),
  /** Words matched against the code, name, shop name, phone and city (every word must match one of them). */
  search: z.string().trim().max(100, 'Use at most 100 characters.'),
  status: z.enum(['active', 'inactive', 'all'])
})
export type CustomerListInput = z.output<typeof CustomerListInputSchema>

/** `window.api.customers.search(...)`: quick lookup for choosing a customer. */
export const CustomerSearchInputSchema = z.strictObject({
  query: z.string().trim().max(100, 'Use at most 100 characters.'),
  limit: wholeNumber(1, MAX_CUSTOMER_SEARCH_LIMIT),
  includeInactive: z.boolean()
})
export type CustomerSearchInput = z.output<typeof CustomerSearchInputSchema>

/** `window.api.customers.ledger(...)`: one page of a customer's ledger, oldest first; page null is the last page. */
export const CustomerLedgerInputSchema = z.strictObject({
  customerId: IdSchema,
  page: PageSchema.nullable(),
  pageSize: wholeNumber(1, MAX_CUSTOMER_PAGE_SIZE)
})
export type CustomerLedgerInput = z.output<typeof CustomerLedgerInputSchema>

/**
 * `window.api.customers.adjustBalance(...)`: an account correction (an ADJUSTMENT entry). INCREASE: the customer owes
 * more. DECREASE: the customer owes less, or has more advance.
 */
export const BalanceAdjustmentInputSchema = z.strictObject({
  customerId: IdSchema,
  entryDate: DateSchema,
  direction: z.enum(['INCREASE', 'DECREASE'], { error: 'Choose increase or decrease.' }),
  amountMinor: PositiveAmountSchema,
  reason: requiredText('reason', LEDGER_REASON_MAX),
  currencyMinorDigits: CurrencyDigitsSchema
})
export type BalanceAdjustmentInput = z.output<typeof BalanceAdjustmentInputSchema>

export const CustomerIdSchema = IdSchema

export interface ListPage<T> {
  readonly items: readonly T[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

/** A row of the Customers table, and a quick-search result. */
export interface CustomerListItem {
  readonly id: number
  readonly code: string
  readonly name: string
  readonly shopName: string | null
  readonly phone: string | null
  readonly city: string | null
  readonly isActive: boolean
  /** Σ ledger: positive Due, negative Advance. */
  readonly balanceMinor: number
}

export interface Customer extends CustomerListItem {
  readonly address: string | null
  readonly notes: string | null
  /** The latest ledger entry date: the customer's posting-date floor. Null without ledger entries. */
  readonly latestEntryDate: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface LedgerRow {
  readonly id: number
  readonly entryDate: string
  readonly type: LedgerEntryType
  /** Signed: positive increases what the customer owes, negative decreases it. */
  readonly amountMinor: number
  /** Σ of this entry and every earlier one, in (entry date, id) order. */
  readonly runningBalanceMinor: number
  readonly paymentId: number | null
  readonly paymentNo: string | null
  readonly paymentMethod: string | null
  readonly paymentReference: string | null
  /** The payment's current status (a PAYMENT row whose payment was voided later shows VOID). */
  readonly paymentStatus: 'POSTED' | 'VOID' | null
  readonly invoiceId: number | null
  readonly invoiceNo: string | null
  /** The adjustment reason, or the void reason of a PAYMENT_VOID. */
  readonly note: string | null
  readonly createdAt: string
}

export interface CustomerLedger {
  readonly customer: Customer
  readonly rows: readonly LedgerRow[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

export interface BalanceAdjustmentResult {
  readonly entry: LedgerRow
  /** The customer after the adjustment, with the new balance. */
  readonly customer: Customer
}
