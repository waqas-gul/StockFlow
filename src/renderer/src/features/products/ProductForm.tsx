import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Info, LoaderCircle, Lock, Plus, Trash2 } from 'lucide-react'
import {
  Controller,
  useFieldArray,
  useForm,
  useWatch,
  type FieldPath,
  type UseFormReturn
} from 'react-hook-form'
import { toast } from 'sonner'
import type { Company } from '@shared/companies'
import { MAX_UNITS_PER_PRODUCT, type Product } from '@shared/products'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@renderer/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Separator } from '@renderer/components/ui/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import { unwrap } from '@renderer/lib/api'
import { companiesQuery } from '@renderer/lib/app-queries'
import { errorMessage } from '@renderer/lib/format'
import { queryKeys } from '@renderer/lib/query-keys'
import { saveProduct, type ProductNotifier } from './product-actions'
import type { CurrencyFormat } from './product-display'
import {
  NO_COMPANY,
  canRemoveUnitRow,
  chooseBaseRow,
  emptyProductForm,
  newUnitRow,
  productFormSchema,
  productToFormValues,
  toCreateInput,
  toUpdateInput,
  type ProductDraft,
  type ProductFormValues
} from './product-form'

const notify: ProductNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

export interface ProductFormProps {
  /** The product being edited (read fresh from the main process); null to add a product. */
  readonly product: Product | null
  readonly currency: CurrencyFormat
  readonly onSaved: (product: Product) => void
  readonly onCancel: () => void
}

type Form = UseFormReturn<ProductFormValues, unknown, ProductDraft>

/** Add/Edit Product: Basic Information, then Units & Prices. */
export function ProductForm({
  product,
  currency,
  onSaved,
  onCancel
}: ProductFormProps): React.JSX.Element {
  const form = useForm<ProductFormValues, unknown, ProductDraft>({
    resolver: zodResolver(productFormSchema(currency.minorDigits)),
    defaultValues: product
      ? productToFormValues(product, currency.minorDigits)
      : emptyProductForm(),
    mode: 'onTouched'
  })
  const { handleSubmit, setError, formState } = form
  const saving = formState.isSubmitting

  const onSubmit = handleSubmit(async (draft) => {
    const request =
      product === null
        ? ({ mode: 'create', input: toCreateInput(draft, currency.minorDigits) } as const)
        : ({
            mode: 'update',
            input: toUpdateInput(product.id, draft, currency.minorDigits)
          } as const)
    await saveProduct(window.api.products, request, {
      onSaved,
      onFieldError: (path, message) =>
        setError(path as FieldPath<ProductFormValues>, { type: 'server', message }),
      notify
    })
  })

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <SectionTitle title="Basic Information" />
        <BasicFields form={form} product={product} />
      </section>
      <Separator />
      <section className="flex flex-col gap-4">
        <SectionTitle
          title="Units & Prices"
          description={`Stock is counted in the base unit. Amounts in ${currency.symbol}; leave a price empty when it is not used.`}
        />
        <UnitsEditor form={form} hasStockMovements={product?.hasStockMovements ?? false} />
      </section>
      {formState.errors.root?.message && (
        <p className="text-sm text-destructive">{formState.errors.root.message}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <LoaderCircle className="animate-spin" aria-hidden />}
          {saving ? 'Saving…' : product === null ? 'Add product' : 'Save product'}
        </Button>
      </div>
    </form>
  )
}

function SectionTitle({
  title,
  description
}: {
  title: string
  description?: string
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  )
}

function BasicFields({
  form,
  product
}: {
  form: Form
  product: Product | null
}): React.JSX.Element {
  const { register, control, formState } = form
  const { errors } = formState
  const { data: companies = [] } = useQuery(companiesQuery)
  // New products get active companies only; an inactive company a product already has stays selectable.
  const choices = companies.filter(
    (company) => company.isActive || company.id === product?.companyId
  )

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field id="code" label="Code" error={errors.code?.message} hint="Unique, e.g. P-001.">
        <Input
          id="code"
          maxLength={30}
          autoComplete="off"
          aria-invalid={errors.code ? true : undefined}
          {...register('code')}
        />
      </Field>
      <Field id="name" label="Name" error={errors.name?.message} className="lg:col-span-3">
        <Input
          id="name"
          maxLength={120}
          autoComplete="off"
          aria-invalid={errors.name ? true : undefined}
          {...register('name')}
        />
      </Field>
      <Field
        id="companyId"
        label="Brand / Company"
        error={errors.companyId?.message}
        hint="Optional."
        className="lg:col-span-2"
      >
        <Controller
          control={control}
          name="companyId"
          render={({ field }) => (
            <CompanyPicker
              value={field.value}
              onChange={field.onChange}
              companies={choices}
              invalid={errors.companyId !== undefined}
            />
          )}
        />
      </Field>
      <Field
        id="packingLabel"
        label="Packing"
        error={errors.packingLabel?.message}
        hint="Display text only, e.g. 1*12*18. It is never used for units or stock."
      >
        <Input
          id="packingLabel"
          maxLength={40}
          autoComplete="off"
          aria-invalid={errors.packingLabel ? true : undefined}
          {...register('packingLabel')}
        />
      </Field>
      <Field
        id="lowStockThresholdBase"
        label="Low-stock level"
        error={errors.lowStockThresholdBase?.message}
        hint="In base units. 0 means none."
      >
        <Input
          id="lowStockThresholdBase"
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={errors.lowStockThresholdBase ? true : undefined}
          {...register('lowStockThresholdBase')}
        />
      </Field>
    </div>
  )
}

