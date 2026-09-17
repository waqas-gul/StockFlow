import { z } from 'zod'
import { MAX_MINOR_DIGITS } from './domain/guards'
import type { ProductUnit } from './products'
import {
  DateSchema,
  IdSchema,
  RequestIdSchema,
  optionalText,
  requiredText,
  wholeNumber
} from './validation'

/*
 * Stock In, stock adjustments and the stock card (plan §8). Stock is never a stored number: a product's quantity Q is
 * Σ stock_movements.qty_base (base units) and its inventory value V is Σ stock_movements.value_minor. Every document
 * writes its movements in one transaction, which ends by checking Q ≥ 0, V ≥ 0 and Q = 0 ⇒ V = 0.
 *
 * The same schemas validate the forms (renderer) and every IPC request (main process).
 */

export const RECEIPT_NUMBER_PREFIX = 'GRN-'
export const ADJUSTMENT_NUMBER_PREFIX = 'ADJ-'
export const DOCUMENT_NUMBER_DIGITS = 6
export const MAX_RECEIPT_LINES = 100
/** Largest quantity of one line, in the unit it is entered in. */
export const MAX_STOCK_QUANTITY = 1_000_000
export const SUPPLIER_NAME_MAX = 80
export const REFERENCE_MAX = 60
export const NOTE_MAX = 300
export const REASON_NOTE_MAX = 300
export const MAX_STOCK_PAGE_SIZE = 100

/** The fixed adjustment reason codes of V1 (plan §8.6). Users cannot add their own. */
export const ADJUSTMENT_REASONS = [
  'OPENING_STOCK',
  'DAMAGE',
  'EXPIRY',
  'SHORTAGE',
  'COUNT_SURPLUS',
  'RECEIPT_QTY_CORRECTION',
  'RECEIPT_COST_CORRECTION',
  'OTHER_CORRECTION'
] as const
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]

/** IN adds stock, OUT removes it, VALUE changes only the inventory value (a receipt cost correction). */
export type AdjustmentDirection = 'IN' | 'OUT' | 'VALUE'

/**
 * How the Profit & Loss report (Phase 11) treats an adjustment (plan §8.6, §13): OPERATING_LOSS / OPERATING_GAIN count
 * in Net Operating Profit; INVENTORY_DATA_CORRECTION is shown below it, under Data Corrections, and counts in Profit After
 * Data Corrections; DISCLOSURE_ONLY is shown for information and counts in no profit figure; NONE is not P&L.
 *
 * A receipt cost correction is DISCLOSURE_ONLY: it changes the inventory value, so it reaches profit through the COGS of
 * later sales (historical COGS stays frozen). Counting it in the period's profit as well would count it twice.
 */
export type StockPnlTreatment =
  'NONE' | 'OPERATING_LOSS' | 'OPERATING_GAIN' | 'INVENTORY_DATA_CORRECTION' | 'DISCLOSURE_ONLY'

export interface AdjustmentReasonInfo {
  readonly label: string
  /** Plain-language help for the adjustment form. */
  readonly description: string
  readonly directions: readonly AdjustmentDirection[]
  readonly pnl: StockPnlTreatment
}

/** The one mapping of reason code → label, direction and P&L treatment, shared by the form and later reports. */
export const ADJUSTMENT_REASON_INFO: Readonly<Record<AdjustmentReason, AdjustmentReasonInfo>> =
  Object.freeze({
    OPENING_STOCK: {
      label: 'Opening Stock',
      description: 'Stock you already had when you started using StockFlow, at its cost.',
      directions: ['IN'],
      pnl: 'NONE'
    },
    DAMAGE: {
      label: 'Damage',
      description: 'Damaged goods removed from stock.',
      directions: ['OUT'],
      pnl: 'OPERATING_LOSS'
    },
    EXPIRY: {
      label: 'Expiry',
      description: 'Expired goods removed from stock.',
      directions: ['OUT'],
      pnl: 'OPERATING_LOSS'
    },
    SHORTAGE: {
      label: 'Shortage',
      description: 'A count found less stock than recorded (missing or lost goods).',
      directions: ['OUT'],
      pnl: 'OPERATING_LOSS'
    },
    COUNT_SURPLUS: {
      label: 'Count Surplus',
      description: 'A count found more stock than recorded.',
      directions: ['IN'],
      pnl: 'OPERATING_GAIN'
    },
    RECEIPT_QTY_CORRECTION: {
      label: 'Receipt Quantity Correction',
      description: 'A saved receipt recorded too much or too little of a product.',
      directions: ['IN', 'OUT'],
      pnl: 'INVENTORY_DATA_CORRECTION'
    },
    RECEIPT_COST_CORRECTION: {
      label: 'Receipt Cost Correction',
      description: 'A saved receipt recorded the wrong unit cost.',
      directions: ['VALUE'],
      pnl: 'DISCLOSURE_ONLY'
    },
    OTHER_CORRECTION: {
      label: 'Other Correction',
      description: 'A data-entry mistake that is not about a receipt.',
      directions: ['IN', 'OUT'],
      pnl: 'INVENTORY_DATA_CORRECTION'
    }
  })

