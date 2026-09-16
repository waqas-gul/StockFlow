import { describe, expect, it } from 'vitest'
import type { InvoiceCreateInput, InvoiceSaveResult } from '@shared/invoices'
import type { AppError, Result } from '@shared/types/result'
import { singleFlight } from '@renderer/lib/single-flight'
import { invoiceFieldErrors, submitInvoice, type InvoiceSubmitHandlers } from './invoice-actions'

const input = { requestId: 'invoice-request-0001' } as InvoiceCreateInput

const saved = {
  id: 7,
  invoiceNo: 'INV-000007',
  balanceAfterMinor: 0,
  replayed: false
} as InvoiceSaveResult

interface Recorded {
  readonly handlers: InvoiceSubmitHandlers
  readonly saved: InvoiceSaveResult[]
  readonly fieldErrors: Array<Record<string, string>>
  readonly refreshed: number[][]
  readonly messages: string[]
}

function recorder(): Recorded {
  const recorded: Recorded = {
    saved: [],
    fieldErrors: [],
    refreshed: [],
    messages: [],
    handlers: {
      onSaved: (invoice) => recorded.saved.push(invoice),
      onFieldErrors: (errors) => recorded.fieldErrors.push(errors),
      onProductsChanged: async (productIds) => {
        recorded.refreshed.push(productIds)
      },
      notify: {
        success: (message) => recorded.messages.push(`success: ${message}`),
        error: (message) => recorded.messages.push(`error: ${message}`)
      }
    }
  }
  return recorded
}

function api(answers: Array<Result<InvoiceSaveResult> | Error>): {
  readonly sent: InvoiceCreateInput[]
  post(value: InvoiceCreateInput): Promise<Result<InvoiceSaveResult>>
} {
  const sent: InvoiceCreateInput[] = []
  return {
    sent,
    post: async (value) => {
      sent.push(value)
      const answer = answers.shift()
      if (answer === undefined) throw new Error('No answer queued.')
      if (answer instanceof Error) throw answer
      return answer
    }
  }
}

const failure = (error: AppError): Result<InvoiceSaveResult> => ({ ok: false, error })

describe('submitInvoice', () => {
  it('posts the invoice and reports it saved; a replayed request says it was already saved', async () => {
    const recorded = recorder()
    const backend = api([
      { ok: true, data: saved },
      { ok: true, data: { ...saved, replayed: true } }
    ])
    await expect(submitInvoice(backend, input, recorded.handlers)).resolves.toBe(true)
    await expect(submitInvoice(backend, input, recorded.handlers)).resolves.toBe(true)
    expect(recorded.saved.map((invoice) => invoice.replayed)).toEqual([false, true])
    expect(recorded.messages).toEqual([
      'success: Invoice INV-000007 saved successfully.',
      'success: Invoice INV-000007 was already saved.'
    ])
  })

  it('retries with the same request id after a lost answer, and a double click posts once', async () => {
    const recorded = recorder()
    const backend = api([new Error('IPC closed'), { ok: true, data: { ...saved, replayed: true } }])
    await expect(submitInvoice(backend, input, recorded.handlers)).resolves.toBe(false)
    expect(recorded.messages).toEqual(['error: The invoice could not be posted. Try again.'])
    await submitInvoice(backend, input, recorded.handlers)
    expect(backend.sent.map((value) => value.requestId)).toEqual([
      'invoice-request-0001',
      'invoice-request-0001'
    ])

    const once = api([{ ok: true, data: saved }])
    const post = singleFlight(() => submitInvoice(once, input, recorded.handlers))
    await Promise.all([post(), post(), post()])
    expect(once.sent).toHaveLength(1)
  })

  it('refreshes the lines when a configured price changed, instead of posting silently', async () => {
    const recorded = recorder()
    const backend = api([
      failure({
        code: 'PRICE_CHANGED',
        message:
          'The retail price of Box for P-001 Tea 950g is Rs 2,500.00, not Rs 2,400.00. Check the price and save again.',
        fieldErrors: {
          'lines.0.quantities.1.unitPriceMinor': ['The retail price is Rs 2,500.00.']
        },
        details: {
          prices: [
            {
              lineIndex: 0,
              quantityIndex: 1,
              productId: 1,
              unitId: 11,
              enteredPriceMinor: 240_000,
              configuredPriceMinor: 250_000
            }
          ]
        }
      })
    ])
    await expect(submitInvoice(backend, input, recorded.handlers)).resolves.toBe(false)
    expect(recorded.refreshed).toEqual([[1]])
    expect(recorded.fieldErrors).toEqual([
      { 'lines.0.quantities.1.price': 'The retail price is Rs 2,500.00.' }
    ])
    expect(recorded.messages).toEqual([
      'error: A price changed since it was entered, so nothing was posted. The line now shows the current price: check it and post again.'
    ])
  })

  it('shows a stock refusal on its line and reads the stock again', async () => {
    const recorded = recorder()
    const backend = api([
      failure({
        code: 'INSUFFICIENT_STOCK',
        message: 'Not enough stock of P-001 Tea 950g: 10 Box + 7 Piece in stock, 11 Box needed.',
        fieldErrors: { 'lines.0.quantities': ['Only 10 Box + 7 Piece in stock.'] },
        details: {
          shortages: [{ lineIndex: 0, productId: 1, availableQtyBase: 247, requestedQtyBase: 264 }]
        }
      })
    ])
    await submitInvoice(backend, input, recorded.handlers)
    expect(recorded.refreshed).toEqual([[1]])
    expect(recorded.fieldErrors).toEqual([
      { 'lines.0.quantities': 'Only 10 Box + 7 Piece in stock.' }
    ])
    expect(recorded.messages).toEqual([
      'error: Not enough stock of P-001 Tea 950g: 10 Box + 7 Piece in stock, 11 Box needed.'
    ])
  })

  it('shows the posting-date refusal, with the blocking customer or product and date, at the date', async () => {
    const recorded = recorder()
    const message =
      'C-00002 Ali Raza (Ali Traders) has account activity on 14-Sep-2026. Use that date or later.'
    await submitInvoice(
      api([
        failure({ code: 'DATE_NOT_ALLOWED', message, fieldErrors: { invoiceDate: [message] } })
      ]),
      input,
      recorded.handlers
    )
    expect(recorded.fieldErrors).toEqual([{ invoiceDate: message }])
    expect(recorded.messages).toEqual([`error: ${message}`])
    expect(recorded.refreshed).toEqual([])
  })

  it('shows the walk-in full-payment refusal at Received', async () => {
    const recorded = recorder()
    const message =
      'Walk-in sales must be paid in full. Select a customer account for credit sales.'
    await submitInvoice(
      api([failure({ code: 'VALIDATION', message, fieldErrors: { receivedMinor: [message] } })]),
      input,
      recorded.handlers
    )
    expect(recorded.fieldErrors).toEqual([{ received: message }])
    expect(recorded.messages).toEqual([`error: ${message}`])
  })
})

