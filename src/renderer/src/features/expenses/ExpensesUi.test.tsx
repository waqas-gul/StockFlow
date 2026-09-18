import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { ListPage } from '@shared/customers'
import type { Expense, ExpenseCategory, ExpenseSummary } from '@shared/expenses'
import type { SettingsView } from '@shared/settings'
import { queryKeys } from '@renderer/lib/query-keys'
import { ExpenseCategoriesManager } from './ExpenseCategoriesDialog'
import { ExpenseForm } from './ExpenseFormDialog'
import { EXPENSES_PAGE_SIZE, ExpensesPage } from './ExpensesPage'
import { VoidExpenseDetails } from './VoidExpenseDialog'

const RS = { minorDigits: 2, symbol: 'Rs' }
const noop = (): void => undefined

const settings: SettingsView = {
  values: {
    'business.name': 'StockFlow',
    'business.address': '',
    'salesman.name': 'Mansoor Iqbal',
    'salesman.phone1': '03179927633',
    'salesman.phone2': '03463820629',
    'currency.code': 'PKR',
    'currency.symbol': 'Rs',
    'currency.minorDigits': 2,
    'invoice.prefix': 'INV-',
    'invoice.padding': 6,
    'invoice.startNumber': 1,
    'invoice.paperSize': 'A4'
  },
  currencyLocked: true,
  startNumberLocked: false
}

const categories: ExpenseCategory[] = [
  { id: 3, name: 'Freight Paid', group: 'SHOP', isActive: true, expenseCount: 0 },
  { id: 2, name: 'Monthly / General Expenses', group: 'GENERAL', isActive: true, expenseCount: 1 },
  { id: 5, name: 'Rent', group: 'GENERAL', isActive: false, expenseCount: 1 },
  { id: 1, name: 'Shop Expenses', group: 'SHOP', isActive: true, expenseCount: 2 }
]

function expense(overrides: Partial<Expense>): Expense {
  return {
    id: 1,
    expenseDate: '2026-09-15',
    categoryId: 1,
    categoryName: 'Shop Expenses',
    categoryGroup: 'SHOP',
    categoryActive: true,
    amountMinor: 125_050,
    description: 'Electricity',
    status: 'ACTIVE',
    createdAt: '2026-09-15T05:00:00.000Z',
    updatedAt: '2026-09-15T05:00:00.000Z',
    ...overrides
  }
}

function render(node: React.ReactNode, queryClient = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  )
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('Expenses page', () => {
  function page(items: Expense[], summary: ExpenseSummary): { html: string; shown: string } {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.settings, settings)
    queryClient.setQueryData(queryKeys.expenseCategories, categories)
    const list: ListPage<Expense> = {
      items,
      total: items.length,
      page: 1,
      pageSize: EXPENSES_PAGE_SIZE
    }
    queryClient.setQueryData(
      queryKeys.expenses.list({
        page: 1,
        pageSize: EXPENSES_PAGE_SIZE,
        search: '',
        group: 'all',
        status: 'ACTIVE',
        dateFrom: null,
        dateTo: null
      }),
      list
    )
    queryClient.setQueryData(queryKeys.expenses.summary({ dateFrom: null, dateTo: null }), summary)
    const html = render(<ExpensesPage />, queryClient)
    return { html, shown: text(html) }
  }

  const summary: ExpenseSummary = {
    dateFrom: null,
    dateTo: null,
    shopMinor: 1_250_000,
    generalMinor: 4_500_000,
    totalMinor: 5_750_000
  }

  it('shows Add Expense, Manage Categories and the Shop, Monthly / General and total cards', () => {
    const { shown } = page([], summary)
    expect(shown).toContain('Expenses')
    expect(shown).toContain('Manage Categories')
    expect(shown).toContain('Add Expense')
    expect(shown).toContain(
      'Shop Expenses Rs 12,500.00 Monthly / General Expenses Rs 45,000.00 Total Expenses Rs 57,500.00'
    )
    expect(shown).toContain('Active expenses only · All dates')
    expect(shown).toContain('No active expenses yet.')
  })

  it('lists date, category, group, description, amount, status and actions, with the filters', () => {
    const { html, shown } = page(
      [
        expense({}),
        expense({
          id: 2,
          expenseDate: '2026-09-03',
          categoryId: 5,
          categoryName: 'Rent',
          categoryGroup: 'GENERAL',
          categoryActive: false,
          amountMinor: 4_500_000,
          description: null
        }),
        expense({ id: 3, status: 'VOID', description: 'Duplicate bill' })
      ],
      summary
    )
    expect(shown).toContain('Date Category Group Description Amount Status Actions')
    expect(shown).toContain(
      '15-Sep-2026 Shop Expenses Shop Electricity Rs 1,250.50 Active Edit Void'
    )
    expect(shown).toContain(
      '03-Sep-2026 Rent (inactive) Monthly / General — Rs 45,000.00 Active Edit Void'
    )
    // A void expense can be neither edited nor voided again.
    expect(shown).toContain('15-Sep-2026 Shop Expenses Shop Duplicate bill Rs 1,250.50 Void')
    expect(shown).not.toContain('Duplicate bill Rs 1,250.50 Void Edit')
    expect(html).toContain('aria-label="Search expenses"')
    expect(html).toContain('placeholder="Search by description or category"')
    expect(html).toContain('id="expenses-from"')
    expect(html).toContain('id="expenses-to"')
    expect(html).toContain('aria-label="Group"')
    expect(html).toContain('aria-label="Status"')
    expect(shown).toContain('Showing 1–3 of 3')
  })
})

