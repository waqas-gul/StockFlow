import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteErrorCode, type Db } from '../adapter'
import {
  createSchemaDatabase,
  createTempDir,
  insertDocuments,
  insertMasters,
  insertRow,
  rows,
  sqliteCodeOf,
  thrown,
  type Documents,
  type Masters,
  type Row,
  type TempDir
} from '../test-utils'

// Constraints are tested directly against SQLite with technical fixture rows in temporary databases.

const CHECK = 'SQLITE_CONSTRAINT_CHECK'
const UNIQUE = 'SQLITE_CONSTRAINT_UNIQUE'
const FOREIGN_KEY = 'SQLITE_CONSTRAINT_FOREIGNKEY'
const DATATYPE = 'SQLITE_CONSTRAINT_DATATYPE'
const NOT_NULL = 'SQLITE_CONSTRAINT_NOTNULL'
const PRIMARY_KEY = 'SQLITE_CONSTRAINT_PRIMARYKEY'
const TIMESTAMP = '2026-09-11T08:30:00.000Z'

let temp: TempDir
let db: Db
let m: Masters
let d: Documents

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  m = insertMasters(db)
  d = insertDocuments(db, m)
})

afterEach(() => {
  temp.remove()
})

/** The SQLite error code of inserting `row`, or undefined if the insert succeeds. */
function insertCode(table: string, row: Row): string | undefined {
  try {
    insertRow(db, table, row)
    return undefined
  } catch (error) {
    return sqliteErrorCode(error)
  }
}

function runCode(sql: string, params: (number | string)[] = []): string | undefined {
  return sqliteCodeOf(() => db.run(sql, params))
}

/**
 * SQLite enforces ON DELETE RESTRICT with an internal trigger, so a refused delete is reported as
 * SQLITE_CONSTRAINT_TRIGGER with the message "FOREIGN KEY constraint failed".
 */
const RESTRICTED = { code: 'SQLITE_CONSTRAINT_TRIGGER', message: 'FOREIGN KEY constraint failed' }

function deleteError(sql: string, params: number[]): { code?: string; message: string } {
  const error = thrown(() => db.run(sql, params)) as Error
  return { code: sqliteErrorCode(error), message: error.message }
}

describe('companies', () => {
  it('rejects a duplicate name, ignoring letter case', () => {
    expect(insertCode('companies', { name: 'ACME foods' })).toBe(UNIQUE)
  })

  it('rejects a blank name and a non-boolean is_active', () => {
    expect(insertCode('companies', { name: '   ' })).toBe(CHECK)
    expect(insertCode('companies', { name: 'Other', is_active: 2 })).toBe(CHECK)
  })

  it('cannot be deleted while a product references it', () => {
    expect(deleteError('DELETE FROM companies WHERE id = ?', [m.companyId])).toEqual(RESTRICTED)
  })
})

describe('products', () => {
  it('rejects a duplicate code, ignoring letter case', () => {
    expect(insertCode('products', { code: 'p-001', name: 'Copy' })).toBe(UNIQUE)
  })

  it('rejects a blank code or name and a negative low-stock threshold', () => {
    expect(insertCode('products', { code: ' ', name: 'Rice' })).toBe(CHECK)
    expect(insertCode('products', { code: 'P-003', name: '' })).toBe(CHECK)
    expect(
      insertCode('products', { code: 'P-003', name: 'Rice', low_stock_threshold_base: -1 })
    ).toBe(CHECK)
  })

  it('stores the packing label exactly as typed and derives nothing from it', () => {
    const labels = ['1*60*18', '1 * 12 * 18', '12x18 (approx)', '']
    labels.forEach((label, index) => {
      const id = insertRow(db, 'products', {
        code: `P-10${index}`,
        name: 'Label',
        packing_label: label
      })
      expect(db.get('SELECT packing_label FROM products WHERE id = ?', [id])).toEqual({
        packing_label: label
      })
      expect(db.get('SELECT count(*) AS n FROM product_units WHERE product_id = ?', [id])).toEqual({
        n: 0
      })
    })
  })

  it('cannot be deleted once documents reference it', () => {
    expect(deleteError('DELETE FROM products WHERE id = ?', [m.productId])).toEqual(RESTRICTED)
  })
})

