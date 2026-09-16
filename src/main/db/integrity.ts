import type { Db } from './adapter'
import { STOCKFLOW_APPLICATION_ID, readApplicationId, readUserVersion } from './connection'
import type { Migration } from './migrate'
import { foreignKeyViolations, integrityProblems } from './verify'

/*
 * The integrity check engine (plan §7.5): database-level checks plus the invariants that can be checked against
 * the V1 schema today. It only reads and reports; it never fixes anything. Later phases add document-level checks
 * (invoice totals, one SALE movement per line, …) when the services that write those documents exist.
 */

export type CheckStatus = 'OK' | 'WARNING' | 'ERROR'

export type IntegrityCheckId =
  | 'sqlite.integrity'
  | 'sqlite.foreign-keys'
  | 'database.application-id'
  | 'database.schema-version'
  | 'schema.history'
  | 'inventory.stock'
  | 'ledger.entries'
  | 'ledger.balances'

export interface IntegrityCheckResult {
  readonly id: IntegrityCheckId
  readonly title: string
  readonly status: CheckStatus
  /** One human-readable sentence. */
  readonly summary: string
  /** The specific findings, at most 20 (then "… and N more."). */
  readonly issues: readonly string[]
}

export interface IntegrityReport {
  /** The worst status of any check. */
  readonly status: CheckStatus
  readonly checkedAt: string
  readonly schemaVersion: number
  readonly checks: readonly IntegrityCheckResult[]
}

export interface IntegrityCheckOptions {
  /** This app's migrations, whose names and checksums the recorded schema history must match. */
  readonly migrations: readonly Migration[]
  readonly now?: () => Date
}

const MAX_ISSUES = 20

/** The summary of a check that could not run; it is reported as an ERROR. */
export const CHECK_FAILED_SUMMARY = 'The check could not run.'

interface Finding {
  readonly status: CheckStatus
  readonly summary: string
  readonly issues: readonly string[]
}

/** Runs every check against `db` and returns the report. Read-only. */
export function runIntegrityCheck(db: Db, options: IntegrityCheckOptions): IntegrityReport {
  const schemaVersion = readUserVersion(db)
  // The business checks need the V1 tables, which exist from schema 1.
  const hasSchema = schemaVersion >= 1
  const checks = [
    runCheck('sqlite.integrity', 'SQLite integrity check', () => sqliteIntegrity(db)),
    runCheck('sqlite.foreign-keys', 'Foreign keys', () => foreignKeys(db)),
    runCheck('database.application-id', 'StockFlow database marker', () => applicationId(db)),
    runCheck('database.schema-version', 'Schema version', () =>
      schemaVersionFinding(schemaVersion, options.migrations.length)
    ),
    checkSchemaHistory(db, options.migrations),
    businessCheck('inventory.stock', 'Stock quantities and values', hasSchema, () => inventory(db)),
    businessCheck('ledger.entries', 'Customer ledger entries', hasSchema, () => ledgerEntries(db)),
    businessCheck('ledger.balances', 'Customer balances', hasSchema, () => ledgerBalances(db))
  ]
  const now = options.now ?? (() => new Date())
  return { status: worst(checks), checkedAt: now().toISOString(), schemaVersion, checks }
}

/**
 * Compares `schema_migrations` with PRAGMA user_version and with this app's migrations (names and pinned checksums).
 * A mismatch is reported, never corrected: the recorded history is left exactly as it is.
 */
export function checkSchemaHistory(db: Db, migrations: readonly Migration[]): IntegrityCheckResult {
  return runCheck('schema.history', 'Schema history and checksums', () => {
    const version = readUserVersion(db)
    if (!objectExists(db, 'schema_migrations')) {
      if (version === 0) return ok('No migrations have been applied yet.')
      return error('The schema history is missing.', [
        `The schema_migrations table is missing; PRAGMA user_version is ${version}.`
      ])
    }
    const rows = db.all<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
    )
    const issues: string[] = []
    const recorded = rows.map((row) => row.version).join(', ')
    const expected = Array.from({ length: Math.max(version, 0) }, (_, index) => index + 1).join(
      ', '
    )
    if (recorded !== expected) {
      issues.push(
        `schema_migrations records versions ${recorded || 'none'}, but the schema version is ${version}.`
      )
    }
    for (const row of rows) {
      const migration = migrations[row.version - 1]
      if (migration === undefined) {
        issues.push(
          `Migration ${row.version} (${row.name}) is newer than this version of StockFlow.`
        )
        continue
      }
      if (row.name !== migration.name) {
        issues.push(
          `Migration ${row.version} is recorded as ${row.name}, but this version of StockFlow names it ${migration.name}.`
        )
      }
      if (row.checksum !== migration.checksum) {
        issues.push(
          `Migration ${migration.name} was applied with checksum ${row.checksum}, but this version of ` +
            `StockFlow has ${migration.checksum}: the schema may have been changed outside StockFlow.`
        )
      }
    }
    if (issues.length > 0) {
      return error('The recorded schema history does not match this version of StockFlow.', issues)
    }
    return ok(`${rows.length} applied migration(s) match this version of StockFlow.`)
  })
}

