import { z } from 'zod'
import { MAX_MINOR_DIGITS } from './domain/guards'
import { blankableText, requiredText, wholeNumber } from './validation'

/*
 * The rules for every setting (the `settings` table stores each value as JSON). Shared: the main process validates
 * every read and write with them, and the Settings screen uses the same rules for its form. There is no
 * negative-stock setting (plan §8.3).
 *
 * The shop (name and address) and the one salesman (name and two phones) are printed on invoices. An invoice copies
 * them when it is posted (invoices.shop_name_snapshot and the other snapshot columns), so changing them here changes
 * only the invoices posted afterwards. There is no salesman table: V1 has one salesman.
 */

export const BUSINESS_NAME_MAX = 100
export const BUSINESS_ADDRESS_MAX = 200
export const SALESMAN_NAME_MAX = 60
export const SALESMAN_PHONE_MAX = 40

const CURRENCY_CODE_MESSAGE = 'Use a three-letter currency code, such as PKR.'

/** The paper an invoice is printed on. */
export const PAPER_SIZES = ['A4', 'A5'] as const
export type PaperSize = (typeof PAPER_SIZES)[number]
const INVOICE_PREFIX_MESSAGE = 'Use up to 12 letters, digits, dots, dashes or underscores.'

export const SETTING_SCHEMAS = {
  'business.name': z
    .string({ error: 'Enter the shop name.' })
    .trim()
    .min(1, 'Enter the shop name.')
    .max(BUSINESS_NAME_MAX, `Use at most ${BUSINESS_NAME_MAX} characters.`),
  /** Printed under the shop name; may be empty. */
  'business.address': blankableText(BUSINESS_ADDRESS_MAX),
  'salesman.name': requiredText('salesman name', SALESMAN_NAME_MAX),
  /** Either phone may be empty. */
  'salesman.phone1': blankableText(SALESMAN_PHONE_MAX),
  'salesman.phone2': blankableText(SALESMAN_PHONE_MAX),
  'currency.code': z
    .string({ error: CURRENCY_CODE_MESSAGE })
    .regex(/^[A-Z]{3}$/, CURRENCY_CODE_MESSAGE),
  'currency.symbol': z
    .string({ error: 'Enter the currency symbol.' })
    .trim()
    .min(1, 'Enter the currency symbol.')
    .max(8, 'Use at most 8 characters.'),
  'currency.minorDigits': wholeNumber(0, MAX_MINOR_DIGITS),
  'invoice.prefix': z
    .string({ error: INVOICE_PREFIX_MESSAGE })
    .regex(/^[A-Za-z0-9._-]{0,12}$/, INVOICE_PREFIX_MESSAGE),
  'invoice.padding': wholeNumber(1, 10),
  'invoice.startNumber': wholeNumber(1, 999_999_999),
  'invoice.paperSize': z.enum(PAPER_SIZES, { error: 'Choose A4 or A5.' }),
  'backup.autoEnabled': z.boolean(),
  'backup.keepDaily': z.number().int().min(1).max(365),
  'backup.keepMonthly': z.number().int().min(0).max(120)
} as const

export type SettingKey = keyof typeof SETTING_SCHEMAS
export type Settings = { readonly [K in SettingKey]: z.output<(typeof SETTING_SCHEMAS)[K]> }

/**
 * The settings the Settings screen shows and edits: shop, salesman, currency and invoice. The backup keys are not among
 * them: automatic backups follow the approved fixed policy (on, 14 daily and 12 monthly).
 */
export const EDITABLE_SETTING_KEYS = Object.freeze([
  'business.name',
  'business.address',
  'salesman.name',
  'salesman.phone1',
  'salesman.phone2',
  'currency.code',
  'currency.symbol',
  'currency.minorDigits',
  'invoice.prefix',
  'invoice.padding',
  'invoice.startNumber',
  'invoice.paperSize'
] as const)

export type EditableSettingKey = (typeof EDITABLE_SETTING_KEYS)[number]
export type EditableSettings = Pick<Settings, EditableSettingKey>
export type EditableSettingsPatch = Partial<EditableSettings>

/**
 * The currency identity: code, symbol and decimal places. Amounts are stored as whole minor units and old invoices are
 * printed with the current currency, so none of them may change once financial data exists.
 */
export const CURRENCY_SETTING_KEYS = Object.freeze([
  'currency.code',
  'currency.symbol',
  'currency.minorDigits'
] as const)

/** Why a currency setting is refused once financial data exists. */
export const CURRENCY_LOCKED_MESSAGE =
  'Currency settings cannot be changed after financial data has been entered.'

/** Why `invoice.startNumber` is refused once invoice numbering has begun. */
export const START_NUMBER_LOCKED_MESSAGE =
  'Starting number cannot be changed after invoice numbering has begun.'

/** What `window.api.settings.get()` and `.update(...)` return. */
export interface SettingsView {
  readonly values: EditableSettings
  /**
   * True once any amount is stored (prices, costs, stock documents, invoices, payments, expenses or ledger entries).
   * Amounts are stored as whole minor units and old invoices print with the current currency, so a different currency
   * code, symbol or decimal places would change their meaning: the main process then refuses them (SETTING_LOCKED), and
   * the Settings screen shows the three fields read-only.
   */
  readonly currencyLocked: boolean
  /**
   * True once invoice numbering has begun (an invoice exists or the invoice number sequence has moved on):
   * `invoice.startNumber` then has no effect, so the main process refuses a different one and the field is read-only.
   */
  readonly startNumberLocked: boolean
}

/** The input of `window.api.settings.update(...)`: any subset of the editable settings. Any other key is refused. */
export const EditableSettingsPatchSchema = z
  .strictObject({
    'business.name': SETTING_SCHEMAS['business.name'],
    'business.address': SETTING_SCHEMAS['business.address'],
    'salesman.name': SETTING_SCHEMAS['salesman.name'],
    'salesman.phone1': SETTING_SCHEMAS['salesman.phone1'],
    'salesman.phone2': SETTING_SCHEMAS['salesman.phone2'],
    'currency.code': SETTING_SCHEMAS['currency.code'],
    'currency.symbol': SETTING_SCHEMAS['currency.symbol'],
    'currency.minorDigits': SETTING_SCHEMAS['currency.minorDigits'],
    'invoice.prefix': SETTING_SCHEMAS['invoice.prefix'],
    'invoice.padding': SETTING_SCHEMAS['invoice.padding'],
    'invoice.startNumber': SETTING_SCHEMAS['invoice.startNumber'],
    'invoice.paperSize': SETTING_SCHEMAS['invoice.paperSize']
  })
  .partial()