describe('product_units', () => {
  it('allows only one base unit per product', () => {
    expect(insertCode('product_units', rows.unit(m.productId, { name: 'Loose' }))).toBe(UNIQUE)
  })

  it('requires the base unit to hold exactly 1 base unit', () => {
    const productId = insertRow(db, 'products', { code: 'P-003', name: 'Rice' })
    expect(insertCode('product_units', rows.unit(productId, { base_qty: 6 }))).toBe(CHECK)
    expect(insertCode('product_units', rows.unit(productId))).toBeUndefined()
  })

  it('rejects a second unit of the same size, or of the same name ignoring case, on one product', () => {
    const pack = { name: 'Pack', is_base: 0, base_qty: 24 }
    expect(insertCode('product_units', rows.unit(m.productId, pack))).toBe(UNIQUE)
    const box = { name: 'BOX', is_base: 0, base_qty: 12 }
    expect(insertCode('product_units', rows.unit(m.productId, box))).toBe(UNIQUE)
  })

  it('allows the same unit name and size on different products', () => {
    const box = { name: 'Box', is_base: 0, base_qty: 24 }
    expect(insertCode('product_units', rows.unit(m.otherProductId, box))).toBeUndefined()
  })

  it.each<[string, Row]>([
    ['a zero size', { name: 'Tray', is_base: 0, base_qty: 0 }],
    ['a negative size', { name: 'Tray', is_base: 0, base_qty: -6 }],
    [
      'a negative wholesale price',
      { name: 'Tray', is_base: 0, base_qty: 6, wholesale_price_minor: -1 }
    ],
    ['a negative retail price', { name: 'Tray', is_base: 0, base_qty: 6, retail_price_minor: -1 }],
    ['a negative default cost', { name: 'Tray', is_base: 0, base_qty: 6, default_cost_minor: -1 }],
    ['a non-boolean is_base', { name: 'Tray', is_base: 2, base_qty: 6 }],
    ['a non-boolean can_sell', { name: 'Tray', is_base: 0, base_qty: 6, can_sell: 2 }],
    ['a non-boolean can_purchase', { name: 'Tray', is_base: 0, base_qty: 6, can_purchase: -1 }],
    ['a non-boolean is_active', { name: 'Tray', is_base: 0, base_qty: 6, is_active: 5 }]
  ])('rejects %s', (_label, overrides) => {
    expect(insertCode('product_units', rows.unit(m.productId, overrides))).toBe(CHECK)
  })

  it('allows a unit without prices (not sold at that tier) and non-nested sizes (a service rule)', () => {
    const unpriced = {
      name: 'Tray',
      is_base: 0,
      base_qty: 10,
      wholesale_price_minor: null,
      retail_price_minor: null,
      default_cost_minor: null
    }
    expect(insertCode('product_units', rows.unit(m.productId, unpriced))).toBeUndefined()
  })

  it('cannot be deleted while a document uses it', () => {
    expect(deleteError('DELETE FROM product_units WHERE id = ?', [m.boxId])).toEqual(RESTRICTED)
  })
})

describe('customers', () => {
  it('rejects a duplicate code, ignoring letter case', () => {
    expect(insertCode('customers', { code: 'C-00002', name: 'Other' })).toBe(UNIQUE)
    expect(insertCode('customers', { code: 'c-00001', name: 'Other' })).toBe(UNIQUE)
  })

  it('allows different customers with identical names and shop names', () => {
    const twin = { code: 'C-00003', name: 'Ali', shop_name: 'Ali Traders', city: 'Lahore' }
    expect(insertCode('customers', twin)).toBeUndefined()
  })

  it('cannot be deleted once it has documents', () => {
    expect(deleteError('DELETE FROM customers WHERE id = ?', [m.customerId])).toEqual(RESTRICTED)
  })
})

describe('STRICT column types', () => {
  const payment2 = (overrides: Row): Row =>
    rows.payment(m, { payment_no: 'RCP-000002', request_id: 'payment-request-2', ...overrides })

  it('rejects text in an INTEGER money column', () => {
    expect(insertCode('payments', payment2({ amount_minor: 'a lot' }))).toBe(DATATYPE)
  })

  it('rejects a fractional amount: money is never floating-point', () => {
    expect(insertCode('payments', payment2({ amount_minor: 125.5 }))).toBe(DATATYPE)
  })

  it('rejects a blob in a TEXT column', () => {
    expect(runCode("INSERT INTO companies (name) VALUES (X'41')")).toBe(DATATYPE)
  })

  it('rejects a number in a date column', () => {
    expect(insertCode('payments', payment2({ payment_date: 20260910 }))).toBe(CHECK)
  })
})

describe('dates and timestamps', () => {
  const expense2 = (overrides: Row): Row =>
    rows.expense(m, { request_id: 'expense-request-2', ...overrides })

  it.each([
    '2026-9-10',
    '10-09-2026',
    '2026/09/10',
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-09-10T00:00:00',
    ' 2026-09-10',
    ''
  ])('rejects the business date %j', (value) => {
    expect(insertCode('expenses', expense2({ expense_date: value }))).toBe(CHECK)
  })

  it('accepts a real calendar date, including 29 February of a leap year', () => {
    expect(insertCode('expenses', expense2({ expense_date: '2028-02-29' }))).toBeUndefined()
  })

  it.each([
    '2026-09-10 08:30:00',
    '2026-09-10T08:30:00Z',
    '2026-09-10T08:30:00.000',
    '2026-09-10T08:30:00.000+05:00',
    '2026-09-10T25:00:00.000Z',
    '2026-02-30T08:30:00.000Z',
    '2026-09-10'
  ])('rejects the timestamp %j', (value) => {
    expect(insertCode('companies', { name: 'Other', created_at: value })).toBe(CHECK)
  })

  it('stamps created_at and updated_at with the current UTC time in ISO-8601 by default', () => {
    const before = new Date().toISOString()
    const id = insertRow(db, 'companies', { name: 'Other' })
    const after = new Date().toISOString()
    const row = db.get<{ created_at: string; updated_at: string }>(
      'SELECT created_at, updated_at FROM companies WHERE id = ?',
      [id]
    )
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(row!.created_at >= before && row!.created_at <= after).toBe(true)
    expect(row?.updated_at).toBe(row?.created_at)
  })
})

