import { useCallback, useMemo, useReducer, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveRestore,
  CircleCheck,
  DatabaseBackup,
  FolderOpen,
  LoaderCircle,
  TriangleAlert,
  Usb
} from 'lucide-react'
import { toast } from 'sonner'
import type { BackupHealth, BackupStatus } from '@shared/types/backup'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@renderer/components/ui/card'
import { Separator } from '@renderer/components/ui/separator'
import { backupStatusQuery } from '@renderer/lib/app-queries'
import { formatDateTime } from '@renderer/lib/format'
import { queryKeys } from '@renderer/lib/query-keys'
import {
  createManualBackupAction,
  createOpenFolderAction,
  type ManualBackupState,
  type Notifier
} from './backup-actions'
import { RestoreDialog } from './RestoreDialog'
import { RESTORE_IDLE, createRestoreActions, isConfirmed, restoreFlowReducer } from './restore-flow'

const notify: Notifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message)
}

/** Settings → Backup & Restore. Every file operation happens in the main process; this only starts them. */
export function BackupRestoreCard(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: status, error } = useQuery(backupStatusQuery)
  const [backup, setBackup] = useState<ManualBackupState>({ state: 'idle' })
  const [flow, dispatch] = useReducer(restoreFlowReducer, RESTORE_IDLE)

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.backup.status })
  }, [queryClient])

  const actions = useMemo(
    () => ({
      backupNow: createManualBackupAction(
        window.api.backup,
        (next) => {
          setBackup(next)
          if (next.state !== 'creating') refresh()
        },
        notify
      ),
      openFolder: createOpenFolderAction(window.api.backup, notify),
      restore: createRestoreActions(window.api.backup, dispatch, (message) => {
        notify.error(message)
        refresh()
      })
    }),
    [refresh]
  )

  return (
    <>
      <BackupRestorePanel
        status={status}
        statusError={error ? error.message : null}
        backup={backup}
        restoreBusy={flow.step !== 'idle'}
        onBackupNow={() => void actions.backupNow()}
        onOpenFolder={() => void actions.openFolder()}
        onRestore={() => void actions.restore.choose()}
      />
      <RestoreDialog
        flow={flow}
        onType={(text) => dispatch({ type: 'type', text })}
        onCancel={() => dispatch({ type: 'cancel' })}
        onConfirm={() => {
          if (flow.step === 'confirm' && isConfirmed(flow.typed)) {
            void actions.restore.confirm(flow.token)
          }
        }}
      />
    </>
  )
}

export interface BackupRestorePanelProps {
  readonly status: BackupStatus | undefined
  readonly statusError: string | null
  readonly backup: ManualBackupState
  /** A restore is being chosen, confirmed or run. */
  readonly restoreBusy: boolean
  readonly onBackupNow: () => void
  readonly onOpenFolder: () => void
  readonly onRestore: () => void
}

export function BackupRestorePanel(props: BackupRestorePanelProps): React.JSX.Element {
  const { status, backup, restoreBusy } = props
  const creating = backup.state === 'creating'
  // Double submissions are refused by the main process too; the buttons simply wait.
  const busy = creating || restoreBusy || status?.busy === true
  const pending = status === undefined ? (props.statusError ?? 'Loading…') : null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Backup &amp; Restore</CardTitle>
        <CardDescription>
          StockFlow makes a verified backup automatically on the first use of each day and when it
          closes, at most once an hour.
        </CardDescription>
      </CardHeader>
      <Separator />
      <CardContent className="grid gap-5 text-sm">
        {status?.lastFailure && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertTitle>The last automatic backup failed</AlertTitle>
            <AlertDescription>
              <p>
                {formatDateTime(status.lastFailure.at)}: {status.lastFailure.message}
              </p>
              <p>StockFlow keeps working and tries again later.</p>
            </AlertDescription>
          </Alert>
        )}

        <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-2.5">
          <dt className="text-muted-foreground">Backup status</dt>
          <dd>{status ? <HealthBadge health={status.health} busy={status.busy} /> : pending}</dd>

          <dt className="text-muted-foreground">Last automatic backup</dt>
          <dd className="font-medium">
            {status
              ? status.lastAutomatic
                ? formatDateTime(status.lastAutomatic.at)
                : 'None yet'
              : pending}
          </dd>

          <dt className="text-muted-foreground">Last manual backup</dt>
          <dd className="font-medium break-all">
            {status
              ? status.lastManual
                ? `${formatDateTime(status.lastManual.at)}, ${status.lastManual.fileName} in ${status.lastManual.location}`
                : 'None recorded'
              : pending}
          </dd>

          {status?.lastRestore && (
            <>
              <dt className="text-muted-foreground">Last restore</dt>
              <dd className="font-medium break-all">
                {formatDateTime(status.lastRestore.at)},{' '}
                {status.lastRestore.restored
                  ? `restored from ${status.lastRestore.fileName}`
                  : 'not completed: the previous data was kept'}
              </dd>
            </>
          )}

          <dt className="text-muted-foreground">Backup folder</dt>
          <dd className="flex flex-wrap items-center gap-3">
            <span className="font-medium break-all">{status ? status.folder : pending}</span>
            <Button variant="outline" size="sm" onClick={props.onOpenFolder}>
              <FolderOpen aria-hidden />
              Open Backup Folder
            </Button>
          </dd>
        </dl>

        <Alert role="note">
          <Usb aria-hidden />
          <AlertTitle>Keep a copy away from this computer</AlertTitle>
          <AlertDescription>
            Keep an occasional backup on a USB drive or another physical drive.
          </AlertDescription>
        </Alert>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={props.onBackupNow} disabled={busy}>
            {creating ? (
              <LoaderCircle className="animate-spin" aria-hidden />
            ) : (
              <DatabaseBackup aria-hidden />
            )}
            {creating ? 'Creating backup…' : 'Backup Now'}
          </Button>
          <Button variant="outline" onClick={props.onRestore} disabled={busy}>
            <ArchiveRestore aria-hidden />
            Restore Backup
          </Button>
        </div>

        {backup.state === 'success' && (
          <p role="status" className="flex items-center gap-2 text-muted-foreground">
            <CircleCheck className="size-4 text-emerald-600" aria-hidden />
            Saved {backup.backup.fileName} in {backup.backup.location}.
          </p>
        )}
        {backup.state === 'failed' && (
          <p role="status" className="text-destructive">
            The backup was not made: {backup.message}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

const HEALTH: Readonly<
  Record<BackupHealth, { label: string; variant: 'success' | 'destructive' | 'secondary' }>
> = {
  OK: { label: 'Working', variant: 'success' },
  FAILED: { label: 'Last automatic backup failed', variant: 'destructive' },
  NONE: { label: 'No automatic backup yet', variant: 'secondary' }
}

function HealthBadge({ health, busy }: { health: BackupHealth; busy: boolean }): React.JSX.Element {
  if (busy) return <Badge variant="secondary">Backup or restore in progress</Badge>
  return <Badge variant={HEALTH[health].variant}>{HEALTH[health].label}</Badge>
}
