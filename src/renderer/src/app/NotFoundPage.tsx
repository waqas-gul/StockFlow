import { SearchX } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@renderer/components/ui/button'

export function NotFoundPage(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <SearchX className="size-10 text-muted-foreground" aria-hidden />
      <h2 className="text-lg font-semibold">Page not found</h2>
      <p className="text-sm text-muted-foreground">This screen does not exist.</p>
      <Button asChild variant="outline">
        <Link to="/">Back to Dashboard</Link>
      </Button>
    </div>
  )
}
