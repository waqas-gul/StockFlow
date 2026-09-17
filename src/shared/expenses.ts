import { z } from 'zod'
import { CurrencyDigitsSchema, PositiveAmountSchema } from './customers'
import { isCalendarDate } from './dates'
import {
  DateSchema,
  IdSchema,
  RequestIdSchema,
  optionalText,
  requiredText,
  wholeNumber
} from './validation'

/*
 * Expenses (plan §7, Phase 10). Each expense belongs to a category, and each category to a group: SHOP (shop expenses)
 * or GENERAL (monthly / general expenses). "Monthly" only names the group: nothing repeats automatically.
 *
 * An expense is dated today or earlier (no posting-date floor: expenses touch no stock or customer ledger). It may be
 * edited while ACTIVE and voided once; it is never deleted, and a void expense never changes again. Categories are never
 * deleted either: an inactive category stays on its expenses but cannot be chosen for another one. Amounts are whole
 * minor units. The same schemas validate the forms (renderer) and every request (main process).
 */

export const EXPENSE_GROUPS = ['SHOP', 'GENERAL'] as const
export type ExpenseGroup = (typeof EXPENSE_GROUPS)[number]

export const EXPENSE_GROUP_LABELS: Readonly<Record<ExpenseGroup, string>> = Object.freeze({
  SHOP: 'Shop',
  GENERAL: 'Monthly / General'
})

export type ExpenseStatus = 'ACTIVE' | 'VOID'

export const EXPENSE_STATUS_LABELS: Readonly<Record<ExpenseStatus, string>> = Object.freeze({
  ACTIVE: 'Active',
  VOID: 'Void'
})

export const EXPENSE_CATEGORY_NAME_MAX = 60
export const EXPENSE_DESCRIPTION_MAX = 300
export const MAX_EXPENSE_PAGE_SIZE = 100

// --- Categories -------------------------------------------------------------------------------------------------------

const GroupSchema = z.enum(EXPENSE_GROUPS, { error: 'Choose Shop or Monthly / General.' })

/** `window.api.expenseCategories.create(...)`. */
export const ExpenseCategoryCreateSchema = z.strictObject({
  name: requiredText('category name', EXPENSE_CATEGORY_NAME_MAX),
  group: GroupSchema
})
export type ExpenseCategoryCreateInput = z.output<typeof ExpenseCategoryCreateSchema>

/**
 * `window.api.expenseCategories.update(...)`: rename, and move to the other group while no expense (active or void) has
 * used the category yet. After its first use the group is locked.
 */
export const ExpenseCategoryUpdateSchema = z.strictObject({
  id: IdSchema,
  name: requiredText('category name', EXPENSE_CATEGORY_NAME_MAX),
  group: GroupSchema
})
export type ExpenseCategoryUpdateInput = z.output<typeof ExpenseCategoryUpdateSchema>

export interface ExpenseCategory {
  readonly id: number
  readonly name: string
  readonly group: ExpenseGroup
  readonly isActive: boolean
  /** Expenses (active or void) in this category. Above zero, the group is locked. */
  readonly expenseCount: number
}

export const DUPLICATE_EXPENSE_CATEGORY_MESSAGE = 'Another expense category already uses this name.'
export const INACTIVE_EXPENSE_CATEGORY_MESSAGE = 'This expense category is inactive.'
export const VOID_EXPENSE_MESSAGE = 'Expense is already void.'
/** A used category keeps its group, so past expenses never move between Shop and Monthly / General totals. */
export const EXPENSE_CATEGORY_GROUP_LOCKED_MESSAGE =
  'Expense type cannot be changed after this category has been used.'

// --- Expenses -----------------------------------------------------------------------------------------------------------

const expenseFields = {
  /** Today or earlier, by the main process's clock. */
  expenseDate: DateSchema,
  /** An active category; editing may keep the expense's current category even if it is now inactive. */
  categoryId: IdSchema,
  amountMinor: PositiveAmountSchema,
  description: optionalText(EXPENSE_DESCRIPTION_MAX),
  /** The currency decimal places the amount was entered with; must match the current setting. */
  currencyMinorDigits: CurrencyDigitsSchema
}

/** `window.api.expenses.create(...)`: a repeated request id returns the saved expense and adds nothing. */
export const ExpenseCreateSchema = z.strictObject({ requestId: RequestIdSchema, ...expenseFields })
export type ExpenseCreateInput = z.output<typeof ExpenseCreateSchema>

/** `window.api.expenses.update(...)`: the whole expense as it should be now. Active expenses only. */
export const ExpenseUpdateSchema = z.strictObject({ id: IdSchema, ...expenseFields })
export type ExpenseUpdateInput = z.output<typeof ExpenseUpdateSchema>

export const ExpenseIdSchema = IdSchema

const OptionalDateSchema = z.string().refine(isCalendarDate, 'Enter a valid date.').nullable()

/** The end of a date range is not before its start. */
function validRange(input: { dateFrom: string | null; dateTo: string | null }): boolean {
  return input.dateFrom === null || input.dateTo === null || input.dateFrom <= input.dateTo
}
const RANGE_ERROR = { path: ['dateTo'], message: 'The end date cannot be before the start date.' }

/** `window.api.expenses.list(...)`: newest first. */
export const ExpenseListInputSchema = z
  .strictObject({
    page: wholeNumber(1, 1_000_000),
    pageSize: wholeNumber(1, MAX_EXPENSE_PAGE_SIZE),
    /** Words matched against the description and the category name. */
    search: z.string().trim().max(100, 'Use at most 100 characters.'),
    group: z.enum(['all', ...EXPENSE_GROUPS]),
    status: z.enum(['all', 'ACTIVE', 'VOID']),
    /** Inclusive expense date range; null leaves that side open. */
    dateFrom: OptionalDateSchema,
    dateTo: OptionalDateSchema
  })
  .refine(validRange, RANGE_ERROR)
export type ExpenseListInput = z.output<typeof ExpenseListInputSchema>

/** `window.api.expenses.summary(...)`: active expense totals for a date range. */
export const ExpenseSummaryInputSchema = z
  .strictObject({ dateFrom: OptionalDateSchema, dateTo: OptionalDateSchema })
  .refine(validRange, RANGE_ERROR)
export type ExpenseSummaryInput = z.output<typeof ExpenseSummaryInputSchema>

export interface Expense {
  readonly id: number
  readonly expenseDate: string
  readonly categoryId: number
  /** The category as it is now (categories are not copied onto expenses). */
  readonly categoryName: string
  readonly categoryGroup: ExpenseGroup
  readonly categoryActive: boolean
  readonly amountMinor: number
  readonly description: string | null
  readonly status: ExpenseStatus
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ExpenseSaveResult extends Expense {
  /** True when the request id had already been saved: this is that expense, and nothing new was added. */
  readonly replayed: boolean
}

/** Totals of ACTIVE expenses in a date range, by group. Void expenses never count. */
export interface ExpenseSummary {
  readonly dateFrom: string | null
  readonly dateTo: string | null
  readonly shopMinor: number
  readonly generalMinor: number
  readonly totalMinor: number
}
