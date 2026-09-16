import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../adapter'
import { openDatabase, readUserVersion } from '../connection'
import { recordSchemaMigration } from '../index'
import { migrate } from '../migrate'
import {
  TEST_APP_VERSION,
  createSchemaDatabase,
  createTempDir,
  sqlChecksum,
  testContext,
  type TempDir
} from '../test-utils'
import { INITIAL_SCHEMA_SQL, initialMigration } from './0001_initial'
import { migrations } from './index'

let temp: TempDir

beforeEach(() => {
  temp = createTempDir()
})

afterEach(() => {
  temp.remove()
})

type SchemaObjectType = 'table' | 'view' | 'index' | 'trigger'

/** Names of the schema objects of one type, excluding SQLite's own (sqlite_*). */
function objectNames(db: Db, type: SchemaObjectType): string[] {
  return db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite%'",
      [type]
    )
    .map((row) => row.name)
    .sort()
}

interface ColumnInfo {
  table: string
  name: string
  type: string
}

function columnsOf(db: Db): ColumnInfo[] {
  return objectNames(db, 'table').flatMap((table) =>
    db
      .all<{ name: string; type: string }>(`PRAGMA table_info(${table})`)
      .map((column) => ({ table, name: column.name, type: column.type }))
  )
}

const V1_TABLES = [
  'companies',
  'products',
  'product_units',
  'customers',
  'customer_ledger',
  'invoices',
  'invoice_items',
  'invoice_item_quantities',
  'invoice_change_log',
  'stock_receipts',
  'stock_receipt_items',
  'stock_adjustments',
  'stock_movements',
  'payments',
  'expense_categories',
  'expenses',
  'settings',
  'sequences',
  'schema_migrations'
]

const V1_VIEWS = ['v_customer_balance', 'v_product_stock']

const V1_INDEXES = [
  'idx_products_name',
  'idx_products_company',
  'idx_products_active',
  'ux_product_units_one_base',
  'idx_customers_name',
  'idx_customers_shop_name',
  'idx_customers_phone',
  'idx_customers_city',
  'idx_customer_ledger_customer_date',
  'idx_customer_ledger_date',
  'ux_customer_ledger_invoice',
  'ux_customer_ledger_payment',
  'ux_customer_ledger_opening',
  'idx_invoices_date',
  'idx_invoices_customer_date',
  'idx_invoices_status_date',
  'idx_invoices_invoice_code',
  'idx_invoices_bilty_no',
  'idx_invoice_items_product',
  'idx_invoice_item_quantities_unit',
  'idx_invoice_change_log_invoice',
  'idx_stock_receipts_date',
  'idx_stock_receipt_items_product',
  'idx_stock_receipt_items_unit',
  'idx_stock_adjustments_product',
  'idx_stock_adjustments_date',
  'idx_stock_adjustments_receipt',
  'idx_stock_adjustments_unit',
  'idx_stock_movements_product_id',
  'idx_stock_movements_product_date',
  'idx_stock_movements_date',
  'idx_stock_movements_type_date',
  'ux_stock_movements_receipt_item',
  'ux_stock_movements_invoice_item',
  'ux_stock_movements_adjustment',
  'idx_payments_customer_date',
  'idx_payments_date',
  'idx_payments_invoice',
  'idx_expenses_date',
  'idx_expenses_category_date'
]

/** Append-only and immutable tables: every UPDATE and DELETE is refused. */
const APPEND_ONLY_TABLES = [
  'customer_ledger',
  'stock_movements',
  'invoice_items',
  'invoice_item_quantities',
  'invoice_change_log',
  'stock_receipt_items',
  'stock_adjustments',
  'schema_migrations'
]

const V1_TRIGGERS = [
  ...APPEND_ONLY_TABLES.flatMap((table) => [`trg_${table}_no_update`, `trg_${table}_no_delete`]),
  'trg_invoices_guard_update',
  'trg_invoices_no_delete',
  'trg_payments_guard_update',
  'trg_payments_no_delete',
  'trg_stock_receipts_guard_update',
  'trg_stock_receipts_no_delete',
  'trg_expenses_no_delete'
]

