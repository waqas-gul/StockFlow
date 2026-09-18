import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  CalendarClock,
  HandCoins,
  Info,
  PackagePlus,
  Pencil,
  Power,
  PowerOff,
  Scale,
  Truck,
  Wallet,
  type LucideIcon
} from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import type { ListPage } from '@shared/customers'
import { formatDisplayDate } from '@shared/dates'
import { PAYMENT_METHOD_LABELS } from '@shared/payments'
import type { StockPage, StockReceiptSummary } from '@shared/stock'
import type { Supplier, SupplierLedger, SupplierPaymentSummary } from '@shared/suppliers'
import { NotFoundPage } from '@renderer/app/NotFoundPage'
import { pageLinks } from '@renderer/app/page-links'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
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
  receiptListQuery,
  refreshAfterSupplierChange,
  settingsQuery,
  supplierLedgerQuery,
  supplierPaymentListQuery,
  supplierQuery
} from '@renderer/lib/app-queries'
import { cn } from '@renderer/lib/utils'
import { PaymentStatusBadge } from '../payments/PaymentStatusBadge'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { Pager } from '../stock/Pager'
import { ReceiptDetailDialog } from '../stock/ReceiptDetailDialog'
import { ReceiptStatusBadge } from '../stock/ReceiptStatusBadge'
import { PaySupplierDialog } from './PaySupplierDialog'
import { toggleSupplierActive, type SupplierNotifier } from './supplier-actions'
import {
  supplierBalanceClassName,
  supplierBalanceDescription,
  supplierBalanceText,
  supplierLedgerAmount,
  supplierLedgerLabel,
  supplierLedgerReference
} from './supplier-display'
import { SupplierAdjustmentDialog } from './SupplierAdjustmentDialog'
import { SupplierDeactivateDialog } from './SupplierDeactivateDialog'
import { SupplierFormDialog } from './SupplierFormDialog'
import { SupplierPaymentDetailDialog } from './SupplierPaymentDetailDialog'

export const SUPPLIER_LEDGER_PAGE_SIZE = 50
export const SUPPLIER_DOCUMENTS_PAGE_SIZE = 25

export const SUPPLIER_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'purchases', label: 'Purchases' },
  { id: 'payments', label: 'Payments' },
  { id: 'ledger', label: 'Ledger' }
] as const
export type SupplierTab = (typeof SUPPLIER_TABS)[number]['id']

const notify: SupplierNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

/** Suppliers → a supplier: profile, balance, totals, actions, and its purchases, payments and account ledger. */
export function SupplierDetailPage(): React.JSX.Element {
  const params = useParams()
  const id = Number(params.supplierId)
  if (!Number.isSafeInteger(id) || id <= 0) return <NotFoundPage />
  return <SupplierDetail key={id} supplierId={id} />
}

