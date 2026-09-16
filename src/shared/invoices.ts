import { z } from 'zod'
import { CurrencyDigitsSchema } from './customers'
import { BPS_PER_WHOLE } from './domain/money'
import {
  PAYMENT_METHODS,
  PAYMENT_REFERENCE_MAX,
  type PaymentMethod,
  type PaymentStatus
} from './payments'
import { MAX_UNITS_PER_PRODUCT } from './products'
import { MAX_STOCK_QUANTITY } from './stock'
import { DateSchema, IdSchema, RequestIdSchema, optionalText, wholeNumber } from './validation'

/*
 * Sales invoices (plan §11). Posting an invoice is one transaction in the main process: the header with a copy of the
 * customer's details, one line per product with a copy of the product's details, the quantity rows of each line with a
 * copy of each unit, one SALE stock movement per line at its frozen weighted-average cost, the INVOICE ledger entry,
 * and, when money is received at the counter, a real payment with its PAYMENT ledger entry.
 *
 * The request carries what the operator chose: products, units, quantities, the price of each quantity row and whether
 * that price was typed over the configured one, discounts, schemes, freight and the amount received. Unit sizes,
 * configured prices, amounts, totals, balances and costs are never taken from it: the main process reads or calculates
 * them (invoice-totals.ts). The same schemas validate the billing form (renderer) and every request (main process).
 */

export const MAX_INVOICE_LINES = 100
/** Largest quantity of one quantity row, in the unit it is entered in. */
export const MAX_SALE_QUANTITY = MAX_STOCK_QUANTITY
export const MAX_CTN_COUNT = 1_000_000
export const INVOICE_CODE_MAX = 40
export const BILTY_NO_MAX = 40
export const TRANSPORT_NAME_MAX = 80
export const ADDA_NAME_MAX = 80
export const CHECKED_BY_MAX = 60
export const INVOICE_NOTES_MAX = 500

export const PRICE_TIERS = ['RETAIL', 'WHOLESALE'] as const
export type PriceTier = (typeof PRICE_TIERS)[number]

export const PRICE_TIER_LABELS: Readonly<Record<PriceTier, string>> = Object.freeze({
  RETAIL: 'Retail',
  WHOLESALE: 'Wholesale'
})

export type InvoiceStatus = 'POSTED' | 'VOID'

/**
 * The walk-in customer (C-00001) only buys for cash: the amount received must equal the invoice total (0 for a zero
 * total), so a walk-in balance never becomes due or an advance.
 */
export const WALK_IN_FULL_PAYMENT_MESSAGE =
  'Walk-in sales must be paid in full. Select a customer account for credit sales.'

/** `details.rule` of the refusal above, so the billing screen can recognise it without reading the message. */
export const WALK_IN_FULL_PAYMENT_RULE = 'WALK_IN_FULL_PAYMENT'

/** An amount the operator entered, in integer minor units: zero or more. */
const AmountSchema = z
  .number({ error: 'Enter the amount.' })
  .int('Enter a valid amount.')
  .min(0, 'The amount cannot be negative.')
  .max(Number.MAX_SAFE_INTEGER, 'The amount is too large.')

const QuantitySchema = wholeNumber(1, MAX_SALE_QUANTITY)

/** One quantity row of a line: a quantity in one unit, at one price per unit. */
export const InvoiceQuantityInputSchema = z.strictObject({
  /** An active unit of the line's product that can be sold. Its size is read from the database. */
  unitId: IdSchema,
  quantity: QuantitySchema,
  /**
   * The price of one unit as the form showed it. Without priceOverride it must still equal the unit's configured price
   * for the invoice's tier (otherwise PRICE_CHANGED); with priceOverride it is the operator's own price.
   */
  unitPriceMinor: AmountSchema,
  /** True when the operator typed the price instead of using the configured price. */
  priceOverride: z.boolean({ error: 'Say whether the price was changed.' })
})
export type InvoiceQuantityInput = z.output<typeof InvoiceQuantityInputSchema>

/** Free scheme goods of a line: they leave stock and are costed, but nothing is charged. */
export const FreeQuantityInputSchema = z.strictObject({
  unitId: IdSchema,
  quantity: QuantitySchema
})
export type FreeQuantityInput = z.output<typeof FreeQuantityInputSchema>

