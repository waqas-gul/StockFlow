import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, ChevronLeft, ChevronRight, Package, Plus, Search } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import {
  DEACTIVATE_WITH_STOCK_WARNING,
  type Product,
  type ProductListItem,
  type ProductStatusFilter
} from '@shared/products'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { wantsForm } from '@renderer/app/page-links'
import { companiesQuery, productListQuery, settingsQuery } from '@renderer/lib/app-queries'
import { queryKeys } from '@renderer/lib/query-keys'
import { useDebouncedValue } from '@renderer/lib/use-debounced-value'
import { CompaniesDialog } from './CompaniesDialog'
import { toggleProductActive, type ProductNotifier } from './product-actions'
import { stockText, type CurrencyFormat } from './product-display'
import { ProductFormDialog, type ProductEditorTarget } from './ProductFormDialog'
import { StockCardDialog } from '../stock/StockCardDialog'
import { ProductsTable } from './ProductsTable'

export const PRODUCTS_PAGE_SIZE = 25
const ALL_COMPANIES = 'all'

const notify: ProductNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

/**
 * Inventory → Products: the product list with search, filters, paging, and the add/edit and company dialogs. `?add=1`
 * (the Dashboard's Add Product) opens Add Product.
 */
export function ProductsPage(): React.JSX.Element {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [companyFilter, setCompanyFilter] = useState(ALL_COMPANIES)
  const [status, setStatus] = useState<ProductStatusFilter>('active')
  const [page, setPage] = useState(1)
  const debouncedSearch = useDebouncedValue(search.trim(), 250)

  const list = useQuery(
    productListQuery({
      page,
      pageSize: PRODUCTS_PAGE_SIZE,
      search: debouncedSearch,
      companyId: companyFilter === ALL_COMPANIES ? null : Number(companyFilter),
      status
    })
  )
  const settings = useQuery(settingsQuery)
  const companies = useQuery(companiesQuery)

  const [params] = useSearchParams()
  const [editor, setEditor] = useState<ProductEditorTarget | null>(() =>
    wantsForm(params, 'add') ? { mode: 'create' } : null
  )
  const [companiesOpen, setCompaniesOpen] = useState(false)
  const [confirming, setConfirming] = useState<ProductListItem | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [stockCardId, setStockCardId] = useState<number | null>(null)

  const currency: CurrencyFormat | null = settings.data
    ? {
        minorDigits: settings.data.values['currency.minorDigits'],
        symbol: settings.data.values['currency.symbol']
      }
    : null

  const total = list.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PRODUCTS_PAGE_SIZE))

  const refreshAfterSave = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.products.all })
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies })
    // A price or cost locks the currency decimal places (Settings).
    void queryClient.invalidateQueries({ queryKey: queryKeys.settings })
  }

  const setActive = async (item: ProductListItem): Promise<void> => {
    setConfirming(null)
    setBusyId(item.id)
    const changed = await toggleProductActive(
      window.api.products,
      { id: item.id, code: item.code, active: !item.isActive },
      notify
    )
    setBusyId(null)
    // The last row of a later page may leave the filtered list: show the page before it.
    if (changed && status !== 'all' && list.data?.items.length === 1 && page > 1) setPage(page - 1)
    void queryClient.invalidateQueries({ queryKey: queryKeys.products.all })
  }

  const onToggleActive = (item: ProductListItem): void => {
    if (item.isActive && item.stockQtyBase > 0) setConfirming(item)
    else void setActive(item)
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="text-sm text-muted-foreground">
            Your products, their units and prices. Stock is added with Stock In.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setCompaniesOpen(true)}>
            <Building2 aria-hidden />
            Manage Brands / Companies
          </Button>
          <Button onClick={() => setEditor({ mode: 'create' })} disabled={currency === null}>
            <Plus aria-hidden />
            Add Product
          </Button>
        </div>
      </div>

      <Card className="gap-0 py-0">
        <CardContent className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="relative min-w-64 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              aria-label="Search products"
              placeholder="Search by code, product or company"
              className="pl-8"
              maxLength={100}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setPage(1)
              }}
            />
          </div>
          <Select
            value={companyFilter}
            onValueChange={(value) => {
              setCompanyFilter(value)
              setPage(1)
            }}
          >
            <SelectTrigger aria-label="Brand / Company" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_COMPANIES}>All companies</SelectItem>
              {(companies.data ?? []).map((company) => (
                <SelectItem key={company.id} value={String(company.id)}>
                  {company.name}
                  {company.isActive ? '' : ' (inactive)'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as ProductStatusFilter)
              setPage(1)
            }}
          >
            <SelectTrigger aria-label="Status" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="all">All statuses</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>

        {list.error ? (
          <p className="px-4 py-8 text-center text-sm text-destructive">{list.error.message}</p>
        ) : !list.data || currency === null ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : list.data.items.length === 0 ? (
          <EmptyState
            filtered={
              debouncedSearch !== '' || companyFilter !== ALL_COMPANIES || status !== 'active'
            }
            onAdd={() => setEditor({ mode: 'create' })}
          />
        ) : (
          <>
            <ProductsTable
              items={list.data.items}
              currency={currency}
              busyId={busyId}
              onEdit={(id) => setEditor({ mode: 'edit', id })}
              onToggleActive={onToggleActive}
              onStockCard={setStockCardId}
            />
            <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
              <span>
                Showing {(page - 1) * PRODUCTS_PAGE_SIZE + 1}–
                {(page - 1) * PRODUCTS_PAGE_SIZE + list.data.items.length} of{' '}
                {total.toLocaleString('en-US')}
              </span>
              <div className="flex items-center gap-2">
                <span>
                  Page {page} of {pages}
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Previous page"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft aria-hidden />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Next page"
                  disabled={page >= pages}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight aria-hidden />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {currency !== null && (
        <ProductFormDialog
          target={editor}
          currency={currency}
          onClose={() => setEditor(null)}
          onSaved={(product: Product) => {
            setEditor(null)
            refreshAfterSave()
            queryClient.setQueryData(queryKeys.products.detail(product.id), product)
          }}
        />
      )}
      <CompaniesDialog open={companiesOpen} onOpenChange={setCompaniesOpen} />
      {currency !== null && (
        <StockCardDialog
          productId={stockCardId}
          currency={currency}
          onClose={() => setStockCardId(null)}
        />
      )}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {confirming?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {DEACTIVATE_WITH_STOCK_WARNING} Current stock:{' '}
              {confirming ? stockText(confirming) : ''}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button onClick={() => confirming && void setActive(confirming)}>Deactivate</Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function EmptyState({
  filtered,
  onAdd
}: {
  filtered: boolean
  onAdd: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg bg-secondary text-primary">
        <Package className="size-5" aria-hidden />
      </div>
      {filtered ? (
        <p className="text-sm text-muted-foreground">No products match the search or filters.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">No products yet.</p>
          <Button size="sm" onClick={onAdd}>
            <Plus aria-hidden />
            Add your first product
          </Button>
        </>
      )}
    </div>
  )
}
