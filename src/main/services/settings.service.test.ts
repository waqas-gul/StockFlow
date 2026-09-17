import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/adapter'
import {
  createMemoryLogger,
  createSchemaDatabase,
  createTempDir,
  insertMasters,
  insertRow,
  isBetween,
  rows,
  thrown,
  type Masters,
  type Row,
  type TempDir
} from '../db/test-utils'
import { AppFailure } from '../errors'
import {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  SettingsPatchSchema,
  hasMonetaryData,
  readEditableSettings,
  readSettings,
  readSettingsView,
  updateEditableSettings,
  updateSettings,
  updateSettingsView
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

  it('readSettingsView adds whether the currency settings and the starting number are locked', () => {
    expect(readSettingsView(db)).toEqual({
      values: EDITABLE,
      currencyLocked: false,
      startNumberLocked: false
    })
    const m = insertMasters(db)
    insertRow(db, 'expenses', rows.expense(m))
    expect(readSettingsView(db)).toEqual({
      values: EDITABLE,
      currencyLocked: true,
      startNumberLocked: false
    })
    insertRow(db, 'invoices', rows.invoice(m))
    expect(readSettingsView(db)).toEqual({
      values: EDITABLE,
      currencyLocked: true,
      startNumberLocked: true
    })
  })

  it('updateSettingsView saves the change and returns the settings with the locks', () => {
    expect(updateSettingsView(db, { 'currency.symbol': 'PKR' })).toEqual({
      values: { ...EDITABLE, 'currency.symbol': 'PKR' },
      currencyLocked: false,
      startNumberLocked: false
    })
  })
})

describe('the currency code, symbol and decimal places are locked once financial data exists', () => {
  const MESSAGE = 'Currency settings cannot be changed after financial data has been entered.'
  const lockedFor = (...keys: string[]): unknown => ({
    code: 'SETTING_LOCKED',
    message: MESSAGE,
    fieldErrors: Object.fromEntries(keys.map((key) => [key, [MESSAGE]]))
  })
  const LOCKED = lockedFor('currency.minorDigits')

  /** Master data whose units have no price or cost: not financial data. */
  function pricelessMasters(): Masters {
    const m = insertMasters(db)
    db.run(
      'UPDATE product_units SET wholesale_price_minor = NULL, retail_price_minor = NULL, default_cost_minor = NULL'
    )
    return m
  }

  /** Inserts a row whose parents do not exist, as only the table itself is under test. */
  function insertOrphan(table: string, row: Row): void {
    db.exec('PRAGMA foreign_keys = OFF')
    try {
      insertRow(db, table, row)
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }
  }

  it('is not locked in a new database: the seeded settings, walk-in customer and expense categories hold no amounts', () => {
    expect(hasMonetaryData(db)).toBe(false)
  })

  it('may change while there is no financial data, even with companies, products, units and customers', () => {
    pricelessMasters()
    expect(hasMonetaryData(db)).toBe(false)
    expect(updateEditableSettings(db, { 'currency.minorDigits': 0 })).toMatchObject({
      'currency.minorDigits': 0
    })
    expect(updateSettings(db, { 'currency.minorDigits': 3 })['currency.minorDigits']).toBe(3)
    expect(stored('currency.minorDigits')).toBe('3')
    expect(
      updateEditableSettings(db, { 'currency.code': 'USD', 'currency.symbol': '$' })
    ).toMatchObject({ 'currency.code': 'USD', 'currency.symbol': '$' })
    expect(stored('currency.code')).toBe('"USD"')
    expect(stored('currency.symbol')).toBe('"$"')
  })

  it.each<[string, (m: Masters) => void]>([
    [
      'a retail price',
      (m) => db.run('UPDATE product_units SET retail_price_minor = 11000 WHERE id = ?', [m.pieceId])
    ],
    [
      'a wholesale price',
      (m) => db.run('UPDATE product_units SET wholesale_price_minor = 0 WHERE id = ?', [m.boxId])
    ],
    [
      'a default cost',
      (m) => db.run('UPDATE product_units SET default_cost_minor = 9000 WHERE id = ?', [m.pieceId])
    ],
    ['a stock receipt', () => insertRow(db, 'stock_receipts', rows.receipt())],
    ['a stock receipt line', (m) => insertOrphan('stock_receipt_items', rows.receiptItem(m, 99))],
    ['a stock adjustment', (m) => insertRow(db, 'stock_adjustments', rows.adjustment(m))],
    [
      'a stock movement',
      (m) => insertOrphan('stock_movements', rows.movement(m, { receipt_item_id: 99 }))
    ],
    ['an invoice', (m) => insertRow(db, 'invoices', rows.invoice(m))],
    ['an invoice line', (m) => insertOrphan('invoice_items', rows.invoiceItem(m, 99))],
    [
      'an invoice line quantity',
      (m) => insertOrphan('invoice_item_quantities', rows.quantity(99, m.boxId))
    ],
    ['a payment', (m) => insertRow(db, 'payments', rows.payment(m))],
    ['an expense', (m) => insertRow(db, 'expenses', rows.expense(m))],
    ['a customer ledger entry', (m) => insertRow(db, 'customer_ledger', rows.ledger(m))]
  ])('is locked once there is %s: the change is refused and nothing is saved', (_label, insert) => {
    insert(pricelessMasters())
    expect(hasMonetaryData(db)).toBe(true)
    const before = allRows()

    const failure = validationFailure(() =>
      updateEditableSettings(db, { 'business.name': 'Ali Traders', 'currency.minorDigits': 0 })
    )

    expect(failure.error).toEqual(LOCKED)
    for (const [key, value] of [
      ['currency.code', 'USD'],
      ['currency.symbol', '$']
    ] as const) {
      expect(validationFailure(() => updateEditableSettings(db, { [key]: value })).error).toEqual(
        lockedFor(key)
      )
    }
    expect(allRows()).toEqual(before)
  })

  it('refuses the change through updateSettings as well', () => {
    insertRow(db, 'stock_receipts', rows.receipt())
    expect(
      validationFailure(() => updateSettings(db, { 'currency.minorDigits': 4 })).error
    ).toEqual(LOCKED)
    expect(stored('currency.minorDigits')).toBe('2')
  })

  it('still accepts saving the current currency settings unchanged, but not another code or symbol', () => {
    insertRow(db, 'stock_receipts', rows.receipt())
    expect(
      updateEditableSettings(db, {
        'business.name': 'Ali Traders',
        'currency.minorDigits': 2,
        'currency.code': 'PKR',
        'currency.symbol': 'Rs'
      })
    ).toMatchObject({
      'business.name': 'Ali Traders',
      'currency.minorDigits': 2,
      'currency.code': 'PKR',
      'currency.symbol': 'Rs'
    })
    const before = allRows()
    expect(
      validationFailure(() =>
        updateEditableSettings(db, {
          'currency.minorDigits': 2,
          'currency.code': 'USD',
          'currency.symbol': '$'
        })
      ).error
    ).toEqual(lockedFor('currency.code', 'currency.symbol'))
    expect(allRows()).toEqual(before)
    expect(stored('currency.code')).toBe('"PKR"')
    expect(stored('currency.symbol')).toBe('"Rs"')
  })
})

