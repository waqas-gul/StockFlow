import { useMemo, useState } from 'react'
import { CircleAlert, CircleCheck, CircleX, LoaderCircle, ShieldCheck } from 'lucide-react'
import type { CheckStatus, IntegrityCheckReport } from '@shared/types/maintenance'
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
import { formatDateTime } from '@renderer/lib/format'
import { createIntegrityCheckAction, type IntegrityCheckRun } from './integrity-check'

/** Settings → Maintenance. */
export function IntegrityCheckCard(): React.JSX.Element {
  const [run, setRun] = useState<IntegrityCheckRun>({ state: 'idle' })
  const check = useMemo(() => createIntegrityCheckAction(window.api.maintenance, setRun), [])
  return <IntegrityCheckPanel run={run} onRun={() => void check()} />
}

export function IntegrityCheckPanel({
  run,
  onRun
}: {
  run: IntegrityCheckRun
  onRun: () => void
}): React.JSX.Element {
  const running = run.state === 'running'
  return (
    <Card>
      <CardHeader>
        <CardTitle>Maintenance</CardTitle>
        <CardDescription>
          The integrity check reads the whole database and reports any problem it finds. It never
          changes your data.
        </CardDescription>
      </CardHeader>
      <Separator />
      <CardContent className="grid gap-4 text-sm">
        <div>
          <Button variant="outline" onClick={onRun} disabled={running}>
            {running ? (
              <LoaderCircle className="animate-spin" aria-hidden />
            ) : (
              <ShieldCheck aria-hidden />
            )}
            {running ? 'Checking…' : 'Run Integrity Check'}
          </Button>
        </div>
        {run.state === 'failed' && <p className="text-destructive">{run.message}</p>}
        {run.state === 'done' && <IntegrityReportView report={run.report} />}
      </CardContent>
    </Card>
  )
}

const STATUS: Readonly<
  Record<CheckStatus, { label: string; variant: 'success' | 'warning' | 'destructive' }>
> = {
  OK: { label: 'OK', variant: 'success' },
  WARNING: { label: 'Warning', variant: 'warning' },
  ERROR: { label: 'Error', variant: 'destructive' }
}

function StatusIcon({ status }: { status: CheckStatus }): React.JSX.Element {
  if (status === 'OK')
    return <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
  if (status === 'WARNING')
    return <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
  return <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
}

export function IntegrityReportView({
  report
}: {
  report: IntegrityCheckReport
}): React.JSX.Element {
  return (
    <div className="grid gap-3" role="status">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Overall:</span>
        <Badge variant={STATUS[report.status].variant}>{STATUS[report.status].label}</Badge>
        <span>{report.message}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Checked {formatDateTime(report.checkedAt)}
        {report.ref !== null && <> · Reference: {report.ref}</>}
      </p>
      <ul className="divide-y rounded-md border">
        {report.checks.map((check) => (
          <li key={check.id} className="flex items-start gap-3 px-3 py-2">
            <StatusIcon status={check.status} />
            <div className="grid gap-0.5">
              <p className="font-medium">
                {check.title} <span className="sr-only">({STATUS[check.status].label})</span>
              </p>
              <p className="text-muted-foreground">{check.message}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
