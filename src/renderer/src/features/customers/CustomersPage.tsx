import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Users } from 'lucide-react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import type { CustomerListItem, CustomerStatusFilter } from '@shared/customers'
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
import {
  customerListQuery,
  refreshAfterCustomerChange,
  settingsQuery
} from '@renderer/lib/app-queries'
import { useDebouncedValue } from '@renderer/lib/use-debounced-value'
import type { CurrencyFormat } from '../products/product-display'
import { Pager } from '../stock/Pager'
import { toggleCustomerActive, type CustomerNotifier } from './customer-actions'
import { balanceText, deactivateText } from './customer-display'
import { CustomerFormDialog, type CustomerEditorTarget } from './CustomerFormDialog'
import { CustomersTable } from './CustomersTable'

export const CUSTOMERS_PAGE_SIZE = 25

const notify: CustomerNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  warning: (message) => toast.warning(message)
}

/** Customers → Customers: the customer list with balances, search, status filter, paging and Add/Edit. */
export function CustomersPage(): React.JSX.Element {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<CustomerStatusFilter>('active')
  const [page, setPage] = useState(1)
  const debouncedSearch = useDebouncedValue(search.trim(), 250)
  const list = useQuery(
    customerListQuery({ page, pageSize: CUSTOMERS_PAGE_SIZE, search: debouncedSearch, status })
  )
  const settings = useQuery(settingsQuery)
  const [editor, setEditor] = useState<CustomerEditorTarget | null>(null)
  const [confirming, setConfirming] = useState<CustomerListItem | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const currency: CurrencyFormat | null = settings.data
    ? {
        minorDigits: settings.data.values['currency.minorDigits'],
        symbol: settings.data.values['currency.symbol']
      }
    : null

  const setActive = async (item: CustomerListItem): Promise<void> => {
    setConfirming(null)
    setBusyId(item.id)
    const changed = await toggleCustomerActive(
      window.api.customers,
      { id: item.id, code: item.code, active: !item.isActive },
      notify
    )
    setBusyId(null)
    // The last row of a later page may leave the filtered list: show the page before it.
    if (changed && status !== 'all' && list.data?.items.length === 1 && page > 1) setPage(page - 1)
    refreshAfterCustomerChange(queryClient)
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="text-sm text-muted-foreground">
            Customer accounts and balances. Open a customer to receive a payment, correct the
            balance or see the account ledger.
          </p>
        </div>
        <Button onClick={() => setEditor({ mode: 'create' })} disabled={currency === null}>
          <Plus aria-hidden />
          Add Customer
        </Button>
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
              aria-label="Search customers"
              placeholder="Search by code, name, shop, phone or city"
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
            value={status}
            onValueChange={(value) => {
              // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
              if (value === '') return
              setStatus(value as CustomerStatusFilter)
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
              <Users className="size-5" aria-hidden />
            </div>
            <p className="text-sm text-muted-foreground">
              {debouncedSearch !== '' || status !== 'active'
                ? 'No customers match the search or filter.'
                : 'No active customers.'}
            </p>
          </div>
        ) : (
          <>
            <CustomersTable
              items={list.data.items}
              currency={currency}
              busyId={busyId}
              onView={(id) => void navigate(`/customers/${id}`)}
              onEdit={(id) => setEditor({ mode: 'edit', id })}
              onToggleActive={(item) =>
                item.isActive ? setConfirming(item) : void setActive(item)
              }
            />
            <Pager
              page={page}
              pageSize={CUSTOMERS_PAGE_SIZE}
              shown={list.data.items.length}
              total={list.data.total}
              onPage={setPage}
            />
          </>
        )}
      </Card>

      {currency !== null && (
        <CustomerFormDialog
          target={editor}
          currency={currency}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            refreshAfterCustomerChange(queryClient)
          }}
        />
      )}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Deactivate {confirming?.code} {confirming?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming && currency
                ? deactivateText(balanceText(confirming.balanceMinor, currency))
                : ''}
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
