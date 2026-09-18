import { z } from 'zod'
import { amountInWords, integerToWords } from './domain/amount-in-words'
import type { InvoiceStatus } from './invoices'
import { PAPER_SIZES, type PaperSize } from './settings'
import { IdSchema } from './validation'

/*
 * Invoice printing and PDF (Phase 9B). The printed invoice is built from one read of the saved invoice: the shop,
 * salesman, customer, product, unit, price and total snapshots written when it was posted, and the current dispatch
 * details. Nothing is taken from the current customer or product records or from the shop and salesman in Settings
 * (except the shop name of an invoice posted before it was kept), and printing writes nothing.
 *
 * The renderer shows the print preview; the main process prints that preview (the system print dialog) or saves it
 * as a PDF (its own Save dialog). No call takes a printer, a file name or a path.
 */

export { PAPER_SIZES, type PaperSize }

/** The print preview route of an invoice: the only screen the main process prints. */
export function invoicePrintPath(invoiceId: number): string {
  return `/invoices/${invoiceId}/print`
}

/** `window.api.invoices.print(...)` and `.savePdf(...)`: the invoice shown in the print preview, on this paper. */
export const InvoicePrintInputSchema = z.strictObject({
  id: IdSchema,
  paperSize: z.enum(PAPER_SIZES, { error: 'Choose A4 or A5.' })
})
export type InvoicePrintInput = z.output<typeof InvoicePrintInputSchema>

/** A quantity row as saved: the unit's names and size, the quantity and the price actually charged. */
export interface PrintableInvoiceQuantity {
  readonly unitName: string
  readonly unitShortName: string | null
  readonly unitBaseQty: number
  readonly quantity: number
  readonly unitPriceMinor: number
  readonly amountMinor: number
}

/** A line as saved. */
export interface PrintableInvoiceLine {
  readonly lineNo: number
  readonly productName: string
  /** Printed verbatim. */
  readonly packingLabel: string | null
  readonly quantities: readonly PrintableInvoiceQuantity[]
  /** Free scheme goods, in base units: they are saved without a unit. */
  readonly schemeQtyBase: number
  readonly grossMinor: number
  /** The percentage entered, in basis points; null for a fixed amount. */
  readonly discountBps: number | null
  readonly discountMinor: number
  /** Sch as money. */
  readonly schemeMinor: number
  /** The Ctn entered; null when none was. */
  readonly ctnCount: number | null
  readonly netMinor: number
}

/** Everything the printed invoice shows, and nothing else (no costs, ids of other records or change log). */
export interface PrintableInvoice {
  readonly id: number
  readonly invoiceNo: string
  readonly invoiceCode: string | null
  readonly invoiceDate: string
  readonly status: InvoiceStatus
  readonly voidDate: string | null
  readonly voidReason: string | null
  /**
   * The shop name saved with the invoice. An invoice posted before shop names were kept prints the current one, as it
   * always did.
   */
  readonly businessName: string
  /** The shop address saved with the invoice; null when none was saved. */
  readonly businessAddress: string | null
  /** The salesman saved with the invoice; null for an invoice posted before the salesman was kept. */
  readonly salesman: {
    readonly name: string
    readonly phone1: string | null
    readonly phone2: string | null
  } | null
  /** Current settings: presentation only. */
  readonly currency: {
    readonly code: string
    readonly symbol: string
    readonly minorDigits: number
  }
  /** The configured paper size: the preview's default. */
  readonly paperSize: PaperSize
  /** The customer's details as saved on the invoice. */
  readonly customer: {
    readonly name: string
    readonly shopName: string | null
    readonly phone: string | null
    readonly address: string | null
    readonly city: string | null
  }
  /** The dispatch details as they are now (they may have changed after posting). */
  readonly dispatch: {
    readonly biltyNo: string | null
    readonly transportName: string | null
    readonly addaName: string | null
  }
  readonly checkedBy: string | null
  readonly lines: readonly PrintableInvoiceLine[]
  /** The stored totals. Received is the amount saved with the invoice, whatever became of its payment since. */
  readonly totals: {
    readonly grossMinor: number
    readonly lineDiscountMinor: number
    readonly lineSchemeMinor: number
    readonly extraDiscountMinor: number
    /** "Current Invoice". */
    readonly netMinor: number
    readonly freightMinor: number
    readonly totalMinor: number
    readonly previousBalanceMinor: number
    readonly receivedMinor: number
    readonly netOutstandingMinor: number
  }
  /** The invoice total in words, generated for printing (never stored). */
  readonly amountInWords: string
  /** The name the Save as PDF dialog suggests. */
  readonly pdfFileName: string
}

export type InvoicePrintResult = { readonly status: 'SENT' } | { readonly status: 'CANCELLED' }

export type InvoicePdfResult =
  | {
      readonly status: 'SAVED'
      readonly fileName: string
      /** The folder, for display: AppData and the user's profile are shown as %APPDATA% and %USERPROFILE%. */
      readonly location: string
    }
  | { readonly status: 'CANCELLED' }

const RUPEES = { singular: 'Rupees', plural: 'Rupees' }
const PAISA = { singular: 'Paisa', plural: 'Paisa' }

/**
 * The invoice total in words. PKR: "Rupees Twelve Thousand Five Hundred and Paisa Fifty Only", in lakh and crore.
 * Another currency: its code, international numbering and the minor part as a fraction ("USD Twelve Thousand and
 * 50/100 Only"), since its unit names are not known.
 */
export function invoiceAmountInWords(
  totalMinor: number,
  currency: { readonly code: string; readonly minorDigits: number }
): string {
  if (currency.code === 'PKR') {
    return amountInWords(totalMinor, {
      minorDigits: currency.minorDigits,
      numbering: 'south-asian',
      majorUnit: RUPEES,
      minorUnit: PAISA,
      labelPosition: 'before'
    })
  }
  const scale = 10 ** currency.minorDigits
  const minor = totalMinor % scale
  const major = integerToWords((totalMinor - minor) / scale, 'international')
  const fraction =
    minor === 0 ? '' : ` and ${String(minor).padStart(currency.minorDigits, '0')}/${scale}`
  return `${currency.code} ${major}${fraction} Only`
}

/** Characters Windows refuses in a file name, and control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILE_NAME = /[<>:"/\\|?*\x00-\x1f]/g

/** "INV-000123.pdf": the invoice number, made safe as a Windows file name. */
export function invoicePdfFileName(invoiceNo: string): string {
  const name = invoiceNo
    .replace(UNSAFE_FILE_NAME, '-')
    .trim()
    .replace(/[. ]+$/, '')
  return `${name === '' ? 'Invoice' : name}.pdf`
}
