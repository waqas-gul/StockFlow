import type { RouteObject } from 'react-router'
import { PlaceholderPage } from '@renderer/components/common/PlaceholderPage'
import { ProductsPage } from '@renderer/features/products/ProductsPage'
import { SettingsPage } from '@renderer/features/settings/SettingsPage'
import { StockAdjustmentsPage } from '@renderer/features/stock/StockAdjustmentsPage'
import { StockInPage } from '@renderer/features/stock/StockInPage'
import { AppShell } from './layout/AppShell'
import { allNavItems, settingsNavItem } from './navigation'
import { NotFoundPage } from './NotFoundPage'
import { RouteErrorPage } from './RouteErrorPage'

// Implemented sections: Products (Phase 5), Stock In and Stock Adjustments (Phase 6) and Settings (Phase 4B). Every
// other section is a placeholder until its phase replaces the Component.
const implemented: Readonly<Record<string, React.ComponentType>> = {
  '/products': ProductsPage,
  '/stock/in': StockInPage,
  '/stock/adjustments': StockAdjustmentsPage,
  [settingsNavItem.path]: SettingsPage
}

const sectionRoutes: RouteObject[] = allNavItems.map((item) => {
  const Component = implemented[item.path] ?? PlaceholderPage
  return item.path === '/' ? { index: true, Component } : { path: item.path.slice(1), Component }
})

export const routes: RouteObject[] = [
  {
    path: '/',
    Component: AppShell,
    // Last resort if the shell itself fails.
    ErrorBoundary: RouteErrorPage,
    children: [
      {
        // Screen errors render inside the shell so navigation keeps working.
        ErrorBoundary: RouteErrorPage,
        children: [...sectionRoutes, { path: '*', Component: NotFoundPage }]
      }
    ]
  }
]
