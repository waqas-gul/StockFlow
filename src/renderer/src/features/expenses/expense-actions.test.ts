import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type {
  Expense,
  ExpenseCreateInput,
  ExpenseSaveResult,
  ExpenseUpdateInput
} from '@shared/expenses'
import type { Result } from '@shared/types/result'
import { refreshAfterExpenseChange } from '@renderer/lib/app-queries'
import { queryKeys } from '@renderer/lib/query-keys'
import { submitExpense, submitExpenseVoid, type ExpenseNotifier } from './expense-actions'

const RS = { minorDigits: 2, symbol: 'Rs' }

const expense: Expense = {
  id: 9,
  expenseDate: '2026-09-15',
  categoryId: 1,
  categoryName: 'Shop Expenses',
  categoryGroup: 'SHOP',
  categoryActive: true,
  amountMinor: 125_050,
  description: 'Electricity',
  status: 'ACTIVE',
  createdAt: '2026-09-15T05:00:00.000Z',
  updatedAt: '2026-09-15T05:00:00.000Z'
}

const createInput: ExpenseCreateInput = {
  requestId: 'request-0001',
  expenseDate: '2026-09-15',
  categoryId: 1,
  amountMinor: 125_050,
  description: 'Electricity',
  currencyMinorDigits: 2
}

function recorder(): ExpenseNotifier & { messages: string[] } {
  const messages: string[] = []
  return {
    messages,
    success: (message) => messages.push(`success: ${message}`),
    error: (message) => messages.push(`error: ${message}`)
  }
}

function api(result: Result<ExpenseSaveResult | Expense> | Error): {
  create(input: ExpenseCreateInput): Promise<Result<ExpenseSaveResult>>
  update(input: ExpenseUpdateInput): Promise<Result<Expense>>
  void(id: number): Promise<Result<Expense>>
  calls: unknown[]
} {
  const calls: unknown[] = []
  const answer = async (input: unknown): Promise<never> => {
    calls.push(input)
    if (result instanceof Error) throw result
    return result as never
  }
  return { calls, create: answer, update: answer, void: answer }
}

describe('submitExpense', () => {
  it('saves a new expense, or says it was already saved', async () => {
    const notify = recorder()
    const saved = api({ ok: true, data: { ...expense, replayed: false } })
    const errors: Array<[string, string]> = []
    const handlers = {
      notify,
      currency: RS,
      onFieldError: (path: string, message: string) => errors.push([path, message])
    }
    await expect(
      submitExpense(saved, { kind: 'create', input: createInput }, handlers)
    ).resolves.toEqual({
      ...expense,
      replayed: false
    })
    const replayed = api({ ok: true, data: { ...expense, replayed: true } })
    await submitExpense(replayed, { kind: 'create', input: createInput }, handlers)
    expect(notify.messages).toEqual([
      'success: Expense of Rs 1,250.50 saved (Shop Expenses).',
      'success: This expense of Rs 1,250.50 was already saved.'
    ])
    expect(saved.calls).toEqual([createInput])
    expect(errors).toEqual([])
  })

  it('saves an edit', async () => {
    const notify = recorder()
    const input: ExpenseUpdateInput = {
      id: 9,
      expenseDate: '2026-09-15',
      categoryId: 1,
      amountMinor: 200_000,
      description: 'Electricity',
      currencyMinorDigits: 2
    }
    const updated = api({ ok: true, data: { ...expense, amountMinor: 200_000 } })
    await submitExpense(
      updated,
      { kind: 'update', input },
      { notify, currency: RS, onFieldError: () => undefined }
    )
    expect(notify.messages).toEqual(['success: Expense updated: Rs 2,000.00 (Shop Expenses).'])
  })

  it('shows a refusal with its field errors, and never the raw error of a failed call', async () => {
    const notify = recorder()
    const errors: Array<[string, string]> = []
    const handlers = {
      notify,
      currency: RS,
      onFieldError: (path: string, message: string) => errors.push([path, message])
    }
    const refused = api({
      ok: false,
      error: {
        code: 'DATE_NOT_ALLOWED',
        message: 'The expense date cannot be after today (17-Sep-2026).',
        fieldErrors: { expenseDate: ['The expense date cannot be after today (17-Sep-2026).'] }
      }
    })
    await expect(
      submitExpense(refused, { kind: 'create', input: createInput }, handlers)
    ).resolves.toBeNull()
    await expect(
      submitExpense(api(new Error('SQLITE_BUSY')), { kind: 'create', input: createInput }, handlers)
    ).resolves.toBeNull()
    expect(errors).toEqual([
      ['expenseDate', 'The expense date cannot be after today (17-Sep-2026).']
    ])
    expect(notify.messages).toEqual([
      'error: The expense date cannot be after today (17-Sep-2026).',
      'error: The expense could not be saved. Try again.'
    ])
  })
})

describe('submitExpenseVoid', () => {
  it('voids the expense, or shows why not', async () => {
    const notify = recorder()
    const voided = api({ ok: true, data: { ...expense, status: 'VOID' } })
    await expect(submitExpenseVoid(voided, expense, notify, RS)).resolves.toMatchObject({
      status: 'VOID'
    })
    expect(voided.calls).toEqual([9])
    await expect(
      submitExpenseVoid(
        api({ ok: false, error: { code: 'FORBIDDEN_STATE', message: 'Expense is already void.' } }),
        expense,
        notify,
        RS
      )
    ).resolves.toBeNull()
    await expect(submitExpenseVoid(api(new Error('boom')), expense, notify, RS)).resolves.toBeNull()
    expect(notify.messages).toEqual([
      'success: Expense of Rs 1,250.50 voided (Shop Expenses, 15-Sep-2026). It no longer counts in the totals.',
      'error: Expense is already void.',
      'error: The expense could not be voided. Try again.'
    ])
  })
})

describe('refreshAfterExpenseChange', () => {
  it('reads the expense list, the summary totals, the categories and the settings lock again', () => {
    const queryClient = new QueryClient()
    const list = queryKeys.expenses.list({
      page: 1,
      pageSize: 25,
      search: '',
      group: 'all',
      status: 'ACTIVE',
      dateFrom: null,
      dateTo: null
    })
    const summary = queryKeys.expenses.summary({ dateFrom: null, dateTo: null })
    for (const key of [
      list,
      summary,
      queryKeys.expenseCategories,
      queryKeys.settings,
      queryKeys.invoices.all
    ]) {
      queryClient.setQueryData(key, {})
    }
    refreshAfterExpenseChange(queryClient)
    const invalidated = (key: readonly unknown[]): boolean | undefined =>
      queryClient.getQueryState(key)?.isInvalidated
    expect(invalidated(list)).toBe(true)
    expect(invalidated(summary)).toBe(true)
    expect(invalidated(queryKeys.expenseCategories)).toBe(true)
    expect(invalidated(queryKeys.settings)).toBe(true)
    // Expenses change no invoice, stock or customer figure.
    expect(invalidated(queryKeys.invoices.all)).toBe(false)
  })
})
