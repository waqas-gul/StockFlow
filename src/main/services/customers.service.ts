import {
  BalanceAdjustmentInputSchema,
  CustomerCreateSchema,
  CustomerIdSchema,
  CustomerLedgerInputSchema,
  CustomerListInputSchema,
  CustomerSearchInputSchema,
  CustomerUpdateSchema,
  formatCustomerCode,
  isWalkInCustomer,
  type BalanceAdjustmentResult,
  type Customer,
  type CustomerLedger,
  type CustomerListItem,
  type LedgerEntryType,
  type LedgerRow,
  type ListPage,
  type OpeningBalanceInput
} from '@shared/customers'
import { localDateString } from '@shared/dates'
import { SetActiveSchema } from '@shared/validation'
import type { Db, SqlValue } from '../db/adapter'
import { AppFailure, parseInput } from '../errors'
import {
  appendLedgerEntry,
  assertCustomerPostingDate,
  customerNotFound,
  customerRow,
  hasLedgerEntries
} from './customer-ledger'
import { takeSequenceValue } from './sequences'
import { assertCurrencyDigits } from './settings.service'

/*
 * Customers, their opening balances, balance adjustments and the customer ledger view (plan §7.3, §10).
 *
 * - The code (C-00002, …) comes from the `customer` sequence inside the create transaction, so a failed create uses
 *   no number. The seeded walk-in customer owns C-00001. Names and shop names may repeat; only the code is unique.
 * - An opening balance is written only when the customer is created, as its first ledger entry, in the same transaction.
 *   Later corrections are ADJUSTMENT entries. Profile edits never touch the ledger.
 * - A customer is never deleted: it is deactivated, and its history stays readable. The walk-in customer (C-00001) is
 *   always active and keeps its name.
 * - Balances are Σ customer_ledger.amount_minor, read fresh on every call.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
const MAX_SEARCH_WORDS = 8

interface CustomerQueryRow {
  id: number
  code: string
  name: string
  shop_name: string | null
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
  type: LedgerEntryType
  amount_minor: number
  running_balance: number
  payment_id: number | null
  payment_no: string | null
  payment_method: string | null
  payment_reference: string | null
  payment_status: 'POSTED' | 'VOID' | null
  invoice_id: number | null
  invoice_no: string | null
  note: string | null
  created_at: string
}

const SELECT_CUSTOMERS = `
  SELECT c.id, c.code, c.name, c.shop_name, c.phone, c.address, c.city, c.notes, c.is_active, c.created_at,
         c.updated_at,
         (SELECT coalesce(sum(l.amount_minor), 0) FROM customer_ledger AS l WHERE l.customer_id = c.id) AS balance_minor,
         (SELECT max(l.entry_date) FROM customer_ledger AS l WHERE l.customer_id = c.id) AS latest_entry_date
  FROM customers AS c`

const SELECT_LEDGER = `
  SELECT l.id, l.entry_date, l.type, l.amount_minor,
         sum(l.amount_minor) OVER (ORDER BY l.entry_date, l.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
           AS running_balance,
         l.payment_id, p.payment_no, p.method AS payment_method, p.reference AS payment_reference,
         p.status AS payment_status, l.invoice_id, i.invoice_no, l.note, l.created_at
  FROM customer_ledger AS l
  LEFT JOIN payments AS p ON p.id = l.payment_id
  LEFT JOIN invoices AS i ON i.id = l.invoice_id
  WHERE l.customer_id = ?`

/** One page of the Customers table, by name, each with its balance. */
export function listCustomers(db: Db, input: unknown): ListPage<CustomerListItem> {
  const { page, pageSize, search, status } = parseInput(CustomerListInputSchema, input)
  const clauses: string[] = []
  const params: SqlValue[] = []
  addSearch(search, clauses, params)
  if (status !== 'all') clauses.push(`c.is_active = ${status === 'active' ? 1 : 0}`)
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM customers AS c ${where}`,
    params
  )!.n
  const rows = db.all<CustomerQueryRow>(
    `${SELECT_CUSTOMERS} ${where} ORDER BY c.name, c.code, c.id LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  )
  return { items: rows.map(toListItem), total, page, pageSize }
}

/**
 * Quick lookup for choosing a customer: every word must match the code, name, shop name, phone or city. An exact code
 * comes first, then codes, names and shop names that start with the text.
 */
