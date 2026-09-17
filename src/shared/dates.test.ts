import { describe, expect, it } from 'vitest'
import { addDays, formatDisplayDate, isCalendarDate, localDateString } from './dates'

describe('localDateString', () => {
  it('writes the local calendar day, padded', () => {
    expect(localDateString(new Date(2026, 8, 6, 23, 59, 59))).toBe('2026-09-06')
    expect(localDateString(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01')
  })
})

describe('addDays', () => {
  it('moves a business date by whole days across month, year and leap-day ends', () => {
    expect(addDays('2026-09-17', -29)).toBe('2026-08-19')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
    expect(addDays('2026-09-17', 0)).toBe('2026-09-17')
  })
})

describe('isCalendarDate', () => {
  it('accepts real days only, in the YYYY-MM-DD shape', () => {
    expect(isCalendarDate('2026-09-16')).toBe(true)
    expect(isCalendarDate('2024-02-29')).toBe(true)
    for (const text of [
      '2026-02-30',
      '2025-02-29',
      '2026-13-01',
      '2026-9-16',
      '16-09-2026',
      '',
      '2026-09-16T00:00'
    ]) {
      expect(isCalendarDate(text)).toBe(false)
    }
  })
})

describe('formatDisplayDate', () => {
  it('shows day, short month and year', () => {
    expect(formatDisplayDate('2026-09-08')).toBe('08-Sep-2026')
    expect(formatDisplayDate('not a date')).toBe('not a date')
  })
})
