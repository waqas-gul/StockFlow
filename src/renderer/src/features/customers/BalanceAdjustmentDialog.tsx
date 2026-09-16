import { zodResolver } from '@hookform/resolvers/zod'
import { LoaderCircle } from 'lucide-react'
import { Controller, useForm, useWatch, type FieldPath } from 'react-hook-form'
import { toast } from 'sonner'
import { LEDGER_REASON_MAX, type BalanceAdjustmentResult, type Customer } from '@shared/customers'
import { formatDisplayDate, localDateString } from '@shared/dates'
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
import type { CurrencyFormat } from '../products/product-display'
import {
  adjustmentBalancePreview,
  balanceAdjustmentFormSchema,
  emptyBalanceAdjustmentForm,
  toBalanceAdjustmentInput,
  type BalanceAdjustmentDraft,
  type BalanceAdjustmentFormValues
} from './balance-adjustment-form'
import { submitBalanceAdjustment, type CustomerNotifier } from './customer-actions'
import { balanceClassName, balanceText } from './customer-display'
import { FormField } from './FormField'

const notify: CustomerNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

/** Adjust Balance: an account correction for one customer. */
export function BalanceAdjustmentDialog({
  open,
  customer,
  currency,
  onSaved,
  onClose
}: {
  open: boolean
  customer: Customer
  currency: CurrencyFormat
  onSaved: (result: BalanceAdjustmentResult) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-[min(40rem,calc(100%-2rem))]"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Adjust Balance</DialogTitle>
          <DialogDescription>
            Correct the account of {customer.code} {customer.name}. This is not a payment: use
            Receive Payment for money received.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <BalanceAdjustmentForm
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

export function BalanceAdjustmentForm({
  customer,
  currency,
  today,
  onSaved,
  onCancel
}: {
  customer: Customer
  currency: CurrencyFormat
  today: string
  onSaved: (result: BalanceAdjustmentResult) => void
  onCancel: () => void
}): React.JSX.Element {
  const form = useForm<BalanceAdjustmentFormValues, unknown, BalanceAdjustmentDraft>({
    resolver: zodResolver(balanceAdjustmentFormSchema(currency.minorDigits)),
    defaultValues: emptyBalanceAdjustmentForm(today),
    mode: 'onTouched'
  })
  const { control, register, handleSubmit, setError, formState } = form
  const { errors } = formState
  const saving = formState.isSubmitting
  const [direction, amount] = useWatch({ control, name: ['direction', 'amount'] })
  const after = adjustmentBalancePreview(
    customer.balanceMinor,
    { direction, amount },
    currency.minorDigits
  )

  const onSubmit = handleSubmit(async (draft) => {
    await submitBalanceAdjustment(
      window.api.customers,
      toBalanceAdjustmentInput(draft, customer.id, currency.minorDigits),
      {
        onSaved,
        onFieldError: (path, message) =>
          setError(path as FieldPath<BalanceAdjustmentFormValues>, { type: 'server', message }),
        notify,
        currency
      }
    )
  })

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label id="adjust-direction-label">Adjustment</Label>
        <Controller
          control={control}
          name="direction"
          render={({ field }) => (
            <RadioGroup
              aria-labelledby="adjust-direction-label"
              value={field.value}
              onValueChange={(value) => value !== '' && field.onChange(value)}
              className="gap-2"
            >
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="INCREASE" />
                Increase — the customer owes more
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="DECREASE" />
                Decrease — the customer owes less
              </label>
            </RadioGroup>
          )}
        />
        {errors.direction?.message && (
          <p className="text-sm text-destructive">{errors.direction.message}</p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="adjust-amount" label="Amount" error={errors.amount?.message}>
          <Input
            id="adjust-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            className="text-right tabular-nums"
            aria-invalid={errors.amount ? true : undefined}
            {...register('amount')}
          />
        </FormField>
        <FormField
          id="adjust-date"
          label="Date"
          error={errors.entryDate?.message}
          hint={
            customer.latestEntryDate
              ? `Earliest allowed: ${formatDisplayDate(customer.latestEntryDate)} (the latest account entry).`
              : 'Today or earlier.'
          }
        >
          <Input
            id="adjust-date"
            type="date"
            min={customer.latestEntryDate ?? undefined}
            max={today}
            aria-invalid={errors.entryDate ? true : undefined}
            {...register('entryDate')}
          />
        </FormField>
      </div>
      <FormField
        id="adjust-reason"
        label="Reason"
        error={errors.reason?.message}
        hint="Required. Kept in the account ledger."
      >
        <Input
          id="adjust-reason"
          maxLength={LEDGER_REASON_MAX}
          autoComplete="off"
          aria-invalid={errors.reason ? true : undefined}
          {...register('reason')}
        />
      </FormField>

      <BalanceChange before={customer.balanceMinor} after={after} currency={currency} />
      {!customer.isActive && (
        <p className="text-sm text-muted-foreground">
          This customer is inactive. The correction is recorded; the customer stays inactive.
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

/** "Current balance … / Balance after …". */
export function BalanceChange({
  before,
  after,
  currency,
  children
}: {
  before: number
  after: number | null
  currency: CurrencyFormat
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <dl className="grid gap-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Current balance</dt>
        <dd className={`font-medium tabular-nums ${balanceClassName(before)}`}>
          {balanceText(before, currency)}
        </dd>
      </div>
      {children}
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Balance after</dt>
        <dd className={`font-medium tabular-nums ${after === null ? '' : balanceClassName(after)}`}>
          {after === null ? '—' : balanceText(after, currency)}
        </dd>
      </div>
    </dl>
  )
}
