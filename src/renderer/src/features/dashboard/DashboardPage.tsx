import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { mainNavSections, settingsNavItem, type NavItem } from '@renderer/app/navigation'
import { Card, CardContent } from '@renderer/components/ui/card'
import { settingsQuery } from '@renderer/lib/app-queries'

/**
 * The start page: the business name and a shortcut to every section, with what each is for. It shows no figures;
 * current totals are in Reports, where they are calculated from the saved records.
 */
export function DashboardPage(): React.JSX.Element {
  const settings = useQuery(settingsQuery)
  const businessName = settings.data?.values['business.name']
  const sections = [
    ...mainNavSections.filter((section) => section.title !== undefined),
    { title: 'Settings', items: [settingsNavItem] }
  ]
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 pb-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{businessName ?? 'StockFlow'}</h1>
        <p className="text-sm text-muted-foreground">
          Choose what to do. Totals and profit are in Reports.
        </p>
      </div>
      {sections.map((section) => (
        <section key={section.title} className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {section.title}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {section.items.map((item) => (
              <SectionLink key={item.path} item={item} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function SectionLink({ item }: { item: NavItem }): React.JSX.Element {
  const Icon = item.icon
  return (
    <Link
      to={item.path}
      className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Card className="h-full py-4 transition-colors hover:bg-accent">
        <CardContent className="flex items-start gap-3 px-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
            <Icon className="size-5" aria-hidden />
          </div>
          <div className="space-y-0.5">
            <p className="font-medium">{item.label}</p>
            <p className="text-sm text-muted-foreground">{item.description}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
