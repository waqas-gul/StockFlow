import { z } from 'zod'
import { LEDGER_REASON_MAX, type BalanceAdjustmentInput } from '@shared/customers'
import { isCalendarDate } from '@shared/dates'
import { parseMoney } from '@shared/domain'
import { positiveMoneyText } from '@renderer/lib/form-text'
import { fieldPairs } from './customer-form'

/*
 * Adjust Balance: an account correction. The operator chooses whether the customer owes more or less and types a
 * positive amount; the main process signs it.
 */

export interface BalanceAdjustmentFormValues {
  entryDate: string
  /** '' until the operator chooses. */
  direction: '' | 'INCREASE' | 'DECREASE'
  amount: string
  reason: string
}

export type BalanceAdjustmentDraft = Omit<
  BalanceAdjustmentInput,
  'customerId' | 'currencyMinorDigits'
>

export function emptyBalanceAdjustmentForm(today: string): BalanceAdjustmentFormValues {
  return { entryDate: today, direction: '', amount: '', reason: '' }
}

export function balanceAdjustmentFormSchema(
  minorDigits: number
): z.ZodType<BalanceAdjustmentDraft, BalanceAdjustmentFormValues> {
  return z
    .object({
      entryDate: z.string().refine(isCalendarDate, 'Enter a valid date.'),
      direction: z.enum(['INCREASE', 'DECREASE'], {
        error: 'Choose whether the customer owes more or less.'
      }),
      amount: positiveMoneyText(minorDigits, 'Enter the amount.'),
      reason: z
        .string()
        .trim()
        .min(1, 'Enter the reason.')
        .max(LEDGER_REASON_MAX, `Use at most ${LEDGER_REASON_MAX} characters.`)
        .regex(/^[^\p{Cc}]*$/u, 'Use a single line of text.')
    })
    .transform((values) => ({
      entryDate: values.entryDate,
      direction: values.direction,
      amountMinor: values.amount,
      reason: values.reason
    }))
}

export function toBalanceAdjustmentInput(
  draft: BalanceAdjustmentDraft,
  customerId: number,
  minorDigits: number
): BalanceAdjustmentInput {
  return { customerId, ...draft, currencyMinorDigits: minorDigits }
}

/** The balance after the adjustment as typed so far; null until the direction and a valid amount are known. */
export function adjustmentBalancePreview(
  balanceMinor: number,
  values: Pick<BalanceAdjustmentFormValues, 'direction' | 'amount'>,
  minorDigits: number
): number | null {
  if (values.direction === '') return null
  const parsed = parseMoney(values.amount, { minorDigits })
  if (!parsed.ok) return null
  return balanceMinor + (values.direction === 'INCREASE' ? parsed.value : -parsed.value)
}

/** The main process's field errors as [form path, message] pairs. */
export function serverBalanceAdjustmentErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Array<[string, string]> {
  return fieldPairs(fieldErrors, {
    entryDate: 'entryDate',
    direction: 'direction',
    amountMinor: 'amount',
    reason: 'reason'
  })
}
