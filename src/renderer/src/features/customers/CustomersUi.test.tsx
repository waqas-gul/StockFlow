import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { Customer, CustomerLedger, CustomerListItem, LedgerRow } from '@shared/customers'
import type { SettingsView } from '@shared/settings'
import { queryKeys } from '@renderer/lib/query-keys'
import { BalanceAdjustmentForm } from './BalanceAdjustmentDialog'
import { CustomerDetailView } from './CustomerDetailPage'
import { CustomerForm } from './CustomerFormDialog'
import { CUSTOMERS_PAGE_SIZE, CustomersPage } from './CustomersPage'

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

const item: CustomerListItem = {
  id: 2,
  code: 'C-00002',
  name: 'Ali Raza',
  shopName: 'Ali Traders',
  phone: '0300-1234567',
  city: 'Lahore',
  isActive: true,
  balanceMinor: 300000
}

const customer: Customer = {
  ...item,
  address: 'Main Bazar',
  notes: 'Pays on Fridays',
  latestEntryDate: '2026-09-12',
  createdAt: '2026-09-10T10:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z'
}

function row(overrides: Partial<LedgerRow>): LedgerRow {
  return {
    id: 1,
    entryDate: '2026-09-10',
    type: 'OPENING',
    amountMinor: 500000,
    runningBalanceMinor: 500000,
    paymentId: null,
    paymentNo: null,
    paymentMethod: null,
    paymentReference: null,
    paymentStatus: null,
    invoiceId: null,
    invoiceNo: null,
    note: null,
    createdAt: '2026-09-10T10:00:00.000Z',
    ...overrides
  }
}

