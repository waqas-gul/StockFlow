import { Card, CardContent } from '@renderer/components/ui/card'
import { cn } from '@renderer/lib/utils'

/** A row of figure cards: [label, value text, emphasised, note]. */
export function FigureCards({
  figures,
  columns = 4
}: {
  figures: ReadonlyArray<{
    readonly label: string
    readonly value: string
    readonly strong?: boolean
    readonly note?: string
    readonly tone?: 'negative' | 'positive'
  }>
  columns?: 3 | 4
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'grid gap-3 sm:grid-cols-2',
        columns === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'
      )}
    >
      {figures.map((figure) => (
        <Card key={figure.label} className="gap-1 py-3">
          <CardContent className="px-4">
            <p className="text-sm text-muted-foreground">{figure.label}</p>
            <p
              className={cn(
                'text-xl tabular-nums',
                figure.strong ? 'font-semibold' : 'font-medium',
                figure.tone === 'negative' && 'text-destructive'
              )}
            >
              {figure.value}
            </p>
            {figure.note && <p className="text-xs text-muted-foreground">{figure.note}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

/** Loading, error or empty text inside a report card. */
export function ReportMessage({
  children,
  error = false
}: {
  children: React.ReactNode
  error?: boolean
}): React.JSX.Element {
  return (
    <p
      className={cn(
        'px-4 py-8 text-center text-sm',
        error ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {children}
    </p>
  )
}

/** A titled card holding a table or statement. */
export function ReportCard({
  title,
  description,
  actions,
  children
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="space-y-0.5">
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </CardContent>
      {children}
    </Card>
  )
}
