import { ChartColumn, CircleCheck, FileText, HandCoins, Package, Wallet } from 'lucide-react'
import { Link } from 'react-router'
import type { DashboardData, DashboardLowStockItem, DashboardSupplierDue } from '@shared/dashboard'
import { EXPENSE_GROUP_LABELS } from '@shared/expenses'
import type { ProductSalesRow } from '@shared/reports'
import { pageLinks } from '@renderer/app/page-links'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'
import type { CurrencyFormat } from '../products/product-display'
import { moneyText } from '../reports/report-display'
import { barPercent, relativeDay } from './dashboard-display'
import { DashboardPanel, PanelEmpty, PanelLink } from './DashboardParts'

/** Active products at or below their low-stock level, the most urgent first. */
export function LowStockPanel({
  items,
  count,
  activeProductCount
}: {
  items: readonly DashboardLowStockItem[]
  count: number
  activeProductCount: number
}): React.JSX.Element {
  return (
    <DashboardPanel
      title="Low Stock Products"
      footer={
        <>
          {count > items.length && (
            <span className="mr-auto text-muted-foreground">
              {`Showing ${items.length} of ${count.toLocaleString('en-US')}.`}
            </span>
          )}
          <PanelLink to={pageLinks.products}>View All Products</PanelLink>
        </>
      }
    >
      {items.length > 0 ? (
        <ul className="divide-y border-t">
          {items.map((item) => (
            <li key={item.productId} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.name}</p>
                <p className="font-mono text-xs text-muted-foreground">{item.code}</p>
              </div>
              <div className="text-right">
                <p className="text-sm tabular-nums">{item.quantityText}</p>
                <p className="text-xs text-muted-foreground">{`Low at ${item.thresholdText}`}</p>
              </div>
              <Badge variant="warning" className="w-22">
                {item.qtyBase <= 0 ? 'Out of stock' : 'Low'}
              </Badge>
            </li>
          ))}
        </ul>
      ) : activeProductCount === 0 ? (
        <PanelEmpty icon={Package}>No products yet.</PanelEmpty>
      ) : (
        <PanelEmpty icon={CircleCheck} positive>
          All products are above their low-stock levels.
        </PanelEmpty>
      )}
    </DashboardPanel>
  )
}

