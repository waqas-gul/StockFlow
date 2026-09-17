import type { DashboardExpenseBreakdown } from '@shared/dashboard'
import { addDays, formatDisplayDate } from '@shared/dates'
import type { DailySales } from '@shared/reports'
import type { CurrencyFormat } from '../products/product-display'

/*
 * How the Dashboard reads: chart scales and labels, the donut's slices and short counts. Presentation only; every
 * figure comes from `window.api.dashboard.get()`.
 */

export type TrendRange = 7 | 30

/** The last `range` days of the trend. */
export function trendDays(trend: readonly DailySales[], range: TrendRange): readonly DailySales[] {
  return trend.slice(-range)
}

/** True when any day shown has a posted invoice. */
export function hasSales(days: readonly DailySales[]): boolean {
  return days.some((day) => day.invoiceCount > 0)
}

export function trendTotals(days: readonly DailySales[]): Omit<DailySales, 'date'> {
  return {
    invoiceCount: days.reduce((sum, day) => sum + day.invoiceCount, 0),
    netGoodsSalesMinor: days.reduce((sum, day) => sum + day.netGoodsSalesMinor, 0)
  }
}

const STEP_FACTORS = [1, 2, 2.5, 5, 10]

/** The amount axis: four even steps of a readable size (at least one currency unit) that reach `maxMinor`. */
export function chartScale(
  maxMinor: number,
  minorDigits: number
): { maxMinor: number; ticks: number[] } {
  const unit = 10 ** minorDigits
  const rough = Math.max(maxMinor / unit / 4, 1)
  const power = 10 ** Math.floor(Math.log10(rough))
  const stepMajor = power * STEP_FACTORS.find((factor) => factor * power >= rough)!
  const step = Math.round(stepMajor * unit)
  const ticks = [0, 1, 2, 3, 4].map((index) => index * step)
  return { maxMinor: ticks[4], ticks }
}

/** Which dates the axis names: every day of a week, every fifth day (ending today) of a month. */
export function xLabelIndexes(count: number): number[] {
  const every = count <= 7 ? 1 : 5
  return Array.from({ length: count }, (_, index) => index).filter(
    (index) => (count - 1 - index) % every === 0
  )
}

const COMPACT = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K']
] as const

/** An axis amount: 'Rs 950', 'Rs 2.5K', 'Rs 1.5M'. */
export function compactMoney(minor: number, currency: CurrencyFormat): string {
  const major = minor / 10 ** currency.minorDigits
  const [size, suffix] = COMPACT.find(([limit]) => Math.abs(major) >= limit) ?? [1, '']
  return `${currency.symbol} ${Math.round((major / size) * 10) / 10}${suffix}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-09-07' → '7 Sep'. */
export function shortDate(date: string): string {
  const [, month, day] = date.split('-').map(Number)
  return `${day} ${MONTHS[month - 1]}`
}

/** 'Today', 'Yesterday' or the date. */
export function relativeDay(date: string, today: string): string {
  if (date === today) return 'Today'
  if (date === addDays(today, -1)) return 'Yesterday'
  return formatDisplayDate(date)
}

export interface DonutSegment {
  readonly key: 'shop' | 'general'
  readonly label: string
  readonly minor: number
  /** Share of the total, 0–1. */
  readonly fraction: number
  /** Where the slice starts, 0–1. */
  readonly offset: number
}

/** One slice per expense group that has expenses; none when both are zero. */
export function donutSegments(
  breakdown: Pick<DashboardExpenseBreakdown, 'shopMinor' | 'generalMinor'>
): DonutSegment[] {
  const total = breakdown.shopMinor + breakdown.generalMinor
  if (total <= 0) return []
  const segments: DonutSegment[] = []
  let offset = 0
  for (const [key, label, minor] of [
    ['shop', 'Shop', breakdown.shopMinor],
    ['general', 'Monthly / General', breakdown.generalMinor]
  ] as const) {
    if (minor <= 0) continue
    segments.push({ key, label, minor, fraction: minor / total, offset })
    offset += minor / total
  }
  return segments
}

/** '1 invoice', '3 invoices'. */
export function countText(count: number, singular: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : `${singular}s`}`
}

/** A bar's width as a percentage of the largest; a value above zero always shows a sliver. */
export function barPercent(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  return Math.max((value / max) * 100, 2)
}
