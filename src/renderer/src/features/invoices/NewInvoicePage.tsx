import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker } from 'react-router'
import { toast } from 'sonner'
import { WALK_IN_CUSTOMER_CODE, isWalkInCustomer } from '@shared/customers'
import { localDateString } from '@shared/dates'
import {
  invoiceBusinessDetails,
  type InvoiceBusinessDetails,
  type InvoiceCreateInput
} from '@shared/invoices'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import {
  customerQuery,
  customerSearchQuery,
  invoiceContextQuery,
  productQuery,
  refreshAfterInvoice,
  settingsQuery
} from '@renderer/lib/app-queries'
import { queryKeys } from '@renderer/lib/query-keys'
import { singleFlight } from '@renderer/lib/single-flight'
import { useUnloadGuard } from '@renderer/lib/unload-guard'
import { customerLabel } from '../customers/customer-display'
import type { CurrencyFormat } from '../products/product-display'
import { newRequestId } from '../stock/stock-actions'
import { submitInvoice, type InvoiceNotifier } from './invoice-actions'
import {
  emptyInvoiceDraft,
  invoiceDraftReducer,
  isDraftDirty,
  lineIndexOf,
  toDraftCustomer,
  type InvoiceDraftAction
} from './invoice-draft'
import { summarizeInvoice } from './invoice-summary'
import { InvoiceEditor } from './InvoiceEditor'
import { PostInvoiceDialog } from './PostInvoiceDialog'

interface PendingPost {
  readonly input: InvoiceCreateInput
  readonly customerLabel: string
  readonly walkIn: boolean
  readonly itemCount: number
  readonly totalMinor: number
  readonly receivedMinor: number
  readonly netOutstandingMinor: number
}

const notify: InvoiceNotifier = {
  // At the top, briefly: the bottom-right corner holds Post Invoice, which is pressed again at once in rapid billing.
  success: (message) => toast.success(message, { position: 'top-center', duration: 2500 }),
  error: (message) => toast.error(message)
}

/** Sales → New Invoice. */
export function NewInvoicePage(): React.JSX.Element {
  const settings = useQuery(settingsQuery)
  if (settings.error) {
    return <p className="text-sm text-destructive">{settings.error.message}</p>
  }
  if (!settings.data) return <p className="text-sm text-muted-foreground">Loading…</p>
  const currency: CurrencyFormat = {
    minorDigits: settings.data.values['currency.minorDigits'],
    symbol: settings.data.values['currency.symbol']
  }
  return (
    <InvoiceWorkspace currency={currency} business={invoiceBusinessDetails(settings.data.values)} />
  )
}

/**
 * The invoice being entered, kept in local state only. It is posted with one request id, which changes only once the
 * invoice is saved (or the draft is discarded), so a retry never saves it twice.
 */