describe('invoice.startNumber is locked once invoice numbering has begun', () => {
  const MESSAGE = 'Starting number cannot be changed after invoice numbering has begun.'
  const LOCKED = {
    code: 'SETTING_LOCKED',
    message: MESSAGE,
    fieldErrors: { 'invoice.startNumber': [MESSAGE] }
  }

  it('may change before the first invoice', () => {
    expect(readSettingsView(db).startNumberLocked).toBe(false)
    expect(updateEditableSettings(db, { 'invoice.startNumber': 501 })['invoice.startNumber']).toBe(
      501
    )
    expect(updateSettings(db, { 'invoice.startNumber': 7 })['invoice.startNumber']).toBe(7)
  })

  it.each<[string, () => void]>([
    ['an invoice exists', () => insertRow(db, 'invoices', rows.invoice(insertMasters(db)))],
    [
      'the invoice number sequence has moved on',
      () => db.run("UPDATE sequences SET next_value = 4 WHERE name = 'invoice'")
    ]
  ])('is refused once %s; saving the same number is still accepted', (_label, begin) => {
    updateSettings(db, { 'invoice.startNumber': 501 })
    begin()
    expect(readSettingsView(db).startNumberLocked).toBe(true)
    const before = allRows()
    expect(
      validationFailure(() =>
        updateEditableSettings(db, { 'business.name': 'Ali Traders', 'invoice.startNumber': 900 })
      ).error
    ).toEqual(LOCKED)
    expect(validationFailure(() => updateSettings(db, { 'invoice.startNumber': 1 })).error).toEqual(
      LOCKED
    )
    expect(allRows()).toEqual(before)
    expect(
      updateEditableSettings(db, { 'invoice.startNumber': 501, 'invoice.prefix': 'SF-' })
    ).toMatchObject({ 'invoice.startNumber': 501, 'invoice.prefix': 'SF-' })
  })
})
