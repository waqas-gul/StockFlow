import type { ListPage } from '@shared/customers'
import { localDateString } from '@shared/dates'
import type { PaymentMethod, PaymentStatus } from '@shared/payments'
import { formatDocumentNumber } from '@shared/stock'
import {
  SUPPLIER_PAYMENT_NUMBER_PREFIX,
  SupplierPaymentCreateSchema,
  SupplierPaymentDuplicateCheckSchema,
  SupplierPaymentIdSchema,
  SupplierPaymentListInputSchema,
  SupplierPaymentVoidInputSchema,
  type DuplicateSupplierPaymentCheck,
  type SupplierPaymentDetail,
  type SupplierPaymentSaveResult,
  type SupplierPaymentSummary,
  type SupplierPaymentVoidResult
} from '@shared/suppliers'
import type { Db, SqlValue } from '../db/adapter'
import { AppFailure, parseInput } from '../errors'
import { takeSequenceValue } from './sequences'
import { assertCurrencyDigits } from './settings.service'
import {
  appendSupplierLedgerEntry,
  assertSupplierPostingDate,
  supplierBalance,
  supplierRow
} from './supplier-ledger'

/*
 * Supplier payments (migration 0003): money the shop pays a supplier. A payment settles what the shop owes; it is never
 * an expense and never part of the Profit & Loss (the goods already went into inventory when they were received).
 *
 * - Posting is one transaction: request id (a retry returns the saved payment) → currency, supplier and posting date →
 *   SPAY- number from the `supplier_payment` sequence → supplier_payments row → PAYMENT ledger entry of −amount. Nothing
 *   is saved, and no number is used, when any step fails.
 * - A payment may exceed what the shop owes: the rest is a supplier advance (a negative balance). An inactive supplier
 *   can still be paid, so old debts can be settled.
 * - A saved payment is never edited. A void, dated today, sets POSTED → VOID with its reason and appends a PAYMENT_VOID
 *   entry of +amount, in one transaction; the PAYMENT entry is never changed.
 * - The same supplier, date and amount as a posted payment is only a warning (checkDuplicateSupplierPayment).
 */

const MAX_SEARCH_WORDS = 8

interface PaymentRow {
  id: number
  payment_no: string
  payment_date: string
  supplier_id: number
  supplier_code: string
  supplier_name: string
  supplier_active: number
  amount_minor: number
  method: PaymentMethod
  reference: string | null
  note: string | null
  status: PaymentStatus
  void_reason: string | null
  void_date: string | null
  voided_at: string | null
  created_at: string
  receipt_id: number | null
  receipt_no: string | null
  receipt_status: PaymentStatus | null
}

const SELECT_PAYMENTS = `
  SELECT p.id, p.payment_no, p.payment_date, p.supplier_id, s.code AS supplier_code, s.name AS supplier_name,
         s.is_active AS supplier_active, p.amount_minor, p.method, p.reference, p.note, p.status, p.void_reason,
         p.void_date, p.voided_at, p.created_at, p.stock_receipt_id AS receipt_id, r.receipt_no,
         r.status AS receipt_status
  FROM supplier_payments AS p
  JOIN suppliers AS s ON s.id = p.supplier_id
  LEFT JOIN stock_receipts AS r ON r.id = p.stock_receipt_id`

/** Pay Supplier: posts a payment and its PAYMENT ledger entry. A repeated request id returns the payment already saved. */
export function createSupplierPayment(
  db: Db,
  input: unknown,
  now: Date
): SupplierPaymentSaveResult {
  const payment = parseInput(SupplierPaymentCreateSchema, input)
  return db.transaction(() => {
    const saved = db.get<{ id: number }>('SELECT id FROM supplier_payments WHERE request_id = ?', [
      payment.requestId
    ])
    if (saved !== undefined) return saveResult(db, saved.id, true)

    assertCurrencyDigits(db, payment.currencyMinorDigits)
    const supplier = supplierRow(db, payment.supplierId, 'supplierId')
    assertSupplierPostingDate(db, {
      date: payment.paymentDate,
      today: localDateString(now),
      supplier,
      field: 'paymentDate'
    })
    const id = insertSupplierPayment(db, { ...payment, supplierId: supplier.id, receiptId: null })
    return saveResult(db, id, false)
  })
}

export interface SupplierPaymentPosting {
  readonly requestId: string
  readonly supplierId: number
  readonly paymentDate: string
  /** Above zero. */
  readonly amountMinor: number
  readonly method: PaymentMethod
  readonly reference: string | null
  readonly note: string | null
  /** The Stock In receipt the payment is made with ("paid now"). */
  readonly receiptId: number | null
}

/**
 * Writes a supplier payment: the next SPAY- number, the supplier_payments row and its PAYMENT ledger entry of −amount.
 * Runs inside the caller's transaction, after the caller has checked the supplier and the posting date. Returns its id.
 */
