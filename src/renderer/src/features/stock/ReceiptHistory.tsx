import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye, Search } from 'lucide-react'
import { formatDisplayDate } from '@shared/dates'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import { receiptListQuery } from '@renderer/lib/app-queries'
import { useDebouncedValue } from '@renderer/lib/use-debounced-value'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { Pager } from './Pager'
import { ReceiptStatusBadge } from './ReceiptStatusBadge'

export const RECEIPTS_PAGE_SIZE = 20

/** Receipt history, newest first. */
export function ReceiptHistory({
  currency,
  onOpen
}: {
  currency: CurrencyFormat
  onOpen: (receiptId: number) => void
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const debounced = useDebouncedValue(search.trim(), 250)
  const list = useQuery(receiptListQuery({ page, pageSize: RECEIPTS_PAGE_SIZE, search: debounced }))

  return (
    <div className="flex flex-col">
      <div className="border-b px-4 py-3">
        <div className="relative max-w-md">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search receipts"
            placeholder="Search by receipt number, supplier or reference"
            className="pl-8"
            maxLength={100}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
          />
        </div>
      </div>
      {list.error ? (
        <p className="px-4 py-8 text-center text-sm text-destructive">{list.error.message}</p>
      ) : !list.data ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : list.data.items.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {debounced === '' ? 'No receipts yet.' : 'No receipt matches the search.'}
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Receipt No</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead className="text-right">Total Cost</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((receipt) => (
                <TableRow
                  key={receipt.id}
                  className={receipt.status === 'VOID' ? 'text-muted-foreground' : undefined}
                >
                  <TableCell className="pl-4 font-mono text-xs">{receipt.receiptNo}</TableCell>
                  <TableCell>{formatDisplayDate(receipt.receiptDate)}</TableCell>
                  <TableCell>
                    {receipt.supplierName ?? <span className="text-muted-foreground">—</span>}
                    {receipt.reference && (
                      <span className="text-xs text-muted-foreground"> · {receipt.reference}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatAmount(receipt.totalCostMinor, currency)}
                  </TableCell>
                  <TableCell>
                    <ReceiptStatusBadge receipt={receipt} />
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button variant="ghost" size="sm" onClick={() => onOpen(receipt.id)}>
                      <Eye aria-hidden />
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager
            page={page}
            pageSize={RECEIPTS_PAGE_SIZE}
            shown={list.data.items.length}
            total={list.data.total}
            onPage={setPage}
          />
        </>
      )}
    </div>
  )
}
