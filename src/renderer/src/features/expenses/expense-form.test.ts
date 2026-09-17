import { describe, expect, it } from 'vitest'
import type { Expense, ExpenseCategory } from '@shared/expenses'
import {
  emptyExpenseForm,
  expenseFormSchema,
  expenseFormValues,
  selectableCategories,
  serverExpenseErrors,
  summaryRangeText,
  toExpenseCreateInput,
  toExpenseUpdateInput
} from './expense-form'

const shop: ExpenseCategory = {
  id: 1,
  name: 'Shop Expenses',
  group: 'SHOP',
  isActive: true,
  expenseCount: 3
}
const rent: ExpenseCategory = {
  id: 5,
  name: 'Rent',
  group: 'GENERAL',
  isActive: false,
  expenseCount: 1
}
const freight: ExpenseCategory = {
  id: 3,
  name: 'Freight Paid',
  group: 'SHOP',
  isActive: false,
  expenseCount: 0
}

function parse(
  values: Partial<ReturnType<typeof emptyExpenseForm>>,
  minorDigits = 2
): ReturnType<ReturnType<typeof expenseFormSchema>['safeParse']> {
  return expenseFormSchema(minorDigits).safeParse({ ...emptyExpenseForm('2026-09-17'), ...values })
}

function messages(result: ReturnType<typeof parse>): Record<string, string[]> {
  if (result.success) return {}
  const out: Record<string, string[]> = {}
  for (const issue of result.error.issues) (out[issue.path.join('.')] ??= []).push(issue.message)
  return out
}

describe('expense form', () => {
  it('starts on today with no category, amount or description', () => {
    expect(emptyExpenseForm('2026-09-17')).toEqual({
      expenseDate: '2026-09-17',
      categoryId: null,
      amount: '',
      description: ''
    })
  })

  it('reads amounts as the user types them into whole minor units', () => {
    for (const [text, minor] of [
      ['1250', 125_000],
      ['1250.50', 125_050],
      ['1,250.50', 125_050],
      [' 0.05 ', 5]
    ] as const) {
      const result = parse({ categoryId: 1, amount: text })
      expect(result.success && result.data.amountMinor).toBe(minor)
    }
    expect(messages(parse({ categoryId: 1, amount: '' }))).toEqual({
      amount: ['Enter the expense amount.']
    })
    expect(messages(parse({ categoryId: 1, amount: '0' }))).toEqual({
      amount: ['Enter an amount greater than zero.']
    })
    expect(messages(parse({ categoryId: 1, amount: '12.345' }))).toEqual({
      amount: ['Use at most 2 decimal places.']
    })
    expect(messages(parse({ categoryId: 1, amount: 'abc' }))).toEqual({
      amount: ['Enter an amount such as 1250 or 1,250.50.']
    })
    expect(messages(parse({ categoryId: 1, amount: '1250.5' }, 0))).toEqual({
      amount: ['Enter a whole amount.']
    })
  })

  it('requires a valid date and a category; the description is optional and trimmed', () => {
    expect(messages(parse({ expenseDate: '', categoryId: null, amount: '10' }))).toEqual({
      expenseDate: ['Enter a valid date.'],
      categoryId: ['Choose the category.']
    })
    const result = parse({ categoryId: 1, amount: '10', description: '  Tea  ' })
    expect(result.success && result.data).toEqual({
      expenseDate: '2026-09-17',
      categoryId: 1,
      amountMinor: 1_000,
      description: 'Tea'
    })
    const blank = parse({ categoryId: 1, amount: '10', description: '   ' })
    expect(blank.success && blank.data.description).toBeNull()
  })

  it('builds the create and update requests with the currency decimal places', () => {
    const draft = {
      expenseDate: '2026-09-15',
      categoryId: 1,
      amountMinor: 125_050,
      description: null
    }
    expect(toExpenseCreateInput(draft, 'request-0001', 2)).toEqual({
      requestId: 'request-0001',
      ...draft,
      currencyMinorDigits: 2
    })
    expect(toExpenseUpdateInput(draft, 9, 2)).toEqual({ id: 9, ...draft, currencyMinorDigits: 2 })
  })

  it('fills the edit form from a saved expense, with a plain amount', () => {
    const expense: Expense = {
      id: 9,
      expenseDate: '2026-09-15',
      categoryId: 1,
      categoryName: 'Shop Expenses',
      categoryGroup: 'SHOP',
      categoryActive: true,
      amountMinor: 125_050,
      description: null,
      status: 'ACTIVE',
      createdAt: '2026-09-15T05:00:00.000Z',
      updatedAt: '2026-09-15T05:00:00.000Z'
    }
    expect(expenseFormValues(expense, 2)).toEqual({
      expenseDate: '2026-09-15',
      categoryId: 1,
      amount: '1250.50',
      description: ''
    })
    const result = expenseFormSchema(2).safeParse(expenseFormValues(expense, 2))
    expect(result.success && result.data.amountMinor).toBe(125_050)
  })

  it('offers active categories, plus the inactive one an edited expense already has', () => {
    expect(selectableCategories([freight, rent, shop], null)).toEqual([shop])
    expect(selectableCategories([freight, rent, shop], rent.id)).toEqual([rent, shop])
  })

  it('maps main-process field errors onto the form fields', () => {
    expect(
      serverExpenseErrors({
        expenseDate: ['The expense date cannot be after today (17-Sep-2026).'],
        categoryId: ['This expense category is inactive.'],
        amountMinor: ['Enter a valid amount.'],
        currencyMinorDigits: ['Changed']
      })
    ).toEqual([
      ['expenseDate', 'The expense date cannot be after today (17-Sep-2026).'],
      ['categoryId', 'This expense category is inactive.'],
      ['amount', 'Enter a valid amount.'],
      ['root', 'Changed']
    ])
  })

  it('names the summary date range', () => {
    expect(summaryRangeText(null, null)).toBe('All dates')
    expect(summaryRangeText('2026-09-01', null)).toBe('From 01-Sep-2026')
    expect(summaryRangeText(null, '2026-09-17')).toBe('Up to 17-Sep-2026')
    expect(summaryRangeText('2026-09-01', '2026-09-17')).toBe('01-Sep-2026 to 17-Sep-2026')
  })
})
