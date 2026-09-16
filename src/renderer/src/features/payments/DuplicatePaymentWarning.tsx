import { formatDisplayDate } from '@shared/dates'
import {
  DUPLICATE_PAYMENT_WARNING,
  PAYMENT_METHOD_LABELS,
  type PaymentSummary
} from '@shared/payments'
import { Button } from '@renderer/components/ui/button'
import { formatAmount, type CurrencyFormat } from '../products/product-display'

/** The soft duplicate warning: the similar payments already posted, and Cancel or Continue. */
export function DuplicatePaymentWarning({
  duplicates,
  currency,
  onCancel,
  onContinue
}: {
  duplicates: readonly PaymentSummary[]
  currency: CurrencyFormat
  onCancel: () => void
  onContinue: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">{DUPLICATE_PAYMENT_WARNING}</p>
      <ul className="rounded-md border text-sm">
        {duplicates.map((payment) => (
          <li
            key={payment.id}
            className="flex flex-wrap gap-x-3 border-b px-3 py-1.5 last:border-b-0"
          >
            <span className="font-mono text-xs leading-5">{payment.paymentNo}</span>
            <span>{formatDisplayDate(payment.paymentDate)}</span>
            <span className="tabular-nums">{formatAmount(payment.amountMinor, currency)}</span>
            <span className="text-muted-foreground">{PAYMENT_METHOD_LABELS[payment.method]}</span>
            {payment.reference && (
              <span className="text-muted-foreground">{payment.reference}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        Continue only if this is a separate payment. Otherwise cancel: nothing is saved.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
