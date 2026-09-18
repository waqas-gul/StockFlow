import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { localDateString } from '@shared/dates'
import type { StockReceiptDetail } from '@shared/stock'
import { linkedId } from '@renderer/app/page-links'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent } from '@renderer/components/ui/card'
import { settingsQuery, supplierQuery } from '@renderer/lib/app-queries'
import { supplierLabel } from '../suppliers/supplier-display'
import { cn } from '@renderer/lib/utils'
import type { CurrencyFormat } from '../products/product-display'
import { ReceiptDetailDialog } from './ReceiptDetailDialog'
import { ReceiptForm } from './ReceiptForm'
import { ReceiptHistory } from './ReceiptHistory'

export type StockInTab = 'new' | 'history'

/** Inventory → Stock In: a new receipt, and the receipt history with receipt details and voids. */
export function StockInPage({
  initialTab = 'new'
}: {
  initialTab?: StockInTab
}): React.JSX.Element {
  const settings = useQuery(settingsQuery)
  const [params] = useSearchParams()
  // Supplier → New Stock Purchase opens the form with that supplier chosen.
  const [linkedSupplierId] = useState(() => linkedId(params, 'supplier'))
  const linkedSupplier = useQuery({
    ...supplierQuery(linkedSupplierId ?? 0),
    enabled: linkedSupplierId !== null
  })
  const [tab, setTab] = useState<StockInTab>(initialTab)
  const [openReceipt, setOpenReceipt] = useState<number | null>(null)
  const [lastSaved, setLastSaved] = useState<StockReceiptDetail | null>(null)
  const today = localDateString(new Date())

  const currency: CurrencyFormat | null = settings.data
    ? {
        minorDigits: settings.data.values['currency.minorDigits'],
        symbol: settings.data.values['currency.symbol']
      }
    : null

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 pb-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Stock In</h1>
        <p className="text-sm text-muted-foreground">
          Record goods received. Each line adds stock in base units at its exact cost; with a
          supplier, the total is added to what the shop owes that supplier.
        </p>
      </div>

      <div role="tablist" aria-label="Stock In" className="flex gap-1 border-b">
        {(
          [
            ['new', 'New Receipt'],
            ['history', 'Receipt History']
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === value
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {currency === null || (linkedSupplierId !== null && linkedSupplier.isPending) ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tab === 'new' ? (
        <>
          {lastSaved && (
            <p className="text-sm">
              Saved receipt <span className="font-mono">{lastSaved.receiptNo}</span>.{' '}
              <Button
                variant="link"
                className="h-auto p-0"
                onClick={() => setOpenReceipt(lastSaved.id)}
              >
                View receipt
              </Button>
            </p>
          )}
          <Card className="py-4">
            <CardContent className="px-4">
              <ReceiptForm
                currency={currency}
                today={today}
                initialSupplier={
                  linkedSupplier.data?.isActive
                    ? { id: linkedSupplier.data.id, label: supplierLabel(linkedSupplier.data) }
                    : null
                }
                onSaved={setLastSaved}
              />
            </CardContent>
          </Card>
        </>
      ) : (
        <Card className="gap-0 py-0">
          <ReceiptHistory currency={currency} onOpen={setOpenReceipt} />
        </Card>
      )}

      {currency !== null && (
        <ReceiptDetailDialog
          receiptId={openReceipt}
          currency={currency}
          onClose={() => setOpenReceipt(null)}
        />
      )}
    </div>
  )
}
