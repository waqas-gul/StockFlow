import { House, RotateCcw, TriangleAlert } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'

type ErrorFallbackProps = {
  title: string
  message: string
  onGoHome?: () => void
}

export function ErrorFallback({ title, message, onGoHome }: ErrorFallbackProps): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <TriangleAlert className="size-10 text-destructive" aria-hidden />
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-md text-sm break-words text-muted-foreground">{message}</p>
      <div className="mt-2 flex gap-2">
        <Button onClick={() => window.location.reload()}>
          <RotateCcw aria-hidden />
          Reload
        </Button>
        {onGoHome && (
          <Button variant="outline" onClick={onGoHome}>
            <House aria-hidden />
            Dashboard
          </Button>
        )}
      </div>
    </div>
  )
}
