import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import type { BalanceState } from '@shared/customers'
import type { CustomerBalancesReport, StockLevel, StockReport } from '@shared/reports'
import { Badge } from '@renderer/components/ui/badge'
import { Input } from '@renderer/components/ui/input'
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
import { customerBalancesQuery, stockReportQuery } from '@renderer/lib/app-queries'
import { cn } from '@renderer/lib/utils'
import { balanceClassName, balanceText } from '../customers/customer-display'
import type { CurrencyFormat } from '../products/product-display'
import { moneyText, STOCK_LEVEL_LABELS } from './report-display'
import { FigureCards, ReportCard, ReportMessage } from './ReportParts'

/*
 * Current-state reports: stock (Σ stock movements) and customer balances (Σ customer ledger) as they are now. They take
 * no date range. Search and filters only narrow the table; the figure cards always cover everything.
 */

function matches(search: string, ...texts: Array<string | null>): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = texts.filter(Boolean).join(' ').toLowerCase()
  return words.every((word) => haystack.includes(word))
}

// --- Stock -------------------------------------------------------------------------------------------------------------

type StockFilter = 'all' | 'LOW' | 'OUT_OF_STOCK' | 'active'

export function StockSection({ currency }: { currency: CurrencyFormat }): React.JSX.Element {
  const { data, error } = useQuery(stockReportQuery)
  if (error) return <ReportMessage error>{error.message}</ReportMessage>
  if (!data) return <ReportMessage>Loading…</ReportMessage>
  return <StockReportView report={data} currency={currency} />
}

const LEVEL_BADGE: Readonly<Record<StockLevel, 'secondary' | 'warning' | 'success'>> = {
  OUT_OF_STOCK: 'secondary',
  LOW: 'warning',
  OK: 'success'
}

