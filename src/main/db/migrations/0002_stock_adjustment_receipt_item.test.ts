import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupFolder } from '../../data-paths'
import { sqliteErrorCode, type Db, type SqlValue } from '../adapter'
import { openDatabase, readUserVersion } from '../connection'
import { initializeDatabase } from '../index'
import {
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
import {
  STOCK_ADJUSTMENT_RECEIPT_ITEM_SQL,
  stockAdjustmentReceiptItemMigration
} from './0002_stock_adjustment_receipt_item'
import { migrations } from './index'

const TRIGGER = 'SQLITE_CONSTRAINT_TRIGGER'

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

function insertCode(db: Db, row: Record<string, SqlValue>): string | undefined {
  try {
    insertRow(db, 'stock_adjustments', row)
    return undefined
  } catch (error) {
    return sqliteErrorCode(error)
  }
}

/** A schema 1 database (0001 only) holding master data and one document of each kind, closed. */
async function schemaOneDatabase(): Promise<void> {
  const db = await initializeDatabase(testContext(temp, { migrations: [initialMigration] }))
  try {
    const m = insertMasters(db)
    insertDocuments(db, m)
  } finally {
    db.close()
  }
}

describe('0002_stock_adjustment_receipt_item: definition', () => {
  it('is schema version 2, registered after 0001', () => {
    expect(stockAdjustmentReceiptItemMigration.version).toBe(2)
    expect(stockAdjustmentReceiptItemMigration.name).toBe('0002_stock_adjustment_receipt_item')
    expect(migrations).toEqual([initialMigration, stockAdjustmentReceiptItemMigration])
  })

  it('pins the SHA-256 checksum of its SQL script, with LF line endings and no floating-point types', () => {
    expect(stockAdjustmentReceiptItemMigration.checksum).toBe(
      sqlChecksum(STOCK_ADJUSTMENT_RECEIPT_ITEM_SQL)
    )
    expect(STOCK_ADJUSTMENT_RECEIPT_ITEM_SQL).not.toContain('\r')
    expect(STOCK_ADJUSTMENT_RECEIPT_ITEM_SQL).not.toMatch(
      /\b(REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL)\b/i
    )
  })

  it('only adds: it never drops, renames or recreates anything of 0001', () => {
    expect(STOCK_ADJUSTMENT_RECEIPT_ITEM_SQL).not.toMatch(/\b(DROP|RENAME)\b/i)
    expect(STOCK_ADJUSTMENT_RECEIPT_ITEM_SQL).not.toMatch(/CREATE TABLE/i)
  })
})

describe('0002_stock_adjustment_receipt_item: upgrading a schema 1 database', () => {
  it('makes a verified pre-migration backup, then migrates 1 → 2 keeping every row and the 0001 checksum', async () => {
    await schemaOneDatabase()
    const before = openDatabase(testContext(temp).paths.databaseFile)
    const adjustmentsBefore = before.all('SELECT * FROM stock_adjustments ORDER BY id')
    const receiptsBefore = before.all('SELECT * FROM stock_receipts ORDER BY id')
    before.close()

    const ctx = testContext(temp, { now: () => TEST_TIME })
    const db = temp.track(await initializeDatabase(ctx))

    expect(readUserVersion(db)).toBe(2)
    expect(
      db.all('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    ).toEqual([
      { version: 1, name: '0001_initial', checksum: initialMigration.checksum },
      {
        version: 2,
        name: '0002_stock_adjustment_receipt_item',
        checksum: stockAdjustmentReceiptItemMigration.checksum
      }
    ])
    expect(initialMigration.checksum).toBe(
      'sha256:0cc4eb9837b99f71442ed9e8bbd48723f869bcbc8fb2f4d8b0dcd90bee576cc4'
    )
    // The old rows are unchanged; the new column is NULL for them.
    const adjustmentsAfter = db.all<Record<string, unknown>>(
      'SELECT * FROM stock_adjustments ORDER BY id'
    )
    expect(
      adjustmentsAfter.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'receipt_item_id'))
      )
    ).toEqual(adjustmentsBefore)
    expect(adjustmentsAfter.map((row) => row.receipt_item_id)).toEqual([null])
    expect(db.all('SELECT * FROM stock_receipts ORDER BY id')).toEqual(receiptsBefore)
    expect(db.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])

    const folder = backupFolder(ctx.paths, 'pre-migration')
    const backups = readdirSync(folder).filter((name) => name.endsWith('.db'))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/_s1\.db$/)
    expect(verifyDatabaseFile(join(folder, backups[0])).schemaVersion).toBe(1)
  })

  it('migrates a new database from schema 0 straight to 2 without a backup', async () => {
    const ctx = testContext(temp)
    const db = await createSchemaDatabase(temp)
    expect(readUserVersion(db)).toBe(2)
    const folder = backupFolder(ctx.paths, 'pre-migration')
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([])
  })

  it('applies atomically: a failure inside 0002 leaves schema 1 unchanged', async () => {
    await schemaOneDatabase()
    const raw = openDatabase(testContext(temp).paths.databaseFile)
    // An object 0002 wants to create already exists, so 0002 fails after its ALTER TABLE.
    raw.exec('CREATE INDEX idx_stock_adjustments_receipt_item ON stock_adjustments (id)')
    raw.close()

    await expect(initializeDatabase(testContext(temp))).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      version: 2
    })
    const db = temp.track(openDatabase(testContext(temp).paths.databaseFile))
    expect(readUserVersion(db)).toBe(1)
    const columns = db.all<{ name: string }>('PRAGMA table_info(stock_adjustments)')
    expect(columns.map((column) => column.name)).not.toContain('receipt_item_id')
    expect(db.all('SELECT version FROM schema_migrations')).toEqual([{ version: 1 }])
  })
})

