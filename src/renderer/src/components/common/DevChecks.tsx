import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@renderer/components/ui/card'
import { Separator } from '@renderer/components/ui/separator'

/** Development-only checks for the Phase 1 foundation. Never rendered in production builds. */
export function DevChecks(): React.JSX.Element {
  const [crash, setCrash] = useState(false)
  if (crash) throw new Error('Simulated screen error (developer check).')

  return (
    <Card>
      <CardHeader>
        <CardTitle>Developer checks</CardTitle>
        <CardDescription>Visible in development builds only.</CardDescription>
      </CardHeader>
      <Separator />
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => toast.success('Notifications are working.')}>
          Show test notification
        </Button>
        <Button variant="outline" onClick={() => setCrash(true)}>
          Simulate screen error
        </Button>
      </CardContent>
    </Card>
  )
}
