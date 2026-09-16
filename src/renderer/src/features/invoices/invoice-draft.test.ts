import { describe, expect, it } from 'vitest'
import type { CustomerListItem } from '@shared/customers'
import { InvoiceCreateSchema } from '@shared/invoices'
import type { Product, ProductUnit } from '@shared/products'
import {
  emptyInvoiceDraft,
  invoiceDraftReducer,
  isDraftDirty,
  lineIndexOf,
  toDraftCustomer,
  type InvoiceDraft,
  type InvoiceDraftAction
} from './invoice-draft'
import { summarizeInvoice } from './invoice-summary'

const TODAY = '2026-09-16'

function unit(overrides: Partial<ProductUnit>): ProductUnit {
  return {
    id: 10,
    name: 'Piece',
    shortName: null,
    baseQty: 1,
    isBase: true,
    canSell: true,
    canPurchase: true,
    wholesalePriceMinor: null,
    retailPriceMinor: null,
    defaultCostMinor: null,
    sortOrder: 0,
    isActive: true,
    ...overrides
  }
}

function product(overrides: Partial<Product>): Product {
  return {
    id: 1,
    code: 'P-001',
    name: 'Tea 950g',
    companyId: 1,
    companyName: 'Tapal',
    companyActive: true,
    packingLabel: '1*12*18',
    lowStockThresholdBase: 0,
    isActive: true,
    stockQtyBase: 247,
    units: [],
    hasStockMovements: true,
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
    ...overrides
  }
}

/** Piece (retail 110, wholesale 100), Box of 24 (retail 2,400, wholesale 2,300), Carton not sold. 10 Box + 7 Piece in stock. */
const tea = product({
  units: [
    unit({ id: 10, name: 'Piece', retailPriceMinor: 11_000, wholesalePriceMinor: 10_000 }),
    unit({
      id: 11,
      name: 'Box',
      baseQty: 24,
      isBase: false,
      retailPriceMinor: 240_000,
      wholesalePriceMinor: 230_000,
      sortOrder: 1
    }),
    unit({
      id: 12,
      name: 'Carton',
      baseQty: 240,
      isBase: false,
      canSell: false,
      retailPriceMinor: 2_400_000,
      sortOrder: 2
    }),
    unit({
      id: 13,
      name: 'Tray',
      baseQty: 12,
      isBase: false,
      isActive: false,
      retailPriceMinor: 120_000,
      sortOrder: 3
    })
  ]
})

/** Kg (retail 200, no wholesale price). 100 Kg in stock. */
const sugar = product({
  id: 2,
  code: 'S-001',
  name: 'Sugar 1kg',
  companyId: null,
  companyName: null,
  companyActive: null,
  packingLabel: null,
  stockQtyBase: 100,
  units: [unit({ id: 20, name: 'Kg', retailPriceMinor: 20_000 })]
})

const ali: CustomerListItem = {
  id: 2,
  code: 'C-00002',
  name: 'Ali Raza',
  shopName: 'Ali Traders',
  phone: null,
  city: null,
  isActive: true,
  balanceMinor: 100_000
}

const walkIn: CustomerListItem = {
  id: 1,
  code: 'C-00001',
  name: 'Cash / Walk-in',
  shopName: null,
  phone: null,
  city: null,
  isActive: true,
  balanceMinor: 0
}

function draft(...actions: InvoiceDraftAction[]): InvoiceDraft {
  return actions.reduce(
    invoiceDraftReducer,
    emptyInvoiceDraft({ today: TODAY, minorDigits: 2, requestId: 'invoice-request-0001' })
  )
}

const line = (value: InvoiceDraft, index = 0): InvoiceDraft['lines'][number] => value.lines[index]
const rowKey = (value: InvoiceDraft, lineIndex: number, rowIndex: number): string =>
  value.lines[lineIndex].quantities[rowIndex].key

/** Tea with 2 Box + 5 Piece at retail prices, for Ali. */
function teaSale(...more: InvoiceDraftAction[]): InvoiceDraft {
  let value = draft(
    { type: 'setCustomer', customer: toDraftCustomer(ali) },
    { type: 'addLine', product: tea }
  )
  const lineKey = line(value).key
  value = invoiceDraftReducer(value, {
    type: 'setRowQuantity',
    lineKey,
    rowKey: rowKey(value, 0, 0),
    value: '5'
  })
  value = invoiceDraftReducer(value, { type: 'addQuantityRow', lineKey })
  value = invoiceDraftReducer(value, {
    type: 'setRowQuantity',
    lineKey,
    rowKey: rowKey(value, 0, 1),
    value: '2'
  })
  return more.reduce(invoiceDraftReducer, value)
}

