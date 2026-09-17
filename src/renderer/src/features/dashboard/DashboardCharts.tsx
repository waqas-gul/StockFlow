import { useState } from 'react'
import { ChartLine, Wallet } from 'lucide-react'
import type { DashboardExpenseBreakdown } from '@shared/dashboard'
import { formatDisplayDate } from '@shared/dates'
import type { DailySales } from '@shared/reports'
import { cn } from '@renderer/lib/utils'
import type { CurrencyFormat } from '../products/product-display'
import { moneyText } from '../reports/report-display'
import {
  chartScale,
  compactMoney,
  countText,
  donutSegments,
  hasSales,
  shortDate,
  trendDays,
  trendTotals,
  xLabelIndexes,
  type TrendRange
} from './dashboard-display'
import { DashboardPanel, PanelEmpty } from './DashboardParts'

/*
 * The Dashboard's two charts, drawn with plain SVG and CSS (no chart library): the sales trend and this month's
 * expenses. They only draw what the overview holds; a period without sales or expenses shows a message instead.
 */

const RANGES: readonly TrendRange[] = [7, 30]

export function SalesTrendPanel({
  trend,
  currency
}: {
  trend: readonly DailySales[]
  currency: CurrencyFormat
}): React.JSX.Element {
  const [range, setRange] = useState<TrendRange>(7)
  const days = trendDays(trend, range)
  return (
    <DashboardPanel
      title="Sales Trend"
      description="Net goods sales of posted invoices"
      action={
        <div role="group" aria-label="Period" className="flex gap-0.5 rounded-md bg-muted p-0.5">
          {RANGES.map((item) => (
            <button
              key={item}
              type="button"
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                range === item
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setRange(item)}
              aria-pressed={range === item}
            >
              {`${item} Days`}
            </button>
          ))}
        </div>
      }
    >
      {hasSales(days) ? (
        <div className="px-4 pt-1 pb-4">
          <SalesTrendChart days={days} currency={currency} />
        </div>
      ) : (
        <PanelEmpty icon={ChartLine}>No sales recorded for this period.</PanelEmpty>
      )}
    </DashboardPanel>
  )
}

