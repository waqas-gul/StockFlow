import { isWalkInCustomer, type CustomerListItem } from '@shared/customers'
import { formatMoney, parseMoney } from '@shared/domain'
import type { PriceTier } from '@shared/invoices'
import type { PaymentMethod } from '@shared/payments'
import type { Product, ProductUnit } from '@shared/products'

/*
 * The New Invoice screen's draft: what the operator has typed, kept in local state only (never saved as a draft). All
 * amounts and quantities stay text until the summary parses them (invoice-summary.ts). Prices follow the price tier:
 * a row shows the unit's configured price for the tier until the operator types another one (a custom price), and a
 * unit without a price for the tier starts empty. Nothing here trusts itself: the main process checks and recalculates
 * everything when the invoice is posted.
 */

export type DiscountKind = 'NONE' | 'PERCENT' | 'AMOUNT'

export interface DraftCustomer {
  readonly id: number
  readonly code: string
  readonly name: string
  readonly shopName: string | null
  /** The balance when the customer was chosen; the screen keeps reading it fresh. */
  readonly balanceMinor: number
  /** C-00001 "Cash / Walk-in": a cash sale, paid exactly in full. */
  readonly walkIn: boolean
}

export interface QuantityRowDraft {
  readonly key: string
  readonly unitId: number | null
  readonly quantity: string
  /** The price of one unit as text; the configured price until the operator types another. */
  readonly price: string
}

export interface FreeRowDraft {
  readonly key: string
  readonly unitId: number | null
  readonly quantity: string
}

export interface LineDraft {
  readonly key: string
  /** The product as read when it was added (units, prices, stock); refreshed after a price or stock change. */
  readonly product: Product
  readonly quantities: readonly QuantityRowDraft[]
  /** Free scheme goods, in units of the product. */
  readonly freeQuantities: readonly FreeRowDraft[]
  readonly discountKind: DiscountKind
  /** A percentage (PERCENT) or an amount (AMOUNT). */
  readonly discount: string
  /** The scheme deducted as money. */
  readonly scheme: string
  /** The printed "Ctn": informational only. */
  readonly ctn: string
}

export interface InvoiceDraft {
  /** One id for every submission of this draft: a retry never posts the invoice twice. */
  readonly requestId: string
  readonly minorDigits: number
  readonly invoiceDate: string
  readonly customer: DraftCustomer | null
  readonly priceTier: PriceTier
  readonly invoiceCode: string
  readonly biltyNo: string
  readonly transportName: string
  readonly addaName: string
  readonly checkedBy: string
  readonly notes: string
  readonly lines: readonly LineDraft[]
  readonly extraDiscount: string
  readonly freight: string
  /** Ignored for the walk-in customer: a cash sale receives exactly the total. */
  readonly received: string
  readonly paymentMethod: PaymentMethod
  readonly paymentReference: string
}

/** Header and totals fields typed as plain text. */
export type DraftTextField =
  | 'invoiceDate'
  | 'invoiceCode'
  | 'biltyNo'
  | 'transportName'
  | 'addaName'
  | 'checkedBy'
  | 'notes'
  | 'extraDiscount'
  | 'freight'
  | 'received'
  | 'paymentReference'

export type InvoiceDraftAction =
  | { readonly type: 'setField'; readonly field: DraftTextField; readonly value: string }
  | { readonly type: 'setPaymentMethod'; readonly method: PaymentMethod }
  | { readonly type: 'setCustomer'; readonly customer: DraftCustomer | null }
  | { readonly type: 'setPriceTier'; readonly tier: PriceTier }
  | { readonly type: 'addLine'; readonly product: Product }
  | { readonly type: 'removeLine'; readonly lineKey: string }
  | { readonly type: 'refreshProduct'; readonly product: Product }
  | { readonly type: 'addQuantityRow'; readonly lineKey: string }
  | { readonly type: 'removeQuantityRow'; readonly lineKey: string; readonly rowKey: string }
  | {
      readonly type: 'setRowUnit'
      readonly lineKey: string
      readonly rowKey: string
      readonly unitId: number
    }
  | {
      readonly type: 'setRowQuantity'
      readonly lineKey: string
      readonly rowKey: string
      readonly value: string
    }
  | {
      readonly type: 'setRowPrice'
      readonly lineKey: string
      readonly rowKey: string
      readonly value: string
    }
  | { readonly type: 'resetRowPrice'; readonly lineKey: string; readonly rowKey: string }
  | { readonly type: 'addFreeRow'; readonly lineKey: string }
  | { readonly type: 'removeFreeRow'; readonly lineKey: string; readonly rowKey: string }
  | {
      readonly type: 'setFreeUnit'
      readonly lineKey: string
      readonly rowKey: string
      readonly unitId: number
    }
  | {
      readonly type: 'setFreeQuantity'
      readonly lineKey: string
      readonly rowKey: string
      readonly value: string
    }
  | { readonly type: 'setDiscountKind'; readonly lineKey: string; readonly kind: DiscountKind }
  | {
      readonly type: 'setLineField'
      readonly lineKey: string
      readonly field: 'discount' | 'scheme' | 'ctn'
      readonly value: string
    }
  | { readonly type: 'reset'; readonly draft: InvoiceDraft }