function sqliteIntegrity(db: Db): Finding {
  const problems = integrityProblems(db)
  if (problems.length === 0) return ok('PRAGMA integrity_check reported "ok".')
  return error(
    `PRAGMA integrity_check reported ${problems.length} problem(s). Restore a recent backup.`,
    problems
  )
}

function foreignKeys(db: Db): Finding {
  const violations = foreignKeyViolations(db)
  if (violations.length === 0) return ok('Every reference points to an existing row.')
  const groups = new Map<
    string,
    { table: string; parent: string; count: number; first: number | null }
  >()
  for (const violation of violations) {
    const key = `${violation.table} ${violation.parent}`
    const group = groups.get(key)
    if (group) group.count++
    else groups.set(key, { ...violation, count: 1, first: violation.rowid })
  }
  return error(
    `${violations.length} row(s) refer to rows that do not exist.`,
    [...groups.values()].map(
      (group) =>
        `${group.table}: ${group.count} row(s) refer to missing rows of ${group.parent} (first rowid ${String(group.first)}).`
    )
  )
}

function applicationId(db: Db): Finding {
  const id = readApplicationId(db)
  if (id === STOCKFLOW_APPLICATION_ID) return ok('The file is marked as a StockFlow database.')
  return error(`The application_id is ${id}, not StockFlow's ${STOCKFLOW_APPLICATION_ID}.`, [])
}

function schemaVersionFinding(version: number, latest: number): Finding {
  if (version < 0) return error(`The schema version ${version} is not valid.`, [])
  if (version > latest) {
    return error(
      `The database uses schema ${version}, newer than the schema ${latest} this version of StockFlow supports.`,
      []
    )
  }
  if (version < latest) {
    return {
      status: 'WARNING',
      summary: `The database uses schema ${version}; this version of StockFlow uses schema ${latest}. Migrations are pending.`,
      issues: []
    }
  }
  return ok(`Schema ${version}, the newest this version of StockFlow supports.`)
}

/** For every product: Q = Σ qty_base ≥ 0, V = Σ value_minor ≥ 0, Q = 0 ⇒ V = 0, and v_product_stock agrees. */
function inventory(db: Db): Finding {
  const products = db.all<{ id: number; code: string; qty: number; value: number }>(`
    SELECT p.id AS id, p.code AS code,
           coalesce(sum(m.qty_base), 0) AS qty, coalesce(sum(m.value_minor), 0) AS value
    FROM products AS p
    LEFT JOIN stock_movements AS m ON m.product_id = p.id
    GROUP BY p.id
    ORDER BY p.id
  `)
  const view = new Map(
    db
      .all<{ product_id: number; qty_base: number; value_minor: number }>(
        'SELECT product_id, qty_base, value_minor FROM v_product_stock'
      )
      .map((row) => [row.product_id, row])
  )
  const issues: string[] = []
  for (const product of products) {
    const label = `Product ${product.code} (id ${product.id})`
    if (product.qty < 0) issues.push(`${label}: stock is ${product.qty} base units.`)
    if (product.value < 0) issues.push(`${label}: stock value is ${product.value} minor units.`)
    if (product.qty === 0 && product.value !== 0) {
      issues.push(
        `${label}: no stock is left but a stock value of ${product.value} minor units remains.`
      )
    }
    const shown = view.get(product.id)
    if (
      shown === undefined ||
      shown.qty_base !== product.qty ||
      shown.value_minor !== product.value
    ) {
      issues.push(
        `v_product_stock disagrees with the stock movements for product ${product.code} (id ${product.id}).`
      )
    }
  }
  if (issues.length > 0) {
    return error(`${issues.length} problem(s) found in stock quantities and values.`, issues)
  }
  return ok(`${products.length} product(s) checked: stock quantities and values are consistent.`)
}

/**
 * Every ledger entry has the sign and references its type requires, and an entry for an invoice or a payment is
 * on that document's customer.
 */
