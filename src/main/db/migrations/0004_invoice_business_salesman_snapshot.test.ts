import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupFolder } from '../../data-paths'
import { sqliteErrorCode, type Db, type SqlValue } from '../adapter'
import { openDatabase, readUserVersion } from '../connection'
import { initializeDatabase } from '../index'
import {
  INVOICE_BUSINESS_SNAPSHOT,
  TEST_TIME,
  createSchemaDatabase,
  createTempDir,
  insertDocuments,
  insertMasters,
  insertRow,
  rows,
  sqlChecksum,
  testContext,
  type Documents,
  type Masters,
  type TempDir
} from '../test-utils'
import { verifyDatabaseFile } from '../verify'
import { initialMigration } from './0001_initial'
import { stockAdjustmentReceiptItemMigration } from './0002_stock_adjustment_receipt_item'
import { supplierAccountsMigration } from './0003_supplier_accounts'
import {
  INVOICE_BUSINESS_SALESMAN_SNAPSHOT_SQL,
  invoiceBusinessSalesmanSnapshotMigration
} from './0004_invoice_business_salesman_snapshot'
import { migrations } from './index'

const TRIGGER = 'SQLITE_CONSTRAINT_TRIGGER'
const SCHEMA_THREE = [
  initialMigration,
  stockAdjustmentReceiptItemMigration,
  supplierAccountsMigration
]
const SNAPSHOT_COLUMNS = [
  'shop_name_snapshot',
  'shop_address_snapshot',
  'salesman_name_snapshot',
  'salesman_phone1_snapshot',
  'salesman_phone2_snapshot'
]

let temp: TempDir

beforeEach(() => {
  temp = createTempDir()
})

afterEach(() => {
  temp.remove()
})

function codeOf(db: Db, sql: string, params: SqlValue[] = []): string | undefined {
  try {
    db.run(sql, params)
    return undefined
  } catch (error) {
    return sqliteErrorCode(error)
  }
}

/** Every user table and its rows, for comparing a database before and after the migration. */
function snapshot(db: Db): Record<string, Array<Record<string, unknown>>> {
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .map((row) => row.name)
  return Object.fromEntries(
    tables.map((table) => [table, db.all(`SELECT * FROM "${table}" ORDER BY rowid`)])
  )
}

function settingsOf(db: Db): Record<string, unknown> {
  return Object.fromEntries(
    db
      .all<{ key: string; value: string }>('SELECT key, value FROM settings ORDER BY key')
      .map((row) => [row.key, JSON.parse(row.value)])
  )
}

/**
 * A schema 3 database (0001–0003) holding master data, one document of each kind, a second invoice that was voided, a
 * supplier and a customer ledger entry, closed. `businessName` is the shop name the owner saved in Settings, if any.
 */
async function schemaThreeDatabase(businessName?: string): Promise<void> {
  const db = await initializeDatabase(testContext(temp, { migrations: SCHEMA_THREE }))
  try {
    const m = insertMasters(db)
    insertDocuments(db, m)
    insertRow(
      db,
      'invoices',
      rows.invoice(m, {
        invoice_no: 'INV-000002',
        seq_no: 2,
        request_id: 'invoice-request-2',
        status: 'VOID',
        void_reason: 'Wrong customer',
        voided_at: '2026-09-11T05:00:00.000Z',
        void_date: '2026-09-11'
      })
    )
    insertRow(db, 'customer_ledger', rows.ledger(m))
    insertRow(db, 'suppliers', { code: 'SUP-00001', name: 'ABC Distributors' })
    db.run("UPDATE sequences SET next_value = 3 WHERE name = 'invoice'")
    if (businessName !== undefined) {
      db.run("UPDATE settings SET value = ? WHERE key = 'business.name'", [
        JSON.stringify(businessName)
      ])
    }
  } finally {
    db.close()
  }
}

