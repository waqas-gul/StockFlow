import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, Pencil, Plus, Tags } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { formatDisplayDate, localDateString } from '@shared/dates'
import {
  EXPENSE_GROUPS,
  EXPENSE_GROUP_LABELS,
  type Expense,
  type ExpenseListInput,
  type ExpenseSummary
} from '@shared/expenses'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import { wantsForm } from '@renderer/app/page-links'
import {
  expenseCategoriesQuery,
  expenseListQuery,
  expenseSummaryQuery,
  refreshAfterExpenseChange,
  settingsQuery
} from '@renderer/lib/app-queries'
import { useDebouncedValue } from '@renderer/lib/use-debounced-value'
import { ExpenseSearchBox } from './ExpenseSearchBox'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { Pager } from '../stock/Pager'
import { submitExpenseVoid, type ExpenseNotifier } from './expense-actions'
import { summaryRangeText } from './expense-form'
import { ExpenseCategoriesDialog } from './ExpenseCategoriesDialog'
import { ExpenseFormDialog } from './ExpenseFormDialog'
import { ExpenseStatusBadge } from './ExpenseStatusBadge'
import { VoidExpenseDialog } from './VoidExpenseDialog'

export const EXPENSES_PAGE_SIZE = 25

const notify: ExpenseNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message)
}

/**
 * Expenses: Shop and Monthly / General expenses, with totals of the active expenses in the chosen date range, filters,
 * Add / Edit, Void and Manage Categories. Nothing here is profit and loss. `?add=1` (the Dashboard's Add Expense) opens
 * Add Expense.
 */
