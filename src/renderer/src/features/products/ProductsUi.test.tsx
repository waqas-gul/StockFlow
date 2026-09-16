import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Company } from '@shared/companies'
import type { Product, ProductListItem, ProductListPage, ProductUnit } from '@shared/products'
import type { SettingsView } from '@shared/settings'
import { queryKeys } from '@renderer/lib/query-keys'
import { CompaniesManager } from './CompaniesDialog'
import { ProductForm } from './ProductForm'
import { PRODUCTS_PAGE_SIZE, ProductsPage } from './ProductsPage'
import { ProductsTable } from './ProductsTable'

const RS = { minorDigits: 2, symbol: 'Rs' }

function unit(overrides: Partial<ProductUnit>): ProductUnit {
  return {
    id: 1,
    name: 'Piece',
    shortName: null,
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

const tea: ProductListItem = {
  id: 1,
  code: 'P-001',
  name: 'Tea 950g',
  companyId: 4,
  companyName: 'Old Brand',
  companyActive: false,
  packingLabel: '1*12*18',
  lowStockThresholdBase: 0,
  isActive: true,
  stockQtyBase: 0,
  units: [
    unit({ id: 1, wholesalePriceMinor: 1000 }),
    unit({
      id: 2,
      name: 'Box',
      shortName: 'Bx',
      baseQty: 24,
      isBase: false,
      wholesalePriceMinor: 24000,
      sortOrder: 1
    })
  ]
}

const sugar: ProductListItem = {
  ...tea,
  id: 2,
  code: 'S-9',
  name: 'Sugar',
  companyId: null,
  companyName: null,
  companyActive: null,
  packingLabel: null,
  isActive: false,
  units: [unit({ id: 3, retailPriceMinor: 0 })]
}

const companies: Company[] = [
  { id: 4, name: 'Old Brand', isActive: false, productCount: 1 },
  { id: 5, name: 'Acme', isActive: true, productCount: 0 }
]

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
  minorDigitsLocked: false
}

function client(page?: ProductListPage): QueryClient {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.companies, companies)
  queryClient.setQueryData(queryKeys.settings, settings)
  if (page) {
    queryClient.setQueryData(
      queryKeys.products.list({
        page: 1,
        pageSize: PRODUCTS_PAGE_SIZE,
        search: '',
        companyId: null,
        status: 'active'
      }),
      page
    )
  }
  return queryClient
}