/** Limitation L1 (plan §8.5): shown before and after a cost correction once other stock activity has followed. */
export const LATE_COST_CORRECTION_WARNING =
  'Some stock from this receipt has already been used or mixed with later stock. This correction will affect future inventory cost and future COGS; past COGS will not be recalculated.'

export const RECEIPT_LOCKED_MESSAGE =
  'This receipt is locked because later stock activity exists for its products. Correct it with a stock adjustment instead.'

export const STOCK_MOVEMENT_TYPES = [
  'OPENING',
  'STOCK_IN',
  'STOCK_IN_VOID',
  'SALE',
  'SALE_VOID',
  'SALE_RETURN',
  'ADJUST_IN',
  'ADJUST_OUT',
  'COST_CORRECTION'
] as const
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number]

/** An amount the user entered: integer minor units, zero or more. */
const CostSchema = z
  .number({ error: 'Enter the unit cost.' })
  .int('Enter a valid amount.')
  .min(0, 'The amount cannot be negative.')
  .max(Number.MAX_SAFE_INTEGER, 'The amount is too large.')

const CurrencyDigitsSchema = z.number().int().min(0).max(MAX_MINOR_DIGITS)

const PageSchema = wholeNumber(1, 1_000_000)
const PageSizeSchema = wholeNumber(1, MAX_STOCK_PAGE_SIZE)

export const StockReceiptLineInputSchema = z.strictObject({
  productId: IdSchema,
  /** An active unit of the product that can be purchased. */
  unitId: IdSchema,
  quantity: wholeNumber(1, MAX_STOCK_QUANTITY),
  /** Cost of one unit (the unit entered), in minor units; 0 for free goods. */
  unitCostMinor: CostSchema
})
export type StockReceiptLineInput = z.output<typeof StockReceiptLineInputSchema>

/** `window.api.stock.receive(...)`: one Stock In receipt. */
export const StockReceiptInputSchema = z.strictObject({
  requestId: RequestIdSchema,
  receiptDate: DateSchema,
  supplierName: optionalText(SUPPLIER_NAME_MAX),
  reference: optionalText(REFERENCE_MAX),
  note: optionalText(NOTE_MAX),
  /** The currency decimal places the costs were entered with; must match the current setting. */
  currencyMinorDigits: CurrencyDigitsSchema,
  lines: z
    .array(StockReceiptLineInputSchema)
    .min(1, 'Add at least one product line.')
    .max(MAX_RECEIPT_LINES, `Use at most ${MAX_RECEIPT_LINES} lines.`)
})
export type StockReceiptInput = z.output<typeof StockReceiptInputSchema>

/** The adjustment form's fields, before the rules that depend on the reason. */
export interface AdjustmentShape {
  readonly reason: AdjustmentReason
  readonly direction: 'IN' | 'OUT' | null
  readonly unitId: number | null
  readonly quantity: number | null
  readonly unitCostMinor: number | null
  readonly receiptItemId: number | null
}

/** `window.api.stock.adjust(...)`: one stock adjustment. Which fields are used depends on the reason. */
export const StockAdjustmentInputSchema = z
  .strictObject({
    requestId: RequestIdSchema,
    adjustmentDate: DateSchema,
    productId: IdSchema,
    reason: z.enum(ADJUSTMENT_REASONS, { error: 'Choose a reason.' }),
    /** Receipt quantity corrections and other corrections only: add (IN) or remove (OUT). */
    direction: z.enum(['IN', 'OUT'], { error: 'Choose add or remove.' }).nullable(),
    unitId: IdSchema.nullable(),
    quantity: wholeNumber(1, MAX_STOCK_QUANTITY).nullable(),
    /**
     * Cost of one unit: required for opening stock and for stock added by another correction, and for a count surplus
     * when the product has no stock; for a receipt cost correction, the correct cost of one unit of the receipt line.
     */
    unitCostMinor: CostSchema.nullable(),
    /** The corrected receipt line (receipt corrections only). */
    receiptItemId: IdSchema.nullable(),
    reasonNote: requiredText('reason note', REASON_NOTE_MAX),
    currencyMinorDigits: CurrencyDigitsSchema
  })
  .superRefine((input, ctx) => {
    for (const [path, message] of adjustmentIssues(input)) {
      ctx.addIssue({ code: 'custom', path: [path], message })
    }
  })
