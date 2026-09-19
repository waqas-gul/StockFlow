import type { ListPage, OpeningBalanceInput } from '@shared/customers'
import { localDateString } from '@shared/dates'
import type { PaymentMethod, PaymentStatus } from '@shared/payments'
import {
  SupplierBalanceAdjustmentInputSchema,
  SupplierCreateSchema,
  SupplierIdSchema,
  SupplierLedgerInputSchema,
  SupplierListInputSchema,
  SupplierSearchInputSchema,
  SupplierUpdateSchema,
  formatSupplierCode,
  type Supplier,
  type SupplierBalanceAdjustmentResult,
  type SupplierLedger,
  type SupplierLedgerRow,
  type SupplierLedgerType,
  type SupplierListItem,
  type SupplierProductRow
} from '@shared/suppliers'
import { SetActiveSchema } from '@shared/validation'
import type { Db, SqlValue } from '../db/adapter'
import { AppFailure, parseInput } from '../errors'
import { quantityText } from './inventory'
import { takeSequenceValue } from './sequences'
import { assertCurrencyDigits } from './settings.service'
import {
  appendSupplierLedgerEntry,
  assertSupplierPostingDate,
  hasSupplierLedgerEntries,
  supplierLabel,
  supplierNotFound,
  supplierRow
} from './supplier-ledger'

/*
 * Suppliers, their opening balances, balance adjustments and the supplier ledger view (migration 0003).
 *
 * - The code (SUP-00001, …) comes from the `supplier` sequence inside the create transaction, so a failed create uses
 *   no number. Names may repeat; only the code is unique.
 * - An opening balance is written only when the supplier is created, as its first ledger entry, in the same transaction.
 *   Later corrections are ADJUSTMENT entries. Profile edits never touch the ledger.
 * - A supplier is never deleted: it is deactivated, and its history stays readable. New stock purchases need an active
 *   supplier; payments, payment voids and adjustments work for an inactive one too, so old debts can still be settled.
 * - Balances are Σ supplier_ledger.amount_minor, read fresh on every call. The purchase and payment totals are read
 *   from the POSTED receipts and payments; nothing is stored.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
const MAX_SEARCH_WORDS = 8

interface SupplierQueryRow {
  id: number
  code: string
  name: string
  contact_person: string | null
  phone: string | null
  address: string | null
  city: string | null
  notes: string | null
  is_active: number
  balance_minor: number
  latest_entry_date: string | null
  created_at: string
  updated_at: string
}

interface LedgerQueryRow {
  id: number
  entry_date: string
  type: SupplierLedgerType
  amount_minor: number
  running_balance: number
  receipt_id: number | null
  receipt_no: string | null
  supplier_bill_no: string | null
  payment_id: number | null
  payment_no: string | null
  payment_method: PaymentMethod | null
  payment_status: PaymentStatus | null
  note: string | null
  created_at: string
}

const SELECT_SUPPLIERS = `
  SELECT s.id, s.code, s.name, s.contact_person, s.phone, s.address, s.city, s.notes, s.is_active, s.created_at,
         s.updated_at,
         (SELECT coalesce(sum(l.amount_minor), 0) FROM supplier_ledger AS l WHERE l.supplier_id = s.id) AS balance_minor,
         (SELECT max(l.entry_date) FROM supplier_ledger AS l WHERE l.supplier_id = s.id) AS latest_entry_date
  FROM suppliers AS s`

const SELECT_LEDGER = `
  SELECT l.id, l.entry_date, l.type, l.amount_minor,
         sum(l.amount_minor) OVER (ORDER BY l.entry_date, l.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
           AS running_balance,
         l.stock_receipt_id AS receipt_id, r.receipt_no, r.supplier_bill_no,
         l.supplier_payment_id AS payment_id, p.payment_no, p.method AS payment_method, p.status AS payment_status,
         l.note, l.created_at
  FROM supplier_ledger AS l
  LEFT JOIN stock_receipts AS r ON r.id = l.stock_receipt_id
  LEFT JOIN supplier_payments AS p ON p.id = l.supplier_payment_id
  WHERE l.supplier_id = ?`

/** One page of the Suppliers table, by name, each with its balance. */
export function listSuppliers(db: Db, input: unknown): ListPage<SupplierListItem> {
  const { page, pageSize, search, status } = parseInput(SupplierListInputSchema, input)
  const clauses: string[] = []
  const params: SqlValue[] = []
  addSearch(search, clauses, params)
  if (status !== 'all') clauses.push(`s.is_active = ${status === 'active' ? 1 : 0}`)
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM suppliers AS s ${where}`,
    params
  )!.n
  const rows = db.all<SupplierQueryRow>(
    `${SELECT_SUPPLIERS} ${where} ORDER BY s.name, s.code, s.id LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  )
  return { items: rows.map(toListItem), total, page, pageSize }
}