describe('invoices', () => {
  const invoice2 = (overrides: Row = {}): Row =>
    rows.invoice(m, {
      invoice_no: 'INV-000002',
      seq_no: 2,
      request_id: 'invoice-request-2',
      ...overrides
    })

  interface Parts {
    gross?: number
    lineDiscount?: number
    lineScheme?: number
    extraDiscount?: number
    freight?: number
    received?: number
    previous?: number
  }

  /** An invoice whose stored totals follow the V1 formulas (B6) from the given parts. */
  function consistentInvoice(parts: Parts): Row {
    const p = {
      gross: 250000,
      lineDiscount: 12500,
      lineScheme: 2500,
      extraDiscount: 5000,
      freight: 3000,
      received: 50000,
      previous: 10000,
      ...parts
    }
    const net = p.gross - p.lineDiscount - p.lineScheme - p.extraDiscount
    const total = net + p.freight
    return invoice2({
      gross_minor: p.gross,
      line_discount_minor: p.lineDiscount,
      line_scheme_minor: p.lineScheme,
      extra_discount_minor: p.extraDiscount,
      net_minor: net,
      freight_minor: p.freight,
      total_minor: total,
      received_minor: p.received,
      previous_balance_minor: p.previous,
      net_outstanding_minor: p.previous + total - p.received
    })
  }

  it('accepts a consistent invoice', () => {
    expect(insertCode('invoices', invoice2())).toBeUndefined()
  })

  it.each<[string, Row]>([
    ['invoice number', { invoice_no: 'INV-000001' }],
    ['invoice number in other letter case', { invoice_no: 'inv-000001' }],
    ['sequence number', { seq_no: 1 }],
    ['request id', { request_id: 'invoice-request-1' }]
  ])('rejects a duplicate %s', (_label, overrides) => {
    expect(insertCode('invoices', invoice2(overrides))).toBe(UNIQUE)
  })

  it.each<[string, Row]>([
    ['an unknown status', { status: 'DRAFT' }],
    ['a lower-case status', { status: 'posted' }],
    ['an unknown price tier', { price_tier: 'SPECIAL' }],
    ['a zero sequence number', { seq_no: 0 }],
    ['a blank invoice number', { invoice_no: ' ' }],
    ['a blank request id', { request_id: '' }]
  ])('rejects %s', (_label, overrides) => {
    expect(insertCode('invoices', invoice2(overrides))).toBe(CHECK)
  })

  it.each<[string, Parts]>([
    ['gross amount', { gross: -1, lineDiscount: 0, lineScheme: 0, extraDiscount: 0 }],
    ['line discount', { lineDiscount: -1 }],
    ['line scheme amount', { lineScheme: -1 }],
    ['extra discount', { extraDiscount: -1 }],
    ['freight', { freight: -1 }],
    ['received amount', { received: -1 }],
    [
      'net amount (discounts larger than gross)',
      { gross: 1000, lineDiscount: 2000, lineScheme: 0, extraDiscount: 0 }
    ]
  ])('rejects a negative %s even when the totals add up', (_label, parts) => {
    expect(insertCode('invoices', consistentInvoice(parts))).toBe(CHECK)
  })

  it('rejects a negative cost of goods sold', () => {
    expect(insertCode('invoices', invoice2({ cogs_minor: -1 }))).toBe(CHECK)
  })

  it('allows a negative previous balance and net outstanding: the customer has an advance', () => {
    const id = insertRow(db, 'invoices', consistentInvoice({ previous: -300000 }))
    expect(db.get('SELECT net_outstanding_minor FROM invoices WHERE id = ?', [id])).toEqual({
      net_outstanding_minor: -117000
    })
  })

  it.each<[string, Row]>([
    ['net (gross − line discount − line scheme − extra discount)', { net_minor: 230001 }],
    ['total (net + freight)', { total_minor: 233001 }],
    ['net outstanding (previous balance + total − received)', { net_outstanding_minor: 193001 }]
  ])('rejects a %s that does not match its formula', (_label, overrides) => {
    expect(insertCode('invoices', invoice2(overrides))).toBe(CHECK)
  })

  it('keeps Invoice Code and the dispatch fields as optional literal text', () => {
    const plain = insertRow(db, 'invoices', invoice2())
    expect(
      db.get(
        'SELECT invoice_code, bilty_no, transport_name, adda_name, dispatch_updated_at FROM invoices WHERE id = ?',
        [plain]
      )
    ).toEqual({
      invoice_code: null,
      bilty_no: null,
      transport_name: null,
      adda_name: null,
      dispatch_updated_at: null
    })
    const literal = {
      invoice_no: 'INV-000003',
      seq_no: 3,
      request_id: 'invoice-request-3',
      invoice_code: ' BK-7/12 ',
      bilty_no: 'B-00045',
      transport_name: 'Daewoo Cargo',
      adda_name: 'Badami Bagh'
    }
    const id = insertRow(db, 'invoices', invoice2(literal))
    expect(
      db.get(
        'SELECT invoice_code, bilty_no, transport_name, adda_name FROM invoices WHERE id = ?',
        [id]
      )
    ).toEqual({
      invoice_code: ' BK-7/12 ',
      bilty_no: 'B-00045',
      transport_name: 'Daewoo Cargo',
      adda_name: 'Badami Bagh'
    })
  })

  it.each<[string, Row]>([
    ['VOID without a reason', { status: 'VOID', voided_at: TIMESTAMP, void_date: '2026-09-11' }],
    [
      'VOID with a blank reason',
      { status: 'VOID', void_reason: ' ', voided_at: TIMESTAMP, void_date: '2026-09-11' }
    ],
    ['VOID without its void time and date', { status: 'VOID', void_reason: 'Wrong customer' }],
    ['POSTED with void details', { void_reason: 'Wrong customer' }]
  ])('rejects %s', (_label, overrides) => {
    expect(insertCode('invoices', invoice2(overrides))).toBe(CHECK)
  })

  it('rejects an unknown customer', () => {
    expect(insertCode('invoices', invoice2({ customer_id: 999 }))).toBe(FOREIGN_KEY)
  })
})

