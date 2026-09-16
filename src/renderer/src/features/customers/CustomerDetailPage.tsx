import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, HandCoins, Info, Pencil, Power, PowerOff, Scale } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { isWalkInCustomer, type Customer, type CustomerLedger } from '@shared/customers'
import { formatDisplayDate } from '@shared/dates'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import {
  customerLedgerQuery,
  customerQuery,
  refreshAfterCustomerChange,
  settingsQuery
} from '@renderer/lib/app-queries'
import { NotFoundPage } from '@renderer/app/NotFoundPage'
import { PaymentDetailDialog } from '../payments/PaymentDetailDialog'
import { ReceivePaymentDialog } from '../payments/ReceivePaymentDialog'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { Pager } from '../stock/Pager'
import { BalanceAdjustmentDialog } from './BalanceAdjustmentDialog'
import { toggleCustomerActive, type CustomerNotifier } from './customer-actions'
import {
  balanceClassName,
  balanceDescription,
  balanceText,
  deactivateText,
  ledgerAmounts,
  ledgerReference,
  ledgerTypeLabel
} from './customer-display'
import { CustomerFormDialog } from './CustomerFormDialog'

export const LEDGER_PAGE_SIZE = 50

const notify: CustomerNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

/** Customers → a customer: profile, balance, actions and the account ledger with its running balance. */
export function CustomerDetailPage(): React.JSX.Element {
  const params = useParams()
  const id = Number(params.customerId)
  if (!Number.isSafeInteger(id) || id <= 0) return <NotFoundPage />
  return <CustomerDetail key={id} customerId={id} />
}

