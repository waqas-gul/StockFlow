import { useState } from 'react'
import { Ban, LoaderCircle } from 'lucide-react'
import { formatDisplayDate } from '@shared/dates'
import { EXPENSE_GROUP_LABELS, type Expense } from '@shared/expenses'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { singleFlight } from '@renderer/lib/single-flight'
import { formatAmount, type CurrencyFormat } from '../products/product-display'

/** Void Expense: the confirmation. The expense stays in the list as void; nothing is deleted. */
export function VoidExpenseDialog({
  expense,
  currency,
  onConfirm,
  onClose
}: {
  /** The expense to void; null when the dialog is closed. */
  expense: Expense | null
  currency: CurrencyFormat
  /** Sends the void; resolves true once it is done (the caller shows the messages). */
  onConfirm: (expense: Expense) => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  // One void at a time: a double click sends it once.
  const [confirm] = useState(() =>
    singleFlight(async (target: Expense) => {
      setBusy(true)
      try {
        if (await onConfirm(target)) onClose()
      } finally {
        setBusy(false)
      }
    })
  )

  return (
    <AlertDialog open={expense !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Void this expense?</AlertDialogTitle>
          <AlertDialogDescription>Check the expense before voiding it.</AlertDialogDescription>
        </AlertDialogHeader>
        {expense !== null && <VoidExpenseDetails expense={expense} currency={currency} />}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy || expense === null}
            onClick={() => expense !== null && void confirm(expense)}
          >
            {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <Ban aria-hidden />}
            {busy ? 'Voiding…' : 'Void Expense'}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function VoidExpenseDetails({
  expense,
  currency
}: {
  expense: Expense
  currency: CurrencyFormat
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Date</dt>
        <dd>{formatDisplayDate(expense.expenseDate)}</dd>
        <dt className="text-muted-foreground">Category</dt>
        <dd>
          {expense.categoryName} ({EXPENSE_GROUP_LABELS[expense.categoryGroup]})
        </dd>
        <dt className="text-muted-foreground">Amount</dt>
        <dd className="font-medium tabular-nums">{formatAmount(expense.amountMinor, currency)}</dd>
        <dt className="text-muted-foreground">Description</dt>
        <dd className="whitespace-normal">{expense.description ?? '—'}</dd>
      </dl>
      <p className="text-muted-foreground">
        The expense stays in the list as void and no longer counts in the totals. It cannot be
        edited or restored.
      </p>
    </div>
  )
}
