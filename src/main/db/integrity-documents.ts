import { WALK_IN_CUSTOMER_CODE } from '@shared/customers'
import { formatDisplayDate } from '@shared/dates'
import { calculateInvoiceTotals, type InvoiceTotalsLineInput } from '@shared/invoice-totals'
import type { Db } from './adapter'
import { hasSupplierSchema } from './integrity-suppliers'

/*
 * The document-level integrity checks (plan §7.5, final V1 audit). Each one reads the saved documents and the ledgers
 * they wrote, and reports every place where they no longer agree with the contracts of the services that wrote them.
 * They only read; nothing is ever corrected. Each returns its findings and how many documents it checked.
 *
 * The contracts checked, as the services write them:
 * - Invoice (invoices.service): every quantity row is quantity × price and quantity × unit size; a line's gross is the
 *   sum of its rows and its base quantity is paid + free; the line and header totals are the Phase 8 calculation
 *   (calculateInvoiceTotals) of the saved rows, discount (percentage when discount_bps is saved, otherwise an amount),
 *   scheme, extra discount, freight, received and previous balance; COGS is the sum of the frozen line costs.
 * - Each invoice line has one SALE movement of −qty_base and −cost_minor on its product, dated on the invoice date. A
 *   VOID invoice adds one SALE_VOID of +qty_base and +cost_minor per line, dated on the void date (never today's average);
 *   a POSTED invoice has none.
 * - An invoice above zero has one INVOICE entry of +total on the invoice date; a zero invoice has none. A VOID invoice
 *   above zero adds one INVOICE_VOID of −total on the void date. Money received has exactly one payment linked to the
 *   invoice, for that amount, customer and date; the payment may have been voided later (Phase 9).
 * - A payment has one PAYMENT entry of −amount on its date; a VOID payment adds one PAYMENT_VOID of +amount on its void
 *   date. The walk-in customer's account is always at zero.
 * - A receipt's total cost is the sum of its lines. Each receipt line has one STOCK_IN of +qty_base and +line cost on
 *   the receipt date; a VOID receipt adds one STOCK_IN_VOID of exactly −qty_base and −line cost on the void date. Lines
 *   are checked one by one, by line id, never by product totals.
 * - An adjustment has one movement on its product and date: OPENING_STOCK → OPENING, COUNT_SURPLUS → ADJUST_IN,
 *   RECEIPT_COST_CORRECTION → COST_CORRECTION (quantity 0, value ±value_minor), otherwise IN → ADJUST_IN and
 *   OUT → ADJUST_OUT; IN is +qty_base and +value_minor, OUT is −qty_base and −value_minor.
 * - No business date (invoice, payment, expense, receipt, adjustment, movement, ledger entry, supplier ledger entry,
 *   supplier payment, or a void date) is after the main process's today. created_at timestamps are not business dates.
 */

export interface DocumentFindings {
  readonly issues: readonly string[]
  /** How many documents (or rows) were checked. */
  readonly checked: number
}

/** A movement date, product and signed amounts, summed by kind for one source line. */
interface MovementTotals {
  readonly n: number
  readonly qty: number | null
  readonly value: number | null
  /** Movements of this kind on another product or date than the document says. */
  readonly misplaced: number
}

const movementColumns = (alias: string, type: string, product: string, date: string): string => `
  count(CASE WHEN m.type = '${type}' THEN 1 END) AS ${alias}_n,
  sum(CASE WHEN m.type = '${type}' THEN m.qty_base END) AS ${alias}_qty,
  sum(CASE WHEN m.type = '${type}' THEN m.value_minor END) AS ${alias}_value,
  count(CASE WHEN m.type = '${type}' AND (m.product_id IS NOT ${product} OR m.movement_date IS NOT ${date}) THEN 1 END)
    AS ${alias}_misplaced`

/** The totals of `movementColumns` read through the `mv` aggregate: zero counts when a line has no movement. */
const movedColumns = (alias: string): string => `
  coalesce(mv.${alias}_n, 0) AS ${alias}_n, mv.${alias}_qty AS ${alias}_qty, mv.${alias}_value AS ${alias}_value,
  coalesce(mv.${alias}_misplaced, 0) AS ${alias}_misplaced`

