import type { Db } from './adapter'
import type { DocumentFindings } from './integrity-documents'

/*
 * The supplier account integrity checks (migration 0003). Like the document checks, they only read and report every
 * place where the saved records no longer agree with the contracts of the services that wrote them; nothing is fixed.
 *
 * The contracts checked, as the services write them:
 * - Every supplier ledger entry has the sign and references its type requires (PURCHASE +, PURCHASE_VOID −, PAYMENT −,
 *   PAYMENT_VOID +, OPENING and ADJUSTMENT non-zero, an ADJUSTMENT with its reason), and v_supplier_balance equals the
 *   sum of each supplier's entries.
 * - A supplier-linked receipt (stock_receipts.supplier_id set) with a total above zero has one PURCHASE of +total on the
 *   receipt's supplier and date; a VOID one adds one PURCHASE_VOID of −total on its void date. A zero total has neither.
 *   A receipt without a supplier account (every receipt saved before migration 0003) has no supplier entry at all.
 * - A supplier payment has one PAYMENT of −amount on its supplier and date; a VOID one adds one PAYMENT_VOID of +amount on
 *   its void date. A payment made with a receipt names a receipt of the same supplier.
 */

/** True once migration 0003 has created the supplier tables. */
export function hasSupplierSchema(db: Db): boolean {
  return (
    db.get(
      "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'supplier_ledger'"
    ) !== undefined
  )
}

// --- Ledger entries and balances ------------------------------------------------------------------------------------------

export function supplierLedgerFindings(db: Db): DocumentFindings {
  const issues: string[] = []
  const wrongShape = db.all<{ id: number; type: string; amount_minor: number }>(`
    SELECT id, type, amount_minor FROM supplier_ledger
    WHERE NOT (CASE type
      WHEN 'OPENING' THEN amount_minor <> 0 AND stock_receipt_id IS NULL AND supplier_payment_id IS NULL
      WHEN 'ADJUSTMENT' THEN amount_minor <> 0 AND stock_receipt_id IS NULL AND supplier_payment_id IS NULL
        AND trim(coalesce(note, '')) <> ''
      WHEN 'PURCHASE' THEN amount_minor > 0 AND stock_receipt_id IS NOT NULL AND supplier_payment_id IS NULL
      WHEN 'PURCHASE_VOID' THEN amount_minor < 0 AND stock_receipt_id IS NOT NULL AND supplier_payment_id IS NULL
      WHEN 'PAYMENT' THEN amount_minor < 0 AND supplier_payment_id IS NOT NULL AND stock_receipt_id IS NULL
      WHEN 'PAYMENT_VOID' THEN amount_minor > 0 AND supplier_payment_id IS NOT NULL AND stock_receipt_id IS NULL
      ELSE 0
    END)
    ORDER BY id
  `)
  for (const entry of wrongShape) {
    issues.push(
      `Supplier ledger entry ${entry.id} (${entry.type}, ${entry.amount_minor}): the amount sign or references do not match the entry type.`
    )
  }
  const openings = db.all<{ code: string; n: number }>(`
    SELECT s.code, count(*) AS n FROM supplier_ledger AS l JOIN suppliers AS s ON s.id = l.supplier_id
    WHERE l.type = 'OPENING' GROUP BY l.supplier_id HAVING count(*) > 1 ORDER BY s.id
  `)
  for (const supplier of openings) {
    issues.push(
      `Supplier ${supplier.code} has ${supplier.n} opening balances; at most one is expected.`
    )
  }
  const differing = db.all<{ id: number; code: string; direct: number; shown: number | null }>(`
    WITH sums AS MATERIALIZED (
      SELECT supplier_id, sum(amount_minor) AS total FROM supplier_ledger GROUP BY supplier_id
    )
    SELECT s.id, s.code, coalesce(t.total, 0) AS direct, b.balance_minor AS shown
    FROM suppliers AS s
    LEFT JOIN sums AS t ON t.supplier_id = s.id
    LEFT JOIN v_supplier_balance AS b ON b.supplier_id = s.id
    WHERE b.supplier_id IS NULL OR b.balance_minor IS NOT coalesce(t.total, 0)
    ORDER BY s.id
  `)
  for (const supplier of differing) {
    issues.push(
      `Supplier ${supplier.code}: the balance shows ${supplier.shown ?? 'nothing'}, but its account entries add up to ${supplier.direct}.`
    )
  }
  const [{ n }] = db.all<{ n: number }>('SELECT count(*) AS n FROM suppliers')
  return { issues, checked: n }
}

// --- Purchases ---------------------------------------------------------------------------------------------------------