describe('invoice_items', () => {
  const item2 = (overrides: Row = {}): Row =>
    rows.invoiceItem(m, d.invoiceId, { line_no: 2, ...overrides })

  it('accepts a consistent line, with or without a discount percentage and CTN', () => {
    expect(insertCode('invoice_items', item2())).toBeUndefined()
    expect(
      insertCode('invoice_items', item2({ line_no: 3, discount_bps: null, ctn_count: null }))
    ).toBeUndefined()
  })

  it.each<[string, Row]>([
    ['a zero base quantity', { qty_base: 0 }],
    ['a negative free (scheme) quantity', { scheme_qty_base: -1 }],
    ['more free quantity than the whole line', { scheme_qty_base: 28 }],
    [
      'a negative gross amount',
      { gross_minor: -1, discount_bps: null, discount_minor: 0, scheme_minor: 0, net_minor: -1 }
    ],
    ['a negative discount', { discount_minor: -1, net_minor: 247501 }],
    ['a negative scheme amount', { scheme_minor: -1, net_minor: 237501 }],
    ['a negative cost', { cost_minor: -1 }],
    ['a discount above 100%', { discount_bps: 10001 }],
    ['a negative discount percentage', { discount_bps: -1 }],
    ['a negative CTN count', { ctn_count: -1 }],
    ['a net amount that is not gross − discount − scheme amount', { net_minor: 235001 }],
    ['a zero line number', { line_no: 0 }]
  ])('rejects %s', (_label, overrides) => {
    expect(insertCode('invoice_items', item2(overrides))).toBe(CHECK)
  })

  it('allows free goods up to the whole line quantity', () => {
    expect(insertCode('invoice_items', item2({ scheme_qty_base: 27 }))).toBeUndefined()
  })

  it('rejects a duplicate line number on one invoice', () => {
    expect(insertCode('invoice_items', item2({ line_no: 1 }))).toBe(UNIQUE)
  })

  it('rejects an unknown product', () => {
    expect(insertCode('invoice_items', item2({ product_id: 999 }))).toBe(FOREIGN_KEY)
  })
})

describe('invoice_item_quantities', () => {
  let itemId: number
  beforeEach(() => {
    itemId = insertRow(db, 'invoice_items', rows.invoiceItem(m, d.invoiceId, { line_no: 2 }))
  })

  it.each<[string, Row]>([
    ['a zero quantity', { quantity: 0, amount_minor: 0, qty_base: 0 }],
    ['a negative unit price', { unit_price_minor: -1, amount_minor: -1 }],
    ['an amount that is not quantity × unit price', { amount_minor: 240001 }],
    ['a base quantity that is not quantity × unit size', { qty_base: 25 }],
    ['a zero unit size', { unit_base_qty: 0, qty_base: 0 }]
  ])('rejects %s', (_label, overrides) => {
    expect(insertCode('invoice_item_quantities', rows.quantity(itemId, m.boxId, overrides))).toBe(
      CHECK
    )
  })

  it('rejects the same unit twice on one line', () => {
    insertRow(db, 'invoice_item_quantities', rows.quantity(itemId, m.boxId))
    expect(insertCode('invoice_item_quantities', rows.quantity(itemId, m.boxId))).toBe(UNIQUE)
  })

  it('holds a mixed-unit line: 2 Box + 5 Piece is one line with two quantity rows (53 base units)', () => {
    insertRow(
      db,
      'invoice_item_quantities',
      rows.quantity(itemId, m.boxId, { quantity: 2, amount_minor: 480000, qty_base: 48 })
    )
    insertRow(
      db,
      'invoice_item_quantities',
      rows.quantity(itemId, m.pieceId, {
        unit_name: 'Piece',
        unit_short_name: 'Pcs',
        unit_base_qty: 1,
        quantity: 5,
        unit_price_minor: 10000,
        amount_minor: 50000,
        qty_base: 5
      })
    )
    expect(
      db.get(
        'SELECT sum(qty_base) AS qty_base, sum(amount_minor) AS gross_minor FROM invoice_item_quantities WHERE invoice_item_id = ?',
        [itemId]
      )
    ).toEqual({ qty_base: 53, gross_minor: 530000 })
  })
})

