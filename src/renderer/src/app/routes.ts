import type { RouteObject } from 'react-router'
import { DashboardPage } from '@renderer/features/dashboard/DashboardPage'
import { CustomerDetailPage } from '@renderer/features/customers/CustomerDetailPage'
import { CustomersPage } from '@renderer/features/customers/CustomersPage'
import { ExpensesPage } from '@renderer/features/expenses/ExpensesPage'
import { InvoiceDetailPage } from '@renderer/features/invoices/InvoiceDetailPage'
import { InvoiceHistoryPage } from '@renderer/features/invoices/InvoiceHistoryPage'
import { InvoicePrintPage } from '@renderer/features/invoices/InvoicePrintPage'
import { NewInvoicePage } from '@renderer/features/invoices/NewInvoicePage'
import { PaymentsPage } from '@renderer/features/payments/PaymentsPage'
import { ProductsPage } from '@renderer/features/products/ProductsPage'
import { ReportsPage } from '@renderer/features/reports/ReportsPage'
import { SettingsPage } from '@renderer/features/settings/SettingsPage'
import { StockAdjustmentsPage } from '@renderer/features/stock/StockAdjustmentsPage'
import { StockInPage } from '@renderer/features/stock/StockInPage'
import { SupplierDetailPage } from '@renderer/features/suppliers/SupplierDetailPage'
import { SuppliersPage } from '@renderer/features/suppliers/SuppliersPage'
import { AppShell } from './layout/AppShell'
import { allNavItems, settingsNavItem } from './navigation'
import { NotFoundPage } from './NotFoundPage'
import { RouteErrorPage } from './RouteErrorPage'

// Every navigation section's page. A section without one fails the routes test.
const sectionPages: Readonly<Record<string, React.ComponentType>> = {
  '/': DashboardPage,
  '/invoices/new': NewInvoicePage,
  '/invoices': InvoiceHistoryPage,
  '/products': ProductsPage,
  '/stock/in': StockInPage,
  '/stock/adjustments': StockAdjustmentsPage,
  '/customers': CustomersPage,
  '/payments': PaymentsPage,
  '/suppliers': SuppliersPage,
  '/expenses': ExpensesPage,
  '/reports': ReportsPage,
  [settingsNavItem.path]: SettingsPage
}

const sectionRoutes: RouteObject[] = [
  ...allNavItems.map((item): RouteObject => {
    const Component = sectionPages[item.path] ?? NotFoundPage
    return item.path === '/' ? { index: true, Component } : { path: item.path.slice(1), Component }
  }),
  { path: 'customers/:customerId', Component: CustomerDetailPage },
  { path: 'suppliers/:supplierId', Component: SupplierDetailPage },
  { path: 'invoices/:invoiceId', Component: InvoiceDetailPage }
]

export const routes: RouteObject[] = [
  // The print preview (Phase 9B) shows the invoice as it prints, so it has no sidebar or top bar.
  {
    path: '/invoices/:invoiceId/print',
    Component: InvoicePrintPage,
    ErrorBoundary: RouteErrorPage
  },
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
