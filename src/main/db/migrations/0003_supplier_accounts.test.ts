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
import { stockAdjustmentReceiptItemMigration } from './0002_stock_adjustment_receipt_item'
import { SUPPLIER_ACCOUNTS_SQL, supplierAccountsMigration } from './0003_supplier_accounts'
import { migrations } from './index'

const TRIGGER = 'SQLITE_CONSTRAINT_TRIGGER'
const CHECK = 'SQLITE_CONSTRAINT_CHECK'
const UNIQUE = 'SQLITE_CONSTRAINT_UNIQUE'
const SCHEMA_TWO = [initialMigration, stockAdjustmentReceiptItemMigration]

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

function insertCode(db: Db, table: string, row: Record<string, SqlValue>): string | undefined {
  try {
    insertRow(db, table, row)
    return undefined
  } catch (error) {
    return sqliteErrorCode(error)
  }
}

/** Every user table and its rows, for comparing a database before and after the migration. */
function snapshot(db: Db): Record<string, unknown[]> {
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .map((row) => row.name)
  return Object.fromEntries(
    tables.map((table) => [table, db.all(`SELECT * FROM "${table}" ORDER BY rowid`)])
  )
}

/** A schema 2 database (0001 + 0002) holding master data, one document of each kind and two old receipts, closed. */
async function schemaTwoDatabase(): Promise<void> {
  const db = await initializeDatabase(testContext(temp, { migrations: SCHEMA_TWO }))
  try {
    const m = insertMasters(db)
    insertDocuments(db, m)
    // Phase 6 receipts: one with a free-text supplier, one without.
    insertRow(
      db,
      'stock_receipts',
      rows.receipt({
        receipt_no: 'GRN-000002',
        request_id: 'receipt-request-2',
        supplier_name: 'Old Traders'
      })
    )
    insertRow(
      db,
      'stock_receipts',
      rows.receipt({
        receipt_no: 'GRN-000003',
        request_id: 'receipt-request-3',
        supplier_name: null
      })
    )
    insertRow(db, 'customer_ledger', rows.ledger(m))
    insertRow(db, 'expenses', rows.expense(m))
    db.run("UPDATE sequences SET next_value = 4 WHERE name = 'receipt'")
  } finally {
    db.close()
  }
}

describe('0003_supplier_accounts: definition', () => {
  it('is schema version 3, registered after 0002', () => {
    expect(supplierAccountsMigration.version).toBe(3)
    expect(supplierAccountsMigration.name).toBe('0003_supplier_accounts')
    expect(migrations).toEqual([
      initialMigration,
      stockAdjustmentReceiptItemMigration,
      supplierAccountsMigration
    ])
  })

  it('pins the SHA-256 checksum of its SQL script, with LF line endings and no floating-point types', () => {
    expect(supplierAccountsMigration.checksum).toBe(sqlChecksum(SUPPLIER_ACCOUNTS_SQL))
    expect(SUPPLIER_ACCOUNTS_SQL).not.toContain('\r')
    expect(SUPPLIER_ACCOUNTS_SQL).not.toMatch(/\b(REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL)\b/i)
  })

  it('leaves the checksums of 0001 and 0002 unchanged', () => {
    expect(initialMigration.checksum).toBe(
      'sha256:0cc4eb9837b99f71442ed9e8bbd48723f869bcbc8fb2f4d8b0dcd90bee576cc4'
    )
    expect(stockAdjustmentReceiptItemMigration.checksum).toBe(
      'sha256:fb50cb92d9de9f5d2e41866ea02f9192bd5416f2284e33e1e4a7483f6c4a442d'
    )
  })

  it('only adds: it never drops, renames or rewrites anything of 0001 or 0002', () => {
    expect(SUPPLIER_ACCOUNTS_SQL).not.toMatch(/\b(DROP|RENAME)\b/i)
    expect(SUPPLIER_ACCOUNTS_SQL).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i)
    expect(SUPPLIER_ACCOUNTS_SQL).not.toMatch(/\bDELETE\s+FROM\b/i)
    const created = [...SUPPLIER_ACCOUNTS_SQL.matchAll(/CREATE TABLE (\w+)/g)].map(
      (match) => match[1]
    )
    expect(created).toEqual(['suppliers', 'supplier_payments', 'supplier_ledger'])
    // The only rows it writes are the two new sequences.
    const inserts = [...SUPPLIER_ACCOUNTS_SQL.matchAll(/INSERT INTO (\w+)/g)].map(
      (match) => match[1]
    )
    expect(inserts).toEqual(['sequences'])
  })
})

