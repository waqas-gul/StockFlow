import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  Expense,
  ExpenseCreateInput,
  ExpenseListInput,
  ExpenseUpdateInput
} from '@shared/expenses'
import type { Db } from '../db/adapter'
import { createSchemaDatabase, createTempDir, thrown, type TempDir } from '../db/test-utils'
import { AppFailure } from '../errors'
import {
  createExpenseCategory,
  listExpenseCategories,
  setExpenseCategoryActive,
  updateExpenseCategory
} from './expense-categories.service'
import {
  createExpense,
  getExpense,
  listExpenses,
  summarizeExpenses,
  updateExpense,
  voidExpense
} from './expenses.service'
import { updateSettings } from './settings.service'

// Test data lives only in temporary databases.

/** Thursday 17 Sep 2026, 10:00 local time: "today" is 2026-09-17. */
const NOW = new Date(2026, 8, 17, 10, 0, 0)
const LATER = new Date(2026, 8, 17, 16, 30, 0)

let temp: TempDir
let db: Db
let requests: number

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  requests = 0
})

afterEach(() => {
  temp.remove()
})

function categoryId(name: string): number {
  const category = listExpenseCategories(db).find((item) => item.name === name)
  if (category === undefined) throw new Error(`No category ${name}`)
  return category.id
}

function add(
  overrides: Partial<ExpenseCreateInput> = {},
  now: Date = NOW
): ReturnType<typeof createExpense> {
  requests++
  return createExpense(
    db,
    {
      requestId: `expense-request-${String(requests).padStart(4, '0')}`,
      expenseDate: '2026-09-15',
      categoryId: categoryId('Shop Expenses'),
      amountMinor: 125_050,
      description: 'Electricity bill',
      currencyMinorDigits: 2,
      ...overrides
    },
    now
  )
}