function InvoiceWorkspace({
  currency,
  business
}: {
  currency: CurrencyFormat
  business: InvoiceBusinessDetails
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const newDraft = useCallback(
    () =>
      emptyInvoiceDraft({
        today: localDateString(new Date()),
        minorDigits: currency.minorDigits,
        requestId: newRequestId()
      }),
    [currency.minorDigits]
  )
  const [draft, dispatch] = useReducer(invoiceDraftReducer, undefined, newDraft)
  // Problems of empty fields are shown once the operator tries to post; main-process errors until the next edit.
  const [attempted, setAttempted] = useState(false)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  // The invoice as the operator confirms it: the dialog shows and posts exactly this. `confirmed` stays after closing,
  // so the dialog is never unmounted while open (the draft resets as soon as the invoice is saved).
  const [pending, setPending] = useState<PendingPost | null>(null)
  const [confirmed, setConfirmed] = useState<PendingPost | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [posting, setPosting] = useState(false)
  const [savedCount, setSavedCount] = useState(0)

  // Ready for the next invoice: once the cleared form is on screen, it starts with the customer.
  useEffect(() => {
    if (savedCount > 0) document.getElementById('invoice-customer')?.focus()
  }, [savedCount])

  const edit = useCallback((action: InvoiceDraftAction) => {
    setServerErrors({})
    dispatch(action)
  }, [])

  const customerId = draft.customer?.id ?? null
  const customer = useQuery({ ...customerQuery(customerId ?? 0), enabled: customerId !== null })
  const balanceMinor = customer.data?.balanceMinor ?? draft.customer?.balanceMinor ?? 0
  const productIds = draft.lines.map((line) => line.product.id).sort((a, b) => a - b)
  const context = useQuery(invoiceContextQuery({ customerId, productIds }))
  const walkInSearch = useQuery(
    customerSearchQuery({ query: WALK_IN_CUSTOMER_CODE, limit: 5, includeInactive: true })
  )
  const walkIn = walkInSearch.data?.find((item) => isWalkInCustomer(item.code))

  const summary = useMemo(() => summarizeInvoice(draft, { balanceMinor }), [draft, balanceMinor])
  const dirty = isDraftDirty(draft)
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname
  )
  // Closing the window over a dirty draft asks in the main process first (Stay / Close and Discard).
  useUnloadGuard(dirty)

  const errors = { ...(attempted ? summary.issues : {}), ...serverErrors }

  const startOver = useCallback(() => {
    dispatch({ type: 'reset', draft: newDraft() })
    setAttempted(false)
    setServerErrors({})
  }, [newDraft])

  const post = useMemo(
    () =>
      singleFlight(async (input: InvoiceCreateInput) => {
        setPosting(true)
        try {
          const saved = await submitInvoice(window.api.invoices, input, {
            onSaved: () => {
              refreshAfterInvoice(queryClient)
              startOver()
              setSavedCount((count) => count + 1)
            },
            onFieldErrors: setServerErrors,
            onProductsChanged: async (ids) => {
              for (const id of ids) {
                try {
                  dispatch({
                    type: 'refreshProduct',
                    product: await queryClient.fetchQuery(productQuery(id))
                  })
                } catch {
                  // The product stays as it was; posting checks it again.
                }
              }
            },
            notify
          })
          if (!saved) {
            // The balance, the posting-date floor or the next number may have changed meanwhile.
            void queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all })
            void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all })
          }
        } finally {
          setPosting(false)
          setPending(null)
        }
      }),
    [queryClient, startOver]
  )

  const requestPost = (): void => {
    setAttempted(true)
    const { input, totals } = summary
    if (input === null || totals === null || draft.customer === null) {
      toast.error(
        summary.stockBlocked
          ? 'A line needs more stock than is available.'
          : 'Check the highlighted fields before posting.'
      )
      return
    }
    const next: PendingPost = {
      input,
      customerLabel: customerLabel(draft.customer),
      walkIn: summary.walkIn,
      itemCount: draft.lines.length,
      totalMinor: totals.totalMinor,
      receivedMinor: totals.receivedMinor,
      netOutstandingMinor: totals.netOutstandingMinor
    }
    setPending(next)
    setConfirmed(next)
  }

  const addProduct = async (item: { id: number; code: string; name: string }): Promise<void> => {
    const existing = lineIndexOf(draft, item.id)
    if (existing !== null) {
      toast.warning(
        `${item.code} ${item.name} is already on line ${existing + 1}. Add its other units on that line.`
      )
      return
    }
    try {
      edit({ type: 'addLine', product: await queryClient.fetchQuery(productQuery(item.id)) })
    } catch {
      toast.error('The product could not be loaded. Try again.')
    }
  }

  const discardOpen = discarding || blocker.state === 'blocked'
  const keepEditing = (): void => {
    setDiscarding(false)
    if (blocker.state === 'blocked') blocker.reset()
  }
  const discard = (): void => {
    setDiscarding(false)
    startOver()
    if (blocker.state === 'blocked') blocker.proceed()
  }

  return (
    <>
      <InvoiceEditor
        draft={draft}
        summary={summary}
        currency={currency}
        context={context.data}
        business={business}
        customerBalanceMinor={balanceMinor}
        walkInAvailable={walkIn?.isActive === true}
        errors={errors}
        posting={posting}
        dispatch={edit}
        onPickCustomer={(item) => edit({ type: 'setCustomer', customer: toDraftCustomer(item) })}
        onCashSale={() => {
          if (walkIn !== undefined) edit({ type: 'setCustomer', customer: toDraftCustomer(walkIn) })
        }}
        onAddProduct={(item) => void addProduct(item)}
        onPost={requestPost}
        onClear={() => (dirty ? setDiscarding(true) : startOver())}
      />

      {confirmed !== null && (
        <PostInvoiceDialog
          open={pending !== null}
          customerLabel={confirmed.customerLabel}
          walkIn={confirmed.walkIn}
          itemCount={confirmed.itemCount}
          totalMinor={confirmed.totalMinor}
          receivedMinor={confirmed.receivedMinor}
          netOutstandingMinor={confirmed.netOutstandingMinor}
          currency={currency}
          posting={posting}
          onCancel={() => setPending(null)}
          onConfirm={() => void post(confirmed.input)}
        />
      )}

      <AlertDialog open={discardOpen} onOpenChange={(open) => !open && keepEditing()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              The customer, products and amounts entered so far will be lost. Nothing has been
              posted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={keepEditing}>
              Keep Editing
            </Button>
            <Button variant="destructive" onClick={discard}>
              Discard
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