const ledger: CustomerLedger = {
  customer,
  total: 4,
  page: 1,
  pageSize: 50,
  rows: [
    row({}),
    row({
      id: 2,
      entryDate: '2026-09-12',
      type: 'PAYMENT',
      amountMinor: -600000,
      runningBalanceMinor: -100000,
      paymentId: 7,
      paymentNo: 'RCP-000001',
      paymentMethod: 'CASH',
      paymentStatus: 'VOID'
    }),
    row({
      id: 3,
      entryDate: '2026-09-12',
      type: 'PAYMENT_VOID',
      amountMinor: 600000,
      runningBalanceMinor: 500000,
      paymentId: 7,
      paymentNo: 'RCP-000001',
      note: 'Cheque bounced'
    }),
    row({
      id: 4,
      entryDate: '2026-09-12',
      type: 'ADJUSTMENT',
      amountMinor: -200000,
      runningBalanceMinor: 300000,
      note: 'Discount agreed'
    })
  ]
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

describe('Customers page', () => {
  it('lists customers with code, shop, phone, city, balance meaning, status and actions', () => {
    const queryClient = client()
    queryClient.setQueryData(
      queryKeys.customers.list({
        page: 1,
        pageSize: CUSTOMERS_PAGE_SIZE,
        search: '',
        status: 'active'
      }),
      {
        items: [
          item,
          {
            ...item,
            id: 1,
            code: 'C-00001',
            name: 'Cash / Walk-in',
            shopName: null,
            phone: null,
            city: null,
            balanceMinor: 0
          },
          { ...item, id: 3, code: 'C-00003', name: 'Bilal', balanceMinor: -75000, isActive: false }
        ],
        total: 3,
        page: 1,
        pageSize: CUSTOMERS_PAGE_SIZE
      }
    )
    const html = render(<CustomersPage />, queryClient)
    const shown = text(html)
    for (const expected of [
      'Customers',
      'Add Customer',
      'Code Customer Shop Phone City Balance Status Actions',
      'C-00002 Ali Raza Ali Traders 0300-1234567 Lahore Rs 3,000.00 Due Active View Edit Deactivate',
      'C-00001 Cash / Walk-in — — — Settled Active View Edit Deactivate',
      'C-00003 Bilal Ali Traders 0300-1234567 Lahore Rs 750.00 Advance Inactive View Edit Reactivate',
      'Showing 1–3 of 3'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(html).toContain('placeholder="Search by code, name, shop, phone or city"')
  })
})

describe('Customer form', () => {
  it('Add asks for the profile and an opening balance without signs: owes us or advance, and its date', () => {
    const html = render(
      <CustomerForm customer={null} currency={RS} today={TODAY} onSaved={noop} onCancel={noop} />
    )
    const shown = text(html)
    for (const expected of [
      'Name',
      'Shop Name',
      'Phone',
      'Address',
      'City',
      'Notes',
      'Opening Balance',
      'Amount',
      'Customer owes us',
      'Customer advance',
      'Opening date',
      'No opening balance.',
      'Save Customer'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(html).toMatch(/<input[^>]*type="date"/)
    expect(shown).not.toMatch(/paisa|minor|negative/i)
  })

  it('Edit changes the profile only and explains how to correct a balance', () => {
    const shown = text(
      render(
        <CustomerForm
          customer={customer}
          currency={RS}
          today={TODAY}
          onSaved={noop}
          onCancel={noop}
        />
      )
    )
    expect(shown).toContain('Save Changes')
    expect(shown).toContain(
      'The opening balance cannot be changed here. Use Adjust Balance on the customer page.'
    )
    expect(shown).not.toMatch(/Customer owes us|Opening date/)
  })
})

describe('Customer detail', () => {
  function detail(target: Customer, rows: CustomerLedger | undefined = ledger): string {
    return text(
      render(
        <CustomerDetailView
          customer={target}
          ledger={rows}
          currency={RS}
          busy={false}
          onPage={noop}
          onReceivePayment={noop}
          onAdjustBalance={noop}
          onEdit={noop}
          onToggleActive={noop}
          onOpenPayment={noop}
        />
      )
    )
  }

  it('shows the profile, the balance meaning, the actions and the running ledger', () => {
    const shown = detail(customer)
    for (const expected of [
      'Ali Raza',
      'C-00002',
      'Ali Traders',
      'Active',
      'Rs 3,000.00 Due',
      'The customer owes the shop.',
      'Receive Payment',
      'Adjust Balance',
      'Edit Customer',
      'Deactivate',
      'Date Type Reference Increase (owes more) Decrease (owes less) Balance',
      '10-Sep-2026 Opening balance (due) Rs 5,000.00 Rs 5,000.00 Due',
      '12-Sep-2026 Payment received · Cash (voided) RCP-000001 Rs 6,000.00 Rs 1,000.00 Advance',
      '12-Sep-2026 Payment voided Cheque bounced RCP-000001 Rs 6,000.00 Rs 5,000.00 Due',
      '12-Sep-2026 Balance adjustment Discount agreed Rs 2,000.00 Rs 3,000.00 Due',
      'Showing 1–4 of 4'
    ]) {
      expect(shown).toContain(expected)
    }
  })

  it('an inactive customer keeps its history; a new payment needs reactivation, a correction does not', () => {
    const html = render(
      <CustomerDetailView
        customer={{ ...customer, isActive: false, balanceMinor: 0 }}
        ledger={{ ...ledger, total: 0, rows: [] }}
        currency={RS}
        busy={false}
        onPage={noop}
        onReceivePayment={noop}
        onAdjustBalance={noop}
        onEdit={noop}
        onToggleActive={noop}
        onOpenPayment={noop}
      />
    )
    const shown = text(html)
    expect(shown).toContain('Inactive')
    expect(shown).toContain('Settled')
    expect(shown).toContain('This customer is inactive.')
    expect(shown).toContain('Reactivate')
    expect(shown).toContain('No account entries yet.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Receive Payment/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Adjust Balance/)
  })
})

describe('Adjust Balance form', () => {
  it('asks increase or decrease in plain words, with the amount, date, reason and the current balance', () => {
    const shown = text(
      render(
        <BalanceAdjustmentForm
          customer={{ ...customer, isActive: false }}
          currency={RS}
          today={TODAY}
          onSaved={noop}
          onCancel={noop}
        />
      )
    )
    for (const expected of [
      'Current balance Rs 3,000.00 Due',
      'Increase — the customer owes more',
      'Decrease — the customer owes less',
      'Amount',
      'Date',
      'Earliest allowed: 12-Sep-2026',
      'Reason',
      'Balance after —',
      'This customer is inactive. The correction is recorded; the customer stays inactive.',
      'Save Adjustment'
    ]) {
      expect(shown).toContain(expected)
    }
  })
})