/** Daily sales as an area line. Hovering a day shows its date, sales and invoice count. */
export function SalesTrendChart({
  days,
  currency
}: {
  days: readonly DailySales[]
  currency: CurrencyFormat
}): React.JSX.Element {
  const [active, setActive] = useState<number | null>(null)
  const totals = trendTotals(days)
  const scale = chartScale(
    Math.max(0, ...days.map((day) => day.netGoodsSalesMinor)),
    currency.minorDigits
  )
  const x = (index: number): number => ((index + 0.5) / days.length) * 100
  const height = (minor: number): number => (minor / scale.maxMinor) * 100
  const points = days.map((day, index) => [x(index), 100 - height(day.netGoodsSalesMinor)])
  const line = points
    .map(([px, py], index) => `${index === 0 ? 'M' : 'L'}${px.toFixed(2)} ${py.toFixed(2)}`)
    .join(' ')
  const area = `${line} L${points.at(-1)![0].toFixed(2)} 100 L${points[0][0].toFixed(2)} 100 Z`
  const labelled = new Set(xLabelIndexes(days.length))
  const activeDay = active === null ? null : days[active]
  const summary = `Sales, last ${days.length} days: ${moneyText(totals.netGoodsSalesMinor, currency)} from ${countText(totals.invoiceCount, 'invoice')}`

  return (
    <div role="img" aria-label={summary}>
      <div className="flex gap-3">
        <div className="relative h-48 w-14 shrink-0 text-xs text-muted-foreground" aria-hidden>
          {scale.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 translate-y-1/2 whitespace-nowrap tabular-nums"
              style={{ bottom: `${height(tick)}%` }}
            >
              {compactMoney(tick, currency)}
            </span>
          ))}
        </div>
        <div className="relative h-48 min-w-0 flex-1" onMouseLeave={() => setActive(null)}>
          {scale.ticks.map((tick) => (
            <div
              key={tick}
              aria-hidden
              className={cn(
                'absolute inset-x-0 border-t',
                tick === 0 ? 'border-border' : 'border-dashed border-border/70'
              )}
              style={{ bottom: `${height(tick)}%` }}
            />
          ))}
          <svg
            aria-hidden
            className="absolute inset-0 size-full overflow-visible"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <path d={area} className="fill-primary/8" />
            <path
              d={line}
              className="fill-none stroke-primary"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              data-chart="sales-line"
            />
          </svg>
          {activeDay !== null && (
            <div
              aria-hidden
              className="absolute inset-y-0 border-l border-ring/40"
              style={{ left: `${x(active!)}%` }}
            />
          )}
          {points.map(([px, py], index) =>
            days.length <= 7 || index === active ? (
              <span
                key={days[index].date}
                aria-hidden
                className={cn(
                  'absolute -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-primary bg-card',
                  index === active ? 'size-3' : 'size-2'
                )}
                style={{ left: `${px}%`, bottom: `${100 - py}%` }}
              />
            ) : null
          )}
          {activeDay !== null && (
            <div
              className={cn(
                'pointer-events-none absolute top-0 z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap shadow-sm',
                x(active!) < 25
                  ? 'translate-x-2'
                  : x(active!) > 75
                    ? '-translate-x-[calc(100%+0.5rem)]'
                    : '-translate-x-1/2'
              )}
              style={{ left: `${x(active!)}%` }}
            >
              <p className="text-muted-foreground">{formatDisplayDate(activeDay.date)}</p>
              <p className="font-semibold tabular-nums">
                {moneyText(activeDay.netGoodsSalesMinor, currency)}
              </p>
              <p className="text-muted-foreground">
                {countText(activeDay.invoiceCount, 'invoice')}
              </p>
            </div>
          )}
          <div className="absolute inset-0 flex">
            {days.map((day, index) => (
              <div key={day.date} className="h-full flex-1" onMouseEnter={() => setActive(index)} />
            ))}
          </div>
        </div>
      </div>
      <div className="relative mt-2 ml-[4.25rem] h-4 text-xs text-muted-foreground" aria-hidden>
        {days.map((day, index) =>
          labelled.has(index) ? (
            <span
              key={day.date}
              className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${x(index)}%` }}
              data-axis="x"
            >
              {shortDate(day.date)}
            </span>
          ) : null
        )}
      </div>
    </div>
  )
}

const SLICE_COLORS = { shop: 'stroke-primary', general: 'stroke-primary/35' } as const
const SWATCH_COLORS = { shop: 'bg-primary', general: 'bg-primary/35' } as const

/** This month's Shop and Monthly / General expenses as a donut. */
export function ExpenseBreakdownPanel({
  breakdown,
  currency
}: {
  breakdown: DashboardExpenseBreakdown
  currency: CurrencyFormat
}): React.JSX.Element {
  const segments = donutSegments(breakdown)
  const money = (minor: number): string => moneyText(minor, currency)
  return (
    <DashboardPanel title="Expenses This Month">
      {segments.length === 0 ? (
        <PanelEmpty icon={Wallet}>No expenses recorded this month.</PanelEmpty>
      ) : (
        <div className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-4 px-4 pb-4">
          <svg viewBox="0 0 42 42" className="size-32 shrink-0 -rotate-90" aria-hidden>
            <circle
              cx="21"
              cy="21"
              r="15.9155"
              className="fill-none stroke-muted"
              strokeWidth={6}
            />
            {segments.map((segment) => (
              <circle
                key={segment.key}
                cx="21"
                cy="21"
                r="15.9155"
                className={cn('fill-none', SLICE_COLORS[segment.key])}
                strokeWidth={6}
                strokeDasharray={`${segment.fraction * 100} ${100 - segment.fraction * 100}`}
                strokeDashoffset={-segment.offset * 100}
                data-slice={segment.key}
              />
            ))}
          </svg>
          <div className="max-w-xs min-w-40 flex-1 space-y-3">
            <div>
              <p className="text-xs text-muted-foreground">Total Expenses</p>
              <p className="text-lg font-semibold tabular-nums">
                {money(breakdown.operatingMinor)}
              </p>
            </div>
            <ul className="space-y-1.5 text-sm">
              {(
                [
                  ['shop', 'Shop', breakdown.shopMinor],
                  ['general', 'Monthly / General', breakdown.generalMinor]
                ] as const
              ).map(([key, label, minor]) => (
                <li key={key} className="flex items-center gap-2">
                  <span aria-hidden className={cn('size-2.5 rounded-sm', SWATCH_COLORS[key])} />
                  <span className="flex-1 text-muted-foreground">{label}</span>
                  <span className="tabular-nums">{money(minor)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {breakdown.purchaseCostCorrectionsMinor > 0 && (
        <p className="px-4 pb-4 text-xs text-muted-foreground">
          Purchase cost corrections of {money(breakdown.purchaseCostCorrectionsMinor)} are not
          included.
        </p>
      )}
    </DashboardPanel>
  )
}
