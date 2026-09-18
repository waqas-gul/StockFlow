import { describe, expect, it } from 'vitest'
import {
  InvoiceCreateSchema,
  formatInvoiceNumber,
  invoiceBusinessDetails,
  salesmanPhoneText,
  type InvoiceCreateInput,
  type InvoiceLineInput
} from './invoices'

function line(overrides: Partial<InvoiceLineInput> = {}): InvoiceLineInput {
  return {
    productId: 1,
    quantities: [{ unitId: 10, quantity: 2, unitPriceMinor: 240_000, priceOverride: false }],
    freeQuantities: [],
    discount: null,
    schemeMinor: 0,
    ctnCount: null,
    ...overrides
  }
}

function invoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const input: InvoiceCreateInput = {
    requestId: 'invoice-request-0001',
    invoiceDate: '2026-09-16',
    customerId: 1,
    priceTier: 'RETAIL',
    invoiceCode: null,
    biltyNo: null,
    transportName: null,
    addaName: null,
    checkedBy: null,
    notes: null,
    lines: [line()],
    extraDiscountMinor: 0,
    freightMinor: 0,
    receivedMinor: 0,
    paymentMethod: null,
    paymentReference: null,
    currencyMinorDigits: 2
  }
  return { ...input, ...overrides }
}

function issues(value: unknown): Record<string, string[]> {
  const parsed = InvoiceCreateSchema.safeParse(value)
  if (parsed.success) return {}
  const result: Record<string, string[]> = {}
  for (const issue of parsed.error.issues) {
    ;(result[issue.path.map(String).join('.') || 'root'] ??= []).push(issue.message)
  }
  return result
}

describe('InvoiceCreateSchema', () => {
  it('accepts an invoice and trims its optional texts, blank becoming null', () => {
    const parsed = InvoiceCreateSchema.parse(
      invoice({
        invoiceCode: ' B-17 ',
        biltyNo: '',
        transportName: ' Daewoo ',
        checkedBy: ' Waqas '
      })
    )
    expect(parsed).toMatchObject({
      invoiceCode: 'B-17',
      biltyNo: null,
      transportName: 'Daewoo',
      checkedBy: 'Waqas'
    })
  })

  it('refuses unknown fields: unit sizes, amounts and totals always come from the main process', () => {
    const withSize = line()
    const quantities = [{ ...withSize.quantities[0], unitBaseQty: 24 }]
    expect(Object.keys(issues(invoice({ lines: [{ ...withSize, quantities }] })))).toEqual([
      'lines.0.quantities.0'
    ])
    expect(Object.keys(issues(invoice({ totalMinor: 480_000 })))).toEqual(['root'])
    expect(Object.keys(issues(invoice({ lines: [{ ...line(), grossMinor: 1 }] })))).toEqual([
      'lines.0'
    ])
  })

  it('requires at least one product line, and at least one paid quantity on each line', () => {
    expect(issues(invoice({ lines: [] }))).toEqual({ lines: ['Add at least one product.'] })
    expect(issues(invoice({ lines: [line({ quantities: [] })] }))).toEqual({
      'lines.0.quantities': ['Enter a quantity.']
    })
  })

  it('refuses a product on two lines, and a unit twice on one line', () => {
    expect(issues(invoice({ lines: [line(), line({ productId: 2 }), line()] }))).toEqual({
      'lines.2.productId': [
        'This product is already on line 1. Enter all its quantities on that line.'
      ]
    })
    const twice = line({
      quantities: [
        { unitId: 10, quantity: 1, unitPriceMinor: 240_000, priceOverride: false },
        { unitId: 10, quantity: 2, unitPriceMinor: 240_000, priceOverride: false }
      ],
      freeQuantities: [
        { unitId: 11, quantity: 1 },
        { unitId: 11, quantity: 1 }
      ]
    })
    expect(issues(invoice({ lines: [twice] }))).toEqual({
      'lines.0.quantities.1.unitId': ['This unit is already on the line.'],
      'lines.0.freeQuantities.1.unitId': ['This unit is already in the free quantity.']
    })
    // The same unit may be sold and given free on one line.
    const soldAndFree = line({ freeQuantities: [{ unitId: 10, quantity: 1 }] })
    expect(issues(invoice({ lines: [soldAndFree] }))).toEqual({})
  })

  it('takes quantities as positive whole numbers and prices, discounts and charges as amounts of zero or more', () => {
    const bad = line({
      quantities: [{ unitId: 10, quantity: 0, unitPriceMinor: -1, priceOverride: true }],
      freeQuantities: [{ unitId: 10, quantity: 1.5 }],
      discount: { type: 'PERCENT', bps: 10_001 },
      schemeMinor: -5,
      ctnCount: -1
    })
    expect(
      Object.keys(
        issues(
          invoice({ lines: [bad], extraDiscountMinor: -1, freightMinor: 0.5, receivedMinor: -1 })
        )
      ).sort()
    ).toEqual(
      [
        'lines.0.quantities.0.quantity',
        'lines.0.quantities.0.unitPriceMinor',
        'lines.0.freeQuantities.0.quantity',
        'lines.0.discount.bps',
        'lines.0.schemeMinor',
        'lines.0.ctnCount',
        'extraDiscountMinor',
        'freightMinor',
        'receivedMinor'
      ].sort()
    )
    expect(
      issues(invoice({ lines: [line({ discount: { type: 'AMOUNT', amountMinor: 1.25 } })] }))
    ).toEqual({ 'lines.0.discount.amountMinor': ['Enter a valid amount.'] })
    expect(
      Object.keys(issues(invoice({ lines: [line({ discount: { type: 'OFF' } as never })] })))
    ).toEqual(['lines.0.discount.type'])
    // A zero price is valid: a price the operator gives away.
    const zero = line({
      quantities: [{ unitId: 10, quantity: 1, unitPriceMinor: 0, priceOverride: true }]
    })
    expect(issues(invoice({ lines: [zero] }))).toEqual({})
  })

  it('needs an explicit price source: priceOverride is a required true or false', () => {
    const withoutFlag: Record<string, unknown> = { ...line().quantities[0] }
    delete withoutFlag.priceOverride
    expect(
      Object.keys(issues(invoice({ lines: [{ ...line(), quantities: [withoutFlag] }] })))
    ).toEqual(['lines.0.quantities.0.priceOverride'])
  })

  it('needs a payment method only when money is received', () => {
    expect(issues(invoice({ receivedMinor: 5000 }))).toEqual({
      paymentMethod: ['Choose how the money was received.']
    })
    expect(issues(invoice({ receivedMinor: 5000, paymentMethod: 'CASH' }))).toEqual({})
    expect(issues(invoice({ receivedMinor: 0, paymentMethod: 'CASH' }))).toEqual({})
    expect(Object.keys(issues(invoice({ receivedMinor: 5000, paymentMethod: 'CARD' })))).toEqual([
      'paymentMethod'
    ])
  })

  it('refuses an unknown price tier, a bad date and a bad request id', () => {
    expect(
      Object.keys(
        issues(invoice({ priceTier: 'SPECIAL', invoiceDate: '2026-02-30', requestId: 'x' }))
      ).sort()
    ).toEqual(['invoiceDate', 'priceTier', 'requestId'])
  })
})

