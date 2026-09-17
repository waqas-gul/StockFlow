import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import {
  ADDA_NAME_MAX,
  BILTY_NO_MAX,
  DISPATCH_NOTE_MAX,
  TRANSPORT_NAME_MAX,
  type InvoiceDetail,
  type InvoiceDispatchResult,
  type InvoiceDispatchUpdateInput
} from '@shared/invoices'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { singleFlight } from '@renderer/lib/single-flight'
import type { DispatchOutcome } from './invoice-history'

export interface DispatchDialogProps {
  readonly open: boolean
  readonly invoice: InvoiceDetail
  readonly onSave: (input: InvoiceDispatchUpdateInput) => Promise<DispatchOutcome>
  readonly onSaved: (invoice: InvoiceDispatchResult) => void
  readonly onClose: () => void
}

/** Edit Dispatch: the only details of a saved invoice that may change, each change logged. */
export function DispatchDialog({ open, ...props }: DispatchDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && props.onClose()}>
      <DialogContent
        className="sm:max-w-[min(32rem,calc(100%-2rem))]"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Dispatch details of {props.invoice.invoiceNo}</DialogTitle>
          <DialogDescription>
            Only Bilty No, Transport and Adda can change after an invoice is saved. Each change is
            logged with its old and new value.
          </DialogDescription>
        </DialogHeader>
        {open && <DispatchForm {...props} />}
      </DialogContent>
    </Dialog>
  )
}

const FIELDS = [
  { key: 'biltyNo', label: 'Bilty No', max: BILTY_NO_MAX },
  { key: 'transportName', label: 'Transport', max: TRANSPORT_NAME_MAX },
  { key: 'addaName', label: 'Adda', max: ADDA_NAME_MAX },
  { key: 'note', label: 'Note for this change (optional)', max: DISPATCH_NOTE_MAX }
] as const

export function DispatchForm({
  invoice,
  onSave,
  onSaved,
  onClose
}: Omit<DispatchDialogProps, 'open'>): React.JSX.Element {
  const [values, setValues] = useState({
    biltyNo: invoice.biltyNo ?? '',
    transportName: invoice.transportName ?? '',
    addaName: invoice.addaName ?? '',
    note: ''
  })
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [busy, setBusy] = useState(false)
  const [save] = useState(() =>
    singleFlight(async (input: InvoiceDispatchUpdateInput) => {
      setBusy(true)
      try {
        const outcome = await onSave(input)
        if (outcome.saved !== null) onSaved(outcome.saved)
        else setErrors(outcome.fieldErrors)
      } finally {
        setBusy(false)
      }
    })
  )

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void save({ id: invoice.id, ...values })
      }}
    >
      {FIELDS.map((field) => (
        <div key={field.key} className="grid gap-1.5">
          <Label htmlFor={`dispatch-${field.key}`}>{field.label}</Label>
          <Input
            id={`dispatch-${field.key}`}
            maxLength={field.max}
            autoComplete="off"
            value={values[field.key]}
            disabled={busy}
            aria-invalid={errors[field.key] !== undefined ? true : undefined}
            onChange={(event) =>
              setValues((current) => ({ ...current, [field.key]: event.target.value }))
            }
          />
          {errors[field.key] !== undefined && (
            <p className="text-xs text-destructive">{errors[field.key]}</p>
          )}
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <LoaderCircle className="animate-spin" aria-hidden />}
          Save Dispatch Details
        </Button>
      </div>
    </form>
  )
}
