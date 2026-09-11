import { useLocation } from 'react-router'
import { findNavItem } from '@renderer/app/navigation'
import { NotFoundPage } from '@renderer/app/NotFoundPage'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@renderer/components/ui/card'
import { AboutCard } from './AboutCard'
import { DevChecks } from './DevChecks'

/** Temporary screen for a navigation section until its phase implements it. */
export function PlaceholderPage(): React.JSX.Element {
  const { pathname } = useLocation()
  const item = findNavItem(pathname)
  if (!item) return <NotFoundPage />

  const Icon = item.icon
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row items-center gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
            <Icon className="size-5" aria-hidden />
          </div>
          <div className="space-y-1">
            <CardTitle>{item.label}</CardTitle>
            <CardDescription>{item.placeholder}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          This section is a placeholder. No data is stored or shown yet.
        </CardContent>
      </Card>

      {item.path === '/settings' && <AboutCard />}
      {import.meta.env.DEV && item.path === '/settings' && <DevChecks />}
    </div>
  )
}