describe('invoiceFieldErrors', () => {
  it('puts every main-process field error on its screen field', () => {
    expect(
      invoiceFieldErrors({
        customerId: ['This customer is inactive.'],
        invoiceDate: ['Too early.'],
        lines: ['Add at least one product.'],
        'lines.1.productId': ['R-001 Rice 5kg is inactive.'],
        'lines.0.quantities.0.unitId': ['Tray is inactive.'],
        'lines.0.quantities.0.quantity': ['Too many.'],
        'lines.0.quantities.0.unitPriceMinor': ['The retail price is Rs 1.00.'],
        'lines.0.freeQuantities.1.unitId': ['This unit does not belong to the product.'],
        'lines.2.discount.bps': ['Enter a percentage from 0 to 100.'],
        'lines.2.schemeMinor': ['Too large.'],
        'lines.2.ctnCount': ['Whole number.'],
        'lines.3': ['The amounts on this line are too large.'],
        extraDiscountMinor: ['Too large.'],
        freightMinor: ['Negative.'],
        paymentMethod: ['Choose how the money was received.'],
        notes: ['Use at most 500 characters.'],
        root: ['The invoice amounts are too large.'],
        'lines.0.quantities.0': ['Unknown field.']
      })
    ).toEqual({
      customer: 'This customer is inactive.',
      invoiceDate: 'Too early.',
      lines: 'Add at least one product.',
      'lines.1.product': 'R-001 Rice 5kg is inactive.',
      'lines.0.quantities.0.unitId': 'Tray is inactive.',
      'lines.0.quantities.0.quantity': 'Too many.',
      'lines.0.quantities.0.price': 'The retail price is Rs 1.00.',
      'lines.0.freeQuantities.1.unitId': 'This unit does not belong to the product.',
      'lines.2.discount': 'Enter a percentage from 0 to 100.',
      'lines.2.scheme': 'Too large.',
      'lines.2.ctn': 'Whole number.',
      'lines.3.amounts': 'The amounts on this line are too large.',
      extraDiscount: 'Too large.',
      freight: 'Negative.',
      paymentMethod: 'Choose how the money was received.',
      notes: 'Use at most 500 characters.',
      root: 'The invoice amounts are too large. Unknown field.'
    })
    expect(invoiceFieldErrors(undefined)).toEqual({})
  })
})
