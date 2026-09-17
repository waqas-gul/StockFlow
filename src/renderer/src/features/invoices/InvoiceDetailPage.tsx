import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Ban, Info, Pencil, Printer } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { formatDisplayDate } from '@shared/dates'
import { PAYMENT_METHOD_LABELS } from '@shared/payments'
import { invoicePrintPath } from '@shared/invoice-print'
import { PRICE_TIER_LABELS, type InvoiceDetail } from '@shared/invoices'
import { NotFoundPage } from '@renderer/app/NotFoundPage'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
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
import { invoiceQuery, refreshAfterInvoice, settingsQuery } from '@renderer/lib/app-queries'
import { formatDateTime } from '@renderer/lib/format'
import { queryKeys } from '@renderer/lib/query-keys'
import { balanceClassName, balanceText } from '../customers/customer-display'
import { PaymentDetailDialog } from '../payments/PaymentDetailDialog'
import { PaymentStatusBadge } from '../payments/PaymentStatusBadge'
import { formatAmount, type CurrencyFormat } from '../products/product-display'
import { DispatchDialog } from './DispatchDialog'
import {
  dispatchFieldLabel,
  lineDiscountText,
  quantityRowText,
  savedQuantityText,
  submitDispatchUpdate,
  submitInvoiceVoid,
  type InvoiceNotifier
} from './invoice-history'
import { InvoiceStatusBadge } from './InvoiceHistoryPage'
import { VoidInvoiceDialog } from './VoidInvoiceDialog'

const notify: InvoiceNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message)
}

/** Sales → Invoice History → an invoice, exactly as saved. */
export function InvoiceDetailPage(): React.JSX.Element {
  const params = useParams()
  const id = Number(params.invoiceId)
  if (!Number.isSafeInteger(id) || id <= 0) return <NotFoundPage />
  return <InvoiceDetailScreen key={id} invoiceId={id} />
}

function InvoiceDetailScreen({ invoiceId }: { invoiceId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const settings = useQuery(settingsQuery)
  const invoice = useQuery(invoiceQuery(invoiceId))
  const [dialog, setDialog] = useState<'dispatch' | 'void' | null>(null)
  const [paymentId, setPaymentId] = useState<number | null>(null)

  const currency: CurrencyFormat | null = settings.data
    ? {
        minorDigits: settings.data.values['currency.minorDigits'],
        symbol: settings.data.values['currency.symbol']
      }
    : null

  if (invoice.error) {
    return (
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <BackLink />
        <p className="text-sm text-destructive">{invoice.error.message}</p>
      </div>
    )
  }
  if (!invoice.data || currency === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  const current = invoice.data
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 pb-6">
      <BackLink />
      <InvoiceDetailView
        invoice={current}
        currency={currency}
        onEditDispatch={() => setDialog('dispatch')}
        onVoid={() => setDialog('void')}
        onOpenPayment={setPaymentId}
      />

      <DispatchDialog
        open={dialog === 'dispatch'}
        invoice={current}
        onSave={(input) => submitDispatchUpdate(window.api.invoices, input, notify)}
        onSaved={() => {
          setDialog(null)
          void queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all })
        }}
        onClose={() => setDialog(null)}
      />
      <VoidInvoiceDialog
        open={dialog === 'void'}
        invoice={current}
        currency={currency}
        onConfirm={async (input) => {
          const outcome = await submitInvoiceVoid(window.api.invoices, input, notify, currency)
          // Read everything again either way: a refusal may mean the invoice or its payment changed meanwhile.
          refreshAfterInvoice(queryClient)
          return outcome
        }}
        onVoided={() => setDialog(null)}
        onClose={() => setDialog(null)}
      />
      <PaymentDetailDialog
        paymentId={paymentId}
        currency={currency}
        onClose={() => setPaymentId(null)}
        onVoided={() => refreshAfterInvoice(queryClient)}
      />
    </div>
  )
}

function BackLink(): React.JSX.Element {
  return (
    <Button variant="ghost" size="sm" className="self-start" asChild>
      <Link to="/invoices">
        <ArrowLeft aria-hidden />
        Invoice History
      </Link>
    </Button>
  )
}

export interface InvoiceDetailViewProps {
  readonly invoice: InvoiceDetail
  readonly currency: CurrencyFormat
  readonly onEditDispatch: () => void
  readonly onVoid: () => void
  readonly onOpenPayment: (paymentId: number) => void
}