export function ExpensesPage(): React.JSX.Element {
  const queryClient = useQueryClient()
  const settings = useQuery(settingsQuery)
  const categories = useQuery(expenseCategoriesQuery)
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [group, setGroup] = useState<ExpenseListInput['group']>('all')
  const [status, setStatus] = useState<ExpenseListInput['status']>('ACTIVE')
  const [page, setPage] = useState(1)
  /** The Add / Edit dialog: null closed, { expense: null } adding. */
  const [params] = useSearchParams()
  const [form, setForm] = useState<{ expense: Expense | null } | null>(() =>
    wantsForm(params, 'add') ? { expense: null } : null
  )
  const [voiding, setVoiding] = useState<Expense | null>(null)
  const [managing, setManaging] = useState(false)
  const debouncedSearch = useDebouncedValue(search.trim(), 250)
  const rangeError =
    dateFrom !== '' && dateTo !== '' && dateFrom > dateTo
      ? 'The end date cannot be before the start date.'
      : null
  const range = {
    dateFrom: dateFrom === '' ? null : dateFrom,
    dateTo: dateTo === '' ? null : dateTo
  }
  const list = useQuery({
    ...expenseListQuery({
      page,
      pageSize: EXPENSES_PAGE_SIZE,
      search: debouncedSearch,
      group,
      status,
      ...range
    }),
    enabled: rangeError === null
  })
  const summary = useQuery({ ...expenseSummaryQuery(range), enabled: rangeError === null })

  const currency: CurrencyFormat | null = settings.data
    ? {
        minorDigits: settings.data.values['currency.minorDigits'],
        symbol: settings.data.values['currency.symbol']
      }
    : null

  const filtered = debouncedSearch !== '' || dateFrom !== '' || dateTo !== '' || group !== 'all'
  const changeFilter =
    <T,>(set: (value: T) => void) =>
    (value: T): void => {
      set(value)
      setPage(1)
    }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
          <p className="text-sm text-muted-foreground">
            Shop and Monthly / General expenses. An expense can be edited while active; a mistake is
            voided, never deleted.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setManaging(true)}>
            <Tags aria-hidden />
            Manage Categories
          </Button>
          <Button
            onClick={() => setForm({ expense: null })}
            disabled={currency === null || !categories.data}
          >
            <Plus aria-hidden />
            Add Expense
          </Button>
        </div>
      </div>

      {currency !== null && (
        <SummaryCards summary={summary.data ?? null} currency={currency} range={range} />
      )}

      <Card className="gap-0 py-0">
        <CardContent className="flex flex-wrap items-end gap-3 border-b px-4 py-3">
          <div className="min-w-64 flex-1">
            <ExpenseSearchBox
              ariaLabel="Search expenses"
              placeholder="Search by description or category"
              value={search}
              onChange={changeFilter(setSearch)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="expenses-from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="expenses-from"
              type="date"
              className="w-40"
              value={dateFrom}
              onChange={(event) => changeFilter(setDateFrom)(event.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="expenses-to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="expenses-to"
              type="date"
              className="w-40"
              value={dateTo}
              onChange={(event) => changeFilter(setDateTo)(event.target.value)}
            />
          </div>
          <Select
            value={group}
            onValueChange={(value) => {
              // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
              if (value !== '') changeFilter(setGroup)(value as ExpenseListInput['group'])
            }}
          >
            <SelectTrigger aria-label="Group" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All groups</SelectItem>
              {EXPENSE_GROUPS.map((item) => (
                <SelectItem key={item} value={item}>
                  {EXPENSE_GROUP_LABELS[item]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(value) => {
              if (value !== '') changeFilter(setStatus)(value as ExpenseListInput['status'])
            }}
          >
            <SelectTrigger aria-label="Status" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="VOID">Void</SelectItem>
              <SelectItem value="all">All statuses</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>

        {rangeError !== null ? (
          <p className="px-4 py-8 text-center text-sm text-destructive">{rangeError}</p>
        ) : list.error ? (
          <p className="px-4 py-8 text-center text-sm text-destructive">{list.error.message}</p>
        ) : !list.data || currency === null ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : list.data.items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {filtered
              ? 'No expenses match the search or filters.'
              : status === 'ACTIVE'
                ? 'No active expenses yet.'
                : status === 'VOID'
                  ? 'No void expenses.'
                  : 'No expenses yet.'}
          </p>
        ) : (
          <>
            <ExpensesTable
              items={list.data.items}
              currency={currency}
              onEdit={(expense) => setForm({ expense })}
              onVoid={setVoiding}
            />
            <Pager
              page={page}
              pageSize={EXPENSES_PAGE_SIZE}
              shown={list.data.items.length}
              total={list.data.total}
              onPage={setPage}
            />
          </>
        )}
      </Card>

      {currency !== null && categories.data && (
        <ExpenseFormDialog
          open={form !== null}
          expense={form?.expense ?? null}
          categories={categories.data}
          currency={currency}
          today={localDateString(new Date())}
          onSaved={() => setForm(null)}
          onCancel={() => setForm(null)}
        />
      )}
      {currency !== null && (
        <VoidExpenseDialog
          expense={voiding}
          currency={currency}
          onConfirm={async (expense) => {
            const voided = await submitExpenseVoid(window.api.expenses, expense, notify, currency)
            // Read everything again either way: a refusal may mean the expense changed meanwhile.
            refreshAfterExpenseChange(queryClient)
            return voided !== null
          }}
          onClose={() => setVoiding(null)}
        />
      )}
      <ExpenseCategoriesDialog open={managing} onOpenChange={setManaging} />
    </div>
  )
}

function SummaryCards({
  summary,
  currency,
  range
}: {
  summary: ExpenseSummary | null
  currency: CurrencyFormat
  range: { dateFrom: string | null; dateTo: string | null }
}): React.JSX.Element {
  const cards: Array<[label: string, minor: number | undefined, strong: boolean]> = [
    ['Shop Expenses', summary?.shopMinor, false],
    ['Monthly / General Expenses', summary?.generalMinor, false],
    ['Total Expenses', summary?.totalMinor, true]
  ]
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map(([label, minor, strong]) => (
          <Card key={label} className="gap-1 py-3">
            <CardContent className="px-4">
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className={`text-xl tabular-nums ${strong ? 'font-semibold' : 'font-medium'}`}>
                {minor === undefined ? '—' : formatAmount(minor, currency)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Active expenses only · {summaryRangeText(range.dateFrom, range.dateTo)}
      </p>
    </div>
  )
}

function ExpensesTable({
  items,
  currency,
  onEdit,
  onVoid
}: {
  items: readonly Expense[]
  currency: CurrencyFormat
  onEdit: (expense: Expense) => void
  onVoid: (expense: Expense) => void
}): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Date</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Group</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-4 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((expense) => {
          const isVoid = expense.status === 'VOID'
          return (
            <TableRow key={expense.id} className={isVoid ? 'text-muted-foreground' : undefined}>
              <TableCell className="pl-4">{formatDisplayDate(expense.expenseDate)}</TableCell>
              <TableCell className="max-w-56 whitespace-normal">
                {expense.categoryName}
                {!expense.categoryActive && (
                  <span className="text-xs text-muted-foreground"> (inactive)</span>
                )}
              </TableCell>
              <TableCell>{EXPENSE_GROUP_LABELS[expense.categoryGroup]}</TableCell>
              <TableCell className="max-w-80 whitespace-normal">
                {expense.description ?? <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className={`text-right tabular-nums ${isVoid ? 'line-through' : ''}`}>
                {formatAmount(expense.amountMinor, currency)}
              </TableCell>
              <TableCell>
                <ExpenseStatusBadge status={expense.status} />
              </TableCell>
              <TableCell className="pr-4 text-right">
                {!isVoid && (
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onEdit(expense)}>
                      <Pencil aria-hidden />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => onVoid(expense)}
                    >
                      <Ban aria-hidden />
                      Void
                    </Button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
