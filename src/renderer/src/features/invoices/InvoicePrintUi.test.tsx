import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { PrintableInvoice } from '@shared/invoice-print'
import { queryKeys } from '@renderer/lib/query-keys'
import { InvoiceDetailView } from './InvoiceDetailPage'
import { InvoicePrintDocument } from './InvoicePrintDocument'
import { InvoicePrintPage, InvoicePrintToolbar } from './InvoicePrintPage'
import { invoiceDetail, printableInvoice } from './invoice-test-data'

const noop = (): void => undefined

function text(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function printed(
  invoice: PrintableInvoice,
  paperSize = invoice.paperSize
): { html: string; shown: string } {
  const html = renderToStaticMarkup(
    <InvoicePrintDocument invoice={invoice} paperSize={paperSize} />
  )
  return { html, shown: text(html) }
}

describe('the printed invoice', () => {
  it('prints the header, customer and dispatch details as saved', () => {
    const { html, shown } = printed(printableInvoice())
    expect(html).toContain('data-print-document=""')
    expect(html).toContain('data-invoice-no="INV-000001"')
    expect(shown).toContain(
      'Madina Traders Shop 4, Circular Road, Lahore Salesman: Hamid Ali Phone: 0300-7654321 / 0345-1112223 ' +
        'INVOICE Invoice No INV-000001 Date 12-Sep-2026 Invoice Code IC-7'
    )
    expect(shown).toContain(
      'Bill To Customer Ali Raza Shop Name Ali Traders Contact 0300-1234567 Address Main Bazar City Lahore'
    )
    expect(shown).toContain(
      'Dispatch Bilty Number BL-1 Transport Service Daewoo Cargo Adda Name Badami Bagh'
    )
  })

  it('prints the shop, address and salesman saved with the invoice at the top, next to the invoice number', () => {
    const { html } = printed(printableInvoice())
    const seller = /<div class="ip-seller">([\s\S]*?)<\/div>/.exec(html)
    expect(seller).not.toBeNull()
    expect(seller![1]).toBe(
      '<p class="ip-business">Madina Traders</p>' +
        '<p class="ip-address">Shop 4, Circular Road, Lahore</p>' +
        '<p class="ip-salesman">Salesman: <span class="ip-strong">Hamid Ali</span></p>' +
        '<p class="ip-salesman">Phone: 0300-7654321 / 0345-1112223</p>'
    )
  })

  it('prints only the salesman phones that were saved, and no phone line without one', () => {
    const one = printed(
      printableInvoice({ salesman: { name: 'Hamid Ali', phone1: null, phone2: '0345-1112223' } })
    ).shown
    expect(one).toContain('Salesman: Hamid Ali Phone: 0345-1112223 INVOICE')
    const none = printed(
      printableInvoice({
        businessAddress: null,
        salesman: { name: 'Hamid Ali', phone1: null, phone2: null }
      })
    ).shown
    expect(none).toContain('Madina Traders Salesman: Hamid Ali INVOICE')
    expect(none).not.toContain('Phone')
  })

  it('prints an invoice posted before the shop and salesman were kept as it always did: the shop name only', () => {
    const { html, shown } = printed(printableInvoice({ businessAddress: null, salesman: null }))
    expect(shown).toContain('Madina Traders INVOICE Invoice No INV-000001 Date 12-Sep-2026')
    expect(shown).not.toContain('Salesman')
    expect(shown).not.toContain('Phone')
    expect(html).not.toContain('ip-address')
  })

  it('prints each line with its saved packing, quantities, prices, discount, Ctn, Sch and free goods', () => {
    const { shown } = printed(printableInvoice())
    expect(shown).toContain(
      '# Product Packing Quantity Price Gross Amount Discount Ctn Sch Net Amount'
    )
    // Box + Piece on one line, each quantity with the price charged for it; 3 Pc free under Sch.
    expect(shown).toContain(
      '1 Tea 950g 1*12*18 2 Box 5 Pc 2,400.00 110.00 5,350.00 267.50 5% 2 100.00 Free 3 Pc 4,982.50'
    )
    expect(shown).toContain('2 Sugar 10 Kg 160.00 1,600.00 50.00 1,550.00')
    expect(shown).toContain('Amounts in Rs')
  })

  it('prints the stored totals, the total in words, Checked By and a signature line', () => {
    const { shown } = printed(printableInvoice())
    expect(shown).toContain(
      'Amount in Words Rupees Six Thousand Seven Hundred Only ' +
        'Gross Amount 6,950.00 Discount 317.50 Scheme 100.00 Extra Discount 32.50 ' +
        'Current Invoice 6,500.00 Freight 200.00 Invoice Total 6,700.00 ' +
        'Previous Balance 1,000.00 Received 2,000.00 Net Outstanding 5,700.00'
    )
    expect(shown).toContain('Checked By Hamid Signature')
    expect(shown).not.toContain('VOID')
  })

  it('prints nothing the invoice document does not show: no codes, costs, notes or payment status', () => {
    const { shown } = printed(printableInvoice())
    for (const hidden of ['P-001', 'C-00002', 'Cost', 'Internal', 'RCP-', 'Posted', 'Retail']) {
      expect(shown).not.toContain(hidden)
    }
  })

  it('sets the A4 or A5 page for the chosen paper', () => {
    const a4 = printed(printableInvoice(), 'A4').html
    expect(a4).toContain('data-paper-size="A4"')
    expect(a4).toContain('size: A4 portrait;')
    const a5 = printed(printableInvoice(), 'A5').html
    expect(a5).toContain('data-paper-size="A5"')
    expect(a5).toContain('size: A5 portrait;')
    expect(a5).not.toContain('size: A4')
  })

  it('makes a void invoice unmistakable, with its void date and reason, and keeps its saved contents', () => {
    const { html, shown } = printed(
      printableInvoice({
        status: 'VOID',
        voidDate: '2026-09-17',
        voidReason: 'Customer returned the goods'
      })
    )
    expect(html).toContain('<div class="ip-watermark" aria-hidden="true">VOID</div>')
    expect(html).toContain('data-status="VOID"')
    expect(shown).toContain(
      'VOID This invoice was voided on 17-Sep-2026. Reason: Customer returned the goods'
    )
    expect(shown).toContain('Invoice No INV-000001')
    expect(shown).toContain('Received 2,000.00 Net Outstanding 5,700.00')
  })

  it('hides empty customer details, leaves dispatch and Checked By blank to fill in, and drops empty columns', () => {
    const base = printableInvoice()
    const sugar = { ...base.lines[1], discountMinor: 0 }
    const { html, shown } = printed(
      printableInvoice({
        invoiceCode: null,
        customer: { name: 'Bilal', shopName: null, phone: null, address: null, city: null },
        dispatch: { biltyNo: null, transportName: null, addaName: null },
        checkedBy: null,
        lines: [sugar],
        totals: {
          grossMinor: 160_000,
          lineDiscountMinor: 0,
          lineSchemeMinor: 0,
          extraDiscountMinor: 0,
          netMinor: 160_000,
          freightMinor: 0,
          totalMinor: 160_000,
          previousBalanceMinor: -200_000,
          receivedMinor: 0,
          netOutstandingMinor: -40_000
        },
        amountInWords: 'Rupees One Thousand Six Hundred Only'
      })
    )
    expect(shown).toContain(
      'Invoice No INV-000001 Date 12-Sep-2026 Bill To Customer Bilal Dispatch'
    )
    expect(shown).not.toContain('Invoice Code')
    expect(shown).not.toContain('Shop Name')
    expect(shown).not.toContain('Contact')
    expect(shown).toContain('Dispatch Bilty Number Transport Service Adda Name')
    expect(html.match(/class="ip-blank"/g)).toHaveLength(3)
    expect(shown).toContain('# Product Packing Quantity Price Gross Amount Net Amount')
    expect(shown).toContain('2 Sugar 10 Kg 160.00 1,600.00 1,550.00')
    expect(shown).toContain(
      'Current Invoice 1,600.00 Freight 0.00 Invoice Total 1,600.00 ' +
        'Previous Balance 2,000.00 Advance Received 0.00 Net Outstanding 400.00 Advance'
    )
    expect(shown).not.toContain('Gross Amount 1,600.00')
    expect(shown).toContain('Checked By Signature')
  })
})

describe('the print preview', () => {
  function toolbar(props: Partial<React.ComponentProps<typeof InvoicePrintToolbar>> = {}): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <InvoicePrintToolbar
          invoiceId={1}
          invoiceNo="INV-000001"
          paperSize="A5"
          defaultPaperSize="A4"
          busy={null}
          onPaperSize={noop}
          onPrint={noop}
          onSavePdf={noop}
          {...props}
        />
      </MemoryRouter>
    )
  }

  it('offers the paper sizes, Save as PDF and Print, and a way back to the invoice, but no editing', () => {
    const html = toolbar()
    const shown = text(html)
    expect(shown).toContain('INV-000001 Print Preview')
    expect(html).toContain('href="/invoices/1"')
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>A4<\/button>/)
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>A5<\/button>/)
    expect(shown).toContain('Settings: A4')
    expect(shown).toContain('Save as PDF…')
    expect(shown).toContain('Print…')
    for (const editing of ['Edit', 'Void', 'Save Dispatch']) expect(shown).not.toContain(editing)
    expect(html).toContain('print:hidden')
  })

  it('disables every action while printing or saving', () => {
    const html = toolbar({ busy: 'pdf' })
    expect(text(html)).toContain('Saving PDF…')
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(4)
    expect(text(toolbar({ busy: 'print' }))).toContain('Printing…')
  })

  it('shows the invoice on the configured paper, without the app navigation', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.invoices.print(1), printableInvoice({ paperSize: 'A5' }))
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/invoices/1/print']}>
          <Routes>
            <Route path="/invoices/:invoiceId/print" element={<InvoicePrintPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
    expect(html).toContain('data-paper-size="A5"')
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>A5<\/button>/)
    expect(text(html)).toContain(
      'Madina Traders Shop 4, Circular Road, Lahore Salesman: Hamid Ali Phone: 0300-7654321 / 0345-1112223 INVOICE'
    )
    expect(html).not.toContain('<aside')
    expect(html).not.toContain('<nav')
  })
})

