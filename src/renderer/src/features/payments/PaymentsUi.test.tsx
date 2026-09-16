import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { Customer } from '@shared/customers'
import type { PaymentDetail as PaymentDetailData, PaymentSummary } from '@shared/payments'
import type { SettingsView } from '@shared/settings'
import { queryKeys } from '@renderer/lib/query-keys'
import { DuplicatePaymentWarning } from './DuplicatePaymentWarning'
import { PaymentDetail } from './PaymentDetailDialog'
import { PaymentForm } from './PaymentForm'
import { PaymentPreviewPanel } from './PaymentPreviewPanel'
import { PAYMENTS_PAGE_SIZE, PaymentsPage } from './PaymentsPage'
import { voidConfirmationText } from './payment-display'

const RS = { minorDigits: 2, symbol: 'Rs' }
const TODAY = '2026-09-16'

const settings: SettingsView = {
  values: {
    'business.name': 'StockFlow',
    'currency.code': 'PKR',
    'currency.symbol': 'Rs',
    'currency.minorDigits': 2,
    'invoice.prefix': 'INV-',
    'invoice.padding': 6,
    'invoice.startNumber': 1,
    'invoice.paperSize': 'A4'
  },
  minorDigitsLocked: true
}

const customer: Customer = {
  id: 2,
  code: 'C-00002',
  name: 'Ali Raza',
  shopName: 'Ali Traders',
  phone: '0300-1234567',
  city: 'Lahore',
  isActive: true,
  balanceMinor: 100000,
  address: null,
  notes: null,
  latestEntryDate: '2026-09-12',
  createdAt: '2026-09-10T10:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z'
}

const summary: PaymentSummary = {
  id: 7,
  paymentNo: 'RCP-000001',
  paymentDate: '2026-09-14',
  customerId: 2,
  customerCode: 'C-00002',
  customerName: 'Ali Raza',
  shopName: 'Ali Traders',
  amountMinor: 400000,
  method: 'CHEQUE',
  reference: 'CHQ 4471',
  status: 'POSTED',
  createdAt: '2026-09-14T10:00:00.000Z'
}

const detail: PaymentDetailData = {
  ...summary,
  customerActive: true,
  note: 'Collected at the shop',
  voidReason: null,
  voidDate: null,
  voidedAt: null
}

function client(): QueryClient {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.settings, settings)
  return queryClient
}

function render(node: React.ReactNode, queryClient = client()): string {
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
    .replace(/\s+/g, ' ')
    .trim()
}

const noop = (): void => undefined

describe('Payments page', () => {
  it('lists payments with filters, and offers Void only for posted payments', () => {
    const queryClient = client()
    queryClient.setQueryData(
      queryKeys.payments.list({
        page: 1,
        pageSize: PAYMENTS_PAGE_SIZE,
        search: '',
        status: 'all',
        method: 'all',
        dateFrom: null,
        dateTo: null
      }),
      {
        items: [
          summary,
          {
            ...summary,
            id: 8,
            paymentNo: 'RCP-000002',
            method: 'CASH',
            reference: null,
            status: 'VOID'
          }
        ],
        total: 2,
        page: 1,
        pageSize: PAYMENTS_PAGE_SIZE
      }
    )
    const html = render(<PaymentsPage />, queryClient)
    const shown = text(html)
    for (const expected of [
      'Payments',
      'Receive Payment',
      'From',
      'To',
      'Payment No Date Customer Shop Method Reference Amount Status Actions',
      'RCP-000001 14-Sep-2026 Ali Raza C-00002 Ali Traders Cheque CHQ 4471 Rs 4,000.00 Posted View Void',
      'RCP-000002 14-Sep-2026 Ali Raza C-00002 Ali Traders Cash — Rs 4,000.00 Void View',
      'Showing 1–2 of 2'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(shown).not.toContain('Void View Void')
    expect(html).toContain('placeholder="Search by payment no, customer, shop or reference"')
  })
})

describe('Receive Payment', () => {
  it('shows the chosen customer, the current balance and every payment field', () => {
    const queryClient = client()
    queryClient.setQueryData(queryKeys.customers.detail(customer.id), customer)
    const html = render(
      <PaymentForm
        customer={customer}
        currency={RS}
        today={TODAY}
        onSaved={noop}
        onCancel={noop}
      />,
      queryClient
    )
    const shown = text(html)
    for (const expected of [
      'Customer',
      'C-00002 Ali Raza (Ali Traders)',
      'Date',
      'Earliest allowed: 12-Sep-2026',
      'Amount',
      'Method',
      'Reference',
      'Note',
      'Current balance Rs 1,000.00 Due',
      'Balance after —',
      'Save Payment'
    ]) {
      expect(shown).toContain(expected)
    }
  })

  it('previews an overpayment as an advance before saving', () => {
    const shown = text(
      render(<PaymentPreviewPanel balanceMinor={100000} amount="1,500" currency={RS} />)
    )
    expect(shown).toContain('Current balance Rs 1,000.00 Due')
    expect(shown).toContain('This payment Rs 1,500.00')
    expect(shown).toContain('Balance after Rs 500.00 Advance')
    expect(shown).toContain(
      'This payment is Rs 500.00 more than the customer owes. The extra is kept as an advance.'
    )
    const exact = text(
      render(<PaymentPreviewPanel balanceMinor={100000} amount="1000" currency={RS} />)
    )
    expect(exact).toContain('Balance after Settled')
    expect(exact).not.toContain('advance.')
  })

  it('warns about a possible duplicate, naming the payment, with Cancel and Continue', () => {
    const shown = text(
      render(
        <DuplicatePaymentWarning
          duplicates={[summary]}
          currency={RS}
          onCancel={noop}
          onContinue={noop}
        />
      )
    )
    expect(shown).toContain('A payment with the same customer, date and amount already exists.')
    expect(shown).toContain('RCP-000001 14-Sep-2026 Rs 4,000.00 Cheque')
    expect(shown).toContain('Cancel')
    expect(shown).toContain('Continue')
  })
})

describe('Payment detail', () => {
  it('shows the saved payment with Void and no Edit', () => {
    const shown = text(render(<PaymentDetail payment={detail} currency={RS} onClose={noop} />))
    for (const expected of [
      'Customer C-00002 Ali Raza (Ali Traders)',
      'Date 14-Sep-2026',
      'Amount Rs 4,000.00',
      'Method Cheque',
      'Reference CHQ 4471',
      'Note Collected at the shop',
      'Status Posted',
      'Reason for voiding',
      'Void Payment'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(shown).not.toMatch(/\bEdit\b/)
    expect(voidConfirmationText(detail, RS)).toBe(
      'Voiding RCP-000001 adds Rs 4,000.00 back to the balance of C-00002 Ali Raza. The payment stays in the history as void.'
    )
  })

  it('a void payment shows when and why, with no void action', () => {
    const shown = text(
      render(
        <PaymentDetail
          payment={{
            ...detail,
            status: 'VOID',
            voidDate: '2026-09-16',
            voidReason: 'Cheque bounced',
            voidedAt: '2026-09-16T11:00:00.000Z'
          }}
          currency={RS}
          onClose={noop}
        />
      )
    )
    expect(shown).toContain('Status Void')
    expect(shown).toContain('Voided on 16-Sep-2026')
    expect(shown).toContain('Void reason Cheque bounced')
    expect(shown).not.toContain('Void Payment')
  })
})
