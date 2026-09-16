import { isCalendarDate } from '@shared/dates'
import { parseMoney, parsePercentToBps } from '@shared/domain'
import {
  calculateInvoiceTotals,
  type InvoiceTotals,
  type InvoiceTotalsLineInput,
  type LineDiscount
} from '@shared/invoice-totals'
import {
  MAX_CTN_COUNT,
  MAX_SALE_QUANTITY,
  PRICE_TIER_LABELS,
  type InvoiceCreateInput
} from '@shared/invoices'
import type { ProductUnit } from '@shared/products'
import { moneyMessage } from '@renderer/lib/form-text'
import { stockText } from '../products/product-display'
import { configuredPrice, isCustomPrice, type InvoiceDraft, type LineDraft } from './invoice-draft'

/*
 * Everything the New Invoice screen derives from the draft: parsed rows, line and invoice totals from the shared Phase
 * 8A calculator (a preview: the main process recalculates from the database), stock warnings, the problems to fix
 * (keyed by draft path, e.g. `lines.0.quantities.1.price`) and, once there are none, the exact posting request.
 */

export interface RowSummary {
  readonly unit: ProductUnit | null
  readonly quantity: number | null
  /** The unit's price for the tier; null when it has none. */
  readonly configuredPriceMinor: number | null
  readonly priceMinor: number | null
  /** A typed price that is not the configured one: sent as an explicit override. */
  readonly custom: boolean
  /** The unit has no price for the tier and none is typed yet. */
  readonly missingPrice: boolean
  readonly amountMinor: number | null
}

export interface LineSummary {
  readonly rows: readonly RowSummary[]
  /** Base units, never shown as such: requestedText and stockText are in the product's units. */
  readonly paidQtyBase: number
  readonly schemeQtyBase: number
  readonly requestedQtyBase: number
  /** '2 Box + 5 Piece'. */
  readonly requestedText: string
  readonly stockText: string
  readonly overStock: boolean
  /** Null while the line cannot be calculated (e.g. a discount larger than the line). */
  readonly grossMinor: number | null
  readonly discountMinor: number | null
  readonly schemeMinor: number | null
  readonly netMinor: number | null
}

export interface InvoiceSummary {
  readonly lines: readonly LineSummary[]
  /** Null while a line or the invoice cannot be calculated. */
  readonly totals: InvoiceTotals | null
  readonly walkIn: boolean
  /** Problems to fix before posting, by draft path. */
  readonly issues: Readonly<Record<string, string>>
  /** A line needs more stock than there is: posting is disabled. */
  readonly stockBlocked: boolean
  /** The posting request (without surprises: it is what the preview shows); null while there are problems. */
  readonly input: InvoiceCreateInput | null
}

const QUANTITY_MESSAGE = `Enter a quantity from 1 to ${MAX_SALE_QUANTITY.toLocaleString('en-US')}.`
const CTN_MESSAGE = `Enter a whole number from 0 to ${MAX_CTN_COUNT.toLocaleString('en-US')}.`
const PERCENT_MESSAGE = 'Enter a percentage from 0 to 100, such as 5 or 2.5.'

