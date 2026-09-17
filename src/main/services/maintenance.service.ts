import type {
  CheckStatus,
  IntegrityCheckItem,
  IntegrityCheckReport
} from '@shared/types/maintenance'
import type { Db } from '../db/adapter'
import type { DataSafetyContext } from '../db/context'
import {
  CHECK_FAILED_SUMMARY,
  runIntegrityCheck,
  type IntegrityCheckId,
  type IntegrityCheckResult
} from '../db/integrity'
import { createErrorRef } from '../logging'

type CheckWording = { readonly title: string } & Readonly<Record<CheckStatus, string>>

const NEEDS_ATTENTION = 'This check needs attention.'

/** Plain-language wording for each check. No SQL, pragma, table or checksum ever reaches the screen. */
const WORDING: Readonly<Record<IntegrityCheckId, CheckWording>> = {
  'sqlite.integrity': {
    title: 'Database file',
    OK: 'The database file is intact.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'The database file is damaged.'
  },
  'sqlite.foreign-keys': {
    title: 'Links between records',
    OK: 'Every record is linked to records that exist.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'Some records are linked to records that do not exist.'
  },
  'database.application-id': {
    title: 'StockFlow database',
    OK: 'The file is a StockFlow database.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'The file is not marked as a StockFlow database.'
  },
  'database.schema-version': {
    title: 'Database version',
    OK: 'The database version matches this version of StockFlow.',
    WARNING: 'The database is older than this version of StockFlow and still needs its update.',
    ERROR: 'The database version is not supported by this version of StockFlow.'
  },
  'schema.history': {
    title: 'Database structure',
    OK: 'The database structure matches this version of StockFlow.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'The recorded database structure does not match this version of StockFlow.'
  },
  'inventory.stock': {
    title: 'Stock quantities and values',
    OK: 'Stock quantities and values are consistent.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'Some stock quantities or values are not consistent.'
  },
  'ledger.entries': {
    title: 'Customer ledger',
    OK: 'Customer ledger entries are consistent.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'Some customer ledger entries are not consistent.'
  },
  'ledger.balances': {
    title: 'Customer balances',
    OK: 'Every customer balance matches the ledger.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'Some customer balances do not match the ledger.'
  },
  'invoices.totals': {
    title: 'Invoice lines and totals',
    OK: 'Every invoice line and total adds up.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'Some invoice lines or totals do not add up.'
  },
  'invoices.stock': {
    title: 'Invoice stock',
    OK: 'Every invoice took, and every void returned, exactly its own stock.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'The stock records of some invoices do not match the invoices.'
  },
  'invoices.accounts': {
    title: 'Invoice customer accounts',
    OK: 'Every invoice has the expected customer account entries and payment.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'Some invoices do not have the expected customer account entries or payment.'
  },
  'payments.ledger': {
    title: 'Payments',
    OK: 'Every payment, and every payment void, is on the customer account as expected.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'Some payments are missing from the customer account, or differ from it.'
  },
  'customers.walk-in': {
    title: 'Walk-in customer',
    OK: 'The walk-in customer account is at zero.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'The walk-in customer account is not at zero.'
  },
  'receipts.stock': {
    title: 'Stock receipts',
    OK: 'Every stock receipt line added, and every void removed, exactly its own stock.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'The stock records of some stock receipts do not match the receipts.'
  },
  'adjustments.stock': {
    title: 'Stock adjustments',
    OK: 'Every stock adjustment has exactly its own stock movement.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'The stock records of some stock adjustments do not match the adjustments.'
  },
  'dates.future': {
    title: 'Business dates',
    OK: 'No record is dated after today.',
    WARNING: NEEDS_ATTENTION,
    ERROR: 'Some records are dated after today.'
  }
}

const OVERALL: Readonly<Record<CheckStatus, string>> = {
  OK: 'No problems were found.',
  WARNING: 'Something needs attention. See the checks below.',
  ERROR:
    'Problems were found. Restore a recent verified backup, or contact support and give them the reference below.'
}

/**
 * The findings of these checks are technical (SQLite messages, table names, checksums) and can be logged. Those of
 * the business checks name products and customers, so only their number is logged, unless the check could not run:
 * its finding is then the SQLite error, never a record.
 */
const TECHNICAL_CHECKS: ReadonlySet<IntegrityCheckId> = new Set([
  'sqlite.integrity',
  'sqlite.foreign-keys',
  'database.application-id',
  'database.schema-version',
  'schema.history'
])

/**
 * Settings → Maintenance → Run Integrity Check: the Phase 4A integrity check, read-only, reported in plain language.
 * It never fixes anything. When a check does not pass, its technical findings are logged under a reference that the
 * report shows.
 */
export function integrityCheckReport(
  db: Db,
  ctx: Pick<DataSafetyContext, 'migrations' | 'now' | 'log'>
): IntegrityCheckReport {
  const started = Date.now()
  const report = runIntegrityCheck(db, { migrations: ctx.migrations, now: ctx.now })
  const failed = report.checks.filter((check) => check.status !== 'OK')
  const ref = failed.length === 0 ? null : createErrorRef()
  ctx.log.info('[maintenance] integrity check run', {
    status: report.status,
    ms: Date.now() - started,
    ref
  })
  for (const check of failed) {
    const loggable = TECHNICAL_CHECKS.has(check.id) || couldNotRun(check)
    ctx.log.warn('[maintenance] integrity check finding', {
      ref,
      check: check.id,
      status: check.status,
      findings: check.issues.length,
      detail: loggable ? [check.summary, ...check.issues].join(' | ') : null
    })
  }
  return {
    status: report.status,
    message: OVERALL[report.status],
    checkedAt: report.checkedAt,
    checks: report.checks.map(describeCheck),
    ref
  }
}

function describeCheck(check: IntegrityCheckResult): IntegrityCheckItem {
  const wording = WORDING[check.id]
  const message = couldNotRun(check) ? 'This check could not be completed.' : wording[check.status]
  return { id: check.id, title: wording.title, status: check.status, message }
}

function couldNotRun(check: IntegrityCheckResult): boolean {
  return check.status === 'ERROR' && check.summary === CHECK_FAILED_SUMMARY
}
