import { formatDisplayDate, isCalendarDate } from '@shared/dates'
import type { ReportPeriod } from '@shared/reports'

/*
 * The report date range: a preset or custom inclusive business dates. Presets are calendar ranges around the computer's
 * today; no fiscal-year rule is assumed.
 */

export const PERIOD_PRESETS = ['TODAY', 'THIS_MONTH', 'LAST_MONTH', 'THIS_YEAR', 'CUSTOM'] as const
export type PeriodPreset = (typeof PERIOD_PRESETS)[number]

export const PERIOD_PRESET_LABELS: Readonly<Record<PeriodPreset, string>> = Object.freeze({
  TODAY: 'Today',
  THIS_MONTH: 'This Month',
  LAST_MONTH: 'Last Month',
  THIS_YEAR: 'This Year',
  CUSTOM: 'Custom'
})

const pad = (value: number): string => String(value).padStart(2, '0')

/** The last day of a month (month 1–12). */
function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The range of a preset for `today` ('YYYY-MM-DD'); null for CUSTOM. */
export function presetPeriod(preset: PeriodPreset, today: string): ReportPeriod | null {
  const [year, month] = today.split('-').map(Number)
  const ym = `${year}-${pad(month)}`
  switch (preset) {
    case 'TODAY':
      return { dateFrom: today, dateTo: today }
    case 'THIS_MONTH':
      return { dateFrom: `${ym}-01`, dateTo: `${ym}-${pad(lastDay(year, month))}` }
    case 'LAST_MONTH': {
      const [y, m] = month === 1 ? [year - 1, 12] : [year, month - 1]
      return { dateFrom: `${y}-${pad(m)}-01`, dateTo: `${y}-${pad(m)}-${pad(lastDay(y, m))}` }
    }
    case 'THIS_YEAR':
      return { dateFrom: `${year}-01-01`, dateTo: `${year}-12-31` }
    default:
      return null
  }
}

/** Why a custom range cannot be reported, or null when it can. */
export function periodError(dateFrom: string, dateTo: string): string | null {
  if (!isCalendarDate(dateFrom) || !isCalendarDate(dateTo)) return 'Enter both dates.'
  if (dateFrom > dateTo) return 'The end date cannot be before the start date.'
  return null
}

/** '01-Sep-2026 to 30-Sep-2026', or the one day. */
export function periodText(period: ReportPeriod): string {
  return period.dateFrom === period.dateTo
    ? formatDisplayDate(period.dateFrom)
    : `${formatDisplayDate(period.dateFrom)} to ${formatDisplayDate(period.dateTo)}`
}
