import { describe, expect, it } from 'vitest'
import type { ProductUnit } from '@shared/products'
import type {
  StockAdjustmentResult,
  StockAdjustmentSummary,
  StockReceiptDetail,
  StockReceiptLine
} from '@shared/stock'
import type { Result } from '@shared/types/result'
import {
  adjustmentFieldSet,
  adjustmentFormSchema,
  emptyAdjustmentForm,
  receiptLineLabel,
  recordedUnitCostText,
  serverAdjustmentErrors,
  toAdjustmentInput,
  withReceiptLine,
  type AdjustmentFormValues
} from './adjustment-form'
import {
  emptyReceiptForm,
  linePreview,
  newReceiptLine,
  projectedSupplierBalance,
  purchasableUnits,
  receiptFormSchema,
  receiptTotal,
  serverReceiptErrors,
  toReceiptInput,
  withProduct,
  withUnit,
  type ReceiptFormValues
} from './receipt-form'
import { submitAdjustment, submitReceipt, submitVoid, type StockNotifier } from './stock-actions'
import {
  adjustmentQuantityText,
  averageUnitCost,
  isLowStock,
  movementLabel,
  quantityInUnits,
  signedAmount
} from './stock-display'

const RS = { minorDigits: 2, symbol: 'Rs' }

function unit(overrides: Partial<ProductUnit>): ProductUnit {
  return {
    id: 1,
    name: 'Piece',
    shortName: 'Pcs',
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

const piece = unit({ id: 1, defaultCostMinor: 11000 })
const box = unit({
  id: 2,
  name: 'Box',
  shortName: 'Box',
  baseQty: 24,
  isBase: false,
  defaultCostMinor: 240000,
  sortOrder: 1
})
const tea = { id: 7, code: 'P-001', name: 'Tea 950g', units: [piece, box] }

type Issues = Record<string, string[]>

function issuesOf(result: {
  success: boolean
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> }
}): Issues {
  const issues: Issues = {}
  for (const issue of result.error?.issues ?? []) {
    ;(issues[issue.path.map(String).join('.')] ??= []).push(issue.message)
  }
  return issues
}

describe('stock display helpers', () => {
  it('names movements by reason or type, and shows stock in the product units', () => {
    expect(movementLabel({ type: 'STOCK_IN', reason: null })).toBe('Stock In')
    expect(movementLabel({ type: 'ADJUST_OUT', reason: 'DAMAGE' })).toBe('Damage')
    expect(movementLabel({ type: 'COST_CORRECTION', reason: 'RECEIPT_COST_CORRECTION' })).toBe(
      'Receipt Cost Correction'
    )
    expect(quantityInUnits(187, [piece, box])).toBe('7 Box + 19 Piece')
    expect(quantityInUnits(0, [piece, box])).toBe('0 Piece')
  })

  it('flags low stock only when a level is set', () => {
    expect(isLowStock({ stockQtyBase: 24, lowStockThresholdBase: 24 })).toBe(true)
    expect(isLowStock({ stockQtyBase: 25, lowStockThresholdBase: 24 })).toBe(false)
    expect(isLowStock({ stockQtyBase: 0, lowStockThresholdBase: 0 })).toBe(false)
  })

  it('shows signed quantities and amounts, and the average cost of a unit', () => {
    const summary = { direction: 'OUT', quantity: 3, unitName: 'Box' } as StockAdjustmentSummary
    expect(adjustmentQuantityText(summary)).toBe('−3 Box')
    expect(adjustmentQuantityText({ ...summary, direction: 'IN' })).toBe('+3 Box')
    expect(adjustmentQuantityText({ ...summary, direction: 'VALUE', quantity: null })).toBe('—')
    expect(signedAmount(-125050, RS)).toBe('−Rs 1,250.50')
    expect(signedAmount(240, RS)).toBe('+Rs 2.40')
    expect(signedAmount(0, RS)).toBe('Rs 0.00')
    expect(averageUnitCost({ qtyBase: 3, valueMinor: 100 }, 1)).toBe(33)
    expect(averageUnitCost({ qtyBase: 2, valueMinor: 67 }, 1)).toBe(34)
    expect(averageUnitCost({ qtyBase: 240, valueMinor: 15000 }, 24)).toBe(1500)
    expect(averageUnitCost({ qtyBase: 0, valueMinor: 0 }, 24)).toBeNull()
  })
})

describe('receipt form', () => {
  function values(overrides: Partial<ReceiptFormValues> = {}): ReceiptFormValues {
    const line = withProduct(newReceiptLine(), tea, 2)
    return { ...emptyReceiptForm('2026-09-16'), lines: [{ ...line, quantity: '10' }], ...overrides }
  }

  it('picks the first purchasable unit and its default cost; a unit change fills a blank cost only', () => {
    const noPurchasePiece = { ...tea, units: [{ ...piece, canPurchase: false }, box] }
    expect(purchasableUnits(noPurchasePiece.units)).toEqual([box])
    const line = withProduct(newReceiptLine(), noPurchasePiece, 2)
    expect(line).toMatchObject({
      productId: 7,
      productLabel: 'P-001 Tea 950g',
      unitId: '2',
      unitCost: '2400.00'
    })
    expect(withUnit({ ...line, unitCost: '' }, piece, 2).unitCost).toBe('110.00')
    expect(withUnit({ ...line, unitCost: '2,350' }, piece, 2)).toMatchObject({
      unitId: '1',
      unitCost: '2,350'
    })
    expect(
      withProduct(newReceiptLine(), { ...tea, units: [unit({ canPurchase: false })] }, 2).unitId
    ).toBe('')
  })

  it('parses typed costs and quantities into the receipt input', () => {
    const form = values({ reference: '' })
    form.lines[0] = { ...form.lines[0], unitId: '2', quantity: '1,000', unitCost: '2,400.50' }
    const parsed = receiptFormSchema(2).safeParse(form)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(toReceiptInput(parsed.data, 'request-0001', 2)).toEqual({
      requestId: 'request-0001',
      receiptDate: '2026-09-16',
      supplierId: null,
      supplierName: null,
      supplierBillNo: null,
      reference: null,
      note: null,
      paidNow: null,
      currencyMinorDigits: 2,
      lines: [{ productId: 7, unitId: 2, quantity: 1000, unitCostMinor: 240050 }]
    })
  })

  it('makes a supplier purchase with a bill number and money paid now', () => {
    const form = values({
      ...emptyReceiptForm('2026-09-16', { id: 3, label: 'SUP-00003 ABC Distributors' }),
      supplierBillNo: ' ABC-101 ',
      paidNowAmount: '20,000',
      paidNowMethod: 'BANK',
      paidNowReference: ' TT-55 '
    })
    form.lines = values().lines
    const parsed = receiptFormSchema(2).safeParse(form)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(toReceiptInput(parsed.data, 'request-0002', 2)).toMatchObject({
      supplierId: 3,
      supplierName: null,
      supplierBillNo: 'ABC-101',
      paidNow: { amountMinor: 2_000_000, method: 'BANK', reference: 'TT-55' }
    })
    // Nothing paid now: no payment at all, never a zero one.
    for (const nothing of ['', '0', '0.00']) {
      const none = receiptFormSchema(2).safeParse({ ...form, paidNowAmount: nothing })
      expect(none.success && none.data.paidNow).toBe(null)
    }
  })

  it('refuses money paid now without a supplier account, and an invalid amount', () => {
    expect(issuesOf(receiptFormSchema(2).safeParse(values({ paidNowAmount: '100' })))).toEqual({
      paidNowAmount: ['Choose the supplier to record a payment with the receipt.']
    })
    const supplier = emptyReceiptForm('2026-09-16', { id: 3, label: 'SUP-00003 X' })
    expect(
      issuesOf(
        receiptFormSchema(2).safeParse(
          values({ ...supplier, lines: values().lines, paidNowAmount: '1.234' })
        )
      )
    ).toEqual({ paidNowAmount: ['Use at most 2 decimal places.'] })
  })

  it('projects the supplier balance: current + purchase − paid now', () => {
    expect(projectedSupplierBalance(1_000_000, 5_000_000, '20,000', 2)).toEqual({
      paidNowMinor: 2_000_000,
      afterMinor: 4_000_000
    })
    expect(projectedSupplierBalance(0, 5_000_000, '', 2)).toEqual({
      paidNowMinor: 0,
      afterMinor: 5_000_000
    })
    // More than is owed: a supplier advance (negative).
    expect(projectedSupplierBalance(0, 1_000_000, '15,000', 2).afterMinor).toBe(-500_000)
    expect(projectedSupplierBalance(0, null, '1', 2)).toEqual({
      paidNowMinor: 100,
      afterMinor: null
    })
    expect(projectedSupplierBalance(0, 100, 'x', 2)).toEqual({
      paidNowMinor: null,
      afterMinor: null
    })
  })

  it('sends paid-now and supplier errors of the main process to their fields', () => {
    expect(
      serverReceiptErrors({
        supplierId: ['This supplier is inactive.'],
        'paidNow.amountMinor': ['Enter an amount greater than zero.'],
        paidNow: ['Choose the supplier to record a payment with the receipt.'],
        'paidNow.method': ['Choose the payment method.'],
        supplierBillNo: ['Use at most 40 characters.']
      })
    ).toEqual([
      ['supplierId', 'This supplier is inactive.'],
      ['paidNowAmount', 'Enter an amount greater than zero.'],
      ['paidNowAmount', 'Choose the supplier to record a payment with the receipt.'],
      ['paidNowMethod', 'Choose the payment method.'],
      ['supplierBillNo', 'Use at most 40 characters.']
    ])
  })

  it('accepts a zero cost and refuses a missing product, unit, quantity or cost', () => {
    const free = values()
    free.lines[0] = { ...free.lines[0], unitCost: '0' }
    expect(receiptFormSchema(2).safeParse(free).success).toBe(true)

    const bad = values({ receiptDate: '2026-02-30' })
    bad.lines = [
      { ...newReceiptLine(), quantity: '2', unitCost: '5' },
      { ...values().lines[0], unitId: '', quantity: '0', unitCost: '' },
      { ...values().lines[0], unitCost: '1.234' }
    ]
    expect(issuesOf(receiptFormSchema(2).safeParse(bad))).toEqual({
      receiptDate: ['Enter a valid date.'],
      'lines.1.quantity': ['Enter a whole number from 1 to 1,000,000.'],
      'lines.1.unitCost': ['Enter the unit cost (0 for free goods).'],
      'lines.2.unitCost': ['Use at most 2 decimal places.']
    })
    const unpicked = values()
    unpicked.lines = [
      { ...newReceiptLine(), quantity: '2', unitCost: '5' },
      { ...values().lines[0], unitId: '' }
    ]
    expect(issuesOf(receiptFormSchema(2).safeParse(unpicked))).toEqual({
      'lines.0.productId': ['Choose a product.'],
      'lines.1.unitId': ['Choose the unit.']
    })
  })

  it('previews each line in base units with its exact cost, and the receipt total', () => {
    const units = [piece, box]
    const boxes = linePreview({ unitId: '2', quantity: '10', unitCost: '2,400' }, units, 2)
    expect(boxes).toEqual({ qtyBase: 240, lineCostMinor: 2400000 })
    const pieces = linePreview({ unitId: '1', quantity: '5', unitCost: '110.50' }, units, 2)
    expect(pieces).toEqual({ qtyBase: 5, lineCostMinor: 55250 })
    const partial = linePreview({ unitId: '', quantity: '5', unitCost: 'x' }, units, 2)
    expect(partial).toEqual({ qtyBase: null, lineCostMinor: null })
    expect(receiptTotal([boxes, pieces, partial])).toBe(2455250)
    expect(receiptTotal([partial])).toBeNull()
  })

  it('puts main-process errors on the matching form fields', () => {
    expect(
      serverReceiptErrors({
        receiptDate: ['P-001 Tea 950g has stock activity on 15-Sep-2026. Use that date or later.'],
        'lines.1.unitId': ['This unit is inactive.'],
        'lines.0.unitCostMinor': ['The amount is too large.'],
        lines: ['Add at least one product line.'],
        requestId: ['The request is not valid.']
      })
    ).toEqual([
      ['receiptDate', 'P-001 Tea 950g has stock activity on 15-Sep-2026. Use that date or later.'],
      ['lines.1.unitId', 'This unit is inactive.'],
      ['lines.0.unitCost', 'The amount is too large.'],
      ['lines.root', 'Add at least one product line.'],
      ['root', 'The request is not valid.']
    ])
  })
})

describe('adjustment form', () => {
  function form(overrides: Partial<AdjustmentFormValues>): AdjustmentFormValues {
    return {
      ...emptyAdjustmentForm('2026-09-16'),
      productId: 7,
      productLabel: 'P-001 Tea 950g',
      reasonNote: 'Counted',
      ...overrides
    }
  }

  it('shows only the fields a reason uses', () => {
    expect(adjustmentFieldSet('DAMAGE', '', true)).toMatchObject({
      product: true,
      quantity: true,
      cost: false,
      direction: false,
      receipt: false
    })
    expect(adjustmentFieldSet('OPENING_STOCK', '', null)).toMatchObject({
      product: true,
      quantity: true,
      cost: true
    })
    expect(adjustmentFieldSet('COUNT_SURPLUS', '', true)).toMatchObject({
      cost: false,
      valuationNote: 'Valued at the current average cost.'
    })
    expect(adjustmentFieldSet('COUNT_SURPLUS', '', false)).toMatchObject({ cost: true })
    expect(adjustmentFieldSet('RECEIPT_QTY_CORRECTION', 'IN', true)).toMatchObject({
      receipt: true,
      product: false,
      direction: true,
      quantity: true,
      cost: false,
      valuationNote: "Added at the receipt line's cost."
    })
    expect(adjustmentFieldSet('RECEIPT_COST_CORRECTION', '', true)).toMatchObject({
      receipt: true,
      quantity: false,
      cost: true,
      costLabel: 'Correct unit cost'
    })
    expect(adjustmentFieldSet('OTHER_CORRECTION', 'IN', true).cost).toBe(true)
    expect(adjustmentFieldSet('OTHER_CORRECTION', 'OUT', true).cost).toBe(false)
  })

  it('builds the adjustment input with unused fields empty', () => {
    const parsed = adjustmentFormSchema(2).safeParse(
      form({ reason: 'DAMAGE', unitId: '2', quantity: '3', unitCost: '999', direction: 'IN' })
    )
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(toAdjustmentInput(parsed.data, 'request-0002', 2)).toEqual({
      requestId: 'request-0002',
      adjustmentDate: '2026-09-16',
      productId: 7,
      reason: 'DAMAGE',
      direction: null,
      unitId: 2,
      quantity: 3,
      unitCostMinor: null,
      receiptItemId: null,
      reasonNote: 'Counted',
      currencyMinorDigits: 2
    })
    const cost = adjustmentFormSchema(2).safeParse(
      form({
        reason: 'RECEIPT_COST_CORRECTION',
        productId: 7,
        receiptId: 3,
        receiptItemId: '9',
        unitId: '2',
        quantity: '4',
        unitCost: '1,700'
      })
    )
    expect(cost.success && cost.data).toMatchObject({
      unitId: null,
      quantity: null,
      unitCostMinor: 170000,
      receiptItemId: 9
    })
  })

  it('reports the missing fields of each reason with the shared rules', () => {
    expect(
      issuesOf(adjustmentFormSchema(2).safeParse(form({ reason: '', reasonNote: '' })))
    ).toEqual({
      reason: ['Choose a reason.'],
      reasonNote: ['Enter the reason note.']
    })
    expect(
      issuesOf(
        adjustmentFormSchema(2).safeParse(form({ reason: 'OPENING_STOCK', productId: null }))
      )
    ).toEqual({
      productId: ['Choose a product.'],
      unitId: ['Choose the unit.'],
      quantity: ['Enter the quantity.'],
      unitCost: ['Enter the unit cost.']
    })
    expect(
      issuesOf(
        adjustmentFormSchema(2).safeParse(
          form({ reason: 'OTHER_CORRECTION', unitId: '1', quantity: '2' })
        )
      )
    ).toEqual({
      direction: ['Choose whether stock is added or removed.']
    })
    expect(
      issuesOf(
        adjustmentFormSchema(2).safeParse(
          form({ reason: 'RECEIPT_QTY_CORRECTION', direction: 'OUT', unitId: '1', quantity: 'two' })
        )
      )
    ).toEqual({
      receiptId: ['Choose the receipt.'],
      quantity: ['Enter a whole number from 1 to 1,000,000.'],
      receiptItemId: ['Choose the receipt line to correct.']
    })
    expect(
      issuesOf(
        adjustmentFormSchema(2).safeParse(
          form({ reason: 'COUNT_SURPLUS', unitId: '1', quantity: '2', unitCost: '1.999' })
        )
      )
    ).toEqual({
      unitCost: ['Use at most 2 decimal places.']
    })
  })

  it('takes the product and unit from the chosen receipt line, and shows its recorded cost', () => {
    const line = {
      id: 9,
      lineNo: 2,
      productId: 7,
      productCode: 'P-001',
      productName: 'Tea 950g',
      unitId: 2,
      unitName: 'Box',
      quantity: 10,
      unitCostMinor: 150000,
      lineCostMinor: 1500000,
      correctedLineCostMinor: 1700000
    } as StockReceiptLine
    expect(withReceiptLine(form({ productId: null }), line)).toMatchObject({
      receiptItemId: '9',
      productId: 7,
      productLabel: 'P-001 Tea 950g',
      unitId: '2'
    })
    expect(withReceiptLine(form({}), undefined)).toMatchObject({
      receiptItemId: '',
      productId: null,
      unitId: ''
    })
    expect(recordedUnitCostText(line, 2)).toBe('1700.00')
    expect(receiptLineLabel(line, 'Rs 1,700.00')).toBe(
      'Line 2 · P-001 Tea 950g · 10 Box @ Rs 1,700.00'
    )
    expect(
      serverAdjustmentErrors({ unitCostMinor: ['x'], quantity: ['y'], requestId: ['z'] })
    ).toEqual([
      ['unitCost', 'x'],
      ['quantity', 'y'],
      ['root', 'z']
    ])
  })
})

describe('stock actions', () => {
  function notifier(): StockNotifier & { log: string[] } {
    const log: string[] = []
    return {
      log,
      success: (message) => log.push(`success: ${message}`),
      error: (message) => log.push(`error: ${message}`),
      warning: (message) => log.push(`warning: ${message}`)
    }
  }

  it('reports a saved receipt, field errors, and a failed call', async () => {
    const notify = notifier()
    const saved: unknown[] = []
    const fields: Array<[string, string]> = []
    const handlers = {
      onSaved: (item: StockReceiptDetail) => saved.push(item.receiptNo),
      onFieldError: (path: string, message: string) => fields.push([path, message]),
      notify
    }
    const input = {} as never
    await expect(
      submitReceipt(
        {
          receive: async () => ({
            ok: true,
            data: { receiptNo: 'GRN-000004' } as StockReceiptDetail
          })
        },
        input,
        handlers
      )
    ).resolves.toBe(true)
    const refused: Result<StockReceiptDetail> = {
      ok: false,
      error: {
        code: 'DATE_NOT_ALLOWED',
        message: 'Blocked.',
        fieldErrors: { receiptDate: ['Blocked.'] }
      }
    }
    await expect(submitReceipt({ receive: async () => refused }, input, handlers)).resolves.toBe(
      false
    )
    await expect(
      submitReceipt({ receive: () => Promise.reject(new Error('ipc')) }, input, handlers)
    ).resolves.toBe(false)
    expect(saved).toEqual(['GRN-000004'])
    expect(fields).toEqual([['receiptDate', 'Blocked.']])
    expect(notify.log).toEqual([
      'success: Receipt GRN-000004 saved.',
      'error: Blocked.',
      'error: The receipt could not be saved. Try again.'
    ])
  })

  it('shows the L1 warning after a late cost correction, and reports voids', async () => {
    const notify = notifier()
    const handlers = { onSaved: () => undefined, onFieldError: () => undefined, notify }
    const result = {
      adjustmentNo: 'ADJ-000002',
      reason: 'RECEIPT_COST_CORRECTION',
      warning: 'Past COGS will not be recalculated.'
    } as StockAdjustmentResult
    await submitAdjustment(
      { adjust: async () => ({ ok: true, data: result }) },
      {} as never,
      handlers
    )
    await submitAdjustment(
      { adjust: async () => ({ ok: true, data: { ...result, reason: 'DAMAGE', warning: null } }) },
      {} as never,
      handlers
    )
    await expect(
      submitVoid(
        {
          voidReceipt: async () => ({
            ok: true,
            data: { receiptNo: 'GRN-000001' } as StockReceiptDetail
          })
        },
        { id: 1, reason: 'x' },
        notify
      )
    ).resolves.toMatchObject({ receiptNo: 'GRN-000001' })
    await expect(
      submitVoid(
        {
          voidReceipt: async () => ({
            ok: false,
            error: { code: 'FORBIDDEN_STATE', message: 'Locked.' }
          })
        },
        { id: 1, reason: 'x' },
        notify
      )
    ).resolves.toBeNull()
    expect(notify.log).toEqual([
      'warning: Receipt Cost Correction ADJ-000002 saved. Past COGS will not be recalculated.',
      'success: Damage ADJ-000002 saved.',
      'success: Receipt GRN-000001 voided.',
      'error: Locked.'
    ])
  })
})
