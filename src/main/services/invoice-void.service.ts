import { isWalkInCustomer } from '@shared/customers'
import { localDateString } from '@shared/dates'
import {
  InvoiceVoidInputSchema,
  WALK_IN_VOID_MESSAGE,
  type InvoiceVoidResult
} from '@shared/invoices'
import type { Db } from '../db/adapter'
import { AppFailure, parseInput } from '../errors'
import {
  appendLedgerEntry,
  assertCustomerPostingDate,
  customerBalance,
  customerRow
} from './customer-ledger'
import { assertPostingDate, assertStockInvariants, inventoryTransaction, unique } from './inventory'
import { invoiceNotFound, readInvoice } from './invoices.service'
import { writePaymentVoid } from './payments.service'

/*
 * Voiding a sales invoice (plan §11.4). A posted invoice is never edited: it is voided, dated today, in one BEGIN
 * IMMEDIATE transaction that appends reversals and changes no earlier row except the invoice's status:
 *
 *   invoice is POSTED → today satisfies the posting floors (the latest movement of every product on it and the
 *   customer's latest ledger entry) → the saved records still match the invoice exactly (one SALE movement per line of
 *   −qty_base and −cost_minor; an INVOICE entry of +total exactly when total > 0; the counter payment exactly when money
 *   was received) → the walk-in decision → POSTED → VOID with the reason → one SALE_VOID movement per line of
 *   +qty_base at +cost_minor → INVOICE_VOID entry of −total (when total > 0) → walk-in only: the counter payment's void
 *   and PAYMENT_VOID entry → stock invariants → customer balance check.
 *
 * Stock comes back at the frozen cost of the original sale, never at today's weighted average, so the reversal adds back
 * exactly what the sale took out.
 *
 * The counter payment of an account customer stays posted (the money was received): the customer's balance then shows
 * it as credit, and the payment is voided on its own if the money was returned. The walk-in customer keeps a zero
 * account, so its invoice is voided only with "money returned", which voids the counter payment in the same
 * transaction. A walk-in payment already voided on its own needs nothing more.
 */

interface VoidInvoiceRow {
  id: number
  invoice_no: string
  status: 'POSTED' | 'VOID'
  customer_id: number
  total_minor: number
  received_minor: number
}

interface VoidItemRow {
  id: number
  product_id: number
  qty_base: number
  cost_minor: number
  sale_qty_base: number | null
  sale_value_minor: number | null
}

interface CounterPaymentRow {
  id: number
  payment_no: string
  customer_id: number
  amount_minor: number
  status: 'POSTED' | 'VOID'
}