function ledgerEntries(db: Db): Finding {
  const issues: string[] = []
  const wrongShape = db.all<{ id: number; type: string; amount_minor: number }>(`
    SELECT id, type, amount_minor FROM customer_ledger
    WHERE NOT (CASE type
      WHEN 'OPENING' THEN amount_minor <> 0 AND invoice_id IS NULL AND payment_id IS NULL
      WHEN 'ADJUSTMENT' THEN amount_minor <> 0 AND invoice_id IS NULL AND payment_id IS NULL
        AND trim(coalesce(note, '')) <> ''
      WHEN 'INVOICE' THEN amount_minor > 0 AND invoice_id IS NOT NULL AND payment_id IS NULL
      WHEN 'INVOICE_VOID' THEN amount_minor < 0 AND invoice_id IS NOT NULL AND payment_id IS NULL
      WHEN 'PAYMENT' THEN amount_minor < 0 AND payment_id IS NOT NULL
      WHEN 'PAYMENT_VOID' THEN amount_minor > 0 AND payment_id IS NOT NULL
      ELSE 0
    END)
    ORDER BY id
  `)
  for (const entry of wrongShape) {
    issues.push(
      `Ledger entry ${entry.id} (${entry.type}, ${entry.amount_minor}): the amount sign or references do not match the entry type.`
    )
  }
  const otherCustomer = db.all<{
    id: number
    type: string
    customer_id: number
    invoice_id: number | null
    invoice_customer: number | null
    payment_id: number | null
    payment_customer: number | null
  }>(`
    SELECT l.id, l.type, l.customer_id, l.invoice_id, i.customer_id AS invoice_customer,
           l.payment_id, p.customer_id AS payment_customer
    FROM customer_ledger AS l
    LEFT JOIN invoices AS i ON i.id = l.invoice_id
    LEFT JOIN payments AS p ON p.id = l.payment_id
    WHERE (l.invoice_id IS NOT NULL AND i.customer_id IS NOT l.customer_id)
       OR (l.payment_id IS NOT NULL AND p.customer_id IS NOT l.customer_id)
    ORDER BY l.id
  `)
  for (const entry of otherCustomer) {
    const documents = [
      ['invoice', entry.invoice_id, entry.invoice_customer],
      ['payment', entry.payment_id, entry.payment_customer]
    ] as const
    for (const [kind, documentId, owner] of documents) {
      if (documentId !== null && owner !== entry.customer_id) {
        issues.push(
          `Ledger entry ${entry.id} (${entry.type}) is for customer ${entry.customer_id}, but its ${kind} belongs to customer ${owner ?? 'unknown'}.`
        )
      }
    }
  }
  if (issues.length > 0)
    return error(`${issues.length} problem(s) found in the customer ledger.`, issues)
  const [{ n }] = db.all<{ n: number }>('SELECT count(*) AS n FROM customer_ledger')
  return ok(`${n} ledger entries checked: signs, references and customers are consistent.`)
}

/** Every customer's balance in v_customer_balance equals the sum of their ledger entries. */
function ledgerBalances(db: Db): Finding {
  const differing = db.all<{ id: number; code: string; direct: number; shown: number | null }>(`
    SELECT id, code, direct, shown FROM (
      SELECT c.id AS id, c.code AS code,
             coalesce((SELECT sum(l.amount_minor) FROM customer_ledger AS l WHERE l.customer_id = c.id), 0) AS direct,
             b.balance_minor AS shown, b.customer_id AS listed
      FROM customers AS c
      LEFT JOIN v_customer_balance AS b ON b.customer_id = c.id
    )
    WHERE listed IS NULL OR shown IS NOT direct
    ORDER BY id
  `)
  if (differing.length > 0) {
    return error(
      `${differing.length} customer balance(s) differ from the ledger.`,
      differing.map(
        (customer) =>
          `Customer ${customer.code} (id ${customer.id}): v_customer_balance shows ${customer.shown ?? 'nothing'} but the ledger adds up to ${customer.direct}.`
      )
    )
  }
  const [{ n }] = db.all<{ n: number }>('SELECT count(*) AS n FROM customers')
  return ok(`${n} customer balance(s) match the ledger.`)
}

/** Runs one check. A check that throws is reported as an error: the report is always complete. */
function runCheck(id: IntegrityCheckId, title: string, check: () => Finding): IntegrityCheckResult {
  let finding: Finding
  try {
    finding = check()
  } catch (failure) {
    finding = error(CHECK_FAILED_SUMMARY, [
      failure instanceof Error ? failure.message : String(failure)
    ])
  }
  const { issues } = finding
  const shown =
    issues.length > MAX_ISSUES
      ? [...issues.slice(0, MAX_ISSUES), `… and ${issues.length - MAX_ISSUES} more.`]
      : issues
  return { id, title, status: finding.status, summary: finding.summary, issues: shown }
}

function businessCheck(
  id: IntegrityCheckId,
  title: string,
  applies: boolean,
  check: () => Finding
): IntegrityCheckResult {
  if (!applies) {
    return {
      id,
      title,
      status: 'OK',
      summary: 'Not applicable: the database has no schema yet.',
      issues: []
    }
  }
  return runCheck(id, title, check)
}

function ok(summary: string): Finding {
  return { status: 'OK', summary, issues: [] }
}

function error(summary: string, issues: readonly string[]): Finding {
  return { status: 'ERROR', summary, issues }
}

function worst(checks: readonly IntegrityCheckResult[]): CheckStatus {
  if (checks.some((item) => item.status === 'ERROR')) return 'ERROR'
  if (checks.some((item) => item.status === 'WARNING')) return 'WARNING'
  return 'OK'
}

function objectExists(db: Db, name: string): boolean {
  return db.get('SELECT 1 AS found FROM sqlite_schema WHERE name = ?', [name]) !== undefined
}