describe('0003_supplier_accounts: upgrading a schema 2 database', () => {
  it('makes a verified pre-migration backup, then migrates 2 → 3 keeping every row and every older checksum', async () => {
    await schemaTwoDatabase()
    const before = openDatabase(testContext(temp).paths.databaseFile)
    const tablesBefore = snapshot(before)
    before.close()

    const ctx = testContext(temp, { now: () => TEST_TIME })
    const db = temp.track(await initializeDatabase(ctx))

    expect(readUserVersion(db)).toBe(3)
    expect(
      db.all('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    ).toEqual([
      { version: 1, name: '0001_initial', checksum: initialMigration.checksum },
      {
        version: 2,
        name: '0002_stock_adjustment_receipt_item',
        checksum: stockAdjustmentReceiptItemMigration.checksum
      },
      { version: 3, name: '0003_supplier_accounts', checksum: supplierAccountsMigration.checksum }
    ])

    const after = snapshot(db)
    for (const [table, before] of Object.entries(tablesBefore)) {
      if (table === 'schema_migrations') continue
      if (table === 'sequences') {
        expect(after.sequences.slice(0, before.length)).toEqual(before)
        continue
      }
      if (table === 'stock_receipts') {
        const receipts = after.stock_receipts as Array<Record<string, unknown>>
        expect(
          receipts.map((row) =>
            Object.fromEntries(
              Object.entries(row).filter(
                ([column]) => column !== 'supplier_id' && column !== 'supplier_bill_no'
              )
            )
          )
        ).toEqual(before)
        continue
      }
      expect(after[table], table).toEqual(before)
    }

    // Old receipts keep their free-text supplier name and are linked to no supplier account.
    expect(
      db.all(
        'SELECT receipt_no, supplier_name, supplier_id, supplier_bill_no FROM stock_receipts ORDER BY id'
      )
    ).toEqual([
      {
        receipt_no: 'GRN-000001',
        supplier_name: 'Acme Distributor',
        supplier_id: null,
        supplier_bill_no: null
      },
      {
        receipt_no: 'GRN-000002',
        supplier_name: 'Old Traders',
        supplier_id: null,
        supplier_bill_no: null
      },
      { receipt_no: 'GRN-000003', supplier_name: null, supplier_id: null, supplier_bill_no: null }
    ])
    // Nothing is invented from them.
    expect(after.suppliers).toEqual([])
    expect(after.supplier_ledger).toEqual([])
    expect(after.supplier_payments).toEqual([])
    expect(db.all('SELECT name, next_value FROM sequences ORDER BY name')).toEqual([
      { name: 'adjustment', next_value: 1 },
      { name: 'customer', next_value: 2 },
      { name: 'invoice', next_value: 1 },
      { name: 'payment', next_value: 1 },
      { name: 'receipt', next_value: 4 },
      { name: 'supplier', next_value: 1 },
      { name: 'supplier_payment', next_value: 1 }
    ])
    expect(db.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])

    const folder = backupFolder(ctx.paths, 'pre-migration')
    const backups = readdirSync(folder).filter((name) => name.endsWith('.db'))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/_s2\.db$/)
    expect(verifyDatabaseFile(join(folder, backups[0])).schemaVersion).toBe(2)
    // The backup is made before anything is migrated.
    const messages = ctx.log.entries.map((entry) => entry.message)
    expect(messages.indexOf('[migrate] verified pre-migration backup made')).toBeLessThan(
      messages.indexOf('[migrate] schema migrated')
    )
  })

  it('creates the supplier tables, indexes, view and triggers', async () => {
    const db = await createSchemaDatabase(temp)
    const names = (type: string): string[] =>
      db
        .all<{ name: string }>(
          `SELECT name FROM sqlite_schema
           WHERE type = ? AND name LIKE '%supplier%' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name`,
          [type]
        )
        .map((row) => row.name)
    expect(names('table')).toEqual(['supplier_ledger', 'supplier_payments', 'suppliers'])
    expect(names('view')).toEqual(['v_supplier_balance'])
    expect(names('index')).toEqual([
      'idx_stock_receipts_supplier_date',
      'idx_supplier_ledger_date',
      'idx_supplier_ledger_supplier_date',
      'idx_supplier_payments_date',
      'idx_supplier_payments_receipt',
      'idx_supplier_payments_supplier_date',
      'idx_suppliers_city',
      'idx_suppliers_contact',
      'idx_suppliers_name',
      'idx_suppliers_phone',
      'ux_supplier_ledger_opening',
      'ux_supplier_ledger_payment',
      'ux_supplier_ledger_receipt'
    ])
    expect(names('trigger')).toEqual([
      'trg_stock_receipts_supplier_guard',
      'trg_stock_receipts_supplier_snapshot',
      'trg_supplier_ledger_no_delete',
      'trg_supplier_ledger_no_update',
      'trg_supplier_ledger_source',
      'trg_supplier_payments_guard_update',
      'trg_supplier_payments_no_delete',
      'trg_supplier_payments_receipt'
    ])
    const receiptColumns = db
      .all<{ name: string; type: string; notnull: number }>('PRAGMA table_info(stock_receipts)')
      .filter((column) => column.name.startsWith('supplier'))
    expect(receiptColumns.map(({ name, type, notnull }) => ({ name, type, notnull }))).toEqual([
      { name: 'supplier_name', type: 'TEXT', notnull: 0 },
      { name: 'supplier_id', type: 'INTEGER', notnull: 0 },
      { name: 'supplier_bill_no', type: 'TEXT', notnull: 0 }
    ])
    expect(
      db
        .all<{ from: string; table: string; on_delete: string }>(
          'PRAGMA foreign_key_list(stock_receipts)'
        )
        .filter((key) => key.from === 'supplier_id')
        .map(({ table, on_delete }) => ({ table, on_delete }))
    ).toEqual([{ table: 'suppliers', on_delete: 'RESTRICT' }])
  })

  it('is idempotent: a second launch migrates nothing and makes no second backup', async () => {
    await schemaTwoDatabase()
    const first = await initializeDatabase(testContext(temp))
    const rowsAfterFirst = snapshot(first)
    first.close()
    const ctx = testContext(temp)
    const db = temp.track(await initializeDatabase(ctx))
    expect(readUserVersion(db)).toBe(3)
    expect(snapshot(db)).toEqual(rowsAfterFirst)
    expect(ctx.log.entries.map((entry) => entry.message)).not.toContain('[migrate] schema migrated')
    const folder = backupFolder(ctx.paths, 'pre-migration')
    expect(readdirSync(folder).filter((name) => name.endsWith('.db'))).toHaveLength(1)
  })

  it('migrates a new database from schema 0 straight to 3 without a backup', async () => {
    const ctx = testContext(temp)
    const db = await createSchemaDatabase(temp)
    expect(readUserVersion(db)).toBe(3)
    const folder = backupFolder(ctx.paths, 'pre-migration')
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([])
  })

  it('applies atomically: a failure late in 0003 leaves schema 2 exactly as it was', async () => {
    await schemaTwoDatabase()
    const raw = openDatabase(testContext(temp).paths.databaseFile)
    // An object 0003 creates near its end already exists, so 0003 fails after its ALTER TABLE statements.
    raw.exec('CREATE VIEW v_supplier_balance AS SELECT 1 AS supplier_id')
    const before = snapshot(raw)
    raw.close()

    await expect(initializeDatabase(testContext(temp))).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      version: 3
    })
    const db = temp.track(openDatabase(testContext(temp).paths.databaseFile))
    expect(readUserVersion(db)).toBe(2)
    expect(snapshot(db)).toEqual(before)
    const columns = db.all<{ name: string }>('PRAGMA table_info(stock_receipts)')
    expect(columns.map((column) => column.name)).not.toContain('supplier_id')
    expect(db.get("SELECT name FROM sqlite_schema WHERE name = 'suppliers'")).toBeUndefined()
    expect(db.all('SELECT version FROM schema_migrations ORDER BY version')).toEqual([
      { version: 1 },
      { version: 2 }
    ])
  })
})