let keyCounter = 0

function nextKey(prefix: string): string {
  keyCounter += 1
  return `${prefix}-${keyCounter}`
}

export function emptyInvoiceDraft(options: {
  readonly today: string
  readonly minorDigits: number
  readonly requestId: string
}): InvoiceDraft {
  return {
    requestId: options.requestId,
    minorDigits: options.minorDigits,
    invoiceDate: options.today,
    customer: null,
    priceTier: 'RETAIL',
    invoiceCode: '',
    biltyNo: '',
    transportName: '',
    addaName: '',
    checkedBy: '',
    notes: '',
    lines: [],
    extraDiscount: '',
    freight: '',
    received: '',
    paymentMethod: 'CASH',
    paymentReference: ''
  }
}

export function toDraftCustomer(
  customer: Pick<CustomerListItem, 'id' | 'code' | 'name' | 'shopName' | 'balanceMinor'>
): DraftCustomer {
  return {
    id: customer.id,
    code: customer.code,
    name: customer.name,
    shopName: customer.shopName,
    balanceMinor: customer.balanceMinor,
    walkIn: isWalkInCustomer(customer.code)
  }
}

/** The units a line can sell in: active and sellable, in display order. */
export function sellableUnits(product: Product): ProductUnit[] {
  return product.units.filter((unit) => unit.isActive && unit.canSell)
}

/** The unit's price for the tier; null when the unit has none (never the other tier's price). */
export function configuredPrice(unit: ProductUnit, tier: PriceTier): number | null {
  return tier === 'RETAIL' ? unit.retailPriceMinor : unit.wholesalePriceMinor
}

/** The index of the line that already holds the product, or null. */
export function lineIndexOf(draft: InvoiceDraft, productId: number): number | null {
  const index = draft.lines.findIndex((line) => line.product.id === productId)
  return index === -1 ? null : index
}

/** True once the draft holds something worth asking about before it is discarded. */
export function isDraftDirty(draft: InvoiceDraft): boolean {
  return (
    draft.customer !== null ||
    draft.lines.length > 0 ||
    [
      draft.invoiceCode,
      draft.biltyNo,
      draft.transportName,
      draft.addaName,
      draft.checkedBy,
      draft.notes,
      draft.extraDiscount,
      draft.freight,
      draft.received,
      draft.paymentReference
    ].some((text) => text.trim() !== '')
  )
}

/**
 * True when the row's price is the operator's own: a typed amount that is not the unit's configured price for the
 * tier. A blank or unreadable price is not custom.
 */
export function isCustomPrice(
  row: Pick<QuantityRowDraft, 'unitId' | 'price'>,
  product: Product,
  tier: PriceTier,
  minorDigits: number
): boolean {
  const parsed = parseMoney(row.price, { minorDigits })
  if (!parsed.ok) return false
  const unit = product.units.find((candidate) => candidate.id === row.unitId)
  const configured = unit === undefined ? null : configuredPrice(unit, tier)
  return configured === null || parsed.value !== configured
}

