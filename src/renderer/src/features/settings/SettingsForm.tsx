import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import {
  BUSINESS_ADDRESS_MAX,
  BUSINESS_NAME_MAX,
  CURRENCY_LOCKED_MESSAGE,
  SALESMAN_NAME_MAX,
  SALESMAN_PHONE_MAX,
  START_NUMBER_LOCKED_MESSAGE,
  type EditableSettings,
  type EditableSettingsPatch,
  type SettingsView
} from '@shared/settings'
import { Button } from '@renderer/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@renderer/components/ui/radio-group'
import { Separator } from '@renderer/components/ui/separator'
import { ApiError, unwrap } from '@renderer/lib/api'
import { settingsQuery } from '@renderer/lib/app-queries'
import { queryKeys } from '@renderer/lib/query-keys'
import { cn } from '@renderer/lib/utils'
import {
  formFieldErrors,
  invoiceNumberPreview,
  settingsFormSchema,
  toFormValues,
  toSettingsPatch,
  type SettingsField,
  type SettingsFormInput,
  type SettingsFormValues
} from './settings-form'

/** Settings → Business, Currency and Invoice, once the settings have loaded. */
export function SettingsSection(): React.JSX.Element {
  const { data, error } = useQuery(settingsQuery)
  if (data) {
    return (
      <SettingsForm
        settings={data.values}
        currencyLocked={data.currencyLocked}
        startNumberLocked={data.startNumberLocked}
      />
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Business</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {error ? (
          <p className="text-destructive">{error.message}</p>
        ) : (
          <p className="text-muted-foreground">Loading…</p>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Read-only rather than disabled: React Hook Form leaves a disabled field's value out of the form. The main process
 * decides the locks and enforces them; the form only shows them.
 */
function lockedProps(locked: boolean): React.ComponentProps<'input'> {
  return {
    readOnly: locked,
    'aria-readonly': locked || undefined,
    className: locked ? 'cursor-not-allowed bg-muted text-muted-foreground' : undefined
  }
}

export function SettingsForm({
  settings,
  currencyLocked,
  startNumberLocked
}: {
  settings: EditableSettings
  /** Financial data exists: the main process refuses another currency code, symbol or decimal places. */
  currencyLocked: boolean
  /** Invoice numbering has begun: the main process refuses another starting number. */
  startNumberLocked: boolean
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const form = useForm<SettingsFormInput, unknown, SettingsFormValues>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: toFormValues(settings),
    mode: 'onTouched'
  })
  const { register, control, handleSubmit, reset, setError } = form
  const { errors, isDirty, dirtyFields } = form.formState

  const save = useMutation({
    mutationFn: (patch: EditableSettingsPatch) => unwrap(window.api.settings.update(patch)),
    onSuccess: (saved: SettingsView) => {
      queryClient.setQueryData(queryKeys.settings, saved)
      reset(toFormValues(saved.values))
      toast.success('Settings saved.')
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        for (const [field, message] of Object.entries(formFieldErrors(error.fieldErrors))) {
          setError(field as SettingsField, { message })
        }
      }
      toast.error(error.message)
    }
  })

  const onSubmit = handleSubmit((values) => {
    if (save.isPending) return
    const patch = toSettingsPatch(values, dirtyFields)
    if (Object.keys(patch).length > 0) save.mutate(patch)
  })

  const [prefix, padding, startNumber] = useWatch({
    control,
    name: ['invoicePrefix', 'invoicePadding', 'invoiceStartNumber']
  })
  const preview = invoiceNumberPreview(String(prefix ?? ''), Number(padding), Number(startNumber))
  const busy = save.isPending

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Business</CardTitle>
          <CardDescription>
            Your shop and salesman as printed on invoices. Each invoice keeps the shop and salesman
            it was posted with: a change here applies to new invoices only.
          </CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field
            id="businessName"
            label="Shop name"
            hint="Printed at the top of invoices and shown on the Dashboard."
            error={errors.businessName?.message}
            className="sm:col-span-3"
          >
            <Input
              id="businessName"
              aria-invalid={errors.businessName ? true : undefined}
              maxLength={BUSINESS_NAME_MAX}
              {...register('businessName')}
            />
          </Field>
          <Field
            id="businessAddress"
            label="Shop address"
            hint="Printed under the shop name. It may be empty."
            error={errors.businessAddress?.message}
            className="sm:col-span-3"
          >
            <Input
              id="businessAddress"
              aria-invalid={errors.businessAddress ? true : undefined}
              maxLength={BUSINESS_ADDRESS_MAX}
              autoComplete="off"
              {...register('businessAddress')}
            />
          </Field>
          <Field
            id="salesmanName"
            label="Salesman name"
            hint="Printed on invoices."
            error={errors.salesmanName?.message}
          >
            <Input
              id="salesmanName"
              aria-invalid={errors.salesmanName ? true : undefined}
              maxLength={SALESMAN_NAME_MAX}
              autoComplete="off"
              {...register('salesmanName')}
            />
          </Field>
          {(['salesmanPhone1', 'salesmanPhone2'] as const).map((field, index) => (
            <Field
              key={field}
              id={field}
              label={`Phone ${index + 1}`}
              hint="The salesman's number. It may be empty."
              error={errors[field]?.message}
            >
              <Input
                id={field}
                inputMode="tel"
                aria-invalid={errors[field] ? true : undefined}
                maxLength={SALESMAN_PHONE_MAX}
                autoComplete="off"
                {...register(field)}
              />
            </Field>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Currency</CardTitle>
          <CardDescription>
            {currencyLocked ? CURRENCY_LOCKED_MESSAGE : 'How amounts are written.'}
          </CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field
            id="currencyCode"
            label="Currency code"
            hint={currencyLocked ? 'Locked.' : 'Three letters, for example PKR.'}
            error={errors.currencyCode?.message}
          >
            <Input
              id="currencyCode"
              aria-invalid={errors.currencyCode ? true : undefined}
              maxLength={3}
              {...lockedProps(currencyLocked)}
              className={cn('uppercase', lockedProps(currencyLocked).className)}
              {...register('currencyCode')}
            />
          </Field>
          <Field
            id="currencySymbol"
            label="Currency symbol"
            hint={currencyLocked ? 'Locked.' : 'Shown with amounts, for example Rs.'}
            error={errors.currencySymbol?.message}
          >
            <Input
              id="currencySymbol"
              aria-invalid={errors.currencySymbol ? true : undefined}
              maxLength={8}
              {...lockedProps(currencyLocked)}
              {...register('currencySymbol')}
            />
          </Field>
          <Field
            id="minorDigits"
            label="Minor digits"
            hint={
              currencyLocked
                ? 'Locked.'
                : 'Digits after the decimal point: 2 for Rs 10.50. Set it before you enter prices.'
            }
            error={errors.minorDigits?.message}
          >
            <Input
              id="minorDigits"
              type="number"
              inputMode="numeric"
              min={0}
              max={4}
              {...lockedProps(currencyLocked)}
              aria-invalid={errors.minorDigits ? true : undefined}
              {...register('minorDigits', { valueAsNumber: true })}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoice</CardTitle>
          <CardDescription>
            How invoice numbers look and the paper they are printed on.
          </CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field
            id="invoicePrefix"
            label="Prefix"
            hint="Up to 12 letters, digits, dots, dashes or underscores. It may be empty."
            error={errors.invoicePrefix?.message}
          >
            <Input
              id="invoicePrefix"
              aria-invalid={errors.invoicePrefix ? true : undefined}
              maxLength={12}
              {...register('invoicePrefix')}
            />
          </Field>
          <Field
            id="invoicePadding"
            label="Padding"
            hint="How many digits the number has: 6 gives 000001."
            error={errors.invoicePadding?.message}
          >
            <Input
              id="invoicePadding"
              type="number"
              inputMode="numeric"
              min={1}
              max={10}
              aria-invalid={errors.invoicePadding ? true : undefined}
              {...register('invoicePadding', { valueAsNumber: true })}
            />
          </Field>
          <Field
            id="invoiceStartNumber"
            label="Starting number"
            hint={
              startNumberLocked
                ? START_NUMBER_LOCKED_MESSAGE
                : 'The number of the first invoice StockFlow creates.'
            }
            error={errors.invoiceStartNumber?.message}
          >
            <Input
              id="invoiceStartNumber"
              type="number"
              inputMode="numeric"
              min={1}
              {...lockedProps(startNumberLocked)}
              aria-invalid={errors.invoiceStartNumber ? true : undefined}
              {...register('invoiceStartNumber', { valueAsNumber: true })}
            />
          </Field>
          <div className="grid gap-2 sm:col-span-3">
            <Label id="paperSize-label">Paper size</Label>
            <Controller
              control={control}
              name="paperSize"
              render={({ field }) => (
                <RadioGroup
                  aria-labelledby="paperSize-label"
                  className="flex gap-6"
                  value={field.value}
                  onValueChange={field.onChange}
                  onBlur={field.onBlur}
                >
                  {(['A4', 'A5'] as const).map((size) => (
                    <div key={size} className="flex items-center gap-2">
                      <RadioGroupItem id={`paperSize-${size}`} value={size} />
                      <Label htmlFor={`paperSize-${size}`} className="font-normal">
                        {size}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              )}
            />
            {errors.paperSize?.message && (
              <p className="text-sm text-destructive">{errors.paperSize.message}</p>
            )}
          </div>
          {!startNumberLocked && (
            <p className="text-sm text-muted-foreground sm:col-span-3">
              First invoice number:{' '}
              <span className="font-medium text-foreground">{preview ?? '—'}</span>
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={!isDirty || busy}
          onClick={() => reset(toFormValues(settings))}
        >
          Discard changes
        </Button>
        <Button type="submit" disabled={!isDirty || busy}>
          {busy && <LoaderCircle className="animate-spin" aria-hidden />}
          {busy ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </form>
  )
}

function Field({
  id,
  label,
  hint,
  error,
  className,
  children
}: {
  id: string
  label: string
  hint: string
  error: string | undefined
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}
