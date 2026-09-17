import { EXPENSE_STATUS_LABELS, type ExpenseStatus } from '@shared/expenses'
import { Badge } from '@renderer/components/ui/badge'

export function ExpenseStatusBadge({ status }: { status: ExpenseStatus }): React.JSX.Element {
  return (
    <Badge variant={status === 'ACTIVE' ? 'success' : 'secondary'}>
      {EXPENSE_STATUS_LABELS[status]}
    </Badge>
  )
}
