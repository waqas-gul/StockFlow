import { z } from 'zod'
import type { BalanceSide } from '@shared/customers'
import { isCalendarDate } from '@shared/dates'
import { parseMoney } from '@shared/domain'
import {
  CONTACT_PERSON_MAX,
  SUPPLIER_ADDRESS_MAX,
  SUPPLIER_CITY_MAX,
  SUPPLIER_NAME_MAX,
  SUPPLIER_NOTES_MAX,
  SUPPLIER_PHONE_MAX,
  SUPPLIER_REASON_MAX,
  type Supplier,
  type SupplierBalanceAdjustmentInput,
  type SupplierCreateInput,
  type SupplierUpdateInput
} from '@shared/suppliers'
import { moneyText, optionalText, positiveMoneyText } from '@renderer/lib/form-text'
import { fieldPairs } from '../customers/customer-form'

/*
 * The Add/Edit Supplier form and Adjust Supplier Balance. The opening balance is only part of Add: an amount (never
 * signed), whether the shop owes the supplier or the supplier holds an advance, and its date. Edit changes the profile
 * only. The main process signs every amount.
 */

export interface SupplierFormValues {
  name: string
  contactPerson: string
  phone: string
  address: string
  city: string
  notes: string
  /** Add only: blank or 0 means no opening balance. */
  openingAmount: string
  /** DUE: we owe the supplier. ADVANCE: the supplier holds an advance of ours. */
  openingSide: BalanceSide
  openingDate: string
}

/** What the form produces: the create input without the currency check. Edit ignores `opening`. */
export type SupplierDraft = Omit<SupplierCreateInput, 'currencyMinorDigits'>

export function emptySupplierForm(today: string): SupplierFormValues {
  return {
    name: '',
    contactPerson: '',
    phone: '',
    address: '',
    city: '',
    notes: '',
    openingAmount: '',
    openingSide: 'DUE',
    openingDate: today
  }
}

/** The edit form of a saved supplier. */
export function supplierFormValues(supplier: Supplier, today: string): SupplierFormValues {
  return {
    ...emptySupplierForm(today),
    name: supplier.name,
    contactPerson: supplier.contactPerson ?? '',
    phone: supplier.phone ?? '',
    address: supplier.address ?? '',
    city: supplier.city ?? '',
    notes: supplier.notes ?? ''
  }
}

export function supplierFormSchema(
  minorDigits: number
): z.ZodType<SupplierDraft, SupplierFormValues> {
  return z
    .object({
      name: z
        .string()
        .trim()
        .min(1, 'Enter the supplier name.')
        .max(SUPPLIER_NAME_MAX, `Use at most ${SUPPLIER_NAME_MAX} characters.`)
        .regex(/^[^\p{Cc}]*$/u, 'Use a single line of text.'),
      contactPerson: optionalText(CONTACT_PERSON_MAX),
      phone: optionalText(SUPPLIER_PHONE_MAX),
      address: optionalText(SUPPLIER_ADDRESS_MAX),
      city: optionalText(SUPPLIER_CITY_MAX),
      notes: optionalText(SUPPLIER_NOTES_MAX),
      openingAmount: moneyText(minorDigits),
      openingSide: z.enum(['DUE', 'ADVANCE']),
      openingDate: z.string()
    })
    .transform((values, ctx): SupplierDraft => {
      const amount = values.openingAmount ?? 0
      if (amount > 0 && !isCalendarDate(values.openingDate)) {
        ctx.addIssue({
          code: 'custom',
          path: ['openingDate'],
          message: 'Enter the opening balance date.'
        })
      }
      return {
        name: values.name,
        contactPerson: values.contactPerson,
        phone: values.phone,
        address: values.address,
        city: values.city,
        notes: values.notes,
        opening:
          amount > 0
            ? { side: values.openingSide, amountMinor: amount, date: values.openingDate }
            : null
      }
    })
}

