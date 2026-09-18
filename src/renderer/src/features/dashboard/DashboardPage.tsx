import { useQuery } from '@tanstack/react-query'
import {
  Banknote,
  Boxes,
  CalendarDays,
  FilePlus,
  HandCoins,
  PackagePlus,
  PiggyBank,
  Plus,
  ReceiptText,
  TriangleAlert,
  Truck,
  Users,
  Wallet,
  type LucideIcon
} from 'lucide-react'
import { Link } from 'react-router'
import type { DashboardData, DashboardSummary } from '@shared/dashboard'
import { localDateString } from '@shared/dates'
import { pageLinks } from '@renderer/app/page-links'
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import { dashboardQuery, settingsQuery } from '@renderer/lib/app-queries'
import { errorMessage } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import type { CurrencyFormat } from '../products/product-display'
import { moneyText } from '../reports/report-display'
import { ExpenseBreakdownPanel, SalesTrendPanel } from './DashboardCharts'
import {
  LowStockPanel,
  RecentActivity,
  SuppliersDuePanel,
  TopProductsPanel
} from './DashboardLists'
import { countText, shortDate } from './dashboard-display'
import { Skeleton } from './DashboardParts'

/**
 * The start page: an overview of the shop today (sales, balances, stock, expenses and recent activity) with the
 * everyday actions. Every figure comes from `window.api.dashboard.get()`, which reads the same reports and lists as
 * the rest of StockFlow; nothing here changes data.
 */
export function DashboardPage(): React.JSX.Element {
  const settings = useQuery(settingsQuery)
  const dashboard = useQuery(dashboardQuery)
  const currency: CurrencyFormat | null = settings.data
    ? {
        minorDigits: settings.data.values['currency.minorDigits'],
        symbol: settings.data.values['currency.symbol']
      }
    : null
  const today = dashboard.data?.today ?? localDateString(new Date())
  const error = dashboard.error ?? settings.error

  return (
    <div className="@container mx-auto flex max-w-7xl flex-col gap-5 pb-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {settings.data?.values['business.name'] ?? 'StockFlow'}
          </h1>
          <p className="text-sm text-muted-foreground">Overview of your shop today.</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Today</p>
          <p className="text-sm font-medium">{`${shortDate(today)} ${today.slice(0, 4)}`}</p>
        </div>
      </header>

      <QuickActions />

      {error ? (
        <Card className="gap-0 py-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
            <p className="text-sm text-destructive">{errorMessage(error)}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void dashboard.refetch()
                void settings.refetch()
              }}
            >
              Try Again
            </Button>
          </div>
        </Card>
      ) : dashboard.data && currency !== null ? (
        <DashboardBody data={dashboard.data} currency={currency} />
      ) : (
        <DashboardLoading />
      )}
    </div>
  )
}

const QUICK_ACTIONS: ReadonlyArray<{
  to: string
  label: string
  icon: LucideIcon
  accent?: boolean
}> = [
  { to: pageLinks.newInvoice, label: 'New Invoice', icon: FilePlus, accent: true },
  { to: pageLinks.stockIn, label: 'Stock In', icon: PackagePlus },
  { to: pageLinks.receivePayment, label: 'Receive Payment', icon: HandCoins },
  { to: pageLinks.paySupplier, label: 'Pay Supplier', icon: Banknote },
  { to: pageLinks.addExpense, label: 'Add Expense', icon: Wallet }
]

function QuickActions(): React.JSX.Element {
  return (
    <nav
      aria-label="Quick actions"
      className="grid grid-cols-2 gap-3 @xl:grid-cols-3 @4xl:grid-cols-5"
    >
      {QUICK_ACTIONS.map(({ to, label, icon: Icon, accent }) => (
        <Link
          key={to}
          to={to}
          className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-3 text-sm font-medium shadow-xs transition-colors hover:border-ring/40 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-md',
              accent ? 'bg-highlight/25 text-highlight-foreground' : 'bg-secondary text-primary'
            )}
          >
            <Icon className="size-4" aria-hidden />
          </span>
          <span className="truncate">{label}</span>
        </Link>
      ))}
    </nav>
  )
}

function DashboardBody({
  data,
  currency
}: {
  data: DashboardData
  currency: CurrencyFormat
}): React.JSX.Element {
  return (
    <>
      {data.gettingStarted && <GettingStarted />}
      <SummaryCards summary={data.summary} currency={currency} />
      <div className="grid gap-4 @4xl:grid-cols-[minmax(0,13fr)_minmax(0,7fr)]">
        <SalesTrendPanel trend={data.salesTrend} currency={currency} />
        <ExpenseBreakdownPanel breakdown={data.expenseBreakdown} currency={currency} />
      </div>
      <div className="grid gap-4 @4xl:grid-cols-2 @6xl:grid-cols-3">
        <LowStockPanel
          items={data.lowStock}
          count={data.summary.lowStockCount}
          activeProductCount={data.summary.activeProductCount}
        />
        <TopProductsPanel rows={data.topProducts} currency={currency} />
        <SuppliersDuePanel
          items={data.suppliersDue}
          count={data.summary.dueSupplierCount}
          currency={currency}
          className="@4xl:col-span-2 @6xl:col-span-1"
        />
      </div>
      <RecentActivity data={data} currency={currency} />
    </>
  )
}

