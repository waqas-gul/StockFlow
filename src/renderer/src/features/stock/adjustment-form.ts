import { z } from 'zod'
import { isCalendarDate } from '@shared/dates'
import { formatMoney, parseMoney } from '@shared/domain'
import {
  ADJUSTMENT_REASONS,
  MAX_STOCK_QUANTITY,
  REASON_NOTE_MAX,
  adjustmentIssues,
  type AdjustmentReason,
  type AdjustmentShape,
  type StockAdjustmentInput,
  type StockReceiptLine
} from '@shared/stock'
import { requiredText } from '@shared/validation'
import { moneyMessage } from '@renderer/lib/form-text'

/*
 * The stock adjustment form. Which fields it shows depends on the reason; the operator never enters signs or values
 * for OUT movements (the main process values them at the current average cost). The same shared rules
 * (adjustmentIssues) decide which fields are required here and in the main process.
 */

export interface AdjustmentFormValues {
  adjustmentDate: string
  reason: AdjustmentReason | ''
  /** The product; for receipt corrections it is the chosen receipt line's product. */
  productId: number | null
  productLabel: string
  /** Receipt corrections: the chosen receipt and line. */
  receiptId: number | null
  receiptItemId: string
  direction: '' | 'IN' | 'OUT'
  unitId: string
  quantity: string
  unitCost: string
  reasonNote: string
}

export type AdjustmentDraft = Omit<StockAdjustmentInput, 'requestId' | 'currencyMinorDigits'>

export function emptyAdjustmentForm(today: string): AdjustmentFormValues {
  return {
    adjustmentDate: today,
    reason: '',
    productId: null,
    productLabel: '',
    receiptId: null,
    receiptItemId: '',
    direction: '',
    unitId: '',
    quantity: '',
    unitCost: '',
    reasonNote: ''
  }
}

/** The reasons in the order the form offers them. */
export const REASON_CHOICES: readonly AdjustmentReason[] = [
  'OPENING_STOCK',
  'DAMAGE',
  'EXPIRY',
  'SHORTAGE',
  'COUNT_SURPLUS',
  'RECEIPT_QTY_CORRECTION',
  'RECEIPT_COST_CORRECTION',
  'OTHER_CORRECTION'
]

export interface AdjustmentFieldSet {
  /** Pick a receipt and one of its lines (the product comes from the line). */
  readonly receipt: boolean
  /** Pick the product directly. */
  readonly product: boolean
  /** Choose Add stock / Remove stock. */
  readonly direction: boolean
  /** Unit and quantity. */
  readonly quantity: boolean
  readonly cost: boolean
  readonly costLabel: string
  /** How the stock is valued when the operator enters no cost. */
  readonly valuationNote: string | null
}

/**
 * The fields shown for a reason and direction. `hasStock` is whether the product currently has stock (null while
 * unknown): a count surplus asks for a cost only when there is none.
 */
export function adjustmentFieldSet(
  reason: AdjustmentReason | '',
  direction: '' | 'IN' | 'OUT',
  hasStock: boolean | null
): AdjustmentFieldSet {
  const none: AdjustmentFieldSet = {
    receipt: false,
    product: false,
    direction: false,
    quantity: false,
    cost: false,
    costLabel: 'Unit cost',
    valuationNote: null
  }
  const average = 'Valued at the current average cost.'
  switch (reason) {
    case '':
      return none
    case 'OPENING_STOCK':
      return { ...none, product: true, quantity: true, cost: true }
    case 'DAMAGE':
    case 'EXPIRY':
    case 'SHORTAGE':
      return { ...none, product: true, quantity: true, valuationNote: average }
    case 'COUNT_SURPLUS':
      return hasStock === false
        ? {
            ...none,
            product: true,
            quantity: true,
            cost: true,
            valuationNote: 'This product has no stock, so enter the cost of the surplus.'
          }
        : { ...none, product: true, quantity: true, valuationNote: average }
    case 'RECEIPT_QTY_CORRECTION':
      return {
        ...none,
        receipt: true,
        direction: true,
        quantity: true,
        valuationNote:
          direction === 'IN'
            ? "Added at the receipt line's cost."
            : direction === 'OUT'
              ? 'Removed at the current average cost.'
              : null
      }
    case 'RECEIPT_COST_CORRECTION':
      return { ...none, receipt: true, cost: true, costLabel: 'Correct unit cost' }
    case 'OTHER_CORRECTION':
      return {
        ...none,
        product: true,
        direction: true,
        quantity: true,
        cost: direction === 'IN',
        valuationNote: direction === 'OUT' ? 'Removed at the current average cost.' : null
      }
  }
}

const FORM_FIELD: Readonly<Record<keyof AdjustmentShape, keyof AdjustmentFormValues>> = {
  reason: 'reason',
  direction: 'direction',
  unitId: 'unitId',
  quantity: 'quantity',
  unitCostMinor: 'unitCost',
  receiptItemId: 'receiptItemId'
}