describe('0004_invoice_business_salesman_snapshot: definition', () => {
  it('is schema version 4, registered after 0003', () => {
    expect(invoiceBusinessSalesmanSnapshotMigration.version).toBe(4)
    expect(invoiceBusinessSalesmanSnapshotMigration.name).toBe(
      '0004_invoice_business_salesman_snapshot'
    )
    expect(migrations).toEqual([...SCHEMA_THREE, invoiceBusinessSalesmanSnapshotMigration])
  })

  it('pins the SHA-256 checksum of its SQL script, with LF line endings and no floating-point types', () => {
    expect(invoiceBusinessSalesmanSnapshotMigration.checksum).toBe(
      sqlChecksum(INVOICE_BUSINESS_SALESMAN_SNAPSHOT_SQL)
    )
    expect(INVOICE_BUSINESS_SALESMAN_SNAPSHOT_SQL).not.toContain('\r')
    expect(INVOICE_BUSINESS_SALESMAN_SNAPSHOT_SQL).not.toMatch(
      /\b(REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL)\b/i
    )
  })

  it('leaves the checksums of 0001, 0002 and 0003 unchanged', () => {
    expect(initialMigration.checksum).toBe(
      'sha256:0cc4eb9837b99f71442ed9e8bbd48723f869bcbc8fb2f4d8b0dcd90bee576cc4'
    )
    expect(stockAdjustmentReceiptItemMigration.checksum).toBe(
      'sha256:fb50cb92d9de9f5d2e41866ea02f9192bd5416f2284e33e1e4a7483f6c4a442d'
    )
    expect(supplierAccountsMigration.checksum).toBe(
      'sha256:5bcbe1726aee3f75a7240faab2c266ece5b6499e80f6e8ed6950870c0eaad0a0'
    )
  })

  it('only adds five nullable invoice columns, two triggers and settings: nothing is dropped or rewritten', () => {
    const sql = INVOICE_BUSINESS_SALESMAN_SNAPSHOT_SQL
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i)
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(sql).not.toMatch(/\bCREATE\s+TABLE\b/i)
    expect(
      [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+) TEXT;/g)].map((m) => m.slice(1))
    ).toEqual(SNAPSHOT_COLUMNS.map((column) => ['invoices', column]))
    // No invoice is ever updated: old invoices are not backfilled. The only UPDATE is the untouched default shop name.
    expect([...sql.matchAll(/\bUPDATE\s+(\w+)\s+SET\b/gi)].map((m) => m[1])).toEqual(['settings'])
    expect([...sql.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1])).toEqual(['settings'])
  })
})

