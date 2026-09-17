import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { localDateString } from '@shared/dates'
import type { ReportPeriod } from '@shared/reports'
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
import { settingsQuery } from '@renderer/lib/app-queries'
import { cn } from '@renderer/lib/utils'
import type { CurrencyFormat } from '../products/product-display'
import { CustomerBalancesSection, StockSection } from './CurrentReportViews'
import { ExpenseReportSection } from './ExpenseReportView'
import { ProfitLossSection } from './ProfitLossReportView'
import {
  PERIOD_PRESETS,
  PERIOD_PRESET_LABELS,
  periodError,
  periodText,
  presetPeriod,
  type PeriodPreset
} from './report-period'
import { ReportMessage } from './ReportParts'
import { ProductSalesSection, SalesSection } from './SalesReportViews'

export const REPORT_TABS = [
  { id: 'profit-loss', label: 'Profit & Loss', dated: true },
  { id: 'sales', label: 'Sales', dated: true },
  { id: 'products', label: 'Products', dated: true },
  { id: 'stock', label: 'Stock', dated: false },
  { id: 'customers', label: 'Customer Balances', dated: false },
  { id: 'expenses', label: 'Expenses', dated: true }
] as const
export type ReportTab = (typeof REPORT_TABS)[number]['id']

/**
 * Reports (Phase 11): Profit & Loss, Sales, Products and Expenses for a date range, and current Stock and Customer
 * Balances. Every figure is derived from the saved records when shown; nothing here changes data.
 */
export function ReportsPage({
  initialTab = 'profit-loss',
  today = localDateString(new Date())
}: {
  initialTab?: ReportTab
  /** The computer's today; a prop only so tests can fix it. */
  today?: string
}): React.JSX.Element {
  const settings = useQuery(settingsQuery)
  const [tab, setTab] = useState<ReportTab>(initialTab)
  const [preset, setPreset] = useState<PeriodPreset>('THIS_MONTH')
  const thisMonth = presetPeriod('THIS_MONTH', today)!
  const [custom, setCustom] = useState<ReportPeriod>(thisMonth)

  const period = presetPeriod(preset, today) ?? custom
  const error = preset === 'CUSTOM' ? periodError(custom.dateFrom, custom.dateTo) : null
  const dated = REPORT_TABS.find((item) => item.id === tab)!.dated
  const currency: CurrencyFormat | null = settings.data
    ? {
        minorDigits: settings.data.values['currency.minorDigits'],
        symbol: settings.data.values['currency.symbol']
      }
    : null
  const periodKey = `${period.dateFrom}:${period.dateTo}`

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 pb-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Calculated from the saved invoices, stock ledger, expenses and customer ledger each time
          they are shown. Reports never change any data.
        </p>
      </div>

      <Card className="gap-0 py-0">
        <CardContent className="flex flex-wrap items-end justify-between gap-3 px-4 py-3">
          <div
            role="tablist"
            aria-label="Report"
            className="flex flex-wrap gap-1 rounded-lg bg-muted p-1"
          >
            {REPORT_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  tab === item.id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {dated ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground">Period</Label>
                <Select
                  value={preset}
                  onValueChange={(value) => {
                    // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
                    if (value === '') return
                    const next = value as PeriodPreset
                    // Custom starts from the range that was showing.
                    if (next === 'CUSTOM' && error === null) setCustom(period)
                    setPreset(next)
                  }}
                >
                  <SelectTrigger aria-label="Report period" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PERIOD_PRESETS.map((item) => (
                      <SelectItem key={item} value={item}>
                        {PERIOD_PRESET_LABELS[item]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor="report-from" className="text-xs text-muted-foreground">
                  From
                </Label>
                <Input
                  id="report-from"
                  type="date"
                  className="w-40"
                  value={period.dateFrom}
                  disabled={preset !== 'CUSTOM'}
                  onChange={(event) => setCustom({ ...custom, dateFrom: event.target.value })}
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="report-to" className="text-xs text-muted-foreground">
                  To
                </Label>
                <Input
                  id="report-to"
                  type="date"
                  className="w-40"
                  value={period.dateTo}
                  disabled={preset !== 'CUSTOM'}
                  onChange={(event) => setCustom({ ...custom, dateTo: event.target.value })}
                />
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Current figures, as of now</p>
          )}
        </CardContent>
      </Card>

      {dated && error === null && (
        <p className="-mt-2 text-xs text-muted-foreground">
          {PERIOD_PRESET_LABELS[preset]} · {periodText(period)} · by invoice, adjustment and expense
          dates
        </p>
      )}

      {currency === null ? (
        <ReportMessage error={settings.error !== null}>
          {settings.error ? settings.error.message : 'Loading…'}
        </ReportMessage>
      ) : dated && error !== null ? (
        <ReportMessage error>{error}</ReportMessage>
      ) : tab === 'profit-loss' ? (
        <ProfitLossSection period={period} currency={currency} />
      ) : tab === 'sales' ? (
        <SalesSection key={periodKey} period={period} currency={currency} />
      ) : tab === 'products' ? (
        <ProductSalesSection period={period} currency={currency} />
      ) : tab === 'stock' ? (
        <StockSection currency={currency} />
      ) : tab === 'customers' ? (
        <CustomerBalancesSection currency={currency} />
      ) : (
        <ExpenseReportSection key={periodKey} period={period} currency={currency} />
      )}
    </div>
  )
}
