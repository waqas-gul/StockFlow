import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteErrorCode, type Db, type SqlValue } from '../adapter'
import {
  createSchemaDatabase,
  createTempDir,
  insertDocuments,
  insertMasters,
  insertRow,
  rows,
  thrown,
  type Documents,
  type Masters,
  type Row,
  type TempDir
} from '../test-utils'
import { initialMigration } from './0001_initial'

// SQLite itself must refuse these changes: the rules do not rely on service code.

const TRIGGER = 'SQLITE_CONSTRAINT_TRIGGER'
const CHECK = 'SQLITE_CONSTRAINT_CHECK'
const TIMESTAMP = '2026-09-11T08:30:00.000Z'

let temp: TempDir
let db: Db
let m: Masters
let d: Documents
let ledgerId: number

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp, [initialMigration])
  m = insertMasters(db)
  d = insertDocuments(db, m)
  insertRow(db, 'stock_movements', rows.movement(m, { receipt_item_id: d.receiptItemId }))
  insertRow(
    db,
    'stock_movements',
    rows.movement(m, {
      movement_date: '2026-09-10',
      type: 'SALE',
      qty_base: -27,
      value_minor: -200000,
      invoice_item_id: d.invoiceItemId
    })
  )
  ledgerId = insertRow(
    db,
    'customer_ledger',
    rows.ledger(m, { type: 'INVOICE', amount_minor: 233000, invoice_id: d.invoiceId })
  )
  insertRow(db, 'invoice_change_log', {
    invoice_id: d.invoiceId,
    field: 'bilty_no',
    old_value: null,
    new_value: 'B-00045'
  })
})

afterEach(() => {
  temp.remove()
})

/** The SQLite error code of a statement, or undefined if it succeeds. */
function runCode(sql: string, params: SqlValue[] = []): string | undefined {
  try {
    db.run(sql, params)
    return undefined
  } catch (error) {
    return sqliteErrorCode(error)
  }
}

function allRows(table: string): unknown[] {
  return db.all(`SELECT * FROM ${table} ORDER BY rowid`)
}

function columnsOf(table: string): { name: string; type: string }[] {
  return db.all<{ name: string; type: string }>(`PRAGMA table_info(${table})`)
}

/** An expression that gives `column` a different value of its own type. */
function changed(column: { name: string; type: string }): string {
  return column.type === 'INTEGER'
    ? `coalesce(${column.name}, 0) + 1`
    : `coalesce(${column.name}, '') || 'x'`
}

function replaceRow(table: string, row: Row): string | undefined {
  const columns = Object.keys(row)
  const values = columns.map((column) => `@${column}`).join(', ')
  try {
    db.run(`INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${values})`, row)
    return undefined
  } catch (error) {
    return sqliteErrorCode(error)
  }
}

const APPEND_ONLY: [table: string, column: string][] = [
  ['customer_ledger', 'note'],
  ['stock_movements', 'note'],
  ['invoice_items', 'prod_name'],
  ['invoice_item_quantities', 'unit_name'],
  ['invoice_change_log', 'note'],
  ['stock_receipt_items', 'unit_name'],
  ['stock_adjustments', 'reason_note'],
  ['schema_migrations', 'app_version']
]

describe.each(APPEND_ONLY)('%s is append-only', (table, column) => {
  it('refuses every UPDATE, even one that changes nothing', () => {
    const before = allRows(table)
    expect(before.length).toBeGreaterThan(0)
    expect(runCode(`UPDATE ${table} SET ${column} = 'changed'`)).toBe(TRIGGER)
    expect(runCode(`UPDATE ${table} SET ${column} = ${column}`)).toBe(TRIGGER)
    expect(allRows(table)).toEqual(before)
  })

  it('refuses DELETE of one row and of every row', () => {
    const before = allRows(table)
    expect(runCode(`DELETE FROM ${table} WHERE rowid = (SELECT min(rowid) FROM ${table})`)).toBe(
      TRIGGER
    )
    expect(runCode(`DELETE FROM ${table}`)).toBe(TRIGGER)
    expect(allRows(table)).toEqual(before)
  })

  it('still accepts new rows', () => {
    expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n).toBeGreaterThan(0)
  })
})

