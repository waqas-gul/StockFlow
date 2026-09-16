import { Label } from '@renderer/components/ui/label'

/** A labelled form field with its error, or its hint when there is no error. */
export function FormField({
  id,
  label,
  hint,
  error,
  children
}: {
  id: string
  label: string
  hint?: string
  error: string | undefined
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}
