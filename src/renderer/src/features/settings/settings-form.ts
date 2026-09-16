import { z } from 'zod'
import {
  SETTING_SCHEMAS,
  type EditableSettingKey,
  type EditableSettings,
  type EditableSettingsPatch
} from '@shared/settings'

/**
 * The Settings form's fields and the setting each one edits. React Hook Form reads dots in field names as nesting, so
 * the form uses its own names.
 */
export const SETTINGS_FIELDS = {
  businessName: 'business.name',
  currencyCode: 'currency.code',
  currencySymbol: 'currency.symbol',
  minorDigits: 'currency.minorDigits',
  invoicePrefix: 'invoice.prefix',
  invoicePadding: 'invoice.padding',
  invoiceStartNumber: 'invoice.startNumber',
  paperSize: 'invoice.paperSize'
} as const satisfies Record<string, EditableSettingKey>

export type SettingsField = keyof typeof SETTINGS_FIELDS

const FIELD_ENTRIES = Object.entries(SETTINGS_FIELDS) as Array<[SettingsField, EditableSettingKey]>

/** The same rules the main process applies (it validates again); a currency code is accepted in any case. */
export const settingsFormSchema = z.object({
  businessName: SETTING_SCHEMAS['business.name'],
  currencyCode: z.string().trim().toUpperCase().pipe(SETTING_SCHEMAS['currency.code']),
  currencySymbol: SETTING_SCHEMAS['currency.symbol'],
  minorDigits: SETTING_SCHEMAS['currency.minorDigits'],
  invoicePrefix: SETTING_SCHEMAS['invoice.prefix'],
  invoicePadding: SETTING_SCHEMAS['invoice.padding'],
  invoiceStartNumber: SETTING_SCHEMAS['invoice.startNumber'],
  paperSize: SETTING_SCHEMAS['invoice.paperSize']
})

export type SettingsFormInput = z.input<typeof settingsFormSchema>
export type SettingsFormValues = z.output<typeof settingsFormSchema>

export function toFormValues(settings: EditableSettings): SettingsFormInput {
  return {
    businessName: settings['business.name'],
    currencyCode: settings['currency.code'],
    currencySymbol: settings['currency.symbol'],
    minorDigits: settings['currency.minorDigits'],
    invoicePrefix: settings['invoice.prefix'],
    invoicePadding: settings['invoice.padding'],
    invoiceStartNumber: settings['invoice.startNumber'],
    paperSize: settings['invoice.paperSize']
  }
}

/** The fields the user changed, as the settings update: unchanged settings are not written again. */
export function toSettingsPatch(
  values: SettingsFormValues,
  dirty: Partial<Readonly<Record<SettingsField, unknown>>>
): EditableSettingsPatch {
  const patch: Record<string, unknown> = {}
  for (const [field, key] of FIELD_ENTRIES) {
    if (dirty[field]) patch[key] = values[field]
  }
  return patch as EditableSettingsPatch
}

/** The main process's field errors (keyed by setting) as form field errors: the first message of each. */
export function formFieldErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Partial<Record<SettingsField, string>> {
  const errors: Partial<Record<SettingsField, string>> = {}
  for (const [field, key] of FIELD_ENTRIES) {
    const [message] = fieldErrors?.[key] ?? []
    if (message !== undefined) errors[field] = message
  }
  return errors
}

/** The number of the first invoice, e.g. `INV-000001`; null while the values are not valid. */
export function invoiceNumberPreview(
  prefix: string,
  padding: number,
  startNumber: number
): string | null {
  const valid =
    SETTING_SCHEMAS['invoice.prefix'].safeParse(prefix).success &&
    SETTING_SCHEMAS['invoice.padding'].safeParse(padding).success &&
    SETTING_SCHEMAS['invoice.startNumber'].safeParse(startNumber).success
  return valid ? `${prefix}${String(startNumber).padStart(padding, '0')}` : null
}
