import { Plus, Trash2, TriangleAlert } from 'lucide-react'
import { PRICE_TIER_LABELS, type PriceTier } from '@shared/invoices'
import { Badge } from '@renderer/components/ui/badge'
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
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import {
  sellableUnits,
  type DiscountKind,
  type InvoiceDraftAction,
  type LineDraft
} from './invoice-draft'
import type { LineSummary } from './invoice-summary'

export interface InvoiceLineCardProps {
  readonly line: LineDraft
  readonly index: number
  readonly summary: LineSummary
  readonly priceTier: PriceTier
  readonly currency: CurrencyFormat
  /** Messages to show, by draft path. */
  readonly errors: Readonly<Record<string, string>>
  /** The stock warning of the line: shown at once, not only after Post Invoice. */
  readonly stockWarning: string | undefined
  readonly dispatch: (action: InvoiceDraftAction) => void
}

const DISCOUNT_KINDS: ReadonlyArray<[DiscountKind, string]> = [
  ['NONE', 'No discount'],
  ['PERCENT', 'Percent (%)'],
  ['AMOUNT', 'Amount']
]

/**
 * One product line: its quantity rows (unit, quantity, unit price), free scheme quantity, discount, scheme amount and
 * Ctn, with the line amounts, the stock in the product's units and a warning when the line needs more than the stock.
 */