export function adjustmentFormSchema(
  minorDigits: number
): z.ZodType<AdjustmentDraft, AdjustmentFormValues> {
  return z
    .object({
      adjustmentDate: z.string().refine(isCalendarDate, 'Enter a valid date.'),
      reason: z
        .enum(['', ...ADJUSTMENT_REASONS])
        .refine((reason) => reason !== '', 'Choose a reason.'),
      productId: z.number().nullable(),
      productLabel: z.string(),
      receiptId: z.number().nullable(),
      receiptItemId: z.string(),
      direction: z.enum(['', 'IN', 'OUT']),
      unitId: z.string(),
      quantity: z.string(),
      unitCost: z.string(),
      reasonNote: requiredText('reason note', REASON_NOTE_MAX)
    })
    .transform((values, ctx): AdjustmentDraft => {
      const reported = new Set<string>()
      const issue = (path: keyof AdjustmentFormValues, message: string): void => {
        reported.add(path)
        ctx.addIssue({ code: 'custom', path: [path], message })
      }
      const reason = values.reason as AdjustmentReason
      // The cost field of a count surplus is offered when the product has no stock; the main process decides.
      const fields = adjustmentFieldSet(
        reason,
        values.direction,
        reason === 'COUNT_SURPLUS' ? false : null
      )
      if (fields.receipt && values.receiptId === null) issue('receiptId', 'Choose the receipt.')
      if (fields.product && values.productId === null) issue('productId', 'Choose a product.')

      let quantity: number | null = null
      if (fields.quantity && values.quantity.trim() !== '') {
        const digits = values.quantity.trim().replaceAll(',', '')
        const value = /^\d{1,7}$/.test(digits) ? Number(digits) : Number.NaN
        if (value >= 1 && value <= MAX_STOCK_QUANTITY) quantity = value
        else {
          issue(
            'quantity',
            `Enter a whole number from 1 to ${MAX_STOCK_QUANTITY.toLocaleString('en-US')}.`
          )
        }
      }
      let unitCostMinor: number | null = null
      if (fields.cost && values.unitCost.trim() !== '') {
        const parsed = parseMoney(values.unitCost, { minorDigits })
        if (parsed.ok) unitCostMinor = parsed.value
        else issue('unitCost', moneyMessage(parsed.error, minorDigits))
      }

      const shape: AdjustmentShape = {
        reason,
        direction: fields.direction && values.direction !== '' ? values.direction : null,
        unitId: fields.quantity && values.unitId !== '' ? Number(values.unitId) : null,
        quantity,
        unitCostMinor,
        receiptItemId:
          fields.receipt && values.receiptItemId !== '' ? Number(values.receiptItemId) : null
      }
      for (const [field, message] of adjustmentIssues(shape)) {
        const target = FORM_FIELD[field]
        // A quantity or cost that was typed but unreadable already has its own message.
        if (!reported.has(target)) issue(target, message)
      }
      return {
        adjustmentDate: values.adjustmentDate,
        productId: values.productId ?? 0,
        ...shape,
        reasonNote: values.reasonNote
      }
    })
}

export function toAdjustmentInput(
  draft: AdjustmentDraft,
  requestId: string,
  minorDigits: number
): StockAdjustmentInput {
  return { requestId, ...draft, currencyMinorDigits: minorDigits }
}

/** The form after a receipt line is chosen: its product, and its unit for a quantity correction. */
export function withReceiptLine(
  values: AdjustmentFormValues,
  line: StockReceiptLine | undefined
): AdjustmentFormValues {
  if (line === undefined) {
    return { ...values, receiptItemId: '', productId: null, productLabel: '', unitId: '' }
  }
  return {
    ...values,
    receiptItemId: String(line.id),
    productId: line.productId,
    productLabel: `${line.productCode} ${line.productName}`,
    unitId: String(line.unitId)
  }
}

/** "Line 2 · P-001 Tea 950g · 5 Piece @ Rs 110.00". */
export function receiptLineLabel(line: StockReceiptLine, costText: string): string {
  return `Line ${line.lineNo} · ${line.productCode} ${line.productName} · ${line.quantity.toLocaleString('en-US')} ${line.unitName} @ ${costText}`
}

/** The unit cost a receipt line is recorded at now (after cost corrections), as form text. */
export function recordedUnitCostText(line: StockReceiptLine, minorDigits: number): string {
  const unitCost = Math.round(line.correctedLineCostMinor / line.quantity)
  return formatMoney(unitCost, { minorDigits, grouping: 'none' })
}

const FORM_FIELDS = new Set<string>([
  'adjustmentDate',
  'productId',
  'direction',
  'unitId',
  'quantity',
  'receiptItemId',
  'reasonNote'
])

/** The main process's field errors as [form path, message] pairs. */
export function serverAdjustmentErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const [path, messages] of Object.entries(fieldErrors ?? {})) {
    const target = path === 'unitCostMinor' ? 'unitCost' : FORM_FIELDS.has(path) ? path : 'root'
    for (const message of messages) pairs.push([target, message])
  }
  return pairs
}
