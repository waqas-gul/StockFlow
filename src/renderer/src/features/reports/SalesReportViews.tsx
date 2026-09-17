import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { formatDisplayDate } from '@shared/dates'
import type {
  ProductSalesReport,
  ReportPeriod,
  SalesReport,
  SalesReportInput
} from '@shared/reports'
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
import { productSalesQuery, salesReportQuery } from '@renderer/lib/app-queries'
import { cn } from '@renderer/lib/utils'
import { InvoiceStatusBadge } from '../invoices/InvoiceHistoryPage'
import type { CurrencyFormat } from '../products/product-display'
import { Pager } from '../stock/Pager'
import { moneyText } from './report-display'
import { FigureCards, ReportCard, ReportMessage } from './ReportParts'

export const SALES_REPORT_PAGE_SIZE = 25

// --- Sales -----------------------------------------------------------------------------------------------------------------

/** Posted-invoice sales for the period, and its invoices. */
export function SalesSection({
  period,
  currency
}: {
  period: ReportPeriod
  currency: CurrencyFormat
}): React.JSX.Element {
  const [status, setStatus] = useState<SalesReportInput['status']>('POSTED')
  // The page keys this section by period, so a new period starts again on page 1.
  const [page, setPage] = useState(1)
  const { data, error } = useQuery(
    salesReportQuery({ ...period, page, pageSize: SALES_REPORT_PAGE_SIZE, status })
  )
  if (error) return <ReportMessage error>{error.message}</ReportMessage>
  if (!data) return <ReportMessage>Loading…</ReportMessage>
  return (
    <SalesReportView
      report={data}
      currency={currency}
      status={status}
      onStatus={(next) => {
        setStatus(next)
        setPage(1)
      }}
      onPage={setPage}
    />
  )
}

