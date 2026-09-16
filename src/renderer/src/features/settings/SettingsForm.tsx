import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import type { EditableSettings, EditableSettingsPatch } from '@shared/settings'
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
  if (data) return <SettingsForm settings={data} />
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

export function SettingsForm({ settings }: { settings: EditableSettings }): React.JSX.Element {
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
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.settings, saved)
      reset(toFormValues(saved))
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
          <CardDescription>Your shop as it appears on invoices and reports.</CardDescription>
        </CardHeader>
        <Separator />
        <CardContent>
          <Field
            id="businessName"
            label="Business name"
            hint="Printed on invoices and reports."
            error={errors.businessName?.message}
          >
            <Input
              id="businessName"
              aria-invalid={errors.businessName ? true : undefined}
              maxLength={100}
              {...register('businessName')}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Currency</CardTitle>
          <CardDescription>How amounts are written.</CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field
            id="currencyCode"
            label="Currency code"
            hint="Three letters, for example PKR."
            error={errors.currencyCode?.message}
          >
            <Input
              id="currencyCode"
              className="uppercase"
              aria-invalid={errors.currencyCode ? true : undefined}
              maxLength={3}
              {...register('currencyCode')}
            />
          </Field>
          <Field
            id="currencySymbol"
            label="Currency symbol"
            hint="Shown with amounts, for example Rs."
            error={errors.currencySymbol?.message}
          >
            <Input
              id="currencySymbol"
              aria-invalid={errors.currencySymbol ? true : undefined}
              maxLength={8}
              {...register('currencySymbol')}
            />
          </Field>
          <Field
            id="minorDigits"
            label="Minor digits"
            hint="Digits after the decimal point: 2 for Rs 10.50. Set it before you enter prices."
            error={errors.minorDigits?.message}
          >
            <Input
              id="minorDigits"
              type="number"
              inputMode="numeric"
              min={0}
              max={4}
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
            hint="The number of the first invoice StockFlow creates."
            error={errors.invoiceStartNumber?.message}
          >
            <Input
              id="invoiceStartNumber"
              type="number"
              inputMode="numeric"
              min={1}
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
          <p className="text-sm text-muted-foreground sm:col-span-3">
            First invoice number:{' '}
            <span className="font-medium text-foreground">{preview ?? '—'}</span>
          </p>
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
  children
}: {
  id: string
  label: string
  hint: string
  error: string | undefined
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid content-start gap-1.5">
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