describe('0001_initial: definition', () => {
  it('is schema version 1, registered as the first production migration', () => {
    expect(initialMigration.version).toBe(1)
    expect(initialMigration.name).toBe('0001_initial')
    expect(migrations[0]).toBe(initialMigration)
  })

  it('pins the SHA-256 checksum of its SQL script', () => {
    expect(initialMigration.checksum).toBe(sqlChecksum(INITIAL_SCHEMA_SQL))
  })

  it('is frozen: every shipped migration keeps the checksum it shipped with', () => {
    // Shipped migrations are never edited. A change here means a shipped migration was edited: revert it and
    // put the change in a new migration instead.
    const shipped: Record<number, string> = {
      1: 'sha256:0cc4eb9837b99f71442ed9e8bbd48723f869bcbc8fb2f4d8b0dcd90bee576cc4',
      2: 'sha256:fb50cb92d9de9f5d2e41866ea02f9192bd5416f2284e33e1e4a7483f6c4a442d'
    }
    for (const migration of migrations) {
      expect({ version: migration.version, checksum: migration.checksum }).toEqual({
        version: migration.version,
        checksum: shipped[migration.version]
      })
    }
  })

  it('uses LF line endings only, so the checksum does not depend on how the file was checked out', () => {
    expect(INITIAL_SCHEMA_SQL).not.toContain('\r')
  })

  it('declares no floating-point column types', () => {
    expect(INITIAL_SCHEMA_SQL).not.toMatch(/\b(REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL)\b/i)
  })
})

// These tests look at what 0001 itself creates, on a database migrated with 0001 only (0002 has its own tests).
describe('0001_initial: migrating a new database', () => {
  it('migrates a new StockFlow database from schema 0 to schema 1', async () => {
    const file = testContext(temp).paths.databaseFile
    const fresh = openDatabase(file)
    expect(readUserVersion(fresh)).toBe(0)
    fresh.close()

    const db = await createSchemaDatabase(temp, [initialMigration])
    expect(readUserVersion(db)).toBe(1)
  })

  it('creates exactly the V1 tables, every one of them STRICT', async () => {
    const db = await createSchemaDatabase(temp, [initialMigration])
    expect(objectNames(db, 'table')).toEqual([...V1_TABLES].sort())
    const tables = db.all<{ name: string; strict: number }>(
      "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite%'"
    )
    expect(tables).toHaveLength(V1_TABLES.length)
    expect(tables.filter((table) => table.strict !== 1)).toEqual([])
  })

  it('creates exactly the expected views, indexes and triggers', async () => {
    const db = await createSchemaDatabase(temp, [initialMigration])
    expect(objectNames(db, 'view')).toEqual(V1_VIEWS)
    expect(objectNames(db, 'index')).toEqual([...V1_INDEXES].sort())
    expect(objectNames(db, 'trigger')).toEqual([...V1_TRIGGERS].sort())
  })

  it('stores money, quantities and percentages as INTEGER, and dates and timestamps as TEXT', async () => {
    const columns = columnsOf(await createSchemaDatabase(temp, [initialMigration]))
    const numeric = columns.filter((column) =>
      /(_minor|_bps|_qty|qty_base|_count)$|^(quantity|seq_no|next_value|line_no)$/.test(column.name)
    )
    expect(numeric.length).toBeGreaterThan(40)
    expect(numeric.filter((column) => column.type !== 'INTEGER')).toEqual([])

    const dated = columns.filter((column) => /(_date|_at)$/.test(column.name))
    expect(dated.length).toBeGreaterThan(20)
    expect(dated.filter((column) => column.type !== 'TEXT')).toEqual([])

    expect(columns.filter((column) => !['INTEGER', 'TEXT'].includes(column.type))).toEqual([])
  })

  it('uses ON DELETE RESTRICT for every foreign key, so history is never cascade-deleted', async () => {
    const db = await createSchemaDatabase(temp, [initialMigration])
    const keys = objectNames(db, 'table').flatMap((table) =>
      db
        .all<{ table: string; from: string; on_delete: string }>(
          `PRAGMA foreign_key_list(${table})`
        )
        .map((key) => ({
          child: table,
          column: key.from,
          parent: key.table,
          onDelete: key.on_delete
        }))
    )
    expect(keys.length).toBeGreaterThan(20)
    expect(keys.filter((key) => key.onDelete !== 'RESTRICT')).toEqual([])
  })

  it('leaves a database that passes integrity_check and foreign_key_check', async () => {
    const db = await createSchemaDatabase(temp, [initialMigration])
    expect(db.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])
  })

  it('applies atomically: a failure inside 0001 leaves no object behind and schema 0', async () => {
    const db = temp.track(openDatabase(temp.file('shop.db')))
    // A table 0001 wants to create near the end of its script already exists, so 0001 fails there.
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY) STRICT')
    await expect(
      migrate(db, [initialMigration], {
        backupBeforeMigrating: async () => undefined,
        recordMigration: recordSchemaMigration(TEST_APP_VERSION)
      })
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED', version: 1 })
    expect(readUserVersion(db)).toBe(0)
    expect(objectNames(db, 'table')).toEqual(['settings'])
    expect([
      ...objectNames(db, 'view'),
      ...objectNames(db, 'index'),
      ...objectNames(db, 'trigger')
    ]).toEqual([])
  })

  it('is rolled back completely when recording it in schema_migrations fails', async () => {
    const db = temp.track(openDatabase(temp.file('shop.db')))
    await expect(
      migrate(db, [initialMigration], {
        backupBeforeMigrating: async () => undefined,
        recordMigration: () => {
          throw new Error('could not record')
        }
      })
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED' })
    expect(readUserVersion(db)).toBe(0)
    expect(db.all('SELECT name FROM sqlite_schema')).toEqual([])
  })
})

