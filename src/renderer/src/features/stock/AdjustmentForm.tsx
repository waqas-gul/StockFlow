import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, LoaderCircle, Search } from 'lucide-react'
import { useForm, useWatch, type FieldPath } from 'react-hook-form'
import { toast } from 'sonner'
import { formatDisplayDate } from '@shared/dates'
import {
  ADJUSTMENT_REASON_INFO,
  LATE_COST_CORRECTION_WARNING,
  REASON_NOTE_MAX,
  type AdjustmentReason,
  type StockAdjustmentResult
} from '@shared/stock'
import { SUPPLIER_CORRECTION_NOTE } from '@shared/suppliers'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
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
  postingFloorQuery,
  productQuery,
  receiptListQuery,
  receiptQuery,
  refreshAfterStockChange,
  stockSummaryQuery
} from '@renderer/lib/app-queries'
import { useDebouncedValue } from '@renderer/lib/use-debounced-value'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import {
  REASON_CHOICES,
  adjustmentFieldSet,
  adjustmentFormSchema,
  emptyAdjustmentForm,
  receiptLineLabel,
  toAdjustmentInput,
  withReceiptLine,
  type AdjustmentDraft,
  type AdjustmentFormValues
} from './adjustment-form'
import { ProductPicker } from './ProductPicker'
import { newRequestId, submitAdjustment, type StockNotifier } from './stock-actions'
import { averageUnitCost, quantityInUnits } from './stock-display'

const notify: StockNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

export interface AdjustmentFormProps {
  readonly currency: CurrencyFormat
  readonly today: string
  /** Start as a receipt quantity correction of this receipt (from "Correct Stock"). */
  readonly receiptId?: number | null
  readonly onSaved?: (adjustment: StockAdjustmentResult) => void
}

