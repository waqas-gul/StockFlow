import { matchRoutes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { PlaceholderPage } from '@renderer/components/common/PlaceholderPage'
import { SettingsPage } from '@renderer/features/settings/SettingsPage'
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

  it.each(expectedPaths.filter((path) => path !== '/settings'))(
    'routes %s to its placeholder page',
    (path) => {
      expect(leafComponent(path)).toBe(PlaceholderPage)
    }
  )

  it('routes /settings to the Settings page', () => {
    expect(leafComponent('/settings')).toBe(SettingsPage)
  })

  it('routes unknown paths to the not-found page', () => {
    expect(leafComponent('/does-not-exist')).toBe(NotFoundPage)
  })
})
