import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { formatDisplayDate } from '@shared/dates'
import { EXPENSE_GROUP_LABELS } from '@shared/expenses'
import { FROZEN_COGS_NOTE, type ProfitLossReport, type ReportPeriod } from '@shared/reports'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import { profitLossQuery } from '@renderer/lib/app-queries'
import { cn } from '@renderer/lib/utils'
import type { CurrencyFormat } from '../products/product-display'
import { moneyText, profitLossRows, reasonLabel } from './report-display'
import { FigureCards, ReportCard, ReportMessage } from './ReportParts'

/** Profit & Loss for the chosen period. */
export function ProfitLossSection({
  period,
  currency
}: {
  period: ReportPeriod
  currency: CurrencyFormat
}): React.JSX.Element {
  const { data, error } = useQuery(profitLossQuery(period))
  if (error) return <ReportMessage error>{error.message}</ReportMessage>
  if (!data) return <ReportMessage>Loading…</ReportMessage>
  return <ProfitLossReportView report={data} currency={currency} />
}

export function ProfitLossReportView({
  report,
  currency
}: {
  report: ProfitLossReport
  currency: CurrencyFormat
}): React.JSX.Element {
  const money = (minor: number): string => moneyText(minor, currency)
  const hasInventoryCorrections = report.inventoryCorrections.some((total) => total.count > 0)
  const hasCorrections = hasInventoryCorrections || report.purchaseCostCorrectionsMinor !== 0
  return (
    <div className="flex flex-col gap-4">
      <FigureCards
        figures={[
          { label: 'Goods Revenue', value: money(report.goodsRevenueMinor) },
          { label: 'Gross Profit', value: money(report.grossProfitMinor) },
          {
            label: 'Operating Expenses',
            value: money(report.operatingExpensesMinor),
            note:
              report.stockLossesMinor > 0
                ? `Plus stock losses ${money(report.stockLossesMinor)}`
                : undefined
          },
          {
            label: 'Net Operating Profit',
            value: money(report.netOperatingProfitMinor),
            strong: true,
            tone: report.netOperatingProfitMinor < 0 ? 'negative' : undefined,
            note: hasCorrections
              ? `After data corrections: ${money(report.profitAfterDataCorrectionsMinor)}`
              : undefined
          }
        ]}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ReportCard
          title="Profit & Loss"
          description={`${report.postedInvoiceCount.toLocaleString('en-US')} posted invoice${
            report.postedInvoiceCount === 1 ? '' : 's'
          } · void invoices and void expenses are not counted · payments are not revenue`}
        >
          <Table aria-label="Profit and loss statement">
            <TableBody>
              {profitLossRows(report).map((row) => {
                if (row.kind === 'section') {
                  return (
                    <TableRow key={row.key} className="hover:bg-transparent">
                      <TableCell
                        colSpan={2}
                        className="pt-4 pl-4 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                      >
                        {row.label}
                      </TableCell>
                    </TableRow>
                  )
                }
                const isTotal = row.kind === 'subtotal' || row.kind === 'result'
                return (
                  <TableRow
                    key={row.key}
                    className={cn(
                      isTotal && 'border-t-2 font-semibold',
                      row.kind === 'result' && 'bg-muted/40'
                    )}
                  >
                    <TableCell className={cn('whitespace-normal', isTotal ? 'pl-4' : 'pl-8')}>
                      {row.label}
                      {row.hint && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          {row.hint}
                        </span>
                      )}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'pr-4 text-right tabular-nums',
                        isTotal && row.minor !== null && row.minor < 0 && 'text-destructive'
                      )}
                    >
                      {row.effect === 'deduct' && row.minor !== 0 ? '− ' : ''}
                      {row.minor === null ? '' : money(row.minor)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </ReportCard>

        <ReportCard title="Expenses by Category" description="Active expenses in the period">
          {report.expenseCategories.length === 0 ? (
            <ReportMessage>No active expenses in this period.</ReportMessage>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Category</TableHead>
                  <TableHead>Group</TableHead>
                  <TableHead className="pr-4 text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.expenseCategories.map((category) => (
                  <TableRow key={category.categoryId}>
                    <TableCell className="pl-4 whitespace-normal">
                      {category.name}
                      {!category.isActive && (
                        <span className="text-xs text-muted-foreground"> (inactive)</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {category.isPurchaseCostCorrection
                        ? 'Data correction (below operating profit)'
                        : EXPENSE_GROUP_LABELS[category.group]}
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">
                      {money(category.amountMinor)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ReportCard>
      </div>

      {hasInventoryCorrections && (
        <ReportCard
          title="Inventory Data Corrections"
          description="Receipt quantity and cost corrections and other corrections: shown below Net Operating Profit, never inside it."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Date</TableHead>
                <TableHead>Adjustment</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="pr-4 text-right">Value Effect</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.inventoryCorrectionDetails.map((detail) => (
                <TableRow key={detail.adjustmentId}>
                  <TableCell className="pl-4">{formatDisplayDate(detail.adjustmentDate)}</TableCell>
                  <TableCell>{detail.adjustmentNo}</TableCell>
                  <TableCell>{reasonLabel(detail.reason)}</TableCell>
                  <TableCell className="whitespace-normal">
                    {detail.productCode} · {detail.productName}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {detail.quantityText ?? 'Value only'}
                  </TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">
                    {detail.valueMinor > 0 ? '+' : ''}
                    {money(detail.valueMinor)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="border-t-2">
                <TableCell colSpan={5} className="pl-4 font-semibold">
                  Net value effect
                </TableCell>
                <TableCell className="pr-4 text-right font-semibold tabular-nums">
                  {report.inventoryCorrectionsNetMinor > 0 ? '+' : ''}
                  {money(report.inventoryCorrectionsNetMinor)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </ReportCard>
      )}

      {(report.showFrozenCogsNote || report.openingStockValueMinor !== 0) && (
        <div className="flex flex-col gap-1.5 rounded-md border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {report.showFrozenCogsNote && (
            <p className="flex gap-2">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              {FROZEN_COGS_NOTE}
            </p>
          )}
          {report.openingStockValueMinor !== 0 && (
            <p className="flex gap-2">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              Opening stock of {money(report.openingStockValueMinor)} was entered in this period. It
              is inventory, not profit.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