function totals(row: Record<string, unknown>, alias: string): MovementTotals {
  return {
    n: row[`${alias}_n`] as number,
    qty: row[`${alias}_qty`] as number | null,
    value: row[`${alias}_value`] as number | null,
    misplaced: row[`${alias}_misplaced`] as number
  }
}

/**
 * The movements of one kind a source line must have: exactly one, of `qty` and `value`, on the document's product and
 * date. `words` names the line and the kind in the findings.
 */
function expectMovement(
  issues: string[],
  found: MovementTotals,
  expected: { qty: number; value: number },
  words: {
    line: string
    missing: string
    kind: string
    verb: string
    valueWord: string
    costWord: string
  }
): void {
  if (found.n === 0) {
    issues.push(`${words.line} ${words.missing}.`)
    return
  }
  if (found.n > 1) {
    issues.push(`${words.line} has ${found.n} ${words.kind} movements; one is expected.`)
    return
  }
  if (found.qty !== expected.qty) {
    issues.push(
      `${words.line}: its ${words.kind} movement ${words.verb} ${Math.abs(found.qty as number)} base units, but the line has ${Math.abs(expected.qty)}.`
    )
  }
  if (found.value !== expected.value) {
    issues.push(
      `${words.line}: its ${words.kind} ${words.valueWord} ${found.value}, but ${words.costWord} ${Math.abs(expected.value)}.`
    )
  }
  if (found.misplaced > 0) {
    issues.push(`${words.line}: its ${words.kind} movement is for another product or date.`)
  }
}

// --- Invoices: lines and totals ----------------------------------------------------------------------------------------

interface InvoiceHeaderRow {
  id: number
  invoice_no: string
  gross_minor: number
  line_discount_minor: number
  line_scheme_minor: number
  extra_discount_minor: number
  net_minor: number
  freight_minor: number
  total_minor: number
  received_minor: number
  previous_balance_minor: number
  net_outstanding_minor: number
  cogs_minor: number
}

interface InvoiceItemRow {
  id: number
  invoice_id: number
  line_no: number
  qty_base: number
  scheme_qty_base: number
  gross_minor: number
  discount_bps: number | null
  discount_minor: number
  scheme_minor: number
  net_minor: number
  cost_minor: number
}

interface QuantityRow {
  invoice_item_id: number
  unit_base_qty: number
  quantity: number
  unit_price_minor: number
  amount_minor: number
  qty_base: number
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const row of rows) {
    const list = groups.get(key(row))
    if (list) list.push(row)
    else groups.set(key(row), [row])
  }
  return groups
}

