import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatDisplayDate } from '@shared/dates'
import { EXPENSE_GROUP_LABELS } from '@shared/expenses'
import type { ExpenseReport, ExpenseReportInput, ReportPeriod } from '@shared/reports'
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
import { expenseReportQuery } from '@renderer/lib/app-queries'
import { cn } from '@renderer/lib/utils'
import { ExpenseStatusBadge } from '../expenses/ExpenseStatusBadge'
import type { CurrencyFormat } from '../products/product-display'
import { Pager } from '../stock/Pager'
import { moneyText } from './report-display'
import { FigureCards, ReportCard, ReportMessage } from './ReportParts'

export const EXPENSE_REPORT_PAGE_SIZE = 25

/** Expenses of the period: group totals, categories and the expenses themselves. */
export function ExpenseReportSection({
  period,
  currency
}: {
  period: ReportPeriod
  currency: CurrencyFormat
}): React.JSX.Element {
  // The page keys this section by period, so a new period starts again on page 1.
  const [status, setStatus] = useState<ExpenseReportInput['status']>('ACTIVE')
  const [page, setPage] = useState(1)
  const { data, error } = useQuery(
    expenseReportQuery({ ...period, page, pageSize: EXPENSE_REPORT_PAGE_SIZE, status })
  )
  if (error) return <ReportMessage error>{error.message}</ReportMessage>
  if (!data) return <ReportMessage>Loading…</ReportMessage>
  return (
    <ExpenseReportView
      report={data}
      currency={currency}
      status={status}
      onStatus={(next) => {
        setStatus(next)
        setPage(1)
      }}
      onPage={setPage}
    />
  )
}

export function ExpenseReportView({
  report,
  currency,
  status,
  onStatus,
  onPage
}: {
  report: ExpenseReport
  currency: CurrencyFormat
  status: ExpenseReportInput['status']
  onStatus: (status: ExpenseReportInput['status']) => void
  onPage: (page: number) => void
}): React.JSX.Element {
  const money = (minor: number): string => moneyText(minor, currency)
  const { expenses } = report
  return (
    <div className="flex flex-col gap-4">
      <FigureCards
        figures={[
          { label: 'Shop Expenses', value: money(report.shopMinor) },
          { label: 'Monthly / General Expenses', value: money(report.generalMinor) },
          {
            label: 'Total Operating Expenses',
            value: money(report.operatingMinor),
            strong: true
          },
          {
            label: 'Purchase Cost Corrections',
            value: money(report.purchaseCostCorrectionsMinor),
            note: 'Not an operating expense: shown below operating profit'
          }
        ]}
      />
      <ReportCard
        title="Expenses by Category"
        description={
          report.voidCount > 0
            ? `Active expenses only · ${report.voidCount.toLocaleString('en-US')} void expense${report.voidCount === 1 ? '' : 's'} (${money(report.voidMinor)}) not counted`
            : 'Active expenses only'
        }
      >
        {report.categories.length === 0 ? (
          <ReportMessage>No active expenses in this period.</ReportMessage>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Category</TableHead>
                <TableHead>Group</TableHead>
                <TableHead className="text-right">Expenses</TableHead>
                <TableHead className="pr-4 text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.categories.map((category) => (
                <TableRow key={category.categoryId}>
                  <TableCell className="pl-4 whitespace-normal">
                    {category.name}
                    {!category.isActive && (
                      <span className="text-xs text-muted-foreground"> (inactive)</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {category.isPurchaseCostCorrection
                      ? 'Purchase cost correction'
                      : EXPENSE_GROUP_LABELS[category.group]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {category.count.toLocaleString('en-US')}
                  </TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">
                    {money(category.amountMinor)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="border-t-2 font-semibold">
                <TableCell className="pl-4" colSpan={3}>
                  Total active expenses
                </TableCell>
                <TableCell className="pr-4 text-right tabular-nums">
                  {money(report.totalActiveMinor)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        )}
      </ReportCard>
      <ReportCard
        title="Expenses"
        actions={
          <Select
            value={status}
            onValueChange={(value) => {
              // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
              if (value !== '') onStatus(value as ExpenseReportInput['status'])
            }}
          >
            <SelectTrigger aria-label="Expense status" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="VOID">Void</SelectItem>
              <SelectItem value="all">All statuses</SelectItem>
            </SelectContent>
          </Select>
        }
      >
        {expenses.items.length === 0 ? (
          <ReportMessage>No expenses in this period.</ReportMessage>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Date</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Group</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="pr-4">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {expenses.items.map((expense) => {
                  const isVoid = expense.status === 'VOID'
                  return (
                    <TableRow key={expense.id} className={cn(isVoid && 'text-muted-foreground')}>
                      <TableCell className="pl-4">
                        {formatDisplayDate(expense.expenseDate)}
                      </TableCell>
                      <TableCell className="max-w-56 whitespace-normal">
                        {expense.categoryName}
                      </TableCell>
                      <TableCell>{EXPENSE_GROUP_LABELS[expense.categoryGroup]}</TableCell>
                      <TableCell className="max-w-80 whitespace-normal">
                        {expense.description ?? '—'}
                      </TableCell>
                      <TableCell
                        className={cn('text-right tabular-nums', isVoid && 'line-through')}
                      >
                        {money(expense.amountMinor)}
                      </TableCell>
                      <TableCell className="pr-4">
                        <ExpenseStatusBadge status={expense.status} />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <Pager
              page={expenses.page}
              pageSize={expenses.pageSize}
              shown={expenses.items.length}
              total={expenses.total}
              onPage={onPage}
            />
          </>
        )}
      </ReportCard>
    </div>
  )
}
