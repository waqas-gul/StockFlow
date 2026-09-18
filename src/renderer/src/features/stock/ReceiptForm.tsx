import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, PackagePlus, Plus, Trash2, X } from 'lucide-react'
import {
  Controller,
  useFieldArray,
  useForm,
  useWatch,
  type FieldPath,
  type UseFormReturn
} from 'react-hook-form'
import { toast } from 'sonner'
import { formatDisplayDate } from '@shared/dates'
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from '@shared/payments'
import type { Product, ProductSearchItem } from '@shared/products'
import {
  MAX_RECEIPT_LINES,
  NOTE_MAX,
  PAID_NOW_REFERENCE_MAX,
  REFERENCE_MAX,
  SUPPLIER_BILL_NO_MAX,
  type PostingFloor,
  type StockReceiptDetail
} from '@shared/stock'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import {
  postingFloorQuery,
  productQuery,
  refreshAfterStockChange,
  supplierQuery
} from '@renderer/lib/app-queries'
import { queryKeys } from '@renderer/lib/query-keys'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { ProductFormDialog } from '../products/ProductFormDialog'
import {
  supplierBalanceClassName,
  supplierBalanceText,
  supplierLabel
} from '../suppliers/supplier-display'
import { SupplierPicker } from '../suppliers/SupplierPicker'
import { ProductPicker } from './ProductPicker'
import {
  emptyReceiptForm,
  linePreview,
  newReceiptLine,
  projectedSupplierBalance,
  purchasableUnits,
  receiptFormSchema,
  receiptTotal,
  toReceiptInput,
  withProduct,
  withUnit,
  type ReceiptDraft,
  type ReceiptFormValues
} from './receipt-form'
import { newRequestId, submitReceipt, type StockNotifier } from './stock-actions'

const notify: StockNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

type Form = UseFormReturn<ReceiptFormValues, unknown, ReceiptDraft>

export interface ReceiptFormProps {
  readonly currency: CurrencyFormat
  /** The local calendar day, for the default date. */
  readonly today: string
  /** The supplier to start with (Supplier → New Stock Purchase); null for none. */
  readonly initialSupplier?: { readonly id: number; readonly label: string } | null
  readonly onSaved: (receipt: StockReceiptDetail) => void
}

