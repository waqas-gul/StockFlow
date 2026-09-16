import { Eye, Pencil, Power, PowerOff } from 'lucide-react'
import { isWalkInCustomer, type CustomerListItem } from '@shared/customers'
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
import { balanceClassName, balanceText } from './customer-display'

export interface CustomersTableProps {
  readonly items: readonly CustomerListItem[]
  readonly currency: CurrencyFormat
  /** The customer whose status is being changed: its buttons are disabled. */
  readonly busyId: number | null
  readonly onView: (id: number) => void
  readonly onEdit: (id: number) => void
  readonly onToggleActive: (item: CustomerListItem) => void
}

/** The Customers table: one row per customer with the balance as Due, Advance or Settled. */
export function CustomersTable({
  items,
  currency,
  busyId,
  onView,
  onEdit,
  onToggleActive
}: CustomersTableProps): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Code</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Shop</TableHead>
          <TableHead>Phone</TableHead>
          <TableHead>City</TableHead>
          <TableHead className="text-right">Balance</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-4 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id} className={item.isActive ? undefined : 'text-muted-foreground'}>
            <TableCell className="pl-4 font-mono text-xs">{item.code}</TableCell>
            <TableCell className="max-w-56 font-medium whitespace-normal text-foreground">
              {item.name}
            </TableCell>
            <TableCell className="max-w-48 whitespace-normal">
              <Optional value={item.shopName} />
            </TableCell>
            <TableCell>
              <Optional value={item.phone} />
            </TableCell>
            <TableCell>
              <Optional value={item.city} />
            </TableCell>
            <TableCell
              className={`text-right font-medium tabular-nums ${balanceClassName(item.balanceMinor)}`}
            >
              {balanceText(item.balanceMinor, currency)}
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
                {/* The walk-in customer is always active; an old inactive one can still be reactivated. */}
                {!(isWalkInCustomer(item.code) && item.isActive) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyId === item.id}
                    onClick={() => onToggleActive(item)}
                  >
                    {item.isActive ? <PowerOff aria-hidden /> : <Power aria-hidden />}
                    {item.isActive ? 'Deactivate' : 'Reactivate'}
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

function Optional({ value }: { value: string | null }): React.JSX.Element {
  return value === null ? <span className="text-muted-foreground">—</span> : <>{value}</>
}
