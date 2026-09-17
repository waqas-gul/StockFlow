import type { RouteObject } from 'react-router'
import { PlaceholderPage } from '@renderer/components/common/PlaceholderPage'
import { CustomerDetailPage } from '@renderer/features/customers/CustomerDetailPage'
import { CustomersPage } from '@renderer/features/customers/CustomersPage'
import { InvoiceDetailPage } from '@renderer/features/invoices/InvoiceDetailPage'
import { InvoiceHistoryPage } from '@renderer/features/invoices/InvoiceHistoryPage'
import { NewInvoicePage } from '@renderer/features/invoices/NewInvoicePage'
import { PaymentsPage } from '@renderer/features/payments/PaymentsPage'
import { ProductsPage } from '@renderer/features/products/ProductsPage'
import { SettingsPage } from '@renderer/features/settings/SettingsPage'
import { StockAdjustmentsPage } from '@renderer/features/stock/StockAdjustmentsPage'
import { StockInPage } from '@renderer/features/stock/StockInPage'
import { AppShell } from './layout/AppShell'
import { allNavItems, settingsNavItem } from './navigation'
import { NotFoundPage } from './NotFoundPage'
import { RouteErrorPage } from './RouteErrorPage'

// Implemented sections: Products (Phase 5), Stock In and Stock Adjustments (Phase 6), Customers and Payments (Phase 7),
// New Invoice (Phase 8B), Invoice History (Phase 9A) and Settings (Phase 4B). Every other section is a placeholder until
// its phase replaces the Component.
const implemented: Readonly<Record<string, React.ComponentType>> = {
  '/invoices/new': NewInvoicePage,
  '/invoices': InvoiceHistoryPage,
  '/products': ProductsPage,
  '/stock/in': StockInPage,
  '/stock/adjustments': StockAdjustmentsPage,
  '/customers': CustomersPage,
  '/payments': PaymentsPage,
  [settingsNavItem.path]: SettingsPage
}

const sectionRoutes: RouteObject[] = [
  ...allNavItems.map((item): RouteObject => {
    const Component = implemented[item.path] ?? PlaceholderPage
    return item.path === '/' ? { index: true, Component } : { path: item.path.slice(1), Component }
  }),
  { path: 'customers/:customerId', Component: CustomerDetailPage },
  { path: 'invoices/:invoiceId', Component: InvoiceDetailPage }
]

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
