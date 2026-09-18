import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from './adapter'
import { openDatabase } from './connection'
import {
  checkSchemaHistory,
  runIntegrityCheck,
  type IntegrityCheckId,
  type IntegrityCheckResult,
  type IntegrityReport
} from './integrity'
import type { Migration } from './migrate'
import { migrations } from './migrations'
import { initialMigration } from './migrations/0001_initial'
import {
  createSchemaDatabase,
  createTempDir,
  fixtureMigration,
  insertDocuments,
  insertMasters,
  insertRow,
  isBetween,
  rows,
  type Documents,
  type Masters,
  type TempDir
} from './test-utils'

const CHECKED_AT = '2026-09-14T10:00:00.000Z'
const OTHER_CHECKSUM = `sha256:${'f'.repeat(64)}`
const CHECK_IDS: IntegrityCheckId[] = [
  'sqlite.integrity',
  'sqlite.foreign-keys',
  'database.application-id',
  'database.schema-version',
  'schema.history',
  'inventory.stock',
  'ledger.entries',
  'ledger.balances',
  'invoices.totals',
  'invoices.stock',
  'invoices.accounts',
  'payments.ledger',
  'customers.walk-in',
  'receipts.stock',
  'adjustments.stock',
  'suppliers.ledger',
  'suppliers.purchases',
  'suppliers.payments',
  'dates.future'
]

let temp: TempDir
let db: Db

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
})

afterEach(() => {
  temp.remove()
})

function report(target: Db = db, list: readonly Migration[] = migrations): IntegrityReport {
  return runIntegrityCheck(target, { migrations: list, now: () => new Date(CHECKED_AT) })
}

function check(result: IntegrityReport, id: IntegrityCheckId): IntegrityCheckResult {
  const found = result.checks.find((item) => item.id === id)
  if (!found) throw new Error(`No ${id} check in the report.`)
  return found
}

function statuses(result: IntegrityReport): Record<string, string> {
  return Object.fromEntries(result.checks.map((item) => [item.id, item.status]))
}

describe('runIntegrityCheck: a healthy database', () => {
  it('reports OK for a new database at the latest schema, listing every check', () => {
    const result = report()
    expect(result.status).toBe('OK')
    expect(result.checkedAt).toBe(CHECKED_AT)
    expect(result.schemaVersion).toBe(migrations.length)
    expect(result.checks.map((item) => item.id)).toEqual(CHECK_IDS)
    for (const item of result.checks) {
      expect(item).toMatchObject({ status: 'OK', issues: [] })
      expect(item.title).not.toBe('')
      expect(item.summary).not.toBe('')
    }
  })

  it('reports OK for consistent stock and ledger data', () => {
    const m = insertMasters(db)
    const d = insertDocuments(db, m)
    insertRow(db, 'stock_movements', rows.movement(m, { receipt_item_id: d.receiptItemId }))
    // The sale takes the line's quantity at its frozen cost (200,000); the damage adjustment has its own movement.
    insertRow(
      db,
      'stock_movements',
      rows.movement(m, {
        type: 'SALE',
        qty_base: -27,
        value_minor: -200000,
        invoice_item_id: d.invoiceItemId,
        movement_date: '2026-09-10'
      })
    )
    insertRow(
      db,
      'stock_movements',
      rows.movement(m, {
        type: 'ADJUST_OUT',
        qty_base: -3,
        value_minor: -27000,
        adjustment_id: d.adjustmentId,
        movement_date: '2026-09-02'
      })
    )
    insertRow(
      db,
      'customer_ledger',
      rows.ledger(m, { type: 'INVOICE', amount_minor: 233000, invoice_id: d.invoiceId })
    )
    insertRow(
      db,
      'customer_ledger',
      rows.ledger(m, { type: 'PAYMENT', amount_minor: -50000, payment_id: d.paymentId })
    )
    expect(statuses(report())).toEqual(Object.fromEntries(CHECK_IDS.map((id) => [id, 'OK'])))
  })

  it('never changes the database', () => {
    const before = db.get('SELECT total_changes() AS n')
    report()
    expect(db.get('SELECT total_changes() AS n')).toEqual(before)
  })
})

