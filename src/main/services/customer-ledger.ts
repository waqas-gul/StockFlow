import type { LedgerEntryType } from '@shared/customers'
import { formatDisplayDate } from '@shared/dates'
import type { Db } from '../db/adapter'
import { AppFailure } from '../errors'

/*
 * The customer ledger rules every balance-changing transaction shares (plan §10, §11.5). Customers and payments use
 * them now; invoices and their voids will use the same functions:
 *
 * - a balance is never stored: it is Σ customer_ledger.amount_minor (positive: the customer owes the shop);
 * - entries are only appended, never updated or deleted (the schema's triggers refuse both);
 * - posting dates: never after today, and never before the customer's latest ledger entry. Only that customer's own
 *   ledger sets the floor, so activity of another customer never blocks an entry;
 * - after an entry is appended, the balance must still be a safe whole number, or the transaction rolls back.
 */

export interface CustomerRow {
  id: number
  code: string
  name: string
  shop_name: string | null
  phone: string | null
  address: string | null
  city: string | null
  notes: string | null
  is_active: number
  created_at: string
  updated_at: string
}

/** The customer, or NOT_FOUND (as a field error on `field` when the id came from a form field). */
export function customerRow(db: Db, id: number, field?: string): CustomerRow {
  const row = db.get<CustomerRow>(
    `SELECT id, code, name, shop_name, phone, address, city, notes, is_active, created_at, updated_at
     FROM customers WHERE id = ?`,
    [id]
  )
  if (row === undefined) throw customerNotFound(field)
  return row
}

export function customerNotFound(field?: string): AppFailure {
  const message = 'This customer no longer exists.'
  return new AppFailure({
    code: 'NOT_FOUND',
    message,
    ...(field === undefined ? {} : { fieldErrors: { [field]: [message] } })
  })
}

/** 'C-00002 Ali Raza (Ali Traders)'. */
export function customerLabel(row: Pick<CustomerRow, 'code' | 'name' | 'shop_name'>): string {
  return `${row.code} ${row.name}${row.shop_name === null ? '' : ` (${row.shop_name})`}`
}

/** Σ of the customer's ledger entries (0 without entries). */
export function customerBalance(db: Db, customerId: number): number {
  return db.get<{ total: number }>(
    'SELECT coalesce(sum(amount_minor), 0) AS total FROM customer_ledger WHERE customer_id = ?',
    [customerId]
  )!.total
}

/** The customer's latest ledger entry date: the posting-date floor. Null without entries. */
export function latestLedgerDate(db: Db, customerId: number): string | null {
  return db.get<{ latest: string | null }>(
    'SELECT max(entry_date) AS latest FROM customer_ledger WHERE customer_id = ?',
    [customerId]
  )!.latest
}

export function hasLedgerEntries(db: Db, customerId: number): boolean {
  return (
    db.get<{ found: number }>(
      'SELECT EXISTS (SELECT 1 FROM customer_ledger WHERE customer_id = ?) AS found',
      [customerId]
    )?.found === 1
  )
}

export interface CustomerPostingDateCheck {
  readonly date: string
  /** The main process's calendar day. */
  readonly today: string
  readonly customer: CustomerRow
  /** The form field the date was entered in, for the field error. */
  readonly field?: string
}

/**
 * A balance-changing entry's date must not be later than today, nor earlier than the customer's latest ledger entry
 * (the per-customer posting floor, plan §11.5). Otherwise DATE_NOT_ALLOWED names the customer and the earliest date.
 */
export function assertCustomerPostingDate(db: Db, check: CustomerPostingDateCheck): void {
  const { date, today, customer, field } = check
  if (date > today) {
    throw dateFailure(`The date cannot be later than today (${formatDisplayDate(today)}).`, field, {
      latestDate: today
    })
  }
  const floor = latestLedgerDate(db, customer.id)
  if (floor !== null && date < floor) {
    throw dateFailure(
      `${customerLabel(customer)} has account activity on ${formatDisplayDate(floor)}. Use that date or later.`,
      field,
      { earliestDate: floor, customerId: customer.id, customerCode: customer.code }
    )
  }
}

export interface LedgerEntryInput {
  readonly customerId: number
  readonly date: string
  readonly type: LedgerEntryType
  /** Signed: positive when the customer owes more. */
  readonly amountMinor: number
  readonly paymentId?: number
  readonly note?: string | null
}

/**
 * Appends one ledger entry and returns its id. The customer's new balance must still be a safe whole number; otherwise
 * the thrown VALIDATION failure rolls the caller's transaction back.
 */
export function appendLedgerEntry(db: Db, entry: LedgerEntryInput): number {
  if (!db.inTransaction) throw new Error('Ledger entries are appended inside a transaction.')
  const id = Number(
    db.run(
      `INSERT INTO customer_ledger (customer_id, entry_date, type, amount_minor, payment_id, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entry.customerId,
        entry.date,
        entry.type,
        entry.amountMinor,
        entry.paymentId ?? null,
        entry.note ?? null
      ]
    ).lastInsertRowid
  )
  if (!Number.isSafeInteger(customerBalance(db, entry.customerId))) {
    throw new AppFailure({
      code: 'VALIDATION',
      message: 'The amount is too large: the customer balance could not be kept exactly.'
    })
  }
  return id
}

function dateFailure(message: string, field: string | undefined, details: unknown): AppFailure {
  return new AppFailure({
    code: 'DATE_NOT_ALLOWED',
    message,
    ...(field === undefined ? {} : { fieldErrors: { [field]: [message] } }),
    details
  })
}