export function insertSupplierPayment(db: Db, payment: SupplierPaymentPosting): number {
  const paymentNo = formatDocumentNumber(
    SUPPLIER_PAYMENT_NUMBER_PREFIX,
    takeSequenceValue(db, 'supplier_payment')
  )
  const id = Number(
    db.run(
      `INSERT INTO supplier_payments (payment_no, request_id, supplier_id, payment_date, amount_minor, method, reference,
         note, stock_receipt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        paymentNo,
        payment.requestId,
        payment.supplierId,
        payment.paymentDate,
        payment.amountMinor,
        payment.method,
        payment.reference,
        payment.note,
        payment.receiptId
      ]
    ).lastInsertRowid
  )
  appendSupplierLedgerEntry(db, {
    supplierId: payment.supplierId,
    date: payment.paymentDate,
    type: 'PAYMENT',
    amountMinor: -payment.amountMinor,
    paymentId: id
  })
  return id
}

/** One supplier payment as saved. */
export function getSupplierPayment(db: Db, id: unknown): SupplierPaymentDetail {
  return readPayment(db, parseInput(SupplierPaymentIdSchema, id))
}

/** Supplier payments, newest first, filtered by search words, supplier, date range, status and method. */
export function listSupplierPayments(db: Db, input: unknown): ListPage<SupplierPaymentSummary> {
  const filters = parseInput(SupplierPaymentListInputSchema, input)
  const { page, pageSize } = filters
  const clauses: string[] = []
  const params: SqlValue[] = []
  const words = filters.search
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, MAX_SEARCH_WORDS)
  for (const word of words) {
    const pattern = `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    clauses.push(
      `(${['p.payment_no', 'p.reference', 's.code', 's.name']
        .map((column) => `${column} LIKE ? ESCAPE '\\'`)
        .join(' OR ')})`
    )
    params.push(pattern, pattern, pattern, pattern)
  }
  if (filters.supplierId !== null) {
    clauses.push('p.supplier_id = ?')
    params.push(filters.supplierId)
  }
  if (filters.status !== 'all') {
    clauses.push('p.status = ?')
    params.push(filters.status)
  }
  if (filters.method !== 'all') {
    clauses.push('p.method = ?')
    params.push(filters.method)
  }
  if (filters.dateFrom !== null) {
    clauses.push('p.payment_date >= ?')
    params.push(filters.dateFrom)
  }
  if (filters.dateTo !== null) {
    clauses.push('p.payment_date <= ?')
    params.push(filters.dateTo)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM supplier_payments AS p JOIN suppliers AS s ON s.id = p.supplier_id ${where}`,
    params
  )!.n
  const rows = db.all<PaymentRow>(
    `${SELECT_PAYMENTS} ${where} ORDER BY p.payment_date DESC, p.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  )
  return { items: rows.map(toSummary), total, page, pageSize }
}

/** Posted payments of the same supplier, date and amount: the operator is warned, and may still save. */
export function checkDuplicateSupplierPayment(
  db: Db,
  input: unknown
): DuplicateSupplierPaymentCheck {
  const { supplierId, paymentDate, amountMinor } = parseInput(
    SupplierPaymentDuplicateCheckSchema,
    input
  )
  const rows = db.all<PaymentRow>(
    `${SELECT_PAYMENTS}
     WHERE p.supplier_id = ? AND p.payment_date = ? AND p.amount_minor = ? AND p.status = 'POSTED'
     ORDER BY p.id`,
    [supplierId, paymentDate, amountMinor]
  )
  return { duplicates: rows.map(toSummary) }
}

/** Voids a posted supplier payment, dated today: POSTED → VOID and a PAYMENT_VOID entry of +amount, together. */
export function voidSupplierPayment(db: Db, input: unknown, now: Date): SupplierPaymentVoidResult {
  const { id, reason } = parseInput(SupplierPaymentVoidInputSchema, input)
  return db.transaction(() => {
    const payment = paymentRow(db, id)
    if (payment.status === 'VOID') {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: `Supplier payment ${payment.payment_no} is already void.`
      })
    }
    const supplier = supplierRow(db, payment.supplier_id)
    const today = localDateString(now)
    assertSupplierPostingDate(db, { date: today, today, supplier })
    db.run(
      "UPDATE supplier_payments SET status = 'VOID', void_reason = ?, voided_at = ?, void_date = ? WHERE id = ?",
      [reason, now.toISOString(), today, id]
    )
    appendSupplierLedgerEntry(db, {
      supplierId: supplier.id,
      date: today,
      type: 'PAYMENT_VOID',
      amountMinor: payment.amount_minor,
      paymentId: id,
      note: reason
    })
    return { ...readPayment(db, id), balanceAfterMinor: supplierBalance(db, supplier.id) }
  })
}

/** The payments made with one receipt ("paid now"), oldest first. */
export function receiptSupplierPayments(db: Db, receiptId: number): SupplierPaymentSummary[] {
  return db
    .all<PaymentRow>(`${SELECT_PAYMENTS} WHERE p.stock_receipt_id = ? ORDER BY p.id`, [receiptId])
    .map(toSummary)
}

function saveResult(db: Db, id: number, replayed: boolean): SupplierPaymentSaveResult {
  const payment = readPayment(db, id)
  return { ...payment, balanceAfterMinor: supplierBalance(db, payment.supplierId), replayed }
}

function readPayment(db: Db, id: number): SupplierPaymentDetail {
  const row = paymentRow(db, id)
  return {
    ...toSummary(row),
    supplierActive: row.supplier_active === 1,
    note: row.note,
    receiptStatus: row.receipt_status,
    voidReason: row.void_reason,
    voidDate: row.void_date,
    voidedAt: row.voided_at
  }
}

function paymentRow(db: Db, id: number): PaymentRow {
  const row = db.get<PaymentRow>(`${SELECT_PAYMENTS} WHERE p.id = ?`, [id])
  if (row === undefined) {
    throw new AppFailure({ code: 'NOT_FOUND', message: 'This supplier payment no longer exists.' })
  }
  return row
}

function toSummary(row: PaymentRow): SupplierPaymentSummary {
  return {
    id: row.id,
    paymentNo: row.payment_no,
    paymentDate: row.payment_date,
    supplierId: row.supplier_id,
    supplierCode: row.supplier_code,
    supplierName: row.supplier_name,
    amountMinor: row.amount_minor,
    method: row.method,
    reference: row.reference,
    status: row.status,
    receiptId: row.receipt_id,
    receiptNo: row.receipt_no,
    createdAt: row.created_at
  }
}
