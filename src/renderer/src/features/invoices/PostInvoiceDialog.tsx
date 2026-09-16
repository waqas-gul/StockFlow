import { LoaderCircle } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { balanceClassName, balanceText } from '../customers/customer-display'
import { formatAmount, type CurrencyFormat } from '../products/product-display'

export interface PostInvoiceConfirmationProps {
  readonly customerLabel: string
  readonly walkIn: boolean
  readonly itemCount: number
  readonly totalMinor: number
  readonly receivedMinor: number
  readonly netOutstandingMinor: number
  readonly currency: CurrencyFormat
  readonly posting: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

/** The short check before posting: who, how many products, the total, what was received and the account after. */
export function PostInvoiceDialog({
  open,
  ...props
}: PostInvoiceConfirmationProps & { readonly open: boolean }): React.JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !props.posting && props.onCancel()}>
      {/* The screen decides where focus goes next (the customer of a new invoice, or the field to fix). */}
      <AlertDialogContent onCloseAutoFocus={(event) => event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Post this invoice?</AlertDialogTitle>
          <AlertDialogDescription>
            Stock, the customer&apos;s account and the money received are saved together. A posted
            invoice is not edited.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <PostInvoiceConfirmation {...props} />
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function PostInvoiceConfirmation({
  customerLabel,
  walkIn,
  itemCount,
  totalMinor,
  receivedMinor,
  netOutstandingMinor,
  currency,
  posting,
  onCancel,
  onConfirm
}: PostInvoiceConfirmationProps): React.JSX.Element {
  const rows: Array<[string, string, string?]> = [
    ['Customer', customerLabel],
    ['Items', `${itemCount} product${itemCount === 1 ? '' : 's'}`],
    ['Invoice total', formatAmount(totalMinor, currency)],
    ['Received', formatAmount(receivedMinor, currency)],
    [
      'Account after posting',
      walkIn ? 'Cash sale: paid in full' : balanceText(netOutstandingMinor, currency),
      walkIn ? '' : balanceClassName(netOutstandingMinor)
    ]
  ]
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        {rows.map(([label, value, className]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={`text-right font-medium tabular-nums ${className ?? ''}`}>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={posting} onClick={onCancel}>
          Back
        </Button>
        <Button type="button" disabled={posting} onClick={onConfirm}>
          {posting && <LoaderCircle className="animate-spin" aria-hidden />}
          {posting ? 'Posting…' : 'Post Invoice'}
        </Button>
      </div>
    </div>
  )
}
