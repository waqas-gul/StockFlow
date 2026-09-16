import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatDisplayDate } from '@shared/dates'
import { ADJUSTMENT_REASON_INFO } from '@shared/stock'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import { adjustmentListQuery } from '@renderer/lib/app-queries'
import type { CurrencyFormat } from '../products/product-display'
import { Pager } from './Pager'
import { adjustmentQuantityText, signedAmount } from './stock-display'

export const ADJUSTMENTS_PAGE_SIZE = 20

/** Adjustment history, newest first. Adjustments are never edited: a mistake is corrected by another adjustment. */
export function AdjustmentHistory({ currency }: { currency: CurrencyFormat }): React.JSX.Element {
  const [page, setPage] = useState(1)
  const list = useQuery(
    adjustmentListQuery({ page, pageSize: ADJUSTMENTS_PAGE_SIZE, productId: null })
  )

  if (list.error) {
    return <p className="px-4 py-8 text-center text-sm text-destructive">{list.error.message}</p>
  }
  if (!list.data) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
  }
  if (list.data.items.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-muted-foreground">No adjustments yet.</p>
    )
  }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Adjustment</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Product</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead className="text-right">Quantity</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="pr-4">Note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.data.items.map((adjustment) => (
            <TableRow key={adjustment.id}>
              <TableCell className="pl-4 font-mono text-xs">{adjustment.adjustmentNo}</TableCell>
              <TableCell>{formatDisplayDate(adjustment.adjustmentDate)}</TableCell>
              <TableCell className="whitespace-normal">
                <span className="font-mono text-xs">{adjustment.productCode}</span>{' '}
                {adjustment.productName}
              </TableCell>
              <TableCell>
                {ADJUSTMENT_REASON_INFO[adjustment.reason].label}
                {adjustment.receiptNo && (
                  <div className="text-xs text-muted-foreground">
                    {adjustment.receiptNo}, line {adjustment.receiptLineNo}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right">{adjustmentQuantityText(adjustment)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {signedAmount(adjustment.valueMinor, currency)}
              </TableCell>
              <TableCell className="max-w-72 pr-4 whitespace-normal">
                {adjustment.reasonNote}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Pager
        page={page}
        pageSize={ADJUSTMENTS_PAGE_SIZE}
        shown={list.data.items.length}
        total={list.data.total}
        onPage={setPage}
      />
    </>
  )
}