describe('0001_initial: seed data', () => {
  it('seeds the default settings as JSON values', async () => {
    const db = await createSchemaDatabase(temp, [initialMigration])
    const settings = db.all<{ key: string; value: string; updated_at: string }>(
      'SELECT key, value, updated_at FROM settings ORDER BY key'
    )
    expect(Object.fromEntries(settings.map((row) => [row.key, JSON.parse(row.value)]))).toEqual({
      'backup.autoEnabled': true,
      'backup.keepDaily': 14,
      'backup.keepMonthly': 12,
      'business.name': 'StockFlow',
      'currency.code': 'PKR',
      'currency.minorDigits': 2,
      'currency.symbol': 'Rs',
      'invoice.padding': 6,
      'invoice.paperSize': 'A4',
      'invoice.prefix': 'INV-',
      'invoice.startNumber': 1
    })
    expect(settings.some((row) => /negative/i.test(row.key))).toBe(false)
    expect(
      settings.every((row) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.updated_at))
    ).toBe(true)
  })

  it('seeds the document sequences; the walk-in customer already uses customer number 1', async () => {
    const db = await createSchemaDatabase(temp, [initialMigration])
    expect(db.all('SELECT name, next_value FROM sequences ORDER BY name')).toEqual([
      { name: 'adjustment', next_value: 1 },
      { name: 'customer', next_value: 2 },
      { name: 'invoice', next_value: 1 },
      { name: 'payment', next_value: 1 },
      { name: 'receipt', next_value: 1 }
    ])
  })

  it('seeds the stable "Cash / Walk-in" customer as C-00001', async () => {
    const db = await createSchemaDatabase(temp, [initialMigration])
    expect(db.all('SELECT id, code, name, shop_name, is_active FROM customers')).toEqual([
      { id: 1, code: 'C-00001', name: 'Cash / Walk-in', shop_name: null, is_active: 1 }
    ])
    const next = db.get<{ next_value: number }>(
      "SELECT next_value FROM sequences WHERE name = 'customer'"
    )
    expect(`C-${String(next?.next_value).padStart(5, '0')}`).not.toBe('C-00001')
  })

  it('seeds the expense categories named in the plan, in both groups', async () => {
    const db = await createSchemaDatabase(temp, [initialMigration])
    expect(db.all('SELECT name, grp, is_active FROM expense_categories ORDER BY id')).toEqual([
      { name: 'Shop Expenses', grp: 'SHOP', is_active: 1 },
      { name: 'Monthly / General Expenses', grp: 'GENERAL', is_active: 1 },
      { name: 'Freight Paid', grp: 'SHOP', is_active: 1 },
      { name: 'Purchase Cost Correction', grp: 'GENERAL', is_active: 1 }
    ])
  })

  it('creates no products, stock, invoices, payments, ledger entries or expenses', async () => {
    const db = await createSchemaDatabase(temp, [initialMigration])
    const empty = V1_TABLES.filter(
      (table) =>
        !['settings', 'sequences', 'expense_categories', 'customers', 'schema_migrations'].includes(
          table
        )
    )
    for (const table of empty) {
      expect({
        table,
        rows: db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n
      }).toEqual({
        table,
        rows: 0
      })
    }
  })
})
