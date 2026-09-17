import { ArrowRight, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router'
import { Card } from '@renderer/components/ui/card'
import { cn } from '@renderer/lib/utils'

/** A quiet grey block standing in for content that is loading. */
export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <div data-slot="skeleton" aria-hidden className={cn('rounded-md bg-muted', className)} />
}

/** A titled Dashboard card with an optional action (top right) and footer. */
export function DashboardPanel({
  title,
  description,
  action,
  footer,
  heading = 'h2',
  className,
  children
}: {
  title: string
  description?: string
  action?: React.ReactNode
  footer?: React.ReactNode
  heading?: 'h2' | 'h3'
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const Heading = heading
  return (
    <Card className={cn('gap-0 overflow-hidden py-0', className)}>
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
        <div className="min-w-0 space-y-0.5">
          <Heading className="text-sm font-semibold">{title}</Heading>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <div className="flex flex-1 flex-col">{children}</div>
      {footer && (
        <div className="flex items-center justify-end gap-3 border-t px-4 py-2.5 text-xs">
          {footer}
        </div>
      )}
    </Card>
  )
}

/** A small "View …" link with an arrow. */
export function PanelLink({ to, children }: { to: string; children: string }): React.JSX.Element {
  return (
    <Link
      to={to}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs font-medium whitespace-nowrap text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  )
}

/** What a card shows when it has nothing to show. */
export function PanelEmpty({
  icon: Icon,
  positive = false,
  children
}: {
  icon: LucideIcon
  positive?: boolean
  children: string
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <Icon
        className={cn('size-6', positive ? 'text-emerald-600' : 'text-muted-foreground/50')}
        aria-hidden
      />
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  )
}
