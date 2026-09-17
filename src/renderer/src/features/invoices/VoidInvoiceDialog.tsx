import { useState } from 'react'
import { AlertTriangle, Ban, LoaderCircle } from 'lucide-react'
import { formatDisplayDate } from '@shared/dates'
import {
  INVOICE_VOID_REASON_MAX,
  type InvoiceDetail,
  type InvoiceVoidInput,
  type InvoiceVoidResult
} from '@shared/invoices'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { singleFlight } from '@renderer/lib/single-flight'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { canConfirmVoid, voidPlan, type VoidOutcome } from './invoice-history'

export interface VoidInvoiceDialogProps {
  readonly open: boolean
  readonly invoice: InvoiceDetail
  readonly currency: CurrencyFormat
  /** Sends the void; resolves with the outcome (the caller shows the messages). */
  readonly onConfirm: (input: InvoiceVoidInput) => Promise<VoidOutcome>
  readonly onVoided: (invoice: InvoiceVoidResult) => void
  readonly onClose: () => void
}

/** Void Invoice: what is voided, what happens to its payment, a reason, and the confirmation. */
export function VoidInvoiceDialog({
  open,
  invoice,
  currency,
  onConfirm,
  onVoided,
  onClose
}: VoidInvoiceDialogProps): React.JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent
        className="sm:max-w-[min(36rem,calc(100%-2rem))]"
        // The Void button is gone once the invoice is void: nothing to return focus to.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Void invoice {invoice.invoiceNo}?</AlertDialogTitle>
          <AlertDialogDescription>
            The invoice stays in the history as void. Its goods go back into stock at their original
            cost and its account entry is reversed, dated today. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {open && (
          <VoidInvoiceForm
            invoice={invoice}
            currency={currency}
            onConfirm={onConfirm}
            onVoided={onVoided}
            onClose={onClose}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function VoidInvoiceForm({
  invoice,
  currency,
  onConfirm,
  onVoided,
  onClose
}: Omit<VoidInvoiceDialogProps, 'open'>): React.JSX.Element {
  const plan = voidPlan(invoice, currency)
  const [reason, setReason] = useState('')
  const [moneyReturned, setMoneyReturned] = useState(false)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [busy, setBusy] = useState(false)
  // One void at a time: a double click sends it once.
  const [submit] = useState(() =>
    singleFlight(async (input: InvoiceVoidInput) => {
      setBusy(true)
      try {
        const outcome = await onConfirm(input)
        if (outcome.voided !== null) onVoided(outcome.voided)
        else setErrors(outcome.fieldErrors)
      } finally {
        setBusy(false)
      }
    })
  )
  const ready = canConfirmVoid(plan, reason, moneyReturned)

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-x-6 gap-y-2 rounded-md border p-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Invoice</dt>
          <dd className="font-mono font-medium">{invoice.invoiceNo}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Date</dt>
          <dd>{formatDisplayDate(invoice.invoiceDate)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Customer</dt>
          <dd className="whitespace-normal">
            {invoice.customerCode} {invoice.customerName}
            {invoice.customerShopName !== null && ` (${invoice.customerShopName})`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Total</dt>
          <dd className="font-semibold tabular-nums">
            {formatAmount(invoice.totalMinor, currency)}
          </dd>
        </div>
      </dl>

      {plan.paymentWarning !== null && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-900">
          <AlertTriangle aria-hidden />
          <AlertDescription className="text-amber-900">{plan.paymentWarning}</AlertDescription>
        </Alert>
      )}

      {plan.moneyReturnedRequired && (
        <div className="grid gap-1">
          <div className="flex items-start gap-2">
            <Checkbox
              id="invoice-void-money-returned"
              checked={moneyReturned}
              disabled={busy}
              aria-invalid={errors.moneyReturned !== undefined ? true : undefined}
              onCheckedChange={(checked) => setMoneyReturned(checked === true)}
            />
            <Label htmlFor="invoice-void-money-returned" className="leading-snug font-normal">
              The money ({formatAmount(invoice.payment!.amountMinor, currency)}) was returned to the
              customer
            </Label>
          </div>
          {errors.moneyReturned !== undefined && (
            <p className="text-xs text-destructive">{errors.moneyReturned}</p>
          )}
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="invoice-void-reason">Reason for voiding</Label>
        <Input
          id="invoice-void-reason"
          maxLength={INVOICE_VOID_REASON_MAX}
          autoComplete="off"
          value={reason}
          disabled={busy}
          aria-invalid={errors.reason !== undefined ? true : undefined}
          onChange={(event) => setReason(event.target.value)}
        />
        {errors.reason !== undefined && <p className="text-xs text-destructive">{errors.reason}</p>}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={busy || !ready}
          onClick={() => void submit({ id: invoice.id, reason, moneyReturned })}
        >
          {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <Ban aria-hidden />}
          {busy ? 'Voiding…' : `Void ${invoice.invoiceNo}`}
        </Button>
      </div>
    </div>
  )
}
