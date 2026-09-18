import { Plus, Trash2, TriangleAlert } from 'lucide-react'
import { PRICE_TIER_LABELS, type PriceTier } from '@shared/invoices'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { TableBody, TableCell, TableRow } from '@renderer/components/ui/table'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import {
  sellableUnits,
  type DiscountKind,
  type InvoiceDraftAction,
  type LineDraft
} from './invoice-draft'
import type { LineSummary } from './invoice-summary'

export interface InvoiceLineRowsProps {
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

/** What the discount box shows for its kind, in the width a table column has for it. */
const DISCOUNT_SHORT: Record<DiscountKind, string> = { NONE: '—', PERCENT: '%', AMOUNT: 'Rs' }

/** The columns the unit rows sit in: unit, quantity, unit price, amount, and the button that removes the row. */
const UNIT_COLUMNS = 5

/**
 * One product of the invoice, as rows of the shared Products table: the product, what is sold in which unit, the
 * discount, the scheme amount, Ctn and the line's net, all on one line across the table.
 *
 * A product sold in more than one unit (2 Carton + 5 Piece) takes one row per unit, and free scheme goods take one
 * more each; the cells that belong to the whole line — the product, the discount, the scheme, Ctn and the net — span
 * them all, so they are still read and entered once.
 */
export function InvoiceLineRows({
  line,
  index,
  summary,
  priceTier,
  currency,
  errors,
  stockWarning,
  dispatch
}: InvoiceLineRowsProps): React.JSX.Element {
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
  // The whole-line cells cover every row this product takes: its units, its free goods and the row of buttons.
  const rowSpan = line.quantities.length + line.freeQuantities.length + 1

  return (
    <TableBody className="border-b [&_tr]:border-0">
      {line.quantities.map((row, rowIndex) => {
        const rowSummary = summary.rows[rowIndex]
        const path = `quantities.${rowIndex}`
        const rowLabel = `${label} unit row ${rowIndex + 1}`
        const first = rowIndex === 0
        return (
          <TableRow key={row.key} className="hover:bg-transparent">
            {first && (
              <TableCell rowSpan={rowSpan} className="align-top text-sm text-muted-foreground">
                {index + 1}
              </TableCell>
            )}
            {first && (
              <TableCell rowSpan={rowSpan} className="align-top whitespace-normal">
                <p className="font-medium">
                  <span className="font-mono text-xs">{product.code}</span> {product.name}
                </p>
                {details.length > 0 && (
                  <p className="text-xs text-muted-foreground">{details.join(' · ')}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  In stock <span className="tabular-nums">{summary.stockText}</span>
                </p>
                <CellError message={error('product')} />
              </TableCell>
            )}
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
                placeholder="0"
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
                placeholder={rowSummary?.missingPrice ? 'Price' : '0.00'}
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
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge variant="warning">Custom price</Badge>
                  {rowSummary.configuredPriceMinor !== null && (
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto p-0"
                      title={`The ${tier} price is ${formatAmount(rowSummary.configuredPriceMinor, currency)}.`}
                      onClick={() => dispatch({ type: 'resetRowPrice', lineKey, rowKey: row.key })}
                    >
                      Use list price
                    </Button>
                  )}
                </div>
              )}
              {rowSummary?.missingPrice && error(`${path}.price`) === undefined && (
                <p className="mt-1 text-xs whitespace-normal text-amber-700">
                  No {tier} price: type one.
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
                onClick={() => dispatch({ type: 'removeQuantityRow', lineKey, rowKey: row.key })}
              >
                <Trash2 aria-hidden />
              </Button>
            </TableCell>

            {first && (
              <TableCell rowSpan={rowSpan} className="align-top">
                <div className="flex gap-1">
                  <Select
                    value={line.discountKind}
                    onValueChange={(value) => {
                      // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
                      if (value !== '')
                        dispatch({ type: 'setDiscountKind', lineKey, kind: value as DiscountKind })
                    }}
                  >
                    <SelectTrigger aria-label={`${label} discount type`} className="w-16">
                      <SelectValue>{DISCOUNT_SHORT[line.discountKind]}</SelectValue>
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
                    aria-label={`${label} discount`}
                    inputMode="decimal"
                    autoComplete="off"
                    className="w-20 text-right tabular-nums"
                    disabled={line.discountKind === 'NONE'}
                    placeholder={line.discountKind === 'PERCENT' ? '0' : '0.00'}
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
              </TableCell>
            )}
            {first && (
              <TableCell rowSpan={rowSpan} className="align-top">
                <Input
                  aria-label={`${label} scheme amount`}
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
              </TableCell>
            )}
            {first && (
              <TableCell rowSpan={rowSpan} className="align-top">
                <Input
                  aria-label={`${label} ctn`}
                  inputMode="numeric"
                  autoComplete="off"
                  className="text-right tabular-nums"
                  aria-invalid={error('ctn') ? true : undefined}
                  value={line.ctn}
                  onChange={(event) =>
                    dispatch({
                      type: 'setLineField',
                      lineKey,
                      field: 'ctn',
                      value: event.target.value
                    })
                  }
                />
                <CellError message={error('ctn')} />
              </TableCell>
            )}
            {first && (
              <TableCell rowSpan={rowSpan} className="pt-4 text-right align-top">
                <span className="font-semibold tabular-nums">{amount(summary.netMinor)}</span>
                {summary.discountMinor !== null && summary.discountMinor > 0 && (
                  <p className="text-xs text-muted-foreground">
                    was <span className="tabular-nums">{amount(summary.grossMinor)}</span>
                  </p>
                )}
                <CellError message={error('amounts')} />
              </TableCell>
            )}
            {first && (
              <TableCell rowSpan={rowSpan} className="align-top">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${label.toLowerCase()}`}
                  onClick={() => dispatch({ type: 'removeLine', lineKey })}
                >
                  <Trash2 aria-hidden />
                </Button>
              </TableCell>
            )}
          </TableRow>
        )
      })}

      {line.freeQuantities.map((row, rowIndex) => {
        const path = `freeQuantities.${rowIndex}`
        const rowLabel = `${label} free row ${rowIndex + 1}`
        return (
          <TableRow key={row.key} className="hover:bg-transparent">
            <TableCell className="align-top">
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
                    type: 'setFreeQuantity',
                    lineKey,
                    rowKey: row.key,
                    value: event.target.value
                  })
                }
              />
              <CellError message={error(`${path}.quantity`)} />
            </TableCell>
            <TableCell colSpan={2} className="align-middle text-xs whitespace-normal">
              <Badge variant="secondary">Free</Badge>{' '}
              <span className="text-muted-foreground">
                given free: leaves stock, nothing is charged.
              </span>
            </TableCell>
            <TableCell className="align-top">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${rowLabel.toLowerCase()}`}
                onClick={() => dispatch({ type: 'removeFreeRow', lineKey, rowKey: row.key })}
              >
                <Trash2 aria-hidden />
              </Button>
            </TableCell>
          </TableRow>
        )
      })}

      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={UNIT_COLUMNS} className="whitespace-normal">
          {units.length === 0 && (
            <p className="mb-2 text-sm text-destructive">
              This product has no active unit that can be sold.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!canAddRow}
              onClick={() => dispatch({ type: 'addQuantityRow', lineKey })}
            >
              <Plus aria-hidden />
              Add unit
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!canAddFree}
              onClick={() => dispatch({ type: 'addFreeRow', lineKey })}
            >
              <Plus aria-hidden />
              Free goods
            </Button>
            <p className="text-xs text-muted-foreground">
              Leaving stock <span className="tabular-nums">{summary.requestedText}</span>
              {summary.schemeQtyBase > 0 && ' (free goods included)'}
            </p>
          </div>
          {stockWarning !== undefined && (
            <p
              role="alert"
              className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{stockWarning}</span>
            </p>
          )}
          <CellError message={error('quantities')} />
        </TableCell>
      </TableRow>
    </TableBody>
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

export function CellError({ message }: { message: string | undefined }): React.JSX.Element | null {
  return message ? (
    <p className="mt-1 text-xs whitespace-normal text-destructive">{message}</p>
  ) : null
}
