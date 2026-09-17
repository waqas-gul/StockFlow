import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { ProductListItem, ProductUnit } from '@shared/products'
import type { SettingsView } from '@shared/settings'
import type {
  StockAdjustmentSummary,
  StockCard,
  StockPage,
  StockReceiptDetail,
  StockReceiptSummary
} from '@shared/stock'
import { queryKeys } from '@renderer/lib/query-keys'
import { ProductsTable } from '../products/ProductsTable'
import { ADJUSTMENTS_PAGE_SIZE } from './AdjustmentHistory'
import { ReceiptDetail } from './ReceiptDetailDialog'
import { RECEIPTS_PAGE_SIZE } from './ReceiptHistory'
import { StockAdjustmentsPage } from './StockAdjustmentsPage'
import { StockCardView } from './StockCardDialog'
import { StockInPage } from './StockInPage'

const RS = { minorDigits: 2, symbol: 'Rs' }

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
  currencyLocked: true,
  startNumberLocked: false
}

function unit(overrides: Partial<ProductUnit>): ProductUnit {
  return {
    id: 1,
    name: 'Piece',
    shortName: 'Pcs',
    baseQty: 1,
    isBase: true,
    canSell: true,
    canPurchase: true,
    wholesalePriceMinor: null,
    retailPriceMinor: null,
    defaultCostMinor: null,
    sortOrder: 0,
    isActive: true,
    ...overrides
  }
}

const units = [
  unit({ id: 1 }),
  unit({ id: 2, name: 'Box', shortName: 'Box', baseQty: 24, isBase: false, sortOrder: 1 })
]

const receiptSummary: StockReceiptSummary = {
  id: 1,
  receiptNo: 'GRN-000001',
  receiptDate: '2026-09-14',
  supplierName: 'Acme Distributor',
  reference: 'Bill 77',
  totalCostMinor: 2455000,
  status: 'POSTED',
  lineCount: 2,
  voidable: true,
  createdAt: '2026-09-14T10:00:00.000Z'
}

const correction: StockAdjustmentSummary = {
  id: 4,
  adjustmentNo: 'ADJ-000004',
  adjustmentDate: '2026-09-15',
  productId: 7,
  productCode: 'P-001',
  productName: 'Tea 950g',
  reason: 'RECEIPT_QTY_CORRECTION',
  direction: 'OUT',
  unitName: 'Piece',
  quantity: 2,
  qtyBase: 2,
  valueMinor: -22000,
  receiptId: 1,
  receiptNo: 'GRN-000001',
  receiptItemId: 11,
  receiptLineNo: 2,
  reasonNote: 'Two pieces were broken on arrival',
  createdAt: '2026-09-15T10:00:00.000Z'
}

const receiptDetail: StockReceiptDetail = {
  ...receiptSummary,
  note: 'Paid cash',
  voidReason: null,
  voidDate: null,
  lines: [
    {
      id: 10,
      lineNo: 1,
      productId: 7,
      productCode: 'P-001',
      productName: 'Tea 950g',
      unitId: 2,
      unitName: 'Box',
      unitBaseQty: 24,
      quantity: 10,
      qtyBase: 240,
      unitCostMinor: 240000,
      lineCostMinor: 2400000,
      correctedLineCostMinor: 2400000,
      laterActivity: false
    },
    {
      id: 11,
      lineNo: 2,
      productId: 7,
      productCode: 'P-001',
      productName: 'Tea 950g',
      unitId: 1,
      unitName: 'Piece',
      unitBaseQty: 1,
      quantity: 5,
      qtyBase: 5,
      unitCostMinor: 11000,
      lineCostMinor: 55000,
      correctedLineCostMinor: 60000,
      laterActivity: false
    }
  ],
  corrections: []
}

function client(): QueryClient {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.settings, settings)
  return queryClient
}

