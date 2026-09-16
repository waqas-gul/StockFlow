import { z } from 'zod'
import { isCalendarDate } from './dates'

/*
 * Small Zod building blocks shared by the business input schemas (settings, companies, products). Messages are plain
 * language: the Settings and Products screens show them next to the field.
 */

/** A row id: a positive whole number. */
export const IdSchema = z
  .number({ error: 'The record is not valid.' })
  .int('The record is not valid.')
  .positive('The record is not valid.')
  .max(Number.MAX_SAFE_INTEGER, 'The record is not valid.')

/** No control characters (tabs, line breaks, NUL…): names and codes are single-line text. */
const SINGLE_LINE = /^[^\p{Cc}]*$/u

export function wholeNumber(min: number, max: number): z.ZodNumber {
  const message = `Enter a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`
  return z.number({ error: message }).int(message).min(min, message).max(max, message)
}

/** Required single-line text, trimmed. */
export function requiredText(label: string, max: number): z.ZodString {
  const required = `Enter the ${label}.`
  return z
    .string({ error: required })
    .trim()
    .min(1, required)
    .max(max, `Use at most ${max} characters.`)
    .regex(SINGLE_LINE, 'Use a single line of text.')
}

/** Optional single-line text, trimmed; blank becomes null. */
export function optionalText(max: number): z.ZodType<string | null, string | null> {
  return z
    .string({ error: 'Enter text.' })
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .regex(SINGLE_LINE, 'Use a single line of text.')
    .nullable()
    .transform((value) => (value === null || value === '' ? null : value))
}

/** A money amount in integer minor units (paisa): zero or more. Null means "not set". */
export const MinorAmountSchema = z
  .number({ error: 'Enter a valid amount.' })
  .int('Enter a valid amount.')
  .min(0, 'The amount cannot be negative.')
  .max(Number.MAX_SAFE_INTEGER, 'The amount is too large.')
  .nullable()

/** A business date: 'YYYY-MM-DD', a real calendar day. */
export const DateSchema = z
  .string({ error: 'Enter the date.' })
  .refine(isCalendarDate, 'Enter a valid date.')

/**
 * The id the renderer creates once per form submission (a UUID). A retry of the same submission sends it again, and
 * the main process then returns the document it already saved instead of saving a second one.
 */
export const RequestIdSchema = z
  .string({ error: 'The request is not valid.' })
  .regex(/^[A-Za-z0-9-]{8,64}$/, 'The request is not valid.')

/** `{ id, active }`: activate or deactivate a record. */
export const SetActiveSchema = z.strictObject({ id: IdSchema, active: z.boolean() })
export type SetActiveInput = z.output<typeof SetActiveSchema>
