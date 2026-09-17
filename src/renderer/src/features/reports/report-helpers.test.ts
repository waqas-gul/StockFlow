import { describe, expect, it } from 'vitest'
import type { ProfitLossReport } from '@shared/reports'
import { moneyText, profitLossRows } from './report-display'
import { periodError, periodText, presetPeriod } from './report-period'
import { basePl } from './report-test-data'

const RS = { minorDigits: 2, symbol: 'Rs' }

describe('report periods', () => {
  it('turns presets into inclusive calendar ranges', () => {
    expect(presetPeriod('TODAY', '2026-09-17')).toEqual({
      dateFrom: '2026-09-17',
      dateTo: '2026-09-17'
    })
    expect(presetPeriod('THIS_MONTH', '2026-09-17')).toEqual({
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30'
    })
    expect(presetPeriod('THIS_MONTH', '2028-02-10')).toEqual({
      dateFrom: '2028-02-01',
      dateTo: '2028-02-29'
    })
    expect(presetPeriod('LAST_MONTH', '2026-09-17')).toEqual({
      dateFrom: '2026-08-01',
      dateTo: '2026-08-31'
    })
    expect(presetPeriod('LAST_MONTH', '2027-01-05')).toEqual({
      dateFrom: '2026-12-01',
      dateTo: '2026-12-31'
    })
    expect(presetPeriod('THIS_YEAR', '2026-09-17')).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31'
    })
    expect(presetPeriod('CUSTOM', '2026-09-17')).toBeNull()
  })

  it('checks a custom range and names it', () => {
    expect(periodError('2026-09-01', '2026-09-30')).toBeNull()
    expect(periodError('2026-09-01', '2026-09-01')).toBeNull()
    expect(periodError('', '2026-09-30')).toBe('Enter both dates.')
    expect(periodError('2026-09-30', '2026-09-01')).toBe(
      'The end date cannot be before the start date.'
    )
    expect(periodText({ dateFrom: '2026-09-01', dateTo: '2026-09-30' })).toBe(
      '01-Sep-2026 to 30-Sep-2026'
    )
    expect(periodText({ dateFrom: '2026-09-17', dateTo: '2026-09-17' })).toBe('17-Sep-2026')
  })
})

describe('report money', () => {
  it('writes amounts with the currency, and a minus sign below zero', () => {
    expect(moneyText(125_050, RS)).toBe('Rs 1,250.50')
    expect(moneyText(-5_000, RS)).toBe('−Rs 50.00')
    expect(moneyText(0, RS)).toBe('Rs 0.00')
  })
})

describe('profit and loss statement', () => {
  const rows = (report: ProfitLossReport): Array<[string, number | null, string | null]> =>
    profitLossRows(report).map((row) => [row.label, row.minor, row.effect])

  it('shows revenue, COGS, gross profit, the expense groups and net operating profit; zero stock lines stay hidden', () => {
    expect(rows(basePl)).toEqual([
      ['Revenue', null, null],
      ['Goods Revenue', 1_000_000, 'add'],
      ['Freight Income', 0, 'add'],
      ['Cost of Goods Sold', null, null],
      ['COGS', 600_000, 'deduct'],
      ['Gross Profit', 400_000, null],
      ['Operating Expenses', null, null],
      ['Shop Expenses', 100_000, 'deduct'],
      ['Monthly / General Expenses', 0, 'deduct'],
      ['Net Operating Profit', 300_000, null]
    ])
  })

  it('adds gains, losses and the data corrections below net operating profit when present', () => {
    const report: ProfitLossReport = {
      ...basePl,
      freightIncomeMinor: 50_000,
      stockGainsMinor: 20_000,
      stockDamageMinor: 10_000,
      stockShortageMinor: 5_000,
      stockLossesMinor: 15_000,
      netOperatingProfitMinor: 355_000,
      purchaseCostCorrectionsMinor: 25_000,
      inventoryCorrections: basePl.inventoryCorrections.map((total) =>
        total.reason === 'OTHER_CORRECTION'
          ? { ...total, count: 1, valueRemovedMinor: 7_000, netValueMinor: -7_000 }
          : total
      ),
      inventoryCorrectionsNetMinor: -7_000,
      profitAfterDataCorrectionsMinor: 323_000
    }
    expect(rows(report)).toEqual([
      ['Revenue', null, null],
      ['Goods Revenue', 1_000_000, 'add'],
      ['Freight Income', 50_000, 'add'],
      ['Cost of Goods Sold', null, null],
      ['COGS', 600_000, 'deduct'],
      ['Gross Profit', 400_000, null],
      ['Operating Gains', null, null],
      ['Stock Count Surplus', 20_000, 'add'],
      ['Operating Expenses', null, null],
      ['Shop Expenses', 100_000, 'deduct'],
      ['Monthly / General Expenses', 0, 'deduct'],
      ['Stock Damage', 10_000, 'deduct'],
      ['Stock Shortage', 5_000, 'deduct'],
      ['Net Operating Profit', 355_000, null],
      ['Data Corrections', null, null],
      ['Purchase Cost Corrections', 25_000, 'deduct'],
      ['Inventory Quantity Corrections', 7_000, 'deduct'],
      ['Profit After Data Corrections', 323_000, null]
    ])
  })
})