export type StockAdjustmentInput = z.output<typeof StockAdjustmentInputSchema>

/** The direction an adjustment moves stock in. */
export function adjustmentDirection(
  input: Pick<AdjustmentShape, 'reason' | 'direction'>
): AdjustmentDirection {
  const [only, ...others] = ADJUSTMENT_REASON_INFO[input.reason].directions
  return others.length === 0 ? only : (input.direction ?? 'IN')
}

const NOT_USED = 'Not used for this reason.'

/** The fields an adjustment must, or must not, have for its reason: [field, message] pairs. */
export function adjustmentIssues(input: AdjustmentShape): Array<[keyof AdjustmentShape, string]> {
  const issues: Array<[keyof AdjustmentShape, string]> = []
  const { reason } = input
  const choosesDirection = ADJUSTMENT_REASON_INFO[reason].directions.length > 1
  if (choosesDirection && input.direction === null) {
    issues.push(['direction', 'Choose whether stock is added or removed.'])
  }
  if (!choosesDirection && input.direction !== null) issues.push(['direction', NOT_USED])

  if (reason === 'RECEIPT_COST_CORRECTION') {
    if (input.unitId !== null) issues.push(['unitId', NOT_USED])
    if (input.quantity !== null) issues.push(['quantity', NOT_USED])
  } else {
    if (input.unitId === null) issues.push(['unitId', 'Choose the unit.'])
    if (input.quantity === null) issues.push(['quantity', 'Enter the quantity.'])
  }

  // The cost rules depend on the direction: until it is chosen, only the missing direction is reported.
  if (choosesDirection && input.direction === null) return withReceiptIssues(issues, input)
  const direction = adjustmentDirection(input)
  const costRequired =
    reason === 'OPENING_STOCK' ||
    reason === 'RECEIPT_COST_CORRECTION' ||
    (reason === 'OTHER_CORRECTION' && direction === 'IN')
  const costUnused =
    direction === 'OUT' || (reason === 'RECEIPT_QTY_CORRECTION' && direction === 'IN')
  if (costRequired && input.unitCostMinor === null) {
    issues.push([
      'unitCostMinor',
      reason === 'RECEIPT_COST_CORRECTION' ? 'Enter the correct unit cost.' : 'Enter the unit cost.'
    ])
  }
  if (costUnused && input.unitCostMinor !== null) {
    issues.push([
      'unitCostMinor',
      direction === 'OUT'
        ? 'Not used: stock leaves at its current average cost.'
        : "Not used: stock is added at the receipt line's cost."
    ])
  }

  return withReceiptIssues(issues, input)
}

function withReceiptIssues(
  issues: Array<[keyof AdjustmentShape, string]>,
  input: AdjustmentShape
): Array<[keyof AdjustmentShape, string]> {
  const forReceipt =
    input.reason === 'RECEIPT_QTY_CORRECTION' || input.reason === 'RECEIPT_COST_CORRECTION'
  if (forReceipt && input.receiptItemId === null) {
    issues.push(['receiptItemId', 'Choose the receipt line to correct.'])
  }
  if (!forReceipt && input.receiptItemId !== null) issues.push(['receiptItemId', NOT_USED])
  return issues
}

/** `window.api.stock.voidReceipt(...)`. */
export const ReceiptVoidInputSchema = z.strictObject({
  id: IdSchema,
  reason: requiredText('reason for voiding', REASON_NOTE_MAX)
})
export type ReceiptVoidInput = z.output<typeof ReceiptVoidInputSchema>

/** `window.api.stock.listReceipts(...)`: newest first. */
export const ReceiptListInputSchema = z.strictObject({
  page: PageSchema,
  pageSize: PageSizeSchema,
  /** Matched against the receipt number, supplier and reference. */
  search: z.string().trim().max(100, 'Use at most 100 characters.')
})
export type ReceiptListInput = z.output<typeof ReceiptListInputSchema>

/** `window.api.stock.listAdjustments(...)`: newest first. */
export const AdjustmentListInputSchema = z.strictObject({
  page: PageSchema,
  pageSize: PageSizeSchema,
  productId: IdSchema.nullable()
})
export type AdjustmentListInput = z.output<typeof AdjustmentListInputSchema>

/** `window.api.stock.stockCard(...)`: one page of a product's movements, oldest first; page null is the last page. */
export const StockCardInputSchema = z.strictObject({
  productId: IdSchema,
  page: PageSchema.nullable(),
  pageSize: PageSizeSchema
})
export type StockCardInput = z.output<typeof StockCardInputSchema>

