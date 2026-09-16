import type { Customer } from '@shared/customers'
import { localDateString } from '@shared/dates'
import type { PaymentSaveResult } from '@shared/payments'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import type { CurrencyFormat } from '../products/product-display'
import { PaymentForm } from './PaymentForm'

/** Receive Payment, for a given customer (customer page) or any active customer (Payments page). */
export function ReceivePaymentDialog({
  open,
  customer,
  currency,
  onSaved,
  onClose
}: {
  open: boolean
  customer: Customer | null
  currency: CurrencyFormat
  onSaved: (payment: PaymentSaveResult) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-[min(44rem,calc(100%-2rem))]"
        // A stray click outside must not discard what was typed.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Receive Payment</DialogTitle>
          <DialogDescription>
            Money received from a customer. It reduces the balance at once; more than the customer
            owes becomes an advance.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <PaymentForm
            customer={customer}
            currency={currency}
            today={localDateString(new Date())}
            onSaved={onSaved}
            onCancel={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