export function invoiceTotalsFindings(db: Db): DocumentFindings {
  const invoices = db.all<InvoiceHeaderRow>(
    `SELECT id, invoice_no, gross_minor, line_discount_minor, line_scheme_minor, extra_discount_minor, net_minor,
            freight_minor, total_minor, received_minor, previous_balance_minor, net_outstanding_minor, cogs_minor
     FROM invoices ORDER BY id`
  )
  const items = groupBy(
    db.all<InvoiceItemRow>(
      `SELECT id, invoice_id, line_no, qty_base, scheme_qty_base, gross_minor, discount_bps, discount_minor,
              scheme_minor, net_minor, cost_minor
       FROM invoice_items ORDER BY invoice_id, line_no`
    ),
    (row) => row.invoice_id
  )
  const quantities = groupBy(
    db.all<QuantityRow>(
      `SELECT invoice_item_id, unit_base_qty, quantity, unit_price_minor, amount_minor, qty_base
       FROM invoice_item_quantities ORDER BY invoice_item_id, id`
    ),
    (row) => row.invoice_item_id
  )
  const issues: string[] = []
  for (const invoice of invoices) {
    const label = `Invoice ${invoice.invoice_no}`
    const lines = items.get(invoice.id) ?? []
    if (lines.length === 0) {
      issues.push(`${label} has no lines.`)
      continue
    }
    let recalculable = true
    const inputs: InvoiceTotalsLineInput[] = []
    for (const item of lines) {
      const line = `${label} line ${item.line_no}`
      const rows = quantities.get(item.id) ?? []
      if (rows.length === 0) {
        issues.push(`${line} has no quantities.`)
        recalculable = false
        continue
      }
      if (
        rows.some(
          (row) =>
            row.amount_minor !== row.quantity * row.unit_price_minor ||
            row.qty_base !== row.quantity * row.unit_base_qty
        )
      ) {
        issues.push(
          `${line}: a quantity row's amount or base quantity does not match its quantity.`
        )
      }
      const rowsGross = rows.reduce((sum, row) => sum + row.amount_minor, 0)
      const paid = rows.reduce((sum, row) => sum + row.qty_base, 0)
      if (item.gross_minor !== rowsGross) {
        issues.push(
          `${line}: the saved gross ${item.gross_minor} is not the sum of its quantities (${rowsGross}).`
        )
      }
      if (item.qty_base !== paid + item.scheme_qty_base) {
        issues.push(
          `${line}: the saved quantity ${item.qty_base} base units is not the paid ${paid} plus the free ${item.scheme_qty_base}.`
        )
      }
      inputs.push({
        quantities: rows.map((row) => ({
          quantity: row.quantity,
          unitBaseQty: row.unit_base_qty,
          unitPriceMinor: row.unit_price_minor
        })),
        freeQuantities:
          item.scheme_qty_base > 0 ? [{ quantity: item.scheme_qty_base, unitBaseQty: 1 }] : [],
        discount:
          item.discount_bps !== null
            ? { type: 'PERCENT', bps: item.discount_bps }
            : item.discount_minor > 0
              ? { type: 'AMOUNT', amountMinor: item.discount_minor }
              : null,
        schemeMinor: item.scheme_minor
      })
    }
    if (!recalculable) continue

    let result: ReturnType<typeof calculateInvoiceTotals>
    try {
      result = calculateInvoiceTotals({
        lines: inputs,
        extraDiscountMinor: invoice.extra_discount_minor,
        freightMinor: invoice.freight_minor,
        receivedMinor: invoice.received_minor,
        previousBalanceMinor: invoice.previous_balance_minor
      })
    } catch {
      result = { ok: false, issues: [] }
    }
    if (!result.ok) {
      issues.push(`${label}: its totals cannot be recalculated from its saved lines.`)
      continue
    }
    const recalculated = result.totals
    lines.forEach((item, index) => {
      const line = recalculated.lines[index]
      for (const [word, saved, expected] of [
        ['discount', item.discount_minor, line.discountMinor],
        ['scheme', item.scheme_minor, line.schemeMinor],
        ['net', item.net_minor, line.netMinor]
      ] as const) {
        if (saved !== expected) {
          issues.push(
            `${label} line ${item.line_no}: the saved ${word} ${saved} does not match the recalculated ${expected}.`
          )
        }
      }
    })
    const cogs = lines.reduce((sum, item) => sum + item.cost_minor, 0)
    for (const [word, saved, expected] of [
      ['gross', invoice.gross_minor, recalculated.grossMinor],
      ['line discounts', invoice.line_discount_minor, recalculated.lineDiscountMinor],
      ['schemes', invoice.line_scheme_minor, recalculated.lineSchemeMinor],
      ['net', invoice.net_minor, recalculated.netMinor],
      ['total', invoice.total_minor, recalculated.totalMinor],
      ['net outstanding', invoice.net_outstanding_minor, recalculated.netOutstandingMinor],
      ['COGS', invoice.cogs_minor, cogs]
    ] as const) {
      if (saved !== expected) {
        issues.push(`${label}: the saved ${word} ${saved} does not match its lines (${expected}).`)
      }
    }
  }
  return { issues, checked: invoices.length }
}

// --- Invoices: stock movements ---------------------------------------------------------------------------------------