export function summarizeInvoice(
  draft: InvoiceDraft,
  options: { readonly balanceMinor: number }
): InvoiceSummary {
  const digits = draft.minorDigits
  const issues: Record<string, string> = {}
  const walkIn = draft.customer?.walkIn ?? false

  if (draft.customer === null) issues.customer = 'Choose the customer, or Cash Sale.'
  if (!isCalendarDate(draft.invoiceDate)) issues.invoiceDate = 'Enter a valid date.'
  if (draft.lines.length === 0) issues.lines = 'Add at least one product.'

  const money = (text: string, path: string): number => {
    if (text.trim() === '') return 0
    const parsed = parseMoney(text, { minorDigits: digits })
    if (parsed.ok) return parsed.value
    issues[path] = moneyMessage(parsed.error, digits)
    return 0
  }

  const parsedLines = draft.lines.map((line, index) => parseLine(draft, line, index, issues))
  const lines = parsedLines.map((parsed, index): LineSummary => {
    const line = draft.lines[index]
    const result = calculateInvoiceTotals({
      lines: [parsed.calculation],
      extraDiscountMinor: 0,
      freightMinor: 0,
      receivedMinor: 0,
      previousBalanceMinor: 0
    })
    if (!result.ok) {
      for (const issue of result.issues) issues[lineIssuePath(issue.path, index)] = issue.message
    }
    const totals = result.ok ? result.totals.lines[0] : null
    const requestedQtyBase = parsed.paidQtyBase + parsed.schemeQtyBase
    const overStock = requestedQtyBase > line.product.stockQtyBase
    // In the units the product is sold in (and its base unit), never as a raw base count.
    const inUnits = (qtyBase: number): string =>
      stockText({
        stockQtyBase: qtyBase,
        units: line.product.units.filter((unit) => unit.isBase || (unit.isActive && unit.canSell))
      })
    if (overStock) {
      issues[`lines.${index}.stock`] =
        `Only ${inUnits(Math.max(line.product.stockQtyBase, 0))} in stock; this line needs ${inUnits(requestedQtyBase)}.`
    }
    return {
      rows: parsed.rows,
      paidQtyBase: parsed.paidQtyBase,
      schemeQtyBase: parsed.schemeQtyBase,
      requestedQtyBase,
      requestedText: inUnits(requestedQtyBase),
      stockText: inUnits(line.product.stockQtyBase),
      overStock,
      grossMinor: totals?.grossMinor ?? null,
      discountMinor: totals?.discountMinor ?? null,
      schemeMinor: totals?.schemeMinor ?? null,
      netMinor: totals?.netMinor ?? null
    }
  })

  const extraDiscountMinor = money(draft.extraDiscount, 'extraDiscount')
  const freightMinor = money(draft.freight, 'freight')
  const typedReceived = walkIn ? 0 : money(draft.received, 'received')

  let totals: InvoiceTotals | null = null
  if (lines.every((line) => line.netMinor !== null)) {
    const calculate = (receivedMinor: number): ReturnType<typeof calculateInvoiceTotals> =>
      calculateInvoiceTotals({
        lines: parsedLines.map((parsed) => parsed.calculation),
        extraDiscountMinor,
        freightMinor,
        receivedMinor,
        previousBalanceMinor: options.balanceMinor
      })
    let result = calculate(typedReceived)
    // A cash sale receives exactly the total.
    if (walkIn && result.ok) result = calculate(result.totals.totalMinor)
    if (result.ok) {
      totals = result.totals
    } else {
      for (const issue of result.issues) {
        issues[issue.path === 'extraDiscountMinor' ? 'extraDiscount' : 'totals'] = issue.message
      }
    }
  }

  const stockBlocked = lines.some((line) => line.overStock)
  const input =
    Object.keys(issues).length === 0 && totals !== null && draft.customer !== null
      ? toInput(draft, draft.customer.id, parsedLines, totals)
      : null
  return { lines, totals, walkIn, issues, stockBlocked, input }
}

interface ParsedLine {
  readonly rows: readonly RowSummary[]
  readonly paidQtyBase: number
  readonly schemeQtyBase: number
  /** The line with unreadable numbers counted as zero, for the live preview. */
  readonly calculation: InvoiceTotalsLineInput
  readonly request: InvoiceCreateInput['lines'][number]
}

