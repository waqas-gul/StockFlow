import { TriangleAlert } from 'lucide-react'
import { SUPPLIER_BALANCE_DEACTIVATE_WARNING } from '@shared/suppliers'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import type { CurrencyFormat } from '../products/product-display'
import { supplierBalanceText, supplierDeactivateText } from './supplier-display'

/** Confirms deactivating a supplier: what changes, what stays, and a warning when a balance is still open. */
export function SupplierDeactivateDialog<
  T extends { readonly code: string; readonly name: string; readonly balanceMinor: number }
>({
  supplier,
  currency,
  onCancel,
  onConfirm
}: {
  supplier: T | null
  currency: CurrencyFormat
  onCancel: () => void
  onConfirm: (supplier: T) => void
}): React.JSX.Element {
  return (
    <AlertDialog open={supplier !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Deactivate {supplier?.code} {supplier?.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {supplier
              ? supplierDeactivateText(supplierBalanceText(supplier.balanceMinor, currency))
              : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {supplier !== null && supplier.balanceMinor !== 0 && (
          <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{SUPPLIER_BALANCE_DEACTIVATE_WARNING}</span>
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => supplier && onConfirm(supplier)}>Deactivate</Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
