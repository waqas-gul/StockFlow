import { Banknote, LoaderCircle, PackageSearch } from 'lucide-react'
import type { CustomerListItem } from '@shared/customers'
import { formatDisplayDate } from '@shared/dates'
import {
  ADDA_NAME_MAX,
  BILTY_NO_MAX,
  CHECKED_BY_MAX,
  INVOICE_CODE_MAX,
  INVOICE_NOTES_MAX,
  MAX_INVOICE_LINES,
  PRICE_TIERS,
  PRICE_TIER_LABELS,
  TRANSPORT_NAME_MAX,
  salesmanPhoneText,
  type InvoiceBusinessDetails,
  type InvoiceContext
} from '@shared/invoices'
import type { ProductSearchItem } from '@shared/products'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Textarea } from '@renderer/components/ui/textarea'
import { Table, TableHead, TableHeader, TableRow } from '@renderer/components/ui/table'
import { cn } from '@renderer/lib/utils'
import { balanceClassName, balanceText, customerLabel } from '../customers/customer-display'
import { CustomerPicker } from '../customers/CustomerPicker'
import { FormField } from '../customers/FormField'
import type { CurrencyFormat } from '../products/product-display'
import { ProductPicker } from '../stock/ProductPicker'
import type { DraftTextField, InvoiceDraft, InvoiceDraftAction } from './invoice-draft'
import type { InvoiceSummary } from './invoice-summary'
import { CellError, InvoiceLineRows } from './InvoiceLineRows'
import { InvoiceTotalsPanel } from './InvoiceTotalsPanel'

export interface InvoiceEditorProps {
  readonly draft: InvoiceDraft
  readonly summary: InvoiceSummary
  readonly currency: CurrencyFormat
  /** Today, the next invoice number and the posting-date floor, from the main process. */
  readonly context: InvoiceContext | undefined
  /** The shop and salesman in Settings: printed on the invoice and saved with it when it is posted. */
  readonly business: InvoiceBusinessDetails
  /** The chosen customer's current balance (read fresh). */
  readonly customerBalanceMinor: number
  /** The walk-in customer exists and is active. */
  readonly walkInAvailable: boolean
  /** Messages to show, by draft path. Stock warnings are shown from the summary at all times. */
  readonly errors: Readonly<Record<string, string>>
  readonly posting: boolean
  readonly dispatch: (action: InvoiceDraftAction) => void
  readonly onPickCustomer: (customer: CustomerListItem) => void
  readonly onCashSale: () => void
  readonly onAddProduct: (product: ProductSearchItem) => void
  readonly onPost: () => void
  readonly onClear: () => void
}

const OPTIONAL_FIELDS: ReadonlyArray<[DraftTextField, string, number, string]> = [
  ['invoiceCode', 'Invoice Code', INVOICE_CODE_MAX, 'Optional.'],
  ['biltyNo', 'Bilty No', BILTY_NO_MAX, 'Optional.'],
  ['transportName', 'Transport', TRANSPORT_NAME_MAX, 'Optional.'],
  ['addaName', 'Adda', ADDA_NAME_MAX, 'Optional.'],
  ['checkedBy', 'Checked By', CHECKED_BY_MAX, 'Optional.']
]

