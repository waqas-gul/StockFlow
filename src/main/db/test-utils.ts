// Test-only helpers for the database tests. Excluded from coverage and never imported by application code.
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sqliteErrorCode, type Db, type SqlValue } from './adapter'
import { initializeDatabase } from './index'

export interface TempDir {
  readonly path: string
  file(name: string): string
  /** Closes every tracked database, then deletes the directory (Windows cannot delete open files). */
  remove(): void
  /** Registers a database to be closed by `remove()`. */
  track<T extends Db>(db: T): T
}

/** A fresh folder under the OS temp directory. Tests never touch %APPDATA%\StockFlow or StockFlow-dev. */
export function createTempDir(): TempDir {
  const path = mkdtempSync(join(tmpdir(), 'stockflow-test-'))
  const opened: Db[] = []
  return {
    path,
    file: (name) => join(path, name),
    track: (db) => {
      opened.push(db)
      return db
    },
    remove: () => {
      for (const db of opened.splice(0)) db.close()
      rmSync(path, { recursive: true, force: true })
    }
  }
}

/** The error thrown by `fn`. Fails the test if nothing is thrown. */
export function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('Expected the function to throw.')
}

/** The SQLite result code (e.g. `SQLITE_CONSTRAINT_CHECK`) of the error thrown by `fn`. */
export function sqliteCodeOf(fn: () => unknown): string | undefined {
  return sqliteErrorCode(thrown(fn))
}

// --- Schema fixtures (technical test data; never seeded into a real database) ---

export const TEST_APP_VERSION = '1.0.0-test'

/**
 * How migration checksums are generated: SHA-256 over the UTF-8 bytes of the migration's SQL script, written
 * as `sha256:` + 64 lowercase hex digits. Production code never computes it: each migration pins its value.
 */
export function sqlChecksum(sql: string): string {
  return `sha256:${createHash('sha256').update(sql, 'utf8').digest('hex')}`
}

/** A new database migrated to the latest schema, exactly as the app creates it on first start. */
export async function createSchemaDatabase(temp: TempDir, name = 'shop.db'): Promise<Db> {
  return temp.track(await initializeDatabase(temp.file(name), { appVersion: TEST_APP_VERSION }))
}

export type Row = Record<string, SqlValue>

