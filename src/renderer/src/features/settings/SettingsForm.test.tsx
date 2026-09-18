import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EditableSettings } from '@shared/settings'
import { SettingsForm } from './SettingsForm'

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
  'invoice.paperSize': 'A5'
}

/** Server-renders the form: no effects run and window.api is never called. */
function render(
  settings: EditableSettings = SETTINGS,
  currencyLocked = false,
  startNumberLocked = false
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SettingsForm
        settings={settings}
        currencyLocked={currencyLocked}
        startNumberLocked={startNumberLocked}
      />
    </QueryClientProvider>
  )
}

function inputTag(html: string, id: string): string {
  const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)
  if (tag === null) throw new Error(`No input ${id}`)
  return tag[0]
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('SettingsForm', () => {
  it('has the Business, Currency and Invoice sections with their fields, and nothing else', () => {
    const shown = text(render())
    for (const expected of [
      'Business',
      'Shop name',
      'Shop address',
      'Salesman name',
      'Phone 1',
      'Phone 2',
      'Currency',
      'Currency code',
      'Currency symbol',
      'Minor digits',
      'Invoice',
      'Prefix',
      'Padding',
      'Starting number',
      'Paper size',
      'A4',
      'A5'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(shown).not.toMatch(/negative/i)
    expect(render()).not.toMatch(/type="file"/)
  })

  // The saved values reach these fields through toFormValues (settings-form.test.ts); React Hook Form fills them in
  // after mounting, so the server-rendered markup has none.
  it('lets the shop and salesman be edited at any time, and says a change only affects invoices posted afterwards', () => {
    const html = render(SETTINGS, true, true)
    for (const id of [
      'businessName',
      'businessAddress',
      'salesmanName',
      'salesmanPhone1',
      'salesmanPhone2'
    ]) {
      expect(inputTag(html, id)).not.toMatch(/readonly|disabled=""/i)
    }
    expect(inputTag(html, 'salesmanPhone1')).toContain('inputMode="tel"')
    expect(inputTag(html, 'businessAddress')).toContain('maxLength="200"')
    expect(text(html)).toContain(
      'Each invoice keeps the shop and salesman it was posted with: a change here applies to new invoices only.'
    )
  })

  it('previews the first invoice number and marks the saved paper size', () => {
    const html = render()
    expect(text(html)).toContain('First invoice number: INV-000001')
    expect(html).toMatch(/aria-checked="true"[^>]*value="A5"|value="A5"[^>]*aria-checked="true"/)
    expect(html).toMatch(/aria-checked="false"[^>]*value="A4"|value="A4"[^>]*aria-checked="false"/)
  })

  it('lets the currency and the starting number be edited while nothing locks them', () => {
    const html = render()
    for (const id of ['currencyCode', 'currencySymbol', 'minorDigits', 'invoiceStartNumber']) {
      expect(inputTag(html, id)).not.toMatch(/readonly/i)
    }
    expect(text(html)).not.toMatch(/Locked|cannot be changed/)
  })

  it('shows the currency code, symbol and decimal places read-only with the reason once financial data exists', () => {
    const html = render(SETTINGS, true)
    for (const id of ['currencyCode', 'currencySymbol', 'minorDigits']) {
      expect(inputTag(html, id)).toMatch(/readonly=""/i)
      expect(inputTag(html, id)).toMatch(/aria-readonly="true"/)
    }
    expect(text(html)).toContain(
      'Currency settings cannot be changed after financial data has been entered.'
    )
    expect(inputTag(html, 'invoiceStartNumber')).not.toMatch(/readonly/i)
  })

  it('shows the starting number read-only with the reason once invoice numbering has begun', () => {
    const html = render(SETTINGS, true, true)
    expect(inputTag(html, 'invoiceStartNumber')).toMatch(/readonly=""/i)
    expect(inputTag(html, 'invoiceStartNumber')).toMatch(/aria-readonly="true"/)
    expect(text(html)).toContain(
      'Starting number cannot be changed after invoice numbering has begun.'
    )
    expect(text(html)).not.toContain('First invoice number')
    for (const id of ['invoicePrefix', 'invoicePadding']) {
      expect(inputTag(html, id)).not.toMatch(/readonly/i)
    }
  })

  it('offers Save only once something was changed', () => {
    const html = render()
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>.*Save settings/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Discard changes/)
  })
})
