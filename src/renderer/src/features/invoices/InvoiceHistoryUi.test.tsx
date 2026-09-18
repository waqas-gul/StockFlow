import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { ListPage } from '@shared/customers'
import type { InvoiceDetail, InvoiceSummary } from '@shared/invoices'
import type { SettingsView } from '@shared/settings'
import { queryKeys } from '@renderer/lib/query-keys'
import { DispatchForm } from './DispatchDialog'
import { InvoiceDetailView } from './InvoiceDetailPage'
import { INVOICES_PAGE_SIZE, InvoiceHistoryPage } from './InvoiceHistoryPage'
import { invoiceDetail } from './invoice-test-data'
import { VoidInvoiceForm } from './VoidInvoiceDialog'

const RS = { minorDigits: 2, symbol: 'Rs' }

const settings: SettingsView = {
  values: {
    'business.name': 'StockFlow',
    'business.address': '',
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
  },
  currencyLocked: true,
  startNumberLocked: false
}

function summary(overrides: Partial<InvoiceSummary>): InvoiceSummary {
  return {
    id: 1,
    invoiceNo: 'INV-000001',
    invoiceDate: '2026-09-12',
    customerId: 2,
    customerCode: 'C-00002',
    customerName: 'Ali Raza',
    customerShopName: 'Ali Traders',
    totalMinor: 522_000,
    receivedMinor: 100_000,
    netOutstandingMinor: 472_000,
    status: 'POSTED',
    ...overrides
  }
}

function render(node: React.ReactNode, queryClient = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  )
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

const noop = (): void => undefined
const never = (): Promise<never> => new Promise(() => undefined)

describe('Invoice History', () => {
  it('lists invoices with number, date, customer, shop, total, received, outstanding, status and View', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.settings, settings)
    const page: ListPage<InvoiceSummary> = {
      items: [
        summary({ id: 3, invoiceNo: 'INV-000003', invoiceDate: '2026-09-14' }),
        summary({
          id: 2,
          invoiceNo: 'INV-000002',
          customerCode: 'C-00001',
          customerName: 'Cash / Walk-in',
          customerShopName: null,
          totalMinor: 44_000,
          receivedMinor: 44_000,
          netOutstandingMinor: 0,
          status: 'VOID'
        }),
        summary({ netOutstandingMinor: -5_000 })
      ],
      total: 3,
      page: 1,
      pageSize: INVOICES_PAGE_SIZE
    }
    queryClient.setQueryData(
      queryKeys.invoices.list({
        page: 1,
        pageSize: INVOICES_PAGE_SIZE,
        search: '',
        status: 'all',
        dateFrom: null,
        dateTo: null
      }),
      page
    )
    const html = render(<InvoiceHistoryPage />, queryClient)
    const shown = text(html)
    for (const expected of [
      'Invoice History',
      'New Invoice',
      'From',
      'To',
      'Invoice No Date Customer Shop Total Received Outstanding Status Actions',
      'INV-000003 14-Sep-2026 Ali Raza C-00002 Ali Traders Rs 5,220.00 Rs 1,000.00 Rs 4,720.00 Due Posted View',
      'INV-000002 12-Sep-2026 Cash / Walk-in C-00001 — Rs 440.00 Rs 440.00 Settled Void View',
      'INV-000001 12-Sep-2026 Ali Raza C-00002 Ali Traders Rs 5,220.00 Rs 1,000.00 Rs 50.00 Advance Posted View',
      'Showing 1–3 of 3'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(html).toContain(
      'placeholder="Search by invoice no, invoice code, customer, customer code or shop"'
    )
    expect(html).toContain('aria-label="Status"')
    expect(html).toContain('href="/invoices/3"')
    expect(html).toContain('href="/invoices/new"')
  })
})