/**
 * Quick lookup for choosing a supplier: every word must match the code, name, contact person, phone or city. An exact
 * code comes first, then codes and names that start with the text. With nothing typed every supplier comes back by
 * name, so the picker opens on a list to browse instead of on nothing.
 */
export function searchSuppliers(db: Db, input: unknown): SupplierListItem[] {
  const { query, limit, includeInactive } = parseInput(SupplierSearchInputSchema, input)
  const clauses: string[] = []
  const params: SqlValue[] = []
  addSearch(query, clauses, params)
  if (!includeInactive) clauses.push('s.is_active = 1')
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  if (query === '') {
    return db
      .all<SupplierQueryRow>(
        `${SELECT_SUPPLIERS} ${where} ORDER BY s.name, s.code, s.id LIMIT ?`,
        [limit]
      )
      .map(toListItem)
  }
  const prefix = `${escapeLike(query)}%`
  const rows = db.all<SupplierQueryRow>(
    `SELECT * FROM (
       ${SELECT_SUPPLIERS.replace(
         'SELECT s.id,',
         `SELECT CASE WHEN s.code = ? THEN 0 WHEN s.code LIKE ? ESCAPE '\\' THEN 1
                      WHEN s.name LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END AS rank, s.id,`
       )}
       ${where}
     )
     ORDER BY rank, name, code, id
     LIMIT ?`,
    [query, prefix, prefix, ...params, limit]
  )
  return rows.map(toListItem)
}

/** One supplier with the current balance, purchase and payment totals, and the products bought from it. */
export function getSupplier(db: Db, id: unknown): Supplier {
  return readSupplier(db, parseInput(SupplierIdSchema, id))
}

