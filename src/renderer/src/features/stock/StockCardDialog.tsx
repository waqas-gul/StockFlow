import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatDisplayDate } from '@shared/dates'
import type { StockCard } from '@shared/stock'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import { stockCardQuery } from '@renderer/lib/app-queries'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { Pager } from './Pager'
import { movementLabel, quantityInUnits } from './stock-display'

export const STOCK_CARD_PAGE_SIZE = 50

/** A product's stock card: every movement, oldest first, with the running quantity and value. Read-only. */
export function StockCardDialog({
  productId,
  currency,
  onClose
}: {
  productId: number | null
  currency: CurrencyFormat
  onClose: () => void
}): React.JSX.Element {
  // null asks for the last page, where the latest movements are.
  const [page, setPage] = useState<number | null>(null)
  const card = useQuery({
    ...stockCardQuery({ productId: productId ?? 0, page, pageSize: STOCK_CARD_PAGE_SIZE }),
    enabled: productId !== null
  })

  return (
    <Dialog
      open={productId !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPage(null)
          onClose()
        }
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[min(80rem,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>
            Stock Card{card.data ? `: ${card.data.product.code} ${card.data.product.name}` : ''}
          </DialogTitle>
          <DialogDescription>
            Every stock movement of the product. Rows are never edited; corrections appear as new
            rows.
          </DialogDescription>
        </DialogHeader>
        {card.data ? (
          <StockCardView card={card.data} currency={currency} onPage={setPage} />
        ) : (
          <p className={`text-sm ${card.error ? 'text-destructive' : 'text-muted-foreground'}`}>
            {card.error ? card.error.message : 'Loading…'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function StockCardView({
  card,
  currency,
  onPage
}: {
  card: StockCard
  currency: CurrencyFormat
  onPage: (page: number) => void
}): React.JSX.Element {
  const { product } = card
  const baseUnit = product.units.find((unit) => unit.isBase)?.name ?? 'base units'
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Current stock</dt>
          <dd className="mt-0.5 font-medium">{quantityInUnits(card.qtyBase, product.units)}</dd>
          <dd className="text-xs text-muted-foreground">
            {card.qtyBase.toLocaleString('en-US')} {baseUnit}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Stock value</dt>
          <dd className="mt-0.5 font-medium tabular-nums">
            {formatAmount(card.valueMinor, currency)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Packing</dt>
          <dd className="mt-0.5">{product.packingLabel ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Units</dt>
          <dd className="mt-0.5">
            {product.units
              .map((unit) =>
                unit.isBase ? `${unit.name} (base)` : `${unit.name} = ${unit.baseQty}`
              )
              .join(' · ')}
          </dd>
        </div>
      </dl>

      {card.total === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No stock movements yet.</p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Qty In</TableHead>
                <TableHead className="text-right">Qty Out</TableHead>
                <TableHead className="text-right">Value In</TableHead>
                <TableHead className="text-right">Value Out</TableHead>
                <TableHead className="text-right">Running Qty</TableHead>
                <TableHead className="pr-3 text-right">Running Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {card.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="pl-3">{formatDisplayDate(row.date)}</TableCell>
                  <TableCell>{movementLabel(row)}</TableCell>
                  <TableCell className="font-mono text-xs">{row.reference}</TableCell>
                  <NumberCell value={row.qtyInBase} />
                  <NumberCell value={row.qtyOutBase} />
                  <NumberCell
                    value={row.valueInMinor}
                    text={formatAmount(row.valueInMinor, currency)}
                  />
                  <NumberCell
                    value={row.valueOutMinor}
                    text={formatAmount(row.valueOutMinor, currency)}
                  />
                  <TableCell
                    className="text-right tabular-nums"
                    title={quantityInUnits(row.runningQtyBase, product.units)}
                  >
                    {row.runningQtyBase.toLocaleString('en-US')}
                  </TableCell>
                  <TableCell className="pr-3 text-right tabular-nums">
                    {formatAmount(row.runningValueMinor, currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            Quantities are in {baseUnit}. Hover a running quantity to see it in the product&apos;s
            units.
          </p>
          <Pager
            page={card.page}
            pageSize={card.pageSize}
            shown={card.rows.length}
            total={card.total}
            onPage={onPage}
          />
        </div>
      )}
    </div>
  )
}

/** A quantity or amount cell that shows nothing for zero, so in and out columns read at a glance. */
function NumberCell({ value, text }: { value: number; text?: string }): React.JSX.Element {
  return (
    <TableCell className="text-right tabular-nums">
      {value === 0 ? '' : (text ?? value.toLocaleString('en-US'))}
    </TableCell>
  )
}
