import { randomBytes } from 'node:crypto'
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { InvoiceIdSchema } from '@shared/invoices'
import {
  InvoicePrintInputSchema,
  invoiceAmountInWords,
  invoicePdfFileName,
  invoicePrintPath,
  type InvoicePdfResult,
  type InvoicePrintResult,
  type PaperSize,
  type PrintableInvoice
} from '@shared/invoice-print'
import type { Db } from '../db/adapter'
import { toDisplayLocation } from '../data-paths'
import { AppFailure, parseInput } from '../errors'
import type { Logger } from '../logging'
import { readInvoice } from './invoices.service'
import type { LiveDatabase } from './live-database'
import { readSettings } from './settings.service'

/*
 * Invoice printing and PDF (Phase 9B). Read-only: nothing here writes to the database.
 *
 * The renderer shows the print preview of one invoice (its route and a document marked with the invoice number and
 * paper size). Print and Save as PDF are main-process operations on that window: the main process reads the invoice
 * itself, checks that the window really shows its print preview on the requested paper, then opens the system print
 * dialog, or its own Save dialog and printToPDF. The renderer never names a printer, a file or a folder.
 */

/**
 * The printed invoice, from the saved invoice (one synchronous read, so it cannot mix two states), with the shop and
 * salesman saved with it, and the current currency and paper settings, which only change its presentation. An invoice
 * posted before the shop and salesman were kept prints the current shop name, as it always did, and no address or
 * salesman: nothing is invented for it.
 */
export function readPrintableInvoice(db: Db, id: unknown): PrintableInvoice {
  const invoice = readInvoice(db, parseInput(InvoiceIdSchema, id))
  const settings = readSettings(db)
  const { business } = invoice
  const currency = {
    code: settings['currency.code'],
    symbol: settings['currency.symbol'],
    minorDigits: settings['currency.minorDigits']
  }
  return {
    id: invoice.id,
    invoiceNo: invoice.invoiceNo,
    invoiceCode: invoice.invoiceCode,
    invoiceDate: invoice.invoiceDate,
    status: invoice.status,
    voidDate: invoice.voidDate,
    voidReason: invoice.voidReason,
    businessName: business?.shopName ?? settings['business.name'],
    businessAddress: business?.shopAddress ?? null,
    salesman:
      business === null
        ? null
        : {
            name: business.salesmanName,
            phone1: business.salesmanPhone1,
            phone2: business.salesmanPhone2
          },
    currency,
    paperSize: settings['invoice.paperSize'],
    customer: {
      name: invoice.customerName,
      shopName: invoice.customerShopName,
      phone: invoice.customerPhone,
      address: invoice.customerAddress,
      city: invoice.customerCity
    },
    dispatch: {
      biltyNo: invoice.biltyNo,
      transportName: invoice.transportName,
      addaName: invoice.addaName
    },
    checkedBy: invoice.checkedBy,
    lines: invoice.lines.map((line) => ({
      lineNo: line.lineNo,
      productName: line.productName,
      packingLabel: line.packingLabel,
      quantities: line.quantities.map((row) => ({
        unitName: row.unitName,
        unitShortName: row.unitShortName,
        unitBaseQty: row.unitBaseQty,
        quantity: row.quantity,
        unitPriceMinor: row.unitPriceMinor,
        amountMinor: row.amountMinor
      })),
      schemeQtyBase: line.schemeQtyBase,
      grossMinor: line.grossMinor,
      discountBps: line.discountBps,
      discountMinor: line.discountMinor,
      schemeMinor: line.schemeMinor,
      ctnCount: line.ctnCount,
      netMinor: line.netMinor
    })),
    totals: {
      grossMinor: invoice.grossMinor,
      lineDiscountMinor: invoice.lineDiscountMinor,
      lineSchemeMinor: invoice.lineSchemeMinor,
      extraDiscountMinor: invoice.extraDiscountMinor,
      netMinor: invoice.netMinor,
      freightMinor: invoice.freightMinor,
      totalMinor: invoice.totalMinor,
      previousBalanceMinor: invoice.previousBalanceMinor,
      receivedMinor: invoice.receivedMinor,
      netOutstandingMinor: invoice.netOutstandingMinor
    },
    amountInWords: invoiceAmountInWords(invoice.totalMinor, currency),
    pdfFileName: invoicePdfFileName(invoice.invoiceNo)
  }
}

/** What the app window shows: its route and, on a print preview, the invoice number and paper of its document. */
export interface PrintTargetView {
  readonly route: string
  readonly invoiceNo: string | null
  readonly paperSize: string | null
}

/** The app window, as printing needs it (Electron's webContents in the app; a fake in tests). */
export interface PrintTarget {
  inspect(): Promise<PrintTargetView>
  /** Opens the system print dialog. Throws when printing fails. */
  print(paperSize: PaperSize): Promise<'SENT' | 'CANCELLED'>
  /** The document as a PDF. Throws when it cannot be created. */
  printToPdf(paperSize: PaperSize): Promise<Uint8Array>
}

export interface PdfDialogs {
  /** The Save dialog of a PDF, opened at `defaultPath`; it asks before replacing a file. Null when cancelled. */
  choosePdfFile(defaultPath: string): Promise<string | null>
}