describe('the append-only rules cannot be bypassed', () => {
  it('explains the refusal', () => {
    const error = thrown(() => db.run('DELETE FROM customer_ledger'))
    expect((error as Error).message).toMatch(/append-only/)
  })

  it('INSERT OR REPLACE cannot overwrite a ledger entry', () => {
    const before = allRows('customer_ledger')
    const replacement = rows.ledger(m, {
      id: ledgerId,
      type: 'INVOICE',
      amount_minor: 1,
      invoice_id: d.invoiceId
    })
    expect(replaceRow('customer_ledger', replacement)).toBe(TRIGGER)
    expect(allRows('customer_ledger')).toEqual(before)
  })

  it('REPLACE cannot swap the sale movement of an invoice line for another one', () => {
    const before = allRows('stock_movements')
    const replacement = rows.movement(m, {
      type: 'SALE',
      qty_base: -1,
      value_minor: -1,
      invoice_item_id: d.invoiceItemId
    })
    expect(replaceRow('stock_movements', replacement)).toBe(TRIGGER)
    expect(allRows('stock_movements')).toEqual(before)
  })

  it('REPLACE cannot rewrite an invoice line or its quantities', () => {
    const items = allRows('invoice_items')
    const quantities = allRows('invoice_item_quantities')
    expect(
      replaceRow('invoice_items', rows.invoiceItem(m, d.invoiceId, { prod_name: 'Other' }))
    ).toBe(TRIGGER)
    expect(
      replaceRow(
        'invoice_item_quantities',
        rows.quantity(d.invoiceItemId, m.boxId, { unit_name: 'Carton' })
      )
    ).toBe(TRIGGER)
    expect(allRows('invoice_items')).toEqual(items)
    expect(allRows('invoice_item_quantities')).toEqual(quantities)
  })

  it('an UPSERT cannot update a ledger entry, and UPDATE OR REPLACE cannot change a movement', () => {
    const ledger = allRows('customer_ledger')
    const movements = allRows('stock_movements')
    expect(
      runCode(
        "INSERT INTO customer_ledger (id, customer_id, entry_date, type, amount_minor, invoice_id) VALUES (?, ?, '2026-09-10', 'INVOICE', 1, ?) ON CONFLICT (id) DO UPDATE SET note = 'changed'",
        [ledgerId, m.customerId, d.invoiceId]
      )
    ).toBe(TRIGGER)
    expect(runCode("UPDATE OR REPLACE stock_movements SET note = 'changed'")).toBe(TRIGGER)
    expect(allRows('customer_ledger')).toEqual(ledger)
    expect(allRows('stock_movements')).toEqual(movements)
  })
})

describe('invoices: a saved header changes only by voiding it or updating its dispatch details', () => {
  const DISPATCH = ['bilty_no', 'transport_name', 'adda_name', 'dispatch_updated_at']
  const VOIDING = ['status', 'void_reason', 'voided_at', 'void_date']
  const PROTECTED = [
    'id',
    'invoice_no',
    'seq_no',
    'request_id',
    'invoice_code',
    'invoice_date',
    'customer_id',
    'cust_name',
    'cust_shop_name',
    'cust_phone',
    'cust_address',
    'cust_city',
    'price_tier',
    'gross_minor',
    'line_discount_minor',
    'line_scheme_minor',
    'extra_discount_minor',
    'net_minor',
    'freight_minor',
    'total_minor',
    'received_minor',
    'previous_balance_minor',
    'net_outstanding_minor',
    'cogs_minor',
    'checked_by',
    'notes',
    'created_at'
  ]
  const invoice = (): unknown => db.get('SELECT * FROM invoices WHERE id = ?', [d.invoiceId])
  const voidIt = (): void => {
    db.run(
      "UPDATE invoices SET status = 'VOID', void_reason = 'Wrong customer', voided_at = ?, void_date = '2026-09-11' WHERE id = ?",
      [TIMESTAMP, d.invoiceId]
    )
  }

  it('every column is either protected, a dispatch detail or a void detail', () => {
    expect(
      columnsOf('invoices')
        .map((column) => column.name)
        .sort()
    ).toEqual([...PROTECTED, ...DISPATCH, ...VOIDING].sort())
  })

  it('allows updating the dispatch details after the invoice is saved', () => {
    const before = invoice() as Record<string, unknown>
    db.run(
      "UPDATE invoices SET bilty_no = 'B-00045', transport_name = 'Daewoo Cargo', adda_name = 'Badami Bagh', dispatch_updated_at = ? WHERE id = ?",
      [TIMESTAMP, d.invoiceId]
    )
    expect(invoice()).toEqual({
      ...before,
      bilty_no: 'B-00045',
      transport_name: 'Daewoo Cargo',
      adda_name: 'Badami Bagh',
      dispatch_updated_at: TIMESTAMP
    })
  })

  it('allows voiding a posted invoice with its reason, time and date', () => {
    const before = invoice() as Record<string, unknown>
    voidIt()
    expect(invoice()).toEqual({
      ...before,
      status: 'VOID',
      void_reason: 'Wrong customer',
      voided_at: TIMESTAMP,
      void_date: '2026-09-11'
    })
  })

  it('refuses a void without its reason, time and date', () => {
    expect(runCode("UPDATE invoices SET status = 'VOID' WHERE id = ?", [d.invoiceId])).toBe(CHECK)
  })

  it('refuses to un-void an invoice or to edit its void details', () => {
    voidIt()
    const voided = invoice()
    expect(
      runCode(
        "UPDATE invoices SET status = 'POSTED', void_reason = NULL, voided_at = NULL, void_date = NULL WHERE id = ?",
        [d.invoiceId]
      )
    ).toBe(TRIGGER)
    expect(runCode("UPDATE invoices SET void_reason = 'Other' WHERE id = ?", [d.invoiceId])).toBe(
      TRIGGER
    )
    expect(
      runCode("UPDATE invoices SET void_date = '2026-09-12' WHERE id = ?", [d.invoiceId])
    ).toBe(TRIGGER)
    expect(invoice()).toEqual(voided)
  })

  it('refuses a change to any protected column, checked one column at a time', () => {
    const before = invoice()
    const accepted = columnsOf('invoices')
      .filter((column) => PROTECTED.includes(column.name))
      .filter(
        (column) =>
          runCode(`UPDATE invoices SET ${column.name} = ${changed(column)} WHERE id = ?`, [
            d.invoiceId
          ]) !== TRIGGER
      )
      .map((column) => column.name)
    expect(accepted).toEqual([])
    expect(invoice()).toEqual(before)
  })

  it('treats a change of letter case as a change', () => {
    expect(
      runCode('UPDATE invoices SET cust_name = upper(cust_name) WHERE id = ?', [d.invoiceId])
    ).toBe(TRIGGER)
  })

  it('refuses to delete an invoice, posted or void', () => {
    expect(runCode('DELETE FROM invoices WHERE id = ?', [d.invoiceId])).toBe(TRIGGER)
    voidIt()
    expect(runCode('DELETE FROM invoices WHERE id = ?', [d.invoiceId])).toBe(TRIGGER)
  })
})