export function invoiceStockFindings(db: Db): DocumentFindings {
  const rows = db.all<Record<string, unknown>>(
    `WITH mv AS MATERIALIZED (
       SELECT m.invoice_item_id AS source_id,
              ${movementColumns('sale', 'SALE', 'ii.product_id', 'i.invoice_date')},
              ${movementColumns('reversal', 'SALE_VOID', 'ii.product_id', 'i.void_date')},
              count(CASE WHEN m.type NOT IN ('SALE', 'SALE_VOID') THEN 1 END) AS others
       FROM stock_movements AS m
       JOIN invoice_items AS ii ON ii.id = m.invoice_item_id
       JOIN invoices AS i ON i.id = ii.invoice_id
       WHERE m.invoice_item_id IS NOT NULL
       GROUP BY m.invoice_item_id
     )
     SELECT ii.id, ii.line_no, ii.qty_base, ii.cost_minor, i.invoice_no, i.status,
            ${movedColumns('sale')}, ${movedColumns('reversal')}, coalesce(mv.others, 0) AS others
     FROM invoice_items AS ii
     JOIN invoices AS i ON i.id = ii.invoice_id
     LEFT JOIN mv ON mv.source_id = ii.id
     ORDER BY i.id, ii.line_no`
  )
  const issues: string[] = []
  for (const row of rows) {
    const qty = row.qty_base as number
    const cost = row.cost_minor as number
    const line = `Invoice ${String(row.invoice_no)} line ${String(row.line_no)}`
    expectMovement(
      issues,
      totals(row, 'sale'),
      { qty: -qty, value: -cost },
      {
        line,
        missing: 'has no sale stock movement',
        kind: 'sale',
        verb: 'takes',
        valueWord: 'movement is valued at',
        costWord: "the line's frozen cost is"
      }
    )
    const reversal = totals(row, 'reversal')
    if (row.status === 'VOID') {
      expectMovement(
        issues,
        reversal,
        { qty, value: cost },
        {
          line: `Void ${line.charAt(0).toLowerCase()}${line.slice(1)}`,
          missing: 'has no reversal stock movement',
          kind: 'reversal',
          verb: 'returns',
          valueWord: 'is valued at',
          costWord: "the line's frozen cost is"
        }
      )
    } else if (reversal.n > 0) {
      issues.push(
        `Posted ${line.charAt(0).toLowerCase()}${line.slice(1)} has a void reversal stock movement.`
      )
    }
    if ((row.others as number) > 0) {
      issues.push(`${line} has a stock movement of an unexpected kind.`)
    }
  }
  const invoices = db.get<{ n: number }>('SELECT count(*) AS n FROM invoices')!.n
  return { issues, checked: invoices }
}

// --- Invoices: customer account and payment ----------------------------------------------------------------------------

