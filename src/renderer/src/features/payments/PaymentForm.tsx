import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { Controller, useForm, useWatch, type FieldPath } from 'react-hook-form'
import { toast } from 'sonner'
import type { Customer } from '@shared/customers'
import { formatDisplayDate } from '@shared/dates'
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_NOTE_MAX,
  PAYMENT_REFERENCE_MAX,
  type PaymentSaveResult,
  type PaymentSummary
} from '@shared/payments'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { customerQuery, refreshAfterCustomerChange } from '@renderer/lib/app-queries'
import { newRequestId } from '../stock/stock-actions'
import { CustomerPicker } from '../customers/CustomerPicker'
import { FormField } from '../customers/FormField'
import { customerLabel } from '../customers/customer-display'
import type { CurrencyFormat } from '../products/product-display'
import { DuplicatePaymentWarning } from './DuplicatePaymentWarning'
import { submitPayment, type PaymentNotifier } from './payment-actions'
import {
  emptyPaymentForm,
  paymentFormSchema,
  toPaymentInput,
  withCustomer,
  type PaymentDraft,
  type PaymentFormValues
} from './payment-form'
import { PaymentPreviewPanel } from './PaymentPreviewPanel'

const notify: PaymentNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

interface PendingDuplicate {
  readonly duplicates: readonly PaymentSummary[]
  readonly answer: (proceed: boolean) => void
}

export interface PaymentFormProps {
  /** The customer the payment is from; null lets the operator choose an active customer. */
  readonly customer: Customer | null
  readonly currency: CurrencyFormat
  /** The local calendar day, for the default date. */
  readonly today: string
  readonly onSaved: (payment: PaymentSaveResult) => void
  readonly onCancel: () => void
}

/** Receive Payment: posts one payment receipt, with the balance preview and the soft duplicate warning. */
export function PaymentForm({
  customer: fixedCustomer,
  currency,
  today,
  onSaved,
  onCancel
}: PaymentFormProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const form = useForm<PaymentFormValues, unknown, PaymentDraft>({
    resolver: zodResolver(paymentFormSchema(currency.minorDigits)),
    defaultValues:
      fixedCustomer === null
        ? emptyPaymentForm(today)
        : withCustomer(emptyPaymentForm(today), fixedCustomer),
    mode: 'onTouched'
  })
  const { control, register, handleSubmit, setError, setValue, formState } = form
  const { errors } = formState
  // One id per submission: a retry after a lost answer returns the payment already saved.
  const [requestId, setRequestId] = useState(newRequestId)
  const [pending, setPending] = useState<PendingDuplicate | null>(null)
  const saving = formState.isSubmitting

  const [customerId, customerText, amount] = useWatch({
    control,
    name: ['customerId', 'customerLabel', 'amount']
  })
  const chosen = useQuery({ ...customerQuery(customerId ?? 0), enabled: customerId !== null })
  const customer = chosen.data ?? (fixedCustomer?.id === customerId ? fixedCustomer : null)

  const onSubmit = handleSubmit(async (draft) => {
    const outcome = await submitPayment(
      window.api.payments,
      toPaymentInput(draft, requestId, currency.minorDigits),
      {
        confirmDuplicate: (duplicates) =>
          new Promise<boolean>((resolve) =>
            setPending({
              duplicates,
              answer: (proceed) => {
                setPending(null)
                resolve(proceed)
              }
            })
          ),
        onSaved: (payment) => {
          setRequestId(newRequestId())
          refreshAfterCustomerChange(queryClient)
          onSaved(payment)
        },
        onFieldError: (path, message) =>
          setError(path as FieldPath<PaymentFormValues>, { type: 'server', message }),
        notify,
        currency
      }
    )
    if (outcome === 'failed') {
      // The balance or posting-date floor may have changed: read the customer again.
      void chosen.refetch()
    }
  })

  const formElement = (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="payment-customer">Customer</Label>
        {fixedCustomer === null ? (
          <CustomerPicker
            id="payment-customer"
            ariaLabel="Customer"
            label={customerText}
            invalid={errors.customerId !== undefined}
            onPick={(item) => {
              setValue('customerId', item.id, { shouldValidate: true, shouldDirty: true })
              setValue('customerLabel', customerLabel(item), { shouldDirty: true })
            }}
          />
        ) : (
          <p id="payment-customer" className="text-sm font-medium">
            {customerLabel(fixedCustomer)}
          </p>
        )}
        {errors.customerId?.message && (
          <p className="text-sm text-destructive">{errors.customerId.message}</p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id="payment-date"
          label="Date"
          error={errors.paymentDate?.message}
          hint={
            customer?.latestEntryDate
              ? `Earliest allowed: ${formatDisplayDate(customer.latestEntryDate)} (the latest account entry).`
              : 'Today or earlier.'
          }
        >
          <Input
            id="payment-date"
            type="date"
            min={customer?.latestEntryDate ?? undefined}
            max={today}
            aria-invalid={errors.paymentDate ? true : undefined}
            {...register('paymentDate')}
          />
        </FormField>
        <FormField id="payment-amount" label="Amount" error={errors.amount?.message}>
          <Input
            id="payment-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            className="text-right tabular-nums"
            aria-invalid={errors.amount ? true : undefined}
            {...register('amount')}
          />
        </FormField>
        <div className="grid content-start gap-1.5">
          <Label htmlFor="payment-method">Method</Label>
          <Controller
            control={control}
            name="method"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(value) => {
                  // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
                  if (value !== '') field.onChange(value)
                }}
              >
                <SelectTrigger id="payment-method" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((method) => (
                    <SelectItem key={method} value={method}>
                      {PAYMENT_METHOD_LABELS[method]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <FormField
          id="payment-reference"
          label="Reference"
          error={errors.reference?.message}
          hint="Cheque, transfer or slip number. Optional."
        >
          <Input
            id="payment-reference"
            maxLength={PAYMENT_REFERENCE_MAX}
            autoComplete="off"
            {...register('reference')}
          />
        </FormField>
      </div>
      <FormField id="payment-note" label="Note" error={errors.note?.message} hint="Optional.">
        <Input
          id="payment-note"
          maxLength={PAYMENT_NOTE_MAX}
          autoComplete="off"
          {...register('note')}
        />
      </FormField>

      {customer !== null && (
        <PaymentPreviewPanel
          balanceMinor={customer.balanceMinor}
          amount={amount}
          currency={currency}
        />
      )}
      {errors.root?.message && <p className="text-sm text-destructive">{errors.root.message}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <LoaderCircle className="animate-spin" aria-hidden />}
          {saving ? 'Saving…' : 'Save Payment'}
        </Button>
      </div>
    </form>
  )

  return (
    <>
      {formElement}
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && pending?.answer(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Possible duplicate payment</AlertDialogTitle>
            <AlertDialogDescription>Check before saving this payment.</AlertDialogDescription>
          </AlertDialogHeader>
          {pending && (
            <DuplicatePaymentWarning
              duplicates={pending.duplicates}
              currency={currency}
              onCancel={() => pending.answer(false)}
              onContinue={() => pending.answer(true)}
            />
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