function failure(fn: () => unknown): AppFailure['error'] {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

function rows(table: string): unknown[] {
  return db.all(`SELECT * FROM ${table} ORDER BY rowid`)
}

// --- Categories ---------------------------------------------------------------------------------------------------------

describe('expense categories', () => {
  it('lists the seeded categories with their groups, active, by name', () => {
    expect(listExpenseCategories(db)).toEqual([
      {
        id: expect.any(Number),
        name: 'Freight Paid',
        group: 'SHOP',
        isActive: true,
        expenseCount: 0
      },
      {
        id: expect.any(Number),
        name: 'Monthly / General Expenses',
        group: 'GENERAL',
        isActive: true,
        expenseCount: 0
      },
      {
        id: expect.any(Number),
        name: 'Purchase Cost Correction',
        group: 'GENERAL',
        isActive: true,
        expenseCount: 0
      },
      {
        id: expect.any(Number),
        name: 'Shop Expenses',
        group: 'SHOP',
        isActive: true,
        expenseCount: 0
      }
    ])
  })

  it('creates a category with a trimmed name', () => {
    const created = createExpenseCategory(db, { name: '  Rent  ', group: 'GENERAL' })
    expect(created).toEqual({
      id: expect.any(Number),
      name: 'Rent',
      group: 'GENERAL',
      isActive: true,
      expenseCount: 0
    })
    expect(listExpenseCategories(db).map((item) => item.name)).toContain('Rent')
  })

  it('refuses a name another category already uses, whatever its letter case, and a blank name', () => {
    const duplicate = {
      code: 'DUPLICATE',
      message: 'Another expense category already uses this name.',
      fieldErrors: { name: ['Another expense category already uses this name.'] }
    }
    expect(
      failure(() => createExpenseCategory(db, { name: 'shop expenses', group: 'SHOP' }))
    ).toEqual(duplicate)
    const rent = createExpenseCategory(db, { name: 'Rent', group: 'GENERAL' })
    expect(
      failure(() => updateExpenseCategory(db, { id: rent.id, name: 'FREIGHT PAID', group: 'SHOP' }))
    ).toEqual(duplicate)
    expect(failure(() => createExpenseCategory(db, { name: '   ', group: 'SHOP' }))).toMatchObject({
      code: 'VALIDATION',
      fieldErrors: { name: ['Enter the category name.'] }
    })
    expect(
      failure(() => createExpenseCategory(db, { name: 'Tea', group: 'MONTHLY' }))
    ).toMatchObject({
      code: 'VALIDATION',
      fieldErrors: { group: ['Choose Shop or Monthly / General.'] }
    })
    expect(listExpenseCategories(db)).toHaveLength(5)
  })

  it('renames a category, changes its group, and keeps its expenses on it', () => {
    const rent = createExpenseCategory(db, { name: 'Rent', group: 'SHOP' })
    const expense = add({ categoryId: rent.id })
    // Renaming to itself in another letter case is not a duplicate.
    expect(updateExpenseCategory(db, { id: rent.id, name: 'RENT', group: 'SHOP' }).name).toBe(
      'RENT'
    )
    expect(updateExpenseCategory(db, { id: rent.id, name: 'Shop Rent', group: 'GENERAL' })).toEqual(
      {
        id: rent.id,
        name: 'Shop Rent',
        group: 'GENERAL',
        isActive: true,
        expenseCount: 1
      }
    )
    expect(getExpense(db, expense.id)).toMatchObject({
      categoryName: 'Shop Rent',
      categoryGroup: 'GENERAL'
    })
    expect(
      failure(() => updateExpenseCategory(db, { id: 999, name: 'X', group: 'SHOP' }))
    ).toMatchObject({ code: 'NOT_FOUND', message: 'This expense category no longer exists.' })
  })

  it('deactivates and reactivates a category, which stays on its expenses', () => {
    const shop = categoryId('Shop Expenses')
    const expense = add()
    expect(setExpenseCategoryActive(db, { id: shop, active: false })).toMatchObject({
      isActive: false,
      expenseCount: 1
    })
    expect(listExpenseCategories(db).find((item) => item.id === shop)?.isActive).toBe(false)
    expect(getExpense(db, expense.id)).toMatchObject({
      categoryName: 'Shop Expenses',
      categoryActive: false
    })
    expect(setExpenseCategoryActive(db, { id: shop, active: true }).isActive).toBe(true)
    expect(failure(() => setExpenseCategoryActive(db, { id: 999, active: false }))).toMatchObject({
      code: 'NOT_FOUND'
    })
  })
})

// --- Expenses -----------------------------------------------------------------------------------------------------------

describe('creating expenses', () => {
  it('saves a shop expense and a monthly / general expense', () => {
    const shop = add()
    expect(shop).toEqual({
      id: expect.any(Number),
      expenseDate: '2026-09-15',
      categoryId: categoryId('Shop Expenses'),
      categoryName: 'Shop Expenses',
      categoryGroup: 'SHOP',
      categoryActive: true,
      amountMinor: 125_050,
      description: 'Electricity bill',
      status: 'ACTIVE',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      replayed: false
    })
    const general = add({
      categoryId: categoryId('Monthly / General Expenses'),
      amountMinor: 4_500_000,
      description: '  Salaries  ',
      expenseDate: '2026-09-17'
    })
    expect(general).toMatchObject({
      categoryGroup: 'GENERAL',
      amountMinor: 4_500_000,
      description: 'Salaries',
      expenseDate: '2026-09-17'
    })
    expect(add({ description: '   ' }).description).toBeNull()
    expect(rows('expenses')).toHaveLength(3)
  })

  it('returns the saved expense for a repeated request id and adds nothing', () => {
    const first = createExpense(
      db,
      {
        requestId: 'same-request-0001',
        expenseDate: '2026-09-15',
        categoryId: categoryId('Freight Paid'),
        amountMinor: 30_000,
        description: 'Transport to Lahore',
        currencyMinorDigits: 2
      },
      NOW
    )
    const again = createExpense(
      db,
      {
        requestId: 'same-request-0001',
        expenseDate: '2026-09-16',
        categoryId: categoryId('Shop Expenses'),
        amountMinor: 99_999,
        description: 'Changed',
        currencyMinorDigits: 2
      },
      LATER
    )
    expect(again).toEqual({ ...first, replayed: true })
    expect(rows('expenses')).toHaveLength(1)
  })

  it('refuses a date after today by the main process clock, and accepts any earlier date', () => {
    expect(failure(() => add({ expenseDate: '2026-09-18' }))).toEqual({
      code: 'DATE_NOT_ALLOWED',
      message: 'The expense date cannot be after today (17-Sep-2026).',
      fieldErrors: { expenseDate: ['The expense date cannot be after today (17-Sep-2026).'] }
    })
    expect(add({ expenseDate: '2020-01-01' }).expenseDate).toBe('2020-01-01')
    expect(failure(() => add({ expenseDate: '2026-02-30' }))).toMatchObject({ code: 'VALIDATION' })
    expect(rows('expenses')).toHaveLength(1)
  })

  it('refuses an amount that is not a whole number of minor units above zero', () => {
    for (const amountMinor of [0, -100, 12.5, '1250']) {
      expect(failure(() => add({ amountMinor: amountMinor as number }))).toMatchObject({
        code: 'VALIDATION',
        fieldErrors: { amountMinor: expect.any(Array) }
      })
    }
    expect(rows('expenses')).toEqual([])
  })

  it('refuses an inactive or missing category', () => {
    const shop = categoryId('Shop Expenses')
    setExpenseCategoryActive(db, { id: shop, active: false })
    expect(failure(() => add({ categoryId: shop }))).toEqual({
      code: 'FORBIDDEN_STATE',
      message: 'This expense category is inactive.',
      fieldErrors: { categoryId: ['This expense category is inactive.'] }
    })
    expect(failure(() => add({ categoryId: 999 }))).toMatchObject({
      code: 'NOT_FOUND',
      message: 'This expense category no longer exists.',
      fieldErrors: { categoryId: ['This expense category no longer exists.'] }
    })
    expect(rows('expenses')).toEqual([])
  })

  it('refuses amounts entered for other currency decimal places, and locks them once saved', () => {
    expect(failure(() => add({ currencyMinorDigits: 0 }))).toMatchObject({ code: 'CONFLICT' })
    add()
    expect(thrown(() => updateSettings(db, { 'currency.minorDigits': 0 }))).toMatchObject({
      error: { code: 'SETTING_LOCKED' }
    })
  })

  it('changes no invoice, stock, payment or customer record', () => {
    const tables = [
      'invoices',
      'stock_movements',
      'customer_ledger',
      'payments',
      'customers',
      'products',
      'sequences'
    ]
    const before = tables.map(rows)
    const expense = add()
    updateExpense(db, { id: expense.id, ...editable(expense), amountMinor: 1_000 }, LATER)
    voidExpense(db, expense.id)
    expect(tables.map(rows)).toEqual(before)
  })
})

function editable(expense: Expense): Omit<ExpenseUpdateInput, 'id'> {
  return {
    expenseDate: expense.expenseDate,
    categoryId: expense.categoryId,
    amountMinor: expense.amountMinor,
    description: expense.description,
    currencyMinorDigits: 2
  }
}

describe('editing and voiding expenses', () => {
  it('edits every field of an active expense, validated again', () => {
    const expense = getExpense(db, add().id)
    const edited = updateExpense(
      db,
      {
        id: expense.id,
        expenseDate: '2026-09-10',
        categoryId: categoryId('Monthly / General Expenses'),
        amountMinor: 200_000,
        description: 'September rent',
        currencyMinorDigits: 2
      },
      LATER
    )
    expect(edited).toEqual({
      ...expense,
      expenseDate: '2026-09-10',
      categoryId: categoryId('Monthly / General Expenses'),
      categoryName: 'Monthly / General Expenses',
      categoryGroup: 'GENERAL',
      amountMinor: 200_000,
      description: 'September rent',
      updatedAt: expect.any(String)
    })
    expect(getExpense(db, expense.id)).toEqual(edited)
    expect(
      failure(() =>
        updateExpense(db, { id: expense.id, ...editable(edited), expenseDate: '2026-09-18' }, LATER)
      )
    ).toMatchObject({ code: 'DATE_NOT_ALLOWED' })
    expect(
      failure(() =>
        updateExpense(db, { id: expense.id, ...editable(edited), amountMinor: 0 }, LATER)
      )
    ).toMatchObject({ code: 'VALIDATION' })
    expect(failure(() => updateExpense(db, { id: 999, ...editable(edited) }, LATER))).toMatchObject(
      { code: 'NOT_FOUND', message: 'This expense no longer exists.' }
    )
    expect(getExpense(db, expense.id)).toEqual(edited)
  })

  it('keeps a category that became inactive, but refuses moving to another inactive one', () => {
    const shop = categoryId('Shop Expenses')
    const freight = categoryId('Freight Paid')
    const expense = add({ categoryId: shop })
    setExpenseCategoryActive(db, { id: shop, active: false })
    setExpenseCategoryActive(db, { id: freight, active: false })
    expect(
      updateExpense(db, { id: expense.id, ...editable(expense), amountMinor: 5_000 }, LATER)
    ).toMatchObject({ amountMinor: 5_000, categoryId: shop, categoryActive: false })
    expect(
      failure(() =>
        updateExpense(db, { id: expense.id, ...editable(expense), categoryId: freight }, LATER)
      )
    ).toMatchObject({ code: 'FORBIDDEN_STATE', message: 'This expense category is inactive.' })
  })

  it('voids an expense once; a void expense is never edited or voided again, and never deleted', () => {
    const expense = getExpense(db, add().id)
    const voided = voidExpense(db, expense.id)
    expect(voided).toEqual({ ...expense, status: 'VOID', updatedAt: expect.any(String) })
    expect(failure(() => voidExpense(db, expense.id))).toEqual({
      code: 'FORBIDDEN_STATE',
      message: 'Expense is already void.'
    })
    expect(
      failure(() =>
        updateExpense(db, { id: expense.id, ...editable(expense), amountMinor: 1 }, LATER)
      )
    ).toEqual({
      code: 'FORBIDDEN_STATE',
      message: 'This expense is void, so it can no longer be edited.'
    })
    expect(failure(() => voidExpense(db, 999))).toMatchObject({ code: 'NOT_FOUND' })
    expect(() => db.run('DELETE FROM expenses WHERE id = ?', [expense.id])).toThrow(/never deleted/)
    expect(getExpense(db, expense.id)).toEqual(voided)
  })
})

// --- List and summary ---------------------------------------------------------------------------------------------------

describe('expense list and summary', () => {
  function list(overrides: Partial<ExpenseListInput> = {}): ReturnType<typeof listExpenses> {
    return listExpenses(db, {
      page: 1,
      pageSize: 25,
      search: '',
      group: 'all',
      status: 'all',
      dateFrom: null,
      dateTo: null,
      ...overrides
    })
  }

  const descriptions = (overrides: Partial<ExpenseListInput> = {}): Array<string | null> =>
    list(overrides).items.map((item) => item.description)

  /** Shop: Electricity 01-Sep 1,000, Tea 05-Sep 250.50, Freight 10-Sep 300 (void). General: Rent 03-Sep 45,000, Salaries 12-Sep 20,000. */
  function seed(): void {
    const shop = categoryId('Shop Expenses')
    const general = categoryId('Monthly / General Expenses')
    const freight = categoryId('Freight Paid')
    add({
      expenseDate: '2026-09-01',
      categoryId: shop,
      amountMinor: 100_000,
      description: 'Electricity'
    })
    add({
      expenseDate: '2026-09-03',
      categoryId: general,
      amountMinor: 4_500_000,
      description: 'Rent'
    })
    add({
      expenseDate: '2026-09-05',
      categoryId: shop,
      amountMinor: 25_050,
      description: 'Tea for staff'
    })
    const freightPaid = add({
      expenseDate: '2026-09-10',
      categoryId: freight,
      amountMinor: 30_000,
      description: 'Daewoo cargo'
    })
    voidExpense(db, freightPaid.id)
    add({
      expenseDate: '2026-09-12',
      categoryId: general,
      amountMinor: 2_000_000,
      description: 'Salaries'
    })
  }

  it('lists newest first with category name and group, and pages', () => {
    seed()
    expect(descriptions()).toEqual([
      'Salaries',
      'Daewoo cargo',
      'Tea for staff',
      'Rent',
      'Electricity'
    ])
    expect(list().items[0]).toMatchObject({
      categoryName: 'Monthly / General Expenses',
      categoryGroup: 'GENERAL'
    })
    const second = list({ page: 2, pageSize: 2 })
    expect(second).toMatchObject({ total: 5, page: 2, pageSize: 2 })
    expect(second.items.map((item) => item.description)).toEqual(['Tea for staff', 'Rent'])
    expect(list({ page: 3, pageSize: 2 }).items.map((item) => item.description)).toEqual([
      'Electricity'
    ])
  })

  it('searches the description and the category name', () => {
    seed()
    expect(descriptions({ search: 'tea' })).toEqual(['Tea for staff'])
    expect(descriptions({ search: 'freight' })).toEqual(['Daewoo cargo'])
    expect(descriptions({ search: 'monthly sal' })).toEqual(['Salaries'])
    expect(descriptions({ search: '100%' })).toEqual([])
  })

  it('filters by group, status and an inclusive date range', () => {
    seed()
    expect(descriptions({ group: 'SHOP' })).toEqual([
      'Daewoo cargo',
      'Tea for staff',
      'Electricity'
    ])
    expect(descriptions({ group: 'GENERAL' })).toEqual(['Salaries', 'Rent'])
    expect(descriptions({ status: 'VOID' })).toEqual(['Daewoo cargo'])
    expect(descriptions({ status: 'ACTIVE', group: 'SHOP' })).toEqual([
      'Tea for staff',
      'Electricity'
    ])
    expect(descriptions({ dateFrom: '2026-09-03', dateTo: '2026-09-10' })).toEqual([
      'Daewoo cargo',
      'Tea for staff',
      'Rent'
    ])
    expect(failure(() => list({ dateFrom: '2026-09-10', dateTo: '2026-09-01' }))).toMatchObject({
      code: 'VALIDATION',
      fieldErrors: { dateTo: ['The end date cannot be before the start date.'] }
    })
  })

  it('totals active expenses by group for the date range; void expenses never count', () => {
    seed()
    expect(summarizeExpenses(db, { dateFrom: null, dateTo: null })).toEqual({
      dateFrom: null,
      dateTo: null,
      shopMinor: 125_050,
      generalMinor: 6_500_000,
      totalMinor: 6_625_050
    })
    expect(summarizeExpenses(db, { dateFrom: '2026-09-04', dateTo: '2026-09-12' })).toEqual({
      dateFrom: '2026-09-04',
      dateTo: '2026-09-12',
      shopMinor: 25_050,
      generalMinor: 2_000_000,
      totalMinor: 2_025_050
    })
    expect(summarizeExpenses(db, { dateFrom: '2026-10-01', dateTo: null })).toMatchObject({
      shopMinor: 0,
      generalMinor: 0,
      totalMinor: 0
    })
  })

  it('moves totals when an expense is edited, voided, or its category changes group', () => {
    seed()
    const rent = list({ search: 'rent' }).items[0]
    updateExpense(db, { id: rent.id, ...editable(rent), amountMinor: 5_000_000 }, LATER)
    expect(summarizeExpenses(db, { dateFrom: null, dateTo: null }).generalMinor).toBe(7_000_000)
    voidExpense(db, rent.id)
    expect(summarizeExpenses(db, { dateFrom: null, dateTo: null })).toMatchObject({
      generalMinor: 2_000_000,
      totalMinor: 2_125_050
    })
    updateExpenseCategory(db, {
      id: categoryId('Shop Expenses'),
      name: 'Shop Expenses',
      group: 'GENERAL'
    })
    expect(summarizeExpenses(db, { dateFrom: null, dateTo: null })).toMatchObject({
      shopMinor: 0,
      generalMinor: 2_125_050,
      totalMinor: 2_125_050
    })
  })
})