/** Sales → New Invoice: the header, the product lines and the totals of one invoice being entered. */
export function InvoiceEditor({
  draft,
  summary,
  currency,
  context,
  business,
  customerBalanceMinor,
  walkInAvailable,
  errors,
  posting,
  dispatch,
  onPickCustomer,
  onCashSale,
  onAddProduct,
  onPost,
  onClear
}: InvoiceEditorProps): React.JSX.Element {
  const { customer } = draft
  const floor = context?.earliestDateSetBy
  const dateHint =
    floor && context?.earliestDate
      ? `Earliest allowed: ${formatDisplayDate(context.earliestDate)} (${floor.code} ${floor.name} has later ${floor.kind === 'CUSTOMER' ? 'account' : 'stock'} activity).`
      : 'Today or earlier.'

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New Invoice</h1>
          <p className="text-sm text-muted-foreground">
            Stock, the customer&apos;s account and any money received are saved together when the
            invoice is posted.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Next invoice number{' '}
          <span className="font-mono font-medium text-foreground">
            {context?.nextInvoiceNo ?? '—'}
          </span>{' '}
          (assigned when the invoice is posted)
        </p>
      </div>

      <Card className="py-4">
        <CardContent className="grid gap-4 px-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid content-start gap-1.5 sm:col-span-2">
            <Label htmlFor="invoice-customer">Customer</Label>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <CustomerPicker
                  id="invoice-customer"
                  ariaLabel="Customer"
                  label={customer === null ? '' : customerLabel(customer)}
                  invalid={errors.customer !== undefined}
                  onPick={onPickCustomer}
                />
              </div>
              <Button
                type="button"
                variant={customer?.walkIn ? 'default' : 'outline'}
                disabled={!walkInAvailable}
                title={
                  walkInAvailable
                    ? 'Sell to C-00001 Cash / Walk-in, paid in full.'
                    : 'The walk-in customer C-00001 is inactive. Reactivate it on the Customers screen.'
                }
                onClick={onCashSale}
              >
                <Banknote aria-hidden />
                Cash Sale
              </Button>
            </div>
            {errors.customer ? (
              <p className="text-sm text-destructive">{errors.customer}</p>
            ) : customer === null ? (
              <p className="text-xs text-muted-foreground">
                Search by code, name, shop or phone, or choose Cash Sale.
              </p>
            ) : customer.walkIn ? (
              <p className="text-sm">
                <strong>Cash Sale:</strong> paid in full at the counter. Choose a customer account
                for credit.
              </p>
            ) : (
              <p className="text-sm">
                <span className="text-muted-foreground">Current balance</span>{' '}
                <span className={`font-medium ${balanceClassName(customerBalanceMinor)}`}>
                  {balanceText(customerBalanceMinor, currency)}
                </span>
              </p>
            )}
          </div>

          <FormField
            id="invoice-date"
            label="Invoice Date"
            error={errors.invoiceDate}
            hint={dateHint}
          >
            <Input
              id="invoice-date"
              type="date"
              min={context?.earliestDate ?? undefined}
              max={context?.today}
              aria-invalid={errors.invoiceDate ? true : undefined}
              value={draft.invoiceDate}
              onChange={(event) =>
                dispatch({ type: 'setField', field: 'invoiceDate', value: event.target.value })
              }
            />
          </FormField>

          <div className="grid content-start gap-1.5">
            <Label id="invoice-tier-label">Price Tier</Label>
            <div
              role="group"
              aria-labelledby="invoice-tier-label"
              className="inline-flex w-fit rounded-md border p-0.5"
            >
              {PRICE_TIERS.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  aria-pressed={draft.priceTier === tier}
                  className={cn(
                    'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                    draft.priceTier === tier
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => dispatch({ type: 'setPriceTier', tier })}
                >
                  {PRICE_TIER_LABELS[tier]}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Unit prices start from this tier.</p>
          </div>

          {OPTIONAL_FIELDS.map(([field, label, max, hint]) => (
            <FormField
              key={field}
              id={`invoice-${field}`}
              label={label}
              error={errors[field]}
              hint={hint}
            >
              <Input
                id={`invoice-${field}`}
                maxLength={max}
                autoComplete="off"
                aria-invalid={errors[field] ? true : undefined}
                value={draft[field]}
                onChange={(event) =>
                  dispatch({ type: 'setField', field, value: event.target.value })
                }
              />
            </FormField>
          ))}
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <CardTitle className="text-base">Products</CardTitle>
            {draft.lines.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {draft.lines.length} of {MAX_INVOICE_LINES} lines
              </p>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4 py-4">
          {draft.lines.length === 0 ? (
            <div className="flex flex-col items-center gap-1 rounded-md border border-dashed px-4 py-6 text-center">
              <PackageSearch className="size-6 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">No products on this invoice yet</p>
              <p className="text-sm text-muted-foreground">
                Search below and press Enter to put the first one on the bill.
              </p>
            </div>
          ) : (
            // One table for the whole invoice: every product is a row across it, so quantities and amounts read
            // down a column instead of being hunted for in a card each.
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">#</TableHead>
                  <TableHead className="min-w-60">Product</TableHead>
                  <TableHead className="w-32">Unit</TableHead>
                  <TableHead className="w-20">Qty</TableHead>
                  <TableHead className="w-28">Unit Price</TableHead>
                  <TableHead className="w-28 text-right">Amount</TableHead>
                  <TableHead className="w-8">
                    <span className="sr-only">Remove unit</span>
                  </TableHead>
                  <TableHead className="w-40">Discount</TableHead>
                  <TableHead className="w-24">Scheme</TableHead>
                  <TableHead className="w-20">Ctn</TableHead>
                  <TableHead className="w-28 text-right">Net</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">Remove product</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              {draft.lines.map((line, index) => (
                <InvoiceLineRows
                  key={line.key}
                  line={line}
                  index={index}
                  summary={summary.lines[index]}
                  priceTier={draft.priceTier}
                  currency={currency}
                  errors={errors}
                  stockWarning={summary.issues[`lines.${index}.stock`]}
                  dispatch={dispatch}
                />
              ))}
            </Table>
          )}
          <CellError message={errors.lines} />
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor="invoice-add-product">Add Product</Label>
            <ProductPicker
              id="invoice-add-product"
              label=""
              ariaLabel="Add Product"
              disabled={draft.lines.length >= MAX_INVOICE_LINES}
              onPick={onAddProduct}
            />
            <p className="text-xs text-muted-foreground">
              {draft.lines.length >= MAX_INVOICE_LINES
                ? `This invoice already has the most lines allowed (${MAX_INVOICE_LINES}).`
                : 'Click the box to see every product, or type a code, name or company and press Enter to take the top match. A product goes on one line; add its other units there.'}
            </p>
          </div>
        </CardContent>
      </Card>

      <InvoiceBusinessPanel business={business} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <Card className="gap-0 py-0">
          <CardHeader className="border-b px-4 py-3">
            <CardTitle className="text-base">Notes</CardTitle>
          </CardHeader>
          {/* flex-1 and h-full so the box grows to the height the totals beside it set, instead of leaving a gap. */}
          <CardContent className="flex flex-1 flex-col gap-1.5 px-4 py-4">
            <Textarea
              id="invoice-notes"
              aria-label="Notes"
              maxLength={INVOICE_NOTES_MAX}
              placeholder="Anything to remember about this bill. Optional."
              aria-invalid={errors.notes ? true : undefined}
              className="h-full min-h-40 flex-1 resize-none"
              value={draft.notes}
              onChange={(event) =>
                dispatch({ type: 'setField', field: 'notes', value: event.target.value })
              }
            />
            <CellError message={errors.notes} />
          </CardContent>
        </Card>
        <InvoiceTotalsPanel
          draft={draft}
          summary={summary}
          currency={currency}
          errors={errors}
          dispatch={dispatch}
        />
      </div>

      {errors.root && <p className="text-sm text-destructive">{errors.root}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={posting} onClick={onClear}>
          Clear
        </Button>
        <Button
          type="button"
          disabled={posting || summary.stockBlocked}
          title={summary.stockBlocked ? 'A line needs more stock than is available.' : undefined}
          onClick={onPost}
        >
          {posting && <LoaderCircle className="animate-spin" aria-hidden />}
          Post Invoice
        </Button>
      </div>
    </div>
  )
}