describe('runIntegrityCheck: database-level problems', () => {
  it('detects foreign key violations', () => {
    db.exec('PRAGMA foreign_keys = OFF')
    insertRow(db, 'product_units', rows.unit(999))
    db.exec('PRAGMA foreign_keys = ON')
    const result = report()
    expect(result.status).toBe('ERROR')
    expect(check(result, 'sqlite.foreign-keys')).toMatchObject({
      status: 'ERROR',
      issues: ['product_units: 1 row(s) refer to missing rows of products (first rowid 1).']
    })
  })

  it('detects a failed integrity_check', () => {
    db.exec('PRAGMA ignore_check_constraints = ON')
    insertRow(db, 'settings', { key: 'probe.broken', value: 'not json' })
    db.exec('PRAGMA ignore_check_constraints = OFF')
    expect(check(report(), 'sqlite.integrity')).toMatchObject({
      status: 'ERROR',
      issues: ['CHECK constraint failed in settings']
    })
  })

  it('detects a database that is not marked as a StockFlow database', () => {
    db.exec('PRAGMA application_id = 42')
    expect(check(report(), 'database.application-id')).toMatchObject({
      status: 'ERROR',
      summary: expect.stringMatching(/application_id is 42/)
    })
  })
})

describe('runIntegrityCheck: schema', () => {
  it('detects a migration checksum mismatch, and reports it without changing the recorded one', () => {
    const history = check(
      report(db, [{ ...initialMigration, checksum: OTHER_CHECKSUM }, ...migrations.slice(1)]),
      'schema.history'
    )
    expect(history.status).toBe('ERROR')
    expect(history.issues).toEqual([
      `Migration 0001_initial was applied with checksum ${initialMigration.checksum}, but this version of ` +
        `StockFlow has ${OTHER_CHECKSUM}: the schema may have been changed outside StockFlow.`
    ])
    expect(db.all('SELECT checksum FROM schema_migrations ORDER BY version')).toEqual(
      migrations.map((migration) => ({ checksum: migration.checksum }))
    )
  })

  it('detects a migration recorded under another name', () => {
    const history = check(
      report(db, [{ ...initialMigration, name: '0001_other' }, ...migrations.slice(1)]),
      'schema.history'
    )
    expect(history.issues).toEqual([
      'Migration 1 is recorded as 0001_initial, but this version of StockFlow names it 0001_other.'
    ])
  })

  it('detects a schema version that schema_migrations does not agree with', () => {
    const newer = migrations.length + 1
    db.exec(`PRAGMA user_version = ${newer}`)
    const result = report()
    expect(check(result, 'database.schema-version')).toMatchObject({
      status: 'ERROR',
      summary: expect.stringContaining(`schema ${newer}, newer than`)
    })
    expect(check(result, 'schema.history')).toMatchObject({
      status: 'ERROR',
      issues: [
        `schema_migrations records versions ${migrations.map((item) => item.version).join(', ')}, but the schema version is ${newer}.`
      ]
    })
  })

  it('detects an invalid (negative) schema version', () => {
    db.exec('PRAGMA user_version = -1')
    expect(check(report(), 'database.schema-version')).toMatchObject({ status: 'ERROR' })
  })

  it('detects a schema history with its rows removed', () => {
    db.exec('DROP TRIGGER trg_schema_migrations_no_delete; DELETE FROM schema_migrations')
    expect(check(report(), 'schema.history')).toMatchObject({
      status: 'ERROR',
      issues: [
        `schema_migrations records versions none, but the schema version is ${migrations.length}.`
      ]
    })
  })

  it('reports pending migrations as a warning', () => {
    const later = fixtureMigration(migrations.length + 1, '9999_fixture_later', 'SELECT 1')
    const result = report(db, [...migrations, later])
    expect(check(result, 'database.schema-version').status).toBe('WARNING')
    expect(result.status).toBe('WARNING')
  })

  it('treats the business checks as not applicable to a database without a schema', () => {
    const empty = temp.track(openDatabase(temp.file('empty.db')))
    const result = report(empty)
    expect(statuses(result)).toEqual({
      'sqlite.integrity': 'OK',
      'sqlite.foreign-keys': 'OK',
      'database.application-id': 'OK',
      'database.schema-version': 'WARNING',
      'schema.history': 'OK',
      'inventory.stock': 'OK',
      'ledger.entries': 'OK',
      'ledger.balances': 'OK',
      'invoices.totals': 'OK',
      'invoices.stock': 'OK',
      'invoices.accounts': 'OK',
      'payments.ledger': 'OK',
      'customers.walk-in': 'OK',
      'receipts.stock': 'OK',
      'adjustments.stock': 'OK',
      'suppliers.ledger': 'OK',
      'suppliers.purchases': 'OK',
      'suppliers.payments': 'OK',
      'dates.future': 'OK'
    })
    expect(check(result, 'suppliers.ledger').summary).toMatch(/not applicable/i)
    expect(check(result, 'inventory.stock').summary).toMatch(/not applicable/i)
    expect(check(result, 'dates.future').summary).toMatch(/not applicable/i)
  })

  it('detects a schema version whose history table and tables are missing', () => {
    const bare = temp.track(openDatabase(temp.file('bare.db')))
    bare.exec('PRAGMA user_version = 1')
    const result = report(bare)
    expect(check(result, 'schema.history')).toMatchObject({
      status: 'ERROR',
      issues: ['The schema_migrations table is missing; PRAGMA user_version is 1.']
    })
    expect(check(result, 'inventory.stock')).toMatchObject({
      status: 'ERROR',
      summary: 'The check could not run.'
    })
  })
})