describe('0003_supplier_accounts: constraints', () => {
  let db: Db
  let m: Masters
  let d: Documents
  let supplierId: number
  let otherSupplierId: number
  let receiptId: number

  beforeEach(async () => {
    db = await createSchemaDatabase(temp)
    m = insertMasters(db)
    d = insertDocuments(db, m)
    supplierId = insertRow(db, 'suppliers', { code: 'SUP-00001', name: 'ABC Distributors' })
    otherSupplierId = insertRow(db, 'suppliers', { code: 'SUP-00002', name: 'ABC Distributors' })
    receiptId = insertRow(
      db,
      'stock_receipts',
      rows.receipt({
        receipt_no: 'GRN-000002',
        request_id: 'receipt-request-2',
        supplier_id: supplierId,
        supplier_name: 'ABC Distributors',
        supplier_bill_no: 'ABC-101'
      })
    )
  })

  const payment = (overrides: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
    payment_no: 'SPAY-000001',
    request_id: 'supplier-payment-1',
    supplier_id: supplierId,
    payment_date: '2026-09-01',
    amount_minor: 20000,
    method: 'CASH',
    ...overrides
  })

  const entry = (overrides: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
    supplier_id: supplierId,
    entry_date: '2026-09-01',
    type: 'ADJUSTMENT',
    amount_minor: 5000,
    note: 'Bill corrected',
    ...overrides
  })

  it('allows repeated supplier names but not a repeated code', () => {
    expect(
      insertCode(db, 'suppliers', { code: 'SUP-00003', name: 'ABC Distributors' })
    ).toBeUndefined()
    expect(insertCode(db, 'suppliers', { code: 'sup-00001', name: 'Other' })).toBe(UNIQUE)
    expect(insertCode(db, 'suppliers', { code: ' ', name: 'Other' })).toBe(CHECK)
  })

  it('checks the sign and references of every ledger entry type', () => {
    const paymentId = insertRow(db, 'supplier_payments', payment())
    // The right shapes.
    expect(
      insertCode(db, 'supplier_ledger', entry({ type: 'OPENING', amount_minor: -100, note: null }))
    ).toBeUndefined()
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({ type: 'PURCHASE', amount_minor: 480000, stock_receipt_id: receiptId, note: null })
      )
    ).toBeUndefined()
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({ type: 'PAYMENT', amount_minor: -20000, supplier_payment_id: paymentId, note: null })
      )
    ).toBeUndefined()
    expect(insertCode(db, 'supplier_ledger', entry())).toBeUndefined()
    expect(insertCode(db, 'supplier_ledger', entry({ amount_minor: -5000 }))).toBeUndefined()
    // Wrong signs.
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({
          type: 'PURCHASE_VOID',
          amount_minor: 480000,
          stock_receipt_id: receiptId,
          note: null
        })
      )
    ).toBe(CHECK)
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({
          type: 'PAYMENT_VOID',
          amount_minor: -20000,
          supplier_payment_id: paymentId,
          note: null
        })
      )
    ).toBe(CHECK)
    expect(insertCode(db, 'supplier_ledger', entry({ amount_minor: 0 }))).toBe(CHECK)
    // Wrong references.
    expect(
      insertCode(db, 'supplier_ledger', entry({ type: 'PURCHASE_VOID', amount_minor: -480000 }))
    ).toBe(CHECK)
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({
          type: 'PAYMENT_VOID',
          amount_minor: 20000,
          supplier_payment_id: paymentId,
          stock_receipt_id: receiptId
        })
      )
    ).toBe(CHECK)
    expect(insertCode(db, 'supplier_ledger', entry({ stock_receipt_id: receiptId }))).toBe(CHECK)
    // An adjustment needs its reason.
    expect(insertCode(db, 'supplier_ledger', entry({ note: '  ' }))).toBe(CHECK)
  })

  it('allows one entry of each kind per receipt or payment, and one opening balance per supplier', () => {
    const paymentId = insertRow(db, 'supplier_payments', payment())
    insertRow(db, 'supplier_ledger', entry({ type: 'OPENING', amount_minor: 1000, note: null }))
    insertRow(
      db,
      'supplier_ledger',
      entry({ type: 'PURCHASE', amount_minor: 480000, stock_receipt_id: receiptId, note: null })
    )
    insertRow(
      db,
      'supplier_ledger',
      entry({ type: 'PAYMENT', amount_minor: -20000, supplier_payment_id: paymentId, note: null })
    )
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({ type: 'PURCHASE', amount_minor: 480000, stock_receipt_id: receiptId, note: null })
      )
    ).toBe(UNIQUE)
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({ type: 'PAYMENT', amount_minor: -20000, supplier_payment_id: paymentId, note: null })
      )
    ).toBe(UNIQUE)
    // PURCHASE_VOID and PAYMENT_VOID once each.
    insertRow(
      db,
      'supplier_ledger',
      entry({
        type: 'PURCHASE_VOID',
        amount_minor: -480000,
        stock_receipt_id: receiptId,
        note: null
      })
    )
    insertRow(
      db,
      'supplier_ledger',
      entry({
        type: 'PAYMENT_VOID',
        amount_minor: 20000,
        supplier_payment_id: paymentId,
        note: null
      })
    )
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({
          type: 'PURCHASE_VOID',
          amount_minor: -480000,
          stock_receipt_id: receiptId,
          note: null
        })
      )
    ).toBe(UNIQUE)
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({
          type: 'PAYMENT_VOID',
          amount_minor: 20000,
          supplier_payment_id: paymentId,
          note: null
        })
      )
    ).toBe(UNIQUE)
  })

  it('accepts an opening balance only as the supplier’s first entry', () => {
    insertRow(db, 'supplier_ledger', entry())
    expect(insertCode(db, 'supplier_ledger', entry({ type: 'OPENING', note: null }))).toBe(TRIGGER)
    // Another supplier's history does not count.
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({ supplier_id: otherSupplierId, type: 'OPENING', note: null })
      )
    ).toBeUndefined()
  })

  it('refuses a receipt or payment entry on another supplier, or for a receipt without a supplier', () => {
    const paymentId = insertRow(db, 'supplier_payments', payment())
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({
          supplier_id: otherSupplierId,
          type: 'PURCHASE',
          amount_minor: 480000,
          stock_receipt_id: receiptId,
          note: null
        })
      )
    ).toBe(TRIGGER)
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({
          supplier_id: otherSupplierId,
          type: 'PAYMENT',
          amount_minor: -20000,
          supplier_payment_id: paymentId,
          note: null
        })
      )
    ).toBe(TRIGGER)
    // d.receiptId is an old receipt without a supplier account.
    expect(
      insertCode(
        db,
        'supplier_ledger',
        entry({ type: 'PURCHASE', amount_minor: 480000, stock_receipt_id: d.receiptId, note: null })
      )
    ).toBe(TRIGGER)
  })

  it('keeps supplier_ledger append-only', () => {
    insertRow(db, 'supplier_ledger', entry())
    expect(codeOf(db, 'UPDATE supplier_ledger SET amount_minor = 1')).toBe(TRIGGER)
    expect(codeOf(db, 'DELETE FROM supplier_ledger')).toBe(TRIGGER)
  })

  it('lets a saved supplier payment change only from POSTED to VOID, and never be deleted', () => {
    const paymentId = insertRow(db, 'supplier_payments', payment())
    expect(
      codeOf(db, 'UPDATE supplier_payments SET amount_minor = 1 WHERE id = ?', [paymentId])
    ).toBe(TRIGGER)
    expect(
      codeOf(db, 'UPDATE supplier_payments SET reference = ? WHERE id = ?', ['X', paymentId])
    ).toBe(TRIGGER)
    expect(
      codeOf(db, "UPDATE supplier_payments SET status = 'VOID' WHERE id = ?", [paymentId])
    ).toBe(CHECK)
    expect(
      codeOf(
        db,
        "UPDATE supplier_payments SET status = 'VOID', void_reason = 'Wrong', voided_at = '2026-09-02T10:00:00.000Z', void_date = '2026-09-02' WHERE id = ?",
        [paymentId]
      )
    ).toBeUndefined()
    expect(
      codeOf(
        db,
        "UPDATE supplier_payments SET status = 'POSTED', void_reason = NULL, voided_at = NULL, void_date = NULL WHERE id = ?",
        [paymentId]
      )
    ).toBe(TRIGGER)
    expect(codeOf(db, 'DELETE FROM supplier_payments')).toBe(TRIGGER)
  })

  it('checks each supplier payment field', () => {
    expect(insertCode(db, 'supplier_payments', payment({ amount_minor: 0 }))).toBe(CHECK)
    expect(insertCode(db, 'supplier_payments', payment({ method: 'CARD' }))).toBe(CHECK)
    expect(insertCode(db, 'supplier_payments', payment({ payment_date: '2026-02-30' }))).toBe(CHECK)
    insertRow(db, 'supplier_payments', payment())
    expect(insertCode(db, 'supplier_payments', payment({ request_id: 'supplier-payment-2' }))).toBe(
      UNIQUE
    )
    expect(insertCode(db, 'supplier_payments', payment({ payment_no: 'SPAY-000002' }))).toBe(UNIQUE)
  })

  it('lets a payment name only a receipt of its own supplier', () => {
    expect(
      insertCode(db, 'supplier_payments', payment({ stock_receipt_id: receiptId }))
    ).toBeUndefined()
    expect(
      insertCode(
        db,
        'supplier_payments',
        payment({
          payment_no: 'SPAY-000002',
          request_id: 'supplier-payment-2',
          supplier_id: otherSupplierId,
          stock_receipt_id: receiptId
        })
      )
    ).toBe(TRIGGER)
    expect(
      insertCode(
        db,
        'supplier_payments',
        payment({
          payment_no: 'SPAY-000003',
          request_id: 'supplier-payment-3',
          stock_receipt_id: d.receiptId
        })
      )
    ).toBe(TRIGGER)
  })

  it('fixes the supplier account and bill number of a saved receipt, and still lets it be voided', () => {
    expect(
      codeOf(db, 'UPDATE stock_receipts SET supplier_id = ? WHERE id = ?', [
        otherSupplierId,
        receiptId
      ])
    ).toBe(TRIGGER)
    expect(
      codeOf(db, 'UPDATE stock_receipts SET supplier_id = NULL WHERE id = ?', [receiptId])
    ).toBe(TRIGGER)
    expect(
      codeOf(db, "UPDATE stock_receipts SET supplier_bill_no = 'X' WHERE id = ?", [receiptId])
    ).toBe(TRIGGER)
    // An old receipt cannot be linked afterwards either.
    expect(
      codeOf(db, 'UPDATE stock_receipts SET supplier_id = ? WHERE id = ?', [
        supplierId,
        d.receiptId
      ])
    ).toBe(TRIGGER)
    expect(
      codeOf(db, 'UPDATE stock_receipts SET supplier_name = ? WHERE id = ?', [
        'New name',
        receiptId
      ])
    ).toBe(TRIGGER)
    expect(
      codeOf(
        db,
        "UPDATE stock_receipts SET status = 'VOID', void_reason = 'Wrong', void_date = '2026-09-02' WHERE id = ?",
        [receiptId]
      )
    ).toBeUndefined()
  })

  it('requires a supplier-linked receipt to keep the supplier name', () => {
    expect(
      insertCode(
        db,
        'stock_receipts',
        rows.receipt({
          receipt_no: 'GRN-000009',
          request_id: 'receipt-request-9',
          supplier_id: supplierId,
          supplier_name: null
        })
      )
    ).toBe(TRIGGER)
  })

  it('computes v_supplier_balance from the ledger, with zero for a supplier without history', () => {
    insertRow(db, 'supplier_ledger', entry({ type: 'OPENING', amount_minor: 1000000, note: null }))
    insertRow(
      db,
      'supplier_ledger',
      entry({ type: 'PURCHASE', amount_minor: 480000, stock_receipt_id: receiptId, note: null })
    )
    insertRow(db, 'supplier_ledger', entry({ amount_minor: -80000 }))
    expect(
      db.all('SELECT supplier_id, balance_minor FROM v_supplier_balance ORDER BY supplier_id')
    ).toEqual([
      { supplier_id: supplierId, balance_minor: 1400000 },
      { supplier_id: otherSupplierId, balance_minor: 0 }
    ])
  })
})