export function searchCustomers(db: Db, input: unknown): CustomerListItem[] {
  const { query, limit, includeInactive } = parseInput(CustomerSearchInputSchema, input)
  const clauses: string[] = []
  const params: SqlValue[] = []
  addSearch(query, clauses, params)
  if (clauses.length === 0) return []
  if (!includeInactive) clauses.push('c.is_active = 1')
  const prefix = `${escapeLike(query)}%`
  const rows = db.all<CustomerQueryRow>(
    `SELECT * FROM (
       ${SELECT_CUSTOMERS.replace(
         'SELECT c.id,',
         `SELECT CASE WHEN c.code = ? THEN 0 WHEN c.code LIKE ? ESCAPE '\\' THEN 1
                      WHEN c.name LIKE ? ESCAPE '\\' THEN 2 WHEN c.shop_name LIKE ? ESCAPE '\\' THEN 3
                      ELSE 4 END AS rank, c.id,`
       )}
       WHERE ${clauses.join(' AND ')}
     )
     ORDER BY rank, name, code, id
     LIMIT ?`,
    [query, prefix, prefix, prefix, ...params, limit]
  )
  return rows.map(toListItem)
}

/** One customer with the current balance and posting-date floor. */
export function getCustomer(db: Db, id: unknown): Customer {
  return readCustomer(db, parseInput(CustomerIdSchema, id))
}

