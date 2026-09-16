import { z } from 'zod'
import {
  EDITABLE_SETTING_KEYS,
  EditableSettingsPatchSchema,
  MINOR_DIGITS_LOCKED_MESSAGE,
  SETTING_SCHEMAS,
  type EditableSettings,
  type SettingKey,
  type Settings,
  type SettingsView
} from '@shared/settings'
import type { Db } from '../db/adapter'
import { AppFailure, fieldErrorsOf } from '../errors'
import type { Logger } from '../logging'

/*
 * The typed settings backend over the `settings` table, where each value is stored as JSON. Only the keys defined in
 * @shared/settings can be read or written through it: there is no generic key/value access. There is no
 * negative-stock setting (plan §8.3). The Settings screen reads and edits the business, currency and invoice settings
 * through `window.api.settings` (readSettingsView, updateSettingsView); the backup keys are not exposed: automatic
 * backups keep the fixed V1 policy. currency.minorDigits is locked once financial data exists (hasMonetaryData). The
 * business effect of a change, such as applying invoice.startNumber to the invoice sequence, belongs to the phase that
 * uses the setting.
 */

export { SETTING_SCHEMAS, type SettingKey, type Settings } from '@shared/settings'

export const SETTING_KEYS: readonly SettingKey[] = Object.freeze(
  Object.keys(SETTING_SCHEMAS) as SettingKey[]
)

/** The values seeded by 0001_initial, used for a stored value that is missing or invalid. */
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  'business.name': 'StockFlow',
  'currency.code': 'PKR',
  'currency.symbol': 'Rs',
  'currency.minorDigits': 2,
  'invoice.prefix': 'INV-',
  'invoice.padding': 6,
  'invoice.startNumber': 1,
  'invoice.paperSize': 'A4',
  'backup.autoEnabled': true,
  'backup.keepDaily': 14,
  'backup.keepMonthly': 12
})

/** An update: any subset of the known settings. An unknown key is refused. */
export const SettingsPatchSchema = z.strictObject(SETTING_SCHEMAS).partial()

/**
 * Every known setting. A stored value that is missing or fails its schema is replaced by its default, and only
 * its key is logged. Rows of unknown keys are ignored.
 */
export function readSettings(db: Db, log?: Pick<Logger, 'warn'>): Settings {
  const stored = new Map(
    db
      .all<{ key: string; value: string }>('SELECT key, value FROM settings')
      .map((row) => [row.key, row.value])
  )
  const settings: Record<string, unknown> = {}
  for (const key of SETTING_KEYS) {
    const parsed = SETTING_SCHEMAS[key].safeParse(parseJson(stored.get(key)))
    if (parsed.success) {
      settings[key] = parsed.data
    } else {
      settings[key] = DEFAULT_SETTINGS[key]
      log?.warn('[settings] a stored setting is missing or invalid; its default is used', { key })
    }
  }
  return settings as Settings
}

/**
 * True once any amount is stored: a unit price or default cost, a stock receipt, adjustment or movement, an invoice
 * with its lines and quantities, a payment, an expense or a customer ledger entry. Amounts are whole minor units, so
 * `currency.minorDigits` must not change after that. The seeded settings, counters, walk-in customer and expense
 * categories hold no amounts, and neither do companies, products, units without prices, or customers.
 */
export function hasMonetaryData(db: Db): boolean {
  const row = db.get<{ found: number }>(
    `SELECT EXISTS (
       SELECT 1 FROM product_units
       WHERE wholesale_price_minor IS NOT NULL OR retail_price_minor IS NOT NULL OR default_cost_minor IS NOT NULL
     )
     OR EXISTS (SELECT 1 FROM stock_receipts)
     OR EXISTS (SELECT 1 FROM stock_receipt_items)
     OR EXISTS (SELECT 1 FROM stock_adjustments)
     OR EXISTS (SELECT 1 FROM stock_movements)
     OR EXISTS (SELECT 1 FROM invoices)
     OR EXISTS (SELECT 1 FROM invoice_items)
     OR EXISTS (SELECT 1 FROM invoice_item_quantities)
     OR EXISTS (SELECT 1 FROM payments)
     OR EXISTS (SELECT 1 FROM expenses)
     OR EXISTS (SELECT 1 FROM customer_ledger) AS found`
  )
  return row?.found === 1
}

/**
 * Validates `patch` and writes it in one transaction: every setting in it is saved, or none is. Invalid input
 * (including an unknown key) is refused with a VALIDATION failure and changes nothing. A different
 * `currency.minorDigits` once financial data exists (hasMonetaryData) is refused with SETTING_LOCKED and changes
 * nothing either. Returns every setting.
 */
export function updateSettings(db: Db, patch: unknown): Settings {
  const parsed = SettingsPatchSchema.safeParse(patch)
  if (!parsed.success) throw invalidSettings(parsed.error)
  const changes = Object.entries(parsed.data).filter(([, value]) => value !== undefined)
  const minorDigits = parsed.data['currency.minorDigits']
  db.transaction(() => {
    if (
      minorDigits !== undefined &&
      minorDigits !== readSettings(db)['currency.minorDigits'] &&
      hasMonetaryData(db)
    ) {
      throw new AppFailure({
        code: 'SETTING_LOCKED',
        message: MINOR_DIGITS_LOCKED_MESSAGE,
        fieldErrors: { 'currency.minorDigits': [MINOR_DIGITS_LOCKED_MESSAGE] }
      })
    }
    for (const [key, value] of changes) {
      db.run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE
         SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        [key, JSON.stringify(value)]
      )
    }
  })
  return readSettings(db)
}

/** The settings the Settings screen shows: business, currency and invoice (EDITABLE_SETTING_KEYS). */
export function readEditableSettings(db: Db, log?: Pick<Logger, 'warn'>): EditableSettings {
  return editableOf(readSettings(db, log))
}

/**
 * Saves a change made on the Settings screen. Only the editable settings are accepted: a backup setting or any other
 * key is refused with VALIDATION and nothing changes. Then updateSettings validates and writes it in one transaction.
 */
export function updateEditableSettings(db: Db, patch: unknown): EditableSettings {
  const parsed = EditableSettingsPatchSchema.safeParse(patch)
  if (!parsed.success) throw invalidSettings(parsed.error)
  return editableOf(updateSettings(db, parsed.data))
}

/** `settings.get()`: the editable settings, and whether the currency decimal places are locked. */
export function readSettingsView(db: Db, log?: Pick<Logger, 'warn'>): SettingsView {
  return { values: readEditableSettings(db, log), minorDigitsLocked: hasMonetaryData(db) }
}

/** `settings.update(...)`: updateEditableSettings, then the settings with the lock as they are now. */
export function updateSettingsView(db: Db, patch: unknown): SettingsView {
  return { values: updateEditableSettings(db, patch), minorDigitsLocked: hasMonetaryData(db) }
}

function invalidSettings(error: z.ZodError): AppFailure {
  return new AppFailure({
    code: 'VALIDATION',
    message: 'The settings are not valid.',
    fieldErrors: fieldErrorsOf(error)
  })
}

function editableOf(settings: Settings): EditableSettings {
  return Object.fromEntries(
    EDITABLE_SETTING_KEYS.map((key) => [key, settings[key]])
  ) as unknown as EditableSettings
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
