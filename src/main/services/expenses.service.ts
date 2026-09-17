import { formatDisplayDate, localDateString } from '@shared/dates'
import {
  ExpenseCreateSchema,
  ExpenseIdSchema,
  ExpenseListInputSchema,
  ExpenseSummaryInputSchema,
  ExpenseUpdateSchema,
  INACTIVE_EXPENSE_CATEGORY_MESSAGE,
  VOID_EXPENSE_MESSAGE,
  type Expense,
  type ExpenseGroup,
  type ExpenseSaveResult,
  type ExpenseStatus,
  type ExpenseSummary
} from '@shared/expenses'
import type { ListPage } from '@shared/customers'
import type { Db, SqlValue } from '../db/adapter'
import { AppFailure, parseInput } from '../errors'
import { readExpenseCategory } from './expense-categories.service'
import { assertCurrencyDigits } from './settings.service'

/*
 * Expenses over the `expenses` table (plan §7, Phase 10). They touch no stock, customer or invoice record, so there is
 * no posting-date floor: any day up to today (the main process's clock) is allowed. An ACTIVE expense may be edited in
 * place (V1 keeps no edit history) or voided; a VOID expense never changes again. Nothing is deleted (a trigger refuses
 * it). A repeated create request id returns the expense already saved.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
const MAX_SEARCH_WORDS = 8

interface ExpenseRow {
  id: number
  expense_date: string
  category_id: number
  category_name: string
  category_group: ExpenseGroup
  category_active: number
  amount_minor: number
  description: string | null
  status: ExpenseStatus
  created_at: string
  updated_at: string
}

const SELECT_EXPENSES = `
  SELECT e.id, e.expense_date, e.category_id, c.name AS category_name, c.grp AS category_group,
         c.is_active AS category_active, e.amount_minor, e.description, e.status, e.created_at, e.updated_at
  FROM expenses AS e JOIN expense_categories AS c ON c.id = e.category_id`

/** Expenses newest first, filtered by search words (description or category name), group, status and date range. */
export function listExpenses(db: Db, input: unknown): ListPage<Expense> {
  const filters = parseInput(ExpenseListInputSchema, input)
  const { page, pageSize } = filters
  const clauses: string[] = []
  const params: SqlValue[] = []
  const words = filters.search
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, MAX_SEARCH_WORDS)
  for (const word of words) {
    const pattern = `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    clauses.push(`(e.description LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')`)
    params.push(pattern, pattern)
  }
  if (filters.group !== 'all') {
    clauses.push('c.grp = ?')
    params.push(filters.group)
  }
  if (filters.status !== 'all') {
    clauses.push('e.status = ?')
    params.push(filters.status)
  }
  addDateRange(clauses, params, filters)
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM expenses AS e JOIN expense_categories AS c ON c.id = e.category_id ${where}`,
    params
  )!.n
  const rows = db.all<ExpenseRow>(
    `${SELECT_EXPENSES} ${where} ORDER BY e.expense_date DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  )
  return { items: rows.map(toExpense), total, page, pageSize }
}

/** ACTIVE expense totals by group for a date range (open sides allowed). */
export function summarizeExpenses(db: Db, input: unknown): ExpenseSummary {
  const range = parseInput(ExpenseSummaryInputSchema, input)
  const clauses = ["e.status = 'ACTIVE'"]
  const params: SqlValue[] = []
  addDateRange(clauses, params, range)
  const rows = db.all<{ grp: ExpenseGroup; total: number }>(
    `SELECT c.grp, coalesce(sum(e.amount_minor), 0) AS total
     FROM expenses AS e JOIN expense_categories AS c ON c.id = e.category_id
     WHERE ${clauses.join(' AND ')}
     GROUP BY c.grp`,
    params
  )
  const shopMinor = rows.find((row) => row.grp === 'SHOP')?.total ?? 0
  const generalMinor = rows.find((row) => row.grp === 'GENERAL')?.total ?? 0
  return {
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    shopMinor,
    generalMinor,
    totalMinor: shopMinor + generalMinor
  }
}

export function getExpense(db: Db, id: unknown): Expense {
  return readExpense(db, parseInput(ExpenseIdSchema, id))
}