function render(node: React.ReactNode, queryClient = client()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
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

function inputTag(html: string, label: string): string {
  const tag = new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`).exec(html)
  if (tag === null) throw new Error(`No input labelled ${label}`)
  return tag[0]
}

function buttonTag(html: string, label: string): string {
  const tag = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html)
  if (tag === null) throw new Error(`No button labelled ${label}`)
  return tag[0]
}

describe('ProductsTable', () => {
  it('shows each product compactly: code, name and units, company, packing text as typed, stock, prices, status', () => {
    const shown = text(
      render(
        <ProductsTable
          items={[tea, sugar]}
          currency={RS}
          busyId={null}
          onEdit={() => {}}
          onToggleActive={() => {}}
          onStockCard={() => {}}
        />
      )
    )
    for (const expected of [
      'Code Product Company Packing Stock Wholesale Retail Status Actions',
      'P-001 Tea 950g Piece · Box Old Brand (inactive) 1*12*18 0 Piece',
      'Rs 10.00 / Piece +1 more unit',
      '— Active Stock Card Edit Deactivate',
      'S-9 Sugar Piece — — 0 Piece — Rs 0.00 / Piece Inactive Stock Card Edit Activate'
    ]) {
      expect(shown).toContain(expected)
    }
  })
})

describe('ProductForm', () => {
  it('a new product starts with Basic Information and one base unit whose size is fixed at 1', () => {
    const html = render(
      <ProductForm product={null} currency={RS} onSaved={() => {}} onCancel={() => {}} />
    )
    const shown = text(html)
    for (const expected of [
      'Basic Information',
      'Code',
      'Name',
      'Company',
      'New company',
      'Packing',
      'Display text only, e.g. 1*12*18. It is never used for units or stock.',
      'Low-stock level',
      'Units & Prices',
      'Unit Short name Base qty Base unit Sell? Purchase? Wholesale Retail Default cost Active',
      'Base unit',
      'Add unit',
      'Add product'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(inputTag(html, 'Unit 1 base quantity')).toMatch(/readonly=""/i)
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Unit 1 is the base unit"/)
    expect(buttonTag(html, 'Remove unit 1')).toMatch(/disabled=""/)
    expect(shown).not.toContain('stock history')
    expect(html).not.toMatch(/type="file"/)
  })

  it('a product with stock history locks sizes, the base unit and removal, and says so', () => {
    const product: Product = {
      ...tea,
      stockQtyBase: 48,
      hasStockMovements: true,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z'
    }
    const html = render(
      <ProductForm product={product} currency={RS} onSaved={() => {}} onCancel={() => {}} />
    )
    expect(text(html)).toContain(
      'This product has stock history. Base quantities and the base unit are locked'
    )
    expect(inputTag(html, 'Unit 2 base quantity')).toMatch(/readonly=""/i)
    expect(buttonTag(html, 'Remove unit 2')).toMatch(/disabled=""/)
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Unit 2 is the base unit"|aria-label="Unit 2 is the base unit"[^>]*disabled=""/
    )
    expect(inputTag(html, 'Unit 2 name')).not.toMatch(/readonly/i)
    expect(inputTag(html, 'Unit 2 wholesale price')).not.toMatch(/readonly/i)
    expect(text(html)).toContain('Save product')
  })

  it('a saved product without stock history can change sizes and remove saved units', () => {
    const product: Product = { ...tea, hasStockMovements: false, createdAt: '', updatedAt: '' }
    const html = render(
      <ProductForm product={product} currency={RS} onSaved={() => {}} onCancel={() => {}} />
    )
    expect(inputTag(html, 'Unit 2 base quantity')).not.toMatch(/readonly/i)
    expect(buttonTag(html, 'Remove unit 2')).not.toMatch(/disabled=""/)
  })
})

describe('ProductsPage', () => {
  it('shows the title, actions, search, filters, the table and the page count', () => {
    const shown = text(
      render(
        <ProductsPage />,
        client({ items: [tea], total: 1, page: 1, pageSize: PRODUCTS_PAGE_SIZE })
      )
    )
    for (const expected of [
      'Products',
      'Manage Companies',
      'Add Product',
      'P-001',
      'Tea 950g',
      'Showing 1–1 of 1',
      'Page 1 of 1'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(
      render(
        <ProductsPage />,
        client({ items: [tea], total: 1, page: 1, pageSize: PRODUCTS_PAGE_SIZE })
      )
    ).toContain('placeholder="Search by code, product or company"')
    expect(shown).not.toMatch(/Stock In\b.*button/)
  })

  it('invites the first product when there is none', () => {
    const shown = text(
      render(
        <ProductsPage />,
        client({ items: [], total: 0, page: 1, pageSize: PRODUCTS_PAGE_SIZE })
      )
    )
    expect(shown).toContain('No products yet.')
    expect(shown).toContain('Add your first product')
  })
})

describe('CompaniesManager', () => {
  it('lists companies with their product counts, status, Rename and Activate/Deactivate, and an add field', () => {
    const html = render(<CompaniesManager />)
    const shown = text(html)
    expect(html).toContain('placeholder="New company name"')
    expect(shown).toContain('Add company')
    expect(shown).toContain('Old Brand 1 Inactive Rename Activate')
    expect(shown).toContain('Acme 0 Active Rename Deactivate')
    expect(shown).not.toMatch(/delete/i)
  })
})
