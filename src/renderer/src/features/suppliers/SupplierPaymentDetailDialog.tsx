import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { formatDisplayDate } from '@shared/dates'
import { PAYMENT_METHOD_LABELS } from '@shared/payments'
import { SUPPLIER_PAYMENT_NOTE_MAX, type SupplierPaymentDetail } from '@shared/suppliers'
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
import { refreshAfterSupplierChange, supplierPaymentQuery } from '@renderer/lib/app-queries'
import { formatDateTime } from '@renderer/lib/format'
import { PaymentStatusBadge } from '../payments/PaymentStatusBadge'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { submitSupplierPaymentVoid, type SupplierNotifier } from './supplier-actions'
import { supplierLabel } from './supplier-display'

const notify: SupplierNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

/** A saved supplier payment. There is no edit: a mistake is voided. */
export function SupplierPaymentDetailDialog({
  paymentId,
  currency,
  onClose,
  onOpenReceipt,
  onVoided
}: {
  paymentId: number | null
  currency: CurrencyFormat
  onClose: () => void
  /** Opens the Stock In receipt the payment was made with. */
  onOpenReceipt?: (receiptId: number) => void
  onVoided?: () => void
}): React.JSX.Element {
  const payment = useQuery({
    ...supplierPaymentQuery(paymentId ?? 0),
    enabled: paymentId !== null
  })
  return (
    <Dialog open={paymentId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[min(40rem,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>
            {payment.data ? `Supplier Payment ${payment.data.paymentNo}` : 'Supplier Payment'}
          </DialogTitle>
          <DialogDescription>The payment exactly as it was saved.</DialogDescription>
        </DialogHeader>
        {payment.data && payment.data.id === paymentId ? (
          <SupplierPaymentDetailView
            payment={payment.data}
            currency={currency}
            onOpenReceipt={onOpenReceipt}
            onVoided={onVoided}
          />
        ) : (
          <p className={`text-sm ${payment.error ? 'text-destructive' : 'text-muted-foreground'}`}>
            {payment.error ? payment.error.message : 'Loading…'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function SupplierPaymentDetailView({
  payment,
  currency,
  onOpenReceipt,
  onVoided
}: {
  payment: SupplierPaymentDetail
  currency: CurrencyFormat
  onOpenReceipt?: (receiptId: number) => void
  onVoided?: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Supplier</dt>
          <dd className="mt-0.5 font-medium">
            {supplierLabel({ code: payment.supplierCode, name: payment.supplierName })}
            {!payment.supplierActive && (
              <span className="text-xs font-normal text-muted-foreground"> (inactive)</span>
            )}
          </dd>
        </div>
        <Detail label="Date" value={formatDisplayDate(payment.paymentDate)} />
        <Detail label="Amount" value={formatAmount(payment.amountMinor, currency)} />
        <Detail label="Method" value={PAYMENT_METHOD_LABELS[payment.method]} />
        <Detail label="Reference" value={payment.reference} />
        <Detail label="Note" value={payment.note} />
        {payment.receiptId !== null && (
          <div>
            <dt className="text-muted-foreground">Paid with receipt</dt>
            <dd className="mt-0.5">
              {onOpenReceipt ? (
                <Button
                  variant="link"
                  className="h-auto p-0 font-mono text-sm"
                  onClick={() => onOpenReceipt(payment.receiptId!)}
                >
                  {payment.receiptNo}
                </Button>
              ) : (
                <span className="font-mono">{payment.receiptNo}</span>
              )}
              {payment.receiptStatus === 'VOID' && (
                <span className="text-xs text-muted-foreground"> (void)</span>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="mt-0.5">
            <PaymentStatusBadge status={payment.status} />
          </dd>
        </div>
        <Detail label="Recorded" value={formatDateTime(payment.createdAt)} />
        {payment.status === 'VOID' && (
          <>
            <Detail
              label="Voided on"
              value={payment.voidDate && formatDisplayDate(payment.voidDate)}
            />
            <Detail label="Void reason" value={payment.voidReason} />
          </>
        )}
      </dl>
      {payment.status === 'POSTED' && (
        <VoidSupplierPayment payment={payment} currency={currency} onVoided={onVoided} />
      )}
    </div>
  )
}

/** Void: a reason, then a confirmation that says what the void does. */
function VoidSupplierPayment({
  payment,
  currency,
  onVoided
}: {
  payment: SupplierPaymentDetail
  currency: CurrencyFormat
  onVoided?: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const voidIt = async (): Promise<void> => {
    setBusy(true)
    const voided = await submitSupplierPaymentVoid(
      window.api.supplierPayments,
      { id: payment.id, reason },
      notify,
      currency
    )
    setBusy(false)
    setConfirming(false)
    if (voided !== null) {
      queryClient.setQueryData(supplierPaymentQuery(payment.id).queryKey, voided)
      onVoided?.()
    }
    refreshAfterSupplierChange(queryClient)
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm text-muted-foreground">
        A saved payment is never edited. If it is wrong, or the supplier returned the money, void it
        with a reason.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-64 flex-1 gap-1.5">
          <Label htmlFor="supplierPaymentVoidReason">Reason for voiding</Label>
          <Input
            id="supplierPaymentVoidReason"
            maxLength={SUPPLIER_PAYMENT_NOTE_MAX}
            autoComplete="off"
            value={reason}
            disabled={confirming}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        {!confirming && (
          <Button
            variant="outline"
            disabled={reason.trim() === ''}
            onClick={() => setConfirming(true)}
          >
            <Ban aria-hidden />
            Void Payment
          </Button>
        )}
      </div>
      {confirming && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-sm">
            Voiding {payment.paymentNo} adds {formatAmount(payment.amountMinor, currency)} back to
            what the shop owes{' '}
            {supplierLabel({ code: payment.supplierCode, name: payment.supplierName })}. The payment
            stays in the history as void.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void voidIt()}>
              {busy && <LoaderCircle className="animate-spin" aria-hidden />}
              Confirm void of {payment.paymentNo}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string | null }): React.JSX.Element {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 whitespace-normal">{value ?? '—'}</dd>
    </div>
  )
}