function render(node: React.ReactNode, queryClient = client(), path = '/'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
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

describe('Stock In page', () => {
  it('shows the receipt form: header fields, the line columns, Add Product, the total and Save', () => {
    const html = render(<StockInPage />)
    const shown = text(html)
    for (const expected of [
      'Stock In',
      'New Receipt',
      'Receipt History',
      'Date',
      'Supplier',
      'Reference',
      'Note',
      'Product Unit Quantity Unit Cost Base Qty Line Cost Remove',
      'Add Product',
      'Total receipt cost —',
      'Save Receipt'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(html).toMatch(/<input[^>]*type="date"/)
    expect(html).toContain('aria-label="Line 1 product"')
    expect(html).toContain('placeholder="Code, product or company"')
  })

  it('lists receipts with their status: void available, locked, or void', () => {
    const queryClient = client()
    const page: StockPage<StockReceiptSummary> = {
      items: [
        receiptSummary,
        {
          ...receiptSummary,
          id: 2,
          receiptNo: 'GRN-000002',
          voidable: false,
          supplierName: null,
          reference: null
        },
        { ...receiptSummary, id: 3, receiptNo: 'GRN-000003', status: 'VOID', voidable: false }
      ],
      total: 3,
      page: 1,
      pageSize: RECEIPTS_PAGE_SIZE
    }
    queryClient.setQueryData(
      queryKeys.stock.receipts({ page: 1, pageSize: RECEIPTS_PAGE_SIZE, search: '' }),
      page
    )
    const shown = text(render(<StockInPage initialTab="history" />, queryClient))
    for (const expected of [
      'Receipt No Date Supplier Total Cost Status Actions',
      'GRN-000001 14-Sep-2026 Acme Distributor · Bill 77 Rs 24,550.00 Posted · Void available View',
      'GRN-000002 14-Sep-2026 — Rs 24,550.00 Posted · Locked View',
      'GRN-000003 14-Sep-2026 Acme Distributor · Bill 77 Rs 24,550.00 Void View',
      'Showing 1–3 of 3'
    ]) {
      expect(shown).toContain(expected)
    }
  })
})

describe('Receipt detail', () => {
  it('shows the saved lines and costs, and offers Void when no later activity exists', () => {
    const shown = text(
      render(<ReceiptDetail receipt={receiptDetail} currency={RS} onClose={() => {}} />)
    )
    for (const expected of [
      'Date 14-Sep-2026',
      'Supplier Acme Distributor',
      'Total cost Rs 24,550.00',
      'Posted · Void available',
      'Line Product Unit Quantity Base Qty Unit Cost Line Cost',
      '1 P-001 Tea 950g Box (24) 10 240 Rs 2,400.00 Rs 24,000.00',
      '2 P-001 Tea 950g Piece 5 5 Rs 110.00 Rs 550.00 Corrected: Rs 600.00',
      'Void available.',
      'Reason for voiding',
      'Void Receipt',
      'No corrections.'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(shown).not.toContain('Correct Stock')
  })

  it('a locked receipt explains why and guides to Correct Stock instead of offering Void', () => {
    const shown = text(
      render(
        <ReceiptDetail
          receipt={{ ...receiptDetail, voidable: false, corrections: [correction] }}
          currency={RS}
          onClose={() => {}}
        />
      )
    )
    expect(shown).toContain('Posted · Locked')
    expect(shown).toContain('Receipt locked because later stock activity exists')
    expect(shown).toContain('Correct Stock')
    expect(shown).not.toContain('Void Receipt')
    expect(shown).toContain(
      'ADJ-000004 15-Sep-2026 Receipt Quantity Correction 2 −2 Piece −Rs 220.00 Two pieces were broken on arrival'
    )
  })

  it('a void receipt shows when and why it was voided, with no void or correct action', () => {
    const shown = text(
      render(
        <ReceiptDetail
          receipt={{
            ...receiptDetail,
            status: 'VOID',
            voidable: false,
            voidDate: '2026-09-16',
            voidReason: 'Keyed twice'
          }}
          currency={RS}
          onClose={() => {}}
        />
      )
    )
    expect(shown).toContain('Voided on 16-Sep-2026')
    expect(shown).toContain('Void reason Keyed twice')
    expect(shown).not.toMatch(/Void Receipt|Correct Stock/)
  })
})

describe('Stock Adjustments page', () => {
  it('shows the new adjustment form and the history', () => {
    const queryClient = client()
    queryClient.setQueryData(
      queryKeys.stock.adjustments({ page: 1, pageSize: ADJUSTMENTS_PAGE_SIZE, productId: null }),
      { items: [correction], total: 1, page: 1, pageSize: ADJUSTMENTS_PAGE_SIZE }
    )
    const shown = text(render(<StockAdjustmentsPage />, queryClient, '/stock/adjustments'))
    for (const expected of [
      'Stock Adjustments',
      'New Adjustment',
      'Reason',
      'Choose a reason',
      'Save Adjustment',
      'Adjustment History',
      'Adjustment Date Product Reason Quantity Value Note',
      'ADJ-000004 15-Sep-2026 P-001 Tea 950g Receipt Quantity Correction GRN-000001, line 2 −2 Piece −Rs 220.00'
    ]) {
      expect(shown).toContain(expected)
    }
    // No sign or value fields for the operator before a reason is chosen.
    expect(shown).not.toMatch(/Unit cost|Quantity\s+Unit/)
  })

  it('"Correct Stock" opens a receipt quantity correction of that receipt', () => {
    const queryClient = client()
    queryClient.setQueryData(queryKeys.stock.receipt(1), { ...receiptDetail, voidable: false })
    const html = render(<StockAdjustmentsPage />, queryClient, '/stock/adjustments?receipt=1')
    const shown = text(html)
    // The chosen reason's description, and the chosen receipt in the receipt field.
    expect(html).toContain('placeholder="GRN-000001"')
    for (const expected of [
      'A saved receipt recorded too much or too little of a product.',
      'Receipt',
      'Receipt line',
      'Choose the line to correct',
      'Stock',
      'Add or remove',
      'Unit',
      'Quantity',
      'Reason note'
    ]) {
      expect(shown).toContain(expected)
    }
  })
})

describe('Stock card', () => {
  it('shows current stock in the product units and every movement with running totals', () => {
    const card: StockCard = {
      product: {
        id: 7,
        code: 'P-001',
        name: 'Tea 950g',
        packingLabel: '1*12*18',
        isActive: true,
        lowStockThresholdBase: 0,
        units
      },
      qtyBase: 187,
      valueMinor: 1870000,
      total: 2,
      page: 1,
      pageSize: 50,
      rows: [
        {
          id: 1,
          date: '2026-09-14',
          type: 'STOCK_IN',
          reason: null,
          reference: 'GRN-000001 (line 1)',
          qtyInBase: 192,
          qtyOutBase: 0,
          valueInMinor: 1920000,
          valueOutMinor: 0,
          runningQtyBase: 192,
          runningValueMinor: 1920000
        },
        {
          id: 2,
          date: '2026-09-15',
          type: 'ADJUST_OUT',
          reason: 'DAMAGE',
          reference: 'ADJ-000001',
          qtyInBase: 0,
          qtyOutBase: 5,
          valueInMinor: 0,
          valueOutMinor: 50000,
          runningQtyBase: 187,
          runningValueMinor: 1870000
        }
      ]
    }
    const html = render(<StockCardView card={card} currency={RS} onPage={() => {}} />)
    const shown = text(html)
    for (const expected of [
      'Current stock 7 Box + 19 Piece 187 Piece',
      'Stock value Rs 18,700.00',
      'Packing 1*12*18',
      'Date Type Reference Qty In Qty Out Value In Value Out Running Qty Running Value',
      '14-Sep-2026 Stock In GRN-000001 (line 1) 192 Rs 19,200.00 192 Rs 19,200.00',
      '15-Sep-2026 Damage ADJ-000001 5 Rs 500.00 187 Rs 18,700.00',
      'Quantities are in Piece.'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(html).toContain('title="7 Box + 19 Piece"')
    expect(html).not.toMatch(/<input/)
  })
})

describe('Products table stock', () => {
  it('shows real stock in units, a Low badge at or below the level, and the Stock Card action', () => {
    const item: ProductListItem = {
      id: 7,
      code: 'P-001',
      name: 'Tea 950g',
      companyId: null,
      companyName: null,
      companyActive: null,
      packingLabel: '1*12*18',
      lowStockThresholdBase: 200,
      isActive: true,
      stockQtyBase: 187,
      units
    }
    const shown = text(
      render(
        <ProductsTable
          items={[item, { ...item, id: 8, code: 'P-002', stockQtyBase: 240 }]}
          currency={RS}
          busyId={null}
          onEdit={() => {}}
          onToggleActive={() => {}}
          onStockCard={() => {}}
        />
      )
    )
    expect(shown).toContain('P-001 Tea 950g Piece · Box — 1*12*18 7 Box + 19 Piece Low')
    expect(shown).toContain('P-002 Tea 950g Piece · Box — 1*12*18 10 Box — —')
    expect(shown).toContain('Stock Card Edit Deactivate')
  })
})