export function StockReportView({
  report,
  currency
}: {
  report: StockReport
  currency: CurrencyFormat
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<StockFilter>('all')
  const money = (minor: number): string => moneyText(minor, currency)
  const rows = report.rows.filter(
    (row) =>
      matches(search, row.code, row.name, row.companyName) &&
      (filter === 'all' || (filter === 'active' ? row.isActive : row.level === filter))
  )
  return (
    <div className="flex flex-col gap-4">
      <FigureCards
        columns={3}
        figures={[
          {
            label: 'Total Inventory Value',
            value: money(report.totalValueMinor),
            strong: true,
            note: `${report.rows.length.toLocaleString('en-US')} products · at average cost`
          },
          { label: 'Low Stock', value: report.lowStockCount.toLocaleString('en-US') },
          { label: 'Out of Stock', value: report.outOfStockCount.toLocaleString('en-US') }
        ]}
      />
      <ReportCard
        title="Current Stock"
        description="From the stock movement ledger, as of now"
        actions={
          <>
            <Input
              type="search"
              aria-label="Search stock"
              placeholder="Search code, product or company"
              className="w-64"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select
              value={filter}
              onValueChange={(value) => {
                if (value !== '') setFilter(value as StockFilter)
              }}
            >
              <SelectTrigger aria-label="Stock filter" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All products</SelectItem>
                <SelectItem value="active">Active only</SelectItem>
                <SelectItem value="LOW">Low stock</SelectItem>
                <SelectItem value="OUT_OF_STOCK">Out of stock</SelectItem>
              </SelectContent>
            </Select>
          </>
        }
      >
        {rows.length === 0 ? (
          <ReportMessage>
            {report.rows.length === 0
              ? 'No products yet.'
              : 'No products match the search or filter.'}
          </ReportMessage>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Code</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Company</TableHead>
                <TableHead className="text-right">Current Qty</TableHead>
                <TableHead>In Units</TableHead>
                <TableHead className="text-right">Inventory Value</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead className="pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.productId}
                  className={cn(!row.isActive && 'text-muted-foreground')}
                >
                  <TableCell className="pl-4">{row.code}</TableCell>
                  <TableCell className="max-w-64 whitespace-normal">{row.name}</TableCell>
                  <TableCell className="max-w-40 whitespace-normal">
                    {row.companyName ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.qtyBase.toLocaleString('en-US')}
                  </TableCell>
                  <TableCell className="whitespace-normal">{row.quantityText}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.valueMinor)}</TableCell>
                  <TableCell>
                    <Badge
                      variant={LEVEL_BADGE[row.level]}
                      title={
                        row.level === 'LOW'
                          ? `At or below the low-stock level of ${row.lowStockThresholdBase.toLocaleString('en-US')} base units.`
                          : undefined
                      }
                    >
                      {STOCK_LEVEL_LABELS[row.level]}
                    </Badge>
                  </TableCell>
                  <TableCell className="pr-4">{row.isActive ? 'Active' : 'Inactive'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ReportCard>
    </div>
  )
}

// --- Customer balances ----------------------------------------------------------------------------------------------------

type BalanceFilter = 'all' | BalanceState

export function CustomerBalancesSection({
  currency
}: {
  currency: CurrencyFormat
}): React.JSX.Element {
  const { data, error } = useQuery(customerBalancesQuery)
  if (error) return <ReportMessage error>{error.message}</ReportMessage>
  if (!data) return <ReportMessage>Loading…</ReportMessage>
  return <CustomerBalancesReportView report={data} currency={currency} />
}

export function CustomerBalancesReportView({
  report,
  currency
}: {
  report: CustomerBalancesReport
  currency: CurrencyFormat
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<BalanceFilter>('all')
  const money = (minor: number): string => moneyText(minor, currency)
  const rows = report.rows.filter(
    (row) =>
      matches(search, row.code, row.name, row.shopName, row.city) &&
      (filter === 'all' || row.state === filter)
  )
  return (
    <div className="flex flex-col gap-4">
      <FigureCards
        columns={3}
        figures={[
          {
            label: 'Total Receivables',
            value: money(report.receivablesMinor),
            strong: true,
            note: `${report.dueCount.toLocaleString('en-US')} customers owe the shop`
          },
          {
            label: 'Total Customer Advances',
            value: money(report.advancesMinor),
            strong: true,
            note: `${report.advanceCount.toLocaleString('en-US')} customers hold an advance`
          },
          {
            label: 'Net Receivable',
            value: money(report.netMinor),
            note: `Receivables − advances · ${report.settledCount.toLocaleString('en-US')} settled`
          }
        ]}
      />
      <ReportCard
        title="Customer Balances"
        description="From the customer ledger, as of now"
        actions={
          <>
            <Input
              type="search"
              aria-label="Search customers"
              placeholder="Search code, name, shop or city"
              className="w-64"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select
              value={filter}
              onValueChange={(value) => {
                if (value !== '') setFilter(value as BalanceFilter)
              }}
            >
              <SelectTrigger aria-label="Balance filter" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All balances</SelectItem>
                <SelectItem value="DUE">Due</SelectItem>
                <SelectItem value="ADVANCE">Advance</SelectItem>
                <SelectItem value="SETTLED">Settled</SelectItem>
              </SelectContent>
            </Select>
          </>
        }
      >
        {rows.length === 0 ? (
          <ReportMessage>No customers match the search or filter.</ReportMessage>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Code</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Shop</TableHead>
                <TableHead className="pr-4 text-right">Current Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.customerId}
                  className={cn(!row.isActive && 'text-muted-foreground')}
                >
                  <TableCell className="pl-4">{row.code}</TableCell>
                  <TableCell className="max-w-64 whitespace-normal">
                    <Link
                      to={`/customers/${row.customerId}`}
                      className="font-medium hover:underline"
                    >
                      {row.name}
                    </Link>
                    {!row.isActive && <span className="text-xs"> (inactive)</span>}
                  </TableCell>
                  <TableCell className="max-w-56 whitespace-normal">
                    {row.shopName ?? '—'}
                    {row.city && (
                      <span className="block text-xs text-muted-foreground">{row.city}</span>
                    )}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'pr-4 text-right tabular-nums',
                      balanceClassName(row.balanceMinor)
                    )}
                  >
                    {balanceText(row.balanceMinor, currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ReportCard>
    </div>
  )
}