export function invoiceAccountFindings(db: Db): DocumentFindings {
  const rows = db.all<{
    invoice_no: string
    status: 'POSTED' | 'VOID'
    total_minor: number
    received_minor: number
    entries: number
    entry_amount: number | null
    entry_misdated: number
    voids: number
    void_amount: number | null
    void_misdated: number
    payments: number
    payment_amount: number | null
    payment_mismatch: number
  }>(
    `WITH entries AS MATERIALIZED (
       SELECT l.invoice_id,
              count(CASE WHEN l.type = 'INVOICE' THEN 1 END) AS entries,
              sum(CASE WHEN l.type = 'INVOICE' THEN l.amount_minor END) AS entry_amount,
              count(CASE WHEN l.type = 'INVOICE' AND l.entry_date IS NOT i.invoice_date THEN 1 END) AS entry_misdated,
              count(CASE WHEN l.type = 'INVOICE_VOID' THEN 1 END) AS voids,
              sum(CASE WHEN l.type = 'INVOICE_VOID' THEN l.amount_minor END) AS void_amount,
              count(CASE WHEN l.type = 'INVOICE_VOID' AND l.entry_date IS NOT i.void_date THEN 1 END) AS void_misdated
       FROM customer_ledger AS l
       JOIN invoices AS i ON i.id = l.invoice_id
       WHERE l.invoice_id IS NOT NULL AND l.type IN ('INVOICE', 'INVOICE_VOID')
       GROUP BY l.invoice_id
     ),
     paid AS MATERIALIZED (
       SELECT p.invoice_id, count(*) AS payments, sum(p.amount_minor) AS payment_amount,
              count(CASE WHEN p.customer_id IS NOT i.customer_id OR p.payment_date IS NOT i.invoice_date THEN 1 END)
                AS payment_mismatch
       FROM payments AS p
       JOIN invoices AS i ON i.id = p.invoice_id
       WHERE p.invoice_id IS NOT NULL
       GROUP BY p.invoice_id
     )
     SELECT i.invoice_no, i.status, i.total_minor, i.received_minor,
            coalesce(e.entries, 0) AS entries, e.entry_amount, coalesce(e.entry_misdated, 0) AS entry_misdated,
            coalesce(e.voids, 0) AS voids, e.void_amount, coalesce(e.void_misdated, 0) AS void_misdated,
            coalesce(pd.payments, 0) AS payments, pd.payment_amount, coalesce(pd.payment_mismatch, 0) AS payment_mismatch
     FROM invoices AS i
     LEFT JOIN entries AS e ON e.invoice_id = i.id
     LEFT JOIN paid AS pd ON pd.invoice_id = i.id
     ORDER BY i.id`
  )
  const issues: string[] = []
  for (const row of rows) {
    const label = `Invoice ${row.invoice_no}`
    if (row.total_minor > 0) {
      if (row.entries === 0) issues.push(`${label} has no account entry for its total.`)
      else if (row.entries > 1) {
        issues.push(`${label} has ${row.entries} account entries for its total; one is expected.`)
      } else if (row.entry_amount !== row.total_minor) {
        issues.push(
          `${label}: its account entry is ${row.entry_amount}, but its total is ${row.total_minor}.`
        )
      } else if (row.entry_misdated > 0) {
        issues.push(`${label}: its account entry is not dated on the invoice date.`)
      }
    } else if (row.entries > 0) {
      issues.push(`${label} has a total of zero but an account entry.`)
    }

    if (row.status === 'POSTED') {
      if (row.voids > 0) issues.push(`Posted invoice ${row.invoice_no} has an account void entry.`)
    } else if (row.total_minor > 0) {
      const voidLabel = `Void invoice ${row.invoice_no}`
      if (row.voids === 0) issues.push(`${voidLabel} has no account entry reversing its total.`)
      else if (row.voids > 1) {
        issues.push(`${voidLabel} has ${row.voids} account void entries; one is expected.`)
      } else if (row.void_amount !== -row.total_minor) {
        issues.push(
          `${voidLabel}: its account void entry is ${row.void_amount}, but it should be ${-row.total_minor}.`
        )
      } else if (row.void_misdated > 0) {
        issues.push(`${voidLabel}: its account void entry is not dated on the void date.`)
      }
    } else if (row.voids > 0) {
      issues.push(`Void invoice ${row.invoice_no} has a total of zero but an account void entry.`)
    }

    // The payment received with the invoice; it may have been voided later.
    if (row.received_minor > 0) {
      if (row.payments === 0) {
        issues.push(`${label}: the ${row.received_minor} received has no payment.`)
      } else if (row.payments > 1) {
        issues.push(
          `${label} has ${row.payments} payments for the money received; one is expected.`
        )
      } else if (row.payment_amount !== row.received_minor || row.payment_mismatch > 0) {
        issues.push(
          `${label}: its payment does not match the amount received, the customer or the invoice date.`
        )
      }
    } else if (row.payments > 0) {
      issues.push(`${label} received nothing but has a payment.`)
    }
  }
  return { issues, checked: rows.length }
}

// --- Payments: customer account ----------------------------------------------------------------------------------------

