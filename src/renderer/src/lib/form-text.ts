import { z } from 'zod'
import { parseMoney, type DecimalParseError } from '@shared/domain'

/*
 * Zod parsers for what the user types into form inputs (always text). Amounts use the Phase 2 money parser, so
 * "1250", "1250.50" and "1,250.50" become integer minor units and extra decimals are refused, never rounded.
 */

/** Optional text typed in the form: trimmed, blank becomes null (the same rules as the shared schema). */
export function optionalText(max: number): z.ZodType<string | null, string> {
  return z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .regex(/^[^\p{Cc}]*$/u, 'Use a single line of text.')
    .transform((value) => (value === '' ? null : value))
}

export function moneyText(minorDigits: number): z.ZodType<number | null, string> {
  return z.string().transform((text, ctx) => {
    if (text.trim() === '') return null
    const parsed = parseMoney(text, { minorDigits })
    if (parsed.ok) return parsed.value
    ctx.addIssue({ code: 'custom', message: moneyMessage(parsed.error, minorDigits) })
    return z.NEVER
  })
}

export function moneyMessage(error: DecimalParseError, minorDigits: number): string {
  switch (error) {
    case 'TOO_MANY_DECIMALS':
      return minorDigits === 0
        ? 'Enter a whole amount.'
        : `Use at most ${minorDigits} decimal place${minorDigits === 1 ? '' : 's'}.`
    case 'NEGATIVE_NOT_ALLOWED':
      return 'The amount cannot be negative.'
    case 'OUT_OF_RANGE':
      return 'The amount is too large.'
    default:
      return 'Enter an amount such as 1250 or 1,250.50.'
  }
}

export function wholeNumberText(min: number, max: number): z.ZodType<number, string> {
  const message = `Enter a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`
  return z.string().transform((text, ctx) => {
    const digits = text.trim().replaceAll(',', '')
    const value = /^\d{1,13}$/.test(digits) ? Number(digits) : Number.NaN
    if (Number.isSafeInteger(value) && value >= min && value <= max) return value
    ctx.addIssue({ code: 'custom', message })
    return z.NEVER
  })
}

/** A required amount above zero (a payment or a correction): blank is refused with `required`, and so is 0. */
export function positiveMoneyText(
  minorDigits: number,
  required: string
): z.ZodType<number, string> {
  return z.string().transform((text, ctx) => {
    const parsed = parseMoney(text, { minorDigits })
    if (parsed.ok && parsed.value > 0) return parsed.value
    const message = parsed.ok
      ? 'Enter an amount greater than zero.'
      : parsed.error === 'EMPTY'
        ? required
        : moneyMessage(parsed.error, minorDigits)
    ctx.addIssue({ code: 'custom', message })
    return z.NEVER
  })
}

/** A required amount: like moneyText, but blank is refused with `required`. */
export function requiredMoneyText(
  minorDigits: number,
  required: string
): z.ZodType<number, string> {
  return moneyText(minorDigits).transform((value, ctx) => {
    if (value !== null) return value
    ctx.addIssue({ code: 'custom', message: required })
    return z.NEVER
  })
}