describe('stock_receipts and stock_receipt_items', () => {
  const receipt2 = (overrides: Row = {}): Row =>
    rows.receipt({ receipt_no: 'GRN-000002', request_id: 'receipt-request-2', ...overrides })
  const line2 = (overrides: Row = {}): Row =>
    rows.receiptItem(m, d.receiptId, { line_no: 2, ...overrides })

  it.each<[string, Row]>([
    ['receipt number', { receipt_no: 'GRN-000001' }],
    ['request id', { request_id: 'receipt-request-1' }]
  ])('rejects a duplicate %s', (_label, overrides) => {
    expect(insertCode('stock_receipts', receipt2(overrides))).toBe(UNIQUE)
  })

  it.each<[string, Row]>([
    ['an unknown status', { status: 'OPEN' }],
    ['a negative total cost', { total_cost_minor: -1 }],
    ['VOID without a reason', { status: 'VOID', void_date: '2026-09-11' }],
    ['POSTED with a void date', { void_date: '2026-09-11' }]
  ])('rejects a receipt with %s', (_label, overrides) => {
    expect(insertCode('stock_receipts', receipt2(overrides))).toBe(CHECK)
  })

  it.each<[string, Row]>([
    ['a zero quantity', { quantity: 0, qty_base: 0, line_cost_minor: 0 }],
    ['a negative unit cost', { unit_cost_minor: -1, line_cost_minor: -2 }],
    ['a line cost that is not quantity × unit cost', { line_cost_minor: 480001 }],
    ['a base quantity that is not quantity × unit size', { qty_base: 47 }]
  ])('rejects a line with %s', (_label, overrides) => {
    expect(insertCode('stock_receipt_items', line2(overrides))).toBe(CHECK)
  })

  it('accepts a zero-cost line (for example bonus goods from the supplier)', () => {
    expect(
      insertCode('stock_receipt_items', line2({ unit_cost_minor: 0, line_cost_minor: 0 }))
    ).toBeUndefined()
  })

  it('rejects a unit that belongs to another product', () => {
    const wrongUnit = { unit_id: m.otherPieceId, unit_name: 'Piece', unit_base_qty: 1, qty_base: 2 }
    expect(insertCode('stock_receipt_items', line2(wrongUnit))).toBe(FOREIGN_KEY)
  })

  it('rejects a duplicate line number on one receipt', () => {
    expect(insertCode('stock_receipt_items', line2({ line_no: 1 }))).toBe(UNIQUE)
  })
})

describe('stock_adjustments', () => {
  let counter = 1
  const adjustment = (overrides: Row = {}): Row => {
    counter += 1
    return rows.adjustment(m, {
      adjustment_no: `ADJ-${String(counter).padStart(6, '0')}`,
      request_id: `adjustment-request-${counter}`,
      ...overrides
    })
  }
  const valueOnly = (overrides: Row = {}): Row =>
    adjustment({
      reason_code: 'RECEIPT_COST_CORRECTION',
      direction: 'VALUE',
      unit_id: null,
      unit_name: null,
      unit_base_qty: null,
      quantity: null,
      qty_base: 0,
      value_minor: 1000,
      receipt_id: d.receiptId,
      ...overrides
    })

  it('accepts every reason code in its allowed direction', () => {
    const cases: Row[] = [
      { reason_code: 'OPENING_STOCK', direction: 'IN' },
      { reason_code: 'DAMAGE', direction: 'OUT' },
      { reason_code: 'EXPIRY', direction: 'OUT' },
      { reason_code: 'SHORTAGE', direction: 'OUT' },
      { reason_code: 'COUNT_SURPLUS', direction: 'IN' },
      { reason_code: 'RECEIPT_QTY_CORRECTION', direction: 'IN', receipt_id: d.receiptId },
      { reason_code: 'RECEIPT_QTY_CORRECTION', direction: 'OUT', receipt_id: d.receiptId },
      { reason_code: 'OTHER_CORRECTION', direction: 'IN' },
      { reason_code: 'OTHER_CORRECTION', direction: 'OUT' }
    ]
    for (const overrides of cases) {
      expect({ overrides, code: insertCode('stock_adjustments', adjustment(overrides)) }).toEqual({
        overrides,
        code: undefined
      })
    }
    expect(insertCode('stock_adjustments', valueOnly())).toBeUndefined()
  })

  it.each<[string, () => Row]>([
    ['an unknown reason code', () => adjustment({ reason_code: 'THEFT' })],
    ['an unknown direction', () => adjustment({ direction: 'SIDEWAYS' })],
    ['damage going IN', () => adjustment({ direction: 'IN' })],
    ['opening stock going OUT', () => adjustment({ reason_code: 'OPENING_STOCK' })],
    ['a count surplus going OUT', () => adjustment({ reason_code: 'COUNT_SURPLUS' })],
    [
      'a receipt cost correction moving quantity',
      () => adjustment({ reason_code: 'RECEIPT_COST_CORRECTION', receipt_id: d.receiptId })
    ],
    [
      'another correction changing value only',
      () => valueOnly({ reason_code: 'OTHER_CORRECTION', receipt_id: null })
    ],
    ['a value-only adjustment with a quantity', () => valueOnly({ qty_base: 3 })],
    [
      'a value-only adjustment with a unit',
      () => valueOnly({ unit_id: m.pieceId, unit_name: 'Piece', unit_base_qty: 1 })
    ],
    ['a value-only adjustment of zero', () => valueOnly({ value_minor: 0 })],
    ['a quantity adjustment of zero units', () => adjustment({ quantity: 0, qty_base: 0 })],
    [
      'a quantity adjustment without its unit',
      () => adjustment({ unit_id: null, unit_name: null, unit_base_qty: null })
    ],
    ['a quantity adjustment without its entered quantity', () => adjustment({ quantity: null })],
    ['a base quantity that is not quantity × unit size', () => adjustment({ qty_base: 4 })],
    ['a negative value', () => adjustment({ value_minor: -1 })],
    [
      'a receipt correction without its receipt',
      () => adjustment({ reason_code: 'RECEIPT_QTY_CORRECTION' })
    ],
    ['damage linked to a receipt', () => adjustment({ receipt_id: d.receiptId })],
    ['a blank reason note', () => adjustment({ reason_note: '  ' })]
  ])('rejects %s', (_label, build) => {
    expect(insertCode('stock_adjustments', build())).toBe(CHECK)
  })

  it('requires a reason note', () => {
    expect(insertCode('stock_adjustments', adjustment({ reason_note: null }))).toBe(NOT_NULL)
  })

  it('rejects a duplicate adjustment number or request id', () => {
    expect(insertCode('stock_adjustments', adjustment({ adjustment_no: 'ADJ-000001' }))).toBe(
      UNIQUE
    )
    expect(
      insertCode('stock_adjustments', adjustment({ request_id: 'adjustment-request-1' }))
    ).toBe(UNIQUE)
  })

  it('rejects a unit that belongs to another product', () => {
    expect(insertCode('stock_adjustments', adjustment({ unit_id: m.otherPieceId }))).toBe(
      FOREIGN_KEY
    )
  })
})

