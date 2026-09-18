import { z } from 'zod'
import { isCalendarDate } from '@shared/dates'
import { formatMoney, parseMoney } from '@shared/domain'
import { PAYMENT_METHODS, type PaymentMethod } from '@shared/payments'
import type { ProductUnit } from '@shared/products'
import {
  MAX_RECEIPT_LINES,
  MAX_STOCK_QUANTITY,
  NOTE_MAX,
  PAID_NOW_REFERENCE_MAX,
  REFERENCE_MAX,
  SUPPLIER_BILL_NO_MAX,
  type StockReceiptInput
} from '@shared/stock'
import {
  moneyText,
  optionalText,
  requiredMoneyText,
  wholeNumberText
} from '@renderer/lib/form-text'

/*
 * The Stock In receipt form. Quantities and costs are typed as text and parsed with the Phase 2 parsers; the base
 * quantity and line cost shown per line are previews, and the main process computes and checks them again.
 *
 * With a supplier account the receipt is a supplier purchase: its total is added to what the shop owes the supplier,
 * and "Paid Now" records a real supplier payment with it. Without one the receipt only adds stock.
 */

export interface ReceiptLineRow {
  rowKey: string
  /** The chosen product; null until one is picked. */
  productId: number | null
  /** "P-001 Tea 950g", shown in the picker. */
  productLabel: string
  /** A product unit id, or '' before one is chosen. */
  unitId: string
  quantity: string
  unitCost: string
}

export interface ReceiptFormValues {
  receiptDate: string
  /** The supplier account; null for stock received without one. */
  supplierId: number | null
  /** "SUP-00001 ABC Distributors", shown in the picker. */
  supplierLabel: string
  supplierBillNo: string
  reference: string
  note: string
  /** Blank or 0: nothing paid now. */
  paidNowAmount: string
  paidNowMethod: PaymentMethod
  paidNowReference: string
  lines: ReceiptLineRow[]
}

/** What the form produces: the receipt input without the request id and the currency check. */
export type ReceiptDraft = Omit<Required<StockReceiptInput>, 'requestId' | 'currencyMinorDigits'>

let rowCounter = 0

export function newReceiptLine(): ReceiptLineRow {
  rowCounter += 1
  return {
    rowKey: `line-${rowCounter}`,
    productId: null,
    productLabel: '',
    unitId: '',
    quantity: '',
    unitCost: ''
  }
}

export function emptyReceiptForm(
  today: string,
  supplier: { readonly id: number; readonly label: string } | null = null
): ReceiptFormValues {
  return {
    receiptDate: today,
    supplierId: supplier?.id ?? null,
    supplierLabel: supplier?.label ?? '',
    supplierBillNo: '',
    reference: '',
    note: '',
    paidNowAmount: '',
    paidNowMethod: 'CASH',
    paidNowReference: '',
    lines: [newReceiptLine()]
  }
}

/** The units a receipt line can use: active and purchasable, in display order. */
export function purchasableUnits(units: readonly ProductUnit[]): ProductUnit[] {
  return units.filter((unit) => unit.isActive && unit.canPurchase)
}

/**
 * A line after a product is picked: its first purchasable unit, with that unit's default cost when it has one.
 * The quantity typed so far is kept.
 */
export function withProduct(
  row: ReceiptLineRow,
  product: {
    readonly id: number
    readonly code: string
    readonly name: string
    readonly units: readonly ProductUnit[]
  },
  minorDigits: number
): ReceiptLineRow {
  const [unit] = purchasableUnits(product.units)
  return {
    ...row,
    productId: product.id,
    productLabel: `${product.code} ${product.name}`,
    unitId: unit === undefined ? '' : String(unit.id),
    unitCost: defaultCostText(unit, minorDigits)
  }
}

/** A line after its unit changes: the unit's default cost replaces the cost only when the cost is still blank. */
export function withUnit(
  row: ReceiptLineRow,
  unit: ProductUnit | undefined,
  minorDigits: number
): ReceiptLineRow {
  return {
    ...row,
    unitId: unit === undefined ? '' : String(unit.id),
    unitCost: row.unitCost.trim() === '' ? defaultCostText(unit, minorDigits) : row.unitCost
  }
}

function defaultCostText(unit: ProductUnit | undefined, minorDigits: number): string {
  return unit?.defaultCostMinor === null || unit === undefined
    ? ''
    : formatMoney(unit.defaultCostMinor, { minorDigits, grouping: 'none' })
}

