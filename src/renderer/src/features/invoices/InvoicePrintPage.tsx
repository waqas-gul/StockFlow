import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, FileDown, Printer } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { PAPER_SIZES, type InvoicePrintInput, type PaperSize } from '@shared/invoice-print'
import { NotFoundPage } from '@renderer/app/NotFoundPage'
import { Button } from '@renderer/components/ui/button'
import { printableInvoiceQuery } from '@renderer/lib/app-queries'
import { singleFlight } from '@renderer/lib/single-flight'
import type { InvoiceNotifier } from './invoice-history'
import { submitInvoicePdf, submitInvoicePrint } from './invoice-print'
import { InvoicePrintDocument } from './InvoicePrintDocument'

const notify: InvoiceNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message)
}

type PrintAction = 'print' | 'pdf'

/**
 * Invoice Detail → Print Invoice: the invoice exactly as it prints, outside the app shell, with a paper choice (the
 * Settings paper size first), Save as PDF and Print. Nothing can be edited here.
 */
export function InvoicePrintPage(): React.JSX.Element {
  const params = useParams()
  const id = Number(params.invoiceId)
  if (!Number.isSafeInteger(id) || id <= 0) return <NotFoundPage />
  return <InvoicePrintScreen key={id} invoiceId={id} />
}

function InvoicePrintScreen({ invoiceId }: { invoiceId: number }): React.JSX.Element {
  const invoice = useQuery(printableInvoiceQuery(invoiceId))
  const [chosenPaper, setChosenPaper] = useState<PaperSize | null>(null)
  const [busy, setBusy] = useState<PrintAction | null>(null)
  // One print or PDF at a time: a double click sends it once.
  const [run] = useState(() =>
    singleFlight(async (action: PrintAction, input: InvoicePrintInput, invoiceNo: string) => {
      setBusy(action)
      try {
        if (action === 'print') {
          await submitInvoicePrint(window.api.invoices, input, invoiceNo, notify)
        } else {
          await submitInvoicePdf(window.api.invoices, input, notify)
        }
      } finally {
        setBusy(null)
      }
    })
  )

  if (invoice.error) {
    return (
      <div className="flex flex-col items-start gap-4 p-6">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/invoices">
            <ArrowLeft aria-hidden />
            Invoice History
          </Link>
        </Button>
        <p className="text-sm text-destructive">{invoice.error.message}</p>
      </div>
    )
  }
  if (!invoice.data) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>

  const current = invoice.data
  const paperSize = chosenPaper ?? current.paperSize
  const input: InvoicePrintInput = { id: current.id, paperSize }
  return (
    <div className="ip-page">
      <InvoicePrintToolbar
        invoiceId={current.id}
        invoiceNo={current.invoiceNo}
        paperSize={paperSize}
        defaultPaperSize={current.paperSize}
        busy={busy}
        onPaperSize={setChosenPaper}
        onPrint={() => void run('print', input, current.invoiceNo)}
        onSavePdf={() => void run('pdf', input, current.invoiceNo)}
      />
      <div className="ip-canvas">
        <InvoicePrintDocument invoice={current} paperSize={paperSize} />
      </div>
    </div>
  )
}

export interface InvoicePrintToolbarProps {
  readonly invoiceId: number
  readonly invoiceNo: string
  readonly paperSize: PaperSize
  /** The paper size in Settings. */
  readonly defaultPaperSize: PaperSize
  readonly busy: PrintAction | null
  readonly onPaperSize: (paperSize: PaperSize) => void
  readonly onPrint: () => void
  readonly onSavePdf: () => void
}

/** The preview's bar: never printed. */
export function InvoicePrintToolbar({
  invoiceId,
  invoiceNo,
  paperSize,
  defaultPaperSize,
  busy,
  onPaperSize,
  onPrint,
  onSavePdf
}: InvoicePrintToolbarProps): React.JSX.Element {
  const disabled = busy !== null
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-4 py-2.5 shadow-xs print:hidden">
      <Button variant="ghost" size="sm" asChild>
        <Link to={`/invoices/${invoiceId}`}>
          <ArrowLeft aria-hidden />
          <span className="font-mono">{invoiceNo}</span>
        </Link>
      </Button>
      <h1 className="text-base font-semibold">Print Preview</h1>

      <div className="flex items-center gap-2">
        <span id="paper-size-label" className="text-sm text-muted-foreground">
          Paper
        </span>
        <div role="group" aria-labelledby="paper-size-label" className="flex gap-1">
          {PAPER_SIZES.map((size) => (
            <Button
              key={size}
              type="button"
              size="sm"
              variant={size === paperSize ? 'default' : 'outline'}
              aria-pressed={size === paperSize}
              disabled={disabled}
              onClick={() => onPaperSize(size)}
            >
              {size}
            </Button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">Settings: {defaultPaperSize}</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" disabled={disabled} onClick={onSavePdf}>
          <FileDown aria-hidden />
          {busy === 'pdf' ? 'Saving PDF…' : 'Save as PDF…'}
        </Button>
        <Button disabled={disabled} onClick={onPrint}>
          <Printer aria-hidden />
          {busy === 'print' ? 'Printing…' : 'Print…'}
        </Button>
      </div>
    </div>
  )
}