export function paymentLedgerFindings(db: Db): DocumentFindings {
  const rows = db.all<{
    payment_no: string
    status: 'POSTED' | 'VOID'
    amount_minor: number
    entries: number
    entry_amount: number | null
    entry_misdated: number
    voids: number
    void_amount: number | null
    void_misdated: number
  }>(
    `WITH entries AS MATERIALIZED (
       SELECT l.payment_id,
              count(CASE WHEN l.type = 'PAYMENT' THEN 1 END) AS entries,
              sum(CASE WHEN l.type = 'PAYMENT' THEN l.amount_minor END) AS entry_amount,
              count(CASE WHEN l.type = 'PAYMENT' AND l.entry_date IS NOT p.payment_date THEN 1 END) AS entry_misdated,
              count(CASE WHEN l.type = 'PAYMENT_VOID' THEN 1 END) AS voids,
              sum(CASE WHEN l.type = 'PAYMENT_VOID' THEN l.amount_minor END) AS void_amount,
              count(CASE WHEN l.type = 'PAYMENT_VOID' AND l.entry_date IS NOT p.void_date THEN 1 END) AS void_misdated
       FROM customer_ledger AS l
       JOIN payments AS p ON p.id = l.payment_id
       WHERE l.payment_id IS NOT NULL
       GROUP BY l.payment_id
     )
     SELECT p.payment_no, p.status, p.amount_minor,
            coalesce(e.entries, 0) AS entries, e.entry_amount, coalesce(e.entry_misdated, 0) AS entry_misdated,
            coalesce(e.voids, 0) AS voids, e.void_amount, coalesce(e.void_misdated, 0) AS void_misdated
     FROM payments AS p
     LEFT JOIN entries AS e ON e.payment_id = p.id
     ORDER BY p.id`
  )
  const issues: string[] = []
  for (const row of rows) {
    const label = `Payment ${row.payment_no}`
    if (row.entries === 0) issues.push(`${label} has no account entry.`)
    else if (row.entries > 1) {
      issues.push(`${label} has ${row.entries} account entries; one is expected.`)
    } else if (row.entry_amount !== -row.amount_minor) {
      issues.push(
        `${label}: its account entry is ${row.entry_amount}, but it should be ${-row.amount_minor}.`
      )
    } else if (row.entry_misdated > 0) {
      issues.push(`${label}: its account entry is not dated on the payment date.`)
    }

    if (row.status === 'POSTED') {
      if (row.voids > 0) issues.push(`Posted payment ${row.payment_no} has an account void entry.`)
      continue
    }
    const voidLabel = `Void payment ${row.payment_no}`
    if (row.voids === 0) issues.push(`${voidLabel} has no account entry reversing it.`)
    else if (row.voids > 1) {
      issues.push(`${voidLabel} has ${row.voids} account void entries; one is expected.`)
    } else if (row.void_amount !== row.amount_minor) {
      issues.push(
        `${voidLabel}: its account void entry is ${row.void_amount}, but it should be ${row.amount_minor}.`
      )
    } else if (row.void_misdated > 0) {
      issues.push(`${voidLabel}: its account void entry is not dated on the void date.`)
    }
  }
  return { issues, checked: rows.length }
}

// --- The walk-in customer ---------------------------------------------------------------------------------------------

export function walkInFindings(db: Db): DocumentFindings {
  const row = db.get<{ balance: number }>(
    `SELECT coalesce((SELECT sum(l.amount_minor) FROM customer_ledger AS l WHERE l.customer_id = c.id), 0) AS balance
     FROM customers AS c WHERE c.code = ?`,
    [WALK_IN_CUSTOMER_CODE]
  )
  if (row === undefined) {
    return { issues: [`The walk-in customer (${WALK_IN_CUSTOMER_CODE}) is missing.`], checked: 0 }
  }
  return {
    issues:
      row.balance === 0
        ? []
        : [
            `The walk-in customer (${WALK_IN_CUSTOMER_CODE}) has a balance of ${row.balance}; it should be 0.`
          ],
    checked: 1
  }
}

// --- Stock receipts -----------------------------------------------------------------------------------------------------