/** A line discount: a percentage of the line's gross amount, or a fixed amount. Null: no discount. */
export const LineDiscountSchema = z
  .discriminatedUnion(
    'type',
    [
      z.strictObject({
        type: z.literal('PERCENT'),
        bps: z
          .number({ error: 'Enter a percentage from 0 to 100.' })
          .int('Use at most 2 decimal places.')
          .min(0, 'Enter a percentage from 0 to 100.')
          .max(BPS_PER_WHOLE, 'Enter a percentage from 0 to 100.')
      }),
      z.strictObject({ type: z.literal('AMOUNT'), amountMinor: AmountSchema })
    ],
    { error: 'Choose a percentage or an amount.' }
  )
  .nullable()

export const InvoiceLineInputSchema = z
  .strictObject({
    productId: IdSchema,
    quantities: z
      .array(InvoiceQuantityInputSchema)
      .min(1, 'Enter a quantity.')
      .max(MAX_UNITS_PER_PRODUCT, `Use at most ${MAX_UNITS_PER_PRODUCT} units on a line.`),
    freeQuantities: z
      .array(FreeQuantityInputSchema)
      .max(MAX_UNITS_PER_PRODUCT, `Use at most ${MAX_UNITS_PER_PRODUCT} units on a line.`),
    discount: LineDiscountSchema,
    /** Sch as money: deducted after the discount, no stock effect. */
    schemeMinor: AmountSchema,
    /** The printed "Ctn": informational only, never used for stock or money. */
    ctnCount: wholeNumber(0, MAX_CTN_COUNT).nullable()
  })
  .superRefine((line, ctx) => {
    repeatedUnits(line.quantities).forEach((index) => {
      ctx.addIssue({
        code: 'custom',
        path: ['quantities', index, 'unitId'],
        message: 'This unit is already on the line.'
      })
    })
    repeatedUnits(line.freeQuantities).forEach((index) => {
      ctx.addIssue({
        code: 'custom',
        path: ['freeQuantities', index, 'unitId'],
        message: 'This unit is already in the free quantity.'
      })
    })
  })
export type InvoiceLineInput = z.output<typeof InvoiceLineInputSchema>

/** The input of posting an invoice. */
export const InvoiceCreateSchema = z
  .strictObject({
    requestId: RequestIdSchema,
    invoiceDate: DateSchema,
    /** The walk-in customer (C-00001) or an active customer. */
    customerId: IdSchema,
    priceTier: z.enum(PRICE_TIERS, { error: 'Choose retail or wholesale prices.' }),
    /** The printed "Invoice Code": optional text with no calculated meaning. */
    invoiceCode: optionalText(INVOICE_CODE_MAX),
    biltyNo: optionalText(BILTY_NO_MAX),
    transportName: optionalText(TRANSPORT_NAME_MAX),
    addaName: optionalText(ADDA_NAME_MAX),
    checkedBy: optionalText(CHECKED_BY_MAX),
    notes: optionalText(INVOICE_NOTES_MAX),
    lines: z
      .array(InvoiceLineInputSchema)
      .min(1, 'Add at least one product.')
      .max(MAX_INVOICE_LINES, `Use at most ${MAX_INVOICE_LINES} lines.`),
    extraDiscountMinor: AmountSchema,
    /** Charged to the customer: part of the total and the balance. */
    freightMinor: AmountSchema,
    /** Money received with the invoice. Above zero, it is saved as a real payment. */
    receivedMinor: AmountSchema,
    /** Required when money is received; ignored otherwise. */
    paymentMethod: z.enum(PAYMENT_METHODS, { error: 'Choose a payment method.' }).nullable(),
    paymentReference: optionalText(PAYMENT_REFERENCE_MAX),
    /** The currency decimal places the amounts were entered with; must match the current setting. */
    currencyMinorDigits: CurrencyDigitsSchema
  })
  .superRefine((invoice, ctx) => {
    const firstLine = new Map<number, number>()
    invoice.lines.forEach((line, index) => {
      const first = firstLine.get(line.productId)
      if (first === undefined) {
        firstLine.set(line.productId, index)
        return
      }
      ctx.addIssue({
        code: 'custom',
        path: ['lines', index, 'productId'],
        message: `This product is already on line ${first + 1}. Enter all its quantities on that line.`
      })
    })
    if (invoice.receivedMinor > 0 && invoice.paymentMethod === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['paymentMethod'],
        message: 'Choose how the money was received.'
      })
    }
  })
export type InvoiceCreateInput = z.output<typeof InvoiceCreateSchema>

export const InvoiceIdSchema = IdSchema

