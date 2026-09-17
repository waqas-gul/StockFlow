import { matchRoutes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { PlaceholderPage } from '@renderer/components/common/PlaceholderPage'
import { CustomerDetailPage } from '@renderer/features/customers/CustomerDetailPage'
import { CustomersPage } from '@renderer/features/customers/CustomersPage'
import { ExpensesPage } from '@renderer/features/expenses/ExpensesPage'
import { InvoiceDetailPage } from '@renderer/features/invoices/InvoiceDetailPage'
import { InvoiceHistoryPage } from '@renderer/features/invoices/InvoiceHistoryPage'
import { InvoicePrintPage } from '@renderer/features/invoices/InvoicePrintPage'
import { NewInvoicePage } from '@renderer/features/invoices/NewInvoicePage'
import { PaymentsPage } from '@renderer/features/payments/PaymentsPage'
import { ProductsPage } from '@renderer/features/products/ProductsPage'
import { SettingsPage } from '@renderer/features/settings/SettingsPage'
import { StockAdjustmentsPage } from '@renderer/features/stock/StockAdjustmentsPage'
import { StockInPage } from '@renderer/features/stock/StockInPage'
import { AppShell } from './layout/AppShell'
import { allNavItems, findSectionItem } from './navigation'
import { NotFoundPage } from './NotFoundPage'
import { routes } from './routes'

const expectedPaths = [
  '/',
  '/invoices/new',
  '/invoices',
  '/products',
  '/stock/in',
  '/stock/adjustments',
  '/customers',
  '/payments',
  '/expenses',
  '/reports',
  '/settings'
]

function leafComponent(pathname: string): unknown {
  const matches = matchRoutes(routes, pathname)
  return matches?.at(-1)?.route.Component
}

describe('navigation and routes', () => {
  it('has one navigation item for every V1 section, with unique paths', () => {
    const paths = allNavItems.map((item) => item.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect([...paths].sort()).toEqual([...expectedPaths].sort())
  })

  const implemented = [
    '/invoices/new',
    '/invoices',
    '/settings',
    '/products',
    '/stock/in',
    '/stock/adjustments',
    '/customers',
    '/payments',
    '/expenses'
  ]

  it.each(expectedPaths.filter((path) => !implemented.includes(path)))(
    'routes %s to its placeholder page',
    (path) => {
      expect(leafComponent(path)).toBe(PlaceholderPage)
    }
  )

  it('routes /settings to the Settings page', () => {
    expect(leafComponent('/settings')).toBe(SettingsPage)
  })

  it('routes /products to the Products page', () => {
    expect(leafComponent('/products')).toBe(ProductsPage)
  })

  it('routes /stock/in and /stock/adjustments to the Phase 6 stock pages', () => {
    expect(leafComponent('/stock/in')).toBe(StockInPage)
    expect(leafComponent('/stock/adjustments')).toBe(StockAdjustmentsPage)
  })

  it('routes /customers, /customers/:id and /payments to the Phase 7 pages', () => {
    expect(leafComponent('/customers')).toBe(CustomersPage)
    expect(leafComponent('/customers/12')).toBe(CustomerDetailPage)
    expect(leafComponent('/payments')).toBe(PaymentsPage)
  })

  it('routes /invoices/new to the billing page, /invoices and /invoices/:id to the Phase 9A history pages', () => {
    expect(leafComponent('/invoices/new')).toBe(NewInvoicePage)
    expect(leafComponent('/invoices')).toBe(InvoiceHistoryPage)
    expect(leafComponent('/invoices/12')).toBe(InvoiceDetailPage)
  })

  it('routes /invoices/:id/print to the Phase 9B print preview, outside the app shell', () => {
    expect(leafComponent('/invoices/12/print')).toBe(InvoicePrintPage)
    const matched = matchRoutes(routes, '/invoices/12/print') ?? []
    expect(matched.map((match) => match.route.Component)).not.toContain(AppShell)
    expect(matchRoutes(routes, '/invoices/12')?.[0].route.Component).toBe(AppShell)
  })

  it('routes /expenses to the Phase 10 Expenses page', () => {
    expect(leafComponent('/expenses')).toBe(ExpensesPage)
  })

  it('titles a customer page with its section', () => {
    expect(findSectionItem('/customers/12')?.label).toBe('Customers')
    expect(findSectionItem('/customers')?.label).toBe('Customers')
    expect(findSectionItem('/invoices/new')?.label).toBe('New Invoice')
    expect(findSectionItem('/invoices/12')?.label).toBe('Invoice History')
    expect(findSectionItem('/products/12')).toBeUndefined()
  })

  it('routes unknown paths to the not-found page', () => {
    expect(leafComponent('/does-not-exist')).toBe(NotFoundPage)
  })
})