/** The company select, with a quick "New company" entry that creates it in the main process and selects it. */
function CompanyPicker({
  value,
  onChange,
  companies,
  invalid
}: {
  value: string
  onChange: (value: string) => void
  companies: readonly Company[]
  invalid: boolean
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const add = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const company = await unwrap(window.api.companies.create({ name }))
      queryClient.setQueryData<readonly Company[]>(queryKeys.companies, (old = []) => [
        ...old,
        company
      ])
      void queryClient.invalidateQueries({ queryKey: queryKeys.companies })
      onChange(String(company.id))
      setAdding(false)
      setName('')
      toast.success(`Company ${company.name} added.`)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  if (adding) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex gap-2">
          <Input
            aria-label="New company name"
            placeholder="Company name"
            maxLength={80}
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void add()
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            className="h-9"
            disabled={busy}
            onClick={() => void add()}
          >
            Add
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-9"
            disabled={busy}
            onClick={() => {
              setAdding(false)
              setError(null)
            }}
          >
            Cancel
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    )
  }

  return (
    <div className="flex gap-2">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="companyId" className="w-full" aria-invalid={invalid ? true : undefined}>
          <SelectValue placeholder="No company" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_COMPANY}>No company</SelectItem>
          {companies.map((company) => (
            <SelectItem key={company.id} value={String(company.id)}>
              {company.name}
              {company.isActive ? '' : ' (inactive)'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="button" variant="outline" className="shrink-0" onClick={() => setAdding(true)}>
        <Plus aria-hidden />
        New company
      </Button>
    </div>
  )
}

/** The unit rows: base unit choice, size, sell/purchase flags, prices and order. */
function UnitsEditor({
  form,
  hasStockMovements
}: {
  form: Form
  hasStockMovements: boolean
}): React.JSX.Element {
  const { control, register, getValues, setValue, formState } = form
  const { errors } = formState
  const { fields, append, remove, move, replace } = useFieldArray({ control, name: 'units' })
  const baseRowKey = useWatch({ control, name: 'baseRowKey' })
  const listError = errors.units?.root?.message ?? errors.units?.message

  const makeBase = (rowKey: string): void => {
    replace(chooseBaseRow(getValues('units'), rowKey))
    setValue('baseRowKey', rowKey, { shouldDirty: true })
  }

  return (
    <div className="flex flex-col gap-3">
      {hasStockMovements && (
        <Alert>
          <Lock aria-hidden />
          <AlertDescription>
            This product has stock history. Base quantities and the base unit are locked, and saved
            units cannot be removed (make them inactive instead). Names, prices, costs and the Sell,
            Purchase and Active options can still change, and new units can be added.
          </AlertDescription>
        </Alert>
      )}
      <RadioGroup
        value={baseRowKey}
        onValueChange={makeBase}
        disabled={hasStockMovements}
        aria-label="Base unit"
        className="block rounded-md border"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-3">Unit</TableHead>
              <TableHead>Short name</TableHead>
              <TableHead>Base qty</TableHead>
              <TableHead className="text-center">Base unit</TableHead>
              <TableHead className="text-center">Sell?</TableHead>
              <TableHead className="text-center">Purchase?</TableHead>
              <TableHead>Wholesale</TableHead>
              <TableHead>Retail</TableHead>
              <TableHead>Default cost</TableHead>
              <TableHead className="text-center">Active</TableHead>
              <TableHead className="pr-3 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field, index) => {
              const isBase = field.rowKey === baseRowKey
              const sizeLocked = isBase || (hasStockMovements && field.unitId !== null)
              const rowErrors = errors.units?.[index]
              const removable = canRemoveUnitRow(field, baseRowKey, hasStockMovements)
              return (
                <TableRow key={field.id} className={isBase ? 'bg-secondary/40' : undefined}>
                  <TableCell className="min-w-36 pl-3 align-top">
                    <CellInput
                      label={`Unit ${index + 1} name`}
                      error={rowErrors?.name?.message}
                      maxLength={30}
                      {...register(`units.${index}.name`)}
                    />
                    {isBase && <p className="mt-1 text-xs font-medium text-primary">Base unit</p>}
                  </TableCell>
                  <TableCell className="w-24 align-top">
                    <CellInput
                      label={`Unit ${index + 1} short name`}
                      error={rowErrors?.shortName?.message}
                      maxLength={12}
                      {...register(`units.${index}.shortName`)}
                    />
                  </TableCell>
                  <TableCell className="w-24 align-top">
                    <CellInput
                      label={`Unit ${index + 1} base quantity`}
                      error={rowErrors?.baseQty?.message}
                      inputMode="numeric"
                      readOnly={sizeLocked}
                      aria-readonly={sizeLocked || undefined}
                      className={
                        sizeLocked ? 'cursor-not-allowed bg-muted text-muted-foreground' : undefined
                      }
                      title={
                        isBase
                          ? 'The base unit always has base quantity 1.'
                          : sizeLocked
                            ? 'Locked: stock has already been recorded for this product.'
                            : undefined
                      }
                      {...register(`units.${index}.baseQty`)}
                    />
                  </TableCell>
                  <TableCell className="pt-4 text-center align-top">
                    <RadioGroupItem
                      value={field.rowKey}
                      aria-label={`Unit ${index + 1} is the base unit`}
                    />
                  </TableCell>
                  <TableCell className="pt-4 text-center align-top">
                    <FlagBox
                      form={form}
                      name={`units.${index}.canSell`}
                      label={`Unit ${index + 1} can be sold`}
                    />
                  </TableCell>
                  <TableCell className="pt-4 text-center align-top">
                    <FlagBox
                      form={form}
                      name={`units.${index}.canPurchase`}
                      label={`Unit ${index + 1} can be purchased`}
                    />
                  </TableCell>
                  {(['wholesalePriceMinor', 'retailPriceMinor', 'defaultCostMinor'] as const).map(
                    (price) => (
                      <TableCell key={price} className="w-32 align-top">
                        <CellInput
                          label={`Unit ${index + 1} ${PRICE_LABELS[price]}`}
                          error={rowErrors?.[price]?.message}
                          inputMode="decimal"
                          placeholder="Not set"
                          className="text-right tabular-nums"
                          {...register(`units.${index}.${price}`)}
                        />
                      </TableCell>
                    )
                  )}
                  <TableCell className="pt-4 text-center align-top">
                    <FlagBox
                      form={form}
                      name={`units.${index}.isActive`}
                      label={`Unit ${index + 1} is active`}
                    />
                    {rowErrors?.isActive?.message && (
                      <p className="mt-1 text-xs text-destructive">{rowErrors.isActive.message}</p>
                    )}
                  </TableCell>
                  <TableCell className="pr-3 align-top">
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Move unit ${index + 1} up`}
                        disabled={index === 0}
                        onClick={() => move(index, index - 1)}
                      >
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Move unit ${index + 1} down`}
                        disabled={index === fields.length - 1}
                        onClick={() => move(index, index + 1)}
                      >
                        <ArrowDown aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove unit ${index + 1}`}
                        title={
                          removable
                            ? undefined
                            : isBase
                              ? 'Choose another base unit first.'
                              : 'A unit with stock history cannot be removed. Make it inactive instead.'
                        }
                        disabled={!removable}
                        onClick={() => remove(index)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </RadioGroup>
      {listError && <p className="text-sm text-destructive">{listError}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="size-3.5" aria-hidden />
          Each larger unit holds a whole number of the next smaller one, e.g. 1, 12, 144. The order
          here is the display order.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fields.length >= MAX_UNITS_PER_PRODUCT}
          onClick={() => append(newUnitRow())}
        >
          <Plus aria-hidden />
          Add unit
        </Button>
      </div>
    </div>
  )
}

const PRICE_LABELS = {
  wholesalePriceMinor: 'wholesale price',
  retailPriceMinor: 'retail price',
  defaultCostMinor: 'default cost'
} as const

function FlagBox({
  form,
  name,
  label
}: {
  form: Form
  name: `units.${number}.${'canSell' | 'canPurchase' | 'isActive'}`
  label: string
}): React.JSX.Element {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field }) => (
        <Checkbox
          checked={field.value}
          onCheckedChange={(checked) => field.onChange(checked === true)}
          onBlur={field.onBlur}
          aria-label={label}
        />
      )}
    />
  )
}

function CellInput({
  label,
  error,
  className,
  ...props
}: React.ComponentProps<typeof Input> & {
  label: string
  error: string | undefined
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Input
        aria-label={label}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        className={className}
        {...props}
      />
      {error && <p className="text-xs whitespace-normal text-destructive">{error}</p>}
    </div>
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
  hint?: string
  error: string | undefined
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`grid content-start gap-1.5 ${className ?? ''}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}