export function InvoiceLineCard({
  line,
  index,
  summary,
  priceTier,
  currency,
  errors,
  stockWarning,
  dispatch
}: InvoiceLineCardProps): React.JSX.Element {
  const { product } = line
  const lineKey = line.key
  const units = sellableUnits(product)
  const tier = PRICE_TIER_LABELS[priceTier].toLowerCase()
  const error = (path: string): string | undefined => errors[`lines.${index}.${path}`]
  const label = `Line ${index + 1}`
  const amount = (value: number | null): string =>
    value === null ? '—' : formatAmount(value, currency)
  const unitChoices = (
    rows: readonly { readonly key: string; readonly unitId: number | null }[],
    rowKey: string
  ): typeof units =>
    units.filter((unit) => !rows.some((row) => row.key !== rowKey && row.unitId === unit.id))
  const canAddRow = units.some((unit) => !line.quantities.some((row) => row.unitId === unit.id))
  const canAddFree = units.some(
    (unit) => !line.freeQuantities.some((row) => row.unitId === unit.id)
  )
  const details = [
    product.companyName,
    product.packingLabel === null ? null : `Packing ${product.packingLabel}`
  ].filter((part) => part !== null)

  return (
    <section aria-label={`${label}: ${product.code} ${product.name}`} className="rounded-md border">
      <div className="flex flex-wrap items-start gap-3 border-b bg-muted/30 px-3 py-2">
        <span className="mt-0.5 w-5 text-sm text-muted-foreground tabular-nums">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            <span className="font-mono text-xs">{product.code}</span> {product.name}
          </p>
          {details.length > 0 && (
            <p className="text-xs text-muted-foreground">{details.join(' · ')}</p>
          )}
          <CellError message={error('product')} />
        </div>
        <p className="text-sm">
          <span className="text-muted-foreground">In stock</span>{' '}
          <span className="font-medium tabular-nums">{summary.stockText}</span>
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${label.toLowerCase()}`}
          onClick={() => dispatch({ type: 'removeLine', lineKey })}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>

      <div className="grid gap-4 p-3 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="flex min-w-0 flex-col gap-3">
          {units.length === 0 && (
            <p className="text-sm text-destructive">
              This product has no active unit that can be sold.
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-32">Unit</TableHead>
                <TableHead className="w-28">Quantity</TableHead>
                <TableHead className="w-44">Unit Price</TableHead>
                <TableHead className="w-32 text-right">Amount</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Remove</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {line.quantities.map((row, rowIndex) => {
                const rowSummary = summary.rows[rowIndex]
                const path = `quantities.${rowIndex}`
                const rowLabel = `${label} unit row ${rowIndex + 1}`
                return (
                  <TableRow key={row.key}>
                    <TableCell className="align-top">
                      <UnitSelect
                        value={row.unitId}
                        units={unitChoices(line.quantities, row.key)}
                        ariaLabel={`${rowLabel} unit`}
                        invalid={error(`${path}.unitId`) !== undefined}
                        onChange={(unitId) =>
                          dispatch({ type: 'setRowUnit', lineKey, rowKey: row.key, unitId })
                        }
                      />
                      <CellError message={error(`${path}.unitId`)} />
                    </TableCell>
                    <TableCell className="align-top">
                      <Input
                        aria-label={`${rowLabel} quantity`}
                        inputMode="numeric"
                        autoComplete="off"
                        className="text-right tabular-nums"
                        aria-invalid={error(`${path}.quantity`) ? true : undefined}
                        value={row.quantity}
                        onChange={(event) =>
                          dispatch({
                            type: 'setRowQuantity',
                            lineKey,
                            rowKey: row.key,
                            value: event.target.value
                          })
                        }
                      />
                      <CellError message={error(`${path}.quantity`)} />
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <Input
                        aria-label={`${rowLabel} unit price`}
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder={rowSummary?.missingPrice ? 'Custom price' : '0.00'}
                        className="text-right tabular-nums"
                        aria-invalid={error(`${path}.price`) ? true : undefined}
                        value={row.price}
                        onChange={(event) =>
                          dispatch({
                            type: 'setRowPrice',
                            lineKey,
                            rowKey: row.key,
                            value: event.target.value
                          })
                        }
                      />
                      {rowSummary?.custom && (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <Badge variant="warning">Custom price</Badge>
                          {rowSummary.configuredPriceMinor !== null && (
                            <Button
                              type="button"
                              variant="link"
                              size="xs"
                              className="h-auto p-0"
                              title={`The ${tier} price is ${formatAmount(rowSummary.configuredPriceMinor, currency)}.`}
                              onClick={() =>
                                dispatch({ type: 'resetRowPrice', lineKey, rowKey: row.key })
                              }
                            >
                              Use list price
                            </Button>
                          )}
                        </div>
                      )}
                      {rowSummary?.missingPrice && error(`${path}.price`) === undefined && (
                        <p className="mt-1 text-xs text-amber-700">
                          No {tier} price: enter a custom price.
                        </p>
                      )}
                      <CellError message={error(`${path}.price`)} />
                    </TableCell>
                    <TableCell className="pt-4 text-right align-top tabular-nums">
                      {amount(rowSummary?.amountMinor ?? null)}
                    </TableCell>
                    <TableCell className="align-top">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${rowLabel.toLowerCase()}`}
                        disabled={line.quantities.length === 1}
                        onClick={() =>
                          dispatch({ type: 'removeQuantityRow', lineKey, rowKey: row.key })
                        }
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canAddRow}
              onClick={() => dispatch({ type: 'addQuantityRow', lineKey })}
            >
              <Plus aria-hidden />
              Add unit
            </Button>
            <p className="text-sm">
              <span className="text-muted-foreground">Leaving stock</span>{' '}
              <span className="font-medium tabular-nums">{summary.requestedText}</span>
              {summary.schemeQtyBase > 0 && (
                <span className="text-muted-foreground"> (free goods included)</span>
              )}
            </p>
          </div>
          {stockWarning !== undefined && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{stockWarning}</span>
            </p>
          )}
          <CellError message={error('quantities')} />

          <div className="grid gap-2 rounded-md bg-muted/30 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Free scheme quantity</p>
              <p className="text-xs text-muted-foreground">
                Goods given free: they leave stock, and nothing is charged for them.
              </p>
            </div>
            {line.freeQuantities.map((row, rowIndex) => {
              const path = `freeQuantities.${rowIndex}`
              const rowLabel = `${label} free row ${rowIndex + 1}`
              return (
                <div key={row.key} className="flex flex-wrap items-start gap-2">
                  <div className="w-40">
                    <UnitSelect
                      value={row.unitId}
                      units={unitChoices(line.freeQuantities, row.key)}
                      ariaLabel={`${rowLabel} unit`}
                      invalid={error(`${path}.unitId`) !== undefined}
                      onChange={(unitId) =>
                        dispatch({ type: 'setFreeUnit', lineKey, rowKey: row.key, unitId })
                      }
                    />
                    <CellError message={error(`${path}.unitId`)} />
                  </div>
                  <div className="w-28">
                    <Input
                      aria-label={`${rowLabel} quantity`}
                      inputMode="numeric"
                      autoComplete="off"
                      className="text-right tabular-nums"
                      aria-invalid={error(`${path}.quantity`) ? true : undefined}
                      value={row.quantity}
                      onChange={(event) =>
                        dispatch({
                          type: 'setFreeQuantity',
                          lineKey,
                          rowKey: row.key,
                          value: event.target.value
                        })
                      }
                    />
                    <CellError message={error(`${path}.quantity`)} />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${rowLabel.toLowerCase()}`}
                    onClick={() => dispatch({ type: 'removeFreeRow', lineKey, rowKey: row.key })}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              )
            })}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              disabled={!canAddFree}
              onClick={() => dispatch({ type: 'addFreeRow', lineKey })}
            >
              <Plus aria-hidden />
              Add free quantity
            </Button>
          </div>
        </div>

        <div className="grid content-start gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${lineKey}-discount`}>Discount</Label>
            <div className="flex gap-2">
              <Select
                value={line.discountKind}
                onValueChange={(value) => {
                  // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
                  if (value !== '')
                    dispatch({ type: 'setDiscountKind', lineKey, kind: value as DiscountKind })
                }}
              >
                <SelectTrigger aria-label={`${label} discount type`} className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DISCOUNT_KINDS.map(([kind, text]) => (
                    <SelectItem key={kind} value={kind}>
                      {text}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                id={`${lineKey}-discount`}
                inputMode="decimal"
                autoComplete="off"
                className="text-right tabular-nums"
                disabled={line.discountKind === 'NONE'}
                placeholder={line.discountKind === 'PERCENT' ? '0 %' : '0.00'}
                aria-invalid={error('discount') ? true : undefined}
                value={line.discount}
                onChange={(event) =>
                  dispatch({
                    type: 'setLineField',
                    lineKey,
                    field: 'discount',
                    value: event.target.value
                  })
                }
              />
            </div>
            <CellError message={error('discount')} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${lineKey}-scheme`}>Scheme amount</Label>
            <Input
              id={`${lineKey}-scheme`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              className="text-right tabular-nums"
              aria-invalid={error('scheme') ? true : undefined}
              value={line.scheme}
              onChange={(event) =>
                dispatch({
                  type: 'setLineField',
                  lineKey,
                  field: 'scheme',
                  value: event.target.value
                })
              }
            />
            <CellError message={error('scheme')} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${lineKey}-ctn`}>Ctn</Label>
            <Input
              id={`${lineKey}-ctn`}
              inputMode="numeric"
              autoComplete="off"
              className="text-right tabular-nums"
              aria-invalid={error('ctn') ? true : undefined}
              value={line.ctn}
              onChange={(event) =>
                dispatch({ type: 'setLineField', lineKey, field: 'ctn', value: event.target.value })
              }
            />
            {error('ctn') === undefined && (
              <p className="text-xs text-muted-foreground">Optional. Printed as written.</p>
            )}
            <CellError message={error('ctn')} />
          </div>
          <dl className="grid gap-1 rounded-md border px-3 py-2 text-sm">
            <AmountRow label="Gross" value={amount(summary.grossMinor)} />
            <AmountRow label="Discount" value={amount(summary.discountMinor)} />
            <AmountRow label="Scheme" value={amount(summary.schemeMinor)} />
            <AmountRow label="Net" value={amount(summary.netMinor)} strong />
          </dl>
          <CellError message={error('amounts')} />
        </div>
      </div>
    </section>
  )
}

function UnitSelect({
  value,
  units,
  ariaLabel,
  invalid,
  onChange
}: {
  value: number | null
  units: ReturnType<typeof sellableUnits>
  ariaLabel: string
  invalid: boolean
  onChange: (unitId: number) => void
}): React.JSX.Element {
  return (
    <Select
      value={value === null ? '' : String(value)}
      onValueChange={(next) => {
        // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
        if (next !== '') onChange(Number(next))
      }}
    >
      <SelectTrigger
        className="w-full"
        aria-label={ariaLabel}
        aria-invalid={invalid ? true : undefined}
      >
        <SelectValue placeholder="Unit" />
      </SelectTrigger>
      <SelectContent>
        {units.map((unit) => (
          <SelectItem key={unit.id} value={String(unit.id)}>
            {unit.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function AmountRow({
  label,
  value,
  strong
}: {
  label: string
  value: string
  strong?: boolean
}): React.JSX.Element {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`tabular-nums ${strong ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
  )
}

export function CellError({ message }: { message: string | undefined }): React.JSX.Element | null {
  return message ? (
    <p className="mt-1 text-xs whitespace-normal text-destructive">{message}</p>
  ) : null
}