/** Saves an expense; a request id already saved returns that expense and adds nothing. */
export function createExpense(db: Db, input: unknown, now: Date): ExpenseSaveResult {
  const expense = parseInput(ExpenseCreateSchema, input)
  return db.transaction(() => {
    const saved = db.get<{ id: number }>('SELECT id FROM expenses WHERE request_id = ?', [
      expense.requestId
    ])
    if (saved !== undefined) return { ...readExpense(db, saved.id), replayed: true }

    assertCurrencyDigits(db, expense.currencyMinorDigits)
    assertExpenseDate(expense.expenseDate, now)
    assertCategoryUsable(db, expense.categoryId, null)
    const { lastInsertRowid } = db.run(
      `INSERT INTO expenses (request_id, expense_date, category_id, amount_minor, description)
       VALUES (?, ?, ?, ?, ?)`,
      [
        expense.requestId,
        expense.expenseDate,
        expense.categoryId,
        expense.amountMinor,
        expense.description
      ]
    )
    return { ...readExpense(db, Number(lastInsertRowid)), replayed: false }
  })
}

/** Edits an ACTIVE expense: date, category, amount and description, all validated again. */
export function updateExpense(db: Db, input: unknown, now: Date): Expense {
  const expense = parseInput(ExpenseUpdateSchema, input)
  return db.transaction(() => {
    const current = readExpense(db, expense.id)
    if (current.status === 'VOID') {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: 'This expense is void, so it can no longer be edited.'
      })
    }
    assertCurrencyDigits(db, expense.currencyMinorDigits)
    assertExpenseDate(expense.expenseDate, now)
    assertCategoryUsable(db, expense.categoryId, current.categoryId)
    db.run(
      `UPDATE expenses SET expense_date = ?, category_id = ?, amount_minor = ?, description = ?, updated_at = ${NOW}
       WHERE id = ?`,
      [
        expense.expenseDate,
        expense.categoryId,
        expense.amountMinor,
        expense.description,
        expense.id
      ]
    )
    return readExpense(db, expense.id)
  })
}

/** Voids an ACTIVE expense. The row stays, and a void expense never changes again. */
export function voidExpense(db: Db, id: unknown): Expense {
  const expenseId = parseInput(ExpenseIdSchema, id)
  return db.transaction(() => {
    const current = readExpense(db, expenseId)
    if (current.status === 'VOID') {
      throw new AppFailure({ code: 'FORBIDDEN_STATE', message: VOID_EXPENSE_MESSAGE })
    }
    db.run(`UPDATE expenses SET status = 'VOID', updated_at = ${NOW} WHERE id = ?`, [expenseId])
    return readExpense(db, expenseId)
  })
}

function readExpense(db: Db, id: number): Expense {
  const row = db.get<ExpenseRow>(`${SELECT_EXPENSES} WHERE e.id = ?`, [id])
  if (row === undefined) {
    throw new AppFailure({ code: 'NOT_FOUND', message: 'This expense no longer exists.' })
  }
  return toExpense(row)
}

/** Today or earlier by the main process's clock; no floor, since expenses touch no other ledger. */
function assertExpenseDate(date: string, now: Date): void {
  const today = localDateString(now)
  if (date <= today) return
  const message = `The expense date cannot be after today (${formatDisplayDate(today)}).`
  throw new AppFailure({
    code: 'DATE_NOT_ALLOWED',
    message,
    fieldErrors: { expenseDate: [message] }
  })
}

/** The category exists and is active; an edit may keep the expense's current category even when it is inactive. */
function assertCategoryUsable(db: Db, categoryId: number, currentCategoryId: number | null): void {
  const category = readExpenseCategory(db, categoryId, 'categoryId')
  if (category.isActive || category.id === currentCategoryId) return
  throw new AppFailure({
    code: 'FORBIDDEN_STATE',
    message: INACTIVE_EXPENSE_CATEGORY_MESSAGE,
    fieldErrors: { categoryId: [INACTIVE_EXPENSE_CATEGORY_MESSAGE] }
  })
}

function addDateRange(
  clauses: string[],
  params: SqlValue[],
  range: { readonly dateFrom: string | null; readonly dateTo: string | null }
): void {
  if (range.dateFrom !== null) {
    clauses.push('e.expense_date >= ?')
    params.push(range.dateFrom)
  }
  if (range.dateTo !== null) {
    clauses.push('e.expense_date <= ?')
    params.push(range.dateTo)
  }
}

function toExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    expenseDate: row.expense_date,
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryGroup: row.category_group,
    categoryActive: row.category_active === 1,
    amountMinor: row.amount_minor,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