describe('Invoice Detail', () => {
  function detail(overrides: Parameters<typeof invoiceDetail>[0] = {}): string {
    return text(
      renderToStaticMarkup(
        <MemoryRouter>
          <InvoiceDetailView
            invoice={invoiceDetail(overrides)}
            currency={{ minorDigits: 2, symbol: 'Rs' }}
            onEditDispatch={noop}
            onVoid={noop}
            onOpenPayment={noop}
          />
        </MemoryRouter>
      )
    )
  }

  it('shows the shop and salesman saved with the invoice', () => {
    const shown = detail()
    expect(shown).toContain('Sold by Iftikhar and Arshad Traders Shop 12, Main Bazar, Mingora')
    expect(shown).toContain('Salesman Mansoor Iqbal 03179927633 / 03463820629')
    expect(shown).not.toContain('Not saved')
  })

  it('leaves out an address or phone that was not saved', () => {
    const shown = detail({
      business: {
        shopName: 'Iftikhar and Arshad Traders',
        shopAddress: null,
        salesmanName: 'Mansoor Iqbal',
        salesmanPhone1: null,
        salesmanPhone2: null
      }
    })
    expect(shown).toContain('Sold by Iftikhar and Arshad Traders Salesman Mansoor Iqbal')
  })

  it('says an invoice posted before the shop and salesman were kept has none, and invents nothing', () => {
    const shown = detail({ business: null })
    expect(shown).toContain(
      'Shop and salesman Not saved: this invoice was posted before StockFlow kept them.'
    )
    expect(shown).not.toContain('Sold by')
    expect(shown).not.toContain('Mansoor')
  })

  it.each(['POSTED', 'VOID'] as const)('a %s invoice offers Print Invoice', (status) => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InvoiceDetailView
          invoice={invoiceDetail(
            status === 'VOID'
              ? { status, voidDate: '2026-09-17', voidReason: 'Wrong customer', voidedAt: 'x' }
              : {}
          )}
          currency={{ minorDigits: 2, symbol: 'Rs' }}
          onEditDispatch={noop}
          onVoid={noop}
          onOpenPayment={noop}
        />
      </MemoryRouter>
    )
    expect(html).toMatch(/<a[^>]*href="\/invoices\/1\/print"[^>]*>.*Print Invoice<\/a>/)
  })
})