describe('0004_invoice_business_salesman_snapshot: upgrading a schema 3 database', () => {
  it('makes a verified pre-migration backup, then migrates 3 → 4 keeping every row and every older checksum', async () => {
    await schemaThreeDatabase()
    const before = openDatabase(testContext(temp).paths.databaseFile)
    const tablesBefore = snapshot(before)
    before.close()

    const ctx = testContext(temp, { now: () => TEST_TIME })
    const db = temp.track(await initializeDatabase(ctx))

    expect(readUserVersion(db)).toBe(4)
    expect(
      db.all('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    ).toEqual([
      { version: 1, name: '0001_initial', checksum: initialMigration.checksum },
      {
        version: 2,
        name: '0002_stock_adjustment_receipt_item',
        checksum: stockAdjustmentReceiptItemMigration.checksum
      },
      { version: 3, name: '0003_supplier_accounts', checksum: supplierAccountsMigration.checksum },
      {
        version: 4,
        name: '0004_invoice_business_salesman_snapshot',
        checksum: invoiceBusinessSalesmanSnapshotMigration.checksum
      }
    ])

    const after = snapshot(db)
    for (const [table, rowsBefore] of Object.entries(tablesBefore)) {
      if (table === 'schema_migrations' || table === 'settings') continue
      if (table === 'invoices') {
        // Every old invoice keeps every saved value; the new columns are empty (no history is invented).
        expect(
          after.invoices.map((row) =>
            Object.fromEntries(
              Object.entries(row).filter(([column]) => !SNAPSHOT_COLUMNS.includes(column))
            )
          )
        ).toEqual(rowsBefore)
        for (const row of after.invoices) {
          for (const column of SNAPSHOT_COLUMNS) expect(row[column], column).toBeNull()
        }
        continue
      }
      expect(after[table], table).toEqual(rowsBefore)
    }
    expect(after.invoices).toHaveLength(2)

    // Settings: every earlier value is kept, the default shop name becomes the shop's name, the salesman is added.
    const settingsBefore = Object.fromEntries(
      tablesBefore.settings.map((row) => [row.key, JSON.parse(String(row.value))])
    )
    expect(settingsOf(db)).toEqual({
      ...settingsBefore,
      'business.name': 'Iftikhar and Arshad Traders',
      'business.address': '',
      'salesman.name': 'Mansoor Iqbal',
      'salesman.phone1': '03179927633',
      'salesman.phone2': '03463820629'
    })
    expect(db.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])

    const folder = backupFolder(ctx.paths, 'pre-migration')
    const backups = readdirSync(folder).filter((name) => name.endsWith('.db'))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/_s3\.db$/)
    expect(verifyDatabaseFile(join(folder, backups[0])).schemaVersion).toBe(3)
    // The backup is made before anything is migrated.
    const messages = ctx.log.entries.map((entry) => entry.message)
    expect(messages.indexOf('[migrate] verified pre-migration backup made')).toBeLessThan(
      messages.indexOf('[migrate] schema migrated')
    )
  })

  it('keeps a shop name the owner already chose', async () => {
    await schemaThreeDatabase('Madina Traders')
    const db = temp.track(await initializeDatabase(testContext(temp)))
    expect(settingsOf(db)['business.name']).toBe('Madina Traders')
    expect(settingsOf(db)['salesman.name']).toBe('Mansoor Iqbal')
  })

  it('never lets an old invoice be given a snapshot later, but still lets it be voided or its dispatch changed', async () => {
    await schemaThreeDatabase()
    const db = temp.track(await initializeDatabase(testContext(temp)))
    const legacy = db.get<{ id: number }>(
      "SELECT id FROM invoices WHERE invoice_no = 'INV-000001'"
    )!
    for (const column of SNAPSHOT_COLUMNS) {
      expect(
        codeOf(db, `UPDATE invoices SET ${column} = 'Mansoor Iqbal' WHERE id = ?`, [legacy.id]),
        column
      ).toBe(TRIGGER)
    }
    expect(
      codeOf(db, "UPDATE invoices SET bilty_no = 'BL-9', dispatch_updated_at = ? WHERE id = ?", [
        '2026-09-12T05:00:00.000Z',
        legacy.id
      ])
    ).toBeUndefined()
    expect(
      codeOf(
        db,
        "UPDATE invoices SET status = 'VOID', void_reason = 'Wrong', voided_at = '2026-09-12T06:00:00.000Z', void_date = '2026-09-12' WHERE id = ?",
        [legacy.id]
      )
    ).toBeUndefined()
    expect(
      db.get(`SELECT status, ${SNAPSHOT_COLUMNS.join(', ')} FROM invoices WHERE id = ?`, [
        legacy.id
      ])
    ).toEqual({ status: 'VOID', ...Object.fromEntries(SNAPSHOT_COLUMNS.map((c) => [c, null])) })
  })

  it('is idempotent: a second launch migrates nothing and makes no second backup', async () => {
    await schemaThreeDatabase()
    const first = await initializeDatabase(testContext(temp))
    const rowsAfterFirst = snapshot(first)
    first.close()
    const ctx = testContext(temp)
    const db = temp.track(await initializeDatabase(ctx))
    expect(readUserVersion(db)).toBe(4)
    expect(snapshot(db)).toEqual(rowsAfterFirst)
    expect(ctx.log.entries.map((entry) => entry.message)).not.toContain('[migrate] schema migrated')
    const folder = backupFolder(ctx.paths, 'pre-migration')
    expect(readdirSync(folder).filter((name) => name.endsWith('.db'))).toHaveLength(1)
  })

  it('migrates a new database from schema 0 straight to 4, with the shop and salesman settings, without a backup', async () => {
    const ctx = testContext(temp)
    const db = await createSchemaDatabase(temp)
    expect(readUserVersion(db)).toBe(4)
    expect(settingsOf(db)).toMatchObject({
      'business.name': 'Iftikhar and Arshad Traders',
      'business.address': '',
      'salesman.name': 'Mansoor Iqbal',
      'salesman.phone1': '03179927633',
      'salesman.phone2': '03463820629'
    })
    const folder = backupFolder(ctx.paths, 'pre-migration')
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([])
  })

  it('applies atomically: a failure at the end of 0004 leaves schema 3 exactly as it was', async () => {
    await schemaThreeDatabase()
    const raw = openDatabase(testContext(temp).paths.databaseFile)
    // The last object 0004 creates already exists, so 0004 fails after its columns and settings.
    raw.exec(`CREATE TRIGGER trg_invoices_business_snapshot_guard BEFORE DELETE ON sequences
      BEGIN SELECT 1; END`)
    const before = snapshot(raw)
    raw.close()

    await expect(initializeDatabase(testContext(temp))).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      version: 4
    })
    const db = temp.track(openDatabase(testContext(temp).paths.databaseFile))
    expect(readUserVersion(db)).toBe(3)
    expect(snapshot(db)).toEqual(before)
    const columns = db.all<{ name: string }>('PRAGMA table_info(invoices)')
    expect(columns.map((column) => column.name)).not.toContain('shop_name_snapshot')
    expect(settingsOf(db)['business.name']).toBe('StockFlow')
    expect(settingsOf(db)).not.toHaveProperty('salesman.name')
  })
})

