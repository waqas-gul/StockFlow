import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EditableSettings } from '@shared/settings'
import { SettingsForm } from './SettingsForm'

const SETTINGS: EditableSettings = {
  'business.name': 'Ali Traders',
  'currency.code': 'PKR',
  'currency.symbol': 'Rs',
  'currency.minorDigits': 2,
  'invoice.prefix': 'INV-',
  'invoice.padding': 6,
  'invoice.startNumber': 1,
  'invoice.paperSize': 'A5'
}

/** Server-renders the form: no effects run and window.api is never called. */
function render(settings: EditableSettings = SETTINGS): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SettingsForm settings={settings} />
    </QueryClientProvider>
  )
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
      'Business name',
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

  it('previews the first invoice number and marks the saved paper size', () => {
    const html = render()
    expect(text(html)).toContain('First invoice number: INV-000001')
    expect(html).toMatch(/aria-checked="true"[^>]*value="A5"|value="A5"[^>]*aria-checked="true"/)
    expect(html).toMatch(/aria-checked="false"[^>]*value="A4"|value="A4"[^>]*aria-checked="false"/)
  })

  it('offers Save only once something was changed', () => {
    const html = render()
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>.*Save settings/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Discard changes/)
  })
})
