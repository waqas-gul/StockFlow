import { formatMoney } from '@shared/domain'
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, PAYMENT_REFERENCE_MAX } from '@shared/payments'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { balanceClassName, balanceText } from '../customers/customer-display'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import type { InvoiceDraft, InvoiceDraftAction } from './invoice-draft'
import type { InvoiceSummary } from './invoice-summary'
import { CellError } from './InvoiceLineRows'

export interface InvoiceTotalsPanelProps {
  readonly draft: InvoiceDraft
  readonly summary: InvoiceSummary
  readonly currency: CurrencyFormat
  readonly errors: Readonly<Record<string, string>>
  readonly dispatch: (action: InvoiceDraftAction) => void
}

/**
 * The invoice totals from the shared calculator (a preview: the main process recalculates when posting), the amount
 * received with its payment method, and the customer's account after the invoice.
 */
export function InvoiceTotalsPanel({
  draft,
  summary,
  currency,
  errors,
  dispatch
}: InvoiceTotalsPanelProps): React.JSX.Element {
  const { totals, walkIn } = summary
  const amount = (value: number | undefined): string =>
    value === undefined ? '—' : formatAmount(value, currency)
  const received = totals?.receivedMinor ?? 0

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="text-base">Totals</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 px-4 py-4">
        <dl className="grid gap-2 text-sm">
          <TotalRow label="Gross" value={amount(totals?.grossMinor)} />
          <TotalRow label="Line Discounts" value={amount(totals?.lineDiscountMinor)} />
          <TotalRow label="Scheme Discounts" value={amount(totals?.lineSchemeMinor)} />
          <InputRow
            id="invoice-extra-discount"
            label="Extra Discount"
            value={draft.extraDiscount}
            error={errors.extraDiscount}
            onChange={(value) => dispatch({ type: 'setField', field: 'extraDiscount', value })}
          />
          <TotalRow label="Net Invoice" value={amount(totals?.netMinor)} strong />
          <InputRow
            id="invoice-freight"
            label="Freight"
            value={draft.freight}
            error={errors.freight}
            onChange={(value) => dispatch({ type: 'setField', field: 'freight', value })}
          />
          <TotalRow label="Total" value={amount(totals?.totalMinor)} strong large />
          <TotalRow
            label="Previous Balance"
            value={totals === null ? '—' : balanceText(totals.previousBalanceMinor, currency)}
          />
          {walkIn ? (
            <InputRow
              id="invoice-received"
              label="Received"
              value={
                totals === null
                  ? ''
                  : formatMoney(totals.receivedMinor, { minorDigits: currency.minorDigits })
              }
              readOnly
              hint="Received equals the total for a cash sale."
              error={errors.received}
            />
          ) : (
            <InputRow
              id="invoice-received"
              label="Received"
              value={draft.received}
              hint="Money received with this invoice: none, part, all or more."
              error={errors.received}
              onChange={(value) => dispatch({ type: 'setField', field: 'received', value })}
            />
          )}
          <TotalRow
            label="Net Outstanding"
            value={totals === null ? '—' : balanceText(totals.netOutstandingMinor, currency)}
            className={totals === null ? '' : balanceClassName(totals.netOutstandingMinor)}
            strong
          />
        </dl>

        {received > 0 && (
          <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
            <div className="grid content-start gap-1.5">
              <Label htmlFor="invoice-payment-method">Payment Method</Label>
              <Select
                value={draft.paymentMethod}
                onValueChange={(value) => {
                  // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
                  if (value !== '')
                    dispatch({
                      type: 'setPaymentMethod',
                      method: value as InvoiceDraft['paymentMethod']
                    })
                }}
              >
                <SelectTrigger id="invoice-payment-method" className="w-full">
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
              <CellError message={errors.paymentMethod} />
            </div>
            <div className="grid content-start gap-1.5">
              <Label htmlFor="invoice-payment-reference">Payment Reference</Label>
              <Input
                id="invoice-payment-reference"
                maxLength={PAYMENT_REFERENCE_MAX}
                autoComplete="off"
                value={draft.paymentReference}
                onChange={(event) =>
                  dispatch({
                    type: 'setField',
                    field: 'paymentReference',
                    value: event.target.value
                  })
                }
              />
              {errors.paymentReference ? (
                <CellError message={errors.paymentReference} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Cheque or transfer number. Optional.
                </p>
              )}
            </div>
          </div>
        )}
        <CellError message={errors.totals} />
      </CardContent>
    </Card>
  )
}

function TotalRow({
  label,
  value,
  strong,
  large,
  className = ''
}: {
  label: string
  value: string
  strong?: boolean
  large?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</dt>
      <dd
        className={`tabular-nums ${strong ? 'font-semibold' : ''} ${large ? 'text-lg' : ''} ${className}`}
      >
        {value}
      </dd>
    </div>
  )
}

function InputRow({
  id,
  label,
  value,
  hint,
  error,
  readOnly,
  onChange
}: {
  id: string
  label: string
  value: string
  hint?: string
  error: string | undefined
  readOnly?: boolean
  onChange?: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-4">
        <dt>
          <Label htmlFor={id} className="font-normal text-muted-foreground">
            {label}
          </Label>
        </dt>
        <dd className="w-40">
          <Input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            className="text-right tabular-nums read-only:bg-muted"
            aria-invalid={error ? true : undefined}
            readOnly={readOnly}
            value={value}
            onChange={(event) => onChange?.(event.target.value)}
          />
        </dd>
      </div>
      {error ? (
        <p className="text-right text-xs text-destructive">{error}</p>
      ) : (
        hint && <p className="text-right text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}
