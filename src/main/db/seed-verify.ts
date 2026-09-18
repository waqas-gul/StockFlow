import { win32 } from 'node:path'
import { openDatabase } from './connection'
import { runIntegrityCheck } from './integrity'
import { migrations } from './migrations'

/*
 * Runs the app's own Maintenance > Check integrity report against a seeded database, so a demo database is
 * proved to obey the same rules a real one does. Read-only; used by `npm run seed:verify`.
 */

/** A one-line answer each, so a seeded database can be judged without opening the app. Every query is fixed text. */
const HIGHLIGHTS: ReadonlyArray<readonly [string, string]> = [
  [
    'Products in stock',
    `SELECT count(*) || ' of ' || (SELECT count(*) FROM products) AS value
     FROM v_product_stock WHERE qty_base > 0`
  ],
  [
    'Products below their threshold',
    `SELECT count(*) AS value FROM products AS p JOIN v_product_stock AS s ON s.product_id = p.id
     WHERE p.low_stock_threshold_base > 0 AND s.qty_base <= p.low_stock_threshold_base`
  ],
  [
    'Customers owing / advance / settled',
    `SELECT sum(balance_minor > 0) || ' / ' || sum(balance_minor < 0) || ' / ' || sum(balance_minor = 0) AS value
     FROM v_customer_balance`
  ],
  [
    'Posted / void invoices',
    `SELECT sum(status = 'POSTED') || ' / ' || sum(status = 'VOID') AS value FROM invoices`
  ],
  ['Invoice numbers', `SELECT min(invoice_no) || ' .. ' || max(invoice_no) AS value FROM invoices`],
  [
    'Sales / cost of goods sold',
    `SELECT (sum(total_minor) / 100) || ' / ' || (sum(cogs_minor) / 100) AS value
     FROM invoices WHERE status = 'POSTED'`
  ],
  [
    'Expenses (active)',
    `SELECT count(*) || ' worth ' || (sum(amount_minor) / 100) AS value FROM expenses WHERE status = 'ACTIVE'`
  ],
  [
    'Suppliers owed / advance / settled',
    `SELECT sum(balance_minor > 0) || ' / ' || sum(balance_minor < 0) || ' / ' || sum(balance_minor = 0) AS value
     FROM v_supplier_balance`
  ],
  [
    'Receipts on account / cash',
    `SELECT sum(supplier_id IS NOT NULL) || ' / ' || sum(supplier_id IS NULL) AS value FROM stock_receipts`
  ],
  [
    'Purchases / paid to suppliers',
    `SELECT ((SELECT sum(total_cost_minor) FROM stock_receipts WHERE status = 'POSTED' AND supplier_id IS NOT NULL) / 100)
            || ' / ' ||
            ((SELECT sum(amount_minor) FROM supplier_payments WHERE status = 'POSTED') / 100) AS value`
  ],
  [
    'Supplier payments posted / void',
    `SELECT sum(status = 'POSTED') || ' / ' || sum(status = 'VOID') AS value FROM supplier_payments`
  ],
  ['Stock movement types', `SELECT group_concat(DISTINCT type) AS value FROM stock_movements`],
  ['Customer ledger types', `SELECT group_concat(DISTINCT type) AS value FROM customer_ledger`],
  ['Supplier ledger types', `SELECT group_concat(DISTINCT type) AS value FROM supplier_ledger`],
  ['Payment methods', `SELECT group_concat(DISTINCT method) AS value FROM payments`]
]

const root = process.argv[2]
if (root === undefined) throw new Error('Usage: seed-verify <data root>')

const db = openDatabase(win32.join(root, 'data', 'shop.db'))
try {
  const report = runIntegrityCheck(db, { migrations })
  console.log(`Integrity report: ${report.status} (schema ${report.schemaVersion})\n`)
  for (const check of report.checks) {
    console.log(`  ${check.status.padEnd(5)} ${check.title}: ${check.summary}`)
    for (const issue of check.issues) console.log(`          - ${issue}`)
  }
  console.log('\nWhat the screens will show:\n')
  for (const [label, sql] of HIGHLIGHTS) {
    console.log(`  ${label.padEnd(36)} ${db.get<{ value: string }>(sql)!.value}`)
  }
  process.exitCode = report.status === 'OK' ? 0 : 1
} finally {
  db.close()
}
