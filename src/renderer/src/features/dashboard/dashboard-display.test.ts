import { describe, expect, it } from 'vitest'
import type { DailySales } from '@shared/reports'
import {
  barPercent,
  chartScale,
  compactMoney,
  countText,
  donutSegments,
  hasSales,
  relativeDay,
  shortDate,
  trendDays,
  trendTotals,
  xLabelIndexes
} from './dashboard-display'

const RS = { minorDigits: 2, symbol: 'Rs' }

function days(count: number, sales: Record<number, [number, number]> = {}): DailySales[] {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    invoiceCount: sales[index]?.[0] ?? 0,
    netGoodsSalesMinor: sales[index]?.[1] ?? 0
  }))
}

describe('sales trend', () => {
  it('shows the last 7 or all 30 days', () => {
    const trend = days(30)
    expect(trendDays(trend, 7).map((day) => day.date)).toEqual([
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30'
    ])
    expect(trendDays(trend, 30)).toHaveLength(30)
  })

  it('has sales only when a day has a posted invoice, and totals the days shown', () => {
    expect(hasSales(days(7))).toBe(false)
    const trend = days(7, { 2: [1, 50_000], 6: [2, 125_000] })
    expect(hasSales(trend)).toBe(true)
    expect(trendTotals(trend)).toEqual({ invoiceCount: 3, netGoodsSalesMinor: 175_000 })
  })

  it('rounds the amount axis up to a readable top with four even steps', () => {
    // Rs 9,900.00 → 0, 2,500, 5,000, 7,500, 10,000.
    expect(chartScale(990_000, 2)).toEqual({
      maxMinor: 1_000_000,
      ticks: [0, 250_000, 500_000, 750_000, 1_000_000]
    })
    expect(chartScale(1_000_000, 2).maxMinor).toBe(1_000_000)
    expect(chartScale(123_456_789, 2).ticks).toEqual([
      0, 50_000_000, 100_000_000, 150_000_000, 200_000_000
    ])
    // Whole-rupee currencies, and tiny or zero amounts, still get steps of at least one unit.
    expect(chartScale(3_700, 0).ticks).toEqual([0, 1_000, 2_000, 3_000, 4_000])
    expect(chartScale(250, 2).ticks).toEqual([0, 100, 200, 300, 400])
    expect(chartScale(0, 2).ticks).toEqual([0, 100, 200, 300, 400])
  })

  it('labels the date axis without crowding it: every day of a week, every fifth day of a month', () => {
    expect(xLabelIndexes(7)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(xLabelIndexes(30)).toEqual([4, 9, 14, 19, 24, 29])
  })

  it('writes axis amounts compactly', () => {
    expect(compactMoney(0, RS)).toBe('Rs 0')
    expect(compactMoney(95_000, RS)).toBe('Rs 950')
    expect(compactMoney(250_000, RS)).toBe('Rs 2.5K')
    expect(compactMoney(1_000_000, RS)).toBe('Rs 10K')
    expect(compactMoney(150_000_000, RS)).toBe('Rs 1.5M')
    expect(compactMoney(250_000_000_000, RS)).toBe('Rs 2.5B')
    expect(compactMoney(7_500, { minorDigits: 0, symbol: 'PKR' })).toBe('PKR 7.5K')
  })
})

describe('dates', () => {
  it('writes chart dates short, and recent dates relative to today', () => {
    expect(shortDate('2026-09-07')).toBe('7 Sep')
    expect(relativeDay('2026-09-17', '2026-09-17')).toBe('Today')
    expect(relativeDay('2026-09-16', '2026-09-17')).toBe('Yesterday')
    expect(relativeDay('2026-08-31', '2026-09-01')).toBe('Yesterday')
    expect(relativeDay('2026-09-15', '2026-09-17')).toBe('15-Sep-2026')
  })
})

describe('expense donut', () => {
  it('has no slices without expenses', () => {
    expect(donutSegments({ shopMinor: 0, generalMinor: 0 })).toEqual([])
  })

  it('draws only the groups that have expenses, as shares of their total', () => {
    expect(donutSegments({ shopMinor: 10_000, generalMinor: 30_000 })).toEqual([
      { key: 'shop', label: 'Shop', minor: 10_000, fraction: 0.25, offset: 0 },
      { key: 'general', label: 'Monthly / General', minor: 30_000, fraction: 0.75, offset: 0.25 }
    ])
    expect(donutSegments({ shopMinor: 0, generalMinor: 5_000 })).toEqual([
      { key: 'general', label: 'Monthly / General', minor: 5_000, fraction: 1, offset: 0 }
    ])
  })
})

describe('text and bars', () => {
  it('counts with the right plural', () => {
    expect(countText(0, 'invoice')).toBe('0 invoices')
    expect(countText(1, 'invoice')).toBe('1 invoice')
    expect(countText(1_250, 'active product')).toBe('1,250 active products')
  })

  it('sizes bars against the largest, keeping a sliver visible for small values', () => {
    expect(barPercent(50, 200)).toBe(25)
    expect(barPercent(200, 200)).toBe(100)
    expect(barPercent(1, 1_000_000)).toBe(2)
    expect(barPercent(0, 0)).toBe(0)
  })
})
