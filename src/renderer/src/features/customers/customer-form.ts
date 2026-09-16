import { z } from 'zod'
import {
  ADDRESS_MAX,
  CITY_MAX,
  CUSTOMER_NAME_MAX,
  CUSTOMER_NOTES_MAX,
  PHONE_MAX,
  SHOP_NAME_MAX,
  type BalanceSide,
  type Customer,
  type CustomerCreateInput,
  type CustomerUpdateInput
} from '@shared/customers'
import { isCalendarDate } from '@shared/dates'
import { parseMoney } from '@shared/domain'
import { moneyText, optionalText } from '@renderer/lib/form-text'

/*
 * The Add/Edit Customer form. The opening balance is only part of Add: an amount (never signed), whether the customer
 * owes the shop or has an advance, and its date. Edit changes the profile only.
 */

export interface CustomerFormValues {
  name: string
  shopName: string
  phone: string
  address: string
  city: string
  notes: string
  /** Add only: blank or 0 means no opening balance. */
  openingAmount: string
  openingSide: BalanceSide
  openingDate: string
}

/** What the form produces: the create input without the currency check. Edit ignores `opening`. */
export type CustomerDraft = Omit<CustomerCreateInput, 'currencyMinorDigits'>

export function emptyCustomerForm(today: string): CustomerFormValues {
  return {
    name: '',
    shopName: '',
    phone: '',
    address: '',
    city: '',
    notes: '',
    openingAmount: '',
    openingSide: 'DUE',
    openingDate: today
  }
}

/** The edit form of a saved customer. */
export function customerFormValues(customer: Customer, today: string): CustomerFormValues {
  return {
    ...emptyCustomerForm(today),
    name: customer.name,
    shopName: customer.shopName ?? '',
    phone: customer.phone ?? '',
    address: customer.address ?? '',
    city: customer.city ?? '',
    notes: customer.notes ?? ''
  }
}

export function customerFormSchema(
  minorDigits: number
): z.ZodType<CustomerDraft, CustomerFormValues> {
  const required = 'Enter the customer name.'
  return z
    .object({
      name: z
        .string()
        .trim()
        .min(1, required)
        .max(CUSTOMER_NAME_MAX, `Use at most ${CUSTOMER_NAME_MAX} characters.`)
        .regex(/^[^\p{Cc}]*$/u, 'Use a single line of text.'),
      shopName: optionalText(SHOP_NAME_MAX),
      phone: optionalText(PHONE_MAX),
      address: optionalText(ADDRESS_MAX),
      city: optionalText(CITY_MAX),
      notes: optionalText(CUSTOMER_NOTES_MAX),
      openingAmount: moneyText(minorDigits),
      openingSide: z.enum(['DUE', 'ADVANCE']),
      openingDate: z.string()
    })
    .transform((values, ctx): CustomerDraft => {
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
        shopName: values.shopName,
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

export function toCustomerCreateInput(
  draft: CustomerDraft,
  minorDigits: number
): CustomerCreateInput {
  return { ...draft, currencyMinorDigits: minorDigits }
}

export function toCustomerUpdateInput(id: number, draft: CustomerDraft): CustomerUpdateInput {
  return {
    id,
    name: draft.name,
    shopName: draft.shopName,
    phone: draft.phone,
    address: draft.address,
    city: draft.city,
    notes: draft.notes
  }
}

/** The opening balance as it will be saved (positive Due, negative Advance, 0 none); null while the amount is not valid. */
export function openingBalancePreview(
  values: Pick<CustomerFormValues, 'openingAmount' | 'openingSide'>,
  minorDigits: number
): number | null {
  if (values.openingAmount.trim() === '') return 0
  const parsed = parseMoney(values.openingAmount, { minorDigits })
  if (!parsed.ok) return null
  return values.openingSide === 'DUE' ? parsed.value : -parsed.value
}

const FIELDS: Readonly<Record<string, string>> = {
  name: 'name',
  shopName: 'shopName',
  phone: 'phone',
  address: 'address',
  city: 'city',
  notes: 'notes',
  'opening.amountMinor': 'openingAmount',
  'opening.side': 'openingSide',
  'opening.date': 'openingDate'
}

/** The main process's field errors as [form path, message] pairs; anything else goes to `root`. */
export function serverCustomerErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Array<[string, string]> {
  return fieldPairs(fieldErrors, FIELDS)
}

export function fieldPairs(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined,
  fields: Readonly<Record<string, string>>
): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const [path, messages] of Object.entries(fieldErrors ?? {})) {
    for (const message of messages) pairs.push([fields[path] ?? 'root', message])
  }
  return pairs
}