/** This month's best sellers by revenue, as bars against the first. */
export function TopProductsPanel({
  rows,
  currency
}: {
  rows: readonly ProductSalesRow[]
  currency: CurrencyFormat
}): React.JSX.Element {
  const max = Math.max(0, ...rows.map((row) => row.revenueMinor))
  return (
    <DashboardPanel
      title="Top Selling Products"
      description="This month"
      footer={<PanelLink to={pageLinks.productSalesReport}>View Sales Report</PanelLink>}
    >
      {rows.length > 0 ? (
        <ul className="space-y-3 px-4 pt-1 pb-4">
          {rows.map((row) => (
            <li key={row.productId}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-medium">{row.name}</span>
                <span className="shrink-0 tabular-nums">
                  {moneyText(row.revenueMinor, currency)}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/75"
                  style={{ width: `${barPercent(row.revenueMinor, max)}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{row.quantityText}</p>
            </li>
          ))}
        </ul>
      ) : (
        <PanelEmpty icon={ChartColumn}>No sales recorded this month.</PanelEmpty>
      )}
    </DashboardPanel>
  )
}

/** The suppliers the shop owes most, highest first (at most five). */
export function SuppliersDuePanel({
  items,
  count,
  currency,
  className
}: {
  items: readonly DashboardSupplierDue[]
  count: number
  currency: CurrencyFormat
  className?: string
}): React.JSX.Element {
  return (
    <DashboardPanel
      title="Suppliers Due"
      description="What the shop owes, highest first"
      className={className}
      footer={
        <>
          {count > items.length && (
            <span className="mr-auto text-muted-foreground">
              {`Showing ${items.length} of ${count.toLocaleString('en-US')}.`}
            </span>
          )}
          <PanelLink to={pageLinks.suppliers}>View All Suppliers</PanelLink>
        </>
      }
    >
      {items.length > 0 ? (
        <ul className="divide-y border-t">
          {items.map((item) => (
            <li key={item.supplierId}>
              <Link
                to={pageLinks.supplier(item.supplierId)}
                className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{item.code}</p>
                </div>
                <p className="shrink-0 text-sm font-medium text-amber-700 tabular-nums">
                  {moneyText(item.balanceMinor, currency)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <PanelEmpty icon={CircleCheck} positive>
          No supplier payments are currently due.
        </PanelEmpty>
      )}
    </DashboardPanel>
  )
}

/** The latest invoices, payments and expenses, five of each. */
export function RecentActivity({
  data,
  currency
}: {
  data: Pick<DashboardData, 'today' | 'recentInvoices' | 'recentPayments' | 'recentExpenses'>
  currency: CurrencyFormat
}): React.JSX.Element {
  const money = (minor: number): string => moneyText(minor, currency)
  const day = (date: string): string => relativeDay(date, data.today)
  return (
    <section aria-labelledby="recent-activity" className="flex flex-col gap-3">
      <h2 id="recent-activity" className="text-base font-semibold">
        Recent Activity
      </h2>
      <div className="grid gap-4 @3xl:grid-cols-2 @5xl:grid-cols-3">
        <DashboardPanel
          heading="h3"
          title="Recent Invoices"
          action={<PanelLink to="/invoices">View all</PanelLink>}
        >
          {data.recentInvoices.length > 0 ? (
            <ul className="divide-y border-t">
              {data.recentInvoices.map((invoice) => (
                <li key={invoice.id}>
                  <ActivityRow
                    to={pageLinks.invoice(invoice.id)}
                    title={invoice.invoiceNo}
                    subtitle={invoice.customerName}
                    amount={money(invoice.totalMinor)}
                    date={day(invoice.invoiceDate)}
                    voided={invoice.status === 'VOID'}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <PanelEmpty icon={FileText}>No invoices yet.</PanelEmpty>
          )}
        </DashboardPanel>
        <DashboardPanel
          heading="h3"
          title="Recent Payments"
          action={<PanelLink to="/payments">View all</PanelLink>}
        >
          {data.recentPayments.length > 0 ? (
            <ul className="divide-y border-t">
              {data.recentPayments.map((payment) => (
                <li key={payment.id}>
                  <ActivityRow
                    to={pageLinks.payment(payment.id)}
                    title={payment.customerName}
                    subtitle={payment.paymentNo}
                    amount={money(payment.amountMinor)}
                    date={day(payment.paymentDate)}
                    voided={payment.status === 'VOID'}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <PanelEmpty icon={HandCoins}>No payments yet.</PanelEmpty>
          )}
        </DashboardPanel>
        <DashboardPanel
          heading="h3"
          title="Recent Expenses"
          action={<PanelLink to="/expenses">View all</PanelLink>}
          className="@3xl:col-span-2 @5xl:col-span-1"
        >
          {data.recentExpenses.length > 0 ? (
            <ul className="divide-y border-t">
              {data.recentExpenses.map((expense) => (
                <li key={expense.id}>
                  <ActivityRow
                    title={expense.categoryName}
                    subtitle={expense.description ?? EXPENSE_GROUP_LABELS[expense.categoryGroup]}
                    amount={money(expense.amountMinor)}
                    date={day(expense.expenseDate)}
                    voided={expense.status === 'VOID'}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <PanelEmpty icon={Wallet}>No expenses yet.</PanelEmpty>
          )}
        </DashboardPanel>
      </div>
    </section>
  )
}

function ActivityRow({
  to,
  title,
  subtitle,
  amount,
  date,
  voided
}: {
  to?: string
  title: string
  subtitle: string
  amount: string
  date: string
  voided: boolean
}): React.JSX.Element {
  const content = (
    <>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className={cn('text-sm tabular-nums', voided && 'text-muted-foreground line-through')}>
          {amount}
        </p>
        <p className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
          {date}
          {voided && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[0.65rem]">
              Void
            </Badge>
          )}
        </p>
      </div>
    </>
  )
  const className = 'flex items-center gap-3 px-4 py-2.5'
  return to === undefined ? (
    <div className={className}>{content}</div>
  ) : (
    <Link
      to={to}
      className={cn(
        className,
        'transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none'
      )}
    >
      {content}
    </Link>
  )
}
