import { z } from 'zod'
import { MAX_MINOR_DIGITS } from '@shared/domain/guards'
import type { Db } from '../db/adapter'
import { AppFailure, fieldErrorsOf } from '../errors'
import type { Logger } from '../logging'

/*
 * The typed settings backend over the `settings` table, where each value is stored as JSON. Only the keys defined
 * here can be read or written through it: there is no generic key/value access. There is no negative-stock
 * setting (plan §8.3). The business effect of a change, such as applying invoice.startNumber to the invoice
 * sequence, belongs to the phase that uses the setting. No IPC yet: Phase 4B adds the Settings screen.
 */

export const SETTING_SCHEMAS = {
  'business.name': z.string().trim().min(1).max(100),
  'currency.code': z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, such as PKR.'),
  'currency.symbol': z.string().trim().min(1).max(8),
  'currency.minorDigits': z.number().int().min(0).max(MAX_MINOR_DIGITS),
  'invoice.prefix': z
    .string()
    .regex(/^[A-Za-z0-9._-]{0,12}$/, 'Use up to 12 letters, digits, dots, dashes or underscores.'),
  'invoice.padding': z.number().int().min(1).max(10),
  'invoice.startNumber': z.number().int().min(1).max(999_999_999),
  'invoice.paperSize': z.enum(['A4', 'A5']),
  'backup.autoEnabled': z.boolean(),
  'backup.keepDaily': z.number().int().min(1).max(365),
  'backup.keepMonthly': z.number().int().min(0).max(120)
} as const

export type SettingKey = keyof typeof SETTING_SCHEMAS
export type Settings = { readonly [K in SettingKey]: z.output<(typeof SETTING_SCHEMAS)[K]> }

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

/** An update: any subset of the known settings. An unknown key is refused (the future IPC input schema). */
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
 * Validates `patch` and writes it in one transaction: every setting in it is saved, or none is. Invalid input
 * (including an unknown key) is refused with a VALIDATION failure and changes nothing. Returns every setting.
 */
export function updateSettings(db: Db, patch: unknown): Settings {
  const parsed = SettingsPatchSchema.safeParse(patch)
  if (!parsed.success) {
    throw new AppFailure({
      code: 'VALIDATION',
      message: 'The settings are not valid.',
      fieldErrors: fieldErrorsOf(parsed.error)
    })
  }
  const changes = Object.entries(parsed.data).filter(([, value]) => value !== undefined)
  db.transaction(() => {
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

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
