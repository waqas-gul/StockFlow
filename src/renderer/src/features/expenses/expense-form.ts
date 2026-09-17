import { z } from 'zod'
import { formatDisplayDate, isCalendarDate } from '@shared/dates'
import { formatMoney } from '@shared/domain'
import {
  EXPENSE_DESCRIPTION_MAX,
  type Expense,
  type ExpenseCategory,
  type ExpenseCreateInput,
  type ExpenseUpdateInput
} from '@shared/expenses'
import { optionalText, positiveMoneyText } from '@renderer/lib/form-text'
import { fieldPairs } from '../customers/customer-form'

/*
 * Add / Edit Expense. The amount is typed as text and read with the Phase 2 money parser ("1250", "1250.50",
 * "1,250.50"); the date is only checked to be a real day here: the main process refuses a date after its own today.
 */

export interface ExpenseFormValues {
  expenseDate: string
  /** Null until a category is chosen. */
  categoryId: number | null
  amount: string
  description: string
}

/** What the form produces: the expense without the request id or expense id, and without the currency check. */
export type ExpenseDraft = Pick<
  ExpenseCreateInput,
  'expenseDate' | 'categoryId' | 'amountMinor' | 'description'
>

export function emptyExpenseForm(today: string): ExpenseFormValues {
  return { expenseDate: today, categoryId: null, amount: '', description: '' }
}

/** The edit form of a saved expense: the amount as a plain decimal ("1250.50"). */
export function expenseFormValues(expense: Expense, minorDigits: number): ExpenseFormValues {
  return {
    expenseDate: expense.expenseDate,
    categoryId: expense.categoryId,
    amount: formatMoney(expense.amountMinor, { minorDigits, grouping: 'none' }),
    description: expense.description ?? ''
  }
}

export function expenseFormSchema(minorDigits: number): z.ZodType<ExpenseDraft, ExpenseFormValues> {
  return z
    .object({
      expenseDate: z.string().refine(isCalendarDate, 'Enter a valid date.'),
      categoryId: z
        .number()
        .nullable()
        .refine((id) => id !== null, 'Choose the category.'),
      amount: positiveMoneyText(minorDigits, 'Enter the expense amount.'),
      description: optionalText(EXPENSE_DESCRIPTION_MAX)
    })
    .transform((values): ExpenseDraft => ({
      expenseDate: values.expenseDate,
      categoryId: values.categoryId ?? 0,
      amountMinor: values.amount,
      description: values.description
    }))
}

export function toExpenseCreateInput(
  draft: ExpenseDraft,
  requestId: string,
  minorDigits: number
): ExpenseCreateInput {
  return { requestId, ...draft, currencyMinorDigits: minorDigits }
}

export function toExpenseUpdateInput(
  draft: ExpenseDraft,
  id: number,
  minorDigits: number
): ExpenseUpdateInput {
  return { id, ...draft, currencyMinorDigits: minorDigits }
}

/**
 * The categories an expense may be given: the active ones, plus the category an edited expense already has even if it
 * has become inactive (the main process allows keeping it).
 */
export function selectableCategories(
  categories: readonly ExpenseCategory[],
  currentCategoryId: number | null
): ExpenseCategory[] {
  return categories.filter((category) => category.isActive || category.id === currentCategoryId)
}

/** The main process's field errors as [form path, message] pairs. */
export function serverExpenseErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Array<[string, string]> {
  return fieldPairs(fieldErrors, {
    expenseDate: 'expenseDate',
    categoryId: 'categoryId',
    amountMinor: 'amount',
    description: 'description'
  })
}

/** The date range the summary cards total. */
export function summaryRangeText(dateFrom: string | null, dateTo: string | null): string {
  if (dateFrom !== null && dateTo !== null) {
    return `${formatDisplayDate(dateFrom)} to ${formatDisplayDate(dateTo)}`
  }
  if (dateFrom !== null) return `From ${formatDisplayDate(dateFrom)}`
  if (dateTo !== null) return `Up to ${formatDisplayDate(dateTo)}`
  return 'All dates'
}
