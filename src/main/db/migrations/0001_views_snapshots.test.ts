import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../adapter'
import {
  createSchemaDatabase,
  createTempDir,
  insertDocuments,
  insertMasters,
  insertRow,
  rows,
  type Documents,
  type Masters,
  type TempDir
} from '../test-utils'
import { initialMigration } from './0001_initial'

// Technical fixture rows in temporary databases only. Production seeds contain none of this.

let temp: TempDir
let db: Db
let m: Masters
let d: Documents

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp, [initialMigration])
  m = insertMasters(db)
  d = insertDocuments(db, m)
})

afterEach(() => {
  temp.remove()
})

describe('v_product_stock', () => {
  it('has the columns product_id, qty_base and value_minor', () => {
    expect(
      db.all<{ name: string }>('PRAGMA table_info(v_product_stock)').map((c) => c.name)
    ).toEqual(['product_id', 'qty_base', 'value_minor'])
  })

  it('sums quantity and value per product, and reports 0 for a product without movements', () => {
    const costCorrectionId = insertRow(
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
        value_minor: 1000,
        receipt_id: d.receiptId,
        reason_note: 'Supplier bill corrected'
      })
    )
    insertRow(db, 'stock_movements', rows.movement(m, { receipt_item_id: d.receiptItemId }))
    insertRow(
      db,
      'stock_movements',
      rows.movement(m, {
        movement_date: '2026-09-02',
        type: 'ADJUST_OUT',
        qty_base: -3,
        value_minor: -27000,
        adjustment_id: d.adjustmentId
      })
    )
    insertRow(
      db,
      'stock_movements',
      rows.movement(m, {
        movement_date: '2026-09-03',
        type: 'COST_CORRECTION',
        qty_base: 0,
        value_minor: 1000,
        adjustment_id: costCorrectionId
      })
    )
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

    expect(db.all('SELECT * FROM v_product_stock ORDER BY product_id')).toEqual([
      // 48 − 3 − 27 = 18 base units; 480,000 − 27,000 + 1,000 − 200,000 = 254,000 minor units.
      { product_id: m.productId, qty_base: 18, value_minor: 254000 },
      { product_id: m.otherProductId, qty_base: 0, value_minor: 0 }
    ])
    expect(db.get('SELECT * FROM v_product_stock WHERE product_id = ?', [m.productId])).toEqual({
      product_id: m.productId,
      qty_base: 18,
      value_minor: 254000
    })
  })

  it('follows new movements immediately: there is no stored stock figure to update', () => {
    insertRow(db, 'stock_movements', rows.movement(m, { receipt_item_id: d.receiptItemId }))
    expect(
      db.get('SELECT qty_base FROM v_product_stock WHERE product_id = ?', [m.productId])
    ).toEqual({
      qty_base: 48
    })
    insertRow(
      db,
      'stock_movements',
      rows.movement(m, {
        type: 'SALE',
        qty_base: -27,
        value_minor: -200000,
        invoice_item_id: d.invoiceItemId
      })
    )
    expect(
      db.get('SELECT qty_base FROM v_product_stock WHERE product_id = ?', [m.productId])
    ).toEqual({
      qty_base: 21
    })
  })
})

describe('v_customer_balance', () => {
  it('has the columns customer_id and balance_minor', () => {
    expect(
      db.all<{ name: string }>('PRAGMA table_info(v_customer_balance)').map((c) => c.name)
    ).toEqual(['customer_id', 'balance_minor'])
  })

  it('sums the ledger per customer, and reports 0 for a customer without entries', () => {
    insertRow(db, 'customer_ledger', rows.ledger(m, { entry_date: '2026-09-01' }))
    insertRow(
      db,
      'customer_ledger',
      rows.ledger(m, { type: 'INVOICE', amount_minor: 233000, invoice_id: d.invoiceId })
    )
    insertRow(
      db,
      'customer_ledger',
      rows.ledger(m, {
        type: 'PAYMENT',
        amount_minor: -50000,
        payment_id: d.paymentId,
        invoice_id: d.invoiceId
      })
    )

    expect(db.all('SELECT * FROM v_customer_balance ORDER BY customer_id')).toEqual([
      // The seeded walk-in customer has no entries.
      { customer_id: 1, balance_minor: 0 },
      // Opening 10,000 + invoice 233,000 − payment 50,000 = the invoice's net outstanding (193,000).
      { customer_id: m.customerId, balance_minor: 193000 }
    ])
    const invoice = db.get<{ net_outstanding_minor: number }>(
      'SELECT net_outstanding_minor FROM invoices WHERE id = ?',
      [d.invoiceId]
    )
    expect(invoice?.net_outstanding_minor).toBe(193000)
  })
})

describe('historical snapshots', () => {
  function savedInvoice(): unknown {
    return {
      header: db.get('SELECT * FROM invoices WHERE id = ?', [d.invoiceId]),
      items: db.all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY line_no', [
        d.invoiceId
      ]),
      quantities: db.all(
        'SELECT * FROM invoice_item_quantities WHERE invoice_item_id = ? ORDER BY id',
        [d.invoiceItemId]
      )
    }
  }

  it('keep an invoice exactly as saved when the customer, product, company and units change later', () => {
    const before = savedInvoice()

    db.run(
      "UPDATE customers SET name = 'Ali Khan', shop_name = 'Khan Traders', phone = '0311-7654321', address = 'New Road', city = 'Karachi' WHERE id = ?",
      [m.customerId]
    )
    db.run("UPDATE companies SET name = 'Acme Foods Ltd' WHERE id = ?", [m.companyId])
    db.run(
      "UPDATE products SET code = 'P-001-NEW', name = 'Tea 900g', packing_label = '1*24*24' WHERE id = ?",
      [m.productId]
    )
    db.run(
      "UPDATE product_units SET name = 'Carton', short_name = 'Ctn', base_qty = 12, wholesale_price_minor = 999999, retail_price_minor = 999999 WHERE id = ?",
      [m.boxId]
    )
    db.run('UPDATE product_units SET wholesale_price_minor = 20000 WHERE id = ?', [m.pieceId])

    expect(savedInvoice()).toEqual(before)
    expect(db.get('SELECT cust_name, cust_shop_name, cust_city FROM invoices')).toEqual({
      cust_name: 'Ali',
      cust_shop_name: 'Ali Traders',
      cust_city: 'Lahore'
    })
    expect(
      db.get('SELECT prod_code, prod_name, company_name, packing_label FROM invoice_items')
    ).toEqual({
      prod_code: 'P-001',
      prod_name: 'Tea 950g',
      company_name: 'Acme Foods',
      packing_label: '1*12*18'
    })
    expect(
      db.get(
        'SELECT unit_name, unit_base_qty, quantity, unit_price_minor, amount_minor, qty_base FROM invoice_item_quantities WHERE unit_id = ?',
        [m.boxId]
      )
    ).toEqual({
      unit_name: 'Box',
      unit_base_qty: 24,
      quantity: 1,
      unit_price_minor: 240000,
      amount_minor: 240000,
      qty_base: 24
    })
  })

  it('keep stock receipt lines exactly as saved when the unit changes later', () => {
    const before = db.all('SELECT * FROM stock_receipt_items')
    db.run("UPDATE product_units SET name = 'Carton', base_qty = 12 WHERE id = ?", [m.boxId])
    expect(db.all('SELECT * FROM stock_receipt_items')).toEqual(before)
    expect(db.get('SELECT unit_name, unit_base_qty, qty_base FROM stock_receipt_items')).toEqual({
      unit_name: 'Box',
      unit_base_qty: 24,
      qty_base: 48
    })
  })
})
