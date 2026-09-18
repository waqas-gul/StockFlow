import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { ListPage } from '@shared/customers'
import type { SupplierBalancesReport } from '@shared/reports'
import type { SettingsView } from '@shared/settings'
import type { StockPage, StockReceiptDetail, StockReceiptSummary } from '@shared/stock'
import {
  RECEIPT_PAYMENTS_VOID_WARNING,
  type Supplier,
  type SupplierLedger,
  type SupplierListItem,
  type SupplierPaymentDetail,
  type SupplierPaymentSummary
} from '@shared/suppliers'
import { queryKeys } from '@renderer/lib/query-keys'
import { SupplierBalancesReportView } from '../reports/CurrentReportViews'
import { ReceiptDetail } from '../stock/ReceiptDetailDialog'
import { ReceiptForm } from '../stock/ReceiptForm'
import { SupplierPaymentForm, SupplierPaymentPreviewPanel } from './PaySupplierDialog'
import { SupplierAdjustmentForm } from './SupplierAdjustmentDialog'
import {
  SupplierDetailView,
  type SupplierDetailViewProps,
  type SupplierTab
} from './SupplierDetailPage'
import { SupplierForm } from './SupplierFormDialog'
import { SupplierPaymentDetailView } from './SupplierPaymentDetailDialog'
import { SUPPLIERS_PAGE_SIZE, SuppliersPage } from './SuppliersPage'

const RS = { minorDigits: 2, symbol: 'Rs' }
const TODAY = '2026-09-16'

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

const item: SupplierListItem = {
  id: 1,
  code: 'SUP-00001',
  name: 'ABC Distributors',
  contactPerson: 'Imran',
  phone: '0300-1112233',
  city: 'Lahore',
  isActive: true,
  balanceMinor: 4_000_000
}

const supplier: Supplier = {
  ...item,
  address: 'Circular Road',
  notes: 'Delivers on Mondays',
  latestEntryDate: '2026-09-12',
  totalPurchasesMinor: 8_000_000,
  purchaseCount: 2,
  totalPaidMinor: 4_500_000,
  paymentCount: 3,
  lastPurchaseDate: '2026-09-12',
  lastPaymentDate: '2026-09-16',
  productsPurchased: [
    {
      productId: 7,
      code: 'A-001',
      name: 'Product A',
      lastPurchaseDate: '2026-09-12',
      lastUnitCostMinor: 300_000,
      lastUnitName: 'Box',
      totalQtyBase: 200,
      totalQuantityText: '20 Box'
    }
  ],
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z'
}

const receipt: StockReceiptSummary = {
  id: 11,
  receiptNo: 'GRN-000011',
  receiptDate: '2026-09-10',
  supplierName: 'ABC Distributors',
  supplierId: 1,
  supplierCode: 'SUP-00001',
  supplierBillNo: 'ABC-101',
  reference: 'Truck 7',
  totalCostMinor: 5_000_000,
  status: 'POSTED',
  lineCount: 2,
  voidable: true,
  createdAt: '2026-09-10T10:00:00.000Z'
}

const payment: SupplierPaymentSummary = {
  id: 21,
  paymentNo: 'SPAY-000001',
  paymentDate: '2026-09-10',
  supplierId: 1,
  supplierCode: 'SUP-00001',
  supplierName: 'ABC Distributors',
  amountMinor: 2_000_000,
  method: 'BANK',
  reference: 'TT-55',
  status: 'POSTED',
  receiptId: 11,
  receiptNo: 'GRN-000011',
  createdAt: '2026-09-10T10:00:00.000Z'
}