describe('invoice draft', () => {
  it('starts empty, dated today, with one request id for its submissions', () => {
    const value = draft()
    expect(value).toMatchObject({
      requestId: 'invoice-request-0001',
      invoiceDate: TODAY,
      customer: null,
      priceTier: 'RETAIL',
      lines: [],
      received: '',
      paymentMethod: 'CASH'
    })
    expect(isDraftDirty(value)).toBe(false)
    expect(isDraftDirty(draft({ type: 'setPriceTier', tier: 'WHOLESALE' }))).toBe(false)
    expect(isDraftDirty(draft({ type: 'setField', field: 'notes', value: 'Urgent' }))).toBe(true)
    expect(isDraftDirty(draft({ type: 'addLine', product: sugar }))).toBe(true)
    expect(isDraftDirty(draft({ type: 'setCustomer', customer: toDraftCustomer(ali) }))).toBe(true)
  })

  it('adds a product with its first sellable unit at the tier price, and never adds the same product twice', () => {
    const value = draft({ type: 'addLine', product: tea })
    expect(line(value)).toMatchObject({
      product: tea,
      quantities: [{ unitId: 10, quantity: '', price: '110.00' }],
      freeQuantities: [],
      discountKind: 'NONE'
    })
    const again = invoiceDraftReducer(value, { type: 'addLine', product: tea })
    expect(again).toBe(value)
    expect(lineIndexOf(value, tea.id)).toBe(0)
    expect(lineIndexOf(value, sugar.id)).toBeNull()
  })

  it('takes Box and Piece on one line: only sellable, active units, each once', () => {
    let value = teaSale()
    expect(line(value).quantities.map((row) => [row.unitId, row.quantity, row.price])).toEqual([
      [10, '5', '110.00'],
      [11, '2', '2400.00']
    ])
    // Carton cannot be sold and Tray is inactive: no unit is left to add.
    expect(invoiceDraftReducer(value, { type: 'addQuantityRow', lineKey: line(value).key })).toBe(
      value
    )

    const summary = summarizeInvoice(value, { balanceMinor: 100_000 })
    expect(summary.lines[0]).toMatchObject({
      paidQtyBase: 53,
      schemeQtyBase: 0,
      requestedQtyBase: 53,
      requestedText: '2 Box + 5 Piece',
      stockText: '10 Box + 7 Piece',
      overStock: false,
      grossMinor: 535_000,
      netMinor: 535_000
    })
    expect(summary.lines[0].rows.map((row) => row.amountMinor)).toEqual([55_000, 480_000])

    value = invoiceDraftReducer(value, {
      type: 'removeQuantityRow',
      lineKey: line(value).key,
      rowKey: rowKey(value, 0, 0)
    })
    expect(line(value).quantities.map((row) => row.unitId)).toEqual([11])
  })

  it('switches configured prices with the tier, keeps custom prices, and never borrows the other tier', () => {
    let value = teaSale({ type: 'addLine', product: sugar })
    value = invoiceDraftReducer(value, {
      type: 'setRowPrice',
      lineKey: line(value).key,
      rowKey: rowKey(value, 0, 1),
      value: '2,250'
    })
    value = invoiceDraftReducer(value, { type: 'setPriceTier', tier: 'WHOLESALE' })
    expect(line(value).quantities.map((row) => row.price)).toEqual(['100.00', '2,250'])
    // Sugar has no wholesale price: the price is left empty for the operator, not taken from retail.
    expect(line(value, 1).quantities[0].price).toBe('')

    const summary = summarizeInvoice(
      invoiceDraftReducer(value, {
        type: 'setRowQuantity',
        lineKey: line(value, 1).key,
        rowKey: rowKey(value, 1, 0),
        value: '1'
      }),
      { balanceMinor: 100_000 }
    )
    expect(summary.lines[1].rows[0]).toMatchObject({
      configuredPriceMinor: null,
      missingPrice: true
    })
    expect(summary.issues['lines.1.quantities.0.price']).toBe(
      'Kg has no wholesale price. Enter a custom price.'
    )
    expect(summary.input).toBeNull()

    value = invoiceDraftReducer(value, { type: 'setPriceTier', tier: 'RETAIL' })
    expect(line(value).quantities.map((row) => row.price)).toEqual(['110.00', '2,250'])
    expect(line(value, 1).quantities[0].price).toBe('200.00')
  })

  it('marks a typed price as custom and sends it as an override; zero is a deliberate price', () => {
    let value = teaSale()
    const lineKey = line(value).key
    value = invoiceDraftReducer(value, {
      type: 'setRowPrice',
      lineKey,
      rowKey: rowKey(value, 0, 0),
      value: '0'
    })
    value = invoiceDraftReducer(value, {
      type: 'setRowPrice',
      lineKey,
      rowKey: rowKey(value, 0, 1),
      value: '2,400'
    })
    const summary = summarizeInvoice(value, { balanceMinor: 100_000 })
    expect(summary.lines[0].rows.map((row) => [row.priceMinor, row.custom])).toEqual([
      [0, true],
      // Typing the configured price again is not a custom price.
      [240_000, false]
    ])
    expect(summary.input?.lines[0].quantities).toEqual([
      { unitId: 10, quantity: 5, unitPriceMinor: 0, priceOverride: true },
      { unitId: 11, quantity: 2, unitPriceMinor: 240_000, priceOverride: false }
    ])

    // "Use list price" puts the configured price back.
    const reset = invoiceDraftReducer(value, {
      type: 'resetRowPrice',
      lineKey,
      rowKey: rowKey(value, 0, 0)
    })
    expect(line(reset).quantities[0].price).toBe('110.00')

    // A blank price with a configured price asks for it.
    const blank = invoiceDraftReducer(value, {
      type: 'setRowPrice',
      lineKey,
      rowKey: rowKey(value, 0, 0),
      value: ' '
    })
    expect(summarizeInvoice(blank, { balanceMinor: 0 }).issues['lines.0.quantities.0.price']).toBe(
      'Enter the unit price.'
    )
  })

  it('changing a unit takes its configured price unless the price was custom', () => {
    let value = draft({ type: 'addLine', product: tea })
    const lineKey = line(value).key
    value = invoiceDraftReducer(value, {
      type: 'setRowUnit',
      lineKey,
      rowKey: rowKey(value, 0, 0),
      unitId: 11
    })
    expect(line(value).quantities[0]).toMatchObject({ unitId: 11, price: '2400.00' })
    value = invoiceDraftReducer(value, {
      type: 'setRowPrice',
      lineKey,
      rowKey: rowKey(value, 0, 0),
      value: '2000'
    })
    value = invoiceDraftReducer(value, {
      type: 'setRowUnit',
      lineKey,
      rowKey: rowKey(value, 0, 0),
      unitId: 10
    })
    expect(line(value).quantities[0]).toMatchObject({ unitId: 10, price: '2000' })
  })

  it('converts free scheme quantity from its unit: stock leaves, nothing is charged', () => {
    let value = teaSale()
    const lineKey = line(value).key
    value = invoiceDraftReducer(value, { type: 'addFreeRow', lineKey })
    const freeKey = line(value).freeQuantities[0].key
    expect(line(value).freeQuantities[0]).toMatchObject({ unitId: 10, quantity: '' })
    value = invoiceDraftReducer(value, {
      type: 'setFreeUnit',
      lineKey,
      rowKey: freeKey,
      unitId: 11
    })
    value = invoiceDraftReducer(value, {
      type: 'setFreeQuantity',
      lineKey,
      rowKey: freeKey,
      value: '1'
    })

    const summary = summarizeInvoice(value, { balanceMinor: 100_000 })
    expect(summary.lines[0]).toMatchObject({
      paidQtyBase: 53,
      schemeQtyBase: 24,
      requestedQtyBase: 77,
      requestedText: '3 Box + 5 Piece',
      grossMinor: 535_000
    })
    expect(summary.totals?.totalMinor).toBe(535_000)
    expect(summary.input?.lines[0].freeQuantities).toEqual([{ unitId: 11, quantity: 1 }])

    const removed = invoiceDraftReducer(value, { type: 'removeFreeRow', lineKey, rowKey: freeKey })
    expect(line(removed).freeQuantities).toEqual([])
  })

  it('warns inline and blocks posting when paid plus free quantity exceeds the stock', () => {
    let value = draft(
      { type: 'setCustomer', customer: toDraftCustomer(ali) },
      { type: 'addLine', product: tea }
    )
    const lineKey = line(value).key
    value = invoiceDraftReducer(value, {
      type: 'setRowUnit',
      lineKey,
      rowKey: rowKey(value, 0, 0),
      unitId: 11
    })
    value = invoiceDraftReducer(value, {
      type: 'setRowQuantity',
      lineKey,
      rowKey: rowKey(value, 0, 0),
      value: '10'
    })
    expect(summarizeInvoice(value, { balanceMinor: 0 }).stockBlocked).toBe(false)

    value = invoiceDraftReducer(value, { type: 'addFreeRow', lineKey })
    value = invoiceDraftReducer(value, {
      type: 'setFreeUnit',
      lineKey,
      rowKey: line(value).freeQuantities[0].key,
      unitId: 11
    })
    value = invoiceDraftReducer(value, {
      type: 'setFreeQuantity',
      lineKey,
      rowKey: line(value).freeQuantities[0].key,
      value: '1'
    })
    const summary = summarizeInvoice(value, { balanceMinor: 0 })
    expect(summary.lines[0]).toMatchObject({ requestedQtyBase: 264, overStock: true })
    expect(summary.stockBlocked).toBe(true)
    expect(summary.issues['lines.0.stock']).toBe(
      'Only 10 Box + 7 Piece in stock; this line needs 11 Box.'
    )
    expect(summary.input).toBeNull()
  })

  it('previews a percentage discount, a fixed discount and the scheme amount of each line', () => {
    let value = draft(
      { type: 'setCustomer', customer: toDraftCustomer(ali) },
      { type: 'addLine', product: tea },
      { type: 'addLine', product: sugar }
    )
    const [teaKey, sugarKey] = value.lines.map((item) => item.key)
    value = invoiceDraftReducer(value, {
      type: 'setRowQuantity',
      lineKey: teaKey,
      rowKey: rowKey(value, 0, 0),
      value: '5'
    })
    value = invoiceDraftReducer(value, {
      type: 'setDiscountKind',
      lineKey: teaKey,
      kind: 'PERCENT'
    })
    value = invoiceDraftReducer(value, {
      type: 'setLineField',
      lineKey: teaKey,
      field: 'discount',
      value: '3.33'
    })
    value = invoiceDraftReducer(value, {
      type: 'setLineField',
      lineKey: teaKey,
      field: 'scheme',
      value: '10'
    })
    value = invoiceDraftReducer(value, {
      type: 'setRowQuantity',
      lineKey: sugarKey,
      rowKey: rowKey(value, 1, 0),
      value: '10'
    })
    value = invoiceDraftReducer(value, {
      type: 'setDiscountKind',
      lineKey: sugarKey,
      kind: 'AMOUNT'
    })
    value = invoiceDraftReducer(value, {
      type: 'setLineField',
      lineKey: sugarKey,
      field: 'discount',
      value: '50'
    })
    value = invoiceDraftReducer(value, {
      type: 'setLineField',
      lineKey: sugarKey,
      field: 'ctn',
      value: '2'
    })

    const summary = summarizeInvoice(value, { balanceMinor: 100_000 })
    // 55,000 × 3.33% = 1,831.5 → 1,832.
    expect(
      summary.lines.map((item) => [
        item.grossMinor,
        item.discountMinor,
        item.schemeMinor,
        item.netMinor
      ])
    ).toEqual([
      [55_000, 1_832, 1_000, 52_168],
      [200_000, 5_000, 0, 195_000]
    ])
    expect(summary.totals).toMatchObject({
      grossMinor: 255_000,
      lineDiscountMinor: 6_832,
      lineSchemeMinor: 1_000,
      netMinor: 247_168
    })
    expect(
      summary.input?.lines.map((item) => [item.discount, item.schemeMinor, item.ctnCount])
    ).toEqual([
      [{ type: 'PERCENT', bps: 333 }, 1_000, null],
      [{ type: 'AMOUNT', amountMinor: 5_000 }, 0, 2]
    ])

    const tooMuch = invoiceDraftReducer(value, {
      type: 'setLineField',
      lineKey: sugarKey,
      field: 'discount',
      value: '2000.01'
    })
    const refused = summarizeInvoice(tooMuch, { balanceMinor: 0 })
    expect(refused.issues['lines.1.discount']).toBe(
      'The discount cannot be more than the line amount.'
    )
    expect(refused.lines[1].netMinor).toBeNull()
    expect(refused.lines[0].netMinor).toBe(52_168)
    expect(refused.input).toBeNull()
  })

  it('works out the invoice totals and the account state after it, an overpayment becoming an advance', () => {
    const value = teaSale(
      { type: 'setField', field: 'extraDiscount', value: '350' },
      { type: 'setField', field: 'freight', value: '150' },
      { type: 'setField', field: 'received', value: '2,000' },
      { type: 'setPaymentMethod', method: 'BANK' },
      { type: 'setField', field: 'paymentReference', value: ' TT-55 ' }
    )
    const summary = summarizeInvoice(value, { balanceMinor: 100_000 })
    expect(summary.totals).toMatchObject({
      grossMinor: 535_000,
      extraDiscountMinor: 35_000,
      netMinor: 500_000,
      freightMinor: 15_000,
      totalMinor: 515_000,
      previousBalanceMinor: 100_000,
      receivedMinor: 200_000,
      netOutstandingMinor: 415_000
    })
    expect(summary.input).toMatchObject({
      receivedMinor: 200_000,
      paymentMethod: 'BANK',
      paymentReference: 'TT-55'
    })

    const over = summarizeInvoice(
      invoiceDraftReducer(value, { type: 'setField', field: 'received', value: '7000' }),
      {
        balanceMinor: 100_000
      }
    )
    expect(over.totals?.netOutstandingMinor).toBe(-85_000)

    // Nothing received: no payment method or reference is sent.
    const credit = summarizeInvoice(
      invoiceDraftReducer(value, { type: 'setField', field: 'received', value: '' }),
      {
        balanceMinor: 100_000
      }
    )
    expect(credit.input).toMatchObject({
      receivedMinor: 0,
      paymentMethod: null,
      paymentReference: null
    })
  })

  it('locks received to the total for the walk-in customer: a cash sale', () => {
    let value = teaSale({ type: 'setField', field: 'received', value: '100' })
    value = invoiceDraftReducer(value, { type: 'setCustomer', customer: toDraftCustomer(walkIn) })
    expect(value.customer).toMatchObject({ code: 'C-00001', walkIn: true })
    expect(value.received).toBe('')

    const summary = summarizeInvoice(
      invoiceDraftReducer(value, { type: 'setField', field: 'received', value: '5' }),
      { balanceMinor: 0 }
    )
    expect(summary.walkIn).toBe(true)
    expect(summary.totals).toMatchObject({
      totalMinor: 535_000,
      receivedMinor: 535_000,
      netOutstandingMinor: 0
    })
    expect(summary.input).toMatchObject({
      customerId: 1,
      receivedMinor: 535_000,
      paymentMethod: 'CASH'
    })

    // A zero cash sale takes no money.
    const lineKey = line(value).key
    let free = invoiceDraftReducer(value, {
      type: 'setRowPrice',
      lineKey,
      rowKey: rowKey(value, 0, 0),
      value: '0'
    })
    free = invoiceDraftReducer(free, {
      type: 'setRowPrice',
      lineKey,
      rowKey: rowKey(value, 0, 1),
      value: '0'
    })
    expect(summarizeInvoice(free, { balanceMinor: 0 }).input).toMatchObject({
      receivedMinor: 0,
      paymentMethod: null
    })
    expect(toDraftCustomer(ali).walkIn).toBe(false)
  })

  it('lists what must be fixed before posting, at each field', () => {
    const empty = summarizeInvoice(draft(), { balanceMinor: 0 })
    expect(empty.issues).toEqual({
      customer: 'Choose the customer, or Cash Sale.',
      lines: 'Add at least one product.'
    })
    expect(empty.input).toBeNull()

    let value = draft(
      { type: 'setCustomer', customer: toDraftCustomer(ali) },
      { type: 'addLine', product: tea }
    )
    const lineKey = line(value).key
    value = invoiceDraftReducer(value, {
      type: 'setRowPrice',
      lineKey,
      rowKey: rowKey(value, 0, 0),
      value: '1.234'
    })
    value = invoiceDraftReducer(value, { type: 'addFreeRow', lineKey })
    value = invoiceDraftReducer(value, { type: 'setLineField', lineKey, field: 'ctn', value: 'x' })
    value = invoiceDraftReducer(value, { type: 'setField', field: 'freight', value: '-5' })
    value = invoiceDraftReducer(value, { type: 'setField', field: 'invoiceDate', value: '' })
    expect(summarizeInvoice(value, { balanceMinor: 0 }).issues).toEqual({
      invoiceDate: 'Enter a valid date.',
      'lines.0.quantities.0.quantity': 'Enter a quantity from 1 to 1,000,000.',
      'lines.0.quantities.0.price': 'Use at most 2 decimal places.',
      'lines.0.freeQuantities.0.quantity': 'Enter a quantity from 1 to 1,000,000.',
      'lines.0.ctn': 'Enter a whole number from 0 to 1,000,000.',
      freight: 'The amount cannot be negative.'
    })
  })

  it('builds exactly the request the main process validates', () => {
    const value = teaSale(
      { type: 'setField', field: 'invoiceCode', value: ' B-17 ' },
      { type: 'setField', field: 'biltyNo', value: 'BL-1' },
      { type: 'setField', field: 'transportName', value: '' },
      { type: 'setField', field: 'addaName', value: 'Badami Bagh' },
      { type: 'setField', field: 'checkedBy', value: 'Waqas' },
      { type: 'setField', field: 'notes', value: '' }
    )
    const input = summarizeInvoice(value, { balanceMinor: 100_000 }).input
    expect(input).toEqual({
      requestId: 'invoice-request-0001',
      invoiceDate: TODAY,
      customerId: 2,
      priceTier: 'RETAIL',
      invoiceCode: 'B-17',
      biltyNo: 'BL-1',
      transportName: null,
      addaName: 'Badami Bagh',
      checkedBy: 'Waqas',
      notes: null,
      lines: [
        {
          productId: 1,
          quantities: [
            { unitId: 10, quantity: 5, unitPriceMinor: 11_000, priceOverride: false },
            { unitId: 11, quantity: 2, unitPriceMinor: 240_000, priceOverride: false }
          ],
          freeQuantities: [],
          discount: null,
          schemeMinor: 0,
          ctnCount: null
        }
      ],
      extraDiscountMinor: 0,
      freightMinor: 0,
      receivedMinor: 0,
      paymentMethod: null,
      paymentReference: null,
      currencyMinorDigits: 2
    })
    expect(InvoiceCreateSchema.safeParse(input).success).toBe(true)
  })

  it('refreshes a product after a price or stock change, keeping custom prices', () => {
    let value = teaSale()
    const lineKey = line(value).key
    value = invoiceDraftReducer(value, {
      type: 'setRowPrice',
      lineKey,
      rowKey: rowKey(value, 0, 0),
      value: '105'
    })
    const changed = {
      ...tea,
      stockQtyBase: 50,
      units: tea.units.map((item) =>
        item.id === 11 ? { ...item, retailPriceMinor: 250_000 } : item
      )
    }
    value = invoiceDraftReducer(value, { type: 'refreshProduct', product: changed })
    expect(line(value).product.stockQtyBase).toBe(50)
    expect(line(value).quantities.map((row) => row.price)).toEqual(['105', '2500.00'])
    expect(invoiceDraftReducer(value, { type: 'refreshProduct', product: sugar })).toBe(value)
  })

  it('removes a line, and a reset starts a new draft', () => {
    const value = teaSale({ type: 'addLine', product: sugar })
    const removed = invoiceDraftReducer(value, { type: 'removeLine', lineKey: line(value).key })
    expect(removed.lines.map((item) => item.product.code)).toEqual(['S-001'])
    const next = emptyInvoiceDraft({
      today: TODAY,
      minorDigits: 2,
      requestId: 'invoice-request-0002'
    })
    expect(invoiceDraftReducer(value, { type: 'reset', draft: next })).toBe(next)
  })
})