/** Stock In: the receipt header and its product lines, posted in one transaction by the main process. */
export function ReceiptForm({
  currency,
  today,
  initialSupplier = null,
  onSaved
}: ReceiptFormProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const form = useForm<ReceiptFormValues, unknown, ReceiptDraft>({
    resolver: zodResolver(receiptFormSchema(currency.minorDigits)),
    defaultValues: emptyReceiptForm(today, initialSupplier),
    mode: 'onTouched'
  })
  const { control, register, handleSubmit, setError, setValue, getValues, reset, formState } = form
  const { errors } = formState
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' })
  // One id per submission: a retry after a lost answer returns the receipt already saved.
  const [requestId, setRequestId] = useState(newRequestId)
  const [addingProduct, setAddingProduct] = useState(false)
  const saving = formState.isSubmitting

  const [lines, supplierId, supplierText] = useWatch({
    control,
    name: ['lines', 'supplierId', 'supplierLabel']
  })
  const productIds = [
    ...new Set(lines.flatMap((line) => (line.productId === null ? [] : [line.productId])))
  ].sort((a, b) => a - b)
  const floor = useQuery(postingFloorQuery(productIds, supplierId))

  const onSubmit = handleSubmit(async (draft) => {
    await submitReceipt(window.api.stock, toReceiptInput(draft, requestId, currency.minorDigits), {
      onSaved: (receipt) => {
        setRequestId(newRequestId())
        reset(emptyReceiptForm(today))
        refreshAfterStockChange(queryClient)
        onSaved(receipt)
      },
      onFieldError: (path, message) =>
        setError(path as FieldPath<ReceiptFormValues>, { type: 'server', message }),
      notify
    })
  })

  /** A product just created with the Product form goes on the first empty line, or a new one. */
  const placeNewProduct = (product: Product): void => {
    const rows = getValues('lines')
    const empty = rows.findIndex((row) => row.productId === null)
    const next = withProduct(
      empty === -1 ? newReceiptLine() : rows[empty],
      product,
      currency.minorDigits
    )
    if (empty === -1) {
      append(next)
      return
    }
    for (const key of ['productId', 'productLabel', 'unitId', 'unitCost'] as const) {
      setValue(`lines.${empty}.${key}`, next[key], {
        shouldDirty: true,
        shouldValidate: key === 'unitId'
      })
    }
  }

  return (
    <>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            id="receiptDate"
            label="Receipt Date"
            error={errors.receiptDate?.message}
            hint={dateHint(floor.data)}
          >
            <Input
              id="receiptDate"
              type="date"
              max={floor.data?.today ?? today}
              min={floor.data?.earliestDate ?? undefined}
              aria-invalid={errors.receiptDate ? true : undefined}
              {...register('receiptDate')}
            />
          </Field>
          <Field
            id="receipt-supplier"
            label="Supplier"
            error={errors.supplierId?.message}
            hint={
              supplierId === null
                ? 'Choose the supplier account. Leave empty only for stock without a supplier account.'
                : 'The purchase is added to what the shop owes this supplier.'
            }
          >
            <div className="flex gap-1">
              <div className="min-w-0 flex-1">
                <SupplierPicker
                  id="receipt-supplier"
                  ariaLabel="Supplier"
                  label={supplierText}
                  invalid={errors.supplierId !== undefined}
                  onPick={(item) => {
                    setValue('supplierId', item.id, { shouldDirty: true, shouldValidate: true })
                    setValue('supplierLabel', supplierLabel(item), { shouldDirty: true })
                  }}
                />
              </div>
              {supplierId !== null && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Clear supplier"
                  onClick={() => {
                    setValue('supplierId', null, { shouldDirty: true })
                    setValue('supplierLabel', '', { shouldDirty: true })
                    setValue('paidNowAmount', '', { shouldDirty: true })
                  }}
                >
                  <X aria-hidden />
                </Button>
              )}
            </div>
          </Field>
          <Field
            id="supplierBillNo"
            label="Supplier Bill No"
            error={errors.supplierBillNo?.message}
            hint="The supplier’s invoice number. Optional."
          >
            <Input
              id="supplierBillNo"
              maxLength={SUPPLIER_BILL_NO_MAX}
              autoComplete="off"
              {...register('supplierBillNo')}
            />
          </Field>
          <Field
            id="reference"
            label="Reference"
            error={errors.reference?.message}
            hint="Delivery or gate pass number. Optional."
          >
            <Input
              id="reference"
              maxLength={REFERENCE_MAX}
              autoComplete="off"
              {...register('reference')}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field id="note" label="Note" error={errors.note?.message} hint="Optional.">
              <Input id="note" maxLength={NOTE_MAX} autoComplete="off" {...register('note')} />
            </Field>
          </div>
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-64 pl-3">Product</TableHead>
                <TableHead className="min-w-32">Unit</TableHead>
                <TableHead className="w-28">Quantity</TableHead>
                <TableHead className="w-36">Unit Cost</TableHead>
                <TableHead className="w-24 text-right">Base Qty</TableHead>
                <TableHead className="w-36 text-right">Line Cost</TableHead>
                <TableHead className="w-12 pr-3">
                  <span className="sr-only">Remove</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field, index) => (
                <ReceiptLineEditor
                  key={field.id}
                  form={form}
                  index={index}
                  currency={currency}
                  removable={fields.length > 1}
                  onRemove={() => remove(index)}
                />
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-end gap-6 border-t px-3 py-2.5 text-sm">
            <span className="font-medium">Total receipt cost</span>
            <span className="min-w-36 text-right font-semibold tabular-nums">
              <ReceiptTotal form={form} currency={currency} />
            </span>
            <span className="w-9" aria-hidden />
          </div>
        </div>
        {(errors.lines?.root?.message ?? errors.lines?.message) && (
          <p className="text-sm text-destructive">
            {errors.lines?.root?.message ?? errors.lines?.message}
          </p>
        )}

        {supplierId !== null ? (
          <PaidNowSection form={form} supplierId={supplierId} currency={currency} />
        ) : (
          errors.paidNowAmount?.message && (
            <p className="text-sm text-destructive">{errors.paidNowAmount.message}</p>
          )
        )}
        {errors.root?.message && <p className="text-sm text-destructive">{errors.root.message}</p>}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={fields.length >= MAX_RECEIPT_LINES}
              onClick={() => append(newReceiptLine())}
            >
              <Plus aria-hidden />
              Add Product
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={
                fields.length >= MAX_RECEIPT_LINES && lines.every((row) => row.productId !== null)
              }
              onClick={() => setAddingProduct(true)}
              title="Create a product that is not in StockFlow yet, then buy it on this receipt."
            >
              <PackagePlus aria-hidden />
              New Product
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => reset(emptyReceiptForm(today))}
            >
              Clear
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <LoaderCircle className="animate-spin" aria-hidden />}
              {saving ? 'Saving…' : 'Save Receipt'}
            </Button>
          </div>
        </div>
      </form>
      {/* Outside the receipt form: the Product form's own submit must not submit the receipt. */}
      <ProductFormDialog
        target={addingProduct ? { mode: 'create' } : null}
        currency={currency}
        onClose={() => setAddingProduct(false)}
        onSaved={(product) => {
          setAddingProduct(false)
          void queryClient.invalidateQueries({ queryKey: queryKeys.products.all })
          placeNewProduct(product)
        }}
      />
    </>
  )
}

