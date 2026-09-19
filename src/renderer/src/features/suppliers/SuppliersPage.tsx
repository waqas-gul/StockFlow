import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { HandCoins, Plus, Truck } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import type { SupplierListItem, SupplierStatusFilter } from '@shared/suppliers'
import { pageLinks, wantsForm } from '@renderer/app/page-links'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent } from '@renderer/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import {
  refreshAfterSupplierChange,
  settingsQuery,
  supplierListQuery
} from '@renderer/lib/app-queries'
import { useDebouncedValue } from '@renderer/lib/use-debounced-value'
import { SupplierSearchBox } from './SupplierSearchBox'
import type { CurrencyFormat } from '../products/product-display'
import { Pager } from '../stock/Pager'
import { PaySupplierDialog } from './PaySupplierDialog'
import { toggleSupplierActive, type SupplierNotifier } from './supplier-actions'
import { SupplierDeactivateDialog } from './SupplierDeactivateDialog'
import { SupplierFormDialog, type SupplierEditorTarget } from './SupplierFormDialog'
import { SuppliersTable } from './SuppliersTable'

export const SUPPLIERS_PAGE_SIZE = 25

const notify: SupplierNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

/**
 * Suppliers: the people and firms the shop buys stock from, with what the shop owes each. Search, status filter, paging,
 * Add/Edit, and Pay Supplier (`?pay=1`, the Dashboard's quick action, opens it).
 */
export function SuppliersPage(): React.JSX.Element {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<SupplierStatusFilter>('active')
  const [page, setPage] = useState(1)
  const debouncedSearch = useDebouncedValue(search.trim(), 250)
  const list = useQuery(
    supplierListQuery({ page, pageSize: SUPPLIERS_PAGE_SIZE, search: debouncedSearch, status })
  )
  const settings = useQuery(settingsQuery)
  const [editor, setEditor] = useState<SupplierEditorTarget | null>(null)
  const [paying, setPaying] = useState(() => wantsForm(params, 'pay'))
  const [confirming, setConfirming] = useState<SupplierListItem | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const currency: CurrencyFormat | null = settings.data
    ? {
        minorDigits: settings.data.values['currency.minorDigits'],
        symbol: settings.data.values['currency.symbol']
      }
    : null

  const setActive = async (item: SupplierListItem): Promise<void> => {
    setConfirming(null)
    setBusyId(item.id)
    const changed = await toggleSupplierActive(
      window.api.suppliers,
      { id: item.id, code: item.code, active: !item.isActive },
      notify
    )
    setBusyId(null)
    // The last row of a later page may leave the filtered list: show the page before it.
    if (changed && status !== 'all' && list.data?.items.length === 1 && page > 1) setPage(page - 1)
    refreshAfterSupplierChange(queryClient)
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
          <p className="text-sm text-muted-foreground">
            The people and firms you buy stock from, and what the shop owes each. Open a supplier to
            see its purchases, payments and account ledger.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setPaying(true)} disabled={currency === null}>
            <HandCoins aria-hidden />
            Pay Supplier
          </Button>
          <Button onClick={() => setEditor({ mode: 'create' })} disabled={currency === null}>
            <Plus aria-hidden />
            Add Supplier
          </Button>
        </div>
      </div>

      <Card className="gap-0 py-0">
        <CardContent className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="min-w-64 flex-1">
            <SupplierSearchBox
              ariaLabel="Search suppliers"
              placeholder="Search by code, name, contact, phone or city"
              includeInactive={status !== 'active'}
              value={search}
              onChange={(value) => {
                setSearch(value)
                setPage(1)
              }}
            />
          </div>
          <Select
            value={status}
            onValueChange={(value) => {
              // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
              if (value === '') return
              setStatus(value as SupplierStatusFilter)
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
          <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-lg bg-secondary text-primary">
              <Truck className="size-5" aria-hidden />
            </div>
            <p className="text-sm text-muted-foreground">
              {debouncedSearch !== '' || status !== 'active'
                ? 'No suppliers match the search or filter.'
                : 'No suppliers yet. Add the people and firms you buy stock from.'}
            </p>
          </div>
        ) : (
          <>
            <SuppliersTable
              items={list.data.items}
              currency={currency}
              busyId={busyId}
              onView={(id) => void navigate(pageLinks.supplier(id))}
              onEdit={(id) => setEditor({ mode: 'edit', id })}
              onToggleActive={(item) =>
                item.isActive ? setConfirming(item) : void setActive(item)
              }
            />
            <Pager
              page={page}
              pageSize={SUPPLIERS_PAGE_SIZE}
              shown={list.data.items.length}
              total={list.data.total}
              onPage={setPage}
            />
          </>
        )}
      </Card>

      {currency !== null && (
        <>
          <SupplierFormDialog
            target={editor}
            currency={currency}
            onClose={() => setEditor(null)}
            onSaved={() => {
              setEditor(null)
              refreshAfterSupplierChange(queryClient)
            }}
          />
          <PaySupplierDialog
            open={paying}
            supplier={null}
            currency={currency}
            onClose={() => setPaying(false)}
            onSaved={() => setPaying(false)}
          />
          <SupplierDeactivateDialog
            supplier={confirming}
            currency={currency}
            onCancel={() => setConfirming(null)}
            onConfirm={(item) => void setActive(item)}
          />
        </>
      )}
    </div>
  )
}