export function toSupplierCreateInput(
  draft: SupplierDraft,
  minorDigits: number
): SupplierCreateInput {
  return { ...draft, currencyMinorDigits: minorDigits }
}

export function toSupplierUpdateInput(id: number, draft: SupplierDraft): SupplierUpdateInput {
  return {
    id,
    name: draft.name,
    contactPerson: draft.contactPerson,
    phone: draft.phone,
    address: draft.address,
    city: draft.city,
    notes: draft.notes
  }
}

/** The opening balance as it will be saved (positive Due, negative Advance, 0 none); null while the amount is not valid. */
export function supplierOpeningPreview(
  values: Pick<SupplierFormValues, 'openingAmount' | 'openingSide'>,
  minorDigits: number
): number | null {
  if (values.openingAmount.trim() === '') return 0
  const parsed = parseMoney(values.openingAmount, { minorDigits })
  if (!parsed.ok) return null
  return values.openingSide === 'DUE' ? parsed.value : -parsed.value
}

/** The main process's field errors as [form path, message] pairs; anything else goes to `root`. */
export function serverSupplierErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Array<[string, string]> {
  return fieldPairs(fieldErrors, {
    name: 'name',
    contactPerson: 'contactPerson',
    phone: 'phone',
    address: 'address',
    city: 'city',
    notes: 'notes',
    'opening.amountMinor': 'openingAmount',
    'opening.side': 'openingSide',
    'opening.date': 'openingDate'
  })
}

// --- Adjust Supplier Balance --------------------------------------------------------------------------------------------

export interface SupplierAdjustmentFormValues {
  entryDate: string
  /** '' until the owner chooses. */
  direction: '' | 'INCREASE' | 'DECREASE'
  amount: string
  reason: string
}

export type SupplierAdjustmentDraft = Omit<
  SupplierBalanceAdjustmentInput,
  'supplierId' | 'currencyMinorDigits'
>

export function emptySupplierAdjustmentForm(today: string): SupplierAdjustmentFormValues {
  return { entryDate: today, direction: '', amount: '', reason: '' }
}

export function supplierAdjustmentFormSchema(
  minorDigits: number
): z.ZodType<SupplierAdjustmentDraft, SupplierAdjustmentFormValues> {
  return z
    .object({
      entryDate: z.string().refine(isCalendarDate, 'Enter a valid date.'),
      direction: z.enum(['INCREASE', 'DECREASE'], {
        error: 'Choose whether the shop owes the supplier more or less.'
      }),
      amount: positiveMoneyText(minorDigits, 'Enter the amount.'),
      reason: z
        .string()
        .trim()
        .min(1, 'Enter the reason.')
        .max(SUPPLIER_REASON_MAX, `Use at most ${SUPPLIER_REASON_MAX} characters.`)
        .regex(/^[^\p{Cc}]*$/u, 'Use a single line of text.')
    })
    .transform((values) => ({
      entryDate: values.entryDate,
      direction: values.direction,
      amountMinor: values.amount,
      reason: values.reason
    }))
}

export function toSupplierAdjustmentInput(
  draft: SupplierAdjustmentDraft,
  supplierId: number,
  minorDigits: number
): SupplierBalanceAdjustmentInput {
  return { supplierId, ...draft, currencyMinorDigits: minorDigits }
}

/** The supplier balance after the adjustment as typed so far; null until the direction and a valid amount are known. */
export function supplierAdjustmentPreview(
  balanceMinor: number,
  values: Pick<SupplierAdjustmentFormValues, 'direction' | 'amount'>,
  minorDigits: number
): number | null {
  if (values.direction === '') return null
  const parsed = parseMoney(values.amount, { minorDigits })
  if (!parsed.ok) return null
  return balanceMinor + (values.direction === 'INCREASE' ? parsed.value : -parsed.value)
}

export function serverSupplierAdjustmentErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Array<[string, string]> {
  return fieldPairs(fieldErrors, {
    entryDate: 'entryDate',
    direction: 'direction',
    amountMinor: 'amount',
    reason: 'reason'
  })
}
