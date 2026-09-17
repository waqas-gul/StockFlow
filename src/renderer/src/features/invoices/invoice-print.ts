import { formatMoney } from '@shared/domain'
import type {
  InvoicePdfResult,
  InvoicePrintInput,
  InvoicePrintResult,
  PaperSize,
  PrintableInvoiceLine,
  PrintableInvoiceQuantity
} from '@shared/invoice-print'
import type { Result } from '@shared/types/result'
import { savedQuantityText, type InvoiceNotifier } from './invoice-history'

/*
 * The printed invoice (Phase 9B): how its saved values are written on paper, the page rule of each paper size, and the
 * Print and Save as PDF calls with their messages. Everything printed comes from the printable invoice the main process
 * read; nothing is recalculated.
 */

/** Page margins, top, sides and bottom; the preview sheet uses the same values as padding (invoice-print.css). */
export const PAPER_MARGINS: Readonly<Record<PaperSize, string>> = Object.freeze({
  A4: '12mm 12mm 14mm',
  A5: '8mm 8mm 10mm'
})

interface PrintCurrency {
  readonly minorDigits: number
}

/** An amount on the printed invoice: grouped digits and the currency decimal places, no symbol ("5,700.00"). */
export function printMoney(minor: number, currency: PrintCurrency): string {
  return formatMoney(minor, { minorDigits: currency.minorDigits })
}

/** A balance: what the customer owes as a plain amount, an advance as "250.50 Advance". */
export function printBalance(minor: number, currency: PrintCurrency): string {
  return minor < 0 ? `${printMoney(-minor, currency)} Advance` : printMoney(minor, currency)
}

/** A unit as printed: its saved short name, or its saved name. */
export function printUnitLabel(
  unit: Pick<PrintableInvoiceQuantity, 'unitName' | 'unitShortName'>
): string {
  return unit.unitShortName ?? unit.unitName
}

export interface PrintQuantityRow {
  readonly quantity: string
  readonly price: string
}

/** Each saved quantity row of a line with the price actually charged for it ("2 Box" at "2,400.00"). */
export function printQuantityRows(
  line: PrintableInvoiceLine,
  currency: PrintCurrency
): PrintQuantityRow[] {
  return line.quantities.map((row) => ({
    quantity: `${row.quantity.toLocaleString('en-US')} ${printUnitLabel(row)}`,
    price: printMoney(row.unitPriceMinor, currency)
  }))
}

/** The free scheme goods of a line in its saved units ("3 Pc"), or null when there are none. */
export function freeQuantityText(line: PrintableInvoiceLine): string | null {
  if (line.schemeQtyBase === 0) return null
  return savedQuantityText(line.schemeQtyBase, line.quantities, printUnitLabel)
}

/** A line discount: its amount, and the percentage when one was entered. Null without a discount. */
export function lineDiscount(
  line: PrintableInvoiceLine,
  currency: PrintCurrency
): { readonly amount: string; readonly percent: string | null } | null {
  if (line.discountMinor === 0) return null
  const percent =
    line.discountBps === null
      ? null
      : `${(line.discountBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
  return { amount: printMoney(line.discountMinor, currency), percent }
}

/** The optional item columns that at least one line fills: an empty column is left out. */
export function printColumns(lines: readonly PrintableInvoiceLine[]): {
  readonly discount: boolean
  readonly ctn: boolean
  readonly scheme: boolean
} {
  return {
    discount: lines.some((line) => line.discountMinor > 0),
    ctn: lines.some((line) => line.ctnCount !== null),
    scheme: lines.some((line) => line.schemeMinor > 0 || line.schemeQtyBase > 0)
  }
}

/** Text as a CSS string literal. */
function cssString(text: string): string {
  return `"${text.replace(/["\\<\n\r]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `)}"`
}

/**
 * The @page rule of the printed invoice: the paper, its margins, and a footer on every page with the invoice number
 * and "Page n of N".
 */
export function invoicePageCss(paperSize: PaperSize, invoiceNo: string): string {
  const footer = "font: 7pt 'Segoe UI', Arial, sans-serif; color: #000;"
  return `@page {
  size: ${paperSize} portrait;
  margin: ${PAPER_MARGINS[paperSize]};
  @bottom-left { content: ${cssString(invoiceNo)}; ${footer} }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); ${footer} }
}`
}

/** Prints the invoice shown in the print preview. Null when it was refused or failed (the message is shown). */
export async function submitInvoicePrint(
  api: { print(input: InvoicePrintInput): Promise<Result<InvoicePrintResult>> },
  input: InvoicePrintInput,
  invoiceNo: string,
  notify: InvoiceNotifier
): Promise<InvoicePrintResult['status'] | null> {
  let result: Result<InvoicePrintResult>
  try {
    result = await api.print(input)
  } catch {
    notify.error('The invoice could not be printed. Try again.')
    return null
  }
  if (!result.ok) {
    notify.error(result.error.message)
    return null
  }
  if (result.data.status === 'SENT') notify.success(`${invoiceNo} was sent to the printer.`)
  return result.data.status
}

/** Saves the invoice shown in the print preview as a PDF. Null when it was refused or failed (the message is shown). */
export async function submitInvoicePdf(
  api: { savePdf(input: InvoicePrintInput): Promise<Result<InvoicePdfResult>> },
  input: InvoicePrintInput,
  notify: InvoiceNotifier
): Promise<InvoicePdfResult['status'] | null> {
  let result: Result<InvoicePdfResult>
  try {
    result = await api.savePdf(input)
  } catch {
    notify.error('The PDF could not be saved. Try again.')
    return null
  }
  if (!result.ok) {
    notify.error(result.error.message)
    return null
  }
  if (result.data.status === 'SAVED') {
    notify.success(`Saved ${result.data.fileName} in ${result.data.location}.`)
  }
  return result.data.status
}
