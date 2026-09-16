import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, LoaderCircle, Lock, Wrench } from 'lucide-react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { formatDisplayDate } from '@shared/dates'
import { ADJUSTMENT_REASON_INFO, REASON_NOTE_MAX, type StockReceiptDetail } from '@shared/stock'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import { receiptQuery, refreshAfterStockChange } from '@renderer/lib/app-queries'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { ReceiptStatusBadge } from './ReceiptStatusBadge'
import { submitVoid, type StockNotifier } from './stock-actions'
import { adjustmentQuantityText, signedAmount } from './stock-display'

const notify: StockNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

/** A saved receipt: its lines as recorded, void state, and the adjustments that correct it. */
export function ReceiptDetailDialog({
  receiptId,
  currency,
  onClose
}: {
  receiptId: number | null
  currency: CurrencyFormat
  onClose: () => void
}): React.JSX.Element {
  const receipt = useQuery({ ...receiptQuery(receiptId ?? 0), enabled: receiptId !== null })
  return (
    <Dialog open={receiptId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[min(64rem,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>
            {receipt.data ? `Receipt ${receipt.data.receiptNo}` : 'Receipt'}
          </DialogTitle>
          <DialogDescription>The receipt exactly as it was saved.</DialogDescription>
        </DialogHeader>
        {receipt.data ? (
          <ReceiptDetail receipt={receipt.data} currency={currency} onClose={onClose} />
        ) : (
          <p className={`text-sm ${receipt.error ? 'text-destructive' : 'text-muted-foreground'}`}>
            {receipt.error ? receipt.error.message : 'Loading…'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function ReceiptDetail({
  receipt,
  currency,
  onClose
}: {
  receipt: StockReceiptDetail
  currency: CurrencyFormat
  onClose: () => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const locked = receipt.status === 'POSTED' && !receipt.voidable

  return (
    <div className="flex flex-col gap-5">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <Detail label="Date" value={formatDisplayDate(receipt.receiptDate)} />
        <Detail label="Supplier" value={receipt.supplierName} />
        <Detail label="Reference" value={receipt.reference} />
        <Detail label="Total cost" value={formatAmount(receipt.totalCostMinor, currency)} />
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="mt-0.5">
            <ReceiptStatusBadge receipt={receipt} />
          </dd>
        </div>
        <Detail label="Note" value={receipt.note} />
        {receipt.status === 'VOID' && (
          <>
            <Detail
              label="Voided on"
              value={receipt.voidDate && formatDisplayDate(receipt.voidDate)}
            />
            <Detail label="Void reason" value={receipt.voidReason} />
          </>
        )}
      </dl>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-3">Line</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead className="text-right">Base Qty</TableHead>
              <TableHead className="text-right">Unit Cost</TableHead>
              <TableHead className="pr-3 text-right">Line Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {receipt.lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell className="pl-3">{line.lineNo}</TableCell>
                <TableCell className="whitespace-normal">
                  <span className="font-mono text-xs">{line.productCode}</span> {line.productName}
                </TableCell>
                <TableCell>
                  {line.unitName}
                  {line.unitBaseQty > 1 && (
                    <span className="text-xs text-muted-foreground"> ({line.unitBaseQty})</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {line.quantity.toLocaleString('en-US')}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {line.qtyBase.toLocaleString('en-US')}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatAmount(line.unitCostMinor, currency)}
                </TableCell>
                <TableCell className="pr-3 text-right tabular-nums">
                  {formatAmount(line.lineCostMinor, currency)}
                  {line.correctedLineCostMinor !== line.lineCostMinor && (
                    <div className="text-xs text-muted-foreground">
                      Corrected: {formatAmount(line.correctedLineCostMinor, currency)}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {receipt.status === 'POSTED' && receipt.voidable && <VoidReceipt receipt={receipt} />}
      {locked && (
        <Alert>
          <Lock aria-hidden />
          <AlertTitle>Receipt locked because later stock activity exists</AlertTitle>
          <AlertDescription>
            <p>
              Other stock documents have used or added the products on this receipt since it was
              saved, so voiding it could corrupt stock values. Correct it with a stock adjustment
              instead.
            </p>
            <Button
              size="sm"
              className="mt-2"
              onClick={() => {
                onClose()
                void navigate(`/stock/adjustments?receipt=${receipt.id}`)
              }}
            >
              <Wrench aria-hidden />
              Correct Stock
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Corrections</h3>
        {receipt.corrections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No corrections.</p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-3">Adjustment</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Line</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="pr-3">Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receipt.corrections.map((correction) => (
                  <TableRow key={correction.id}>
                    <TableCell className="pl-3 font-mono text-xs">
                      {correction.adjustmentNo}
                    </TableCell>
                    <TableCell>{formatDisplayDate(correction.adjustmentDate)}</TableCell>
                    <TableCell>{ADJUSTMENT_REASON_INFO[correction.reason].label}</TableCell>
                    <TableCell>{correction.receiptLineNo ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      {adjustmentQuantityText(correction)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {signedAmount(correction.valueMinor, currency)}
                    </TableCell>
                    <TableCell className="max-w-64 pr-3 whitespace-normal">
                      {correction.reasonNote}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  )
}

/** Void available: reverses the receipt's exact quantities and values. */
function VoidReceipt({ receipt }: { receipt: StockReceiptDetail }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const voidIt = async (): Promise<void> => {
    setBusy(true)
    const voided = await submitVoid(window.api.stock, { id: receipt.id, reason }, notify)
    setBusy(false)
    setConfirming(false)
    if (voided !== null) queryClient.setQueryData(receiptQuery(receipt.id).queryKey, voided)
    refreshAfterStockChange(queryClient)
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm">
        <span className="font-medium">Void available.</span>{' '}
        <span className="text-muted-foreground">
          No other stock activity has touched this receipt&apos;s products, so voiding removes
          exactly what it added.
        </span>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-72 flex-1 gap-1.5">
          <Label htmlFor="voidReason">Reason for voiding</Label>
          <Input
            id="voidReason"
            maxLength={REASON_NOTE_MAX}
            autoComplete="off"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        {confirming ? (
          <>
            <Button variant="destructive" disabled={busy} onClick={() => void voidIt()}>
              {busy && <LoaderCircle className="animate-spin" aria-hidden />}
              Confirm void of {receipt.receiptNo}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            disabled={reason.trim() === ''}
            onClick={() => setConfirming(true)}
          >
            <Ban aria-hidden />
            Void Receipt
          </Button>
        )}
      </div>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string | null }): React.JSX.Element {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value ?? '—'}</dd>
    </div>
  )
}
