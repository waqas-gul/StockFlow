import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye, FilePlus, Search } from 'lucide-react'
import { Link } from 'react-router'
import { formatDisplayDate } from '@shared/dates'
import type { InvoiceListInput, InvoiceStatus, InvoiceSummary } from '@shared/invoices'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent } from '@renderer/components/ui/card'
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
import { invoiceListQuery, settingsQuery } from '@renderer/lib/app-queries'
import { useDebouncedValue } from '@renderer/lib/use-debounced-value'
import { balanceClassName, balanceText } from '../customers/customer-display'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { Pager } from '../stock/Pager'
import { INVOICE_STATUS_LABELS } from './invoice-history'

export const INVOICES_PAGE_SIZE = 25

/** Sales → Invoice History: saved invoices, newest first, with search, date and status filters. */
export function InvoiceHistoryPage(): React.JSX.Element {
  const settings = useQuery(settingsQuery)
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [status, setStatus] = useState<InvoiceListInput['status']>('all')
  const [page, setPage] = useState(1)
  const debouncedSearch = useDebouncedValue(search.trim(), 250)
  const rangeError =
    dateFrom !== '' && dateTo !== '' && dateFrom > dateTo
      ? 'The end date cannot be before the start date.'
      : null
  const list = useQuery({
    ...invoiceListQuery({
      page,
      pageSize: INVOICES_PAGE_SIZE,
      search: debouncedSearch,
      status,
      dateFrom: dateFrom === '' ? null : dateFrom,
      dateTo: dateTo === '' ? null : dateTo
    }),
    enabled: rangeError === null
  })

  const currency: CurrencyFormat | null = settings.data
    ? {
        minorDigits: settings.data.values['currency.minorDigits'],
        symbol: settings.data.values['currency.symbol']
      }
    : null

  const filtered = debouncedSearch !== '' || dateFrom !== '' || dateTo !== '' || status !== 'all'
  const changeFilter =
    <T,>(set: (value: T) => void) =>
    (value: T): void => {
      set(value)
      setPage(1)
    }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Invoice History</h1>
          <p className="text-sm text-muted-foreground">
            Saved invoices exactly as they were posted. A posted invoice is never edited; a mistake
            is voided. Outstanding is the customer&apos;s balance right after the invoice.
          </p>
        </div>
        <Button asChild>
          <Link to="/invoices/new">
            <FilePlus aria-hidden />
            New Invoice
          </Link>
        </Button>
      </div>

      <Card className="gap-0 py-0">
        <CardContent className="flex flex-wrap items-end gap-3 border-b px-4 py-3">
          <div className="relative min-w-64 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              aria-label="Search invoices"
              placeholder="Search by invoice no, customer, code or shop"
              className="pl-8"
              maxLength={100}
              value={search}
              onChange={(event) => changeFilter(setSearch)(event.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="invoices-from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="invoices-from"
              type="date"
              className="w-40"
              value={dateFrom}
              onChange={(event) => changeFilter(setDateFrom)(event.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="invoices-to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="invoices-to"
              type="date"
              className="w-40"
              value={dateTo}
              onChange={(event) => changeFilter(setDateTo)(event.target.value)}
            />
          </div>
          <Select
            value={status}
            onValueChange={(value) => {
              // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
              if (value !== '') changeFilter(setStatus)(value as InvoiceListInput['status'])
            }}
          >
            <SelectTrigger aria-label="Status" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="POSTED">Posted</SelectItem>
              <SelectItem value="VOID">Void</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>

        {rangeError !== null ? (
          <p className="px-4 py-8 text-center text-sm text-destructive">{rangeError}</p>
        ) : list.error ? (
          <p className="px-4 py-8 text-center text-sm text-destructive">{list.error.message}</p>
        ) : !list.data || currency === null ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : list.data.items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {filtered ? 'No invoices match the search or filters.' : 'No invoices yet.'}
          </p>
        ) : (
          <>
            <InvoicesTable items={list.data.items} currency={currency} />
            <Pager
              page={page}
              pageSize={INVOICES_PAGE_SIZE}
              shown={list.data.items.length}
              total={list.data.total}
              onPage={setPage}
            />
          </>
        )}
      </Card>
    </div>
  )
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }): React.JSX.Element {
  return (
    <Badge variant={status === 'POSTED' ? 'success' : 'secondary'}>
      {INVOICE_STATUS_LABELS[status]}
    </Badge>
  )
}

export function InvoicesTable({
  items,
  currency
}: {
  items: readonly InvoiceSummary[]
  currency: CurrencyFormat
}): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Invoice No</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Shop</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead className="text-right">Received</TableHead>
          <TableHead className="text-right">Outstanding</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-4 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((invoice) => (
          <TableRow
            key={invoice.id}
            className={invoice.status === 'VOID' ? 'text-muted-foreground' : undefined}
          >
            <TableCell className="pl-4 font-mono text-xs">{invoice.invoiceNo}</TableCell>
            <TableCell>{formatDisplayDate(invoice.invoiceDate)}</TableCell>
            <TableCell className="max-w-56 whitespace-normal">
              <div className="font-medium">{invoice.customerName}</div>
              <div className="font-mono text-xs text-muted-foreground">{invoice.customerCode}</div>
            </TableCell>
            <TableCell className="max-w-48 whitespace-normal">
              {invoice.customerShopName ?? <span className="text-muted-foreground">—</span>}
            </TableCell>
            <TableCell
              className={`text-right tabular-nums ${invoice.status === 'VOID' ? 'line-through' : 'font-medium'}`}
            >
              {formatAmount(invoice.totalMinor, currency)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatAmount(invoice.receivedMinor, currency)}
            </TableCell>
            <TableCell
              className={`text-right tabular-nums ${invoice.status === 'VOID' ? '' : balanceClassName(invoice.netOutstandingMinor)}`}
            >
              {balanceText(invoice.netOutstandingMinor, currency)}
            </TableCell>
            <TableCell>
              <InvoiceStatusBadge status={invoice.status} />
            </TableCell>
            <TableCell className="pr-4 text-right">
              <Button variant="ghost" size="sm" asChild>
                <Link to={`/invoices/${invoice.id}`} aria-label={`View ${invoice.invoiceNo}`}>
                  <Eye aria-hidden />
                  View
                </Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