describe('Invoice detail', () => {
  function detail(invoice: InvoiceDetail): { html: string; shown: string } {
    const html = render(
      <InvoiceDetailView
        invoice={invoice}
        currency={RS}
        onEditDispatch={noop}
        onVoid={noop}
        onOpenPayment={noop}
      />
    )
    return { html, shown: text(html) }
  }

  it('shows the saved header, customer, dispatch, items, payment and totals', () => {
    const { html, shown } = detail(invoiceDetail())
    for (const expected of [
      'INV-000001 Posted',
      'Date 12-Sep-2026',
      'Price tier Retail',
      'Invoice Code B-17',
      'Checked By Waqas',
      'Notes Deliver before noon',
      'Invoice total Rs 5,220.00',
      'Customer As saved on the invoice. Name Ali Raza C-00002 Shop Ali Traders Phone 0300-1234567 City Lahore Address Main Bazar',
      'Dispatch As saved on the invoice. Edit Dispatch Bilty No BL-221 Transport Daewoo Cargo Adda —',
      '# Product Packing Quantity and price Free scheme Gross Discount Scheme Net Ctn',
      '1 P-001 Tea 950g Tapal 1*12*18 2 Box × Rs 2,400.00 = Rs 4,800.00 5 Piece × Rs 110.00 = Rs 550.00 3 Piece Rs 5,350.00 Rs 267.50 (5%) Rs 10.00 Rs 5,072.50 2',
      'Payment received with the invoice Payment No RCP-000001 Amount Rs 1,000.00 Method Bank Status Posted',
      'Gross Rs 5,350.00',
      'Line Discounts Rs 267.50',
      'Scheme Discounts Rs 10.00',
      'Extra Discount Rs 2.50',
      'Net Invoice Rs 5,070.00',
      'Freight Rs 150.00',
      'Total Rs 5,220.00',
      'Previous Balance Rs 500.00 Due',
      'Received Rs 1,000.00',
      'Net Outstanding Rs 4,720.00 Due',
      'Void Invoice…'
    ]) {
      expect(shown).toContain(expected)
    }
    // The frozen cost is internal: inside a closed disclosure, not in the totals.
    expect(html).toMatch(
      /<details[^>]*>\s*<summary[^>]*>Internal<\/summary>.*Rs 5,600\.00.*<\/details>/s
    )
    expect(html).not.toMatch(/<details[^>]*open/)
    expect(shown).not.toMatch(/\bEdit Invoice\b|\bDelete\b/)
  })

  it('a void invoice shows when and why, and offers neither Edit Dispatch nor Void', () => {
    const { shown } = detail(
      invoiceDetail({
        status: 'VOID',
        voidDate: '2026-09-16',
        voidReason: 'Wrong customer',
        voidedAt: '2026-09-16T05:00:00.000Z'
      })
    )
    expect(shown).toContain('INV-000001 Void')
    expect(shown).toContain(
      'Voided on 16-Sep-2026: Wrong customer. Its goods went back into stock at their original cost and its account entry was reversed on that date.'
    )
    expect(shown).not.toContain('Edit Dispatch')
    expect(shown).not.toContain('Void Invoice')
  })

  it('shows a counter payment voided on its own as VOID, and an invoice without payment', () => {
    const base = invoiceDetail()
    const voided = detail({ ...base, payment: { ...base.payment!, status: 'VOID' } }).shown
    expect(voided).toContain('Payment No RCP-000001 Amount Rs 1,000.00 Method Bank Status Void')
    expect(voided).toContain('The payment has been voided')
    expect(voided).toContain('Received Rs 1,000.00')

    const unpaid = detail(invoiceDetail({ payment: null, receivedMinor: 0 })).shown
    expect(unpaid).toContain('No payment was received with this invoice.')
  })

  it('lists the dispatch change log', () => {
    const { shown } = detail(
      invoiceDetail({
        biltyNo: 'BL-222',
        dispatchUpdatedAt: '2026-09-16T05:00:00.000Z',
        changes: [
          {
            id: 1,
            field: 'bilty_no',
            oldValue: 'BL-221',
            newValue: 'BL-222',
            changedAt: '2026-09-16T05:00:00.000Z',
            note: 'Bilty reissued'
          },
          {
            id: 2,
            field: 'adda_name',
            oldValue: null,
            newValue: 'Badami Bagh',
            changedAt: '2026-09-16T05:00:00.000Z',
            note: null
          }
        ]
      })
    )
    expect(shown).toContain('Last changed')
    expect(shown).toMatch(
      /Change log .* Bilty No : BL-221 → BL-222 · Bilty reissued .* Adda : \(blank\) → Badami Bagh/
    )
  })
})

describe('Void Invoice confirmation', () => {
  function form(invoice: InvoiceDetail): { html: string; shown: string } {
    const html = render(
      <VoidInvoiceForm
        invoice={invoice}
        currency={RS}
        onConfirm={never}
        onVoided={noop}
        onClose={noop}
      />
    )
    return { html, shown: text(html) }
  }

  it('shows the invoice number, customer and total, and warns that the payment stays as credit', () => {
    const { html, shown } = form(invoiceDetail())
    for (const expected of [
      'Invoice INV-000001',
      'Date 12-Sep-2026',
      'Customer C-00002 Ali Raza (Ali Traders)',
      'Total Rs 5,220.00',
      "This invoice has a payment of Rs 1,000.00. Voiding the invoice will keep that payment on the customer's account as credit. Void the payment separately if the money was also returned.",
      'Reason for voiding',
      'Cancel',
      'Void INV-000001'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(shown).not.toContain('was returned')
    // Nothing is sent without a reason.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Void INV-000001/)
  })

  it('a walk-in invoice asks to confirm the money was returned', () => {
    const { html, shown } = form(
      invoiceDetail({
        customerCode: 'C-00001',
        customerName: 'Cash / Walk-in',
        customerShopName: null
      })
    )
    expect(shown).toContain('Customer C-00001 Cash / Walk-in')
    expect(shown).toContain('The walk-in account stays at zero')
    expect(shown).toContain('The money (Rs 1,000.00) was returned to the customer')
    expect(html).toContain('id="invoice-void-money-returned"')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Void INV-000001/)
  })

  it('an invoice without a posted payment has no payment warning', () => {
    const { shown } = form(invoiceDetail({ payment: null, receivedMinor: 0 }))
    expect(shown).not.toMatch(/payment of|money/)
  })
})

describe('Dispatch form', () => {
  it('offers only Bilty No, Transport and Adda, filled in, with a note for the change', () => {
    const html = render(
      <DispatchForm invoice={invoiceDetail()} onSave={never} onSaved={noop} onClose={noop} />
    )
    const shown = text(html)
    expect(shown).toContain('Bilty No Transport Adda Note for this change (optional)')
    expect(shown).toContain('Save Dispatch Details')
    expect(html).toContain('value="BL-221"')
    expect(html).toContain('value="Daewoo Cargo"')
    expect(html.match(/<input/g)).toHaveLength(4)
  })
})
