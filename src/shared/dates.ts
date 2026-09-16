/*
 * Business dates are calendar days written 'YYYY-MM-DD' (the schema's date columns). "Today" is the computer's local
 * calendar day; the main process decides it for every posting.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The local calendar day of `time` as 'YYYY-MM-DD'. */
export function localDateString(time: Date): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0')
  return `${pad(time.getFullYear(), 4)}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`
}

/** True for 'YYYY-MM-DD' text naming a real calendar day (so 2026-02-30 is false). */
export function isCalendarDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

/** '2026-09-08' → '08-Sep-2026'. Other text is returned unchanged. */
export function formatDisplayDate(date: string): string {
  if (!isCalendarDate(date)) return date
  const [year, month, day] = date.split('-')
  return `${day}-${MONTHS[Number(month) - 1]}-${year}`
}