export function InvoiceDetailView({
  invoice,
  currency,
  onEditDispatch,
  onVoid,
  onOpenPayment
}: InvoiceDetailViewProps): React.JSX.Element {
  const posted = invoice.status === 'POSTED'
  const money = (minor: number): string => formatAmount(minor, currency)
  return (
    <>
      <Card className="gap-4 py-5">
        <CardContent className="flex flex-wrap items-start justify-between gap-6 px-5">
          <div className="flex min-w-72 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-2xl font-semibold tracking-tight">
                {invoice.invoiceNo}
              </h1>
              <InvoiceStatusBadge status={invoice.status} />
            </div>
            <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
              <Field label="Date" value={formatDisplayDate(invoice.invoiceDate)} />
              <Field label="Price tier" value={PRICE_TIER_LABELS[invoice.priceTier]} />
              <Field label="Invoice Code" value={invoice.invoiceCode} />
              <Field label="Checked By" value={invoice.checkedBy} />
              <Field label="Recorded" value={formatDateTime(invoice.createdAt)} />
              <Field label="Notes" value={invoice.notes} />
            </dl>
          </div>
          <div className="flex min-w-56 flex-col items-end gap-1 text-right">
            <span className="text-sm text-muted-foreground">Invoice total</span>
            <span
              className={`text-2xl font-semibold tabular-nums ${posted ? '' : 'text-muted-foreground line-through'}`}
            >
              {money(invoice.totalMinor)}
            </span>
            <Button variant="outline" size="sm" className="mt-2" asChild>
              <Link to={invoicePrintPath(invoice.id)}>
                <Printer aria-hidden />
                Print Invoice
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      {!posted && (
        <Alert>
          <Info aria-hidden />
          <AlertDescription>
            Voided on {invoice.voidDate === null ? '—' : formatDisplayDate(invoice.voidDate)}:{' '}
            {invoice.voidReason}. Its goods went back into stock at their original cost and its
            account entry was reversed on that date.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-3 py-4">
          <CardHeader className="px-5">
            <CardTitle>Customer</CardTitle>
            <p className="text-xs text-muted-foreground">As saved on the invoice.</p>
          </CardHeader>
          <CardContent className="px-5">
            <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="mt-0.5">
                  <Link
                    to={`/customers/${invoice.customerId}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {invoice.customerName}
                  </Link>{' '}
                  <span className="font-mono text-xs text-muted-foreground">
                    {invoice.customerCode}
                  </span>
                </dd>
              </div>
              <Field label="Shop" value={invoice.customerShopName} />
              <Field label="Phone" value={invoice.customerPhone} />
              <Field label="City" value={invoice.customerCity} />
              <Field label="Address" value={invoice.customerAddress} />
            </dl>
          </CardContent>
        </Card>

        <Card className="gap-3 py-4">
          <CardHeader className="flex flex-row items-start justify-between gap-2 px-5">
            <div>
              <CardTitle>Dispatch</CardTitle>
              <p className="text-xs text-muted-foreground">
                {invoice.dispatchUpdatedAt === null
                  ? 'As saved on the invoice.'
                  : `Last changed ${formatDateTime(invoice.dispatchUpdatedAt)}.`}
              </p>
            </div>
            {posted && (
              <Button variant="outline" size="sm" onClick={onEditDispatch}>
                <Pencil aria-hidden />
                Edit Dispatch
              </Button>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-5">
            <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
              <Field label="Bilty No" value={invoice.biltyNo} />
              <Field label="Transport" value={invoice.transportName} />
              <Field label="Adda" value={invoice.addaName} />
            </dl>
            {invoice.changes.length > 0 && (
              <div className="rounded-md border">
                <p className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
                  Change log
                </p>
                <ul className="divide-y text-xs">
                  {invoice.changes.map((change) => (
                    <li key={change.id} className="px-3 py-1.5">
                      <span className="text-muted-foreground">
                        {formatDateTime(change.changedAt)}
                      </span>{' '}
                      <span className="font-medium">{dispatchFieldLabel(change.field)}</span>:{' '}
                      {change.oldValue ?? '(blank)'} → {change.newValue ?? '(blank)'}
                      {change.note !== null && (
                        <span className="text-muted-foreground"> · {change.note}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b px-4 py-3">
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <InvoiceItemsTable invoice={invoice} currency={currency} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-3 py-4">
          <CardHeader className="px-5">
            <CardTitle>Payment received with the invoice</CardTitle>
          </CardHeader>
          <CardContent className="px-5 text-sm">
            {invoice.payment === null ? (
              <p className="text-muted-foreground">No payment was received with this invoice.</p>
            ) : (
              <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Payment No</dt>
                  <dd className="mt-0.5">
                    <Button
                      variant="link"
                      className="h-auto p-0 font-mono"
                      onClick={() => onOpenPayment(invoice.payment!.id)}
                    >
                      {invoice.payment.paymentNo}
                    </Button>
                  </dd>
                </div>
                <Field label="Amount" value={money(invoice.payment.amountMinor)} />
                <Field label="Method" value={PAYMENT_METHOD_LABELS[invoice.payment.method]} />
                <div>
                  <dt className="text-muted-foreground">Status</dt>
                  <dd className="mt-0.5">
                    <PaymentStatusBadge status={invoice.payment.status} />
                  </dd>
                </div>
                {invoice.payment.status === 'VOID' && (
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    The payment has been voided, so it no longer reduces the customer&apos;s
                    balance. Received below is the amount saved on the invoice.
                  </p>
                )}
              </dl>
            )}
          </CardContent>
        </Card>

        <Card className="gap-3 py-4">
          <CardHeader className="px-5">
            <CardTitle>Totals</CardTitle>
          </CardHeader>
          <CardContent className="px-5">
            <dl className="grid gap-1 text-sm">
              <Total label="Gross" value={money(invoice.grossMinor)} />
              <Total label="Line Discounts" value={money(invoice.lineDiscountMinor)} />
              <Total label="Scheme Discounts" value={money(invoice.lineSchemeMinor)} />
              <Total label="Extra Discount" value={money(invoice.extraDiscountMinor)} />
              <Total label="Net Invoice" value={money(invoice.netMinor)} strong />
              <Total label="Freight" value={money(invoice.freightMinor)} />
              <Total label="Total" value={money(invoice.totalMinor)} strong />
              <Total
                label="Previous Balance"
                value={balanceText(invoice.previousBalanceMinor, currency)}
              />
              <Total label="Received" value={money(invoice.receivedMinor)} />
              <Total
                label="Net Outstanding"
                value={balanceText(invoice.netOutstandingMinor, currency)}
                className={balanceClassName(invoice.netOutstandingMinor)}
                strong
              />
            </dl>
            <details className="mt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Internal</summary>
              <p className="mt-1">
                Cost of goods sold, frozen when the invoice was saved: {money(invoice.cogsMinor)}
              </p>
            </details>
          </CardContent>
        </Card>
      </div>

      {posted && (
        <Card className="gap-2 border-dashed py-4">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 px-5">
            <p className="max-w-3xl text-sm text-muted-foreground">
              A posted invoice is never edited. If it is wrong, void it: its goods go back into
              stock at their original cost and its account entry is reversed, dated today. The
              invoice stays in the history as void.
            </p>
            <Button
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/5 hover:text-destructive"
              onClick={onVoid}
            >
              <Ban aria-hidden />
              Void Invoice…
            </Button>
          </CardContent>
        </Card>
      )}
    </>
  )
}

function InvoiceItemsTable({
  invoice,
  currency
}: {
  invoice: InvoiceDetail
  currency: CurrencyFormat
}): React.JSX.Element {
  const money = (minor: number): string => formatAmount(minor, currency)
  const hasCtn = invoice.lines.some((line) => line.ctnCount !== null)
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">#</TableHead>
          <TableHead>Product</TableHead>
          <TableHead>Packing</TableHead>
          <TableHead>Quantity and price</TableHead>
          <TableHead>Free scheme</TableHead>
          <TableHead className="text-right">Gross</TableHead>
          <TableHead className="text-right">Discount</TableHead>
          <TableHead className="text-right">Scheme</TableHead>
          <TableHead className="text-right">Net</TableHead>
          {hasCtn && <TableHead className="pr-4 text-right">Ctn</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoice.lines.map((line) => (
          <TableRow key={line.id}>
            <TableCell className="pl-4 align-top text-muted-foreground">{line.lineNo}</TableCell>
            <TableCell className="max-w-64 align-top whitespace-normal">
              <div className="font-medium">
                <span className="font-mono text-xs">{line.productCode}</span> {line.productName}
              </div>
              {line.companyName !== null && (
                <div className="text-xs text-muted-foreground">{line.companyName}</div>
              )}
            </TableCell>
            <TableCell className="align-top">{line.packingLabel ?? '—'}</TableCell>
            <TableCell className="align-top whitespace-normal">
              {line.quantities.map((row) => (
                <div key={row.id} className="tabular-nums">
                  {quantityRowText(row, currency)}
                </div>
              ))}
            </TableCell>
            <TableCell className="align-top">
              {line.schemeQtyBase === 0
                ? '—'
                : savedQuantityText(line.schemeQtyBase, line.quantities)}
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">
              {money(line.grossMinor)}
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">
              {lineDiscountText(line, currency)}
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">
              {line.schemeMinor === 0 ? '—' : money(line.schemeMinor)}
            </TableCell>
            <TableCell className="text-right align-top font-medium tabular-nums">
              {money(line.netMinor)}
            </TableCell>
            {hasCtn && (
              <TableCell className="pr-4 text-right align-top tabular-nums">
                {line.ctnCount ?? '—'}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Field({ label, value }: { label: string; value: string | null }): React.JSX.Element {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 whitespace-normal">{value ?? '—'}</dd>
    </div>
  )
}

function Total({
  label,
  value,
  strong,
  className
}: {
  label: string
  value: string
  strong?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'font-semibold' : ''}`}>
      <dt className={strong ? '' : 'text-muted-foreground'}>{label}</dt>
      <dd className={`tabular-nums ${className ?? ''}`}>{value}</dd>
    </div>
  )
}