describe('stock_movements', () => {
  type Source = 'receipt' | 'invoice' | 'adjustment'
  let adjustments = 1

  /** A fresh adjustment to serve as a movement source (each adjustment has one movement). */
  function newAdjustmentId(): number {
    adjustments += 1
    return insertRow(
      db,
      'stock_adjustments',
      rows.adjustment(m, {
        adjustment_no: `ADJ-10000${adjustments}`,
        request_id: `movement-adjustment-${adjustments}`
      })
    )
  }

  function sourceOf(source: Source): Row {
    if (source === 'receipt') return { receipt_item_id: d.receiptItemId }
    if (source === 'invoice') return { invoice_item_id: d.invoiceItemId }
    return { adjustment_id: newAdjustmentId() }
  }

  function movement(type: string, qty: number, value: number, source: Source): Row {
    return rows.movement(m, { type, qty_base: qty, value_minor: value, ...sourceOf(source) })
  }

  it.each<[string, number, number, Source]>([
    ['OPENING', 10, 90000, 'adjustment'],
    ['OPENING', 10, 0, 'adjustment'],
    ['STOCK_IN', 48, 480000, 'receipt'],
    ['STOCK_IN', 48, 0, 'receipt'],
    ['STOCK_IN_VOID', -48, -480000, 'receipt'],
    ['SALE', -27, -200000, 'invoice'],
    ['SALE', -27, 0, 'invoice'],
    ['SALE_VOID', 27, 200000, 'invoice'],
    ['SALE_RETURN', 1, 7000, 'invoice'],
    ['ADJUST_IN', 5, 45000, 'adjustment'],
    ['ADJUST_IN', 5, 0, 'adjustment'],
    ['ADJUST_OUT', -3, -27000, 'adjustment'],
    ['COST_CORRECTION', 0, 1000, 'adjustment'],
    ['COST_CORRECTION', 0, -1000, 'adjustment']
  ])('accepts %s with quantity %i and value %i', (type, qty, value, source) => {
    expect(insertCode('stock_movements', movement(type, qty, value, source))).toBeUndefined()
  })

  it.each<[string, number, number, Source]>([
    ['OPENING', -10, -90000, 'adjustment'],
    ['OPENING', 10, -1, 'adjustment'],
    ['STOCK_IN', -48, -480000, 'receipt'],
    ['STOCK_IN', 0, 0, 'receipt'],
    ['STOCK_IN', 48, -1, 'receipt'],
    ['STOCK_IN_VOID', 48, 480000, 'receipt'],
    ['STOCK_IN_VOID', -48, 1, 'receipt'],
    ['SALE', 27, 200000, 'invoice'],
    ['SALE', -27, 1, 'invoice'],
    ['SALE', 0, 0, 'invoice'],
    ['SALE_VOID', -27, -200000, 'invoice'],
    ['SALE_VOID', 27, -1, 'invoice'],
    ['SALE_RETURN', -1, -7000, 'invoice'],
    ['ADJUST_IN', -5, -45000, 'adjustment'],
    ['ADJUST_OUT', 3, 27000, 'adjustment'],
    ['ADJUST_OUT', -3, 1, 'adjustment'],
    ['COST_CORRECTION', 1, 1000, 'adjustment'],
    ['COST_CORRECTION', 0, 0, 'adjustment'],
    ['TRANSFER', 1, 1, 'adjustment']
  ])('rejects %s with quantity %i and value %i', (type, qty, value, source) => {
    expect(insertCode('stock_movements', movement(type, qty, value, source))).toBe(CHECK)
  })

  it('rejects a movement without a source document', () => {
    expect(insertCode('stock_movements', rows.movement(m))).toBe(CHECK)
  })

  it('rejects a movement with two source documents', () => {
    const both = { receipt_item_id: d.receiptItemId, adjustment_id: newAdjustmentId() }
    expect(insertCode('stock_movements', rows.movement(m, both))).toBe(CHECK)
  })

  it.each<[string, number, number, Source]>([
    ['STOCK_IN', 48, 480000, 'invoice'],
    ['STOCK_IN_VOID', -48, -480000, 'adjustment'],
    ['SALE', -27, -200000, 'receipt'],
    ['SALE_RETURN', 1, 7000, 'adjustment'],
    ['ADJUST_OUT', -3, -27000, 'invoice'],
    ['COST_CORRECTION', 0, 1000, 'receipt']
  ])('rejects %s (quantity %i, value %i) from a %s source', (type, qty, value, source) => {
    expect(insertCode('stock_movements', movement(type, qty, value, source))).toBe(CHECK)
  })

  it('rejects a source document or product that does not exist', () => {
    expect(insertCode('stock_movements', rows.movement(m, { receipt_item_id: 999 }))).toBe(
      FOREIGN_KEY
    )
    expect(
      insertCode(
        'stock_movements',
        rows.movement(m, { product_id: 999, receipt_item_id: d.receiptItemId })
      )
    ).toBe(FOREIGN_KEY)
  })

  it('allows one movement per source line and type', () => {
    insertRow(db, 'stock_movements', movement('SALE', -27, -200000, 'invoice'))
    expect(insertCode('stock_movements', movement('SALE', -27, -200000, 'invoice'))).toBe(UNIQUE)
    insertRow(db, 'stock_movements', movement('SALE_VOID', 27, 200000, 'invoice'))
    expect(insertCode('stock_movements', movement('SALE_VOID', 27, 200000, 'invoice'))).toBe(UNIQUE)
    insertRow(db, 'stock_movements', movement('STOCK_IN', 48, 480000, 'receipt'))
    expect(insertCode('stock_movements', movement('STOCK_IN', 48, 480000, 'receipt'))).toBe(UNIQUE)
    insertRow(db, 'stock_movements', movement('STOCK_IN_VOID', -48, -480000, 'receipt'))
    expect(insertCode('stock_movements', movement('STOCK_IN_VOID', -48, -480000, 'receipt'))).toBe(
      UNIQUE
    )
    const adjustmentId = newAdjustmentId()
    const outflow = {
      type: 'ADJUST_OUT',
      qty_base: -3,
      value_minor: -27000,
      adjustment_id: adjustmentId
    }
    insertRow(db, 'stock_movements', rows.movement(m, outflow))
    expect(insertCode('stock_movements', rows.movement(m, outflow))).toBe(UNIQUE)
  })

  it('allows several returns of one invoice line', () => {
    insertRow(db, 'stock_movements', movement('SALE_RETURN', 1, 7000, 'invoice'))
    expect(
      insertCode('stock_movements', movement('SALE_RETURN', 1, 7000, 'invoice'))
    ).toBeUndefined()
  })
})