describe('runIntegrityCheck: inventory', () => {
  let m: Masters
  let d: Documents

  beforeEach(() => {
    m = insertMasters(db)
    d = insertDocuments(db, m)
  })

  function stockIn(qty: number, value: number): void {
    insertRow(
      db,
      'stock_movements',
      rows.movement(m, { qty_base: qty, value_minor: value, receipt_item_id: d.receiptItemId })
    )
  }

  function sale(qty: number, value: number): void {
    insertRow(
      db,
      'stock_movements',
      rows.movement(m, {
        type: 'SALE',
        qty_base: -qty,
        value_minor: -value,
        invoice_item_id: d.invoiceItemId,
        movement_date: '2026-09-10'
      })
    )
  }

  it('detects negative stock', () => {
    sale(27, 270000)
    expect(check(report(), 'inventory.stock')).toMatchObject({
      status: 'ERROR',
      issues: [
        'Product P-001 (id 1): stock is -27 base units.',
        'Product P-001 (id 1): stock value is -270000 minor units.'
      ]
    })
  })

  it('detects a stock value left when no stock is left (Q = 0, V ≠ 0)', () => {
    stockIn(48, 480000)
    sale(48, 470000)
    expect(check(report(), 'inventory.stock').issues).toEqual([
      'Product P-001 (id 1): no stock is left but a stock value of 10000 minor units remains.'
    ])
  })

  it('detects a negative stock value', () => {
    stockIn(48, 480000)
    const adjustmentId = insertRow(
      db,
      'stock_adjustments',
      rows.adjustment(m, {
        adjustment_no: 'ADJ-000002',
        request_id: 'adjustment-request-2',
        reason_code: 'RECEIPT_COST_CORRECTION',
        direction: 'VALUE',
        unit_id: null,
        unit_name: null,
        unit_base_qty: null,
        quantity: null,
        qty_base: 0,
        value_minor: 500000,
        receipt_id: d.receiptId,
        receipt_item_id: d.receiptItemId
      })
    )
    insertRow(
      db,
      'stock_movements',
      rows.movement(m, {
        type: 'COST_CORRECTION',
        qty_base: 0,
        value_minor: -500000,
        adjustment_id: adjustmentId
      })
    )
    expect(check(report(), 'inventory.stock').issues).toEqual([
      'Product P-001 (id 1): stock value is -20000 minor units.'
    ])
  })

  it('detects v_product_stock disagreeing with the stock movements', () => {
    stockIn(48, 480000)
    db.exec(`
      DROP VIEW v_product_stock;
      CREATE VIEW v_product_stock AS
        SELECT id AS product_id, 0 AS qty_base, 0 AS value_minor FROM products WHERE id = 1;
    `)
    expect(check(report(), 'inventory.stock').issues).toEqual([
      'v_product_stock disagrees with the stock movements for product P-001 (id 1).',
      'v_product_stock disagrees with the stock movements for product P-002 (id 2).'
    ])
  })
})

