import { Fragment } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AppInfo } from '@shared/types/app-info'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@renderer/components/ui/card'
import { Separator } from '@renderer/components/ui/separator'
import { appInfoQuery } from '@renderer/lib/app-queries'

/** Settings → About: technical facts from `window.api.app.info()`. */
export function AboutCard(): React.JSX.Element {
  const { data, error } = useQuery(appInfoQuery)

  let content: React.JSX.Element
  if (data) content = <AppInfoList info={data} />
  else if (error) content = <p className="text-destructive">{error.message}</p>
  else content = <p className="text-muted-foreground">Loading…</p>

  return (
    <Card>
      <CardHeader>
        <CardTitle>About</CardTitle>
        <CardDescription>Technical information about this installation.</CardDescription>
      </CardHeader>
      <Separator />
      <CardContent className="text-sm">{content}</CardContent>
    </Card>
  )
}

function AppInfoList({ info }: { info: AppInfo }): React.JSX.Element {
  const rows: Array<[label: string, value: string]> = [
    ['Version', info.appVersion],
    ['Mode', info.mode === 'production' ? 'Production' : 'Development'],
    ['Database driver', info.databaseDriver],
    ['SQLite version', info.sqliteVersion],
    ['Schema version', String(info.schemaVersion)],
    ['Data folder', info.dataDirectory]
  ]
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-medium break-all">{value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}