export function supplierPurchaseFindings(db: Db): DocumentFindings {
  const rows = db.all<{
    receipt_no: string
    status: 'POSTED' | 'VOID'
    supplier_id: number | null
    total_cost_minor: number
    purchases: number
    purchase_amount: number | null
    purchase_other_supplier: number
    purchase_misdated: number
    voids: number
    void_amount: number | null
    void_other_supplier: number
    void_misdated: number
    others: number
  }>(
    `WITH entries AS MATERIALIZED (
       SELECT l.stock_receipt_id,
              count(CASE WHEN l.type = 'PURCHASE' THEN 1 END) AS purchases,
              sum(CASE WHEN l.type = 'PURCHASE' THEN l.amount_minor END) AS purchase_amount,
              count(CASE WHEN l.type = 'PURCHASE' AND l.supplier_id IS NOT r.supplier_id THEN 1 END)
                AS purchase_other_supplier,
              count(CASE WHEN l.type = 'PURCHASE' AND l.entry_date IS NOT r.receipt_date THEN 1 END) AS purchase_misdated,
              count(CASE WHEN l.type = 'PURCHASE_VOID' THEN 1 END) AS voids,
              sum(CASE WHEN l.type = 'PURCHASE_VOID' THEN l.amount_minor END) AS void_amount,
              count(CASE WHEN l.type = 'PURCHASE_VOID' AND l.supplier_id IS NOT r.supplier_id THEN 1 END)
                AS void_other_supplier,
              count(CASE WHEN l.type = 'PURCHASE_VOID' AND l.entry_date IS NOT r.void_date THEN 1 END) AS void_misdated,
              count(CASE WHEN l.type NOT IN ('PURCHASE', 'PURCHASE_VOID') THEN 1 END) AS others
       FROM supplier_ledger AS l
       JOIN stock_receipts AS r ON r.id = l.stock_receipt_id
       WHERE l.stock_receipt_id IS NOT NULL
       GROUP BY l.stock_receipt_id
     )
     SELECT r.receipt_no, r.status, r.supplier_id, r.total_cost_minor,
            coalesce(e.purchases, 0) AS purchases, e.purchase_amount,
            coalesce(e.purchase_other_supplier, 0) AS purchase_other_supplier,
            coalesce(e.purchase_misdated, 0) AS purchase_misdated,
            coalesce(e.voids, 0) AS voids, e.void_amount,
            coalesce(e.void_other_supplier, 0) AS void_other_supplier,
            coalesce(e.void_misdated, 0) AS void_misdated, coalesce(e.others, 0) AS others
     FROM stock_receipts AS r
     LEFT JOIN entries AS e ON e.stock_receipt_id = r.id
     WHERE r.supplier_id IS NOT NULL OR e.stock_receipt_id IS NOT NULL
     ORDER BY r.id`
  )
  const issues: string[] = []
  let checked = 0
  for (const row of rows) {
    const label = `Receipt ${row.receipt_no}`
    if (row.supplier_id === null) {
      // Legacy and unlinked receipts are never on a supplier account.
      issues.push(`${label} has no supplier account, but has supplier account entries.`)
      continue
    }
    checked++
    if (row.others > 0) issues.push(`${label} has a supplier account entry of an unexpected kind.`)
    const total = row.total_cost_minor
    if (total === 0) {
      if (row.purchases > 0 || row.voids > 0) {
        issues.push(`${label} has a total of 0, so it should have no supplier account entry.`)
      }
      continue
    }
    if (row.purchases === 0) issues.push(`${label} has no supplier purchase entry.`)
    else if (row.purchases > 1) {
      issues.push(`${label} has ${row.purchases} supplier purchase entries; one is expected.`)
    } else {
      if (row.purchase_amount !== total) {
        issues.push(
          `${label}: its supplier purchase entry is ${row.purchase_amount}, but the receipt total is ${total}.`
        )
      }
      if (row.purchase_other_supplier > 0) {
        issues.push(`${label}: its supplier purchase entry is on another supplier.`)
      }
      if (row.purchase_misdated > 0) {
        issues.push(`${label}: its supplier purchase entry is not dated on the receipt date.`)
      }
    }

    if (row.status === 'POSTED') {
      if (row.voids > 0)
        issues.push(`Posted receipt ${row.receipt_no} has a supplier purchase void entry.`)
      continue
    }
    const voidLabel = `Void receipt ${row.receipt_no}`
    if (row.voids === 0) issues.push(`${voidLabel} has no supplier entry reversing its purchase.`)
    else if (row.voids > 1) {
      issues.push(`${voidLabel} has ${row.voids} supplier purchase void entries; one is expected.`)
    } else {
      if (row.void_amount !== -total) {
        issues.push(
          `${voidLabel}: its supplier purchase void entry is ${row.void_amount}, but it should be ${-total}.`
        )
      }
      if (row.void_other_supplier > 0) {
        issues.push(`${voidLabel}: its supplier purchase void entry is on another supplier.`)
      }
      if (row.void_misdated > 0) {
        issues.push(`${voidLabel}: its supplier purchase void entry is not dated on the void date.`)
      }
    }
  }
  return { issues, checked }
}