describe('payments', () => {
  const payment2 = (overrides: Row = {}): Row =>
    rows.payment(m, { payment_no: 'RCP-000002', request_id: 'payment-request-2', ...overrides })

  it.each([0, -1])('rejects the amount %i', (amount) => {
    expect(insertCode('payments', payment2({ amount_minor: amount }))).toBe(CHECK)
  })

  it.each<[string, Row]>([
    ['an unknown method', { method: 'CARD' }],
    ['an unknown status', { status: 'PENDING' }],
    ['VOID without a reason', { status: 'VOID', voided_at: TIMESTAMP, void_date: '2026-09-11' }],
    ['POSTED with void details', { voided_at: TIMESTAMP }]
  ])('rejects %s', (_label, overrides) => {
    expect(insertCode('payments', payment2(overrides))).toBe(CHECK)
  })

  it.each<[string, Row]>([
    ['payment number', { payment_no: 'RCP-000001' }],
    ['request id', { request_id: 'payment-request-1' }]
  ])('rejects a duplicate %s', (_label, overrides) => {
    expect(insertCode('payments', payment2(overrides))).toBe(UNIQUE)
  })

  it('accepts every method, with or without an invoice (running account)', () => {
    ;['CASH', 'BANK', 'CHEQUE', 'OTHER'].forEach((method, index) => {
      const row = payment2({ payment_no: `RCP-00001${index}`, request_id: `pay-${index}`, method })
      expect(insertCode('payments', row)).toBeUndefined()
    })
    expect(db.get("SELECT invoice_id FROM payments WHERE payment_no = 'RCP-000010'")).toEqual({
      invoice_id: null
    })
  })
})