function SupplierDetail({ supplierId }: { supplierId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const settings = useQuery(settingsQuery)
  const supplier = useQuery(supplierQuery(supplierId))
  const [tab, setTab] = useState<SupplierTab>('overview')
  // null asks for the last page, where the latest entries are.
  const [ledgerPage, setLedgerPage] = useState<number | null>(null)
  const [purchasePage, setPurchasePage] = useState(1)
  const [paymentPage, setPaymentPage] = useState(1)
  const ledger = useQuery({
    ...supplierLedgerQuery({ supplierId, page: ledgerPage, pageSize: SUPPLIER_LEDGER_PAGE_SIZE }),
    enabled: tab === 'ledger'
  })
  const purchases = useQuery({
    ...receiptListQuery({
      page: purchasePage,
      pageSize: SUPPLIER_DOCUMENTS_PAGE_SIZE,
      search: '',
      supplierId
    }),
    enabled: tab === 'purchases'
  })
  const payments = useQuery({
    ...supplierPaymentListQuery({
      page: paymentPage,
      pageSize: SUPPLIER_DOCUMENTS_PAGE_SIZE,
      search: '',
      status: 'all',
      method: 'all',
      supplierId,
      dateFrom: null,
      dateTo: null
    }),
    enabled: tab === 'payments'
  })
  const [dialog, setDialog] = useState<'pay' | 'adjust' | 'edit' | 'deactivate' | null>(null)
  const [paymentId, setPaymentId] = useState<number | null>(null)
  const [receiptId, setReceiptId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const currency: CurrencyFormat | null = settings.data
    ? {
        minorDigits: settings.data.values['currency.minorDigits'],
        symbol: settings.data.values['currency.symbol']
      }
    : null

  const refresh = (): void => {
    // New entries go to the end: show the last ledger page again.
    setLedgerPage(null)
    refreshAfterSupplierChange(queryClient)
  }

  const setActive = async (target: Supplier, active: boolean): Promise<void> => {
    setDialog(null)
    setBusy(true)
    await toggleSupplierActive(
      window.api.suppliers,
      { id: target.id, code: target.code, active },
      notify
    )
    setBusy(false)
    refreshAfterSupplierChange(queryClient)
  }

  if (supplier.error) {
    return (
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <BackLink />
        <p className="text-sm text-destructive">{supplier.error.message}</p>
      </div>
    )
  }
  if (!supplier.data || currency === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  const current = supplier.data
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 pb-6">
      <BackLink />
      <SupplierDetailView
        supplier={current}
        currency={currency}
        tab={tab}
        onTab={setTab}
        busy={busy}
        ledger={ledger.data?.supplier.id === current.id ? ledger.data : undefined}
        ledgerError={ledger.error?.message}
        purchases={purchases.data}
        purchasesError={purchases.error?.message}
        payments={payments.data}
        paymentsError={payments.error?.message}
        onLedgerPage={setLedgerPage}
        onPurchasePage={setPurchasePage}
        onPaymentPage={setPaymentPage}
        onNewPurchase={() => void navigate(pageLinks.stockInFromSupplier(current.id))}
        onPay={() => setDialog('pay')}
        onAdjust={() => setDialog('adjust')}
        onEdit={() => setDialog('edit')}
        onToggleActive={() =>
          current.isActive ? setDialog('deactivate') : void setActive(current, true)
        }
        onOpenPayment={setPaymentId}
        onOpenReceipt={setReceiptId}
      />

      <PaySupplierDialog
        open={dialog === 'pay'}
        supplier={current}
        currency={currency}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null)
          refresh()
        }}
      />
      <SupplierAdjustmentDialog
        open={dialog === 'adjust'}
        supplier={current}
        currency={currency}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null)
          refresh()
        }}
      />
      <SupplierFormDialog
        target={dialog === 'edit' ? { mode: 'edit', id: current.id } : null}
        currency={currency}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null)
          refreshAfterSupplierChange(queryClient)
        }}
      />
      <SupplierDeactivateDialog
        supplier={dialog === 'deactivate' ? current : null}
        currency={currency}
        onCancel={() => setDialog(null)}
        onConfirm={() => void setActive(current, false)}
      />
      <SupplierPaymentDetailDialog
        paymentId={paymentId}
        currency={currency}
        onClose={() => setPaymentId(null)}
        onOpenReceipt={(id) => {
          setPaymentId(null)
          setReceiptId(id)
        }}
        onVoided={refresh}
      />
      <ReceiptDetailDialog
        receiptId={receiptId}
        currency={currency}
        onClose={() => {
          setReceiptId(null)
          refresh()
        }}
      />
    </div>
  )
}

function BackLink(): React.JSX.Element {
  return (
    <Button variant="ghost" size="sm" className="self-start" asChild>
      <Link to={pageLinks.suppliers}>
        <ArrowLeft aria-hidden />
        Suppliers
      </Link>
    </Button>
  )
}