/** `window.api.stock.postingFloor(...)`: the earliest date a stock document for these products may have. */
export const PostingFloorInputSchema = z.strictObject({
  productIds: z.array(IdSchema).max(MAX_RECEIPT_LINES)
})
export type PostingFloorInput = z.output<typeof PostingFloorInputSchema>

/** A receipt id (`stock.getReceipt`) or product id (`stock.summary`). */
export const StockIdSchema = IdSchema

export type DocumentStatus = 'POSTED' | 'VOID'

export interface StockPage<T> {
  readonly items: readonly T[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

export interface StockReceiptSummary {
  readonly id: number
  readonly receiptNo: string
  readonly receiptDate: string
  readonly supplierName: string | null
  readonly reference: string | null
  readonly totalCostMinor: number
  readonly status: DocumentStatus
  readonly lineCount: number
  /** A posted receipt that no other stock activity has touched since: it can still be voided. */
  readonly voidable: boolean
  readonly createdAt: string
}

/** A receipt line as saved: the unit name, size and costs are the values recorded then. */
export interface StockReceiptLine {
  readonly id: number
  readonly lineNo: number
  readonly productId: number
  /** The product's current code and name (receipt lines keep no copy of them). */
  readonly productCode: string
  readonly productName: string
  readonly unitId: number
  readonly unitName: string
  readonly unitBaseQty: number
  readonly quantity: number
  readonly qtyBase: number
  readonly unitCostMinor: number
  readonly lineCostMinor: number
  /** The line cost after receipt cost corrections (lineCostMinor when there are none). */
  readonly correctedLineCostMinor: number
  /** Other stock activity for this line's product followed the receipt (limitation L1 applies to corrections). */
  readonly laterActivity: boolean
}

export interface StockReceiptDetail extends StockReceiptSummary {
  readonly note: string | null
  readonly voidReason: string | null
  readonly voidDate: string | null
  readonly lines: readonly StockReceiptLine[]
  /** The adjustments that correct this receipt, oldest first. */
  readonly corrections: readonly StockAdjustmentSummary[]
}

export interface StockAdjustmentSummary {
  readonly id: number
  readonly adjustmentNo: string
  readonly adjustmentDate: string
  readonly productId: number
  readonly productCode: string
  readonly productName: string
  readonly reason: AdjustmentReason
  readonly direction: AdjustmentDirection
  readonly unitName: string | null
  readonly quantity: number | null
  readonly qtyBase: number
  /** The inventory value change: positive in, negative out. */
  readonly valueMinor: number
  readonly receiptId: number | null
  readonly receiptNo: string | null
  readonly receiptItemId: number | null
  readonly receiptLineNo: number | null
  readonly reasonNote: string
  readonly createdAt: string
}

export interface StockAdjustmentResult extends StockAdjustmentSummary {
  /** LATE_COST_CORRECTION_WARNING when it applied to this cost correction; otherwise null. */
  readonly warning: string | null
}

export interface StockCardRow {
  readonly id: number
  readonly date: string
  readonly type: StockMovementType
  /** The adjustment reason, for adjustment movements. */
  readonly reason: AdjustmentReason | null
  /** GRN-000001 (line 2), ADJ-000004 or INV-000010. */
  readonly reference: string
  readonly qtyInBase: number
  readonly qtyOutBase: number
  readonly valueInMinor: number
  readonly valueOutMinor: number
  readonly runningQtyBase: number
  readonly runningValueMinor: number
}

export interface StockCard {
  readonly product: {
    readonly id: number
    readonly code: string
    readonly name: string
    readonly packingLabel: string | null
    readonly isActive: boolean
    readonly lowStockThresholdBase: number
    readonly units: readonly ProductUnit[]
  }
  /** Current totals: Σ of every movement. */
  readonly qtyBase: number
  readonly valueMinor: number
  readonly rows: readonly StockCardRow[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

export interface StockSummary {
  readonly productId: number
  readonly qtyBase: number
  readonly valueMinor: number
  readonly hasMovements: boolean
  /** The latest movement date: stock documents for the product cannot be dated earlier. */
  readonly latestMovementDate: string | null
}

export interface PostingFloor {
  /** The main process's calendar day: the latest date allowed. */
  readonly today: string
  /** The earliest date allowed; null when none of the products has stock activity. */
  readonly earliestDate: string | null
  /** The product whose latest movement sets earliestDate. */
  readonly setBy: {
    readonly productId: number
    readonly productCode: string
    readonly productName: string
  } | null
}

/** 'GRN-' and 12 → 'GRN-000012'. */
export function formatDocumentNumber(prefix: string, value: number): string {
  return `${prefix}${String(value).padStart(DOCUMENT_NUMBER_DIGITS, '0')}`
}
