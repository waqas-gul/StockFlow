import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type {
  CustomerBalancesReport,
  ExpenseReport,
  ProductSalesReport,
  ProfitLossReport,
  SalesReport,
  StockReport
} from '@shared/reports'
import type { SettingsView } from '@shared/settings'
import { queryKeys } from '@renderer/lib/query-keys'
import { EXPENSE_REPORT_PAGE_SIZE } from './ExpenseReportView'
import { basePl } from './report-test-data'
import { ReportsPage, type ReportTab } from './ReportsPage'
import { SALES_REPORT_PAGE_SIZE } from './SalesReportViews'

const SEPTEMBER = { dateFrom: '2026-09-01', dateTo: '2026-09-30' }

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

function render(tab: ReportTab, seed: (client: QueryClient) => void): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.settings, settings)
  seed(queryClient)
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ReportsPage initialTab={tab} today="2026-09-17" />
      </MemoryRouter>
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

describe('Reports page', () => {
  it('offers the seven reports and the period presets, defaulting to Profit & Loss for this month', () => {
    const html = render('profit-loss', (client) =>
      client.setQueryData(queryKeys.reports.profitLoss(SEPTEMBER), basePl)
    )
    const shown = text(html)
    expect(shown).toContain(
      'Profit & Loss Sales Products Stock Customer Balances Supplier Balances Expenses'
    )
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('aria-label="Report period"')
    expect(shown).toContain('This Month · 01-Sep-2026 to 30-Sep-2026')
    expect(html).toContain('value="2026-09-01"')
    expect(html).toContain('value="2026-09-30"')
  })

  it('opens on the report a link asks for (the Dashboard’s View Sales Report)', () => {
    const open = (entry: string): string => {
      const queryClient = new QueryClient()
      queryClient.setQueryData(queryKeys.settings, settings)
      return renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[entry]}>
            <ReportsPage today="2026-09-17" />
          </MemoryRouter>
        </QueryClientProvider>
      )
    }
    expect(open('/reports?tab=products')).toMatch(/aria-selected="true"[^>]*>Products</)
    expect(open('/reports?tab=unknown')).toMatch(/aria-selected="true"[^>]*>Profit &amp; Loss</)
    expect(open('/reports')).toMatch(/aria-selected="true"[^>]*>Profit &amp; Loss</)
  })

  it('shows the P&L statement with gross profit, net operating profit and hidden zero stock lines', () => {
    const shown = text(
      render('profit-loss', (client) =>
        client.setQueryData(queryKeys.reports.profitLoss(SEPTEMBER), basePl)
      )
    )
    expect(shown).toContain(
      'Revenue Goods Revenue Rs 10,000.00 Freight Income Rs 0.00 Cost of Goods Sold COGS − Rs 6,000.00 Gross Profit Goods Revenue − COGS (freight excluded) Rs 4,000.00'
    )
    expect(shown).toContain(
      'Operating Expenses Shop Expenses − Rs 1,000.00 Monthly / General Expenses Rs 0.00 Net Operating Profit'
    )
    expect(shown).toContain('Rs 3,000.00')
    expect(shown).not.toContain('Stock Damage')
    expect(shown).not.toContain('Data Corrections')
    expect(shown).not.toContain('Historical COGS is frozen')
  })

  it('shows data corrections below net operating profit, the inventory corrections and the frozen COGS note', () => {
    const report: ProfitLossReport = {
      ...basePl,
      netOperatingProfitMinor: 300_000,
      purchaseCostCorrectionsMinor: 25_000,
      inventoryCorrections: basePl.inventoryCorrections.map((total) =>
        total.reason === 'OTHER_CORRECTION'
          ? { ...total, count: 1, valueAddedMinor: 20_000, netValueMinor: 20_000 }
          : total
      ),
      inventoryCorrectionsNetMinor: 20_000,
      inventoryCorrectionDetails: [
        {
          adjustmentId: 7,
          adjustmentNo: 'ADJ-000007',
          adjustmentDate: '2026-09-05',
          reason: 'OTHER_CORRECTION',
          direction: 'IN',
          productCode: 'W-001',
          productName: 'Widget',
          qtyBase: 2,
          quantityText: '+2 Piece',
          valueMinor: 20_000
        }
      ],
      profitAfterDataCorrectionsMinor: 295_000,
      expenseCategories: [
        {
          categoryId: 4,
          name: 'Supplier Price Fixes',
          group: 'GENERAL',
          isActive: true,
          isPurchaseCostCorrection: true,
          count: 1,
          amountMinor: 25_000
        }
      ],
      showFrozenCogsNote: true
    }
    const shown = text(
      render('profit-loss', (client) =>
        client.setQueryData(queryKeys.reports.profitLoss(SEPTEMBER), report)
      )
    )
    expect(shown).toContain(
      'Data Corrections Purchase Cost Corrections − Rs 250.00 Inventory Quantity Corrections Rs 200.00 Profit After Data Corrections'
    )
    expect(shown).toContain('Rs 2,950.00')
    expect(shown).toContain(
      'Supplier Price Fixes Data correction (below operating profit) Rs 250.00'
    )
    expect(shown).toContain(
      '05-Sep-2026 ADJ-000007 Other Correction W-001 · Widget +2 Piece +Rs 200.00'
    )
    expect(shown).toContain('Net value effect +Rs 200.00')
    expect(shown).not.toContain('Receipt Cost Correction')
    expect(shown).toContain(
      'Historical COGS is frozen when an invoice is posted. Later purchase-cost corrections affect future inventory valuation and future COGS only.'
    )
  })

  it('discloses receipt cost corrections apart from the statement, never in its arithmetic', () => {
    const detail = {
      adjustmentId: 8,
      adjustmentNo: 'ADJ-000008',
      adjustmentDate: '2026-09-06',
      reason: 'RECEIPT_COST_CORRECTION' as const,
      direction: 'VALUE' as const,
      productCode: 'W-001',
      productName: 'Widget',
      qtyBase: 0,
      quantityText: null
    }
    const report: ProfitLossReport = {
      ...basePl,
      receiptCostCorrections: {
        reason: 'RECEIPT_COST_CORRECTION',
        count: 2,
        valueAddedMinor: 15_000,
        valueRemovedMinor: 5_000,
        netValueMinor: 10_000
      },
      receiptCostCorrectionDetails: [
        { ...detail, valueMinor: 15_000 },
        { ...detail, adjustmentId: 9, adjustmentNo: 'ADJ-000009', valueMinor: -5_000 }
      ],
      showFrozenCogsNote: true
    }
    const shown = text(
      render('profit-loss', (client) =>
        client.setQueryData(queryKeys.reports.profitLoss(SEPTEMBER), report)
      )
    )
    const statement = shown.slice(
      shown.indexOf('Profit & Loss 1 posted'),
      shown.indexOf('Expenses by Category')
    )
    expect(statement).toContain('Net Operating Profit')
    expect(statement).not.toMatch(/Receipt Cost|Data Corrections/)
    expect(shown).toContain(
      'Receipt Cost Corrections For information only: not included in any profit figure above. Net change in inventory value +Rs 100.00 Receipt cost corrections update inventory value and affect future COGS. Historical COGS is not recalculated.'
    )
    expect(shown).toContain('06-Sep-2026 ADJ-000008 W-001 · Widget +Rs 150.00')
    expect(shown).toContain('06-Sep-2026 ADJ-000009 W-001 · Widget −Rs 50.00')
    expect(shown).toContain('Net Operating Profit Rs 3,000.00')
  })

  it('shows the sales summary and the invoices of the period', () => {
    const report: SalesReport = {
      ...SEPTEMBER,
      invoiceCount: 1,
      grossSalesMinor: 1_000_000,
      lineDiscountMinor: 10_000,
      extraDiscountMinor: 20_000,
      discountMinor: 30_000,
      schemeDiscountMinor: 5_000,
      netGoodsSalesMinor: 965_000,
      freightChargedMinor: 30_000,
      totalBilledMinor: 995_000,
      cogsMinor: 660_000,
      grossProfitMinor: 305_000,
      voidInvoiceCount: 1,
      voidTotalMinor: 501_000,
      invoices: {
        items: [
          {
            id: 1,
            invoiceNo: 'INV-000001',
            invoiceDate: '2026-09-10',
            customerName: 'Ali Raza',
            customerShopName: 'Ali Traders',
            status: 'POSTED',
            grossMinor: 1_000_000,
            discountMinor: 30_000,
            schemeMinor: 5_000,
            netMinor: 965_000,
            freightMinor: 30_000,
            totalMinor: 995_000,
            cogsMinor: 660_000,
            grossProfitMinor: 305_000
          }
        ],
        total: 1,
        page: 1,
        pageSize: SALES_REPORT_PAGE_SIZE
      }
    }
    const html = render('sales', (client) =>
      client.setQueryData(
        queryKeys.reports.sales({
          ...SEPTEMBER,
          page: 1,
          pageSize: SALES_REPORT_PAGE_SIZE,
          status: 'POSTED'
        }),
        report
      )
    )
    const shown = text(html)
    expect(shown).toContain(
      'Gross sales Rs 10,000.00 Discounts − Rs 300.00 Scheme discounts − Rs 50.00 Net goods sales Rs 9,650.00 Freight charged + Rs 300.00 Total billed Rs 9,950.00 COGS Rs 6,600.00 Gross profit (net goods sales − COGS) Rs 3,050.00'
    )
    expect(shown).toContain(
      '1 void invoice dated in this period (Rs 5,010.00 billed) is not counted.'
    )
    expect(shown).toContain(
      '10-Sep-2026 INV-000001 Ali Raza Ali Traders Rs 10,000.00 Rs 300.00 Rs 50.00 Rs 9,650.00 Rs 300.00 Rs 6,600.00 Rs 3,050.00 Posted'
    )
    expect(html).toContain('href="/invoices/1"')
  })

  it('shows product sales with free scheme quantity and the extra discount reconciliation', () => {
    const report: ProductSalesReport = {
      ...SEPTEMBER,
      rows: [
        {
          productId: 1,
          code: 'W-001',
          name: 'Widget',
          companyName: 'Acme',
          invoiceCount: 1,
          qtyBase: 16,
          quantityText: '1 Box + 6 Piece',
          schemeQtyBase: 1,
          revenueMinor: 1_500_000,
          cogsMinor: 960_000,
          grossProfitMinor: 540_000
        }
      ],
      revenueMinor: 1_500_000,
      cogsMinor: 960_000,
      grossProfitMinor: 540_000,
      extraDiscountMinor: 20_000,
      netGoodsSalesMinor: 1_480_000
    }
    const shown = text(
      render('products', (client) =>
        client.setQueryData(queryKeys.reports.productSales(SEPTEMBER), report)
      )
    )
    expect(shown).toContain(
      'W-001 Widget Acme 1 Box + 6 Piece 16 base units 1 Rs 15,000.00 Rs 9,600.00 Rs 5,400.00'
    )
    expect(shown).toContain('Total Rs 15,000.00 Rs 9,600.00 Rs 5,400.00')
    expect(shown).toContain(
      'Invoice extra discounts (not allocated to products) − Rs 200.00 Net goods sales Rs 14,800.00'
    )
  })

  it('shows current stock without a date range', () => {
    const report: StockReport = {
      rows: [
        {
          productId: 2,
          code: 'L-001',
          name: 'Lamp',
          companyName: null,
          isActive: true,
          qtyBase: 3,
          quantityText: '3 Piece',
          valueMinor: 21_000,
          lowStockThresholdBase: 5,
          level: 'LOW'
        },
        {
          productId: 3,
          code: 'R-001',
          name: 'Retired',
          companyName: null,
          isActive: false,
          qtyBase: 0,
          quantityText: '0 Piece',
          valueMinor: 0,
          lowStockThresholdBase: 0,
          level: 'OUT_OF_STOCK'
        }
      ],
      totalValueMinor: 21_000,
      lowStockCount: 1,
      outOfStockCount: 1
    }
    const html = render('stock', (client) => client.setQueryData(queryKeys.reports.stock, report))
    const shown = text(html)
    expect(html).not.toContain('aria-label="Report period"')
    expect(shown).toContain('Current figures, as of now')
    expect(shown).toContain('Total Inventory Value Rs 210.00')
    expect(shown).toContain(
      'Code Product Company Current Qty In Units Inventory Value Stock Status'
    )
    expect(shown).toContain('L-001 Lamp — 3 3 Piece Rs 210.00 Low stock Active')
    expect(shown).toContain('R-001 Retired — 0 0 Piece Rs 0.00 Out of stock Inactive')
  })

  it('shows receivables and advances separately, with each customer due, advance or settled', () => {
    const report: CustomerBalancesReport = {
      rows: [
        {
          customerId: 2,
          code: 'C-00002',
          name: 'Ali Raza',
          shopName: 'Ali Traders',
          city: 'Lahore',
          isActive: true,
          balanceMinor: 100_000,
          state: 'DUE'
        },
        {
          customerId: 3,
          code: 'C-00003',
          name: 'Bilal Khan',
          shopName: null,
          city: null,
          isActive: true,
          balanceMinor: -50_000,
          state: 'ADVANCE'
        },
        {
          customerId: 1,
          code: 'C-00001',
          name: 'Cash / Walk-in',
          shopName: null,
          city: null,
          isActive: true,
          balanceMinor: 0,
          state: 'SETTLED'
        }
      ],
      receivablesMinor: 100_000,
      advancesMinor: 50_000,
      netMinor: 50_000,
      dueCount: 1,
      advanceCount: 1,
      settledCount: 1
    }
    const shown = text(
      render('customers', (client) =>
        client.setQueryData(queryKeys.reports.customerBalances, report)
      )
    )
    expect(shown).toContain('Total Receivables Rs 1,000.00')
    expect(shown).toContain('Total Customer Advances Rs 500.00')
    expect(shown).toContain('Net Receivable Rs 500.00')
    expect(shown).toContain('C-00002 Ali Raza Ali Traders Lahore Rs 1,000.00 Due')
    expect(shown).toContain('C-00003 Bilal Khan — Rs 500.00 Advance')
    expect(shown).toContain('C-00001 Cash / Walk-in — Settled')
  })

  it('shows expense totals by group, purchase cost corrections apart, categories and rows', () => {
    const report: ExpenseReport = {
      ...SEPTEMBER,
      shopMinor: 14_000,
      generalMinor: 56_000,
      operatingMinor: 70_000,
      purchaseCostCorrectionsMinor: 3_000,
      totalActiveMinor: 73_000,
      voidCount: 1,
      voidMinor: 99_000,
      categories: [
        {
          categoryId: 5,
          name: 'Rent',
          group: 'GENERAL',
          isActive: false,
          isPurchaseCostCorrection: false,
          count: 1,
          amountMinor: 56_000
        },
        {
          categoryId: 4,
          name: 'Purchase Cost Correction',
          group: 'GENERAL',
          isActive: true,
          isPurchaseCostCorrection: true,
          count: 1,
          amountMinor: 3_000
        }
      ],
      expenses: {
        items: [
          {
            id: 1,
            expenseDate: '2026-09-03',
            categoryId: 5,
            categoryName: 'Rent',
            categoryGroup: 'GENERAL',
            categoryActive: false,
            amountMinor: 56_000,
            description: 'September rent',
            status: 'ACTIVE',
            createdAt: '2026-09-03T05:00:00.000Z',
            updatedAt: '2026-09-03T05:00:00.000Z'
          }
        ],
        total: 1,
        page: 1,
        pageSize: EXPENSE_REPORT_PAGE_SIZE
      }
    }
    const shown = text(
      render('expenses', (client) =>
        client.setQueryData(
          queryKeys.reports.expenses({
            ...SEPTEMBER,
            page: 1,
            pageSize: EXPENSE_REPORT_PAGE_SIZE,
            status: 'ACTIVE'
          }),
          report
        )
      )
    )
    expect(shown).toContain(
      'Shop Expenses Rs 140.00 Monthly / General Expenses Rs 560.00 Total Operating Expenses Rs 700.00 Purchase Cost Corrections Rs 30.00'
    )
    expect(shown).toContain('Active expenses only · 1 void expense (Rs 990.00) not counted')
    expect(shown).toContain('Rent (inactive) Monthly / General 1 Rs 560.00')
    expect(shown).toContain('Purchase Cost Correction Purchase cost correction 1 Rs 30.00')
    expect(shown).toContain('Total active expenses Rs 730.00')
    expect(shown).toContain('03-Sep-2026 Rent Monthly / General September rent Rs 560.00 Active')
  })
})