/** One stock adjustment: the reason decides which fields are asked for. */
export function AdjustmentForm({
  currency,
  today,
  receiptId = null,
  onSaved
}: AdjustmentFormProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const initial: AdjustmentFormValues =
    receiptId === null
      ? emptyAdjustmentForm(today)
      : { ...emptyAdjustmentForm(today), reason: 'RECEIPT_QTY_CORRECTION', receiptId }
  const form = useForm<AdjustmentFormValues, unknown, AdjustmentDraft>({
    resolver: zodResolver(adjustmentFormSchema(currency.minorDigits)),
    defaultValues: initial,
    mode: 'onTouched'
  })
  const { control, register, handleSubmit, setError, setValue, getValues, reset, formState } = form
  const { errors } = formState
  const [requestId, setRequestId] = useState(newRequestId)
  const saving = formState.isSubmitting

  const values = useWatch({ control })
  const reason = values.reason ?? ''
  const direction = values.direction ?? ''
  const productId = values.productId ?? null
  const summary = useQuery({ ...stockSummaryQuery(productId ?? 0), enabled: productId !== null })
  const product = useQuery({ ...productQuery(productId ?? 0), enabled: productId !== null })
  const receipt = useQuery({
    ...receiptQuery(values.receiptId ?? 0),
    enabled: values.receiptId !== null && values.receiptId !== undefined
  })
  const floor = useQuery(postingFloorQuery(productId === null ? [] : [productId]))
  const fields = adjustmentFieldSet(
    reason,
    direction,
    summary.data === undefined ? null : summary.data.qtyBase > 0
  )
  const line = receipt.data?.lines.find((item) => String(item.id) === values.receiptItemId)
  const units = (product.data?.units ?? []).filter(
    (unit) => unit.isActive || (fields.receipt && line?.unitId === unit.id)
  )

  /** A new reason starts its own fields again; the date, note and a still-usable product or receipt line stay. */
  const chooseReason = (next: AdjustmentReason): void => {
    const current = getValues()
    const before = adjustmentFieldSet(current.reason, '', null)
    const after = adjustmentFieldSet(next, '', null)
    const kept =
      (after.product && before.product) || (after.receipt && before.receipt)
        ? {
            productId: current.productId,
            productLabel: current.productLabel,
            unitId: current.unitId,
            receiptId: after.receipt ? current.receiptId : null,
            receiptItemId: after.receipt ? current.receiptItemId : ''
          }
        : {}
    reset({
      ...emptyAdjustmentForm(current.adjustmentDate),
      reason: next,
      reasonNote: current.reasonNote,
      ...kept
    })
  }

  const onSubmit = handleSubmit(async (draft) => {
    await submitAdjustment(
      window.api.stock,
      toAdjustmentInput(draft, requestId, currency.minorDigits),
      {
        onSaved: (saved) => {
          setRequestId(newRequestId())
          reset(emptyAdjustmentForm(getValues('adjustmentDate')))
          refreshAfterStockChange(queryClient)
          onSaved?.(saved)
        },
        onFieldError: (path, message) =>
          setError(path as FieldPath<AdjustmentFormValues>, { type: 'server', message }),
        notify
      }
    )
  })

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <FormField
          id="reason"
          label="Reason"
          error={errors.reason?.message}
          className="md:col-span-2"
        >
          <Select
            value={reason}
            // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
            onValueChange={(value) => value !== '' && chooseReason(value as AdjustmentReason)}
          >
            <SelectTrigger
              id="reason"
              className="w-full"
              aria-invalid={errors.reason ? true : undefined}
            >
              <SelectValue placeholder="Choose a reason" />
            </SelectTrigger>
            <SelectContent>
              {REASON_CHOICES.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {ADJUSTMENT_REASON_INFO[choice].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {reason !== '' && (
            <p className="text-xs text-muted-foreground">
              {ADJUSTMENT_REASON_INFO[reason].description}
            </p>
          )}
        </FormField>
        <FormField
          id="adjustmentDate"
          label="Date"
          error={errors.adjustmentDate?.message}
          hint={
            floor.data?.earliestDate
              ? `Earliest allowed: ${formatDisplayDate(floor.data.earliestDate)} (latest stock activity of this product).`
              : 'Today or earlier.'
          }
        >
          <Input
            id="adjustmentDate"
            type="date"
            max={floor.data?.today ?? today}
            min={floor.data?.earliestDate ?? undefined}
            aria-invalid={errors.adjustmentDate ? true : undefined}
            {...register('adjustmentDate')}
          />
        </FormField>
      </div>

      {fields.receipt && (
        <div className="grid gap-4 md:grid-cols-3">
          <FormField id="receiptSearch" label="Receipt" error={errors.receiptId?.message}>
            <ReceiptPicker
              chosen={receipt.data?.receiptNo ?? null}
              onPick={(id) => {
                const cleared = withReceiptLine(getValues(), undefined)
                setValue('receiptId', id, { shouldValidate: true })
                setValue('receiptItemId', cleared.receiptItemId)
                setValue('productId', cleared.productId)
                setValue('productLabel', cleared.productLabel)
                setValue('unitId', cleared.unitId)
              }}
            />
          </FormField>
          <FormField
            id="receiptItemId"
            label="Receipt line"
            error={errors.receiptItemId?.message}
            className="md:col-span-2"
          >
            <Select
              value={values.receiptItemId ?? ''}
              disabled={receipt.data === undefined}
              onValueChange={(value) => {
                if (value === '') return
                const chosen = receipt.data?.lines.find((item) => String(item.id) === value)
                const next = withReceiptLine(getValues(), chosen)
                setValue('receiptItemId', next.receiptItemId, { shouldValidate: true })
                setValue('productId', next.productId)
                setValue('productLabel', next.productLabel)
                setValue('unitId', next.unitId)
              }}
            >
              <SelectTrigger
                id="receiptItemId"
                className="w-full"
                aria-invalid={errors.receiptItemId ? true : undefined}
              >
                <SelectValue placeholder="Choose the line to correct" />
              </SelectTrigger>
              <SelectContent>
                {(receipt.data?.lines ?? []).map((item) => (
                  <SelectItem key={item.id} value={String(item.id)}>
                    {receiptLineLabel(
                      item,
                      formatAmount(
                        Math.round(item.correctedLineCostMinor / item.quantity),
                        currency
                      )
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {receipt.data?.status === 'VOID' && (
              <p className="text-sm text-destructive">
                This receipt is void and cannot be corrected.
              </p>
            )}
            {receipt.data?.status === 'POSTED' && receipt.data.supplierId !== null && (
              <p className="text-sm text-muted-foreground">{SUPPLIER_CORRECTION_NOTE}</p>
            )}
          </FormField>
        </div>
      )}

      {fields.product && (
        <FormField id="productId" label="Product" error={errors.productId?.message}>
          <ProductPicker
            id="productId"
            label={values.productLabel ?? ''}
            ariaLabel="Product"
            includeInactive
            invalid={errors.productId !== undefined}
            onPick={(item) => {
              setValue('productId', item.id, { shouldValidate: true })
              setValue('productLabel', `${item.code} ${item.name}`)
              setValue('unitId', '')
            }}
          />
        </FormField>
      )}

      {productId !== null && summary.data && product.data && (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-sm">
          <span className="font-medium">{values.productLabel}</span> — in stock:{' '}
          {quantityInUnits(summary.data.qtyBase, product.data.units)}, value{' '}
          {formatAmount(summary.data.valueMinor, currency)}
          {summary.data.qtyBase > 0 && (
            <>
              , average {formatAmount(averageUnitCost(summary.data, 1) ?? 0, currency)} per{' '}
              {product.data.units.find((unit) => unit.isBase)?.name ?? 'base unit'}
            </>
          )}
          .
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        {fields.direction && (
          <FormField id="direction" label="Stock" error={errors.direction?.message}>
            <Select
              value={direction}
              onValueChange={(value) =>
                value !== '' &&
                setValue('direction', value as 'IN' | 'OUT', { shouldValidate: true })
              }
            >
              <SelectTrigger
                id="direction"
                className="w-full"
                aria-invalid={errors.direction ? true : undefined}
              >
                <SelectValue placeholder="Add or remove" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="IN">Add stock</SelectItem>
                <SelectItem value="OUT">Remove stock</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
        )}
        {fields.quantity && (
          <>
            <FormField id="unitId" label="Unit" error={errors.unitId?.message}>
              <Select
                value={values.unitId ?? ''}
                disabled={product.data === undefined}
                onValueChange={(value) =>
                  value !== '' && setValue('unitId', value, { shouldValidate: true })
                }
              >
                <SelectTrigger
                  id="unitId"
                  className="w-full"
                  aria-invalid={errors.unitId ? true : undefined}
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
            </FormField>
            <FormField id="quantity" label="Quantity" error={errors.quantity?.message}>
              <Input
                id="quantity"
                inputMode="numeric"
                autoComplete="off"
                className="text-right tabular-nums"
                aria-invalid={errors.quantity ? true : undefined}
                {...register('quantity')}
              />
            </FormField>
          </>
        )}
        {fields.cost && (
          <FormField
            id="unitCost"
            label={fields.costLabel}
            error={errors.unitCost?.message}
            hint={
              reason === 'RECEIPT_COST_CORRECTION' && line
                ? `Recorded: ${formatAmount(Math.round(line.correctedLineCostMinor / line.quantity), currency)} per ${line.unitName} for ${line.quantity.toLocaleString('en-US')} ${line.unitName}.`
                : `Per unit, in ${currency.symbol}.`
            }
          >
            <Input
              id="unitCost"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              className="text-right tabular-nums"
              aria-invalid={errors.unitCost ? true : undefined}
              {...register('unitCost')}
            />
          </FormField>
        )}
      </div>
      {fields.valuationNote && (
        <p className="text-sm text-muted-foreground">{fields.valuationNote}</p>
      )}

      {reason === 'RECEIPT_COST_CORRECTION' && line?.laterActivity && (
        <Alert>
          <AlertTriangle aria-hidden />
          <AlertDescription>{LATE_COST_CORRECTION_WARNING}</AlertDescription>
        </Alert>
      )}

      {reason !== '' && (
        <FormField
          id="reasonNote"
          label="Reason note"
          error={errors.reasonNote?.message}
          hint="Required: what happened."
        >
          <Input
            id="reasonNote"
            maxLength={REASON_NOTE_MAX}
            autoComplete="off"
            aria-invalid={errors.reasonNote ? true : undefined}
            {...register('reasonNote')}
          />
        </FormField>
      )}
      {errors.root?.message && <p className="text-sm text-destructive">{errors.root.message}</p>}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={saving}
          onClick={() => reset(emptyAdjustmentForm(getValues('adjustmentDate')))}
        >
          Clear
        </Button>
        <Button type="submit" disabled={saving || reason === ''}>
          {saving && <LoaderCircle className="animate-spin" aria-hidden />}
          {saving ? 'Saving…' : 'Save Adjustment'}
        </Button>
      </div>
    </form>
  )
}

/** Find a receipt by number, supplier or reference. */
function ReceiptPicker({
  chosen,
  onPick
}: {
  chosen: string | null
  onPick: (receiptId: number) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const search = useDebouncedValue(text.trim(), 200)
  const results = useQuery({
    ...receiptListQuery({ page: 1, pageSize: 8, search }),
    enabled: search !== ''
  })
  const items = search === '' ? [] : (results.data?.items ?? [])
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        id="receiptSearch"
        aria-label="Find receipt"
        placeholder={chosen ?? 'Receipt number or supplier'}
        className="pl-8"
        autoComplete="off"
        maxLength={100}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {items.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full min-w-72 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {items.map((item) => (
            <li
              key={item.id}
              role="option"
              aria-selected={false}
              aria-disabled={item.status === 'VOID'}
              className={`rounded-sm px-2 py-1.5 text-sm ${item.status === 'VOID' ? 'text-muted-foreground' : 'cursor-pointer hover:bg-accent'}`}
              onMouseDown={(event) => {
                event.preventDefault()
                if (item.status === 'VOID') return
                onPick(item.id)
                setText('')
              }}
            >
              <span className="font-mono text-xs">{item.receiptNo}</span> ·{' '}
              {formatDisplayDate(item.receiptDate)}
              {item.supplierName ? ` · ${item.supplierName}` : ''}
              {item.status === 'VOID' ? ' · void' : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function FormField({
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