describe('0002_stock_adjustment_receipt_item: the receipt line of a correction', () => {
  let db: Db
  let m: Masters
  let d: Documents
  let otherLineId: number
  let otherReceiptLineId: number

  beforeEach(async () => {
    db = await createSchemaDatabase(temp)
    m = insertMasters(db)
    d = insertDocuments(db, m)
    // The same receipt also holds Sugar; another receipt holds Tea.
    otherLineId = insertRow(
      db,
      'stock_receipt_items',
      rows.receiptItem(m, d.receiptId, {
        line_no: 2,
        product_id: m.otherProductId,
        unit_id: m.otherPieceId,
        unit_name: 'Piece',
        unit_base_qty: 1,
        quantity: 5,
        qty_base: 5,
        unit_cost_minor: 100,
        line_cost_minor: 500
      })
    )
    const otherReceipt = insertRow(
      db,
      'stock_receipts',
      rows.receipt({ receipt_no: 'GRN-000002', request_id: 'receipt-request-2' })
    )
    otherReceiptLineId = insertRow(db, 'stock_receipt_items', rows.receiptItem(m, otherReceipt))
  })

  const correction = (overrides: Record<string, SqlValue>): Record<string, SqlValue> =>
    rows.adjustment(m, {
      adjustment_no: 'ADJ-000009',
      request_id: 'adjustment-request-9',
      reason_code: 'RECEIPT_QTY_CORRECTION',
      direction: 'IN',
      receipt_id: d.receiptId,
      receipt_item_id: d.receiptItemId,
      ...overrides
    })

  it('adds a nullable INTEGER column with an ON DELETE RESTRICT foreign key and an index', () => {
    const column = db
      .all<{ name: string; type: string; notnull: number }>('PRAGMA table_info(stock_adjustments)')
      .find((row) => row.name === 'receipt_item_id')
    expect(column).toMatchObject({ type: 'INTEGER', notnull: 0 })
    expect(
      db
        .all<{ from: string; table: string; to: string; on_delete: string }>(
          'PRAGMA foreign_key_list(stock_adjustments)'
        )
        .filter((key) => key.from === 'receipt_item_id')
        .map(({ table, to, on_delete }) => ({ table, to, on_delete }))
    ).toEqual([{ table: 'stock_receipt_items', to: 'id', on_delete: 'RESTRICT' }])
    expect(
      db.get("SELECT name FROM sqlite_schema WHERE name = 'idx_stock_adjustments_receipt_item'")
    ).toBeDefined()
  })

  it('accepts a quantity or cost correction naming a line of its receipt for the same product', () => {
    expect(insertCode(db, correction({}))).toBeUndefined()
    expect(
      insertCode(
        db,
        correction({
          adjustment_no: 'ADJ-000010',
          request_id: 'adjustment-request-10',
          reason_code: 'RECEIPT_COST_CORRECTION',
          direction: 'VALUE',
          unit_id: null,
          unit_name: null,
          unit_base_qty: null,
          quantity: null,
          qty_base: 0,
          value_minor: 1200
        })
      )
    ).toBeUndefined()
  })

  it('refuses a receipt correction without a line, with a line of another receipt, or of another product', () => {
    expect(insertCode(db, correction({ receipt_item_id: null }))).toBe(TRIGGER)
    expect(insertCode(db, correction({ receipt_item_id: otherReceiptLineId }))).toBe(TRIGGER)
    expect(insertCode(db, correction({ receipt_item_id: otherLineId }))).toBe(TRIGGER)
    expect(insertCode(db, correction({ receipt_item_id: 9999 }))).toBe(TRIGGER)
  })

  it('refuses a receipt line on any other adjustment', () => {
    expect(
      insertCode(
        db,
        rows.adjustment(m, {
          adjustment_no: 'ADJ-000011',
          request_id: 'adjustment-request-11',
          receipt_item_id: d.receiptItemId
        })
      )
    ).toBe(TRIGGER)
  })

  it('keeps stock_adjustments and stock_receipt_items append-only', () => {
    insertRow(db, 'stock_adjustments', correction({}))
    expect(codeOf(db, 'UPDATE stock_adjustments SET receipt_item_id = NULL')).toBe(TRIGGER)
    expect(codeOf(db, 'DELETE FROM stock_adjustments')).toBe(TRIGGER)
    expect(codeOf(db, 'DELETE FROM stock_receipt_items WHERE id = ?', [d.receiptItemId])).toBe(
      TRIGGER
    )
  })
})