export interface SupplierDetailViewProps {
  readonly supplier: Supplier
  readonly currency: CurrencyFormat
  readonly tab: SupplierTab
  readonly onTab: (tab: SupplierTab) => void
  /** A status change is running: its button is disabled. */
  readonly busy: boolean
  /** Each tab's data; undefined while it loads (or before the tab is first shown). */
  readonly ledger: SupplierLedger | undefined
  readonly ledgerError?: string
  readonly purchases: StockPage<StockReceiptSummary> | undefined
  readonly purchasesError?: string
  readonly payments: ListPage<SupplierPaymentSummary> | undefined
  readonly paymentsError?: string
  readonly onLedgerPage: (page: number) => void
  readonly onPurchasePage: (page: number) => void
  readonly onPaymentPage: (page: number) => void
  readonly onNewPurchase: () => void
  readonly onPay: () => void
  readonly onAdjust: () => void
  readonly onEdit: () => void
  readonly onToggleActive: () => void
  readonly onOpenPayment: (paymentId: number) => void
  readonly onOpenReceipt: (receiptId: number) => void
}

export function SupplierDetailView(props: SupplierDetailViewProps): React.JSX.Element {
  const { supplier, currency, tab, onTab } = props
  const profile: Array<[string, string | null]> = [
    ['Contact', supplier.contactPerson],
    ['Phone', supplier.phone],
    ['City', supplier.city],
    ['Address', supplier.address],
    ['Notes', supplier.notes]
  ]
  return (
    <>
      <Card className="gap-4 py-5">
        <CardContent className="flex flex-wrap items-start justify-between gap-6 px-5">
          <div className="flex min-w-72 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{supplier.name}</h1>
              <span className="font-mono text-sm text-muted-foreground">{supplier.code}</span>
              {supplier.isActive ? (
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
              className={`text-2xl font-semibold tabular-nums ${supplierBalanceClassName(supplier.balanceMinor)}`}
            >
              {supplierBalanceText(supplier.balanceMinor, currency)}
            </span>
            <span className="text-xs text-muted-foreground">
              {supplierBalanceDescription(supplier.balanceMinor)}
            </span>
          </div>
        </CardContent>
        <CardContent className="flex flex-wrap gap-2 border-t px-5 pt-4">
          <Button
            onClick={props.onNewPurchase}
            disabled={!supplier.isActive}
            title={supplier.isActive ? undefined : 'Reactivate the supplier to record a purchase.'}
          >
            <PackagePlus aria-hidden />
            New Stock Purchase
          </Button>
          <Button variant="outline" onClick={props.onPay}>
            <HandCoins aria-hidden />
            Pay Supplier
          </Button>
          <Button variant="outline" onClick={props.onAdjust}>
            <Scale aria-hidden />
            Adjust Balance
          </Button>
          <Button variant="outline" onClick={props.onEdit}>
            <Pencil aria-hidden />
            Edit Supplier
          </Button>
          <Button variant="ghost" onClick={props.onToggleActive} disabled={props.busy}>
            {supplier.isActive ? <PowerOff aria-hidden /> : <Power aria-hidden />}
            {supplier.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
        </CardContent>
      </Card>

      {!supplier.isActive && (
        <Alert>
          <Info aria-hidden />
          <AlertDescription>
            This supplier is inactive. The history stays visible, and you can still pay the
            supplier, void a payment or adjust the balance; a new stock purchase needs the supplier
            to be reactivated.
          </AlertDescription>
        </Alert>
      )}

      <SummaryCards supplier={supplier} currency={currency} />

      <div role="tablist" aria-label="Supplier" className="flex gap-1 border-b">
        {SUPPLIER_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === item.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
            onClick={() => onTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <ProductsPurchased supplier={supplier} currency={currency} />
      ) : tab === 'purchases' ? (
        <PurchasesTab {...props} />
      ) : tab === 'payments' ? (
        <PaymentsTab {...props} />
      ) : (
        <LedgerTab {...props} />
      )}
    </>
  )
}

function SummaryCards({
  supplier,
  currency
}: {
  supplier: Supplier
  currency: CurrencyFormat
}): React.JSX.Element {
  const cards: ReadonlyArray<{
    label: string
    value: string
    note: string
    icon: LucideIcon
    className?: string
  }> = [
    {
      label: 'Total Purchases',
      value: formatAmount(supplier.totalPurchasesMinor, currency),
      note: `${supplier.purchaseCount.toLocaleString('en-US')} posted receipt${supplier.purchaseCount === 1 ? '' : 's'} (void excluded)`,
      icon: Truck
    },
    {
      label: 'Total Paid',
      value: formatAmount(supplier.totalPaidMinor, currency),
      note: `${supplier.paymentCount.toLocaleString('en-US')} posted payment${supplier.paymentCount === 1 ? '' : 's'} (void excluded)`,
      icon: Wallet
    },
    {
      label: supplier.balanceMinor < 0 ? 'Current Advance' : 'Current Due',
      value: supplierBalanceText(supplier.balanceMinor, currency),
      note: 'Opening balance, purchases, payments and adjustments',
      icon: Scale,
      className: supplierBalanceClassName(supplier.balanceMinor)
    },
    {
      label: 'Last Purchase',
      value:
        supplier.lastPurchaseDate === null ? '—' : formatDisplayDate(supplier.lastPurchaseDate),
      note: 'Latest posted receipt',
      icon: CalendarClock
    },
    {
      label: 'Last Payment',
      value: supplier.lastPaymentDate === null ? '—' : formatDisplayDate(supplier.lastPaymentDate),
      note: 'Latest posted payment',
      icon: HandCoins
    }
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {cards.map(({ label, value, note, icon: Icon, className }) => (
        <Card key={label} className="gap-0 py-0">
          <div className="flex flex-col gap-1 p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">{label}</p>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
                <Icon className="size-4" aria-hidden />
              </span>
            </div>
            <p
              className={cn(
                'text-lg font-semibold tabular-nums [overflow-wrap:anywhere]',
                className
              )}
            >
              {value}
            </p>
            <p className="text-xs text-muted-foreground">{note}</p>
          </div>
        </Card>
      ))}
    </div>
  )
}

function ProductsPurchased({
  supplier,
  currency
}: {
  supplier: Supplier
  currency: CurrencyFormat
}): React.JSX.Element {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <CardTitle>Products Purchased</CardTitle>
        <p className="text-xs text-muted-foreground">
          From this supplier’s posted receipts. History only: current stock is on the Products page.
        </p>
      </CardHeader>
      {supplier.productsPurchased.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No stock purchased from this supplier yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Product</TableHead>
              <TableHead>Last Purchase</TableHead>
              <TableHead className="text-right">Last Unit Cost</TableHead>
              <TableHead className="pr-4 text-right">Total Purchased</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {supplier.productsPurchased.map((row) => (
              <TableRow key={row.productId}>
                <TableCell className="pl-4 whitespace-normal">
                  <span className="font-mono text-xs">{row.code}</span> {row.name}
                </TableCell>
                <TableCell>{formatDisplayDate(row.lastPurchaseDate)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatAmount(row.lastUnitCostMinor, currency)}
                  <span className="text-xs text-muted-foreground"> / {row.lastUnitName}</span>
                </TableCell>
                <TableCell className="pr-4 text-right tabular-nums">
                  {row.totalQuantityText}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  )
}

function PurchasesTab({
  currency,
  purchases,
  purchasesError,
  onPurchasePage,
  onOpenReceipt
}: SupplierDetailViewProps): React.JSX.Element {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <CardTitle>Purchases</CardTitle>
        <p className="text-xs text-muted-foreground">
          Stock In receipts from this supplier, newest first. Open one for its products, quantities,
          costs and payments.
        </p>
      </CardHeader>
      {purchasesError ? (
        <p className="px-4 py-8 text-center text-sm text-destructive">{purchasesError}</p>
      ) : purchases === undefined ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : purchases.total === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No stock purchased from this supplier yet.
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Receipt No</TableHead>
                <TableHead>Supplier Bill No</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purchases.items.map((receipt) => (
                <TableRow key={receipt.id}>
                  <TableCell className="pl-4 font-mono text-xs">{receipt.receiptNo}</TableCell>
                  <TableCell>{receipt.supplierBillNo ?? '—'}</TableCell>
                  <TableCell>{formatDisplayDate(receipt.receiptDate)}</TableCell>
                  <TableCell className="max-w-48 whitespace-normal">
                    {receipt.reference ?? '—'}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      receipt.status === 'VOID' && 'text-muted-foreground line-through'
                    )}
                  >
                    {formatAmount(receipt.totalCostMinor, currency)}
                  </TableCell>
                  <TableCell>
                    <ReceiptStatusBadge receipt={receipt} />
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button variant="ghost" size="sm" onClick={() => onOpenReceipt(receipt.id)}>
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager
            page={purchases.page}
            pageSize={purchases.pageSize}
            shown={purchases.items.length}
            total={purchases.total}
            onPage={onPurchasePage}
          />
        </>
      )}
    </Card>
  )
}

function PaymentsTab({
  currency,
  payments,
  paymentsError,
  onPaymentPage,
  onOpenPayment,
  onOpenReceipt
}: SupplierDetailViewProps): React.JSX.Element {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <CardTitle>Payments</CardTitle>
        <p className="text-xs text-muted-foreground">
          Money paid to this supplier, newest first. A supplier payment is not an expense.
        </p>
      </CardHeader>
      {paymentsError ? (
        <p className="px-4 py-8 text-center text-sm text-destructive">{paymentsError}</p>
      ) : payments === undefined ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : payments.total === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No payments to this supplier yet.
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Payment No</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Linked Receipt</TableHead>
                <TableHead className="pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.items.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell className="pl-4 font-mono text-xs">{payment.paymentNo}</TableCell>
                  <TableCell>{formatDisplayDate(payment.paymentDate)}</TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      payment.status === 'VOID' && 'text-muted-foreground line-through'
                    )}
                  >
                    {formatAmount(payment.amountMinor, currency)}
                  </TableCell>
                  <TableCell>{PAYMENT_METHOD_LABELS[payment.method]}</TableCell>
                  <TableCell className="max-w-40 whitespace-normal">
                    {payment.reference ?? '—'}
                  </TableCell>
                  <TableCell>
                    <PaymentStatusBadge status={payment.status} />
                  </TableCell>
                  <TableCell>
                    {payment.receiptId === null ? (
                      '—'
                    ) : (
                      <Button
                        variant="link"
                        className="h-auto p-0 font-mono text-xs"
                        onClick={() => onOpenReceipt(payment.receiptId!)}
                      >
                        {payment.receiptNo}
                      </Button>
                    )}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button variant="ghost" size="sm" onClick={() => onOpenPayment(payment.id)}>
                      {payment.status === 'POSTED' ? 'View / Void' : 'View'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager
            page={payments.page}
            pageSize={payments.pageSize}
            shown={payments.items.length}
            total={payments.total}
            onPage={onPaymentPage}
          />
        </>
      )}
    </Card>
  )
}

function LedgerTab({
  currency,
  ledger,
  ledgerError,
  onLedgerPage,
  onOpenPayment,
  onOpenReceipt
}: SupplierDetailViewProps): React.JSX.Element {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <CardTitle>Supplier Ledger</CardTitle>
        <p className="text-xs text-muted-foreground">
          + the shop owes more (purchases), − the shop owes less (payments). Due: the shop owes the
          supplier. Advance: the supplier holds the shop’s money. Entries are never edited;
          corrections appear as new entries.
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
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Date</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="pr-4 text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger.rows.map((row) => {
                const reference = supplierLedgerReference(row)
                return (
                  <TableRow key={row.id}>
                    <TableCell className="pl-4 align-top">
                      {formatDisplayDate(row.entryDate)}
                    </TableCell>
                    <TableCell className="max-w-80 align-top whitespace-normal">
                      <div>
                        {supplierLedgerLabel(row)}
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
                      ) : row.receiptId !== null ? (
                        <Button
                          variant="link"
                          className="h-auto p-0 font-mono text-xs"
                          onClick={() => onOpenReceipt(row.receiptId!)}
                        >
                          {reference}
                        </Button>
                      ) : (
                        <span className="font-mono text-xs">{reference}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right align-top tabular-nums">
                      {supplierLedgerAmount(row.amountMinor, currency)}
                    </TableCell>
                    <TableCell
                      className={`pr-4 text-right align-top font-medium tabular-nums ${supplierBalanceClassName(row.runningBalanceMinor)}`}
                    >
                      {supplierBalanceText(row.runningBalanceMinor, currency)}
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
            onPage={onLedgerPage}
          />
        </>
      )}
    </Card>
  )
}