export function receiptStockFindings(db: Db): DocumentFindings {
  const issues: string[] = []
  const receipts = db.all<{
    receipt_no: string
    total_cost_minor: number
    lines: number
    cost: number | null
  }>(
    `SELECT r.receipt_no, r.total_cost_minor, count(ri.id) AS lines, sum(ri.line_cost_minor) AS cost
     FROM stock_receipts AS r LEFT JOIN stock_receipt_items AS ri ON ri.receipt_id = r.id
     GROUP BY r.id ORDER BY r.id`
  )
  const rows = db.all<Record<string, unknown>>(
    `WITH mv AS MATERIALIZED (
       SELECT m.receipt_item_id AS source_id,
              ${movementColumns('stock_in', 'STOCK_IN', 'ri.product_id', 'r.receipt_date')},
              ${movementColumns('reversal', 'STOCK_IN_VOID', 'ri.product_id', 'r.void_date')},
              count(CASE WHEN m.type NOT IN ('STOCK_IN', 'STOCK_IN_VOID') THEN 1 END) AS others
       FROM stock_movements AS m
       JOIN stock_receipt_items AS ri ON ri.id = m.receipt_item_id
       JOIN stock_receipts AS r ON r.id = ri.receipt_id
       WHERE m.receipt_item_id IS NOT NULL
       GROUP BY m.receipt_item_id
     )
     SELECT ri.id, ri.line_no, ri.qty_base, ri.line_cost_minor, r.receipt_no, r.status,
            ${movedColumns('stock_in')}, ${movedColumns('reversal')}, coalesce(mv.others, 0) AS others
     FROM stock_receipt_items AS ri
     JOIN stock_receipts AS r ON r.id = ri.receipt_id
     LEFT JOIN mv ON mv.source_id = ri.id
     ORDER BY r.id, ri.line_no`
  )
  const lines = groupBy(rows, (row) => row.receipt_no as string)
  for (const receipt of receipts) {
    if (receipt.lines === 0) {
      issues.push(`Receipt ${receipt.receipt_no} has no lines.`)
      continue
    }
    if (receipt.total_cost_minor !== receipt.cost) {
      issues.push(
        `Receipt ${receipt.receipt_no}: its total cost ${receipt.total_cost_minor} is not the sum of its lines (${receipt.cost}).`
      )
    }
    for (const row of lines.get(receipt.receipt_no)!) {
      const qty = row.qty_base as number
      const cost = row.line_cost_minor as number
      const line = `Receipt ${receipt.receipt_no} line ${String(row.line_no)}`
      expectMovement(
        issues,
        totals(row, 'stock_in'),
        { qty, value: cost },
        {
          line,
          missing: 'has no stock-in movement',
          kind: 'stock-in',
          verb: 'adds',
          valueWord: 'movement is valued at',
          costWord: 'the line cost is'
        }
      )
      const reversal = totals(row, 'reversal')
      if (row.status === 'VOID') {
        expectMovement(
          issues,
          reversal,
          { qty: -qty, value: -cost },
          {
            line: `Void receipt ${receipt.receipt_no} line ${String(row.line_no)}`,
            missing: 'has no reversal stock movement',
            kind: 'reversal',
            verb: 'removes',
            valueWord: 'is valued at',
            costWord: 'the line cost is'
          }
        )
      } else if (reversal.n > 0) {
        issues.push(
          `Posted receipt ${receipt.receipt_no} line ${String(row.line_no)} has a void reversal stock movement.`
        )
      }
      if ((row.others as number) > 0) {
        issues.push(`${line} has a stock movement of an unexpected kind.`)
      }
    }
  }
  return { issues, checked: receipts.length }
}

// --- Stock adjustments --------------------------------------------------------------------------------------------------

/** The movement type an adjustment writes (stock.service valuation). */
function adjustmentMovementType(reason: string, direction: string): string {
  if (reason === 'OPENING_STOCK') return 'OPENING'
  if (reason === 'COUNT_SURPLUS') return 'ADJUST_IN'
  if (reason === 'RECEIPT_COST_CORRECTION') return 'COST_CORRECTION'
  return direction === 'OUT' ? 'ADJUST_OUT' : 'ADJUST_IN'
}

export function adjustmentStockFindings(db: Db): DocumentFindings {
  const rows = db.all<{
    adjustment_no: string
    reason_code: string
    direction: 'IN' | 'OUT' | 'VALUE'
    qty_base: number
    value_minor: number
    movements: number
    type: string | null
    qty: number | null
    value: number | null
    misplaced: number
  }>(
    `SELECT a.adjustment_no, a.reason_code, a.direction, a.qty_base, a.value_minor,
            count(m.id) AS movements, max(m.type) AS type, sum(m.qty_base) AS qty, sum(m.value_minor) AS value,
            count(CASE WHEN m.product_id IS NOT a.product_id OR m.movement_date IS NOT a.adjustment_date THEN 1 END)
              AS misplaced
     FROM stock_adjustments AS a
     LEFT JOIN stock_movements AS m ON m.adjustment_id = a.id
     GROUP BY a.id
     ORDER BY a.id`
  )
  const issues: string[] = []
  for (const row of rows) {
    const label = `Adjustment ${row.adjustment_no}`
    if (row.movements === 0) {
      issues.push(`${label} has no stock movement.`)
      continue
    }
    if (row.movements > 1) {
      issues.push(`${label} has ${row.movements} stock movements; one is expected.`)
      continue
    }
    const type = adjustmentMovementType(row.reason_code, row.direction)
    if (row.type !== type) {
      issues.push(
        `${label}: its stock movement is ${row.type}, but a ${row.reason_code} adjustment makes ${type}.`
      )
    }
    const sign = row.direction === 'OUT' ? -1 : 1
    const qty = row.direction === 'VALUE' ? 0 : sign * row.qty_base
    if (row.qty !== qty) {
      issues.push(
        `${label}: its stock movement changes stock by ${row.qty} base units, but the adjustment says ${qty}.`
      )
    }
    const valueMatches =
      row.direction === 'VALUE'
        ? row.value !== 0 && Math.abs(row.value as number) === row.value_minor
        : row.value === sign * row.value_minor
    if (!valueMatches) {
      const expected =
        row.direction === 'VALUE' ? `±${row.value_minor}` : String(sign * row.value_minor)
      issues.push(
        `${label}: its stock movement changes the value by ${row.value}, but the adjustment says ${expected}.`
      )
    }
    if (row.misplaced > 0) {
      issues.push(`${label}: its stock movement is for another product or date.`)
    }
  }
  return { issues, checked: rows.length }
}

