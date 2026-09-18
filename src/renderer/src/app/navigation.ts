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
  Truck,
  Users,
  Wallet,
  type LucideIcon
} from 'lucide-react'

export type NavItem = {
  path: string
  label: string
  icon: LucideIcon
  /** What the section is for, shown on the Dashboard. */
  description: string
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
        description: 'Shortcuts to every part of StockFlow.'
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
        description: 'Bill a customer: products, prices, discounts, freight and money received.'
      },
      {
        path: '/invoices',
        label: 'Invoice History',
        icon: ReceiptText,
        description: 'Find, reprint, save as PDF, update dispatch details or void saved invoices.',
        matchChildren: true
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
        description: 'Products, brands / companies, units, prices and current stock.'
      },
      {
        path: '/stock/in',
        label: 'Stock In',
        icon: PackagePlus,
        description: 'Record goods received from suppliers, at their cost, and what is paid now.'
      },
      {
        path: '/stock/adjustments',
        label: 'Stock Adjustments',
        icon: ArrowUpDown,
        description: 'Opening stock, damage, expiry, count differences and corrections.'
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
        description: 'Customer accounts, balances and account history.',
        matchChildren: true
      },
      {
        path: '/payments',
        label: 'Payments',
        icon: HandCoins,
        description: 'Money received from customers.'
      }
    ]
  },
  {
    title: 'Suppliers',
    items: [
      {
        path: '/suppliers',
        label: 'Suppliers',
        icon: Truck,
        description: 'Supplier accounts: purchases, payments and what the shop owes.',
        matchChildren: true
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
        description: 'Shop and monthly / general expenses.'
      },
      {
        path: '/reports',
        label: 'Reports',
        icon: ChartColumn,
        description:
          'Profit & Loss, sales, products, stock, customer and supplier balances, and expenses.'
      }
    ]
  }
]

export const settingsNavItem: NavItem = {
  path: '/settings',
  label: 'Settings',
  icon: Settings,
  description: 'Business details, invoice numbering, backups, restore and data checks.'
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
