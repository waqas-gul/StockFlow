import { useQuery } from '@tanstack/react-query'
import type { Product } from '@shared/products'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { productQuery } from '@renderer/lib/app-queries'
import type { CurrencyFormat } from './product-display'
import { ProductForm } from './ProductForm'

export type ProductEditorTarget =
  { readonly mode: 'create' } | { readonly mode: 'edit'; readonly id: number }

/** Add or edit a product. The product being edited is read fresh, so its unit lock state is the database's. */
export function ProductFormDialog({
  target,
  currency,
  onSaved,
  onClose
}: {
  target: ProductEditorTarget | null
  currency: CurrencyFormat
  onSaved: (product: Product) => void
  onClose: () => void
}): React.JSX.Element {
  const editId = target?.mode === 'edit' ? target.id : null
  const product = useQuery({ ...productQuery(editId ?? 0), enabled: editId !== null })

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-[min(72rem,calc(100%-2rem))]"
        // Typing a product takes a while: a stray click outside must not discard it.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{editId === null ? 'Add Product' : 'Edit Product'}</DialogTitle>
          <DialogDescription>
            {editId === null
              ? 'Enter the product and the units it is counted, bought and sold in.'
              : 'Change the product, its units and prices.'}
          </DialogDescription>
        </DialogHeader>
        {target === null ? null : editId === null ? (
          <ProductForm product={null} currency={currency} onSaved={onSaved} onCancel={onClose} />
        ) : product.data ? (
          <ProductForm
            key={`${product.data.id}-${product.data.updatedAt}`}
            product={product.data}
            currency={currency}
            onSaved={onSaved}
            onCancel={onClose}
          />
        ) : (
          <p className={`text-sm ${product.error ? 'text-destructive' : 'text-muted-foreground'}`}>
            {product.error ? product.error.message : 'Loading…'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
