import { CircleCheck, LoaderCircle, TriangleAlert } from 'lucide-react'
import {
  RESTORE_CONFIRMATION,
  type RestoreCandidateSummary,
  type RestoreResult
} from '@shared/types/backup'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { formatCount, formatDateTime, formatSize } from '@renderer/lib/format'
import { isConfirmed, restoreDialogText, type RestoreFlow } from './restore-flow'

interface RestoreDialogProps {
  readonly flow: RestoreFlow
  readonly onType: (text: string) => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

/** The restore confirmation, then its progress and result. It cannot be dismissed once the restore has started. */
export function RestoreDialog({
  flow,
  onType,
  onCancel,
  onConfirm
}: RestoreDialogProps): React.JSX.Element {
  const text = restoreDialogText(flow)
  const locked = flow.step !== 'confirm'
  return (
    <AlertDialog
      open={text !== null}
      onOpenChange={(open) => {
        if (!open && !locked) onCancel()
      }}
    >
      <AlertDialogContent
        onEscapeKeyDown={(event) => {
          if (locked) event.preventDefault()
          else onCancel()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{text?.title}</AlertDialogTitle>
          <AlertDialogDescription>{text?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {flow.step === 'confirm' && (
          <RestoreConfirmation
            summary={flow.summary}
            typed={flow.typed}
            restoring={false}
            onType={onType}
            onCancel={onCancel}
            onConfirm={onConfirm}
          />
        )}
        {flow.step === 'restoring' && (
          <RestoreConfirmation
            summary={flow.summary}
            typed={RESTORE_CONFIRMATION}
            restoring
            onType={onType}
            onCancel={onCancel}
            onConfirm={onConfirm}
          />
        )}
        {flow.step === 'restarting' && <RestartingNotice result={flow.result} />}
      </AlertDialogContent>
    </AlertDialog>
  )
}

export interface RestoreConfirmationProps {
  readonly summary: RestoreCandidateSummary
  readonly typed: string
  readonly restoring: boolean
  readonly onType: (text: string) => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

/** What is in the backup, the warning, and the typed confirmation. */
export function RestoreConfirmation(props: RestoreConfirmationProps): React.JSX.Element {
  const { summary, typed, restoring } = props
  const rows: Array<[label: string, value: string]> = [
    ['File', summary.fileName],
    ['Backup date', formatDateTime(summary.backupCreatedAt)],
    ['Made with', summary.appVersion ? `StockFlow ${summary.appVersion}` : 'Unknown version'],
    ['Schema version', String(summary.schemaVersion)],
    ['Products', formatCount(summary.products)],
    ['Customers', formatCount(summary.customers)],
    ['Invoices', formatCount(summary.invoices)],
    ['Size', formatSize(summary.sizeBytes)]
  ]
  return (
    <div className="grid gap-4 text-sm">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 rounded-md border bg-muted/40 p-3">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium break-all">{value}</dd>
          </div>
        ))}
      </dl>
      {summary.needsMigration && (
        <p className="text-muted-foreground">
          This backup is from an older version of StockFlow. It is upgraded after it is restored.
        </p>
      )}
      <Alert variant="destructive">
        <TriangleAlert aria-hidden />
        <AlertTitle>Restoring will replace the current StockFlow data.</AlertTitle>
        <AlertDescription>
          StockFlow keeps a copy of the current data first, and restarts when the restore is
          finished.
        </AlertDescription>
      </Alert>
      <div className="grid gap-1.5">
        <Label htmlFor="restore-confirmation">Type {RESTORE_CONFIRMATION} to confirm</Label>
        <Input
          id="restore-confirmation"
          value={typed}
          placeholder={RESTORE_CONFIRMATION}
          autoComplete="off"
          spellCheck={false}
          disabled={restoring}
          onChange={(event) => props.onType(event.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={props.onCancel} disabled={restoring}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={props.onConfirm}
          disabled={restoring || !isConfirmed(typed)}
        >
          {restoring && <LoaderCircle className="animate-spin" aria-hidden />}
          {restoring ? 'Restoring…' : 'Restore backup'}
        </Button>
      </div>
    </div>
  )
}

/** The result of the restore, shown until StockFlow restarts. */
export function RestartingNotice({ result }: { result: RestoreResult }): React.JSX.Element {
  return (
    <div role="status" className="flex items-start gap-3 text-sm">
      {result.restored ? (
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
      ) : (
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
      )}
      <div className="grid gap-2">
        <p>{result.message}</p>
        <p className="flex items-center gap-2 text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          StockFlow is restarting…
        </p>
      </div>
    </div>
  )
}