/** The billing screen's context: the next number and the posting-date floor of the chosen customer and products. */
export const InvoiceContextInputSchema = z.strictObject({
  customerId: IdSchema.nullable(),
  productIds: z.array(IdSchema).max(MAX_INVOICE_LINES)
})
export type InvoiceContextInput = z.output<typeof InvoiceContextInputSchema>

export interface InvoiceContext {
  /** The main process's calendar day: the latest date allowed. */
  readonly today: string
  /** The number the next invoice would get. A preview only: nothing is reserved until an invoice is posted. */
  readonly nextInvoiceNo: string
  /** The earliest date allowed for this customer and these products; null when none of them has activity. */
  readonly earliestDate: string | null
  /** Whose latest activity sets earliestDate (the later one when both have activity). */
  readonly earliestDateSetBy: {
    readonly kind: 'CUSTOMER' | 'PRODUCT'
    readonly id: number
    readonly code: string
    readonly name: string
  } | null
}

/** 'INV-', padding 6 and 12 → 'INV-000012'. A number longer than the padding is written in full. */
export function formatInvoiceNumber(prefix: string, padding: number, value: number): string {
  return `${prefix}${String(value).padStart(padding, '0')}`
}

/** A quantity row as saved: the unit's name and size are the values of the day. */
export interface InvoiceQuantity {
  readonly id: number
  readonly unitId: number
  readonly unitName: string
  readonly unitShortName: string | null
  readonly unitBaseQty: number
  readonly quantity: number
  readonly unitPriceMinor: number
  readonly amountMinor: number
  readonly qtyBase: number
}

/** A line as saved: product details, amounts and cost are the values of the day. */
export interface InvoiceLine {
  readonly id: number
  readonly lineNo: number
  readonly productId: number
  readonly productCode: string
  readonly productName: string
  readonly companyName: string | null
  readonly packingLabel: string | null
  /** Everything that left stock: paid quantity plus free scheme quantity, in base units. */
  readonly qtyBase: number
  readonly schemeQtyBase: number
  readonly grossMinor: number
  readonly discountBps: number | null
  readonly discountMinor: number
  readonly schemeMinor: number
  readonly ctnCount: number | null
  readonly netMinor: number
  /** Frozen cost of goods sold for qtyBase. */
  readonly costMinor: number
  readonly quantities: readonly InvoiceQuantity[]
}

/** The payment saved with the invoice for money received at the counter. */
export interface InvoicePayment {
  readonly id: number
  readonly paymentNo: string
  readonly paymentDate: string
  readonly amountMinor: number
  readonly method: PaymentMethod
  readonly reference: string | null
  readonly status: PaymentStatus
}

export interface InvoiceDetail {
  readonly id: number
  readonly invoiceNo: string
  readonly invoiceDate: string
  readonly invoiceCode: string | null
  readonly status: InvoiceStatus
  readonly customerId: number
  /** The customer's code (codes never change). */
  readonly customerCode: string
  /** The customer's details as they were when the invoice was saved. */
  readonly customerName: string
  readonly customerShopName: string | null
  readonly customerPhone: string | null
  readonly customerAddress: string | null
  readonly customerCity: string | null
  readonly priceTier: PriceTier
  readonly grossMinor: number
  readonly lineDiscountMinor: number
  readonly lineSchemeMinor: number
  readonly extraDiscountMinor: number
  readonly netMinor: number
  readonly freightMinor: number
  readonly totalMinor: number
  readonly receivedMinor: number
  readonly previousBalanceMinor: number
  readonly netOutstandingMinor: number
  readonly cogsMinor: number
  readonly biltyNo: string | null
  readonly transportName: string | null
  readonly addaName: string | null
  readonly checkedBy: string | null
  readonly notes: string | null
  readonly payment: InvoicePayment | null
  readonly lines: readonly InvoiceLine[]
  readonly voidReason: string | null
  readonly voidDate: string | null
  readonly voidedAt: string | null
  readonly createdAt: string
}

export interface InvoiceSaveResult extends InvoiceDetail {
  /** The customer's balance now (Σ ledger). */
  readonly balanceAfterMinor: number
  /** True when the request id had already been saved: the saved invoice is returned and nothing new is written. */
  readonly replayed: boolean
}

/** The indexes of rows whose unit already appeared on an earlier row. */
function repeatedUnits(rows: readonly { readonly unitId: number }[]): number[] {
  const seen = new Set<number>()
  const repeated: number[] = []
  rows.forEach((row, index) => {
    if (seen.has(row.unitId)) repeated.push(index)
    seen.add(row.unitId)
  })
  return repeated
}
