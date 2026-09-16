import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { localDateString } from '@shared/dates'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { settingsQuery } from '@renderer/lib/app-queries'
import type { CurrencyFormat } from '../products/product-display'
import { AdjustmentForm } from './AdjustmentForm'
import { AdjustmentHistory } from './AdjustmentHistory'

/**
 * Inventory → Stock Adjustments: opening stock, damage, expiry, shortage, count surplus and corrections, then the
 * adjustment history. `?receipt=<id>` (from a locked receipt's "Correct Stock") starts a correction of that receipt.
 */
export function StockAdjustmentsPage(): React.JSX.Element {
  const settings = useQuery(settingsQuery)
  const [params] = useSearchParams()
  const receiptParam = Number(params.get('receipt'))
  const receiptId = Number.isSafeInteger(receiptParam) && receiptParam > 0 ? receiptParam : null
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
        <h1 className="text-2xl font-semibold tracking-tight">Stock Adjustments</h1>
        <p className="text-sm text-muted-foreground">
          Opening stock, damage, expiry, shortages, count differences and corrections. Every
          adjustment needs a reason note and is kept in the stock history.
        </p>
      </div>
      {currency === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <Card className="gap-4 py-4">
            <CardHeader className="px-4">
              <CardTitle>New Adjustment</CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              <AdjustmentForm
                key={receiptId ?? 'new'}
                currency={currency}
                today={today}
                receiptId={receiptId}
              />
            </CardContent>
          </Card>
          <Card className="gap-0 py-0">
            <CardHeader className="border-b px-4 py-3">
              <CardTitle>Adjustment History</CardTitle>
            </CardHeader>
            <AdjustmentHistory currency={currency} />
          </Card>
        </>
      )}
    </div>
  )
}