describe('Add / Edit Expense form', () => {
  it('asks for date, category, amount and description', () => {
    const shown = text(
      render(
        <ExpenseForm
          expense={null}
          categories={categories}
          currency={RS}
          today="2026-09-17"
          onSaved={noop}
          onCancel={noop}
        />
      )
    )
    expect(shown).toContain('Date')
    expect(shown).toContain('Category')
    expect(shown).toContain('Amount')
    expect(shown).toContain('Description')
    expect(shown).toContain('Today or earlier.')
    expect(shown).toContain('Cancel Save Expense')
  })

  it('edits a saved expense and names its category group', () => {
    const html = render(
      <ExpenseForm
        expense={expense({
          categoryId: 2,
          categoryName: 'Monthly / General Expenses',
          categoryGroup: 'GENERAL'
        })}
        categories={categories}
        currency={RS}
        today="2026-09-17"
        onSaved={noop}
        onCancel={noop}
      />
    )
    // The saved values are filled in on mount (expenseFormValues, tested in expense-form.test.ts).
    expect(text(html)).toContain('Monthly / General expense')
    expect(text(html)).toContain('Cancel Save Changes')
  })
})

describe('Void Expense confirmation', () => {
  it('shows what is voided and that it leaves the totals', () => {
    const shown = text(
      renderToStaticMarkup(<VoidExpenseDetails expense={expense({})} currency={RS} />)
    )
    expect(shown).toContain(
      'Date 15-Sep-2026 Category Shop Expenses (Shop) Amount Rs 1,250.50 Description Electricity'
    )
    expect(shown).toContain(
      'The expense stays in the list as void and no longer counts in the totals. It cannot be edited or restored.'
    )
  })
})

describe('Manage Categories', () => {
  it('lists every category with its group, expenses and status, and adds one with a group', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.expenseCategories, [
      ...categories,
      { id: 4, name: 'Purchase Cost Correction', group: 'GENERAL', isActive: true, expenseCount: 2 }
    ])
    const html = render(<ExpenseCategoriesManager />, queryClient)
    const shown = text(html)
    expect(shown).toContain('Category Group Expenses Status Actions')
    // Reports use the Purchase Cost Correction category by id: its Edit is unavailable, Deactivate is not.
    expect(shown).toContain(
      'Purchase Cost Correction Used by Reports: its name and group cannot change. Monthly / General 2 Active Edit Deactivate'
    )
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Edit Purchase Cost Correction"/)
    expect(shown).toContain('Freight Paid Shop 0 Active Edit Deactivate')
    expect(shown).toContain('Monthly / General Expenses Monthly / General 1 Active Edit Deactivate')
    expect(shown).toContain('Rent Monthly / General 1 Inactive Edit Activate')
    expect(html).toContain('aria-label="New category name"')
    expect(html).toContain('aria-label="New category group"')
    expect(shown).toContain('Add Category')
    expect(shown).toContain(
      'Expense type cannot be changed after this category has been used. Its name and status can still change.'
    )
    expect(shown).not.toContain('moves its existing expenses')
    expect(shown).not.toMatch(/\bDelete\b/)
  })
})
