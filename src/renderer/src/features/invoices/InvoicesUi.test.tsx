import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { CustomerListItem } from '@shared/customers'
import type { InvoiceContext } from '@shared/invoices'
import type { Product, ProductUnit } from '@shared/products'
import {
  emptyInvoiceDraft,
  invoiceDraftReducer,
  toDraftCustomer,
  type InvoiceDraft,
  type InvoiceDraftAction
} from './invoice-draft'
import { summarizeInvoice } from './invoice-summary'
import { InvoiceEditor, type InvoiceEditorProps } from './InvoiceEditor'
import { PostInvoiceConfirmation } from './PostInvoiceDialog'

const RS = { minorDigits: 2, symbol: 'Rs' }
const TODAY = '2026-09-16'

const context: InvoiceContext = {
  today: TODAY,
  nextInvoiceNo: 'INV-000003',
  earliestDate: '2026-09-12',
  earliestDateSetBy: { kind: 'CUSTOMER', id: 2, code: 'C-00002', name: 'Ali Raza' }
}

function unit(overrides: Partial<ProductUnit>): ProductUnit {
  return {
    id: 10,
    name: 'Piece',
    shortName: null,
    baseQty: 1,
    isBase: true,
    canSell: true,
    canPurchase: true,
    wholesalePriceMinor: 10_000,
    retailPriceMinor: 11_000,
    defaultCostMinor: null,
    sortOrder: 0,
    isActive: true,
    ...overrides
  }
}

const tea: Product = {
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
  units: [
    unit({}),
    unit({
      id: 11,
      name: 'Box',
      baseQty: 24,
      isBase: false,
      retailPriceMinor: 240_000,
      wholesalePriceMinor: null,
      sortOrder: 1
    })
  ],
  hasStockMovements: true,
  createdAt: '2026-09-10T10:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z'
}

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

function draft(...actions: InvoiceDraftAction[]): InvoiceDraft {
  return actions.reduce(
    invoiceDraftReducer,
    emptyInvoiceDraft({ today: TODAY, minorDigits: 2, requestId: 'invoice-request-0001' })
  )
}

/** Ali buys 2 Box + 5 Piece of tea; the Box price is typed over. */
function teaDraft(...more: InvoiceDraftAction[]): InvoiceDraft {
  let value = draft(
    { type: 'setCustomer', customer: toDraftCustomer(ali) },
    { type: 'addLine', product: tea }
  )
  const lineKey = value.lines[0].key
  value = invoiceDraftReducer(value, {
    type: 'setRowQuantity',
    lineKey,
    rowKey: value.lines[0].quantities[0].key,
    value: '5'
  })
  value = invoiceDraftReducer(value, { type: 'addQuantityRow', lineKey })
  const boxKey = value.lines[0].quantities[1].key
  value = invoiceDraftReducer(value, {
    type: 'setRowQuantity',
    lineKey,
    rowKey: boxKey,
    value: '2'
  })
  value = invoiceDraftReducer(value, {
    type: 'setRowPrice',
    lineKey,
    rowKey: boxKey,
    value: '2,250'
  })
  return more.reduce(invoiceDraftReducer, value)
}

const noop = (): void => undefined

