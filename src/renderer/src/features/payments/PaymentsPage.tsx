import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Ban, Eye, HandCoins, Search } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { formatDisplayDate } from '@shared/dates'
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type PaymentListInput,
  type PaymentSummary
} from '@shared/payments'
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
import { linkedId, wantsForm } from '@renderer/app/page-links'
import { paymentListQuery, settingsQuery } from '@renderer/lib/app-queries'
import { useDebouncedValue } from '@renderer/lib/use-debounced-value'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { Pager } from '../stock/Pager'
import { PaymentDetailDialog } from './PaymentDetailDialog'
import { PaymentStatusBadge } from './PaymentStatusBadge'
import { ReceivePaymentDialog } from './ReceivePaymentDialog'

export const PAYMENTS_PAGE_SIZE = 25

/**
 * Customers → Payments: every payment receipt, newest first, with filters, details, voids and Receive Payment.
 * `?receive=1` opens Receive Payment and `?payment=<id>` shows that payment (the Dashboard's links).
 */
export function PaymentsPage(): React.JSX.Element {
  const settings = useQuery(settingsQuery)
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [status, setStatus] = useState<PaymentListInput['status']>('all')
  const [method, setMethod] = useState<PaymentListInput['method']>('all')
  const [page, setPage] = useState(1)
  const [params] = useSearchParams()
  const [receiving, setReceiving] = useState(() => wantsForm(params, 'receive'))
  const [openPayment, setOpenPayment] = useState<number | null>(() => linkedId(params, 'payment'))
  const debouncedSearch = useDebouncedValue(search.trim(), 250)
  const rangeError =
    dateFrom !== '' && dateTo !== '' && dateFrom > dateTo
      ? 'The end date cannot be before the start date.'
      : null
  const list = useQuery({
    ...paymentListQuery({
      page,
      pageSize: PAYMENTS_PAGE_SIZE,
      search: debouncedSearch,
      status,
      method,
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

  const filtered =
    debouncedSearch !== '' ||
    dateFrom !== '' ||
    dateTo !== '' ||
    status !== 'all' ||
    method !== 'all'
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
          <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
          <p className="text-sm text-muted-foreground">
            Money received from customers. A saved payment is never edited; a mistake is voided.
          </p>
        </div>
        <Button onClick={() => setReceiving(true)} disabled={currency === null}>
          <HandCoins aria-hidden />
          Receive Payment
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
              aria-label="Search payments"
              placeholder="Search by payment no, customer, shop or reference"
              className="pl-8"
              maxLength={100}
              value={search}
              onChange={(event) => changeFilter(setSearch)(event.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="payments-from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="payments-from"
              type="date"
              className="w-40"
              value={dateFrom}
              onChange={(event) => changeFilter(setDateFrom)(event.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="payments-to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="payments-to"
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
              if (value !== '') changeFilter(setStatus)(value as PaymentListInput['status'])
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
          <Select
            value={method}
            onValueChange={(value) => {
              if (value !== '') changeFilter(setMethod)(value as PaymentListInput['method'])
            }}
          >
            <SelectTrigger aria-label="Method" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All methods</SelectItem>
              {PAYMENT_METHODS.map((item) => (
                <SelectItem key={item} value={item}>
                  {PAYMENT_METHOD_LABELS[item]}
                </SelectItem>
              ))}
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
            {filtered ? 'No payments match the search or filters.' : 'No payments yet.'}
          </p>
        ) : (
          <>
            <PaymentsTable items={list.data.items} currency={currency} onOpen={setOpenPayment} />
            <Pager
              page={page}
              pageSize={PAYMENTS_PAGE_SIZE}
              shown={list.data.items.length}
              total={list.data.total}
              onPage={setPage}
            />
          </>
        )}
      </Card>

      {currency !== null && (
        <>
          <ReceivePaymentDialog
            open={receiving}
            customer={null}
            currency={currency}
            onClose={() => setReceiving(false)}
            onSaved={() => setReceiving(false)}
          />
          <PaymentDetailDialog
            paymentId={openPayment}
            currency={currency}
            onClose={() => setOpenPayment(null)}
          />
        </>
      )}
    </div>
  )
}

function PaymentsTable({
  items,
  currency,
  onOpen
}: {
  items: readonly PaymentSummary[]
  currency: CurrencyFormat
  onOpen: (paymentId: number) => void
}): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Payment No</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Shop</TableHead>
          <TableHead>Method</TableHead>
          <TableHead>Reference</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-4 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((payment) => (
          <TableRow
            key={payment.id}
            className={payment.status === 'VOID' ? 'text-muted-foreground' : undefined}
          >
            <TableCell className="pl-4 font-mono text-xs">{payment.paymentNo}</TableCell>
            <TableCell>{formatDisplayDate(payment.paymentDate)}</TableCell>
            <TableCell className="max-w-56 whitespace-normal">
              <div className="font-medium">{payment.customerName}</div>
              <div className="font-mono text-xs text-muted-foreground">{payment.customerCode}</div>
            </TableCell>
            <TableCell className="max-w-48 whitespace-normal">
              {payment.shopName ?? <span className="text-muted-foreground">—</span>}
            </TableCell>
            <TableCell>{PAYMENT_METHOD_LABELS[payment.method]}</TableCell>
            <TableCell>
              {payment.reference ?? <span className="text-muted-foreground">—</span>}
            </TableCell>
            <TableCell
              className={`text-right tabular-nums ${payment.status === 'VOID' ? 'line-through' : ''}`}
            >
              {formatAmount(payment.amountMinor, currency)}
            </TableCell>
            <TableCell>
              <PaymentStatusBadge status={payment.status} />
            </TableCell>
            <TableCell className="pr-4 text-right">
              <div className="flex justify-end gap-1">
                <Button variant="ghost" size="sm" onClick={() => onOpen(payment.id)}>
                  <Eye aria-hidden />
                  View
                </Button>
                {payment.status === 'POSTED' && (
                  <Button variant="ghost" size="sm" onClick={() => onOpen(payment.id)}>
                    <Ban aria-hidden />
                    Void
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