function dateHint(floor: PostingFloor | undefined): string {
  if (floor?.earliestDate && floor.supplierSetBy) {
    return `Earliest allowed: ${formatDisplayDate(floor.earliestDate)} (${floor.supplierSetBy.supplierCode} has later account activity).`
  }
  if (floor?.earliestDate && floor.setBy) {
    return `Earliest allowed: ${formatDisplayDate(floor.earliestDate)} (${floor.setBy.productCode} has later stock activity).`
  }
  return 'Today or earlier.'
}

/**
 * Paid Now, and what the supplier account will show: the current balance, + this purchase, − paid now, = the projected
 * balance. Paying more than is owed leaves a supplier advance.
 */
function PaidNowSection({
  form,
  supplierId,
  currency
}: {
  form: Form
  supplierId: number
  currency: CurrencyFormat
}): React.JSX.Element {
  const { control, register, formState } = form
  const { errors } = formState
  const supplier = useQuery(supplierQuery(supplierId))
  const [lines, paidNowAmount] = useWatch({ control, name: ['lines', 'paidNowAmount'] })
  const total = receiptTotal(
    lines.map((line) => linePreview(line, undefined, currency.minorDigits))
  )
  const current = supplier.data?.balanceMinor ?? null
  const { paidNowMinor, afterMinor } = projectedSupplierBalance(
    current ?? 0,
    total,
    paidNowAmount,
    currency.minorDigits
  )
  const projectedMinor = current === null ? null : afterMinor
  return (
    <fieldset className="grid gap-4 rounded-md border p-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <legend className="px-1 text-sm font-semibold">Supplier Payment</legend>
      <div className="grid content-start gap-4 sm:grid-cols-3">
        <Field
          id="paidNowAmount"
          label="Paid Now"
          error={errors.paidNowAmount?.message}
          hint="Leave empty if nothing is paid now."
        >
          <Input
            id="paidNowAmount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            className="text-right tabular-nums"
            aria-invalid={errors.paidNowAmount ? true : undefined}
            {...register('paidNowAmount')}
          />
        </Field>
        <div className="grid content-start gap-1.5">
          <Label htmlFor="paidNowMethod">Payment Method</Label>
          <Controller
            control={control}
            name="paidNowMethod"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(value) => {
                  // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
                  if (value !== '') field.onChange(value)
                }}
              >
                <SelectTrigger id="paidNowMethod" className="w-full">
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
        <Field
          id="paidNowReference"
          label="Payment Reference"
          error={errors.paidNowReference?.message}
          hint="Optional."
        >
          <Input
            id="paidNowReference"
            maxLength={PAID_NOW_REFERENCE_MAX}
            autoComplete="off"
            {...register('paidNowReference')}
          />
        </Field>
      </div>
      <dl className="grid content-start gap-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Supplier Current Balance</dt>
          <dd
            className={`font-medium tabular-nums ${current === null ? '' : supplierBalanceClassName(current)}`}
          >
            {current === null ? '—' : supplierBalanceText(current, currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Purchase Total</dt>
          <dd className="font-medium tabular-nums">
            {total === null ? '—' : `+${formatAmount(total, currency)}`}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Paid Now</dt>
          <dd className="font-medium tabular-nums">
            {paidNowMinor === null ? '—' : `−${formatAmount(paidNowMinor, currency)}`}
          </dd>
        </div>
        <div className="flex justify-between gap-4 border-t pt-1">
          <dt className="font-medium">Projected Supplier Balance</dt>
          <dd
            className={`font-semibold tabular-nums ${projectedMinor === null ? '' : supplierBalanceClassName(projectedMinor)}`}
          >
            {projectedMinor === null ? '—' : supplierBalanceText(projectedMinor, currency)}
          </dd>
        </div>
      </dl>
    </fieldset>
  )
}

/** One product line: product, purchasable unit, quantity and unit cost, with its base quantity and line cost. */
function ReceiptLineEditor({
  form,
  index,
  currency,
  removable,
  onRemove
}: {
  form: Form
  index: number
  currency: CurrencyFormat
  removable: boolean
  onRemove: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const { control, register, setValue, getValues, formState } = form
  const row = useWatch({ control, name: `lines.${index}` })
  const product = useQuery({ ...productQuery(row.productId ?? 0), enabled: row.productId !== null })
  const units = product.data === undefined ? [] : purchasableUnits(product.data.units)
  const preview = linePreview(row, product.data?.units, currency.minorDigits)
  const rowErrors = formState.errors.lines?.[index]
  const baseUnit = product.data?.units.find((unit) => unit.isBase)

  const apply = (next: ReturnType<typeof withUnit>): void => {
    for (const key of ['productId', 'productLabel', 'unitId', 'unitCost'] as const) {
      setValue(`lines.${index}.${key}`, next[key], {
        shouldDirty: true,
        shouldValidate: key === 'unitId'
      })
    }
  }

  const pickProduct = async (item: ProductSearchItem): Promise<void> => {
    try {
      const picked = await queryClient.fetchQuery(productQuery(item.id))
      apply(withProduct(getValues(`lines.${index}`), picked, currency.minorDigits))
    } catch {
      toast.error('The product could not be loaded. Try again.')
    }
  }

  return (
    <TableRow>
      <TableCell className="pl-3 align-top">
        <ProductPicker
          label={row.productLabel}
          ariaLabel={`Line ${index + 1} product`}
          invalid={rowErrors?.productId !== undefined}
          onPick={(item) => void pickProduct(item)}
        />
        <CellError message={rowErrors?.productId?.message} />
        {product.data && units.length === 0 && (
          <p className="mt-1 text-xs text-destructive">
            This product has no active purchasable unit.
          </p>
        )}
      </TableCell>
      <TableCell className="align-top">
        <Select
          value={row.unitId}
          onValueChange={(value) => {
            // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
            if (value === '') return
            apply(
              withUnit(
                getValues(`lines.${index}`),
                units.find((unit) => String(unit.id) === value),
                currency.minorDigits
              )
            )
          }}
          disabled={product.data === undefined}
        >
          <SelectTrigger
            className="w-full"
            aria-label={`Line ${index + 1} unit`}
            aria-invalid={rowErrors?.unitId ? true : undefined}
          >
            <SelectValue placeholder="Unit" />
          </SelectTrigger>
          <SelectContent>
            {units.map((unit) => (
              <SelectItem key={unit.id} value={String(unit.id)}>
                {unit.name}
                {unit.isBase ? '' : ` (${unit.baseQty.toLocaleString('en-US')})`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <CellError message={rowErrors?.unitId?.message} />
      </TableCell>
      <TableCell className="align-top">
        <Input
          aria-label={`Line ${index + 1} quantity`}
          inputMode="numeric"
          autoComplete="off"
          className="text-right tabular-nums"
          aria-invalid={rowErrors?.quantity ? true : undefined}
          {...register(`lines.${index}.quantity`)}
        />
        <CellError message={rowErrors?.quantity?.message} />
      </TableCell>
      <TableCell className="align-top">
        <Input
          aria-label={`Line ${index + 1} unit cost`}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          className="text-right tabular-nums"
          aria-invalid={rowErrors?.unitCost ? true : undefined}
          {...register(`lines.${index}.unitCost`)}
        />
        <CellError message={rowErrors?.unitCost?.message} />
      </TableCell>
      <TableCell className="pt-4 text-right align-top tabular-nums">
        {preview.qtyBase === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span title={baseUnit ? `${baseUnit.name} (base unit)` : undefined}>
            {preview.qtyBase.toLocaleString('en-US')}
          </span>
        )}
      </TableCell>
      <TableCell className="pt-4 text-right align-top tabular-nums">
        {preview.lineCostMinor === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          formatAmount(preview.lineCostMinor, currency)
        )}
      </TableCell>
      <TableCell className="pr-3 align-top">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove line ${index + 1}`}
          disabled={!removable}
          onClick={onRemove}
        >
          <Trash2 aria-hidden />
        </Button>
      </TableCell>
    </TableRow>
  )
}

function ReceiptTotal({
  form,
  currency
}: {
  form: Form
  currency: CurrencyFormat
}): React.JSX.Element {
  const lines = useWatch({ control: form.control, name: 'lines' })
  // A line's cost is quantity × unit cost: it does not depend on the unit.
  const total = receiptTotal(
    lines.map((line) => linePreview(line, undefined, currency.minorDigits))
  )
  return <>{total === null ? '—' : formatAmount(total, currency)}</>
}

function CellError({ message }: { message: string | undefined }): React.JSX.Element | null {
  return message ? (
    <p className="mt-1 text-xs whitespace-normal text-destructive">{message}</p>
  ) : null
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
  hint?: string
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
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}
