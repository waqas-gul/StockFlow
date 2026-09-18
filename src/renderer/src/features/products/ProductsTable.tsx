import { ClipboardList, Pencil, Power, PowerOff } from 'lucide-react'
import type { ProductListItem } from '@shared/products'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import { isLowStock } from '../stock/stock-display'
import { priceSummary, stockText, type CurrencyFormat } from './product-display'

export interface ProductsTableProps {
  readonly items: readonly ProductListItem[]
  readonly currency: CurrencyFormat
  /** The product whose status is being changed: its buttons are disabled. */
  readonly busyId: number | null
  readonly onEdit: (id: number) => void
  readonly onToggleActive: (item: ProductListItem) => void
  /** Opens the product's stock card. */
  readonly onStockCard: (id: number) => void
}

/** The Products table: one row per product, with a compact price per tier. */
export function ProductsTable({
  items,
  currency,
  busyId,
  onEdit,
  onToggleActive,
  onStockCard
}: ProductsTableProps): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Code</TableHead>
          <TableHead>Product</TableHead>
          <TableHead>Brand / Company</TableHead>
          <TableHead>Packing</TableHead>
          <TableHead>Stock</TableHead>
          <TableHead>Wholesale</TableHead>
          <TableHead>Retail</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-4 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id} className={item.isActive ? undefined : 'text-muted-foreground'}>
            <TableCell className="pl-4 font-mono text-xs">{item.code}</TableCell>
            <TableCell className="max-w-64 whitespace-normal">
              <div className="font-medium text-foreground">{item.name}</div>
              <div className="text-xs text-muted-foreground">
                {item.units.map((unit) => unit.name).join(' · ')}
              </div>
            </TableCell>
            <TableCell>
              {item.companyName === null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <>
                  {item.companyName}
                  {item.companyActive === false && (
                    <span className="ml-1 text-xs text-muted-foreground">(inactive)</span>
                  )}
                </>
              )}
            </TableCell>
            <TableCell>
              {item.packingLabel ?? <span className="text-muted-foreground">—</span>}
            </TableCell>
            <TableCell>
              <span className="tabular-nums">{stockText(item)}</span>
              {isLowStock(item) && (
                <Badge
                  variant="warning"
                  className="ml-1.5"
                  title={`At or below the low-stock level of ${item.lowStockThresholdBase.toLocaleString('en-US')} base units.`}
                >
                  Low
                </Badge>
              )}
            </TableCell>
            <TableCell>
              <PriceCell item={item} tier="wholesale" currency={currency} />
            </TableCell>
            <TableCell>
              <PriceCell item={item} tier="retail" currency={currency} />
            </TableCell>
            <TableCell>
              {item.isActive ? (
                <Badge variant="success">Active</Badge>
              ) : (
                <Badge variant="secondary">Inactive</Badge>
              )}
            </TableCell>
            <TableCell className="pr-4 text-right">
              <div className="flex justify-end gap-1">
                <Button variant="ghost" size="sm" onClick={() => onStockCard(item.id)}>
                  <ClipboardList aria-hidden />
                  Stock Card
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId === item.id}
                  onClick={() => onEdit(item.id)}
                >
                  <Pencil aria-hidden />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId === item.id}
                  onClick={() => onToggleActive(item)}
                >
                  {item.isActive ? <PowerOff aria-hidden /> : <Power aria-hidden />}
                  {item.isActive ? 'Deactivate' : 'Activate'}
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function PriceCell({
  item,
  tier,
  currency
}: {
  item: ProductListItem
  tier: 'wholesale' | 'retail'
  currency: CurrencyFormat
}): React.JSX.Element {
  const summary = priceSummary(item.units, tier, currency)
  if (summary === null) return <span className="text-muted-foreground">—</span>
  return (
    <div title={summary.title}>
      <span className="tabular-nums">{summary.text}</span>
      <span className="text-xs text-muted-foreground"> / {summary.unit}</span>
      {summary.others > 0 && (
        <div className="text-xs text-muted-foreground">
          +{summary.others} more unit{summary.others === 1 ? '' : 's'}
        </div>
      )}
    </div>
  )
}