describe('formatInvoiceNumber', () => {
  it('pads the sequence value and puts the prefix in front', () => {
    expect(formatInvoiceNumber('INV-', 6, 1)).toBe('INV-000001')
    expect(formatInvoiceNumber('SF.', 3, 12)).toBe('SF.012')
    expect(formatInvoiceNumber('', 4, 123_456)).toBe('123456')
  })
})

describe('invoiceBusinessDetails', () => {
  const settings = {
    'business.name': 'Iftikhar and Arshad Traders',
    'business.address': 'Shop 12, Main Bazar',
    'salesman.name': 'Mansoor Iqbal',
    'salesman.phone1': '03179927633',
    'salesman.phone2': '03463820629'
  }

  it('takes the shop and salesman from Settings', () => {
    expect(invoiceBusinessDetails(settings)).toEqual({
      shopName: 'Iftikhar and Arshad Traders',
      shopAddress: 'Shop 12, Main Bazar',
      salesmanName: 'Mansoor Iqbal',
      salesmanPhone1: '03179927633',
      salesmanPhone2: '03463820629'
    })
  })

  it('turns an empty address or phone into null', () => {
    expect(
      invoiceBusinessDetails({
        ...settings,
        'business.address': '',
        'salesman.phone1': ' ',
        'salesman.phone2': ''
      })
    ).toMatchObject({ shopAddress: null, salesmanPhone1: null, salesmanPhone2: null })
  })
})

describe('salesmanPhoneText', () => {
  it('writes the phones that are set, separated by a slash', () => {
    expect(salesmanPhoneText('03179927633', '03463820629')).toBe('03179927633 / 03463820629')
    expect(salesmanPhoneText('03179927633', null)).toBe('03179927633')
    expect(salesmanPhoneText(null, '03463820629')).toBe('03463820629')
    expect(salesmanPhoneText('', '03463820629')).toBe('03463820629')
  })

  it('is null without a phone', () => {
    expect(salesmanPhoneText(null, null)).toBeNull()
    expect(salesmanPhoneText('', '')).toBeNull()
  })
})
