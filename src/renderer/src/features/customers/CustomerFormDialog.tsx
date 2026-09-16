import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { Controller, useForm, useWatch, type FieldPath, type UseFormReturn } from 'react-hook-form'
import { toast } from 'sonner'
import {
  ADDRESS_MAX,
  CITY_MAX,
  CUSTOMER_NAME_MAX,
  CUSTOMER_NOTES_MAX,
  PHONE_MAX,
  SHOP_NAME_MAX,
  type Customer
} from '@shared/customers'
import { localDateString } from '@shared/dates'
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
import { customerQuery } from '@renderer/lib/app-queries'
import type { CurrencyFormat } from '../products/product-display'
import { saveCustomer, type CustomerNotifier } from './customer-actions'
import { balanceClassName, balanceText } from './customer-display'
import {
  customerFormSchema,
  customerFormValues,
  emptyCustomerForm,
  openingBalancePreview,
  toCustomerCreateInput,
  toCustomerUpdateInput,
  type CustomerDraft,
  type CustomerFormValues
} from './customer-form'
import { FormField } from './FormField'

const notify: CustomerNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

export type CustomerEditorTarget =
  { readonly mode: 'create' } | { readonly mode: 'edit'; readonly id: number }

/** Add or edit a customer. The customer being edited is read fresh. */
export function CustomerFormDialog({
  target,
  currency,
  onSaved,
  onClose
}: {
  target: CustomerEditorTarget | null
  currency: CurrencyFormat
  onSaved: (customer: Customer) => void
  onClose: () => void
}): React.JSX.Element {
  const editId = target?.mode === 'edit' ? target.id : null
  const customer = useQuery({ ...customerQuery(editId ?? 0), enabled: editId !== null })
  const today = localDateString(new Date())

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-[min(48rem,calc(100%-2rem))]"
        // A stray click outside must not discard what was typed.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{editId === null ? 'Add Customer' : 'Edit Customer'}</DialogTitle>
          <DialogDescription>
            {editId === null
              ? 'Enter the customer and, if the account already has a balance, the opening balance.'
              : 'Change the customer profile. The account history is not changed.'}
          </DialogDescription>
        </DialogHeader>
        {target === null ? null : editId === null ? (
          <CustomerForm
            customer={null}
            currency={currency}
            today={today}
            onSaved={onSaved}
            onCancel={onClose}
          />
        ) : customer.data ? (
          <CustomerForm
            key={`${customer.data.id}-${customer.data.updatedAt}`}
            customer={customer.data}
            currency={currency}
            today={today}
            onSaved={onSaved}
            onCancel={onClose}
          />
        ) : (
          <p className={`text-sm ${customer.error ? 'text-destructive' : 'text-muted-foreground'}`}>
            {customer.error ? customer.error.message : 'Loading…'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

export interface CustomerFormProps {
  /** The customer being edited; null to add one. */
  readonly customer: Customer | null
  readonly currency: CurrencyFormat
  readonly today: string
  readonly onSaved: (customer: Customer) => void
  readonly onCancel: () => void
}

/** The profile fields, and on Add the opening balance: an amount, who owes whom, and its date. */
export function CustomerForm({
  customer,
  currency,
  today,
  onSaved,
  onCancel
}: CustomerFormProps): React.JSX.Element {
  const form = useForm<CustomerFormValues, unknown, CustomerDraft>({
    resolver: zodResolver(customerFormSchema(currency.minorDigits)),
    defaultValues:
      customer === null ? emptyCustomerForm(today) : customerFormValues(customer, today),
    mode: 'onTouched'
  })
  const { control, register, handleSubmit, setError, formState } = form
  const { errors } = formState
  const saving = formState.isSubmitting

  const onSubmit = handleSubmit(async (draft) => {
    await saveCustomer(
      window.api.customers,
      customer === null
        ? { mode: 'create', input: toCustomerCreateInput(draft, currency.minorDigits) }
        : { mode: 'update', input: toCustomerUpdateInput(customer.id, draft) },
      {
        onSaved,
        onFieldError: (path, message) =>
          setError(path as FieldPath<CustomerFormValues>, { type: 'server', message }),
        notify
      }
    )
  })

  const text = (
    name: 'name' | 'shopName' | 'phone' | 'address' | 'city' | 'notes',
    label: string,
    max: number,
    hint?: string
  ): React.JSX.Element => (
    <FormField id={`customer-${name}`} label={label} error={errors[name]?.message} hint={hint}>
      <Input
        id={`customer-${name}`}
        maxLength={max}
        autoComplete="off"
        aria-invalid={errors[name] ? true : undefined}
        {...register(name)}
      />
    </FormField>
  )

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {text('name', 'Name', CUSTOMER_NAME_MAX)}
        {text('shopName', 'Shop Name', SHOP_NAME_MAX, 'Optional.')}
        {text('phone', 'Phone', PHONE_MAX, 'Optional.')}
        {text('city', 'City', CITY_MAX, 'Optional.')}
        <div className="sm:col-span-2">{text('address', 'Address', ADDRESS_MAX, 'Optional.')}</div>
        <div className="sm:col-span-2">
          {text('notes', 'Notes', CUSTOMER_NOTES_MAX, 'Optional.')}
        </div>
      </div>

      {customer === null ? (
        <fieldset className="flex flex-col gap-3 rounded-md border p-4">
          <legend className="px-1 text-sm font-semibold">Opening Balance</legend>
          <p className="text-xs text-muted-foreground">
            Only if the account already has a balance when you start using StockFlow. Leave the
            amount empty for none. It can be entered only now; later corrections use Adjust Balance.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              id="openingAmount"
              label="Amount"
              error={errors.openingAmount?.message}
              hint="For example 5000 or 5,000.50."
            >
              <Input
                id="openingAmount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                className="text-right tabular-nums"
                aria-invalid={errors.openingAmount ? true : undefined}
                {...register('openingAmount')}
              />
            </FormField>
            <div className="grid content-start gap-2">
              <Label id="openingSide-label">Balance type</Label>
              <Controller
                control={control}
                name="openingSide"
                render={({ field }) => (
                  <RadioGroup
                    aria-labelledby="openingSide-label"
                    value={field.value}
                    onValueChange={(value) => value !== '' && field.onChange(value)}
                    className="gap-2"
                  >
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="DUE" />
                      Customer owes us
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="ADVANCE" />
                      Customer advance
                    </label>
                  </RadioGroup>
                )}
              />
            </div>
            <FormField
              id="openingDate"
              label="Opening date"
              error={errors.openingDate?.message}
              hint="Today or earlier."
            >
              <Input
                id="openingDate"
                type="date"
                max={today}
                aria-invalid={errors.openingDate ? true : undefined}
                {...register('openingDate')}
              />
            </FormField>
          </div>
          <OpeningPreview form={form} currency={currency} />
        </fieldset>
      ) : (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          The opening balance cannot be changed here. Use Adjust Balance on the customer page.
        </p>
      )}

      {errors.root?.message && <p className="text-sm text-destructive">{errors.root.message}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <LoaderCircle className="animate-spin" aria-hidden />}
          {saving ? 'Saving…' : customer === null ? 'Save Customer' : 'Save Changes'}
        </Button>
      </div>
    </form>
  )
}

function OpeningPreview({
  form,
  currency
}: {
  form: UseFormReturn<CustomerFormValues, unknown, CustomerDraft>
  currency: CurrencyFormat
}): React.JSX.Element | null {
  const [openingAmount, openingSide] = useWatch({
    control: form.control,
    name: ['openingAmount', 'openingSide']
  })
  const opening = openingBalancePreview({ openingAmount, openingSide }, currency.minorDigits)
  if (opening === null) return null
  return (
    <p className="text-sm">
      {opening === 0 ? (
        <span className="text-muted-foreground">No opening balance.</span>
      ) : (
        <>
          Opening balance:{' '}
          <span className={`font-medium ${balanceClassName(opening)}`}>
            {balanceText(opening, currency)}
          </span>
        </>
      )}
    </p>
  )
}