export interface InvoicePrintServiceDeps {
  readonly database: LiveDatabase
  readonly log: Pick<Logger, 'info' | 'error'>
  /** The app window; null when there is none. */
  readonly target: () => PrintTarget | null
  readonly dialogs: PdfDialogs
  /** Where the first Save dialog opens. */
  readonly documentsDir: string
  /** Absolute AppData and profile folders, only to shorten the folder shown in the renderer. */
  readonly appDataPath: string
  readonly homePath: string
}

const BUSY_MESSAGE = 'An invoice is already being printed or saved as a PDF. Finish that first.'

/** Print and Save as PDF from the print preview. */
export class InvoicePrintService {
  readonly #deps: InvoicePrintServiceDeps
  #busy = false
  /** The folder of the last saved PDF, for this session. */
  #lastFolder: string | null = null

  constructor(deps: InvoicePrintServiceDeps) {
    this.#deps = deps
  }

  /** The system print dialog, for the invoice shown in the print preview. */
  async print(input: unknown): Promise<InvoicePrintResult> {
    const { id, paperSize } = parseInput(InvoicePrintInputSchema, input)
    return this.#exclusive(async () => {
      const invoice = readPrintableInvoice(this.#deps.database.get(), id)
      const target = await this.#previewOf(invoice.invoiceNo, id, paperSize)
      let outcome: 'SENT' | 'CANCELLED'
      try {
        outcome = await target.print(paperSize)
      } catch (error) {
        this.#deps.log.error('[print] the invoice could not be printed', error, {
          invoiceNo: invoice.invoiceNo
        })
        throw printFailed(
          `${invoice.invoiceNo} could not be printed. Check the printer and try again.`
        )
      }
      if (outcome === 'CANCELLED') return { status: 'CANCELLED' }
      this.#deps.log.info('[print] invoice sent to the printer', {
        invoiceNo: invoice.invoiceNo,
        paperSize
      })
      return { status: 'SENT' }
    })
  }

  /**
   * Save as PDF: the main process's Save dialog proposes "<invoice no>.pdf" (in the last PDF folder, or Documents), then
   * the preview is written there as a PDF. The file appears whole or not at all.
   */
  async savePdf(input: unknown): Promise<InvoicePdfResult> {
    const { id, paperSize } = parseInput(InvoicePrintInputSchema, input)
    return this.#exclusive(async () => {
      const { log, dialogs, documentsDir, appDataPath, homePath } = this.#deps
      const invoice = readPrintableInvoice(this.#deps.database.get(), id)
      await this.#previewOf(invoice.invoiceNo, id, paperSize)
      const folder = this.#lastFolder ?? documentsDir
      const chosen = await dialogs.choosePdfFile(win32.join(folder, invoice.pdfFileName))
      if (chosen === null) return { status: 'CANCELLED' }
      if (!win32.isAbsolute(chosen)) {
        throw printFailed('This location cannot be used. Choose another folder.')
      }
      let file = chosen
      if (!/\.pdf$/i.test(file)) {
        file = `${file}.pdf`
        // The dialog asked about the name without .pdf, not about this one.
        if (existsSync(file)) {
          throw printFailed(
            `${win32.basename(file)} already exists. Save the PDF again and choose another name.`
          )
        }
      }
      const fileName = win32.basename(file)

      // The preview must still be there (the dialog is modal, but the window may have closed meanwhile).
      const target = await this.#previewOf(invoice.invoiceNo, id, paperSize)
      let pdf: Uint8Array
      try {
        pdf = await target.printToPdf(paperSize)
      } catch (error) {
        log.error('[print] the invoice PDF could not be created', error, {
          invoiceNo: invoice.invoiceNo
        })
        throw printFailed(`The PDF of ${invoice.invoiceNo} could not be created. Try again.`)
      }
      try {
        writeWholeFile(file, pdf)
      } catch (error) {
        log.error('[print] the invoice PDF could not be written', error, { file: fileName })
        throw printFailed(
          `${fileName} could not be saved. Check that the folder can be written to and that the file is not open in another program, then try again.`
        )
      }
      this.#lastFolder = win32.dirname(file)
      log.info('[print] invoice PDF saved', { invoiceNo: invoice.invoiceNo, file: fileName })
      return {
        status: 'SAVED',
        fileName,
        location: toDisplayLocation(win32.dirname(file), appDataPath, homePath)
      }
    })
  }

  /** The app window, if it shows the print preview of this invoice on this paper. */
  async #previewOf(invoiceNo: string, id: number, paperSize: PaperSize): Promise<PrintTarget> {
    const target = this.#deps.target()
    const view = target === null ? null : await target.inspect()
    if (
      target === null ||
      view === null ||
      view.route !== invoicePrintPath(id) ||
      view.invoiceNo !== invoiceNo ||
      view.paperSize !== paperSize
    ) {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: `Open the print preview of ${invoiceNo} to print it or save it as a PDF.`
      })
    }
    return target
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new AppFailure({ code: 'FORBIDDEN_STATE', message: BUSY_MESSAGE })
    this.#busy = true
    try {
      return await operation()
    } finally {
      this.#busy = false
    }
  }
}

function printFailed(message: string): AppFailure {
  return new AppFailure({ code: 'PRINT_FAILED', message })
}

/** Writes a temporary file next to `file`, then renames it into place; the temporary file is removed on failure. */
function writeWholeFile(file: string, data: Uint8Array): void {
  const partial = `${file}.${randomBytes(4).toString('hex')}.partial`
  try {
    writeFileSync(partial, data, { flag: 'wx' })
    renameSync(partial, file)
  } catch (error) {
    rmSync(partial, { force: true })
    throw error
  }
}