/** Inserts one row and returns its id. Table and column names come from test code only. */
export function insertRow(db: Db, table: string, row: Row): number {
  const columns = Object.keys(row)
  const placeholders = columns.map((column) => `@${column}`).join(', ')
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`
  return Number(db.run(sql, row).lastInsertRowid)
}

/** Master data for the schema tests: one company, two products with units, one customer. */
export interface Masters {
  readonly companyId: number
  /** Tea: Piece (base, 1) and Box (24). */
  readonly productId: number
  readonly pieceId: number
  readonly boxId: number
  /** Sugar: a single base unit. */
  readonly otherProductId: number
  readonly otherPieceId: number
  readonly customerId: number
  /** The seeded "Shop Expenses" category. */
  readonly categoryId: number
}

/** Valid rows for every table. Each test overrides the one value it is about. */
export const rows = {
  unit: (productId: number, overrides: Row = {}): Row => ({
    product_id: productId,
    name: 'Piece',
    short_name: 'Pcs',
    base_qty: 1,
    is_base: 1,
    wholesale_price_minor: 10000,
    retail_price_minor: 11000,
    default_cost_minor: 9000,
    ...overrides
  }),
  // Consistent with invoiceItem + quantities: 1 Box + 1 Pcs, 5% discount, a scheme of 2 free pieces.
  invoice: (m: Masters, overrides: Row = {}): Row => ({
    invoice_no: 'INV-000001',
    seq_no: 1,
    request_id: 'invoice-request-1',
    invoice_date: '2026-09-10',
    customer_id: m.customerId,
    cust_name: 'Ali',
    cust_shop_name: 'Ali Traders',
    cust_phone: '0300-1234567',
    cust_address: 'Main Bazar',
    cust_city: 'Lahore',
    price_tier: 'WHOLESALE',
    gross_minor: 250000,
    line_discount_minor: 12500,
    line_scheme_minor: 2500,
    extra_discount_minor: 5000,
    net_minor: 230000,
    freight_minor: 3000,
    total_minor: 233000,
    received_minor: 50000,
    previous_balance_minor: 10000,
    net_outstanding_minor: 193000,
    cogs_minor: 200000,
    ...overrides
  }),
  invoiceItem: (m: Masters, invoiceId: number, overrides: Row = {}): Row => ({
    invoice_id: invoiceId,
    line_no: 1,
    product_id: m.productId,
    prod_code: 'P-001',
    prod_name: 'Tea 950g',
    company_name: 'Acme Foods',
    packing_label: '1*12*18',
    qty_base: 27,
    scheme_qty_base: 2,
    gross_minor: 250000,
    discount_bps: 500,
    discount_minor: 12500,
    scheme_minor: 2500,
    ctn_count: 1,
    net_minor: 235000,
    cost_minor: 200000,
    ...overrides
  }),
  quantity: (invoiceItemId: number, unitId: number, overrides: Row = {}): Row => ({
    invoice_item_id: invoiceItemId,
    unit_id: unitId,
    unit_name: 'Box',
    unit_short_name: 'Box',
    unit_base_qty: 24,
    quantity: 1,
    unit_price_minor: 240000,
    amount_minor: 240000,
    qty_base: 24,
    ...overrides
  }),
  receipt: (overrides: Row = {}): Row => ({
    receipt_no: 'GRN-000001',
    request_id: 'receipt-request-1',
    receipt_date: '2026-09-01',
    supplier_name: 'Acme Distributor',
    reference: 'Bill 77',
    total_cost_minor: 480000,
    ...overrides
  }),
  receiptItem: (m: Masters, receiptId: number, overrides: Row = {}): Row => ({
    receipt_id: receiptId,
    line_no: 1,
    product_id: m.productId,
    unit_id: m.boxId,
    unit_name: 'Box',
    unit_base_qty: 24,
    quantity: 2,
    qty_base: 48,
    unit_cost_minor: 240000,
    line_cost_minor: 480000,
    ...overrides
  }),
  adjustment: (m: Masters, overrides: Row = {}): Row => ({
    adjustment_no: 'ADJ-000001',
    request_id: 'adjustment-request-1',
    adjustment_date: '2026-09-02',
    product_id: m.productId,
    reason_code: 'DAMAGE',
    direction: 'OUT',
    unit_id: m.pieceId,
    unit_name: 'Piece',
    unit_base_qty: 1,
    quantity: 3,
    qty_base: 3,
    value_minor: 27000,
    reason_note: 'Water damage',
    ...overrides
  }),
  movement: (m: Masters, overrides: Row = {}): Row => ({
    product_id: m.productId,
    movement_date: '2026-09-01',
    type: 'STOCK_IN',
    qty_base: 48,
    value_minor: 480000,
    ...overrides
  }),
  payment: (m: Masters, overrides: Row = {}): Row => ({
    payment_no: 'RCP-000001',
    request_id: 'payment-request-1',
    customer_id: m.customerId,
    payment_date: '2026-09-10',
    amount_minor: 50000,
    method: 'CASH',
    ...overrides
  }),
  ledger: (m: Masters, overrides: Row = {}): Row => ({
    customer_id: m.customerId,
    entry_date: '2026-09-10',
    type: 'OPENING',
    amount_minor: 10000,
    ...overrides
  }),
  expense: (m: Masters, overrides: Row = {}): Row => ({
    request_id: 'expense-request-1',
    expense_date: '2026-09-10',
    category_id: m.categoryId,
    amount_minor: 1500,
    description: 'Tea for the shop',
    ...overrides
  })
}

export function insertMasters(db: Db): Masters {
  const companyId = insertRow(db, 'companies', { name: 'Acme Foods' })
  const productId = insertRow(db, 'products', {
    code: 'P-001',
    name: 'Tea 950g',
    company_id: companyId,
    packing_label: '1*12*18'
  })
  const pieceId = insertRow(db, 'product_units', rows.unit(productId))
  const boxId = insertRow(
    db,
    'product_units',
    rows.unit(productId, {
      name: 'Box',
      short_name: 'Box',
      base_qty: 24,
      is_base: 0,
      wholesale_price_minor: 240000,
      retail_price_minor: 250000,
      default_cost_minor: 216000,
      sort_order: 1
    })
  )
  const otherProductId = insertRow(db, 'products', { code: 'P-002', name: 'Sugar 1kg' })
  const otherPieceId = insertRow(db, 'product_units', rows.unit(otherProductId))
  const customerId = insertRow(db, 'customers', {
    code: 'C-00002',
    name: 'Ali',
    shop_name: 'Ali Traders',
    phone: '0300-1234567',
    address: 'Main Bazar',
    city: 'Lahore'
  })
  const category = db.get<{ id: number }>(
    "SELECT id FROM expense_categories WHERE name = 'Shop Expenses'"
  )
  if (!category) throw new Error('The seeded "Shop Expenses" category is missing.')
  return {
    companyId,
    productId,
    pieceId,
    boxId,
    otherProductId,
    otherPieceId,
    customerId,
    categoryId: category.id
  }
}

/** One posted document of each kind, to serve as movement and ledger sources. */
export interface Documents {
  readonly receiptId: number
  readonly receiptItemId: number
  readonly invoiceId: number
  readonly invoiceItemId: number
  readonly adjustmentId: number
  readonly paymentId: number
}

export function insertDocuments(db: Db, m: Masters): Documents {
  const receiptId = insertRow(db, 'stock_receipts', rows.receipt())
  const receiptItemId = insertRow(db, 'stock_receipt_items', rows.receiptItem(m, receiptId))
  const invoiceId = insertRow(db, 'invoices', rows.invoice(m))
  const invoiceItemId = insertRow(db, 'invoice_items', rows.invoiceItem(m, invoiceId))
  insertRow(db, 'invoice_item_quantities', rows.quantity(invoiceItemId, m.boxId))
  insertRow(
    db,
    'invoice_item_quantities',
    rows.quantity(invoiceItemId, m.pieceId, {
      unit_name: 'Piece',
      unit_short_name: 'Pcs',
      unit_base_qty: 1,
      quantity: 1,
      unit_price_minor: 10000,
      amount_minor: 10000,
      qty_base: 1
    })
  )
  const adjustmentId = insertRow(db, 'stock_adjustments', rows.adjustment(m))
  const paymentId = insertRow(db, 'payments', rows.payment(m, { invoice_id: invoiceId }))
  return { receiptId, receiptItemId, invoiceId, invoiceItemId, adjustmentId, paymentId }
}
