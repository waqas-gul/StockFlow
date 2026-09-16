import {
  ArrowUpDown,
  ChartColumn,
  FilePlus,
  HandCoins,
  LayoutDashboard,
  Package,
  PackagePlus,
  ReceiptText,
  Settings,
  Users,
  Wallet,
  type LucideIcon
} from 'lucide-react'

export type NavItem = {
  path: string
  label: string
  icon: LucideIcon
  /** Shown on the placeholder page until the section is implemented. */
  placeholder: string
  /** The section also owns the pages below its path (e.g. /customers/12). */
  matchChildren?: boolean
}

export type NavSection = {
  title?: string
  items: NavItem[]
}

export const mainNavSections: NavSection[] = [
  {
    items: [
      {
        path: '/',
        label: 'Dashboard',
        icon: LayoutDashboard,
        placeholder: 'The business overview will be implemented in a later phase.'
      }
    ]
  },
  {
    title: 'Sales',
    items: [
      {
        path: '/invoices/new',
        label: 'New Invoice',
        icon: FilePlus,
        placeholder: 'Invoice creation will be implemented in a later phase.'
      },
      {
        path: '/invoices',
        label: 'Invoices',
        icon: ReceiptText,
        placeholder: 'Invoice history will be implemented in a later phase.'
      }
    ]
  },
  {
    title: 'Inventory',
    items: [
      {
        path: '/products',
        label: 'Products',
        icon: Package,
        placeholder: 'Product management will be implemented in a later phase.'
      },
      {
        path: '/stock/in',
        label: 'Stock In',
        icon: PackagePlus,
        placeholder: 'Stock receiving will be implemented in a later phase.'
      },
      {
        path: '/stock/adjustments',
        label: 'Stock Adjustments',
        icon: ArrowUpDown,
        placeholder: 'Stock adjustments will be implemented in a later phase.'
      }
    ]
  },
  {
    title: 'Customers',
    items: [
      {
        path: '/customers',
        label: 'Customers',
        icon: Users,
        placeholder: 'Customer management will be implemented in a later phase.',
        matchChildren: true
      },
      {
        path: '/payments',
        label: 'Payments',
        icon: HandCoins,
        placeholder: 'Customer payments will be implemented in a later phase.'
      }
    ]
  },
  {
    title: 'Finance',
    items: [
      {
        path: '/expenses',
        label: 'Expenses',
        icon: Wallet,
        placeholder: 'Expense tracking will be implemented in a later phase.'
      },
      {
        path: '/reports',
        label: 'Reports',
        icon: ChartColumn,
        placeholder: 'Reports will be implemented in a later phase.'
      }
    ]
  }
]

export const settingsNavItem: NavItem = {
  path: '/settings',
  label: 'Settings',
  icon: Settings,
  placeholder: 'Business settings and backups will be implemented in a later phase.'
}

export const allNavItems: NavItem[] = [
  ...mainNavSections.flatMap((section) => section.items),
  settingsNavItem
]

export function findNavItem(pathname: string): NavItem | undefined {
  return allNavItems.find((item) => item.path === pathname)
}

/** The section a page belongs to: its own item, or the item that owns the pages below it. */
export function findSectionItem(pathname: string): NavItem | undefined {
  return (
    findNavItem(pathname) ??
    allNavItems.find((item) => item.matchChildren && pathname.startsWith(`${item.path}/`))
  )
}