export function SalesReportView({
  report,
  currency,
  status,
  onStatus,
  onPage
}: {
  report: SalesReport
  currency: CurrencyFormat
  status: SalesReportInput['status']
  onStatus: (status: SalesReportInput['status']) => void
  onPage: (page: number) => void
}): React.JSX.Element {
  const money = (minor: number): string => moneyText(minor, currency)
  const { invoices } = report
  return (
    <div className="flex flex-col gap-4">
      <FigureCards
        figures={[
          {
            label: 'Net Goods Sales',
            value: money(report.netGoodsSalesMinor),
            note: `${report.invoiceCount.toLocaleString('en-US')} posted invoice${report.invoiceCount === 1 ? '' : 's'}`
          },
          { label: 'Total Billed', value: money(report.totalBilledMinor), note: 'Goods + freight' },
          { label: 'COGS', value: money(report.cogsMinor), note: 'Frozen at posting' },
          { label: 'Gross Profit', value: money(report.grossProfitMinor), strong: true }
        ]}
      />
      <ReportCard title="Sales Summary" description="Posted invoices only">
        <Table aria-label="Sales summary">
          <TableBody>
            {(
              [
                ['Gross sales', report.grossSalesMinor, ''],
                ['Discounts', report.discountMinor, '− '],
                ['Scheme discounts', report.schemeDiscountMinor, '− '],
                ['Net goods sales', report.netGoodsSalesMinor, '='],
                ['Freight charged', report.freightChargedMinor, '+ '],
                ['Total billed', report.totalBilledMinor, '='],
                ['COGS', report.cogsMinor, ''],
                ['Gross profit (net goods sales − COGS)', report.grossProfitMinor, '=']
              ] as const
            ).map(([label, minor, sign]) => (
              <TableRow key={label} className={cn(sign === '=' && 'font-semibold')}>
                <TableCell className="pl-4">{label}</TableCell>
                <TableCell className="pr-4 text-right tabular-nums">
                  {sign === '=' ? '' : sign}
                  {money(minor)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {report.voidInvoiceCount > 0 && (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            {report.voidInvoiceCount === 1
              ? `1 void invoice dated in this period (${money(report.voidTotalMinor)} billed) is not counted.`
              : `${report.voidInvoiceCount.toLocaleString('en-US')} void invoices dated in this period (${money(report.voidTotalMinor)} billed) are not counted.`}
          </p>
        )}
      </ReportCard>

      <ReportCard
        title="Invoices"
        actions={
          <Select
            value={status}
            onValueChange={(value) => {
              // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
              if (value !== '') onStatus(value as SalesReportInput['status'])
            }}
          >
            <SelectTrigger aria-label="Invoice status" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="POSTED">Posted</SelectItem>
              <SelectItem value="VOID">Void</SelectItem>
              <SelectItem value="all">All statuses</SelectItem>
            </SelectContent>
          </Select>
        }
      >
        {invoices.items.length === 0 ? (
          <ReportMessage>No invoices in this period.</ReportMessage>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Date</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Discounts</TableHead>
                  <TableHead className="text-right">Scheme</TableHead>
                  <TableHead className="text-right">Net Goods</TableHead>
                  <TableHead className="text-right">Freight</TableHead>
                  <TableHead className="text-right">COGS</TableHead>
                  <TableHead className="text-right">Gross Profit</TableHead>
                  <TableHead className="pr-4">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.items.map((invoice) => (
                  <TableRow
                    key={invoice.id}
                    className={cn(invoice.status === 'VOID' && 'text-muted-foreground')}
                  >
                    <TableCell className="pl-4">{formatDisplayDate(invoice.invoiceDate)}</TableCell>
                    <TableCell>
                      <Link to={`/invoices/${invoice.id}`} className="font-medium hover:underline">
                        {invoice.invoiceNo}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-48 whitespace-normal">
                      {invoice.customerName}
                      {invoice.customerShopName && (
                        <span className="block text-xs text-muted-foreground">
                          {invoice.customerShopName}
                        </span>
                      )}
                    </TableCell>
                    {[
                      invoice.grossMinor,
                      invoice.discountMinor,
                      invoice.schemeMinor,
                      invoice.netMinor,
                      invoice.freightMinor,
                      invoice.cogsMinor,
                      invoice.grossProfitMinor
                    ].map((minor, index) => (
                      <TableCell
                        key={index}
                        className={cn(
                          'text-right tabular-nums',
                          invoice.status === 'VOID' && 'line-through'
                        )}
                      >
                        {money(minor)}
                      </TableCell>
                    ))}
                    <TableCell className="pr-4">
                      <InvoiceStatusBadge status={invoice.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager
              page={invoices.page}
              pageSize={invoices.pageSize}
              shown={invoices.items.length}
              total={invoices.total}
              onPage={onPage}
            />
          </>
        )}
      </ReportCard>
    </div>
  )
}

// --- Products ---------------------------------------------------------------------------------------------------------------

/** Product performance for the period. */
export function ProductSalesSection({
  period,
  currency
}: {
  period: ReportPeriod
  currency: CurrencyFormat
}): React.JSX.Element {
  const { data, error } = useQuery(productSalesQuery(period))
  if (error) return <ReportMessage error>{error.message}</ReportMessage>
  if (!data) return <ReportMessage>Loading…</ReportMessage>
  return <ProductSalesReportView report={data} currency={currency} />
}

export function ProductSalesReportView({
  report,
  currency
}: {
  report: ProductSalesReport
  currency: CurrencyFormat
}): React.JSX.Element {
  const money = (minor: number): string => moneyText(minor, currency)
  return (
    <ReportCard
      title="Product Sales"
      description="Posted invoices only · quantity includes free scheme goods, which add COGS but no revenue · revenue is after line discounts and schemes"
    >
      {report.rows.length === 0 ? (
        <ReportMessage>No products sold in this period.</ReportMessage>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Code</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Quantity Sold</TableHead>
              <TableHead className="text-right">Free (Scheme)</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">COGS</TableHead>
              <TableHead className="pr-4 text-right">Gross Profit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.rows.map((row) => (
              <TableRow key={row.productId}>
                <TableCell className="pl-4">{row.code}</TableCell>
                <TableCell className="max-w-64 whitespace-normal">
                  {row.name}
                  {row.companyName && (
                    <span className="block text-xs text-muted-foreground">{row.companyName}</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.quantityText}
                  <span className="block text-xs text-muted-foreground">
                    {row.qtyBase.toLocaleString('en-US')} base units
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.schemeQtyBase === 0 ? '—' : row.schemeQtyBase.toLocaleString('en-US')}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(row.revenueMinor)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(row.cogsMinor)}</TableCell>
                <TableCell
                  className={cn(
                    'pr-4 text-right tabular-nums',
                    row.grossProfitMinor < 0 && 'text-destructive'
                  )}
                >
                  {money(row.grossProfitMinor)}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t-2 font-semibold">
              <TableCell className="pl-4" colSpan={4}>
                Total
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {money(report.revenueMinor)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{money(report.cogsMinor)}</TableCell>
              <TableCell className="pr-4 text-right tabular-nums">
                {money(report.grossProfitMinor)}
              </TableCell>
            </TableRow>
            {report.extraDiscountMinor !== 0 && (
              <>
                <TableRow>
                  <TableCell className="pl-4 whitespace-normal" colSpan={4}>
                    Invoice extra discounts (not allocated to products)
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    − {money(report.extraDiscountMinor)}
                  </TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
                <TableRow className="font-semibold">
                  <TableCell className="pl-4" colSpan={4}>
                    Net goods sales
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(report.netGoodsSalesMinor)}
                  </TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      )}
    </ReportCard>
  )
}