function parseLine(
  draft: InvoiceDraft,
  line: LineDraft,
  index: number,
  issues: Record<string, string>
): ParsedLine {
  const digits = draft.minorDigits
  const tier = PRICE_TIER_LABELS[draft.priceTier].toLowerCase()
  const unitOf = (unitId: number | null): ProductUnit | null =>
    line.product.units.find((unit) => unit.id === unitId) ?? null

  const rows = line.quantities.map((row, rowIndex): RowSummary => {
    const path = `lines.${index}.quantities.${rowIndex}`
    const unit = unitOf(row.unitId)
    if (unit === null) issues[`${path}.unitId`] = 'Choose the unit.'
    const quantity = parseQuantity(row.quantity)
    if (quantity === null) issues[`${path}.quantity`] = QUANTITY_MESSAGE
    const configured = unit === null ? null : configuredPrice(unit, draft.priceTier)
    const parsed = parseMoney(row.price, { minorDigits: digits })
    let priceMinor: number | null = null
    if (parsed.ok) {
      priceMinor = parsed.value
    } else if (parsed.error === 'EMPTY') {
      issues[`${path}.price`] =
        unit !== null && configured === null
          ? `${unit.name} has no ${tier} price. Enter a custom price.`
          : 'Enter the unit price.'
    } else {
      issues[`${path}.price`] = moneyMessage(parsed.error, digits)
    }
    const amount =
      quantity === null || priceMinor === null ? null : BigInt(quantity) * BigInt(priceMinor)
    return {
      unit,
      quantity,
      configuredPriceMinor: configured,
      priceMinor,
      custom: isCustomPrice(row, line.product, draft.priceTier, digits),
      missingPrice: unit !== null && configured === null && priceMinor === null,
      amountMinor:
        amount === null || amount > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(amount)
    }
  })

  const freeRows = line.freeQuantities.map((row, rowIndex) => {
    const path = `lines.${index}.freeQuantities.${rowIndex}`
    const unit = unitOf(row.unitId)
    if (unit === null) issues[`${path}.unitId`] = 'Choose the unit.'
    const quantity = parseQuantity(row.quantity)
    if (quantity === null) issues[`${path}.quantity`] = QUANTITY_MESSAGE
    return { unit, quantity }
  })

  let discount: LineDiscount | null = null
  if (line.discountKind !== 'NONE' && line.discount.trim() !== '') {
    if (line.discountKind === 'PERCENT') {
      const parsed = parsePercentToBps(line.discount)
      if (parsed.ok) discount = { type: 'PERCENT', bps: parsed.value }
      else issues[`lines.${index}.discount`] = PERCENT_MESSAGE
    } else {
      const parsed = parseMoney(line.discount, { minorDigits: digits })
      if (parsed.ok) discount = { type: 'AMOUNT', amountMinor: parsed.value }
      else issues[`lines.${index}.discount`] = moneyMessage(parsed.error, digits)
    }
  }

  let schemeMinor = 0
  if (line.scheme.trim() !== '') {
    const parsed = parseMoney(line.scheme, { minorDigits: digits })
    if (parsed.ok) schemeMinor = parsed.value
    else issues[`lines.${index}.scheme`] = moneyMessage(parsed.error, digits)
  }

  let ctnCount: number | null = null
  if (line.ctn.trim() !== '') {
    const digitsOnly = line.ctn.trim().replaceAll(',', '')
    const value = /^\d{1,7}$/.test(digitsOnly) ? Number(digitsOnly) : Number.NaN
    if (value >= 0 && value <= MAX_CTN_COUNT) ctnCount = value
    else issues[`lines.${index}.ctn`] = CTN_MESSAGE
  }

  const known = <T extends { readonly unit: ProductUnit | null }>(
    list: readonly T[]
  ): Array<T & { readonly unit: ProductUnit }> =>
    list.filter((row): row is T & { readonly unit: ProductUnit } => row.unit !== null)
  const baseOf = (list: readonly { unit: ProductUnit | null; quantity: number | null }[]): number =>
    known(list).reduce((total, row) => total + (row.quantity ?? 0) * row.unit.baseQty, 0)

  return {
    rows,
    paidQtyBase: baseOf(rows),
    schemeQtyBase: baseOf(freeRows),
    calculation: {
      quantities: known(rows).map((row) => ({
        quantity: row.quantity ?? 0,
        unitBaseQty: row.unit.baseQty,
        unitPriceMinor: row.priceMinor ?? 0
      })),
      freeQuantities: known(freeRows).map((row) => ({
        quantity: row.quantity ?? 0,
        unitBaseQty: row.unit.baseQty
      })),
      discount,
      schemeMinor
    },
    request: {
      productId: line.product.id,
      quantities: known(rows).map((row) => ({
        unitId: row.unit.id,
        quantity: row.quantity ?? 0,
        unitPriceMinor: row.priceMinor ?? 0,
        priceOverride: row.custom
      })),
      freeQuantities: known(freeRows).map((row) => ({
        unitId: row.unit.id,
        quantity: row.quantity ?? 0
      })),
      discount,
      schemeMinor,
      ctnCount
    }
  }
}

function toInput(
  draft: InvoiceDraft,
  customerId: number,
  lines: readonly ParsedLine[],
  totals: InvoiceTotals
): InvoiceCreateInput {
  const text = (value: string): string | null => (value.trim() === '' ? null : value.trim())
  const received = totals.receivedMinor > 0
  return {
    requestId: draft.requestId,
    invoiceDate: draft.invoiceDate,
    customerId,
    priceTier: draft.priceTier,
    invoiceCode: text(draft.invoiceCode),
    biltyNo: text(draft.biltyNo),
    transportName: text(draft.transportName),
    addaName: text(draft.addaName),
    checkedBy: text(draft.checkedBy),
    notes: text(draft.notes),
    lines: lines.map((line) => line.request),
    extraDiscountMinor: totals.extraDiscountMinor,
    freightMinor: totals.freightMinor,
    receivedMinor: totals.receivedMinor,
    paymentMethod: received ? draft.paymentMethod : null,
    paymentReference: received ? text(draft.paymentReference) : null,
    currencyMinorDigits: draft.minorDigits
  }
}

/** Where a calculator issue of a line (calculated alone, as line 0) belongs in the draft. */
function lineIssuePath(path: string, index: number): string {
  if (path === 'lines.0.discount') return `lines.${index}.discount`
  if (path === 'lines.0.schemeMinor') return `lines.${index}.scheme`
  return `lines.${index}.amounts`
}

/** A whole quantity from 1 to the maximum, or null. */
function parseQuantity(text: string): number | null {
  const digits = text.trim().replaceAll(',', '')
  if (!/^\d{1,7}$/.test(digits)) return null
  const value = Number(digits)
  return value >= 1 && value <= MAX_SALE_QUANTITY ? value : null
}