function render(value: InvoiceDraft, overrides: Partial<InvoiceEditorProps> = {}): string {
  const balanceMinor = overrides.customerBalanceMinor ?? value.customer?.balanceMinor ?? 0
  const summary = summarizeInvoice(value, { balanceMinor })
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <InvoiceEditor
          draft={value}
          summary={summary}
          currency={RS}
          context={context}
          customerBalanceMinor={balanceMinor}
          walkInAvailable
          errors={{}}
          posting={false}
          dispatch={noop}
          onPickCustomer={noop}
          onCashSale={noop}
          onAddProduct={noop}
          onPost={noop}
          onClear={noop}
          {...overrides}
        />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function postButton(html: string): string {
  const match = /<button[^>]*>(?:(?!<\/button>).)*Post Invoice(?:(?!<\/button>).)*<\/button>/s.exec(
    html
  )
  if (match === null) throw new Error('No Post Invoice button.')
  return match[0]
}

describe('New Invoice screen', () => {
  it('asks for the header fields and shows the next number only as a preview', () => {
    const html = render(draft())
    const shown = text(html)
    for (const expected of [
      'New Invoice',
      'Next invoice number INV-000003 (assigned when the invoice is posted)',
      'Customer',
      'Cash Sale',
      'Invoice Date',
      'Earliest allowed: 12-Sep-2026 (C-00002 Ali Raza has later account activity).',
      'Price Tier',
      'Retail',
      'Wholesale',
      'Invoice Code',
      'Bilty No',
      'Transport',
      'Adda',
      'Checked By',
      'Notes',
      'Add Product',
      'No products yet.',
      'Clear',
      'Post Invoice'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(html).toMatch(/<input[^>]*type="date"[^>]*min="2026-09-12"[^>]*max="2026-09-16"/)
    expect(html).toContain('placeholder="Code, product or company"')
  })

  it("shows the chosen customer's current balance as Due, Advance or Settled", () => {
    const value = draft({ type: 'setCustomer', customer: toDraftCustomer(ali) })
    expect(text(render(value))).toContain('Current balance Rs 1,000.00 Due')
    expect(text(render(value, { customerBalanceMinor: -5_000 }))).toContain(
      'Current balance Rs 50.00 Advance'
    )
    expect(text(render(value, { customerBalanceMinor: 0 }))).toContain('Current balance Settled')
  })

  it('makes a walk-in sale a cash sale: Received follows the total and cannot be typed', () => {
    const walkIn = toDraftCustomer({
      ...ali,
      id: 1,
      code: 'C-00001',
      name: 'Cash / Walk-in',
      shopName: null,
      balanceMinor: 0
    })
    const html = render(teaDraft({ type: 'setCustomer', customer: walkIn }))
    const shown = text(html)
    expect(shown).toContain(
      'Cash Sale: paid in full at the counter. Choose a customer account for credit.'
    )
    expect(html).toMatch(
      /<input[^>]*id="invoice-received"[^>]*readOnly=""[^>]*value="5,050.00"|<input[^>]*id="invoice-received"[^>]*value="5,050.00"[^>]*readOnly=""/
    )
    expect(shown).toContain('Received equals the total for a cash sale.')
    expect(shown).toContain('Net Outstanding Settled')
  })

  it('shows a line with its packing, unit rows, custom price marker, amounts and stock in units', () => {
    const shown = text(render(teaDraft()))
    for (const expected of [
      'P-001 Tea 950g',
      'Tapal',
      'Packing 1*12*18',
      'In stock 10 Box + 7 Piece',
      'Unit Quantity Unit Price Amount',
      'Rs 550.00',
      'Custom price',
      'Use list price',
      'Rs 4,500.00',
      'Leaving stock 2 Box + 5 Piece',
      'Add unit',
      'Free scheme quantity',
      'Add free quantity',
      'Discount',
      'Scheme amount',
      'Ctn',
      'Gross Rs 5,050.00',
      'Net Rs 5,050.00'
    ]) {
      expect(shown).toContain(expected)
    }
    expect(shown).not.toMatch(/base unit|qty_base|base quantity/i)
  })

  it('asks for a custom price when the unit has no price for the tier', () => {
    const value = teaDraft({ type: 'setPriceTier', tier: 'WHOLESALE' })
    const withBlankBox = invoiceDraftReducer(value, {
      type: 'setRowPrice',
      lineKey: value.lines[0].key,
      rowKey: value.lines[0].quantities[1].key,
      value: ''
    })
    expect(text(render(withBlankBox))).toContain('No wholesale price: enter a custom price.')
  })

  it('warns inline and disables Post Invoice when a line needs more than the stock', () => {
    const value = teaDraft()
    const over = invoiceDraftReducer(value, {
      type: 'setRowQuantity',
      lineKey: value.lines[0].key,
      rowKey: value.lines[0].quantities[1].key,
      value: '11'
    })
    const html = render(over)
    expect(text(html)).toContain(
      'Only 10 Box + 7 Piece in stock; this line needs 11 Box + 5 Piece.'
    )
    expect(postButton(html)).toContain('disabled=""')
    expect(postButton(render(value))).not.toContain('disabled=""')
    expect(postButton(render(value, { posting: true }))).toContain('disabled=""')
  })

  it('shows main-process refusals at their fields: the date floor and the stock of a line', () => {
    const shown = text(
      render(teaDraft(), {
        errors: {
          invoiceDate:
            'C-00002 Ali Raza (Ali Traders) has account activity on 14-Sep-2026. Use that date or later.',
          'lines.0.quantities': 'Only 1 Box in stock.',
          'lines.0.quantities.1.price': 'The retail price is Rs 2,500.00.',
          received:
            'Walk-in sales must be paid in full. Select a customer account for credit sales.',
          root: 'The invoice amounts are too large.'
        }
      })
    )
    for (const expected of [
      'C-00002 Ali Raza (Ali Traders) has account activity on 14-Sep-2026. Use that date or later.',
      'Only 1 Box in stock.',
      'The retail price is Rs 2,500.00.',
      'Walk-in sales must be paid in full. Select a customer account for credit sales.',
      'The invoice amounts are too large.'
    ]) {
      expect(shown).toContain(expected)
    }
  })

  it('totals the invoice and shows the account after it; money received needs a payment method', () => {
    const value = teaDraft(
      { type: 'setField', field: 'extraDiscount', value: '50' },
      { type: 'setField', field: 'freight', value: '100' },
      { type: 'setField', field: 'received', value: '6,100' }
    )
    const shown = text(render(value))
    for (const expected of [
      'Gross Rs 5,050.00',
      'Line Discounts Rs 0.00',
      'Scheme Discounts Rs 0.00',
      'Extra Discount',
      'Net Invoice Rs 5,000.00',
      'Freight',
      'Total Rs 5,100.00',
      'Previous Balance Rs 1,000.00 Due',
      'Received',
      'Net Outstanding Settled',
      'Payment Method',
      'Payment Reference'
    ]) {
      expect(shown).toContain(expected)
    }
    const advance = text(
      render(invoiceDraftReducer(value, { type: 'setField', field: 'received', value: '7,000' }))
    )
    expect(advance).toContain('Net Outstanding Rs 900.00 Advance')
    const credit = text(
      render(invoiceDraftReducer(value, { type: 'setField', field: 'received', value: '' }))
    )
    expect(credit).toContain('Net Outstanding Rs 6,100.00 Due')
    expect(credit).not.toContain('Payment Method')
  })
})

describe('Post Invoice confirmation', () => {
  it('sums up the customer, items, total, received and the account after posting', () => {
    const shown = text(
      renderToStaticMarkup(
        <PostInvoiceConfirmation
          customerLabel="C-00002 Ali Raza (Ali Traders)"
          walkIn={false}
          itemCount={2}
          totalMinor={510_000}
          receivedMinor={100_000}
          netOutstandingMinor={510_000}
          currency={RS}
          posting={false}
          onCancel={noop}
          onConfirm={noop}
        />
      )
    )
    for (const expected of [
      'Customer C-00002 Ali Raza (Ali Traders)',
      'Items 2 products',
      'Invoice total Rs 5,100.00',
      'Received Rs 1,000.00',
      'Account after posting Rs 5,100.00 Due',
      'Back',
      'Post Invoice'
    ]) {
      expect(shown).toContain(expected)
    }
    const cash = text(
      renderToStaticMarkup(
        <PostInvoiceConfirmation
          customerLabel="C-00001 Cash / Walk-in"
          walkIn
          itemCount={1}
          totalMinor={5_000}
          receivedMinor={5_000}
          netOutstandingMinor={0}
          currency={RS}
          posting
          onCancel={noop}
          onConfirm={noop}
        />
      )
    )
    expect(cash).toContain('Items 1 product')
    expect(cash).toContain('Cash sale: paid in full')
    expect(cash).toContain('Posting…')
  })
})
