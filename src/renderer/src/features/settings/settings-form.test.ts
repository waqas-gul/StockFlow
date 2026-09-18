import { describe, expect, it } from 'vitest'
import type { EditableSettings } from '@shared/settings'
import {
  formFieldErrors,
  invoiceNumberPreview,
  settingsFormSchema,
  toFormValues,
  toSettingsPatch,
  type SettingsFormValues
} from './settings-form'

const SETTINGS: EditableSettings = {
  'business.name': 'Ali Traders',
  'business.address': 'Shop 12, Main Bazar, Mingora',
  'salesman.name': 'Mansoor Iqbal',
  'salesman.phone1': '03179927633',
  'salesman.phone2': '03463820629',
  'currency.code': 'PKR',
  'currency.symbol': 'Rs',
  'currency.minorDigits': 2,
  'invoice.prefix': 'INV-',
  'invoice.padding': 6,
  'invoice.startNumber': 1,
  'invoice.paperSize': 'A4'
}

const VALUES: SettingsFormValues = {
  businessName: 'Ali Traders',
  businessAddress: 'Shop 12, Main Bazar, Mingora',
  salesmanName: 'Mansoor Iqbal',
  salesmanPhone1: '03179927633',
  salesmanPhone2: '03463820629',
  currencyCode: 'PKR',
  currencySymbol: 'Rs',
  minorDigits: 2,
  invoicePrefix: 'INV-',
  invoicePadding: 6,
  invoiceStartNumber: 1,
  paperSize: 'A4'
}

function messages(values: Partial<SettingsFormValues>): Record<string, string[] | undefined> {
  const result = settingsFormSchema.safeParse({ ...VALUES, ...values })
  if (result.success) return {}
  const errors: Record<string, string[]> = {}
  for (const issue of result.error.issues)
    (errors[String(issue.path[0])] ??= []).push(issue.message)
  return errors
}

describe('the Settings form', () => {
  it('shows each setting in its own field', () => {
    expect(toFormValues(SETTINGS)).toEqual(VALUES)
  })

  it('accepts valid values, trimming text and writing the currency code in capitals', () => {
    expect(
      settingsFormSchema.parse({
        ...VALUES,
        businessName: '  Ali  ',
        businessAddress: '  Shop 1  ',
        salesmanName: ' Imran ',
        salesmanPhone2: '   ',
        currencyCode: ' usd '
      })
    ).toEqual({
      ...VALUES,
      businessName: 'Ali',
      businessAddress: 'Shop 1',
      salesmanName: 'Imran',
      salesmanPhone2: '',
      currencyCode: 'USD'
    })
  })

  it('uses the plain-language messages of the main process rules', () => {
    expect(messages({ businessName: '  ' })).toEqual({ businessName: ['Enter the shop name.'] })
    expect(messages({ businessAddress: 'Main Bazar\nMingora' })).toEqual({
      businessAddress: ['Use a single line of text.']
    })
    expect(messages({ salesmanName: '' })).toEqual({ salesmanName: ['Enter the salesman name.'] })
    expect(messages({ salesmanPhone1: '0'.repeat(41) })).toEqual({
      salesmanPhone1: ['Use at most 40 characters.']
    })
    expect(messages({ currencyCode: 'RUPEE' })).toEqual({
      currencyCode: ['Use a three-letter currency code, such as PKR.']
    })
    expect(messages({ minorDigits: Number.NaN })).toEqual({
      minorDigits: ['Enter a whole number from 0 to 4.']
    })
    expect(messages({ invoicePadding: 11 })).toEqual({
      invoicePadding: ['Enter a whole number from 1 to 10.']
    })
    expect(messages({ paperSize: 'Letter' as 'A4' })).toEqual({ paperSize: ['Choose A4 or A5.'] })
  })

  it('has no negative-stock setting', () => {
    expect(Object.keys(VALUES).some((field) => /negative|stock/i.test(field))).toBe(false)
  })

  it('sends only the fields that were changed, as settings', () => {
    expect(
      toSettingsPatch(
        { ...VALUES, businessName: 'New name', salesmanPhone2: '', paperSize: 'A5' },
        { businessName: true, salesmanPhone2: true, paperSize: true, currencyCode: false }
      )
    ).toEqual({ 'business.name': 'New name', 'salesman.phone2': '', 'invoice.paperSize': 'A5' })
    expect(toSettingsPatch(VALUES, {})).toEqual({})
  })

  it("shows the main process's field errors under the matching fields", () => {
    expect(
      formFieldErrors({
        'business.name': ['Enter the shop name.', 'second'],
        'salesman.name': ['Enter the salesman name.'],
        'invoice.padding': ['Enter a whole number from 1 to 10.'],
        root: ['Unrecognized key']
      })
    ).toEqual({
      businessName: 'Enter the shop name.',
      salesmanName: 'Enter the salesman name.',
      invoicePadding: 'Enter a whole number from 1 to 10.'
    })
    expect(formFieldErrors(undefined)).toEqual({})
  })

  it('previews the first invoice number', () => {
    expect(invoiceNumberPreview('INV-', 6, 1)).toBe('INV-000001')
    expect(invoiceNumberPreview('', 3, 42)).toBe('042')
    expect(invoiceNumberPreview('SF.', 2, 12345)).toBe('SF.12345')
    expect(invoiceNumberPreview('INV /', 6, 1)).toBeNull()
    expect(invoiceNumberPreview('INV-', Number.NaN, 1)).toBeNull()
    expect(invoiceNumberPreview('INV-', 6, 0)).toBeNull()
  })
})
