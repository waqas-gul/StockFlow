import { formatDisplayDate } from '@shared/dates'
import type { SupplierLedgerType } from '@shared/suppliers'
import type { Db } from '../db/adapter'
import { AppFailure } from '../errors'

/*
 * The supplier ledger rules every supplier balance change shares (migration 0003): opening balances, Stock In
 * purchases and their voids, supplier payments and their voids, and balance adjustments.
 *
 * - a balance is never stored: it is Σ supplier_ledger.amount_minor (positive: the shop owes the supplier);
 * - entries are only appended, never updated or deleted (the schema's triggers refuse both);
 * - posting dates: never after today, and never before the supplier's latest ledger entry. Only that supplier's own
 *   ledger sets the floor, so activity of another supplier never blocks an entry;
 * - after an entry is appended, the balance must still be a safe whole number, or the transaction rolls back.
 */

export interface SupplierRow {
  id: number
  code: string
  name: string
  contact_person: string | null
  phone: string | null
  address: string | null
  city: string | null
  notes: string | null
  is_active: number
  created_at: string
  updated_at: string
}

/** The supplier, or NOT_FOUND (as a field error on `field` when the id came from a form field). */
export function supplierRow(db: Db, id: number, field?: string): SupplierRow {
  const row = db.get<SupplierRow>(
    `SELECT id, code, name, contact_person, phone, address, city, notes, is_active, created_at, updated_at
     FROM suppliers WHERE id = ?`,
    [id]
  )
  if (row === undefined) throw supplierNotFound(field)
  return row
}

export function supplierNotFound(field?: string): AppFailure {
  const message = 'This supplier no longer exists.'
  return new AppFailure({
    code: 'NOT_FOUND',
    message,
    ...(field === undefined ? {} : { fieldErrors: { [field]: [message] } })
  })
}

/** 'SUP-00001 ABC Distributors'. */
export function supplierLabel(row: Pick<SupplierRow, 'code' | 'name'>): string {
  return `${row.code} ${row.name}`
}

/** Σ of the supplier's ledger entries (0 without entries). */
export function supplierBalance(db: Db, supplierId: number): number {
  return db.get<{ total: number }>(
    'SELECT coalesce(sum(amount_minor), 0) AS total FROM supplier_ledger WHERE supplier_id = ?',
    [supplierId]
  )!.total
}

/** The supplier's latest ledger entry date: the posting-date floor. Null without entries. */
export function latestSupplierLedgerDate(db: Db, supplierId: number): string | null {
  return db.get<{ latest: string | null }>(
    'SELECT max(entry_date) AS latest FROM supplier_ledger WHERE supplier_id = ?',
    [supplierId]
  )!.latest
}

export function hasSupplierLedgerEntries(db: Db, supplierId: number): boolean {
  return (
    db.get<{ found: number }>(
      'SELECT EXISTS (SELECT 1 FROM supplier_ledger WHERE supplier_id = ?) AS found',
      [supplierId]
    )?.found === 1
  )
}

export interface SupplierPostingDateCheck {
  readonly date: string
  /** The main process's calendar day. */
  readonly today: string
  readonly supplier: SupplierRow
  /** The form field the date was entered in, for the field error. */
  readonly field?: string
}

/**
 * A supplier balance change's date must not be later than today, nor earlier than the supplier's latest ledger entry
 * (the per-supplier posting floor). Otherwise DATE_NOT_ALLOWED names the supplier and the earliest date.
 */
export function assertSupplierPostingDate(db: Db, check: SupplierPostingDateCheck): void {
  const { date, today, supplier, field } = check
  if (date > today) {
    throw supplierDateFailure(
      `The date cannot be later than today (${formatDisplayDate(today)}).`,
      field,
      { latestDate: today }
    )
  }
  const floor = latestSupplierLedgerDate(db, supplier.id)
  if (floor !== null && date < floor) {
    throw supplierDateFailure(
      `${supplierLabel(supplier)} has account activity on ${formatDisplayDate(floor)}. Use that date or later.`,
      field,
      { earliestDate: floor, supplierId: supplier.id, supplierCode: supplier.code }
    )
  }
}

export interface SupplierLedgerEntryInput {
  readonly supplierId: number
  readonly date: string
  readonly type: SupplierLedgerType
  /** Signed: positive when the shop owes the supplier more. */
  readonly amountMinor: number
  readonly receiptId?: number
  readonly paymentId?: number
  readonly note?: string | null
}

/**
 * Appends one supplier ledger entry and returns its id. The supplier's new balance must still be a safe whole number;
 * otherwise the thrown VALIDATION failure rolls the caller's transaction back.
 */
export function appendSupplierLedgerEntry(db: Db, entry: SupplierLedgerEntryInput): number {
  if (!db.inTransaction)
    throw new Error('Supplier ledger entries are appended inside a transaction.')
  const id = Number(
    db.run(
      `INSERT INTO supplier_ledger (supplier_id, entry_date, type, amount_minor, stock_receipt_id, supplier_payment_id,
         note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.supplierId,
        entry.date,
        entry.type,
        entry.amountMinor,
        entry.receiptId ?? null,
        entry.paymentId ?? null,
        entry.note ?? null
      ]
    ).lastInsertRowid
  )
  if (!Number.isSafeInteger(supplierBalance(db, entry.supplierId))) {
    throw new AppFailure({
      code: 'VALIDATION',
      message: 'The amount is too large: the supplier balance could not be kept exactly.'
    })
  }
  return id
}

export function supplierDateFailure(
  message: string,
  field: string | undefined,
  details: unknown
): AppFailure {
  return new AppFailure({
    code: 'DATE_NOT_ALLOWED',
    message,
    ...(field === undefined ? {} : { fieldErrors: { [field]: [message] } }),
    details
  })
}