describe('0004_invoice_business_salesman_snapshot: constraints', () => {
  let db: Db
  let m: Masters
  let d: Documents

  beforeEach(async () => {
    db = await createSchemaDatabase(temp)
    m = insertMasters(db)
    d = insertDocuments(db, m)
  })

  const invoice = (snapshot: Record<string, SqlValue>): Record<string, SqlValue> =>
    rows.invoice(m, {
      invoice_no: 'INV-000009',
      seq_no: 9,
      request_id: 'invoice-request-9',
      ...INVOICE_BUSINESS_SNAPSHOT,
      ...snapshot
    })

  function insertCode(row: Record<string, SqlValue>): string | undefined {
    try {
      insertRow(db, 'invoices', row)
      return undefined
    } catch (error) {
      return sqliteErrorCode(error)
    }
  }

  it('adds five nullable TEXT columns to invoices and two triggers', () => {
    const columns = db
      .all<{ name: string; type: string; notnull: number; dflt_value: unknown }>(
        'PRAGMA table_info(invoices)'
      )
      .filter((column) => SNAPSHOT_COLUMNS.includes(column.name))
    expect(columns).toEqual(
      SNAPSHOT_COLUMNS.map((name) =>
        expect.objectContaining({ name, type: 'TEXT', notnull: 0, dflt_value: null })
      )
    )
    expect(
      db
        .all<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'trg_invoices_business%' ORDER BY name"
        )
        .map((row) => row.name)
    ).toEqual(['trg_invoices_business_snapshot', 'trg_invoices_business_snapshot_guard'])
  })

  it('requires every new invoice to keep its shop name and salesman', () => {
    expect(insertCode(invoice({}))).toBeUndefined()
    expect(
      insertCode(
        invoice({
          invoice_no: 'INV-000010',
          seq_no: 10,
          request_id: 'invoice-request-10',
          shop_address_snapshot: null,
          salesman_phone1_snapshot: null,
          salesman_phone2_snapshot: null
        })
      )
    ).toBeUndefined()
    for (const column of ['shop_name_snapshot', 'salesman_name_snapshot']) {
      expect(insertCode(invoice({ [column]: null })), column).toBe(TRIGGER)
      expect(insertCode(invoice({ [column]: '  ' })), column).toBe(TRIGGER)
    }
    // An empty optional detail is saved as NULL, never as blank text.
    for (const column of [
      'shop_address_snapshot',
      'salesman_phone1_snapshot',
      'salesman_phone2_snapshot'
    ]) {
      expect(insertCode(invoice({ [column]: ' ' })), column).toBe(TRIGGER)
    }
  })

  it('never changes a saved snapshot, but lets the invoice be voided and its dispatch change', () => {
    const id = insertRow(db, 'invoices', invoice({}))
    for (const column of SNAPSHOT_COLUMNS) {
      expect(codeOf(db, `UPDATE invoices SET ${column} = 'Other' WHERE id = ?`, [id]), column).toBe(
        TRIGGER
      )
    }
    expect(codeOf(db, 'UPDATE invoices SET shop_address_snapshot = NULL WHERE id = ?', [id])).toBe(
      TRIGGER
    )
    expect(
      codeOf(db, "UPDATE invoices SET adda_name = 'Lari Adda' WHERE id = ?", [id])
    ).toBeUndefined()
    expect(
      codeOf(
        db,
        "UPDATE invoices SET status = 'VOID', void_reason = 'Wrong', voided_at = '2026-09-12T06:00:00.000Z', void_date = '2026-09-12' WHERE id = ?",
        [id]
      )
    ).toBeUndefined()
    // The document fixture's own invoice was written with a snapshot too.
    expect(db.get('SELECT shop_name_snapshot FROM invoices WHERE id = ?', [d.invoiceId])).toEqual({
      shop_name_snapshot: INVOICE_BUSINESS_SNAPSHOT.shop_name_snapshot
    })
  })
})
