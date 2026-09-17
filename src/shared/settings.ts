import { z } from 'zod'
import { MAX_MINOR_DIGITS } from './domain/guards'
import { wholeNumber } from './validation'

/*
 * The rules for every setting (the `settings` table stores each value as JSON). Shared: the main process validates
 * every read and write with them, and the Settings screen uses the same rules for its form. There is no
 * negative-stock setting (plan §8.3).
 */

const CURRENCY_CODE_MESSAGE = 'Use a three-letter currency code, such as PKR.'

/** The paper an invoice is printed on. */
export const PAPER_SIZES = ['A4', 'A5'] as const
export type PaperSize = (typeof PAPER_SIZES)[number]
const INVOICE_PREFIX_MESSAGE = 'Use up to 12 letters, digits, dots, dashes or underscores.'

export const SETTING_SCHEMAS = {
  'business.name': z
    .string({ error: 'Enter the business name.' })
    .trim()
    .min(1, 'Enter the business name.')
    .max(100, 'Use at most 100 characters.'),
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
 * The settings the Settings screen shows and edits: business, currency and invoice. The backup keys are not among
 * them: automatic backups follow the approved fixed policy (on, 14 daily and 12 monthly).
 */
export const EDITABLE_SETTING_KEYS = Object.freeze([
  'business.name',
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

/** Why `currency.minorDigits` is refused once financial data exists. */
export const MINOR_DIGITS_LOCKED_MESSAGE =
  'Currency decimal places cannot be changed after financial data has been entered.'

/** What `window.api.settings.get()` and `.update(...)` return. */
export interface SettingsView {
  readonly values: EditableSettings
  /**
   * True once any amount is stored (prices, costs, stock documents, invoices, payments, expenses or ledger entries).
   * Amounts are stored as whole minor units, so changing `currency.minorDigits` would change their meaning: the main
   * process then refuses it (SETTING_LOCKED), and the Settings screen shows the field read-only.
   */
  readonly minorDigitsLocked: boolean
}

/** The input of `window.api.settings.update(...)`: any subset of the editable settings. Any other key is refused. */
export const EditableSettingsPatchSchema = z
  .strictObject({
    'business.name': SETTING_SCHEMAS['business.name'],
    'currency.code': SETTING_SCHEMAS['currency.code'],
    'currency.symbol': SETTING_SCHEMAS['currency.symbol'],
    'currency.minorDigits': SETTING_SCHEMAS['currency.minorDigits'],
    'invoice.prefix': SETTING_SCHEMAS['invoice.prefix'],
    'invoice.padding': SETTING_SCHEMAS['invoice.padding'],
    'invoice.startNumber': SETTING_SCHEMAS['invoice.startNumber'],
    'invoice.paperSize': SETTING_SCHEMAS['invoice.paperSize']
  })
  .partial()
