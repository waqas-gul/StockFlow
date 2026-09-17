import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { DashboardData } from '@shared/dashboard'
import type { DailySales } from '@shared/reports'
import type { SettingsView } from '@shared/settings'
import { queryKeys } from '@renderer/lib/query-keys'
import { SalesTrendChart } from './DashboardCharts'
import { DashboardPage } from './DashboardPage'

const RS = { minorDigits: 2, symbol: 'Rs' }

const settings: SettingsView = {
  values: {
    'business.name': 'Ali Traders',
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

function trend(sales: Record<string, [number, number]> = {}): DailySales[] {
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 7, 19 + index)).toISOString().slice(0, 10)
    return {
      date,
      invoiceCount: sales[date]?.[0] ?? 0,
      netGoodsSalesMinor: sales[date]?.[1] ?? 0
    }
  })
}

const EMPTY: DashboardData = {
  today: '2026-09-17',
  month: { dateFrom: '2026-09-01', dateTo: '2026-09-30' },
  summary: {
    todaySalesMinor: 0,
    todayInvoiceCount: 0,
    monthSalesMinor: 0,
    monthInvoiceCount: 0,
    receivablesMinor: 0,
    dueCustomerCount: 0,
    advancesMinor: 0,
    advanceCustomerCount: 0,
    inventoryValueMinor: 0,
    activeProductCount: 0,
    lowStockCount: 0
  },
  salesTrend: trend(),
  expenseBreakdown: {
    dateFrom: '2026-09-01',
    dateTo: '2026-09-30',
    shopMinor: 0,
    generalMinor: 0,
    operatingMinor: 0,
    purchaseCostCorrectionsMinor: 0
  },
  lowStock: [],
  topProducts: [],
  recentInvoices: [],
  recentPayments: [],
  recentExpenses: [],
  gettingStarted: true
}

const BUSY: DashboardData = {
  ...EMPTY,
  summary: {
    todaySalesMinor: 990_000,
    todayInvoiceCount: 1,
    monthSalesMinor: 1_190_000,
    monthInvoiceCount: 2,
    receivablesMinor: 1_090_000,
    dueCustomerCount: 1,
    advancesMinor: 95_000,
    advanceCustomerCount: 1,
    inventoryValueMinor: 2_700_000,
    activeProductCount: 3,
    lowStockCount: 7
  },
  salesTrend: trend({
    '2026-08-25': [1, 100_000],
    '2026-09-10': [1, 200_000],
    '2026-09-17': [1, 990_000]
  }),
  expenseBreakdown: {
    ...EMPTY.expenseBreakdown,
    shopMinor: 10_000,
    generalMinor: 40_000,
    operatingMinor: 50_000,
    purchaseCostCorrectionsMinor: 5_000
  },
  lowStock: [
    {
      productId: 3,
      code: 'L-001',
      name: 'Lamp',
      qtyBase: 0,
      quantityText: '0 Piece',
      lowStockThresholdBase: 5,
      thresholdText: '5 Piece'
    },
    {
      productId: 1,
      code: 'W-001',
      name: 'ABC Soap',
      qtyBase: 38,
      quantityText: '3 Box + 8 Piece',
      lowStockThresholdBase: 40,
      thresholdText: '4 Box'
    }
  ],
  topProducts: [
    {
      productId: 1,
      code: 'W-001',
      name: 'ABC Soap',
      companyName: null,
      invoiceCount: 1,
      qtyBase: 10,
      quantityText: '1 Box',
      schemeQtyBase: 0,
      revenueMinor: 1_000_000,
      cogsMinor: 600_000,
      grossProfitMinor: 400_000
    },
    {
      productId: 2,
      code: 'G-001',
      name: 'Gadget',
      companyName: null,
      invoiceCount: 1,
      qtyBase: 4,
      quantityText: '4 Kg',
      schemeQtyBase: 0,
      revenueMinor: 200_000,
      cogsMinor: 120_000,
      grossProfitMinor: 80_000
    }
  ],
  recentInvoices: [
    {
      id: 5,
      invoiceNo: 'INV-000005',
      invoiceDate: '2026-09-17',
      customerId: 2,
      customerCode: 'C-0002',
      customerName: 'Ahmed Traders',
      customerShopName: null,
      totalMinor: 300_000,
      receivedMinor: 0,
      netOutstandingMinor: 0,
      status: 'VOID'
    },
    {
      id: 4,
      invoiceNo: 'INV-000004',
      invoiceDate: '2026-09-16',
      customerId: 2,
      customerCode: 'C-0002',
      customerName: 'Ahmed Traders',
      customerShopName: null,
      totalMinor: 1_245_000,
      receivedMinor: 0,
      netOutstandingMinor: 0,
      status: 'POSTED'
    }
  ],
  recentPayments: [
    {
      id: 54,
      paymentNo: 'RCP-000054',
      paymentDate: '2026-09-17',
      customerId: 2,
      customerCode: 'C-0002',
      customerName: 'Ahmed Traders',
      shopName: null,
      amountMinor: 500_000,
      method: 'CASH',
      reference: null,
      status: 'POSTED',
      createdAt: '2026-09-17T05:00:00.000Z'
    }
  ],
  recentExpenses: [
    {
      id: 9,
      expenseDate: '2026-09-10',
      categoryId: 3,
      categoryName: 'Freight Paid',
      categoryGroup: 'SHOP',
      categoryActive: true,
      amountMinor: 120_000,
      description: 'Transport charges',
      status: 'ACTIVE',
      createdAt: '2026-09-10T05:00:00.000Z',
      updatedAt: '2026-09-10T05:00:00.000Z'
    }
  ],
  gettingStarted: false
}

