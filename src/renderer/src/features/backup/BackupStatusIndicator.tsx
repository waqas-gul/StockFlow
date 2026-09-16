import { useQuery } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import { Link } from 'react-router'
import type { BackupStatus } from '@shared/types/backup'
import { backupStatusQuery } from '@renderer/lib/app-queries'

/** The top bar's backup indicator: it appears only when the last automatic backup failed. */
export function BackupStatusIndicator(): React.JSX.Element | null {
  const { data } = useQuery(backupStatusQuery)
  return <BackupFailedLink status={data} />
}

export function BackupFailedLink({
  status
}: {
  status: BackupStatus | undefined
}): React.JSX.Element | null {
  if (status?.health !== 'FAILED') return null
  return (
    <Link
      to="/settings"
      title="The last automatic backup failed. Open Settings for details."
      className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/15"
    >
      <TriangleAlert className="size-3.5" aria-hidden />
      Backup failed
    </Link>
  )
}