// --- Business dates ------------------------------------------------------------------------------------------------------

/** Every business date column, with how its first row is named. */
const BUSINESS_DATES: ReadonlyArray<{
  readonly label: string
  readonly table: string
  readonly column: string
  readonly ref: string
}> = [
  { label: 'Invoices', table: 'invoices', column: 'invoice_date', ref: 'invoice_no' },
  { label: 'Invoice voids', table: 'invoices', column: 'void_date', ref: 'invoice_no' },
  { label: 'Payments', table: 'payments', column: 'payment_date', ref: 'payment_no' },
  { label: 'Payment voids', table: 'payments', column: 'void_date', ref: 'payment_no' },
  { label: 'Expenses', table: 'expenses', column: 'expense_date', ref: "'expense ' || id" },
  { label: 'Stock receipts', table: 'stock_receipts', column: 'receipt_date', ref: 'receipt_no' },
  { label: 'Stock receipt voids', table: 'stock_receipts', column: 'void_date', ref: 'receipt_no' },
  {
    label: 'Stock adjustments',
    table: 'stock_adjustments',
    column: 'adjustment_date',
    ref: 'adjustment_no'
  },
  {
    label: 'Stock movements',
    table: 'stock_movements',
    column: 'movement_date',
    ref: "'movement ' || id"
  },
  {
    label: 'Customer ledger entries',
    table: 'customer_ledger',
    column: 'entry_date',
    ref: "'entry ' || id"
  }
]

/** The supplier account dates (migration 0003), checked once the supplier tables exist. */
const SUPPLIER_DATES: typeof BUSINESS_DATES = [
  {
    label: 'Supplier ledger entries',
    table: 'supplier_ledger',
    column: 'entry_date',
    ref: "'supplier entry ' || id"
  },
  {
    label: 'Supplier payments',
    table: 'supplier_payments',
    column: 'payment_date',
    ref: 'payment_no'
  },
  {
    label: 'Supplier payment voids',
    table: 'supplier_payments',
    column: 'void_date',
    ref: 'payment_no'
  }
]

export function futureDateFindings(db: Db, today: string): DocumentFindings {
  const issues: string[] = []
  let checked = 0
  const columns = hasSupplierSchema(db) ? [...BUSINESS_DATES, ...SUPPLIER_DATES] : BUSINESS_DATES
  for (const { label, table, column, ref } of columns) {
    const row = db.get<{
      n: number
      total: number
      first_ref: string | null
      first_date: string | null
    }>(
      `SELECT (SELECT count(*) FROM ${table} WHERE ${column} > ?) AS n,
              (SELECT count(*) FROM ${table}) AS total,
              (SELECT ${ref} FROM ${table} WHERE ${column} > ? ORDER BY ${column}, id LIMIT 1) AS first_ref,
              (SELECT ${column} FROM ${table} WHERE ${column} > ? ORDER BY ${column}, id LIMIT 1) AS first_date`,
      [today, today, today]
    )!
    checked += row.total
    if (row.n > 0) {
      issues.push(
        `${label}: ${row.n} dated after today (${formatDisplayDate(today)}); the first is ${row.first_ref}, dated ${formatDisplayDate(row.first_date as string)}.`
      )
    }
  }
  return { issues, checked }
}