/**
 * The shop and salesman the invoice will be printed with, from Settings. Read-only here: posting saves them with the
 * invoice, so a later change in Settings never alters it.
 */
function InvoiceBusinessPanel({
  business
}: {
  business: InvoiceBusinessDetails
}): React.JSX.Element {
  const phones = salesmanPhoneText(business.salesmanPhone1, business.salesmanPhone2)
  return (
    <section
      aria-label="Printed on the invoice"
      // A strip across the page, its fields side by side: stacked in a narrow box they left the row half empty.
      className="rounded-xl border bg-card px-4 py-3 text-sm text-card-foreground shadow-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Printed on the invoice
        </h2>
        <p className="text-xs text-muted-foreground">
          From Settings. Saved with the invoice when it is posted.
        </p>
      </div>
      <dl className="mt-2 grid gap-x-8 gap-y-2 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Shop</dt>
          <dd className="font-semibold">{business.shopName}</dd>
          {business.shopAddress !== null && (
            <dd className="text-muted-foreground">{business.shopAddress}</dd>
          )}
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Salesman</dt>
          <dd className="font-medium">{business.salesmanName}</dd>
        </div>
        {phones !== null && (
          <div>
            <dt className="text-xs text-muted-foreground">Phone</dt>
            <dd className="tabular-nums">{phones}</dd>
          </div>
        )}
      </dl>
    </section>
  )
}
