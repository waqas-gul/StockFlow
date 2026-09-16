import { Boxes } from 'lucide-react'
import { NavLink } from 'react-router'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { mainNavSections, settingsNavItem, type NavItem } from '../navigation'

// Full width from the lg breakpoint (1024px); an icon rail with tooltips below it.
// Header and Settings stay fixed; only the navigation list scrolls when the window is too short.
export function Sidebar(): React.JSX.Element {
  return (
    <aside className="flex w-16 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:w-56">
      <div className="flex h-14 shrink-0 items-center justify-center gap-2.5 border-b border-sidebar-border lg:justify-start lg:px-5">
        <Boxes className="size-5 shrink-0 text-sidebar-primary" aria-hidden />
        <span className="hidden text-[15px] font-semibold tracking-tight lg:inline">StockFlow</span>
      </div>

      <nav
        aria-label="Main navigation"
        className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-2 py-3 [--scrollbar-thumb-hover:var(--sidebar-muted-foreground)] [--scrollbar-thumb:var(--sidebar-accent)]"
      >
        {mainNavSections.map((section, index) => (
          <div key={section.title ?? index} className="mt-3 first:mt-0">
            {section.title && (
              <>
                <p className="hidden px-3 pb-1 text-[11px] leading-4 font-semibold tracking-wider text-sidebar-muted-foreground uppercase lg:block">
                  {section.title}
                </p>
                <div className="mx-auto mb-3 h-px w-8 bg-sidebar-border lg:hidden" aria-hidden />
              </>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.path}>
                  <SidebarLink item={item} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <SidebarLink item={settingsNavItem} />
      </div>
    </aside>
  )
}

// The className must be a plain string: TooltipTrigger's Radix Slot joins classNames as strings,
// so NavLink's className function would be stringified. Active styling keys off the
// aria-current="page" attribute that NavLink sets on the current route.
const linkClassName = [
  'relative flex h-9 items-center justify-center gap-3 rounded-md px-3 text-sm font-medium lg:justify-start',
  'text-sidebar-foreground/70 transition-colors outline-none',
  'hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
  'focus-visible:ring-2 focus-visible:ring-sidebar-ring',
  'aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground',
  'before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-primary before:opacity-0 aria-[current=page]:before:opacity-100'
].join(' ')

function SidebarLink({ item }: { item: NavItem }): React.JSX.Element {
  const Icon = item.icon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink to={item.path} end={!item.matchChildren} className={linkClassName}>
          <Icon className="size-4 shrink-0" aria-hidden />
          <span className="hidden truncate lg:inline">{item.label}</span>
        </NavLink>
      </TooltipTrigger>
      <TooltipContent side="right" className="lg:hidden">
        {item.label}
      </TooltipContent>
    </Tooltip>
  )
}
