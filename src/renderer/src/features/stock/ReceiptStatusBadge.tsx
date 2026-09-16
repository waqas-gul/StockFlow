import type { StockReceiptSummary } from '@shared/stock'
import { Badge } from '@renderer/components/ui/badge'

/** Void, Posted · void available, or Posted · locked (later stock activity). */
export function ReceiptStatusBadge({
  receipt
}: {
  receipt: Pick<StockReceiptSummary, 'status' | 'voidable'>
}): React.JSX.Element {
  if (receipt.status === 'VOID') return <Badge variant="secondary">Void</Badge>
  return receipt.voidable ? (
    <Badge variant="success" title="No later stock activity: the receipt can still be voided.">
      Posted · Void available
    </Badge>
  ) : (
    <Badge
      variant="warning"
      title="Later stock activity exists: correct it with a stock adjustment."
    >
      Posted · Locked
    </Badge>
  )
}