const ledger: SupplierLedger = {
  supplier,
  total: 3,
  page: 1,
  pageSize: 50,
  rows: [
    {
      id: 1,
      entryDate: '2026-09-01',
      type: 'OPENING',
      amountMinor: 1_000_000,
      runningBalanceMinor: 1_000_000,
      receiptId: null,
      receiptNo: null,
      supplierBillNo: null,
      paymentId: null,
      paymentNo: null,
      paymentMethod: null,
      paymentStatus: null,
      note: null,
      createdAt: '2026-09-01T10:00:00.000Z'
    },
    {
      id: 2,
      entryDate: '2026-09-10',
      type: 'PURCHASE',
      amountMinor: 5_000_000,
      runningBalanceMinor: 6_000_000,
      receiptId: 11,
      receiptNo: 'GRN-000011',
      supplierBillNo: 'ABC-101',
      paymentId: null,
      paymentNo: null,
      paymentMethod: null,
      paymentStatus: null,
      note: null,
      createdAt: '2026-09-10T10:00:00.000Z'
    },
    {
      id: 3,
      entryDate: '2026-09-10',
      type: 'PAYMENT',
      amountMinor: -7_000_000,
      runningBalanceMinor: -1_000_000,
      receiptId: null,
      receiptNo: null,
      supplierBillNo: null,
      paymentId: 21,
      paymentNo: 'SPAY-000001',
      paymentMethod: 'BANK',
      paymentStatus: 'POSTED',
      note: null,
      createdAt: '2026-09-10T10:00:00.000Z'
    }
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
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

const noop = (): void => undefined

function detail(tab: SupplierTab, overrides: Partial<SupplierDetailViewProps> = {}): string {
  return text(
    render(
      <SupplierDetailView
        supplier={supplier}
        currency={RS}
        tab={tab}
        onTab={noop}
        busy={false}
        ledger={ledger}
        purchases={{
          items: [
            receipt,
            { ...receipt, id: 12, receiptNo: 'GRN-000012', status: 'VOID', voidable: false }
          ],
          total: 2,
          page: 1,
          pageSize: 25
        }}
        payments={{
          items: [
            payment,
            {
              ...payment,
              id: 22,
              paymentNo: 'SPAY-000002',
              receiptId: null,
              receiptNo: null,
              status: 'VOID',
              method: 'CASH',
              reference: null
            }
          ],
          total: 2,
          page: 1,
          pageSize: 25
        }}
        onLedgerPage={noop}
        onPurchasePage={noop}
        onPaymentPage={noop}
        onNewPurchase={noop}
        onPay={noop}
        onAdjust={noop}
        onEdit={noop}
        onToggleActive={noop}
        onOpenPayment={noop}
        onOpenReceipt={noop}
        {...overrides}
      />
    )
  )
}

describe('Suppliers page', () => {
  it('lists suppliers with Due, Advance or Settled, and offers Pay Supplier and Add Supplier', () => {
    const queryClient = client()
    const page: ListPage<SupplierListItem> = {
      items: [
        item,
        {
          ...item,
          id: 2,
          code: 'SUP-00002',
          name: 'PQR Foods',
          contactPerson: null,
          balanceMinor: -70_000
        },
        {
          ...item,
          id: 3,
          code: 'SUP-00003',
          name: 'STU Mills',
          phone: null,
          balanceMinor: 0,
          isActive: false
        }
      ],
      total: 3,
      page: 1,
      pageSize: SUPPLIERS_PAGE_SIZE
    }
    queryClient.setQueryData(
      queryKeys.suppliers.list({
        page: 1,
        pageSize: SUPPLIERS_PAGE_SIZE,
        search: '',
        status: 'active'
      }),
      page
    )
    const html = render(<SuppliersPage />, queryClient)
    const shown = text(html)
    for (const expected of [
      'Suppliers',
      'Pay Supplier',
      'Add Supplier',
      'Code Supplier Contact Phone City Current Balance Status Actions',
      'SUP-00001 ABC Distributors Imran 0300-1112233 Lahore Rs 40,000.00 Due Active View Edit Deactivate',
      'SUP-00002 PQR Foods — 0300-1112233 Lahore Rs 700.00 Advance Active',
      'SUP-00003 STU Mills Imran — Lahore Settled Inactive View Edit Reactivate',
      'Showing 1–3 of 3'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(html).toContain('placeholder="Search by code, name, contact, phone or city"')
  })

  it('says how to start when there are no suppliers', () => {
    const queryClient = client()
    queryClient.setQueryData(
      queryKeys.suppliers.list({
        page: 1,
        pageSize: SUPPLIERS_PAGE_SIZE,
        search: '',
        status: 'active'
      }),
      { items: [], total: 0, page: 1, pageSize: SUPPLIERS_PAGE_SIZE }
    )
    expect(text(render(<SuppliersPage />, queryClient))).toContain(
      'No suppliers yet. Add the people and firms you buy stock from.'
    )
  })
})

describe('Supplier detail', () => {
  it('shows the profile, the balance, the actions and the summary cards', () => {
    const shown = detail('overview')
    for (const expected of [
      'ABC Distributors SUP-00001 Active',
      'Contact Imran',
      'Phone 0300-1112233',
      'Address Circular Road',
      'Current balance Rs 40,000.00 Due The shop owes the supplier.',
      'New Stock Purchase Pay Supplier Adjust Balance Edit Supplier Deactivate',
      'Total Purchases Rs 80,000.00 2 posted receipts (void excluded)',
      'Total Paid Rs 45,000.00 3 posted payments (void excluded)',
      'Current Due Rs 40,000.00 Due',
      'Last Purchase 12-Sep-2026',
      'Last Payment 16-Sep-2026',
      'Overview Purchases Payments Ledger',
      'Products Purchased',
      'Product Last Purchase Last Unit Cost Total Purchased',
      'A-001 Product A 12-Sep-2026 Rs 3,000.00 / Box 20 Box'
    ]) {
      expect(shown).toContain(expected)
    }
  })

  it('calls an advance an advance, and keeps an inactive supplier payable but not purchasable', () => {
    const inactive = { ...supplier, isActive: false, balanceMinor: -500_000 }
    const html = render(
      <SupplierDetailView
        supplier={inactive}
        currency={RS}
        tab="overview"
        onTab={noop}
        busy={false}
        ledger={undefined}
        purchases={undefined}
        payments={undefined}
        onLedgerPage={noop}
        onPurchasePage={noop}
        onPaymentPage={noop}
        onNewPurchase={noop}
        onPay={noop}
        onAdjust={noop}
        onEdit={noop}
        onToggleActive={noop}
        onOpenPayment={noop}
        onOpenReceipt={noop}
      />
    )
    const shown = text(html)
    expect(shown).toContain('Current Advance Rs 5,000.00 Advance')
    expect(shown).toContain('The supplier holds an advance of the shop’s money.')
    expect(shown).toContain('This supplier is inactive.')
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*title="Reactivate the supplier to record a purchase\."/
    )
    expect(shown).toContain('Reactivate')
  })

  it('lists the purchases with bill numbers, totals and status', () => {
    const shown = detail('purchases')
    expect(shown).toContain('Receipt No Supplier Bill No Date Reference Total Status Actions')
    expect(shown).toContain(
      'GRN-000011 ABC-101 10-Sep-2026 Truck 7 Rs 50,000.00 Posted · Void available View'
    )
    expect(shown).toContain('GRN-000012 ABC-101 10-Sep-2026 Truck 7 Rs 50,000.00 Void View')
  })

  it('lists the payments with their method, status and linked receipt', () => {
    const shown = detail('payments')
    expect(shown).toContain('Payment No Date Amount Method Reference Status Linked Receipt Actions')
    expect(shown).toContain(
      'SPAY-000001 10-Sep-2026 Rs 20,000.00 Bank TT-55 Posted GRN-000011 View / Void'
    )
    expect(shown).toContain('SPAY-000002 10-Sep-2026 Rs 20,000.00 Cash — Void — View')
    expect(shown).toContain('A supplier payment is not an expense.')
  })

  it('shows the running ledger in shop terms: activity, reference, signed amount and Due/Advance balance', () => {
    const shown = detail('ledger')
    expect(shown).toContain('Date Activity Reference Amount Balance')
    expect(shown).toContain('01-Sep-2026 Opening balance (due) +Rs 10,000.00 Rs 10,000.00 Due')
    expect(shown).toContain(
      '10-Sep-2026 Stock purchase GRN-000011 · Bill ABC-101 +Rs 50,000.00 Rs 60,000.00 Due'
    )
    expect(shown).toContain(
      '10-Sep-2026 Payment · Bank SPAY-000001 −Rs 70,000.00 Rs 10,000.00 Advance'
    )
    expect(shown).toContain(
      'Due: the shop owes the supplier. Advance: the supplier holds the shop’s money.'
    )
  })
})

describe('supplier forms', () => {
  it('asks for the opening balance only when adding a supplier, in plain words', () => {
    const add = text(
      render(
        <SupplierForm supplier={null} currency={RS} today={TODAY} onSaved={noop} onCancel={noop} />
      )
    )
    for (const expected of [
      'Name',
      'Contact Person',
      'Phone',
      'City',
      'Address',
      'Notes',
      'Opening Balance',
      'We owe supplier',
      'Supplier advance',
      'Opening date',
      'Save Supplier'
    ]) {
      expect(add).toContain(expected)
    }
    const edit = text(
      render(
        <SupplierForm
          supplier={supplier}
          currency={RS}
          today={TODAY}
          onSaved={noop}
          onCancel={noop}
        />
      )
    )
    expect(edit).toContain(
      'The opening balance cannot be changed here. Use Adjust Balance on the supplier page.'
    )
    expect(edit).not.toContain('We owe supplier')
  })

  it('pays a supplier with the current balance shown, and warns when a payment becomes an advance', () => {
    const form = text(
      render(
        <SupplierPaymentForm
          supplier={supplier}
          currency={RS}
          today={TODAY}
          onSaved={noop}
          onCancel={noop}
        />
      )
    )
    for (const expected of [
      'Supplier SUP-00001 ABC Distributors',
      'Payment Date',
      'Earliest allowed: 12-Sep-2026 (the latest account entry).',
      'Amount',
      'Method',
      'Reference',
      'Note',
      'Current balance Rs 40,000.00 Due This payment — Balance after —',
      'Save Payment'
    ]) {
      expect(form).toContain(expected)
    }
    const over = text(
      renderToStaticMarkup(
        <SupplierPaymentPreviewPanel balanceMinor={4_000_000} amount="45,000" currency={RS} />
      )
    )
    expect(over).toContain('This payment Rs 45,000.00 Balance after Rs 5,000.00 Advance')
    expect(over).toContain(
      'This payment is Rs 5,000.00 more than the shop owes. The extra is kept as a supplier advance.'
    )
  })

  it('adjusts a supplier balance with a direction, amount, date and reason', () => {
    const shown = text(
      render(
        <SupplierAdjustmentForm
          supplier={supplier}
          currency={RS}
          today={TODAY}
          onSaved={noop}
          onCancel={noop}
        />
      )
    )
    for (const expected of [
      'Increase — the shop owes the supplier more',
      'Decrease — the shop owes less (or the supplier advance grows)',
      'Amount',
      'Date',
      'Reason',
      'Current balance Rs 40,000.00 Due Balance after —',
      'Save Adjustment'
    ]) {
      expect(shown).toContain(expected)
    }
  })

  it('shows a saved supplier payment and offers a void only while it is posted', () => {
    const saved: SupplierPaymentDetail = {
      ...payment,
      supplierActive: true,
      note: null,
      receiptStatus: 'VOID',
      voidReason: null,
      voidDate: null,
      voidedAt: null
    }
    const posted = text(render(<SupplierPaymentDetailView payment={saved} currency={RS} />))
    expect(posted).toContain('Supplier SUP-00001 ABC Distributors')
    expect(posted).toContain('Paid with receipt GRN-000011 (void)')
    expect(posted).toContain('Reason for voiding')
    const voided = text(
      render(
        <SupplierPaymentDetailView
          payment={{
            ...saved,
            status: 'VOID',
            voidReason: 'Money returned',
            voidDate: '2026-09-16',
            voidedAt: '2026-09-16T05:00:00.000Z'
          }}
          currency={RS}
        />
      )
    )
    expect(voided).toContain('Voided on 16-Sep-2026 Void reason Money returned')
    expect(voided).not.toContain('Reason for voiding')
  })
})

describe('Stock In with a supplier', () => {
  it('asks for the supplier, bill number and the money paid now, and projects the supplier balance', () => {
    const queryClient = client()
    queryClient.setQueryData(queryKeys.suppliers.detail(1), supplier)
    const html = render(
      <ReceiptForm
        currency={RS}
        today={TODAY}
        initialSupplier={{ id: 1, label: 'SUP-00001 ABC Distributors' }}
        onSaved={noop}
      />,
      queryClient
    )
    const shown = text(html)
    for (const expected of [
      'Receipt Date',
      'Supplier',
      'The purchase is added to what the shop owes this supplier.',
      'Supplier Bill No',
      'Reference',
      'Note',
      'Product Unit Quantity Unit Cost Base Qty Line Cost',
      'Supplier Payment',
      'Paid Now',
      'Payment Method',
      'Payment Reference',
      'Supplier Current Balance Rs 40,000.00 Due Purchase Total — Paid Now −Rs 0.00 Projected Supplier Balance —',
      'Add Product',
      'New Product',
      'Save Receipt'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(html).toContain('value="SUP-00001 ABC Distributors"')
    expect(html).toContain('aria-label="Clear supplier"')
  })

  it('shows no payment section without a supplier account', () => {
    const shown = text(render(<ReceiptForm currency={RS} today={TODAY} onSaved={noop} />))
    expect(shown).toContain(
      'Choose the supplier account. Leave empty only for stock without a supplier account.'
    )
    expect(shown).not.toContain('Paid Now')
  })

  it('shows a supplier receipt’s account, bill number and payments, and warns before a void that keeps them', () => {
    const detailData: StockReceiptDetail = {
      ...receipt,
      note: null,
      voidReason: null,
      voidDate: null,
      lines: [],
      corrections: [],
      supplierPayments: [payment],
      supplierBalanceMinor: 3_000_000
    }
    const shown = text(render(<ReceiptDetail receipt={detailData} currency={RS} onClose={noop} />))
    for (const expected of [
      'Supplier ABC Distributors SUP-00001',
      'Supplier Bill No ABC-101',
      'Supplier Payments With This Receipt Supplier balance now: Rs 30,000.00 Due',
      'SPAY-000001 10-Sep-2026 Rs 20,000.00 Bank TT-55 Posted',
      'It also removes the purchase from the supplier account.',
      RECEIPT_PAYMENTS_VOID_WARNING
    ]) {
      expect(shown).toContain(expected)
    }
    const unpaid = text(
      render(
        <ReceiptDetail
          receipt={{ ...detailData, supplierPayments: [] }}
          currency={RS}
          onClose={noop}
        />
      )
    )
    expect(unpaid).toContain('Nothing was paid with this receipt.')
    expect(unpaid).not.toContain(RECEIPT_PAYMENTS_VOID_WARNING)
  })
})

describe('Supplier Balances report', () => {
  it('shows payables and advances apart, with each supplier’s balance and last activity', () => {
    const report: SupplierBalancesReport = {
      rows: [
        {
          supplierId: 1,
          code: 'SUP-00001',
          name: 'ABC Distributors',
          phone: '0300-1112233',
          isActive: true,
          balanceMinor: 4_000_000,
          state: 'DUE',
          lastPurchaseDate: '2026-09-10',
          lastPaymentDate: '2026-09-10'
        },
        {
          supplierId: 2,
          code: 'SUP-00002',
          name: 'PQR Foods',
          phone: null,
          isActive: true,
          balanceMinor: -70_000,
          state: 'ADVANCE',
          lastPurchaseDate: null,
          lastPaymentDate: null
        },
        {
          supplierId: 3,
          code: 'SUP-00003',
          name: 'XYZ Traders',
          phone: null,
          isActive: false,
          balanceMinor: 150_000,
          state: 'DUE',
          lastPurchaseDate: null,
          lastPaymentDate: null
        }
      ],
      payablesMinor: 4_150_000,
      advancesMinor: 70_000,
      dueCount: 2,
      advanceCount: 1,
      settledCount: 0
    }
    const shown = text(render(<SupplierBalancesReportView report={report} currency={RS} />))
    for (const expected of [
      'Total Supplier Payables Rs 41,500.00 What the shop owes its suppliers',
      'Supplier Advances Rs 700.00 Paid to suppliers beyond what was owed',
      'Suppliers 3 2 due · 1 advance · 0 settled',
      'Code Supplier Phone Current Balance Due / Advance Last Purchase Last Payment',
      'SUP-00001 ABC Distributors 0300-1112233 Rs 40,000.00 Due Due 10-Sep-2026 10-Sep-2026',
      'SUP-00002 PQR Foods — Rs 700.00 Advance Advance — —',
      'SUP-00003 XYZ Traders (inactive) — Rs 1,500.00 Due Due — —',
      'Supplier purchases and payments are not part of the Profit & Loss.'
    ]) {
      expect(shown).toContain(expected)
    }
  })
})

// Keep the page-level fixtures typed against the real shapes.
const _typed: StockPage<StockReceiptSummary> = { items: [receipt], total: 1, page: 1, pageSize: 25 }
void _typed