/** Creates a customer with the next code and, when one is entered, the opening balance entry: both or neither. */
export function createCustomer(db: Db, input: unknown, now: Date): Customer {
  const customer = parseInput(CustomerCreateSchema, input)
  return db.transaction(() => {
    assertCurrencyDigits(db, customer.currencyMinorDigits)
    const code = formatCustomerCode(takeSequenceValue(db, 'customer'))
    if (db.get('SELECT 1 AS found FROM customers WHERE code = ?', [code]) !== undefined) {
      throw new AppFailure({
        code: 'CONFLICT',
        message: `The next customer code, ${code}, is already in use, so the customer was not saved.`
      })
    }
    const id = Number(
      db.run(
        `INSERT INTO customers (code, name, shop_name, phone, address, city, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          code,
          customer.name,
          customer.shopName,
          customer.phone,
          customer.address,
          customer.city,
          customer.notes
        ]
      ).lastInsertRowid
    )
    if (customer.opening !== null && customer.opening.amountMinor > 0) {
      postOpeningBalance(db, id, customer.opening, localDateString(now))
    }
    return readCustomer(db, id)
  })
}

/**
 * Writes a customer's OPENING entry: +amount when the customer owes the shop, −amount for an advance. Allowed only as
 * the customer's first ledger entry; afterwards a correction is an adjustment. Runs inside the caller's transaction.
 */
export function postOpeningBalance(
  db: Db,
  customerId: number,
  opening: OpeningBalanceInput,
  today: string
): void {
  const customer = customerRow(db, customerId)
  if (hasLedgerEntries(db, customerId)) {
    throw new AppFailure({
      code: 'FORBIDDEN_STATE',
      message: `${customer.code} ${customer.name} already has account entries, so an opening balance can no longer be entered. Use Adjust Balance instead.`
    })
  }
  assertCustomerPostingDate(db, { date: opening.date, today, customer, field: 'opening.date' })
  appendLedgerEntry(db, {
    customerId,
    date: opening.date,
    type: 'OPENING',
    amountMinor: opening.side === 'DUE' ? opening.amountMinor : -opening.amountMinor
  })
}

/** Saves the profile. The code, the opening balance and every ledger entry stay as they are. */
export function updateCustomer(db: Db, input: unknown): Customer {
  const customer = parseInput(CustomerUpdateSchema, input)
  return db.transaction(() => {
    const row = customerRow(db, customer.id)
    if (isWalkInCustomer(row.code) && customer.name !== row.name) {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: `${row.code} ${row.name} is the walk-in customer, so its name cannot be changed.`,
        fieldErrors: { name: ['The walk-in customer keeps its name.'] }
      })
    }
    db.run(
      `UPDATE customers SET name = ?, shop_name = ?, phone = ?, address = ?, city = ?, notes = ?, updated_at = ${NOW}
       WHERE id = ?`,
      [
        customer.name,
        customer.shopName,
        customer.phone,
        customer.address,
        customer.city,
        customer.notes,
        customer.id
      ]
    )
    return readCustomer(db, customer.id)
  })
}

/**
 * Activates or deactivates a customer; nothing is removed, and the balance and history stay. The walk-in customer is
 * always active.
 */
export function setCustomerActive(db: Db, input: unknown): Customer {
  const { id, active } = parseInput(SetActiveSchema, input)
  return db.transaction(() => {
    const row = customerRow(db, id)
    if (!active && isWalkInCustomer(row.code)) {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: `${row.code} ${row.name} is the walk-in customer, so it is always active.`
      })
    }
    if ((row.is_active === 1) !== active) {
      db.run(`UPDATE customers SET is_active = ?, updated_at = ${NOW} WHERE id = ?`, [
        active ? 1 : 0,
        id
      ])
    }
    return readCustomer(db, id)
  })
}

/** One page of the customer's ledger, oldest first, with the running balance after each entry. */
export function customerLedger(db: Db, input: unknown): CustomerLedger {
  const { customerId, page, pageSize } = parseInput(CustomerLedgerInputSchema, input)
  const customer = readCustomer(db, customerId)
  const total = db.get<{ n: number }>(
    'SELECT count(*) AS n FROM customer_ledger WHERE customer_id = ?',
    [customerId]
  )!.n
  const current = page ?? Math.max(1, Math.ceil(total / pageSize))
  const rows = db.all<LedgerQueryRow>(
    `SELECT * FROM (${SELECT_LEDGER}) ORDER BY entry_date, id LIMIT ? OFFSET ?`,
    [customerId, pageSize, (current - 1) * pageSize]
  )
  return { customer, rows: rows.map(toLedgerRow), total, page: current, pageSize }
}

/**
 * An account correction: one ADJUSTMENT entry, +amount (owes more) or −amount (owes less), with its reason. It respects
 * the customer's posting-date floor, and is allowed for an inactive customer, who stays inactive.
 */
export function adjustCustomerBalance(db: Db, input: unknown, now: Date): BalanceAdjustmentResult {
  const adjustment = parseInput(BalanceAdjustmentInputSchema, input)
  return db.transaction(() => {
    assertCurrencyDigits(db, adjustment.currencyMinorDigits)
    const customer = customerRow(db, adjustment.customerId, 'customerId')
    assertCustomerPostingDate(db, {
      date: adjustment.entryDate,
      today: localDateString(now),
      customer,
      field: 'entryDate'
    })
    const entryId = appendLedgerEntry(db, {
      customerId: customer.id,
      date: adjustment.entryDate,
      type: 'ADJUSTMENT',
      amountMinor:
        adjustment.direction === 'INCREASE' ? adjustment.amountMinor : -adjustment.amountMinor,
      note: adjustment.reason
    })
    const entry = db.get<LedgerQueryRow>(`SELECT * FROM (${SELECT_LEDGER}) WHERE id = ?`, [
      customer.id,
      entryId
    ])!
    return { entry: toLedgerRow(entry), customer: readCustomer(db, customer.id) }
  })
}

function readCustomer(db: Db, id: number): Customer {
  const row = db.get<CustomerQueryRow>(`${SELECT_CUSTOMERS} WHERE c.id = ?`, [id])
  if (row === undefined) throw customerNotFound()
  return toCustomer(row)
}

function toListItem(row: CustomerQueryRow): CustomerListItem {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    shopName: row.shop_name,
    phone: row.phone,
    city: row.city,
    isActive: row.is_active === 1,
    balanceMinor: row.balance_minor
  }
}

function toCustomer(row: CustomerQueryRow): Customer {
  return {
    ...toListItem(row),
    address: row.address,
    notes: row.notes,
    latestEntryDate: row.latest_entry_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toLedgerRow(row: LedgerQueryRow): LedgerRow {
  return {
    id: row.id,
    entryDate: row.entry_date,
    type: row.type,
    amountMinor: row.amount_minor,
    runningBalanceMinor: row.running_balance,
    paymentId: row.payment_id,
    paymentNo: row.payment_no,
    paymentMethod: row.payment_method,
    paymentReference: row.payment_reference,
    paymentStatus: row.payment_status,
    invoiceId: row.invoice_id,
    invoiceNo: row.invoice_no,
    note: row.note,
    createdAt: row.created_at
  }
}

/**
 * Every word must match the code, name, shop name, phone or city (LIKE, so English letters ignore case; % and _ are
 * plain text). A word that looks like a phone number also matches the phone with its spaces and dashes ignored.
 */
function addSearch(text: string, clauses: string[], params: SqlValue[]): void {
  const words = text
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, MAX_SEARCH_WORDS)
  for (const word of words) {
    const pattern = `%${escapeLike(word)}%`
    const fields = ['c.code', 'c.name', 'c.shop_name', 'c.phone', 'c.city'].map(
      (column) => `${column} LIKE ? ESCAPE '\\'`
    )
    params.push(pattern, pattern, pattern, pattern, pattern)
    const digits = word.replace(/\D/g, '')
    if (/^[\d()+-]+$/.test(word) && digits.length >= 3) {
      fields.push(
        "replace(replace(replace(replace(replace(c.phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?"
      )
      params.push(`%${digits}%`)
    }
    clauses.push(`(${fields.join(' OR ')})`)
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`)
}
