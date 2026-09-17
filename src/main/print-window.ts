import type { BrowserWindow } from 'electron'
import type { PaperSize } from '@shared/invoice-print'
import type { PrintTarget, PrintTargetView } from './services/invoice-print.service'

/*
 * The Electron side of invoice printing: the app window's own webContents. The print preview's stylesheet sets the page
 * size and margins (@page) and hides everything but the invoice when printing, so the output is the preview itself.
 * Only the main process calls these; the renderer reaches them only through invoices.print and invoices.savePdf.
 */

/** Reads the route and the print document's marks. Runs in the page; returns plain strings or nulls. */
const INSPECT_SCRIPT = `(() => {
  const document_ = document.querySelector('[data-print-document]')
  return {
    hash: location.hash,
    invoiceNo: document_ ? document_.getAttribute('data-invoice-no') : null,
    paperSize: document_ ? document_.getAttribute('data-paper-size') : null
  }
})()`

/**
 * The result of webContents.print: sent, or cancelled in the print dialog. Electron documents the cancel as "cancelled";
 * the Windows 11 print dialog reports "Print job canceled". Any other failure throws.
 */
export function printOutcome(success: boolean, failureReason: string): 'SENT' | 'CANCELLED' {
  if (success) return 'SENT'
  if (/cancel/i.test(failureReason)) return 'CANCELLED'
  throw new Error(`Printing failed: ${failureReason}`)
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** The window to print, while it exists. */
export function createPrintTarget(getWindow: () => BrowserWindow | null): () => PrintTarget | null {
  return () => {
    const window = getWindow()
    if (window === null || window.isDestroyed()) return null
    const contents = window.webContents
    return {
      async inspect(): Promise<PrintTargetView> {
        const found: unknown = await contents.executeJavaScript(INSPECT_SCRIPT)
        const view = (typeof found === 'object' && found !== null ? found : {}) as Record<
          string,
          unknown
        >
        return {
          route: (text(view.hash) ?? '').replace(/^#/, ''),
          invoiceNo: text(view.invoiceNo),
          paperSize: text(view.paperSize)
        }
      },
      print(paperSize: PaperSize): Promise<'SENT' | 'CANCELLED'> {
        return new Promise((resolve, reject) => {
          // Never silent: the user chooses the printer, copies and printer properties.
          contents.print(
            { silent: false, printBackground: false, pageSize: paperSize },
            (success, failureReason) => {
              try {
                resolve(printOutcome(success, failureReason))
              } catch (error) {
                reject(error)
              }
            }
          )
        })
      },
      printToPdf(paperSize: PaperSize): Promise<Uint8Array> {
        // The page size and margins come from the preview's @page rule.
        return contents.printToPDF({
          pageSize: paperSize,
          preferCSSPageSize: true,
          printBackground: false,
          margins: { top: 0, bottom: 0, left: 0, right: 0 }
        })
      }
    }
  }
}
