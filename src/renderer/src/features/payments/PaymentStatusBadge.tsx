import type { PaymentStatus } from '@shared/payments'
import { Badge } from '@renderer/components/ui/badge'
import { PAYMENT_STATUS_LABELS } from './payment-display'

export function PaymentStatusBadge({ status }: { status: PaymentStatus }): React.JSX.Element {
  return (
    <Badge variant={status === 'POSTED' ? 'success' : 'secondary'}>
      {PAYMENT_STATUS_LABELS[status]}
    </Badge>
  )
}
