import { formatDisplayDate } from '@shared/dates'
import type {
  Expense,
  ExpenseCreateInput,
  ExpenseSaveResult,
  ExpenseUpdateInput
} from '@shared/expenses'
import type { Result } from '@shared/types/result'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { serverExpenseErrors } from './expense-form'

export interface ExpenseNotifier {
  success(message: string): void
  error(message: string): void
}

export type ExpenseRequest =
  | { readonly kind: 'create'; readonly input: ExpenseCreateInput }
  | { readonly kind: 'update'; readonly input: ExpenseUpdateInput }

export interface ExpenseSubmitHandlers {
  readonly notify: ExpenseNotifier
  readonly currency: CurrencyFormat
  /** A main-process error for a form field (a form path such as `amount` or `expenseDate`). */
  onFieldError(path: string, message: string): void
}

/**
 * Saves a new expense or an edit. Returns the saved expense, or null when it was refused or failed (the message is
 * shown). A new expense keeps its request id for a retry, so a lost answer never saves it twice.
 */
export async function submitExpense(
  api: {
    create(input: ExpenseCreateInput): Promise<Result<ExpenseSaveResult>>
    update(input: ExpenseUpdateInput): Promise<Result<Expense>>
  },
  request: ExpenseRequest,
  handlers: ExpenseSubmitHandlers
): Promise<Expense | null> {
  let result: Result<Expense | ExpenseSaveResult>
  try {
    result =
      request.kind === 'create' ? await api.create(request.input) : await api.update(request.input)
  } catch {
    handlers.notify.error('The expense could not be saved. Try again.')
    return null
  }
  if (!result.ok) {
    for (const [path, message] of serverExpenseErrors(result.error.fieldErrors)) {
      handlers.onFieldError(path, message)
    }
    handlers.notify.error(result.error.message)
    return null
  }
  const expense = result.data
  const amount = formatAmount(expense.amountMinor, handlers.currency)
  if (request.kind === 'update') {
    handlers.notify.success(`Expense updated: ${amount} (${expense.categoryName}).`)
  } else if ('replayed' in expense && expense.replayed) {
    handlers.notify.success(`This expense of ${amount} was already saved.`)
  } else {
    handlers.notify.success(`Expense of ${amount} saved (${expense.categoryName}).`)
  }
  return expense
}

/** Voids an expense. Returns the void expense, or null when it was refused or failed (the message is shown). */
export async function submitExpenseVoid(
  api: { void(id: number): Promise<Result<Expense>> },
  expense: Expense,
  notify: ExpenseNotifier,
  currency: CurrencyFormat
): Promise<Expense | null> {
  let result: Result<Expense>
  try {
    result = await api.void(expense.id)
  } catch {
    notify.error('The expense could not be voided. Try again.')
    return null
  }
  if (!result.ok) {
    notify.error(result.error.message)
    return null
  }
  notify.success(
    `Expense of ${formatAmount(result.data.amountMinor, currency)} voided (${result.data.categoryName}, ${formatDisplayDate(result.data.expenseDate)}). It no longer counts in the totals.`
  )
  return result.data
}