export function invoiceDraftReducer(draft: InvoiceDraft, action: InvoiceDraftAction): InvoiceDraft {
  const digits = draft.minorDigits
  const priceOf = (product: Product, unitId: number | null, tier = draft.priceTier): string => {
    const unit = product.units.find((candidate) => candidate.id === unitId)
    const price = unit === undefined ? null : configuredPrice(unit, tier)
    return price === null ? '' : formatMoney(price, { minorDigits: digits, grouping: 'none' })
  }
  const updateLine = (lineKey: string, change: (line: LineDraft) => LineDraft): InvoiceDraft => {
    let changed = false
    const lines = draft.lines.map((line) => {
      if (line.key !== lineKey) return line
      const next = change(line)
      changed ||= next !== line
      return next
    })
    return changed ? { ...draft, lines } : draft
  }
  const updateRow = (
    lineKey: string,
    rowKey: string,
    change: (row: QuantityRowDraft, line: LineDraft) => QuantityRowDraft
  ): InvoiceDraft =>
    updateLine(lineKey, (line) => ({
      ...line,
      quantities: line.quantities.map((row) => (row.key === rowKey ? change(row, line) : row))
    }))
  const updateFreeRow = (
    lineKey: string,
    rowKey: string,
    change: (row: FreeRowDraft) => FreeRowDraft
  ): InvoiceDraft =>
    updateLine(lineKey, (line) => ({
      ...line,
      freeQuantities: line.freeQuantities.map((row) => (row.key === rowKey ? change(row) : row))
    }))
  /** The first sellable unit not yet used by `rows`; undefined when every one is used. */
  const unusedUnit = (
    product: Product,
    rows: readonly { readonly unitId: number | null }[]
  ): ProductUnit | undefined =>
    sellableUnits(product).find((unit) => !rows.some((row) => row.unitId === unit.id))

  switch (action.type) {
    case 'setField':
      return { ...draft, [action.field]: action.value }
    case 'setPaymentMethod':
      return { ...draft, paymentMethod: action.method }
    case 'setCustomer':
      // A cash sale receives exactly the total: whatever was typed for an account customer is dropped.
      return {
        ...draft,
        customer: action.customer,
        received: action.customer?.walkIn ? '' : draft.received
      }
    case 'setPriceTier': {
      if (action.tier === draft.priceTier) return draft
      return {
        ...draft,
        priceTier: action.tier,
        lines: draft.lines.map((line) => ({
          ...line,
          quantities: line.quantities.map((row) =>
            isCustomPrice(row, line.product, draft.priceTier, digits)
              ? row
              : { ...row, price: priceOf(line.product, row.unitId, action.tier) }
          )
        }))
      }
    }
    case 'addLine': {
      if (lineIndexOf(draft, action.product.id) !== null) return draft
      const [unit] = sellableUnits(action.product)
      const unitId = unit?.id ?? null
      return {
        ...draft,
        lines: [
          ...draft.lines,
          {
            key: nextKey('line'),
            product: action.product,
            quantities: [
              {
                key: nextKey('row'),
                unitId,
                quantity: '',
                price: priceOf(action.product, unitId)
              }
            ],
            freeQuantities: [],
            discountKind: 'NONE',
            discount: '',
            scheme: '',
            ctn: ''
          }
        ]
      }
    }
    case 'removeLine':
      return { ...draft, lines: draft.lines.filter((line) => line.key !== action.lineKey) }
    case 'refreshProduct': {
      const index = lineIndexOf(draft, action.product.id)
      if (index === null) return draft
      const line = draft.lines[index]
      return updateLine(line.key, () => ({
        ...line,
        product: action.product,
        quantities: line.quantities.map((row) =>
          isCustomPrice(row, line.product, draft.priceTier, digits)
            ? row
            : { ...row, price: priceOf(action.product, row.unitId) }
        )
      }))
    }
    case 'addQuantityRow':
      return updateLine(action.lineKey, (line) => {
        const unit = unusedUnit(line.product, line.quantities)
        if (unit === undefined) return line
        return {
          ...line,
          quantities: [
            ...line.quantities,
            {
              key: nextKey('row'),
              unitId: unit.id,
              quantity: '',
              price: priceOf(line.product, unit.id)
            }
          ]
        }
      })
    case 'removeQuantityRow':
      return updateLine(action.lineKey, (line) => ({
        ...line,
        quantities: line.quantities.filter((row) => row.key !== action.rowKey)
      }))
    case 'setRowUnit':
      return updateRow(action.lineKey, action.rowKey, (row, line) => ({
        ...row,
        unitId: action.unitId,
        price: isCustomPrice(row, line.product, draft.priceTier, digits)
          ? row.price
          : priceOf(line.product, action.unitId)
      }))
    case 'setRowQuantity':
      return updateRow(action.lineKey, action.rowKey, (row) => ({ ...row, quantity: action.value }))
    case 'setRowPrice':
      return updateRow(action.lineKey, action.rowKey, (row) => ({ ...row, price: action.value }))
    case 'resetRowPrice':
      return updateRow(action.lineKey, action.rowKey, (row, line) => ({
        ...row,
        price: priceOf(line.product, row.unitId)
      }))
    case 'addFreeRow':
      return updateLine(action.lineKey, (line) => {
        const unit = unusedUnit(line.product, line.freeQuantities)
        if (unit === undefined) return line
        return {
          ...line,
          freeQuantities: [
            ...line.freeQuantities,
            { key: nextKey('free'), unitId: unit.id, quantity: '' }
          ]
        }
      })
    case 'removeFreeRow':
      return updateLine(action.lineKey, (line) => ({
        ...line,
        freeQuantities: line.freeQuantities.filter((row) => row.key !== action.rowKey)
      }))
    case 'setFreeUnit':
      return updateFreeRow(action.lineKey, action.rowKey, (row) => ({
        ...row,
        unitId: action.unitId
      }))
    case 'setFreeQuantity':
      return updateFreeRow(action.lineKey, action.rowKey, (row) => ({
        ...row,
        quantity: action.value
      }))
    case 'setDiscountKind':
      // The number means something else in the other kind (5% is not Rs 5), so it is cleared.
      return updateLine(action.lineKey, (line) =>
        line.discountKind === action.kind
          ? line
          : { ...line, discountKind: action.kind, discount: '' }
      )
    case 'setLineField':
      return updateLine(action.lineKey, (line) => ({ ...line, [action.field]: action.value }))
    case 'reset':
      return action.draft
  }
}
