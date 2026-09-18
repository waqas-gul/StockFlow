import { zodResolver } from '@hookform/resolvers/zod'
import { LoaderCircle } from 'lucide-react'
import { Controller, useForm, useWatch, type FieldPath } from 'react-hook-form'
import { toast } from 'sonner'
import { formatDisplayDate, localDateString } from '@shared/dates'
import {
  SUPPLIER_REASON_MAX,
  type Supplier,
  type SupplierBalanceAdjustmentResult
} from '@shared/suppliers'
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
import { RadioGroup, RadioGroupItem } from '@renderer/components/ui/radio-group'
import { FormField } from '../customers/FormField'
import type { CurrencyFormat } from '../products/product-display'
import { submitSupplierAdjustment, type SupplierNotifier } from './supplier-actions'
import { supplierBalanceClassName, supplierBalanceText, supplierLabel } from './supplier-display'
import {
  emptySupplierAdjustmentForm,
  supplierAdjustmentFormSchema,
  supplierAdjustmentPreview,
  toSupplierAdjustmentInput,
  type SupplierAdjustmentDraft,
  type SupplierAdjustmentFormValues
} from './supplier-form'

const notify: SupplierNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

/** Adjust Balance: an account correction for one supplier (e.g. a changed supplier bill). */
export function SupplierAdjustmentDialog({
  open,
  supplier,
  currency,
  onSaved,
  onClose
}: {
  open: boolean
  supplier: Supplier
  currency: CurrencyFormat
  onSaved: (result: SupplierBalanceAdjustmentResult) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-[min(40rem,calc(100%-2rem))]"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Adjust Supplier Balance</DialogTitle>
          <DialogDescription>
            Correct the account of {supplierLabel(supplier)}, for example when a supplier bill
            changed. This is not a payment: use Pay Supplier for money paid. It does not change
            stock.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <SupplierAdjustmentForm
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

export function SupplierAdjustmentForm({
  supplier,
  currency,
  today,
  onSaved,
  onCancel
}: {
  supplier: Supplier
  currency: CurrencyFormat
  today: string
  onSaved: (result: SupplierBalanceAdjustmentResult) => void
  onCancel: () => void
}): React.JSX.Element {
  const form = useForm<SupplierAdjustmentFormValues, unknown, SupplierAdjustmentDraft>({
    resolver: zodResolver(supplierAdjustmentFormSchema(currency.minorDigits)),
    defaultValues: emptySupplierAdjustmentForm(today),
    mode: 'onTouched'
  })
  const { control, register, handleSubmit, setError, formState } = form
  const { errors } = formState
  const saving = formState.isSubmitting
  const [direction, amount] = useWatch({ control, name: ['direction', 'amount'] })
  const after = supplierAdjustmentPreview(
    supplier.balanceMinor,
    { direction, amount },
    currency.minorDigits
  )

  const onSubmit = handleSubmit(async (draft) => {
    await submitSupplierAdjustment(
      window.api.suppliers,
      toSupplierAdjustmentInput(draft, supplier.id, currency.minorDigits),
      {
        onSaved,
        onFieldError: (path, message) =>
          setError(path as FieldPath<SupplierAdjustmentFormValues>, { type: 'server', message }),
        notify,
        currency
      }
    )
  })

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label id="supplier-adjust-direction-label">Adjustment</Label>
        <Controller
          control={control}
          name="direction"
          render={({ field }) => (
            <RadioGroup
              aria-labelledby="supplier-adjust-direction-label"
              value={field.value}
              onValueChange={(value) => value !== '' && field.onChange(value)}
              className="gap-2"
            >
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="INCREASE" />
                Increase — the shop owes the supplier more
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="DECREASE" />
                Decrease — the shop owes less (or the supplier advance grows)
              </label>
            </RadioGroup>
          )}
        />
        {errors.direction?.message && (
          <p className="text-sm text-destructive">{errors.direction.message}</p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="supplier-adjust-amount" label="Amount" error={errors.amount?.message}>
          <Input
            id="supplier-adjust-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            className="text-right tabular-nums"
            aria-invalid={errors.amount ? true : undefined}
            {...register('amount')}
          />
        </FormField>
        <FormField
          id="supplier-adjust-date"
          label="Date"
          error={errors.entryDate?.message}
          hint={
            supplier.latestEntryDate
              ? `Earliest allowed: ${formatDisplayDate(supplier.latestEntryDate)} (the latest account entry).`
              : 'Today or earlier.'
          }
        >
          <Input
            id="supplier-adjust-date"
            type="date"
            min={supplier.latestEntryDate ?? undefined}
            max={today}
            aria-invalid={errors.entryDate ? true : undefined}
            {...register('entryDate')}
          />
        </FormField>
      </div>
      <FormField
        id="supplier-adjust-reason"
        label="Reason"
        error={errors.reason?.message}
        hint="Required. Kept in the supplier ledger."
      >
        <Input
          id="supplier-adjust-reason"
          maxLength={SUPPLIER_REASON_MAX}
          autoComplete="off"
          aria-invalid={errors.reason ? true : undefined}
          {...register('reason')}
        />
      </FormField>

      <dl className="grid gap-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Current balance</dt>
          <dd
            className={`font-medium tabular-nums ${supplierBalanceClassName(supplier.balanceMinor)}`}
          >
            {supplierBalanceText(supplier.balanceMinor, currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Balance after</dt>
          <dd
            className={`font-medium tabular-nums ${after === null ? '' : supplierBalanceClassName(after)}`}
          >
            {after === null ? '—' : supplierBalanceText(after, currency)}
          </dd>
        </div>
      </dl>
      {!supplier.isActive && (
        <p className="text-sm text-muted-foreground">
          This supplier is inactive. The correction is recorded; the supplier stays inactive.
        </p>
      )}
      {errors.root?.message && <p className="text-sm text-destructive">{errors.root.message}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <LoaderCircle className="animate-spin" aria-hidden />}
          {saving ? 'Saving…' : 'Save Adjustment'}
        </Button>
      </div>
    </form>
  )
}