describe('runIntegrityCheck: customer ledger', () => {
  let m: Masters
  let d: Documents

  beforeEach(() => {
    m = insertMasters(db)
    d = insertDocuments(db, m)
  })

  it('detects entries whose sign or references do not match their type', () => {
    db.exec('PRAGMA ignore_check_constraints = ON')
    insertRow(
      db,
      'customer_ledger',
      rows.ledger(m, { type: 'INVOICE', amount_minor: -500, invoice_id: d.invoiceId })
    )
    db.exec('PRAGMA ignore_check_constraints = OFF')
    expect(check(report(), 'ledger.entries')).toMatchObject({
      status: 'ERROR',
      issues: [
        'Ledger entry 1 (INVOICE, -500): the amount sign or references do not match the entry type.'
      ]
    })
  })

  it('detects an entry recorded for another customer than its invoice or payment', () => {
    insertRow(
      db,
      'customer_ledger',
      rows.ledger(m, {
        customer_id: 1,
        type: 'PAYMENT',
        amount_minor: -50000,
        payment_id: d.paymentId
      })
    )
    db.exec('PRAGMA foreign_keys = OFF')
    insertRow(
      db,
      'customer_ledger',
      rows.ledger(m, { type: 'INVOICE', amount_minor: 100, invoice_id: 999 })
    )
    db.exec('PRAGMA foreign_keys = ON')
    expect(check(report(), 'ledger.entries').issues).toEqual([
      'Ledger entry 1 (PAYMENT) is for customer 1, but its payment belongs to customer 2.',
      'Ledger entry 2 (INVOICE) is for customer 2, but its invoice belongs to customer unknown.'
    ])
  })

  it('detects a balance view that disagrees with the ledger', () => {
    insertRow(db, 'customer_ledger', rows.ledger(m))
    db.exec(`
      DROP VIEW v_customer_balance;
      CREATE VIEW v_customer_balance AS SELECT id AS customer_id, 0 AS balance_minor FROM customers;
    `)
    expect(check(report(), 'ledger.balances')).toMatchObject({
      status: 'ERROR',
      issues: [
        'Customer C-00002 (id 2): v_customer_balance shows 0 but the ledger adds up to 10000.'
      ]
    })
    db.exec(`
      DROP VIEW v_customer_balance;
      CREATE VIEW v_customer_balance AS SELECT 1 AS customer_id, 0 AS balance_minor;
    `)
    expect(check(report(), 'ledger.balances').issues).toEqual([
      'Customer C-00002 (id 2): v_customer_balance shows nothing but the ledger adds up to 10000.'
    ])
  })

  it('reports a check that cannot run as an error, instead of throwing', () => {
    db.exec('DROP VIEW v_customer_balance')
    expect(check(report(), 'ledger.balances')).toMatchObject({
      status: 'ERROR',
      summary: 'The check could not run.',
      issues: [expect.stringMatching(/no such table: v_customer_balance/)]
    })
  })

  it('lists at most 20 issues per check, and counts them all in the summary', () => {
    db.exec('PRAGMA ignore_check_constraints = ON')
    for (let index = 0; index < 25; index++) {
      insertRow(
        db,
        'customer_ledger',
        rows.ledger(m, { type: 'ADJUSTMENT', amount_minor: 100, note: null })
      )
    }
    db.exec('PRAGMA ignore_check_constraints = OFF')
    const entries = check(report(), 'ledger.entries')
    expect(entries.issues).toHaveLength(21)
    expect(entries.issues[20]).toBe('… and 5 more.')
    expect(entries.summary).toBe('25 problem(s) found in the customer ledger.')
  })
})

describe('runIntegrityCheck: details', () => {
  it('uses the current time when no clock is given', () => {
    const before = new Date().toISOString()
    const result = runIntegrityCheck(db, { migrations })
    expect(isBetween(result.checkedAt, before, new Date().toISOString())).toBe(true)
  })

  it('groups foreign key violations by table', () => {
    db.exec('PRAGMA foreign_keys = OFF')
    insertRow(db, 'product_units', rows.unit(998))
    insertRow(db, 'product_units', rows.unit(999))
    db.exec('PRAGMA foreign_keys = ON')
    expect(check(report(), 'sqlite.foreign-keys')).toMatchObject({
      summary: '2 row(s) refer to rows that do not exist.',
      issues: ['product_units: 2 row(s) refer to missing rows of products (first rowid 1).']
    })
  })

  it('reports a recorded migration this version of StockFlow does not know', () => {
    const result = report(db, [])
    expect(check(result, 'schema.history').issues).toEqual(
      migrations.map(
        (migration) =>
          `Migration ${migration.version} (${migration.name}) is newer than this version of StockFlow.`
      )
    )
    expect(check(result, 'database.schema-version').status).toBe('ERROR')
  })
})

describe('checkSchemaHistory', () => {
  it('is OK when every applied migration matches this version of StockFlow', () => {
    expect(checkSchemaHistory(db, migrations)).toEqual({
      id: 'schema.history',
      title: 'Schema history and checksums',
      status: 'OK',
      summary: `${migrations.length} applied migration(s) match this version of StockFlow.`,
      issues: []
    })
  })
})