function CustomerDetail({ customerId }: { customerId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const settings = useQuery(settingsQuery)
  const customer = useQuery(customerQuery(customerId))
  // null asks for the last page, where the latest entries are.
  const [page, setPage] = useState<number | null>(null)
  const ledger = useQuery(customerLedgerQuery({ customerId, page, pageSize: LEDGER_PAGE_SIZE }))
  const [dialog, setDialog] = useState<'payment' | 'adjust' | 'edit' | 'deactivate' | null>(null)
  const [paymentId, setPaymentId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const currency: CurrencyFormat | null = settings.data
    ? {
        minorDigits: settings.data.values['currency.minorDigits'],
        symbol: settings.data.values['currency.symbol']
      }
    : null

  const refresh = (): void => {
    // New entries go to the end: show the last page again.
    setPage(null)
    refreshAfterCustomerChange(queryClient)
  }

  const setActive = async (target: Customer, active: boolean): Promise<void> => {
    setDialog(null)
    setBusy(true)
    await toggleCustomerActive(
      window.api.customers,
      { id: target.id, code: target.code, active },
      notify
    )
    setBusy(false)
    refreshAfterCustomerChange(queryClient)
  }

  if (customer.error) {
    return (
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <BackLink />
        <p className="text-sm text-destructive">{customer.error.message}</p>
      </div>
    )
  }
  if (!customer.data || currency === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  const current = customer.data
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 pb-6">
      <BackLink />
      <CustomerDetailView
        customer={current}
        ledger={ledger.data?.customer.id === current.id ? ledger.data : undefined}
        ledgerError={ledger.error?.message}
        currency={currency}
        busy={busy}
        onPage={setPage}
        onReceivePayment={() => setDialog('payment')}
        onAdjustBalance={() => setDialog('adjust')}
        onEdit={() => setDialog('edit')}
        onToggleActive={() =>
          current.isActive ? setDialog('deactivate') : void setActive(current, true)
        }
        onOpenPayment={setPaymentId}
      />

      <ReceivePaymentDialog
        open={dialog === 'payment'}
        customer={current}
        currency={currency}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null)
          refresh()
        }}
      />
      <BalanceAdjustmentDialog
        open={dialog === 'adjust'}
        customer={current}
        currency={currency}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null)
          refresh()
        }}
      />
      <CustomerFormDialog
        target={dialog === 'edit' ? { mode: 'edit', id: current.id } : null}
        currency={currency}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null)
          refreshAfterCustomerChange(queryClient)
        }}
      />
      <PaymentDetailDialog
        paymentId={paymentId}
        currency={currency}
        onClose={() => setPaymentId(null)}
        onVoided={refresh}
      />
      <AlertDialog open={dialog === 'deactivate'} onOpenChange={(open) => !open && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Deactivate {current.code} {current.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deactivateText(balanceText(current.balanceMinor, currency))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button onClick={() => void setActive(current, false)}>Deactivate</Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function BackLink(): React.JSX.Element {
  return (
    <Button variant="ghost" size="sm" className="self-start" asChild>
      <Link to="/customers">
        <ArrowLeft aria-hidden />
        Customers
      </Link>
    </Button>
  )
}

export interface CustomerDetailViewProps {
  readonly customer: Customer
  /** The ledger page; undefined while it loads. */
  readonly ledger: CustomerLedger | undefined
  readonly ledgerError?: string
  readonly currency: CurrencyFormat
  /** A status change is running: its button is disabled. */
  readonly busy: boolean
  readonly onPage: (page: number) => void
  readonly onReceivePayment: () => void
  readonly onAdjustBalance: () => void
  readonly onEdit: () => void
  readonly onToggleActive: () => void
  readonly onOpenPayment: (paymentId: number) => void
}

export function CustomerDetailView({
  customer,
  ledger,
  ledgerError,
  currency,
  busy,
  onPage,
  onReceivePayment,
  onAdjustBalance,
  onEdit,
  onToggleActive,
  onOpenPayment
}: CustomerDetailViewProps): React.JSX.Element {
  const profile: Array<[string, string | null]> = [
    ['Shop', customer.shopName],
    ['Phone', customer.phone],
    ['City', customer.city],
    ['Address', customer.address],
    ['Notes', customer.notes]
  ]
  return (
    <>
      <Card className="gap-4 py-5">
        <CardContent className="flex flex-wrap items-start justify-between gap-6 px-5">
          <div className="flex min-w-72 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{customer.name}</h1>
              <span className="font-mono text-sm text-muted-foreground">{customer.code}</span>
              {customer.isActive ? (
                <Badge variant="success">Active</Badge>
              ) : (
                <Badge variant="secondary">Inactive</Badge>
              )}
            </div>
            <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
              {profile.map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="whitespace-normal">{value ?? '—'}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="flex min-w-56 flex-col items-end gap-1 text-right">
            <span className="text-sm text-muted-foreground">Current balance</span>
            <span
              className={`text-2xl font-semibold tabular-nums ${balanceClassName(customer.balanceMinor)}`}
            >
              {balanceText(customer.balanceMinor, currency)}
            </span>
            <span className="text-xs text-muted-foreground">
              {balanceDescription(customer.balanceMinor)}
            </span>
          </div>
        </CardContent>
        <CardContent className="flex flex-wrap gap-2 border-t px-5 pt-4">
          <Button
            onClick={onReceivePayment}
            disabled={!customer.isActive}
            title={customer.isActive ? undefined : 'Reactivate the customer to receive a payment.'}
          >
            <HandCoins aria-hidden />
            Receive Payment
          </Button>
          <Button variant="outline" onClick={onAdjustBalance}>
            <Scale aria-hidden />
            Adjust Balance
          </Button>
          <Button variant="outline" onClick={onEdit}>
            <Pencil aria-hidden />
            Edit Customer
          </Button>
          {/* The walk-in customer is always active; an old inactive one can still be reactivated. */}
          {!(isWalkInCustomer(customer.code) && customer.isActive) && (
            <Button variant="ghost" onClick={onToggleActive} disabled={busy}>
              {customer.isActive ? <PowerOff aria-hidden /> : <Power aria-hidden />}
              {customer.isActive ? 'Deactivate' : 'Reactivate'}
            </Button>
          )}
        </CardContent>
      </Card>

      {!customer.isActive && (
        <Alert>
          <Info aria-hidden />
          <AlertDescription>
            This customer is inactive. The account history stays visible and payments can still be
            voided or the balance corrected; receiving a new payment needs the customer to be
            reactivated.
          </AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
          <CardTitle>Account Ledger</CardTitle>
          <p className="text-xs text-muted-foreground">
            Increase: the customer owes more. Decrease: payments and credits, the customer owes
            less. Entries are never edited; corrections appear as new entries.
          </p>
        </CardHeader>
        {ledgerError ? (
          <p className="px-4 py-8 text-center text-sm text-destructive">{ledgerError}</p>
        ) : ledger === undefined ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : ledger.total === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No account entries yet.
          </p>
        ) : (
          <CustomerLedgerTable
            ledger={ledger}
            currency={currency}
            onPage={onPage}
            onOpenPayment={onOpenPayment}
          />
        )}
      </Card>
    </>
  )
}

function CustomerLedgerTable({
  ledger,
  currency,
  onPage,
  onOpenPayment
}: {
  ledger: CustomerLedger
  currency: CurrencyFormat
  onPage: (page: number) => void
  onOpenPayment: (paymentId: number) => void
}): React.JSX.Element {
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Date</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead className="text-right">Increase (owes more)</TableHead>
            <TableHead className="text-right">Decrease (owes less)</TableHead>
            <TableHead className="pr-4 text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ledger.rows.map((row) => {
            const { increaseMinor, decreaseMinor } = ledgerAmounts(row)
            const reference = ledgerReference(row)
            return (
              <TableRow key={row.id}>
                <TableCell className="pl-4 align-top">{formatDisplayDate(row.entryDate)}</TableCell>
                <TableCell className="max-w-80 align-top whitespace-normal">
                  <div>
                    {ledgerTypeLabel(row)}
                    {row.type === 'PAYMENT' && row.paymentStatus === 'VOID' && (
                      <span className="text-xs text-muted-foreground"> (voided)</span>
                    )}
                  </div>
                  {row.note && <div className="text-xs text-muted-foreground">{row.note}</div>}
                </TableCell>
                <TableCell className="align-top">
                  {row.paymentId !== null ? (
                    <Button
                      variant="link"
                      className="h-auto p-0 font-mono text-xs"
                      onClick={() => onOpenPayment(row.paymentId!)}
                    >
                      {reference}
                    </Button>
                  ) : (
                    <span className="font-mono text-xs">{reference}</span>
                  )}
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">
                  {increaseMinor === null ? '' : formatAmount(increaseMinor, currency)}
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">
                  {decreaseMinor === null ? '' : formatAmount(decreaseMinor, currency)}
                </TableCell>
                <TableCell
                  className={`pr-4 text-right align-top font-medium tabular-nums ${balanceClassName(row.runningBalanceMinor)}`}
                >
                  {balanceText(row.runningBalanceMinor, currency)}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <Pager
        page={ledger.page}
        pageSize={ledger.pageSize}
        shown={ledger.rows.length}
        total={ledger.total}
        onPage={onPage}
      />
    </>
  )
}
