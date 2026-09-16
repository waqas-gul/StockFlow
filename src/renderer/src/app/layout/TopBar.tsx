import { CalendarDays } from 'lucide-react'
import { useLocation } from 'react-router'
import { BackupStatusIndicator } from '@renderer/features/backup/BackupStatusIndicator'
import { findNavItem } from '../navigation'

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric'
})

export function TopBar(): React.JSX.Element {
  const { pathname } = useLocation()
  const title = findNavItem(pathname)?.label ?? 'StockFlow'

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b bg-card px-6">
      <h1 className="text-base font-semibold">{title}</h1>
      <div className="flex items-center gap-4">
        <BackupStatusIndicator />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarDays className="size-4" aria-hidden />
          <span>{dateFormat.format(new Date())}</span>
        </div>
      </div>
    </header>
  )
}