function GettingStarted(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-input bg-card px-4 py-3">
      <p className="text-sm">Start by adding products and recording stock.</p>
      <div className="flex flex-wrap gap-2">
        {(
          [
            [pageLinks.addProduct, 'Add Product'],
            [pageLinks.stockIn, 'Stock In'],
            [pageLinks.newInvoice, 'New Invoice']
          ] as const
        ).map(([to, label]) => (
          <Button key={to} asChild variant="outline" size="sm">
            <Link to={to}>
              <Plus aria-hidden />
              {label}
            </Link>
          </Button>
        ))}
      </div>
    </div>
  )
}

const SALES_NOTE = 'Net goods sales of posted invoices (freight excluded), as in Reports → Sales.'

function SummaryCards({
  summary,
  currency
}: {
  summary: DashboardSummary
  currency: CurrencyFormat
}): React.JSX.Element {
  const money = (minor: number): string => moneyText(minor, currency)
  const lowStock = summary.lowStockCount
  const cards: ReadonlyArray<{
    label: string
    value: string
    note: string
    /** A second, smaller line. */
    extra?: string
    icon: LucideIcon
    title?: string
    attention?: boolean
  }> = [
    {
      label: 'Today Sales',
      value: money(summary.todaySalesMinor),
      note: `${countText(summary.todayInvoiceCount, 'invoice')} today`,
      icon: ReceiptText,
      title: SALES_NOTE
    },
    {
      label: 'This Month Sales',
      value: money(summary.monthSalesMinor),
      note: countText(summary.monthInvoiceCount, 'invoice'),
      icon: CalendarDays,
      title: SALES_NOTE
    },
    {
      label: 'Receivables',
      value: money(summary.receivablesMinor),
      note: `${countText(summary.dueCustomerCount, 'customer')} ${summary.dueCustomerCount === 1 ? 'owes' : 'owe'} money`,
      icon: Users
    },
    {
      label: 'Customer Advances',
      value: money(summary.advancesMinor),
      note: `${countText(summary.advanceCustomerCount, 'customer')} with credit`,
      icon: PiggyBank
    },
    {
      label: 'Inventory Value',
      value: money(summary.inventoryValueMinor),
      note: countText(summary.activeProductCount, 'active product'),
      icon: Boxes,
      title: 'Current stock at average cost, as in Reports → Stock.'
    },
    {
      label: 'Stock Alerts',
      value: countText(lowStock, 'Product'),
      note: 'Low or out of stock',
      icon: TriangleAlert,
      title: 'Active products at or below their low-stock level.',
      attention: lowStock > 0
    },
    {
      label: 'Supplier Payables',
      value: money(summary.supplierPayablesMinor),
      note: `${countText(summary.dueSupplierCount, 'supplier')} due`,
      extra:
        summary.supplierAdvancesMinor > 0
          ? `${money(summary.supplierAdvancesMinor)} supplier advances`
          : undefined,
      icon: Truck,
      title: 'What the shop owes its suppliers, as in Reports → Supplier Balances.'
    }
  ]
  return (
    <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
      {cards.map(({ label, value, note, extra, icon: Icon, title, attention }) => (
        <Card key={label} className="gap-0 py-0" title={title}>
          <div className="flex flex-col gap-1 p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">{label}</p>
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-md',
                  attention
                    ? 'bg-highlight/25 text-highlight-foreground'
                    : 'bg-secondary text-primary'
                )}
              >
                <Icon className="size-4" aria-hidden />
              </span>
            </div>
            <p className="text-xl font-semibold tabular-nums [overflow-wrap:anywhere]">{value}</p>
            <p className="text-xs text-muted-foreground">{note}</p>
            {extra && <p className="text-xs text-emerald-700">{extra}</p>}
          </div>
        </Card>
      ))}
    </div>
  )
}

function DashboardLoading(): React.JSX.Element {
  const panel = (height: string, key: number): React.JSX.Element => (
    <Card key={key} className="gap-3 px-4 py-4">
      <Skeleton className="h-4 w-32" />
      <Skeleton className={height} />
    </Card>
  )
  return (
    <div aria-busy="true" className="flex flex-col gap-5">
      <span className="sr-only">Loading the overview…</span>
      <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
        {[0, 1, 2, 3, 4, 5, 6].map((key) => (
          <Card key={key} className="gap-2.5 px-4 py-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-3 w-20" />
          </Card>
        ))}
      </div>
      <div className="grid gap-4 @4xl:grid-cols-[minmax(0,13fr)_minmax(0,7fr)]">
        {panel('h-52', 0)}
        {panel('h-52', 1)}
      </div>
      <div className="grid gap-4 @4xl:grid-cols-2 @6xl:grid-cols-3">
        {panel('h-44', 0)}
        {panel('h-44', 1)}
        <div className="@4xl:col-span-2 @6xl:col-span-1">{panel('h-44', 2)}</div>
      </div>
      <div className="grid gap-4 @3xl:grid-cols-2 @5xl:grid-cols-3">
        {panel('h-36', 0)}
        {panel('h-36', 1)}
        {panel('h-36', 2)}
      </div>
    </div>
  )
}
