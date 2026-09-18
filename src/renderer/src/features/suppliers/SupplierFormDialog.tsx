import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { Controller, useForm, useWatch, type FieldPath, type UseFormReturn } from 'react-hook-form'
import { toast } from 'sonner'
import { localDateString } from '@shared/dates'
import {
  CONTACT_PERSON_MAX,
  SUPPLIER_ADDRESS_MAX,
  SUPPLIER_CITY_MAX,
  SUPPLIER_NAME_MAX,
  SUPPLIER_NOTES_MAX,
  SUPPLIER_PHONE_MAX,
  type Supplier
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
import { supplierQuery } from '@renderer/lib/app-queries'
import { FormField } from '../customers/FormField'
import type { CurrencyFormat } from '../products/product-display'
import { saveSupplier, type SupplierNotifier } from './supplier-actions'
import { supplierBalanceClassName, supplierBalanceText } from './supplier-display'
import {
  emptySupplierForm,
  supplierFormSchema,
  supplierFormValues,
  supplierOpeningPreview,
  toSupplierCreateInput,
  toSupplierUpdateInput,
  type SupplierDraft,
  type SupplierFormValues
} from './supplier-form'

const notify: SupplierNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

export type SupplierEditorTarget =
  { readonly mode: 'create' } | { readonly mode: 'edit'; readonly id: number }

/** Add or edit a supplier. The supplier being edited is read fresh. */
export function SupplierFormDialog({
  target,
  currency,
  onSaved,
  onClose
}: {
  target: SupplierEditorTarget | null
  currency: CurrencyFormat
  onSaved: (supplier: Supplier) => void
  onClose: () => void
}): React.JSX.Element {
  const editId = target?.mode === 'edit' ? target.id : null
  const supplier = useQuery({ ...supplierQuery(editId ?? 0), enabled: editId !== null })
  const today = localDateString(new Date())

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-[min(48rem,calc(100%-2rem))]"
        // A stray click outside must not discard what was typed.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{editId === null ? 'Add Supplier' : 'Edit Supplier'}</DialogTitle>
          <DialogDescription>
            {editId === null
              ? 'A supplier is someone you buy stock from. If you already owe them money, enter it as the opening balance.'
              : 'Change the supplier profile. The account history is not changed.'}
          </DialogDescription>
        </DialogHeader>
        {target === null ? null : editId === null ? (
          <SupplierForm
            supplier={null}
            currency={currency}
            today={today}
            onSaved={onSaved}
            onCancel={onClose}
          />
        ) : supplier.data ? (
          <SupplierForm
            key={`${supplier.data.id}-${supplier.data.updatedAt}`}
            supplier={supplier.data}
            currency={currency}
            today={today}
            onSaved={onSaved}
            onCancel={onClose}
          />
        ) : (
          <p className={`text-sm ${supplier.error ? 'text-destructive' : 'text-muted-foreground'}`}>
            {supplier.error ? supplier.error.message : 'Loading…'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

export interface SupplierFormProps {
  /** The supplier being edited; null to add one. */
  readonly supplier: Supplier | null
  readonly currency: CurrencyFormat
  readonly today: string
  readonly onSaved: (supplier: Supplier) => void
  readonly onCancel: () => void
}

/** The profile fields, and on Add the opening balance: an amount, who owes whom, and its date. */
export function SupplierForm({
  supplier,
  currency,
  today,
  onSaved,
  onCancel
}: SupplierFormProps): React.JSX.Element {
  const form = useForm<SupplierFormValues, unknown, SupplierDraft>({
    resolver: zodResolver(supplierFormSchema(currency.minorDigits)),
    defaultValues:
      supplier === null ? emptySupplierForm(today) : supplierFormValues(supplier, today),
    mode: 'onTouched'
  })
  const { control, register, handleSubmit, setError, formState } = form
  const { errors } = formState
  const saving = formState.isSubmitting

  const onSubmit = handleSubmit(async (draft) => {
    await saveSupplier(
      window.api.suppliers,
      supplier === null
        ? { mode: 'create', input: toSupplierCreateInput(draft, currency.minorDigits) }
        : { mode: 'update', input: toSupplierUpdateInput(supplier.id, draft) },
      {
        onSaved,
        onFieldError: (path, message) =>
          setError(path as FieldPath<SupplierFormValues>, { type: 'server', message }),
        notify
      }
    )
  })

  const text = (
    name: 'name' | 'contactPerson' | 'phone' | 'address' | 'city' | 'notes',
    label: string,
    max: number,
    hint?: string
  ): React.JSX.Element => (
    <FormField id={`supplier-${name}`} label={label} error={errors[name]?.message} hint={hint}>
      <Input
        id={`supplier-${name}`}
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
        {text('name', 'Name', SUPPLIER_NAME_MAX)}
        {text('contactPerson', 'Contact Person', CONTACT_PERSON_MAX, 'Optional.')}
        {text('phone', 'Phone', SUPPLIER_PHONE_MAX, 'Optional.')}
        {text('city', 'City', SUPPLIER_CITY_MAX, 'Optional.')}
        <div className="sm:col-span-2">
          {text('address', 'Address', SUPPLIER_ADDRESS_MAX, 'Optional.')}
        </div>
        <div className="sm:col-span-2">
          {text('notes', 'Notes', SUPPLIER_NOTES_MAX, 'Optional.')}
        </div>
      </div>

      {supplier === null ? (
        <fieldset className="flex flex-col gap-3 rounded-md border p-4">
          <legend className="px-1 text-sm font-semibold">Opening Balance</legend>
          <p className="text-xs text-muted-foreground">
            Only if the account already has a balance when you start using StockFlow: enter what you
            owe this supplier today, after any payments made outside StockFlow. Leave the amount
            empty for none. It can be entered only now; later corrections use Adjust Balance.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              id="supplierOpeningAmount"
              label="Amount"
              error={errors.openingAmount?.message}
              hint="For example 10000 or 10,000.50."
            >
              <Input
                id="supplierOpeningAmount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                className="text-right tabular-nums"
                aria-invalid={errors.openingAmount ? true : undefined}
                {...register('openingAmount')}
              />
            </FormField>
            <div className="grid content-start gap-2">
              <Label id="supplierOpeningSide-label">Balance type</Label>
              <Controller
                control={control}
                name="openingSide"
                render={({ field }) => (
                  <RadioGroup
                    aria-labelledby="supplierOpeningSide-label"
                    value={field.value}
                    onValueChange={(value) => value !== '' && field.onChange(value)}
                    className="gap-2"
                  >
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="DUE" />
                      We owe supplier
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="ADVANCE" />
                      Supplier advance
                    </label>
                  </RadioGroup>
                )}
              />
            </div>
            <FormField
              id="supplierOpeningDate"
              label="Opening date"
              error={errors.openingDate?.message}
              hint="Today or earlier."
            >
              <Input
                id="supplierOpeningDate"
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
          The opening balance cannot be changed here. Use Adjust Balance on the supplier page.
        </p>
      )}

      {errors.root?.message && <p className="text-sm text-destructive">{errors.root.message}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <LoaderCircle className="animate-spin" aria-hidden />}
          {saving ? 'Saving…' : supplier === null ? 'Save Supplier' : 'Save Changes'}
        </Button>
      </div>
    </form>
  )
}

function OpeningPreview({
  form,
  currency
}: {
  form: UseFormReturn<SupplierFormValues, unknown, SupplierDraft>
  currency: CurrencyFormat
}): React.JSX.Element | null {
  const [openingAmount, openingSide] = useWatch({
    control: form.control,
    name: ['openingAmount', 'openingSide']
  })
  const opening = supplierOpeningPreview({ openingAmount, openingSide }, currency.minorDigits)
  if (opening === null) return null
  return (
    <p className="text-sm">
      {opening === 0 ? (
        <span className="text-muted-foreground">No opening balance.</span>
      ) : (
        <>
          Opening balance:{' '}
          <span className={`font-medium ${supplierBalanceClassName(opening)}`}>
            {supplierBalanceText(opening, currency)}
          </span>
        </>
      )}
    </p>
  )
}