/** Voids a posted invoice with its exact stock and ledger reversals, all or nothing. */
export function voidInvoice(db: Db, input: unknown, now: Date): InvoiceVoidResult {
  const { id, reason, moneyReturned } = parseInput(InvoiceVoidInputSchema, input)
  return inventoryTransaction(db, () => {
    const invoice = db.get<VoidInvoiceRow>(
      'SELECT id, invoice_no, status, customer_id, total_minor, received_minor FROM invoices WHERE id = ?',
      [id]
    )
    if (invoice === undefined) throw invoiceNotFound()
    if (invoice.status === 'VOID') {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: `Invoice ${invoice.invoice_no} is already void.`
      })
    }

    const today = localDateString(now)
    const customer = customerRow(db, invoice.customer_id)
    const items = db.all<VoidItemRow>(
      `SELECT ii.id, ii.product_id, ii.qty_base, ii.cost_minor, m.qty_base AS sale_qty_base,
              m.value_minor AS sale_value_minor
       FROM invoice_items AS ii
       LEFT JOIN stock_movements AS m ON m.invoice_item_id = ii.id AND m.type = 'SALE'
       WHERE ii.invoice_id = ? ORDER BY ii.line_no`,
      [id]
    )
    const productIds = unique(items.map((item) => item.product_id))
    assertPostingDate(db, { date: today, today, productIds })
    assertCustomerPostingDate(db, { date: today, today, customer })
    assertStockRecords(invoice, items)
    const payment = counterPayment(db, invoice)

    const walkIn = isWalkInCustomer(customer.code)
    const returnPayment = walkIn && payment?.status === 'POSTED'
    if (returnPayment && !moneyReturned) {
      throw new AppFailure({
        code: 'VALIDATION',
        message: `${WALK_IN_VOID_MESSAGE} Confirm that the money was returned.`,
        fieldErrors: { moneyReturned: [WALK_IN_VOID_MESSAGE] }
      })
    }
    if (moneyReturned && !returnPayment) {
      const message =
        payment === null
          ? 'No money was received with this invoice, so there is nothing to return.'
          : walkIn
            ? `Payment ${payment.payment_no} is already void, so there is nothing more to return.`
            : `Voiding this invoice keeps payment ${payment.payment_no} on the customer's account as credit. Void the payment separately if the money was also returned.`
      throw new AppFailure({
        code: 'VALIDATION',
        message,
        fieldErrors: { moneyReturned: [message] }
      })
    }

    const balanceBefore = customerBalance(db, customer.id)
    db.run(
      "UPDATE invoices SET status = 'VOID', void_reason = ?, voided_at = ?, void_date = ? WHERE id = ?",
      [reason, now.toISOString(), today, id]
    )
    for (const item of items) {
      db.run(
        `INSERT INTO stock_movements (product_id, movement_date, type, qty_base, value_minor, invoice_item_id)
         VALUES (?, ?, 'SALE_VOID', ?, ?, ?)`,
        [item.product_id, today, item.qty_base, item.cost_minor, item.id]
      )
    }
    if (invoice.total_minor > 0) {
      appendLedgerEntry(db, {
        customerId: customer.id,
        date: today,
        type: 'INVOICE_VOID',
        amountMinor: -invoice.total_minor,
        invoiceId: id,
        note: reason
      })
    }
    if (returnPayment) {
      writePaymentVoid(
        db,
        { id: payment!.id, customerId: customer.id, amountMinor: payment!.amount_minor },
        reason,
        now
      )
    }

    assertStockInvariants(db, productIds)
    const balanceAfterMinor = customerBalance(db, customer.id)
    const expected =
      balanceBefore - invoice.total_minor + (returnPayment ? payment!.amount_minor : 0)
    if (balanceAfterMinor !== expected) {
      throw new Error('The customer balance after the invoice void does not match the reversal.')
    }
    return { ...readInvoice(db, id), balanceAfterMinor }
  })
}

/**
 * The exact reversal needs every line's own SALE movement, still holding what the line froze: −qty_base at −cost_minor.
 * Anything else means the records no longer describe this sale, so nothing is reversed.
 */
function assertStockRecords(invoice: VoidInvoiceRow, items: readonly VoidItemRow[]): void {
  const exact = items.every(
    (item) =>
      item.sale_qty_base === -item.qty_base &&
      item.sale_value_minor !== null &&
      -item.sale_value_minor === item.cost_minor
  )
  if (items.length === 0 || !exact) {
    throw new AppFailure({
      code: 'INVENTORY_INVARIANT',
      message: `Invoice ${invoice.invoice_no} cannot be voided: its saved stock records do not match the invoice, so the stock could not be restored exactly. Nothing was changed.`
    })
  }
}

/**
 * The payment saved with the invoice, which must match the invoice: present exactly when money was received, for that
 * amount and customer. The INVOICE entry must match too. Otherwise the customer account cannot be reversed safely.
 */
function counterPayment(db: Db, invoice: VoidInvoiceRow): CounterPaymentRow | null {
  const payments = db.all<CounterPaymentRow>(
    'SELECT id, payment_no, customer_id, amount_minor, status FROM payments WHERE invoice_id = ? ORDER BY id',
    [invoice.id]
  )
  const entries = db.all<{ amount_minor: number }>(
    "SELECT amount_minor FROM customer_ledger WHERE invoice_id = ? AND type = 'INVOICE'",
    [invoice.id]
  )
  const payment = payments[0] ?? null
  const paymentMatches =
    invoice.received_minor === 0
      ? payments.length === 0
      : payments.length === 1 &&
        payment!.amount_minor === invoice.received_minor &&
        payment!.customer_id === invoice.customer_id
  const entryMatches =
    invoice.total_minor === 0
      ? entries.length === 0
      : entries.length === 1 && entries[0].amount_minor === invoice.total_minor
  if (!paymentMatches || !entryMatches) {
    throw new AppFailure({
      code: 'FORBIDDEN_STATE',
      message: `Invoice ${invoice.invoice_no} cannot be voided: its saved account records do not match the invoice${paymentMatches ? '' : ' (the payment received with it is missing or different)'}. Nothing was changed.`
    })
  }
  return payment
}
