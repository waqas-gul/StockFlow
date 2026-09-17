import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/adapter'
import { migrations } from '../db/migrations'
import {
  TEST_TIME,
  createSchemaDatabase,
  createTempDir,
  fixtureMigration,
  insertMasters,
  testContext,
  type LogEntry,
  type TempDir,
  type TestContext
} from '../db/test-utils'
import { integrityCheckReport } from './maintenance.service'

const TITLES: ReadonlyArray<readonly [id: string, title: string]> = [
  ['sqlite.integrity', 'Database file'],
  ['sqlite.foreign-keys', 'Links between records'],
  ['database.application-id', 'StockFlow database'],
  ['database.schema-version', 'Database version'],
  ['schema.history', 'Database structure'],
  ['inventory.stock', 'Stock quantities and values'],
  ['ledger.entries', 'Customer ledger'],
  ['ledger.balances', 'Customer balances'],
  ['invoices.totals', 'Invoice lines and totals'],
  ['invoices.stock', 'Invoice stock'],
  ['invoices.accounts', 'Invoice customer accounts'],
  ['payments.ledger', 'Payments'],
  ['customers.walk-in', 'Walk-in customer'],
  ['receipts.stock', 'Stock receipts'],
  ['adjustments.stock', 'Stock adjustments'],
  ['dates.future', 'Business dates']
]

/** What must never reach the screen: SQL, pragmas, internal tables and views, checksums, row ids. */
const TECHNICAL =
  /PRAGMA|SELECT|sqlite_|schema_migrations|v_product_stock|v_customer_balance|sha256|rowid|constraint|no such/i

let temp: TempDir
let ctx: TestContext
let db: Db

beforeEach(async () => {
  temp = createTempDir()
  ctx = testContext(temp, { now: () => TEST_TIME })
  db = await createSchemaDatabase(temp)
})

afterEach(() => {
  temp.remove()
})

function findings(): LogEntry[] {
  return ctx.log.entries.filter(
    (entry) => entry.message === '[maintenance] integrity check finding'
  )
}

function changes(): number {
  return db.get<{ n: number }>('SELECT total_changes() AS n')?.n ?? -1
}

describe('integrityCheckReport', () => {
  it('reports a healthy database as OK, check by check, in plain language', () => {
    const report = integrityCheckReport(db, ctx)
    expect(report).toEqual({
      status: 'OK',
      message: 'No problems were found.',
      checkedAt: TEST_TIME.toISOString(),
      checks: TITLES.map(([id, title]) => ({
        id,
        title,
        status: 'OK',
        message: expect.any(String)
      })),
      ref: null
    })
    expect(report.checks.map((check) => check.message)).toContain('The database file is intact.')
    expect(JSON.stringify(report)).not.toMatch(TECHNICAL)
    expect(ctx.log.entries).toEqual([
      {
        level: 'INFO',
        message: '[maintenance] integrity check run',
        context: { status: 'OK', ms: expect.any(Number), ref: null }
      }
    ])
  })

  it('reports a damaged database as ERROR, with a reference to the technical details in the log', () => {
    db.exec('PRAGMA ignore_check_constraints = ON')
    db.run("INSERT INTO settings (key, value) VALUES ('probe.broken', 'not json')")
    db.exec('PRAGMA ignore_check_constraints = OFF')
    const report = integrityCheckReport(db, ctx)
    expect(report).toMatchObject({
      status: 'ERROR',
      message: expect.stringMatching(/Restore a recent verified backup/),
      ref: expect.stringMatching(/^[0-9A-F]{6}$/)
    })
    expect(report.checks[0]).toEqual({
      id: 'sqlite.integrity',
      title: 'Database file',
      status: 'ERROR',
      message: 'The database file is damaged.'
    })
    expect(JSON.stringify(report)).not.toMatch(TECHNICAL)
    expect(findings()).toContainEqual({
      level: 'WARN',
      message: '[maintenance] integrity check finding',
      context: {
        ref: report.ref,
        check: 'sqlite.integrity',
        status: 'ERROR',
        findings: 1,
        detail: expect.stringContaining('CHECK constraint failed in settings')
      }
    })
  })

  it('logs how many business findings there are, never the products or customers they name', () => {
    insertMasters(db)
    db.exec(`
      DROP VIEW v_product_stock;
      CREATE VIEW v_product_stock AS SELECT id AS product_id, 5 AS qty_base, 0 AS value_minor FROM products;
    `)
    const report = integrityCheckReport(db, ctx)
    expect(report.checks.find((check) => check.id === 'inventory.stock')).toEqual({
      id: 'inventory.stock',
      title: 'Stock quantities and values',
      status: 'ERROR',
      message: 'Some stock quantities or values are not consistent.'
    })
    expect(findings()).toEqual([
      {
        level: 'WARN',
        message: '[maintenance] integrity check finding',
        context: {
          ref: report.ref,
          check: 'inventory.stock',
          status: 'ERROR',
          findings: 2,
          detail: null
        }
      }
    ])
    const everything = JSON.stringify([report, ctx.log.entries])
    expect(everything).not.toMatch(/P-00|Tea|Sugar|C-000|Ali/)
  })

  it('says when a check could not be completed, and logs why', () => {
    db.exec('DROP VIEW v_customer_balance')
    const report = integrityCheckReport(db, ctx)
    expect(report.checks.find((check) => check.id === 'ledger.balances')).toEqual({
      id: 'ledger.balances',
      title: 'Customer balances',
      status: 'ERROR',
      message: 'This check could not be completed.'
    })
    expect(JSON.stringify(report)).not.toMatch(TECHNICAL)
    expect(findings()).toContainEqual({
      level: 'WARN',
      message: '[maintenance] integrity check finding',
      context: {
        ref: report.ref,
        check: 'ledger.balances',
        status: 'ERROR',
        findings: 1,
        detail: expect.stringMatching(/no such table: v_customer_balance/)
      }
    })
  })

  it('reports a database that still needs a migration as a WARNING', () => {
    const newer = testContext(temp, {
      now: () => TEST_TIME,
      migrations: [...migrations, fixtureMigration(2, '0002_fixture_later', 'SELECT 1')]
    })
    const report = integrityCheckReport(db, newer)
    expect(report).toMatchObject({
      status: 'WARNING',
      message: 'Something needs attention. See the checks below.',
      ref: expect.stringMatching(/^[0-9A-F]{6}$/)
    })
    expect(report.checks.find((check) => check.id === 'database.schema-version')).toMatchObject({
      status: 'WARNING',
      message: 'The database is older than this version of StockFlow and still needs its update.'
    })
  })

  it('only reads: it never changes the database it checks', () => {
    insertMasters(db)
    const before = changes()
    integrityCheckReport(db, ctx)
    expect(changes()).toBe(before)
  })
})