describe.each<[table: string, voidColumns: string[], voidSql: string]>([
  [
    'payments',
    ['status', 'void_reason', 'voided_at', 'void_date'],
    `status = 'VOID', void_reason = 'Cheque bounced', voided_at = '${TIMESTAMP}', void_date = '2026-09-11'`
  ],
  [
    'stock_receipts',
    ['status', 'void_reason', 'void_date'],
    "status = 'VOID', void_reason = 'Keyed twice', void_date = '2026-09-11'"
  ]
])('%s: a posted document changes only by being voided', (table, voidColumns, voidSql) => {
  const id = (): number => (table === 'payments' ? d.paymentId : d.receiptId)
  const current = (): unknown => db.get(`SELECT * FROM ${table} WHERE id = ?`, [id()])

  it('allows POSTED → VOID with the void details', () => {
    expect(runCode(`UPDATE ${table} SET ${voidSql} WHERE id = ?`, [id()])).toBeUndefined()
    expect(db.get(`SELECT status FROM ${table} WHERE id = ?`, [id()])).toEqual({ status: 'VOID' })
  })

  it('refuses to un-void the document', () => {
    db.run(`UPDATE ${table} SET ${voidSql} WHERE id = ?`, [id()])
    const nulls = voidColumns
      .filter((column) => column !== 'status')
      .map((column) => `${column} = NULL`)
    expect(
      runCode(`UPDATE ${table} SET status = 'POSTED', ${nulls.join(', ')} WHERE id = ?`, [id()])
    ).toBe(TRIGGER)
  })

  it('refuses a change to any other column, checked one column at a time', () => {
    const before = current()
    const others = columnsOf(table).filter((column) => !voidColumns.includes(column.name))
    expect(others.length).toBeGreaterThan(8)
    const accepted = others
      .filter(
        (column) =>
          runCode(`UPDATE ${table} SET ${column.name} = ${changed(column)} WHERE id = ?`, [
            id()
          ]) !== TRIGGER
      )
      .map((column) => column.name)
    expect(accepted).toEqual([])
    expect(current()).toEqual(before)
  })

  it('refuses DELETE', () => {
    expect(runCode(`DELETE FROM ${table} WHERE id = ?`, [id()])).toBe(TRIGGER)
  })
})

describe('editable records', () => {
  it('expenses can be edited and voided, but never deleted', () => {
    const id = insertRow(db, 'expenses', rows.expense(m))
    db.run("UPDATE expenses SET amount_minor = 2000, description = 'Tea and sugar' WHERE id = ?", [
      id
    ])
    db.run("UPDATE expenses SET status = 'VOID' WHERE id = ?", [id])
    expect(db.get('SELECT amount_minor, status FROM expenses WHERE id = ?', [id])).toEqual({
      amount_minor: 2000,
      status: 'VOID'
    })
    expect(runCode('DELETE FROM expenses WHERE id = ?', [id])).toBe(TRIGGER)
  })

  it('master data stays editable: names, prices, contact details and flags can change', () => {
    expect(
      runCode("UPDATE products SET name = 'Tea 900g', is_active = 0 WHERE id = ?", [m.productId])
    ).toBeUndefined()
    expect(
      runCode('UPDATE product_units SET retail_price_minor = 260000 WHERE id = ?', [m.boxId])
    ).toBeUndefined()
    expect(
      runCode("UPDATE customers SET phone = '0311-7654321' WHERE id = ?", [m.customerId])
    ).toBeUndefined()
    expect(
      runCode('UPDATE companies SET is_active = 0 WHERE id = ?', [m.companyId])
    ).toBeUndefined()
    expect(
      runCode("UPDATE settings SET value = '\"Ali Traders\"' WHERE key = 'business.name'")
    ).toBeUndefined()
  })
})
