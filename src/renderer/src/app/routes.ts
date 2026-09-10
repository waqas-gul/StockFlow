import type { RouteObject } from 'react-router'
import { PlaceholderPage } from '@renderer/components/common/PlaceholderPage'
import { AppShell } from './layout/AppShell'
import { allNavItems } from './navigation'
import { NotFoundPage } from './NotFoundPage'
import { RouteErrorPage } from './RouteErrorPage'

// Every section is a placeholder until its phase replaces the Component.
const sectionRoutes: RouteObject[] = allNavItems.map((item) =>
  item.path === '/'
    ? { index: true, Component: PlaceholderPage }
    : { path: item.path.slice(1), Component: PlaceholderPage }
)

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
