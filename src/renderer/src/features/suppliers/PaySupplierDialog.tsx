import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { Controller, useForm, useWatch, type FieldPath } from 'react-hook-form'
import { toast } from 'sonner'
import { formatDisplayDate, localDateString } from '@shared/dates'
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from '@shared/payments'
import {
  DUPLICATE_SUPPLIER_PAYMENT_WARNING,
  SUPPLIER_PAYMENT_NOTE_MAX,
  SUPPLIER_PAYMENT_REFERENCE_MAX,
  type Supplier,
  type SupplierPaymentSaveResult,
  type SupplierPaymentSummary
} from '@shared/suppliers'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { refreshAfterSupplierChange, supplierQuery } from '@renderer/lib/app-queries'
import { FormField } from '../customers/FormField'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { newRequestId } from '../stock/stock-actions'
import { submitSupplierPayment, type SupplierNotifier } from './supplier-actions'
import { supplierBalanceClassName, supplierBalanceText, supplierLabel } from './supplier-display'
import {
  emptySupplierPaymentForm,
  supplierPaymentFormSchema,
  supplierPaymentPreview,
  toSupplierPaymentInput,
  withSupplier,
  type SupplierPaymentDraft,
  type SupplierPaymentFormValues
} from './supplier-payment-form'
import { SupplierPicker } from './SupplierPicker'

const notify: SupplierNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

interface PendingDuplicate {
  readonly duplicates: readonly SupplierPaymentSummary[]
  readonly answer: (proceed: boolean) => void
}

