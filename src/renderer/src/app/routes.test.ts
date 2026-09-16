import { matchRoutes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { PlaceholderPage } from '@renderer/components/common/PlaceholderPage'
import { ProductsPage } from '@renderer/features/products/ProductsPage'
import { SettingsPage } from '@renderer/features/settings/SettingsPage'
import { StockAdjustmentsPage } from '@renderer/features/stock/StockAdjustmentsPage'
import { StockInPage } from '@renderer/features/stock/StockInPage'
import { allNavItems } from './navigation'
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

  const implemented = ['/settings', '/products', '/stock/in', '/stock/adjustments']

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

  it('routes unknown paths to the not-found page', () => {
    expect(leafComponent('/does-not-exist')).toBe(NotFoundPage)
  })
})
