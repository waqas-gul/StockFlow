import type { ListPage } from '@shared/customers'
import { localDateString } from '@shared/dates'
import {
  PAYMENT_NUMBER_PREFIX,
  PaymentCreateSchema,
  PaymentDuplicateCheckSchema,
  PaymentIdSchema,
  PaymentListInputSchema,
  PaymentVoidInputSchema,
  type DuplicatePaymentCheck,
  type PaymentDetail,
  type PaymentMethod,
  type PaymentSaveResult,
  type PaymentStatus,
  type PaymentSummary,
  type PaymentVoidResult
} from '@shared/payments'
import { formatDocumentNumber } from '@shared/stock'
import type { Db, SqlValue } from '../db/adapter'
import { AppFailure, parseInput } from '../errors'
import {
  appendLedgerEntry,
  assertCustomerPostingDate,
  customerBalance,
  customerRow
} from './customer-ledger'
import { takeSequenceValue } from './sequences'
import { assertCurrencyDigits } from './settings.service'

/*
 * Customer payment receipts (plan §10).
 *
 * - Posting is one transaction: request id (a retry returns the saved payment) → currency, customer (must be active)
 *   and posting date → RCP- number from the `payment` sequence → payments row → PAYMENT ledger entry of −amount.
 *   Nothing is saved, and no number is used, when any step fails.
 * - A payment may exceed what the customer owes: the rest is an advance (a negative balance).
 * - A saved payment is never edited. A void, dated today, sets POSTED → VOID with its reason and appends a PAYMENT_VOID
 *   entry of +amount, in one transaction; the PAYMENT entry is never changed. Voids work for inactive customers too.
 * - The same customer, date and amount as a posted payment is only a warning (checkDuplicatePayment), never a rule.
 */

const MAX_SEARCH_WORDS = 8

interface PaymentRow {
  id: number
  payment_no: string
  payment_date: string
  customer_id: number
  customer_code: string
  customer_name: string
  shop_name: string | null
  customer_active: number
  amount_minor: number
  method: PaymentMethod
  reference: string | null
  note: string | null
  status: PaymentStatus
  void_reason: string | null
  void_date: string | null
  voided_at: string | null
  created_at: string
}

const SELECT_PAYMENTS = `
  SELECT p.id, p.payment_no, p.payment_date, p.customer_id, c.code AS customer_code, c.name AS customer_name,
         c.shop_name, c.is_active AS customer_active, p.amount_minor, p.method, p.reference, p.note, p.status,
         p.void_reason, p.void_date, p.voided_at, p.created_at
  FROM payments AS p
  JOIN customers AS c ON c.id = p.customer_id`

/** Posts a payment receipt and its PAYMENT ledger entry. A repeated request id returns the payment already saved. */
export function createPayment(db: Db, input: unknown, now: Date): PaymentSaveResult {
  const payment = parseInput(PaymentCreateSchema, input)
  return db.transaction(() => {
    const saved = db.get<{ id: number }>('SELECT id FROM payments WHERE request_id = ?', [
      payment.requestId
    ])
    if (saved !== undefined) return saveResult(db, saved.id, true)

    assertCurrencyDigits(db, payment.currencyMinorDigits)
    const customer = customerRow(db, payment.customerId, 'customerId')
    if (customer.is_active === 0) {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: `${customer.code} ${customer.name} is inactive. Reactivate the customer to receive a payment.`,
        fieldErrors: { customerId: ['This customer is inactive.'] }
      })
    }
    assertCustomerPostingDate(db, {
      date: payment.paymentDate,
      today: localDateString(now),
      customer,
      field: 'paymentDate'
    })

    const id = insertPayment(db, { ...payment, customerId: customer.id, invoiceId: null })
    return saveResult(db, id, false)
  })
}

export interface PaymentPosting {
  readonly requestId: string
  readonly customerId: number
  readonly paymentDate: string
  /** Above zero. */
  readonly amountMinor: number
  readonly method: PaymentMethod
  readonly reference: string | null
  readonly note: string | null
  /** The invoice the money was received with, for information only. */
  readonly invoiceId: number | null
}

/**
 * Writes a payment: the next RCP- number, the payments row and its PAYMENT ledger entry of −amount. Runs inside the
 * caller's transaction, after the caller has checked the customer and the posting date. Returns the payment id.
 */
