import { TriangleAlert } from 'lucide-react'
import { BalanceChange } from '../customers/BalanceAdjustmentDialog'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { paymentPreview } from './payment-form'

/** The customer's balance before and after the payment as typed, and a clear note when it creates an advance. */
export function PaymentPreviewPanel({
  balanceMinor,
  amount,
  currency
}: {
  balanceMinor: number
  amount: string
  currency: CurrencyFormat
}): React.JSX.Element {
  const preview = paymentPreview(balanceMinor, amount, currency.minorDigits)
  return (
    <div className="flex flex-col gap-2">
      <BalanceChange before={balanceMinor} after={preview.balanceAfterMinor} currency={currency}>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">This payment</dt>
          <dd className="font-medium tabular-nums">
            {preview.amountMinor === null ? '—' : formatAmount(preview.amountMinor, currency)}
          </dd>
        </div>
      </BalanceChange>
      {preview.advanceMinor !== null && (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {balanceMinor > 0
              ? `This payment is ${formatAmount(preview.advanceMinor, currency)} more than the customer owes. The extra is kept as an advance.`
              : `The customer owes nothing now, so the whole payment of ${formatAmount(preview.advanceMinor, currency)} is kept as an advance.`}
          </span>
        </p>
      )}
    </div>
  )
}