function render(data: DashboardData | null): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.settings, settings)
  if (data !== null) queryClient.setQueryData(queryKeys.dashboard, data)
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
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

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1].replace(/&amp;/g, '&'))
}

describe('Dashboard', () => {
  it('opens with the shop, today and the four quick actions, and no navigation card grid', () => {
    const html = render(BUSY)
    const shown = text(html)
    expect(shown).toContain('Ali Traders Overview of your shop today. Today 17 Sep 2026')
    expect(shown).toContain('New Invoice Stock In Receive Payment Add Expense')
    expect(hrefs(html).slice(0, 4)).toEqual([
      '/invoices/new',
      '/stock/in',
      '/payments?receive=1',
      '/expenses?add=1'
    ])
    expect(shown).not.toMatch(/Choose what to do|Stock Adjustments|Settings|placeholder/i)
  })

  it('shows the six figures from the overview', () => {
    const shown = text(render(BUSY))
    for (const figure of [
      'Today Sales Rs 9,900.00 1 invoice today',
      'This Month Sales Rs 11,900.00 2 invoices',
      'Receivables Rs 10,900.00 1 customer owes money',
      'Customer Advances Rs 950.00 1 customer with credit',
      'Inventory Value Rs 27,000.00 3 active products',
      'Low Stock 7 Products Needs attention'
    ]) {
      expect(shown).toContain(figure)
    }
  })

  it('draws the last 7 days of sales by default, with a readable axis and a summary', () => {
    const html = render(BUSY)
    const shown = text(html)
    expect(shown).toContain('Sales Trend')
    expect(html).toContain('aria-pressed="true">7 Days')
    expect(html).toContain('aria-label="Sales, last 7 days: Rs 9,900.00 from 1 invoice"')
    expect(html).toContain('data-chart="sales-line"')
    for (const label of ['11 Sep', '14 Sep', '17 Sep', 'Rs 10K', 'Rs 0']) {
      expect(shown).toContain(label)
    }
  })

  it('names every fifth day of the 30-day trend', () => {
    const html = renderToStaticMarkup(<SalesTrendChart days={BUSY.salesTrend} currency={RS} />)
    const labels = [...html.matchAll(/data-axis="x">([^<]+)</g)].map((match) => match[1])
    expect(labels).toEqual(['23 Aug', '28 Aug', '2 Sep', '7 Sep', '12 Sep', '17 Sep'])
    expect(html).toContain('aria-label="Sales, last 30 days: Rs 12,900.00 from 3 invoices"')
  })

  it('splits this month’s expenses into Shop and Monthly / General, apart from purchase cost corrections', () => {
    const html = render(BUSY)
    const shown = text(html)
    expect(shown).toContain(
      'Expenses This Month Total Expenses Rs 500.00 Shop Rs 100.00 Monthly / General Rs 400.00'
    )
    expect(shown).toContain('Purchase cost corrections of Rs 50.00 are not included.')
    expect(html.match(/data-slice=/g)).toHaveLength(2)
  })

  it('lists low stock with the product’s units and level, and the top products with bars', () => {
    const html = render(BUSY)
    const shown = text(html)
    expect(shown).toContain(
      'Low Stock Products Lamp L-001 0 Piece Low at 5 Piece Out of stock ABC Soap W-001 3 Box + 8 Piece Low at 4 Box Low'
    )
    expect(shown).toContain('Showing 2 of 7.')
    expect(shown).toContain(
      'Top Selling Products This month ABC Soap Rs 10,000.00 1 Box Gadget Rs 2,000.00 4 Kg'
    )
    expect(html).toContain('style="width:20%"')
    expect(hrefs(html)).toEqual(expect.arrayContaining(['/products', '/reports?tab=products']))
  })

  it('shows recent invoices, payments and expenses, linking to the invoice and the payment', () => {
    const html = render(BUSY)
    const shown = text(html)
    expect(shown).toContain('Recent Activity')
    expect(shown).toContain(
      'Recent Invoices View all INV-000005 Ahmed Traders Rs 3,000.00 Today Void INV-000004 Ahmed Traders Rs 12,450.00 Yesterday'
    )
    expect(shown).toContain('Recent Payments View all Ahmed Traders RCP-000054 Rs 5,000.00 Today')
    expect(shown).toContain(
      'Recent Expenses View all Freight Paid Transport charges Rs 1,200.00 10-Sep-2026'
    )
    expect(hrefs(html)).toEqual(
      expect.arrayContaining(['/invoices/5', '/invoices/4', '/payments?payment=54'])
    )
  })

  it('looks intentional for a new shop: zero figures, clean empty charts and where to start', () => {
    const html = render(EMPTY)
    const shown = text(html)
    expect(shown).toContain('Start by adding products and recording stock.')
    expect(hrefs(html)).toEqual(
      expect.arrayContaining(['/products?add=1', '/stock/in', '/invoices/new'])
    )
    for (const figure of [
      'Today Sales Rs 0.00 0 invoices today',
      'This Month Sales Rs 0.00 0 invoices',
      'Receivables Rs 0.00 0 customers owe money',
      'Customer Advances Rs 0.00 0 customers with credit',
      'Inventory Value Rs 0.00 0 active products',
      'Low Stock 0 Products Nothing below its low-stock level'
    ]) {
      expect(shown).toContain(figure)
    }
    expect(shown).toContain('No sales recorded for this period.')
    expect(shown).toContain('No expenses recorded this month.')
    expect(shown).toContain('No products yet.')
    expect(shown).toContain('No sales recorded this month.')
    expect(shown).toContain('No invoices yet.')
    expect(shown).toContain('No payments yet.')
    expect(shown).toContain('No expenses yet.')
    // No fake chart points or slices.
    expect(html).not.toContain('data-chart="sales-line"')
    expect(html).not.toContain('data-slice=')
  })

  it('praises stock that is above every level once products exist, and hides the start message', () => {
    const shown = text(
      render({
        ...EMPTY,
        summary: { ...EMPTY.summary, activeProductCount: 4 },
        gettingStarted: false
      })
    )
    expect(shown).toContain('All products are above their low-stock levels.')
    expect(shown).not.toContain('Start by adding products')
  })

  it('shows quiet placeholders while the overview loads, never figures', () => {
    const html = render(null)
    const shown = text(html)
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('data-slot="skeleton"')
    expect(shown).toContain('New Invoice Stock In Receive Payment Add Expense')
    expect(shown).not.toMatch(/Rs \d|No sales|No expenses/)
  })
})