/** Creates a supplier with the next code and, when one is entered, the opening balance entry: both or neither. */
export function createSupplier(db: Db, input: unknown, now: Date): Supplier {
  const supplier = parseInput(SupplierCreateSchema, input)
  return db.transaction(() => {
    assertCurrencyDigits(db, supplier.currencyMinorDigits)
    const code = formatSupplierCode(takeSequenceValue(db, 'supplier'))
    if (db.get('SELECT 1 AS found FROM suppliers WHERE code = ?', [code]) !== undefined) {
      throw new AppFailure({
        code: 'CONFLICT',
        message: `The next supplier code, ${code}, is already in use, so the supplier was not saved.`
      })
    }
    const id = Number(
      db.run(
        `INSERT INTO suppliers (code, name, contact_person, phone, address, city, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          code,
          supplier.name,
          supplier.contactPerson,
          supplier.phone,
          supplier.address,
          supplier.city,
          supplier.notes
        ]
      ).lastInsertRowid
    )
    if (supplier.opening !== null && supplier.opening.amountMinor > 0) {
      postSupplierOpeningBalance(db, id, supplier.opening, localDateString(now))
    }
    return readSupplier(db, id)
  })
}

/**
 * Writes a supplier's OPENING entry: +amount when the shop owes the supplier, −amount for a supplier advance. Allowed
 * only as the supplier's first ledger entry; afterwards a correction is an adjustment. Runs inside the caller's
 * transaction.
 */
export function postSupplierOpeningBalance(
  db: Db,
  supplierId: number,
  opening: OpeningBalanceInput,
  today: string
): void {
  const supplier = supplierRow(db, supplierId)
  if (hasSupplierLedgerEntries(db, supplierId)) {
    throw new AppFailure({
      code: 'FORBIDDEN_STATE',
      message: `${supplierLabel(supplier)} already has account entries, so an opening balance can no longer be entered. Use Adjust Balance instead.`
    })
  }
  assertSupplierPostingDate(db, { date: opening.date, today, supplier, field: 'opening.date' })
  appendSupplierLedgerEntry(db, {
    supplierId,
    date: opening.date,
    type: 'OPENING',
    amountMinor: opening.side === 'DUE' ? opening.amountMinor : -opening.amountMinor
  })
}

/** Saves the profile. The code, the opening balance and every ledger entry stay as they are. */
export function updateSupplier(db: Db, input: unknown): Supplier {
  const supplier = parseInput(SupplierUpdateSchema, input)
  return db.transaction(() => {
    supplierRow(db, supplier.id)
    db.run(
      `UPDATE suppliers SET name = ?, contact_person = ?, phone = ?, address = ?, city = ?, notes = ?,
         updated_at = ${NOW}
       WHERE id = ?`,
      [
        supplier.name,
        supplier.contactPerson,
        supplier.phone,
        supplier.address,
        supplier.city,
        supplier.notes,
        supplier.id
      ]
    )
    return readSupplier(db, supplier.id)
  })
}

/** Activates or deactivates a supplier; nothing is removed, and the balance and history stay. */
export function setSupplierActive(db: Db, input: unknown): Supplier {
  const { id, active } = parseInput(SetActiveSchema, input)
  return db.transaction(() => {
    const row = supplierRow(db, id)
    if ((row.is_active === 1) !== active) {
      db.run(`UPDATE suppliers SET is_active = ?, updated_at = ${NOW} WHERE id = ?`, [
        active ? 1 : 0,
        id
      ])
    }
    return readSupplier(db, id)
  })
}

/** One page of the supplier's ledger, oldest first, with the running balance after each entry. */
export function supplierLedger(db: Db, input: unknown): SupplierLedger {
  const { supplierId, page, pageSize } = parseInput(SupplierLedgerInputSchema, input)
  const supplier = readSupplier(db, supplierId)
  const total = db.get<{ n: number }>(
    'SELECT count(*) AS n FROM supplier_ledger WHERE supplier_id = ?',
    [supplierId]
  )!.n
  const current = page ?? Math.max(1, Math.ceil(total / pageSize))
  const rows = db.all<LedgerQueryRow>(
    `SELECT * FROM (${SELECT_LEDGER}) ORDER BY entry_date, id LIMIT ? OFFSET ?`,
    [supplierId, pageSize, (current - 1) * pageSize]
  )
  return { supplier, rows: rows.map(toLedgerRow), total, page: current, pageSize }
}

/**
 * An account correction: one ADJUSTMENT entry, +amount (the shop owes more) or −amount (owes less), with its reason. It
 * respects the supplier's posting-date floor, and is allowed for an inactive supplier, who stays inactive. Stock
 * corrections never change a supplier account, so this is how a changed supplier bill is recorded.
 */
export function adjustSupplierBalance(
  db: Db,
  input: unknown,
  now: Date
): SupplierBalanceAdjustmentResult {
  const adjustment = parseInput(SupplierBalanceAdjustmentInputSchema, input)
  return db.transaction(() => {
    assertCurrencyDigits(db, adjustment.currencyMinorDigits)
    const supplier = supplierRow(db, adjustment.supplierId, 'supplierId')
    assertSupplierPostingDate(db, {
      date: adjustment.entryDate,
      today: localDateString(now),
      supplier,
      field: 'entryDate'
    })
    const entryId = appendSupplierLedgerEntry(db, {
      supplierId: supplier.id,
      date: adjustment.entryDate,
      type: 'ADJUSTMENT',
      amountMinor:
        adjustment.direction === 'INCREASE' ? adjustment.amountMinor : -adjustment.amountMinor,
      note: adjustment.reason
    })
    const entry = db.get<LedgerQueryRow>(`SELECT * FROM (${SELECT_LEDGER}) WHERE id = ?`, [
      supplier.id,
      entryId
    ])!
    return { entry: toLedgerRow(entry), supplier: readSupplier(db, supplier.id) }
  })
}

export function readSupplier(db: Db, id: number): Supplier {
  const row = db.get<SupplierQueryRow>(`${SELECT_SUPPLIERS} WHERE s.id = ?`, [id])
  if (row === undefined) throw supplierNotFound()
  const purchases = db.get<{ total: number; n: number; latest: string | null }>(
    `SELECT coalesce(sum(total_cost_minor), 0) AS total, count(*) AS n, max(receipt_date) AS latest
     FROM stock_receipts WHERE supplier_id = ? AND status = 'POSTED'`,
    [id]
  )!
  const payments = db.get<{ total: number; n: number; latest: string | null }>(
    `SELECT coalesce(sum(amount_minor), 0) AS total, count(*) AS n, max(payment_date) AS latest
     FROM supplier_payments WHERE supplier_id = ? AND status = 'POSTED'`,
    [id]
  )!
  return {
    ...toListItem(row),
    address: row.address,
    notes: row.notes,
    latestEntryDate: row.latest_entry_date,
    totalPurchasesMinor: purchases.total,
    purchaseCount: purchases.n,
    totalPaidMinor: payments.total,
    paymentCount: payments.n,
    lastPurchaseDate: purchases.latest,
    lastPaymentDate: payments.latest,
    productsPurchased: productsPurchased(db, id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * The products on the supplier's POSTED receipts: the latest purchase (date, unit cost and unit of the latest line) and
 * the total quantity. History only; stock figures always come from the stock ledger.
 */
function productsPurchased(db: Db, supplierId: number): SupplierProductRow[] {
  const rows = db.all<{
    product_id: number
    code: string
    name: string
    total_qty: number
    last_date: string
    last_cost: number
    last_unit: string
  }>(
    `WITH lines AS MATERIALIZED (
       SELECT ri.product_id, ri.qty_base, ri.unit_cost_minor, ri.unit_name, r.receipt_date,
              row_number() OVER (
                PARTITION BY ri.product_id ORDER BY r.receipt_date DESC, r.id DESC, ri.line_no DESC
              ) AS recency
       FROM stock_receipt_items AS ri
       JOIN stock_receipts AS r ON r.id = ri.receipt_id
       WHERE r.supplier_id = ? AND r.status = 'POSTED'
     )
     SELECT l.product_id, p.code, p.name,
            (SELECT sum(t.qty_base) FROM lines AS t WHERE t.product_id = l.product_id) AS total_qty,
            l.receipt_date AS last_date, l.unit_cost_minor AS last_cost, l.unit_name AS last_unit
     FROM lines AS l
     JOIN products AS p ON p.id = l.product_id
     WHERE l.recency = 1
     ORDER BY p.code COLLATE NOCASE, p.id`,
    [supplierId]
  )
  return rows.map((row) => ({
    productId: row.product_id,
    code: row.code,
    name: row.name,
    lastPurchaseDate: row.last_date,
    lastUnitCostMinor: row.last_cost,
    lastUnitName: row.last_unit,
    totalQtyBase: row.total_qty,
    totalQuantityText: quantityText(db, row.product_id, row.total_qty)
  }))
}

function toListItem(row: SupplierQueryRow): SupplierListItem {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    contactPerson: row.contact_person,
    phone: row.phone,
    city: row.city,
    isActive: row.is_active === 1,
    balanceMinor: row.balance_minor
  }
}

function toLedgerRow(row: LedgerQueryRow): SupplierLedgerRow {
  return {
    id: row.id,
    entryDate: row.entry_date,
    type: row.type,
    amountMinor: row.amount_minor,
    runningBalanceMinor: row.running_balance,
    receiptId: row.receipt_id,
    receiptNo: row.receipt_no,
    supplierBillNo: row.supplier_bill_no,
    paymentId: row.payment_id,
    paymentNo: row.payment_no,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    note: row.note,
    createdAt: row.created_at
  }
}

/**
 * Every word must match the code, name, contact person, phone or city (LIKE, so English letters ignore case; % and _
 * are plain text). A word that looks like a phone number also matches the phone with its spaces and dashes ignored.
 */
function addSearch(text: string, clauses: string[], params: SqlValue[]): void {
  const words = text
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, MAX_SEARCH_WORDS)
  for (const word of words) {
    const pattern = `%${escapeLike(word)}%`
    const fields = ['s.code', 's.name', 's.contact_person', 's.phone', 's.city'].map(
      (column) => `${column} LIKE ? ESCAPE '\\'`
    )
    params.push(pattern, pattern, pattern, pattern, pattern)
    const digits = word.replace(/\D/g, '')
    if (/^[\d()+-]+$/.test(word) && digits.length >= 3) {
      fields.push(
        "replace(replace(replace(replace(replace(s.phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?"
      )
      params.push(`%${digits}%`)
    }
    clauses.push(`(${fields.join(' OR ')})`)
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`)
}