describe('customer_ledger', () => {
  it('rejects a zero amount', () => {
    expect(insertCode('customer_ledger', rows.ledger(m, { amount_minor: 0 }))).toBe(CHECK)
  })

  it.each<[string, () => Row]>([
    [
      'a negative INVOICE entry',
      () => ({ type: 'INVOICE', amount_minor: -1, invoice_id: d.invoiceId })
    ],
    [
      'a positive INVOICE_VOID entry',
      () => ({ type: 'INVOICE_VOID', amount_minor: 1, invoice_id: d.invoiceId })
    ],
    [
      'a positive PAYMENT entry',
      () => ({ type: 'PAYMENT', amount_minor: 1, payment_id: d.paymentId })
    ],
    [
      'a negative PAYMENT_VOID entry',
      () => ({ type: 'PAYMENT_VOID', amount_minor: -1, payment_id: d.paymentId })
    ],
    ['an INVOICE entry without its invoice', () => ({ type: 'INVOICE', amount_minor: 1 })],
    [
      'an INVOICE entry that also names a payment',
      () => ({ type: 'INVOICE', amount_minor: 1, invoice_id: d.invoiceId, payment_id: d.paymentId })
    ],
    ['a PAYMENT entry without its payment', () => ({ type: 'PAYMENT', amount_minor: -1 })],
    ['an OPENING entry that names an invoice', () => ({ invoice_id: d.invoiceId })],
    ['an ADJUSTMENT without a note', () => ({ type: 'ADJUSTMENT', amount_minor: -500 })],
    ['an unknown type', () => ({ type: 'CREDIT' })]
  ])('rejects %s', (_label, build) => {
    expect(insertCode('customer_ledger', rows.ledger(m, build()))).toBe(CHECK)
  })

  it('accepts opening balances and adjustments in either direction', () => {
    expect(insertCode('customer_ledger', rows.ledger(m, { amount_minor: -5000 }))).toBeUndefined()
    for (const amount of [700, -300]) {
      const adjustment = { type: 'ADJUSTMENT', amount_minor: amount, note: 'Agreed correction' }
      expect(insertCode('customer_ledger', rows.ledger(m, adjustment))).toBeUndefined()
    }
  })

  it('allows only one ledger entry per event', () => {
    const invoiceEntry = { type: 'INVOICE', amount_minor: 233000, invoice_id: d.invoiceId }
    const voidEntry = { type: 'INVOICE_VOID', amount_minor: -233000, invoice_id: d.invoiceId }
    const paymentEntry = { type: 'PAYMENT', amount_minor: -50000, payment_id: d.paymentId }
    for (const entry of [{}, invoiceEntry, voidEntry, paymentEntry]) {
      insertRow(db, 'customer_ledger', rows.ledger(m, entry))
      expect(insertCode('customer_ledger', rows.ledger(m, entry))).toBe(UNIQUE)
    }
  })
})

describe('expenses and expense_categories', () => {
  const expense2 = (overrides: Row = {}): Row =>
    rows.expense(m, { request_id: 'expense-request-2', ...overrides })

  it.each([0, -1])('rejects the amount %i', (amount) => {
    expect(insertCode('expenses', expense2({ amount_minor: amount }))).toBe(CHECK)
  })

  it('rejects an unknown status and a duplicate request id', () => {
    expect(insertCode('expenses', expense2({ status: 'DELETED' }))).toBe(CHECK)
    insertRow(db, 'expenses', expense2())
    expect(insertCode('expenses', expense2())).toBe(UNIQUE)
  })

  it('rejects an unknown category group and a duplicate category name, ignoring letter case', () => {
    expect(insertCode('expense_categories', { name: 'Home', grp: 'HOME' })).toBe(CHECK)
    expect(insertCode('expense_categories', { name: 'shop expenses', grp: 'SHOP' })).toBe(UNIQUE)
  })

  it('cannot delete a category that has expenses', () => {
    insertRow(db, 'expenses', expense2())
    expect(deleteError('DELETE FROM expense_categories WHERE id = ?', [m.categoryId])).toEqual(
      RESTRICTED
    )
  })
})

describe('settings, sequences and schema_migrations', () => {
  it('stores each setting as JSON text under a unique key', () => {
    expect(insertCode('settings', { key: 'invoice.footer', value: 'Thank you' })).toBe(CHECK)
    expect(insertCode('settings', { key: 'invoice.footer', value: '"Thank you"' })).toBeUndefined()
    expect(insertCode('settings', { key: 'invoice.showInvoiceCode', value: null })).toBe(NOT_NULL)
    expect(insertCode('settings', { key: 'business.name', value: '"Other"' })).toBe(PRIMARY_KEY)
  })

  it('keeps sequence values positive and sequence names unique', () => {
    expect(runCode("UPDATE sequences SET next_value = 0 WHERE name = 'invoice'")).toBe(CHECK)
    expect(insertCode('sequences', { name: 'invoice', next_value: 5 })).toBe(PRIMARY_KEY)
  })

  it('accepts only sha256 checksums in schema_migrations', () => {
    const row = { version: 2, name: '0002_x', applied_at: TIMESTAMP, app_version: '1.0.1' }
    expect(insertCode('schema_migrations', { ...row, checksum: 'md5:0123' })).toBe(CHECK)
    expect(insertCode('schema_migrations', { ...row, checksum: `sha256:${'A'.repeat(64)}` })).toBe(
      CHECK
    )
    expect(
      insertCode('schema_migrations', { ...row, checksum: `sha256:${'a'.repeat(64)}` })
    ).toBeUndefined()
  })
})