export function receiptFormSchema(minorDigits: number): z.ZodType<ReceiptDraft, ReceiptFormValues> {
  const line = z.object({
    rowKey: z.string(),
    productId: z.number().nullable(),
    productLabel: z.string(),
    unitId: z.string(),
    quantity: wholeNumberText(1, MAX_STOCK_QUANTITY),
    unitCost: requiredMoneyText(minorDigits, 'Enter the unit cost (0 for free goods).')
  })
  return z
    .object({
      receiptDate: z.string().refine(isCalendarDate, 'Enter a valid date.'),
      supplierId: z.number().nullable(),
      supplierLabel: z.string(),
      supplierBillNo: optionalText(SUPPLIER_BILL_NO_MAX),
      reference: optionalText(REFERENCE_MAX),
      note: optionalText(NOTE_MAX),
      paidNowAmount: moneyText(minorDigits),
      paidNowMethod: z.enum(PAYMENT_METHODS, { error: 'Choose the payment method.' }),
      paidNowReference: optionalText(PAID_NOW_REFERENCE_MAX),
      lines: z
        .array(line)
        .min(1, 'Add at least one product line.')
        .max(MAX_RECEIPT_LINES, `Use at most ${MAX_RECEIPT_LINES} lines.`)
    })
    .transform((values, ctx): ReceiptDraft => {
      const paidNow = values.paidNowAmount ?? 0
      if (paidNow > 0 && values.supplierId === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['paidNowAmount'],
          message: 'Choose the supplier to record a payment with the receipt.'
        })
      }
      values.lines.forEach((row, index) => {
        if (row.productId === null) {
          ctx.addIssue({
            code: 'custom',
            path: ['lines', index, 'productId'],
            message: 'Choose a product.'
          })
        } else if (row.unitId === '') {
          ctx.addIssue({
            code: 'custom',
            path: ['lines', index, 'unitId'],
            message: 'Choose the unit.'
          })
        }
      })
      return {
        receiptDate: values.receiptDate,
        supplierId: values.supplierId,
        supplierName: null,
        supplierBillNo: values.supplierBillNo,
        reference: values.reference,
        note: values.note,
        paidNow:
          paidNow > 0
            ? {
                amountMinor: paidNow,
                method: values.paidNowMethod,
                reference: values.paidNowReference
              }
            : null,
        lines: values.lines.map((row) => ({
          productId: row.productId ?? 0,
          unitId: Number(row.unitId),
          quantity: row.quantity,
          unitCostMinor: row.unitCost
        }))
      }
    })
}

export function toReceiptInput(
  draft: ReceiptDraft,
  requestId: string,
  minorDigits: number
): StockReceiptInput {
  return { requestId, ...draft, currencyMinorDigits: minorDigits }
}

export interface LinePreview {
  /** Base units of the line; null while the quantity or unit is not usable yet. */
  readonly qtyBase: number | null
  /** Quantity × unit cost; null while either is not usable yet. */
  readonly lineCostMinor: number | null
}

/** The live base quantity and line cost of a line as typed so far. */
export function linePreview(
  row: Pick<ReceiptLineRow, 'unitId' | 'quantity' | 'unitCost'>,
  units: readonly ProductUnit[] | undefined,
  minorDigits: number
): LinePreview {
  const unit = units?.find((candidate) => String(candidate.id) === row.unitId)
  const digits = row.quantity.trim().replaceAll(',', '')
  const quantity = /^\d{1,7}$/.test(digits) ? Number(digits) : null
  const cost = parseMoney(row.unitCost, { minorDigits })
  const usableQuantity = quantity !== null && quantity >= 1 ? quantity : null
  const lineCost =
    usableQuantity !== null && cost.ok ? BigInt(cost.value) * BigInt(usableQuantity) : null
  return {
    qtyBase: unit === undefined || usableQuantity === null ? null : usableQuantity * unit.baseQty,
    lineCostMinor:
      lineCost === null || lineCost > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(lineCost)
  }
}

/** Σ of the known line costs; null when no line has one yet. */
export function receiptTotal(previews: readonly LinePreview[]): number | null {
  const known = previews.flatMap((preview) =>
    preview.lineCostMinor === null ? [] : [preview.lineCostMinor]
  )
  return known.length === 0 ? null : known.reduce((total, cost) => total + cost, 0)
}

/**
 * The supplier balance before and after the receipt, as typed so far: + the purchase total, − the amount paid now.
 * Null values while the total or the amount paid is not usable yet.
 */
export function projectedSupplierBalance(
  currentMinor: number,
  totalMinor: number | null,
  paidNowText: string,
  minorDigits: number
): { readonly paidNowMinor: number | null; readonly afterMinor: number | null } {
  let paidNowMinor: number | null = 0
  if (paidNowText.trim() !== '') {
    const parsed = parseMoney(paidNowText, { minorDigits })
    paidNowMinor = parsed.ok ? parsed.value : null
  }
  return {
    paidNowMinor,
    afterMinor:
      totalMinor === null || paidNowMinor === null ? null : currentMinor + totalMinor - paidNowMinor
  }
}

const HEADER_FIELDS = new Set(['receiptDate', 'supplierId', 'supplierBillNo', 'reference', 'note'])
const PAID_NOW_FIELDS: Readonly<Record<string, string>> = {
  paidNow: 'paidNowAmount',
  'paidNow.amountMinor': 'paidNowAmount',
  'paidNow.method': 'paidNowMethod',
  'paidNow.reference': 'paidNowReference',
  // A free-text name is never sent with a supplier account; any error about it is about the supplier.
  supplierName: 'supplierId'
}
const LINE_FIELDS: Readonly<Record<string, string>> = {
  productId: 'productId',
  unitId: 'unitId',
  quantity: 'quantity',
  unitCostMinor: 'unitCost'
}

/** The main process's field errors as [form path, message] pairs. */
export function serverReceiptErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const [path, messages] of Object.entries(fieldErrors ?? {})) {
    const line = /^lines\.(\d+)\.(\w+)$/.exec(path)
    const target = HEADER_FIELDS.has(path)
      ? path
      : PAID_NOW_FIELDS[path] !== undefined
        ? PAID_NOW_FIELDS[path]
        : path === 'lines'
          ? 'lines.root'
          : line !== null && LINE_FIELDS[line[2]] !== undefined
            ? `lines.${line[1]}.${LINE_FIELDS[line[2]]}`
            : 'root'
    for (const message of messages) pairs.push([target, message])
  }
  return pairs
}
