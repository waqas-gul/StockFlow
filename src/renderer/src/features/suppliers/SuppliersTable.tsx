import { Eye, Pencil, Power, PowerOff } from 'lucide-react'
import type { SupplierListItem } from '@shared/suppliers'
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
import type { CurrencyFormat } from '../products/product-display'
import { supplierBalanceClassName, supplierBalanceText } from './supplier-display'

export interface SuppliersTableProps {
  readonly items: readonly SupplierListItem[]
  readonly currency: CurrencyFormat
  /** The supplier whose status is being changed: its buttons are disabled. */
  readonly busyId: number | null
  readonly onView: (id: number) => void
  readonly onEdit: (id: number) => void
  readonly onToggleActive: (item: SupplierListItem) => void
}

/** The Suppliers table: one row per supplier with the balance as Due, Advance or Settled. */
export function SuppliersTable({
  items,
  currency,
  busyId,
  onView,
  onEdit,
  onToggleActive
}: SuppliersTableProps): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Code</TableHead>
          <TableHead>Supplier</TableHead>
          <TableHead>Contact</TableHead>
          <TableHead>Phone</TableHead>
          <TableHead>City</TableHead>
          <TableHead className="text-right">Current Balance</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-4 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id} className={item.isActive ? undefined : 'text-muted-foreground'}>
            <TableCell className="pl-4 font-mono text-xs">{item.code}</TableCell>
            <TableCell className="max-w-56 font-medium whitespace-normal text-foreground">
              <button
                type="button"
                className="text-left underline-offset-4 hover:underline"
                onClick={() => onView(item.id)}
              >
                {item.name}
              </button>
            </TableCell>
            <TableCell className="max-w-48 whitespace-normal">
              <Optional value={item.contactPerson} />
            </TableCell>
            <TableCell>
              <Optional value={item.phone} />
            </TableCell>
            <TableCell>
              <Optional value={item.city} />
            </TableCell>
            <TableCell
              className={`text-right font-medium tabular-nums ${supplierBalanceClassName(item.balanceMinor)}`}
            >
              {supplierBalanceText(item.balanceMinor, currency)}
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
                <Button variant="ghost" size="sm" onClick={() => onView(item.id)}>
                  <Eye aria-hidden />
                  View
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
                  {item.isActive ? 'Deactivate' : 'Reactivate'}
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Optional({ value }: { value: string | null }): React.JSX.Element {
  return value === null ? <span className="text-muted-foreground">—</span> : <>{value}</>
}