/** Pay Supplier, for a given supplier (supplier page) or any supplier (Suppliers page, Dashboard). */
export function PaySupplierDialog({
  open,
  supplier,
  currency,
  onSaved,
  onClose
}: {
  open: boolean
  supplier: Supplier | null
  currency: CurrencyFormat
  onSaved: (payment: SupplierPaymentSaveResult) => void
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
          <DialogTitle>Pay Supplier</DialogTitle>
          <DialogDescription>
            Money paid to a supplier. It reduces what the shop owes at once; more than the shop owes
            becomes a supplier advance. A supplier payment is not an expense.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <SupplierPaymentForm
            supplier={supplier}
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

export interface SupplierPaymentFormProps {
  /** The supplier being paid; null lets the owner choose one (inactive ones too: old debts can be settled). */
  readonly supplier: Supplier | null
  readonly currency: CurrencyFormat
  /** The local calendar day, for the default date. */
  readonly today: string
  readonly onSaved: (payment: SupplierPaymentSaveResult) => void
  readonly onCancel: () => void
}

/** Posts one supplier payment, with the balance preview and the soft duplicate warning. */
export function SupplierPaymentForm({
  supplier: fixedSupplier,
  currency,
  today,
  onSaved,
  onCancel
}: SupplierPaymentFormProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const form = useForm<SupplierPaymentFormValues, unknown, SupplierPaymentDraft>({
    resolver: zodResolver(supplierPaymentFormSchema(currency.minorDigits)),
    defaultValues:
      fixedSupplier === null
        ? emptySupplierPaymentForm(today)
        : withSupplier(emptySupplierPaymentForm(today), fixedSupplier),
    mode: 'onTouched'
  })
  const { control, register, handleSubmit, setError, setValue, formState } = form
  const { errors } = formState
  // One id per submission: a double click or a retry after a lost answer returns the payment already saved.
  const [requestId, setRequestId] = useState(newRequestId)
  const [pending, setPending] = useState<PendingDuplicate | null>(null)
  const saving = formState.isSubmitting

  const [supplierId, supplierText, amount] = useWatch({
    control,
    name: ['supplierId', 'supplierLabel', 'amount']
  })
  const chosen = useQuery({ ...supplierQuery(supplierId ?? 0), enabled: supplierId !== null })
  const supplier = chosen.data ?? (fixedSupplier?.id === supplierId ? fixedSupplier : null)

  const onSubmit = handleSubmit(async (draft) => {
    const outcome = await submitSupplierPayment(
      window.api.supplierPayments,
      toSupplierPaymentInput(draft, requestId, currency.minorDigits),
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
          refreshAfterSupplierChange(queryClient)
          onSaved(payment)
        },
        onFieldError: (path, message) =>
          setError(path as FieldPath<SupplierPaymentFormValues>, { type: 'server', message }),
        notify,
        currency
      }
    )
    // The balance or posting-date floor may have changed: read the supplier again.
    if (outcome === 'failed') void chosen.refetch()
  })

  return (
    <>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="supplier-payment-supplier">Supplier</Label>
          {fixedSupplier === null ? (
            <SupplierPicker
              id="supplier-payment-supplier"
              ariaLabel="Supplier"
              includeInactive
              label={supplierText}
              invalid={errors.supplierId !== undefined}
              onPick={(item) => {
                setValue('supplierId', item.id, { shouldValidate: true, shouldDirty: true })
                setValue('supplierLabel', supplierLabel(item), { shouldDirty: true })
              }}
            />
          ) : (
            <p id="supplier-payment-supplier" className="text-sm font-medium">
              {supplierLabel(fixedSupplier)}
            </p>
          )}
          {errors.supplierId?.message && (
            <p className="text-sm text-destructive">{errors.supplierId.message}</p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id="supplier-payment-date"
            label="Payment Date"
            error={errors.paymentDate?.message}
            hint={
              supplier?.latestEntryDate
                ? `Earliest allowed: ${formatDisplayDate(supplier.latestEntryDate)} (the latest account entry).`
                : 'Today or earlier.'
            }
          >
            <Input
              id="supplier-payment-date"
              type="date"
              min={supplier?.latestEntryDate ?? undefined}
              max={today}
              aria-invalid={errors.paymentDate ? true : undefined}
              {...register('paymentDate')}
            />
          </FormField>
          <FormField id="supplier-payment-amount" label="Amount" error={errors.amount?.message}>
            <Input
              id="supplier-payment-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              className="text-right tabular-nums"
              aria-invalid={errors.amount ? true : undefined}
              {...register('amount')}
            />
          </FormField>
          <div className="grid content-start gap-1.5">
            <Label htmlFor="supplier-payment-method">Method</Label>
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
                  <SelectTrigger id="supplier-payment-method" className="w-full">
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
            id="supplier-payment-reference"
            label="Reference"
            error={errors.reference?.message}
            hint="Cheque, transfer or slip number. Optional."
          >
            <Input
              id="supplier-payment-reference"
              maxLength={SUPPLIER_PAYMENT_REFERENCE_MAX}
              autoComplete="off"
              {...register('reference')}
            />
          </FormField>
        </div>
        <FormField
          id="supplier-payment-note"
          label="Note"
          error={errors.note?.message}
          hint="Optional."
        >
          <Input
            id="supplier-payment-note"
            maxLength={SUPPLIER_PAYMENT_NOTE_MAX}
            autoComplete="off"
            {...register('note')}
          />
        </FormField>

        {supplier !== null && (
          <SupplierPaymentPreviewPanel
            balanceMinor={supplier.balanceMinor}
            amount={amount}
            currency={currency}
          />
        )}
        {supplier !== null && !supplier.isActive && (
          <p className="text-sm text-muted-foreground">
            This supplier is inactive. The payment is recorded; the supplier stays inactive.
          </p>
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
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && pending?.answer(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Possible duplicate payment</AlertDialogTitle>
            <AlertDialogDescription>Check before saving this payment.</AlertDialogDescription>
          </AlertDialogHeader>
          {pending && (
            <SupplierDuplicateWarning
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

/** "Current due / This payment / Balance after", and a clear note when the payment creates an advance. */
export function SupplierPaymentPreviewPanel({
  balanceMinor,
  amount,
  currency
}: {
  balanceMinor: number
  amount: string
  currency: CurrencyFormat
}): React.JSX.Element {
  const preview = supplierPaymentPreview(balanceMinor, amount, currency.minorDigits)
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid gap-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Current balance</dt>
          <dd className={`font-medium tabular-nums ${supplierBalanceClassName(balanceMinor)}`}>
            {supplierBalanceText(balanceMinor, currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">This payment</dt>
          <dd className="font-medium tabular-nums">
            {preview.amountMinor === null ? '—' : formatAmount(preview.amountMinor, currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Balance after</dt>
          <dd
            className={`font-medium tabular-nums ${preview.balanceAfterMinor === null ? '' : supplierBalanceClassName(preview.balanceAfterMinor)}`}
          >
            {preview.balanceAfterMinor === null
              ? '—'
              : supplierBalanceText(preview.balanceAfterMinor, currency)}
          </dd>
        </div>
      </dl>
      {preview.advanceMinor !== null && (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {balanceMinor > 0
              ? `This payment is ${formatAmount(preview.advanceMinor, currency)} more than the shop owes. The extra is kept as a supplier advance.`
              : `The shop owes this supplier nothing now, so the whole payment of ${formatAmount(preview.advanceMinor, currency)} is kept as a supplier advance.`}
          </span>
        </p>
      )}
    </div>
  )
}

/** The soft duplicate warning: the similar supplier payments already posted, and Cancel or Continue. */
export function SupplierDuplicateWarning({
  duplicates,
  currency,
  onCancel,
  onContinue
}: {
  duplicates: readonly SupplierPaymentSummary[]
  currency: CurrencyFormat
  onCancel: () => void
  onContinue: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">{DUPLICATE_SUPPLIER_PAYMENT_WARNING}</p>
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