// --- Payments ----------------------------------------------------------------------------------------------------------

export function supplierPaymentFindings(db: Db): DocumentFindings {
  const rows = db.all<{
    payment_no: string
    status: 'POSTED' | 'VOID'
    amount_minor: number
    receipt_no: string | null
    receipt_other_supplier: number
    entries: number
    entry_amount: number | null
    entry_other_supplier: number
    entry_misdated: number
    voids: number
    void_amount: number | null
    void_other_supplier: number
    void_misdated: number
  }>(
    `WITH entries AS MATERIALIZED (
       SELECT l.supplier_payment_id,
              count(CASE WHEN l.type = 'PAYMENT' THEN 1 END) AS entries,
              sum(CASE WHEN l.type = 'PAYMENT' THEN l.amount_minor END) AS entry_amount,
              count(CASE WHEN l.type = 'PAYMENT' AND l.supplier_id IS NOT p.supplier_id THEN 1 END) AS entry_other_supplier,
              count(CASE WHEN l.type = 'PAYMENT' AND l.entry_date IS NOT p.payment_date THEN 1 END) AS entry_misdated,
              count(CASE WHEN l.type = 'PAYMENT_VOID' THEN 1 END) AS voids,
              sum(CASE WHEN l.type = 'PAYMENT_VOID' THEN l.amount_minor END) AS void_amount,
              count(CASE WHEN l.type = 'PAYMENT_VOID' AND l.supplier_id IS NOT p.supplier_id THEN 1 END)
                AS void_other_supplier,
              count(CASE WHEN l.type = 'PAYMENT_VOID' AND l.entry_date IS NOT p.void_date THEN 1 END) AS void_misdated
       FROM supplier_ledger AS l
       JOIN supplier_payments AS p ON p.id = l.supplier_payment_id
       WHERE l.supplier_payment_id IS NOT NULL
       GROUP BY l.supplier_payment_id
     )
     SELECT p.payment_no, p.status, p.amount_minor, r.receipt_no,
            (p.stock_receipt_id IS NOT NULL AND r.supplier_id IS NOT p.supplier_id) AS receipt_other_supplier,
            coalesce(e.entries, 0) AS entries, e.entry_amount,
            coalesce(e.entry_other_supplier, 0) AS entry_other_supplier,
            coalesce(e.entry_misdated, 0) AS entry_misdated,
            coalesce(e.voids, 0) AS voids, e.void_amount,
            coalesce(e.void_other_supplier, 0) AS void_other_supplier,
            coalesce(e.void_misdated, 0) AS void_misdated
     FROM supplier_payments AS p
     LEFT JOIN stock_receipts AS r ON r.id = p.stock_receipt_id
     LEFT JOIN entries AS e ON e.supplier_payment_id = p.id
     ORDER BY p.id`
  )
  const issues: string[] = []
  for (const row of rows) {
    const label = `Supplier payment ${row.payment_no}`
    if (row.receipt_other_supplier === 1) {
      issues.push(`${label} names receipt ${row.receipt_no ?? 'unknown'} of another supplier.`)
    }
    if (row.entries === 0) issues.push(`${label} has no supplier account entry.`)
    else if (row.entries > 1) {
      issues.push(`${label} has ${row.entries} supplier account entries; one is expected.`)
    } else {
      if (row.entry_amount !== -row.amount_minor) {
        issues.push(
          `${label}: its supplier account entry is ${row.entry_amount}, but it should be ${-row.amount_minor}.`
        )
      }
      if (row.entry_other_supplier > 0)
        issues.push(`${label}: its supplier account entry is on another supplier.`)
      if (row.entry_misdated > 0)
        issues.push(`${label}: its supplier account entry is not dated on the payment date.`)
    }

    if (row.status === 'POSTED') {
      if (row.voids > 0) issues.push(`Posted supplier payment ${row.payment_no} has a void entry.`)
      continue
    }
    const voidLabel = `Void supplier payment ${row.payment_no}`
    if (row.voids === 0) issues.push(`${voidLabel} has no supplier account entry reversing it.`)
    else if (row.voids > 1) {
      issues.push(`${voidLabel} has ${row.voids} supplier void entries; one is expected.`)
    } else {
      if (row.void_amount !== row.amount_minor) {
        issues.push(
          `${voidLabel}: its supplier void entry is ${row.void_amount}, but it should be ${row.amount_minor}.`
        )
      }
      if (row.void_other_supplier > 0)
        issues.push(`${voidLabel}: its supplier void entry is on another supplier.`)
      if (row.void_misdated > 0)
        issues.push(`${voidLabel}: its supplier void entry is not dated on the void date.`)
    }
  }
  return { issues, checked: rows.length }
}