export function insertPayment(db: Db, payment: PaymentPosting): number {
  const paymentNo = formatDocumentNumber(PAYMENT_NUMBER_PREFIX, takeSequenceValue(db, 'payment'))
  const id = Number(
    db.run(
      `INSERT INTO payments (payment_no, request_id, customer_id, payment_date, amount_minor, method, reference, note,
         invoice_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        paymentNo,
        payment.requestId,
        payment.customerId,
        payment.paymentDate,
        payment.amountMinor,
        payment.method,
        payment.reference,
        payment.note,
        payment.invoiceId
      ]
    ).lastInsertRowid
  )
  appendLedgerEntry(db, {
    customerId: payment.customerId,
    date: payment.paymentDate,
    type: 'PAYMENT',
    amountMinor: -payment.amountMinor,
    paymentId: id
  })
  return id
}

/** One payment as saved. */
export function getPayment(db: Db, id: unknown): PaymentDetail {
  return readPayment(db, parseInput(PaymentIdSchema, id))
}

/** Payments, newest first, filtered by search words, date range, status and method. */
export function listPayments(db: Db, input: unknown): ListPage<PaymentSummary> {
  const filters = parseInput(PaymentListInputSchema, input)
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
      `(${['p.payment_no', 'p.reference', 'c.code', 'c.name', 'c.shop_name']
        .map((column) => `${column} LIKE ? ESCAPE '\\'`)
        .join(' OR ')})`
    )
    params.push(pattern, pattern, pattern, pattern, pattern)
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
    `SELECT count(*) AS n FROM payments AS p JOIN customers AS c ON c.id = p.customer_id ${where}`,
    params
  )!.n
  const rows = db.all<PaymentRow>(
    `${SELECT_PAYMENTS} ${where} ORDER BY p.payment_date DESC, p.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  )
  return { items: rows.map(toSummary), total, page, pageSize }
}

/** Posted payments of the same customer, date and amount: the operator is warned, and may still save. */
export function checkDuplicatePayment(db: Db, input: unknown): DuplicatePaymentCheck {
  const { customerId, paymentDate, amountMinor } = parseInput(PaymentDuplicateCheckSchema, input)
  const rows = db.all<PaymentRow>(
    `${SELECT_PAYMENTS}
     WHERE p.customer_id = ? AND p.payment_date = ? AND p.amount_minor = ? AND p.status = 'POSTED'
     ORDER BY p.id`,
    [customerId, paymentDate, amountMinor]
  )
  return { duplicates: rows.map(toSummary) }
}

/** Voids a posted payment, dated today: POSTED → VOID and a PAYMENT_VOID entry of +amount, together. */
export function voidPayment(db: Db, input: unknown, now: Date): PaymentVoidResult {
  const { id, reason } = parseInput(PaymentVoidInputSchema, input)
  return db.transaction(() => {
    const payment = paymentRow(db, id)
    if (payment.status === 'VOID') {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: `Payment ${payment.payment_no} is already void.`
      })
    }
    const today = localDateString(now)
    const customer = customerRow(db, payment.customer_id)
    assertCustomerPostingDate(db, { date: today, today, customer })
    db.run(
      "UPDATE payments SET status = 'VOID', void_reason = ?, voided_at = ?, void_date = ? WHERE id = ?",
      [reason, now.toISOString(), today, id]
    )
    appendLedgerEntry(db, {
      customerId: customer.id,
      date: today,
      type: 'PAYMENT_VOID',
      amountMinor: payment.amount_minor,
      paymentId: id,
      note: reason
    })
    return { ...readPayment(db, id), balanceAfterMinor: customerBalance(db, customer.id) }
  })
}

function saveResult(db: Db, id: number, replayed: boolean): PaymentSaveResult {
  const payment = readPayment(db, id)
  return { ...payment, balanceAfterMinor: customerBalance(db, payment.customerId), replayed }
}

function readPayment(db: Db, id: number): PaymentDetail {
  const row = paymentRow(db, id)
  return {
    ...toSummary(row),
    customerActive: row.customer_active === 1,
    note: row.note,
    voidReason: row.void_reason,
    voidDate: row.void_date,
    voidedAt: row.voided_at
  }
}

function paymentRow(db: Db, id: number): PaymentRow {
  const row = db.get<PaymentRow>(`${SELECT_PAYMENTS} WHERE p.id = ?`, [id])
  if (row === undefined) {
    throw new AppFailure({ code: 'NOT_FOUND', message: 'This payment no longer exists.' })
  }
  return row
}

function toSummary(row: PaymentRow): PaymentSummary {
  return {
    id: row.id,
    paymentNo: row.payment_no,
    paymentDate: row.payment_date,
    customerId: row.customer_id,
    customerCode: row.customer_code,
    customerName: row.customer_name,
    shopName: row.shop_name,
    amountMinor: row.amount_minor,
    method: row.method,
    reference: row.reference,
    status: row.status,
    createdAt: row.created_at
  }
}
