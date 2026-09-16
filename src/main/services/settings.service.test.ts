import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/adapter'
import {
  createMemoryLogger,
  createSchemaDatabase,
  createTempDir,
  insertRow,
  isBetween,
  thrown,
  type TempDir
} from '../db/test-utils'
import { AppFailure } from '../errors'
import {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  SettingsPatchSchema,
  readEditableSettings,
  readSettings,
  updateEditableSettings,
  updateSettings
} from './settings.service'

let temp: TempDir
let db: Db

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
})

afterEach(() => {
  temp.remove()
})

function stored(key: string): string | undefined {
  return db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value
}

function allRows(): unknown[] {
  return db.all('SELECT key, value, updated_at FROM settings ORDER BY key')
}

function validationFailure(fn: () => unknown): AppFailure {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return error as AppFailure
}

describe('readSettings', () => {
  it('reads every seeded value with its type', () => {
    expect(readSettings(db)).toEqual({
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
  })

  it('has defaults equal to the seeded values', () => {
    expect(readSettings(db)).toEqual(DEFAULT_SETTINGS)
  })

  it('knows exactly the seeded keys, and has no negative-stock setting', () => {
    const seeded = db
      .all<{ key: string }>('SELECT key FROM settings ORDER BY key')
      .map((row) => row.key)
    expect([...SETTING_KEYS].sort()).toEqual(seeded)
    expect(SETTING_KEYS.some((key) => /negative/i.test(key))).toBe(false)
  })

  it('ignores stored rows for keys it does not know', () => {
    insertRow(db, 'settings', { key: 'future.flag', value: 'true' })
    expect(Object.keys(readSettings(db))).toEqual([...SETTING_KEYS])
  })

  it('uses the default for a stored value that is missing or invalid, and logs only the key', () => {
    db.run(`UPDATE settings SET value = '"TOO LONG CODE"' WHERE key = 'currency.code'`)
    db.run(`UPDATE settings SET value = '"two"' WHERE key = 'currency.minorDigits'`)
    db.run("DELETE FROM settings WHERE key = 'invoice.padding'")
    db.exec('PRAGMA ignore_check_constraints = ON')
    db.run("UPDATE settings SET value = 'not json' WHERE key = 'currency.symbol'")
    db.exec('PRAGMA ignore_check_constraints = OFF')
    const log = createMemoryLogger()
    const settings = readSettings(db, log)
    expect(settings).toMatchObject({
      'currency.code': 'PKR',
      'currency.symbol': 'Rs',
      'currency.minorDigits': 2,
      'invoice.padding': 6
    })
    const warning = '[settings] a stored setting is missing or invalid; its default is used'
    expect(log.entries).toEqual(
      ['currency.code', 'currency.symbol', 'currency.minorDigits', 'invoice.padding'].map(
        (key) => ({
          level: 'WARN',
          message: warning,
          context: { key }
        })
      )
    )
  })
})

describe('updateSettings', () => {
  it('updates the given settings and returns every setting', () => {
    const result = updateSettings(db, {
      'business.name': '  Ali Traders  ',
      'invoice.padding': 5,
      'backup.autoEnabled': false
    })
    expect(result).toEqual({
      ...DEFAULT_SETTINGS,
      'business.name': 'Ali Traders',
      'invoice.padding': 5,
      'backup.autoEnabled': false
    })
    expect(stored('business.name')).toBe('"Ali Traders"')
    expect(stored('invoice.padding')).toBe('5')
    expect(stored('backup.autoEnabled')).toBe('false')
    expect(readSettings(db)).toEqual(result)
  })

  it('stamps updated_at on the changed rows only', () => {
    const before = db.all<{ key: string; updated_at: string }>(
      'SELECT key, updated_at FROM settings ORDER BY key'
    )
    const start = new Date().toISOString()
    updateSettings(db, { 'currency.symbol': 'PKR' })
    const end = new Date().toISOString()
    const after = db.all<{ key: string; updated_at: string }>(
      'SELECT key, updated_at FROM settings ORDER BY key'
    )
    for (const row of after) {
      const previous = before.find((item) => item.key === row.key)?.updated_at
      if (row.key === 'currency.symbol') expect(isBetween(row.updated_at, start, end)).toBe(true)
      else expect(row.updated_at).toBe(previous)
    }
  })

  it('accepts values at the edges of every rule', () => {
    const low = {
      'business.name': 'A',
      'currency.code': 'USD',
      'currency.symbol': '$',
      'currency.minorDigits': 0,
      'invoice.prefix': '',
      'invoice.padding': 1,
      'invoice.startNumber': 1,
      'invoice.paperSize': 'A5',
      'backup.autoEnabled': false,
      'backup.keepDaily': 1,
      'backup.keepMonthly': 0
    } as const
    expect(updateSettings(db, low)).toEqual(low)
    const high = {
      'business.name': 'B'.repeat(100),
      'currency.symbol': 'Rs.',
      'currency.minorDigits': 4,
      'invoice.prefix': 'SF-2026.A_b1',
      'invoice.padding': 10,
      'invoice.startNumber': 999_999_999,
      'backup.keepDaily': 365,
      'backup.keepMonthly': 120
    }
    expect(updateSettings(db, high)).toMatchObject(high)
  })

  it.each<[string, Record<string, unknown>]>([
    ['a blank business name', { 'business.name': '   ' }],
    ['a business name over 100 characters', { 'business.name': 'x'.repeat(101) }],
    ['a currency code that is not upper case', { 'currency.code': 'pkr' }],
    ['a currency code of four letters', { 'currency.code': 'PKRS' }],
    ['an empty currency symbol', { 'currency.symbol': ' ' }],
    ['a currency symbol over 8 characters', { 'currency.symbol': 'Rupees!!!' }],
    ['negative minor digits', { 'currency.minorDigits': -1 }],
    ['more than 4 minor digits', { 'currency.minorDigits': 5 }],
    ['fractional minor digits', { 'currency.minorDigits': 1.5 }],
    ['minor digits given as text', { 'currency.minorDigits': '2' }],
    ['an invoice prefix with a space or a slash', { 'invoice.prefix': 'INV /' }],
    ['an invoice prefix over 12 characters', { 'invoice.prefix': 'X'.repeat(13) }],
    ['padding 0', { 'invoice.padding': 0 }],
    ['padding over 10', { 'invoice.padding': 11 }],
    ['start number 0', { 'invoice.startNumber': 0 }],
    ['a start number over 999,999,999', { 'invoice.startNumber': 1_000_000_000 }],
    ['an unknown paper size', { 'invoice.paperSize': 'Letter' }],
    ['automatic backups given as text', { 'backup.autoEnabled': 'yes' }],
    ['keeping 0 daily backups', { 'backup.keepDaily': 0 }],
    ['keeping a negative number of monthly backups', { 'backup.keepMonthly': -1 }]
  ])('rejects %s and changes nothing', (_label, patch) => {
    const before = allRows()
    const failure = validationFailure(() => updateSettings(db, patch))
    expect(failure.error).toEqual({
      code: 'VALIDATION',
      message: 'The settings are not valid.',
      fieldErrors: { [Object.keys(patch)[0]]: [expect.any(String)] }
    })
    expect(allRows()).toEqual(before)
  })

  it('rejects unknown keys, a negative-stock setting among them, and changes nothing', () => {
    const before = allRows()
    for (const patch of [
      { 'stock.allowNegative': true },
      { 'business.name': 'Fine', 'x.unknown': 1 }
    ]) {
      expect(validationFailure(() => updateSettings(db, patch)).error.fieldErrors).toHaveProperty(
        'root'
      )
    }
    expect(allRows()).toEqual(before)
  })

  it('rejects anything that is not an object', () => {
    for (const patch of [null, undefined, 'business.name', 42, ['business.name']]) {
      expect(validationFailure(() => updateSettings(db, patch)).error.code).toBe('VALIDATION')
    }
  })

  it('rolls the whole update back when one write fails', () => {
    db.exec(`
      CREATE TRIGGER fixture_fail_padding BEFORE UPDATE ON settings WHEN NEW.key = 'invoice.padding'
      BEGIN
        SELECT RAISE(ABORT, 'simulated write failure');
      END
    `)
    expect(() => updateSettings(db, { 'business.name': 'Changed', 'invoice.padding': 5 })).toThrow(
      /simulated write failure/
    )
    expect(stored('business.name')).toBe('"StockFlow"')
    expect(stored('invoice.padding')).toBe('6')
    expect(db.inTransaction).toBe(false)
  })

  it('writes the row of a known setting that is missing', () => {
    db.run("DELETE FROM settings WHERE key = 'invoice.paperSize'")
    expect(updateSettings(db, { 'invoice.paperSize': 'A5' })['invoice.paperSize']).toBe('A5')
    expect(stored('invoice.paperSize')).toBe('"A5"')
  })

  it('changes nothing for an empty update', () => {
    const before = allRows()
    expect(updateSettings(db, {})).toEqual(DEFAULT_SETTINGS)
    expect(allRows()).toEqual(before)
  })
})

describe('SettingsPatchSchema', () => {
  it('is strict: it accepts known keys only', () => {
    expect(SettingsPatchSchema.safeParse({ 'business.name': 'Shop' }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({ 'business.name': 'Shop', extra: 1 }).success).toBe(false)
  })
})

describe('the Settings screen: readEditableSettings and updateEditableSettings', () => {
  const EDITABLE = {
    'business.name': 'StockFlow',
    'currency.code': 'PKR',
    'currency.symbol': 'Rs',
    'currency.minorDigits': 2,
    'invoice.prefix': 'INV-',
    'invoice.padding': 6,
    'invoice.startNumber': 1,
    'invoice.paperSize': 'A4'
  }

  it('reads the business, currency and invoice settings, and no backup setting', () => {
    expect(readEditableSettings(db)).toEqual(EDITABLE)
  })

  it('saves a change in one transaction and returns the editable settings', () => {
    expect(
      updateEditableSettings(db, { 'business.name': ' Ali Traders ', 'currency.minorDigits': 0 })
    ).toEqual({ ...EDITABLE, 'business.name': 'Ali Traders', 'currency.minorDigits': 0 })
    expect(stored('business.name')).toBe('"Ali Traders"')
    expect(stored('currency.minorDigits')).toBe('0')
  })

  it.each<[string, Record<string, unknown>]>([
    ['turning automatic backups off', { 'backup.autoEnabled': false }],
    ['changing the daily retention', { 'backup.keepDaily': 1 }],
    ['changing the monthly retention', { 'backup.keepMonthly': 0 }],
    ['an unknown key next to a valid one', { 'business.name': 'Shop', 'x.unknown': 1 }]
  ])('refuses %s and changes nothing', (_label, patch) => {
    const before = allRows()
    expect(validationFailure(() => updateEditableSettings(db, patch)).error).toMatchObject({
      code: 'VALIDATION',
      fieldErrors: { root: [expect.any(String)] }
    })
    expect(allRows()).toEqual(before)
  })

  it.each<[string, unknown, string]>([
    ['business.name', '  ', 'Enter the business name.'],
    ['currency.code', 'pkr', 'Use a three-letter currency code, such as PKR.'],
    ['currency.symbol', '', 'Enter the currency symbol.'],
    ['currency.minorDigits', 5, 'Enter a whole number from 0 to 4.'],
    ['invoice.prefix', 'INV /', 'Use up to 12 letters, digits, dots, dashes or underscores.'],
    ['invoice.padding', 0, 'Enter a whole number from 1 to 10.'],
    ['invoice.startNumber', 1.5, 'Enter a whole number from 1 to 999,999,999.'],
    ['invoice.paperSize', 'Letter', 'Choose A4 or A5.']
  ])('explains an invalid %s in plain words', (key, value, message) => {
    expect(
      validationFailure(() => updateEditableSettings(db, { [key]: value })).error.fieldErrors
    ).toEqual({ [key]: [message] })
  })
})
