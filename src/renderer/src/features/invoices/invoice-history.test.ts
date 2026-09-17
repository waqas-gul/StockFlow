import { describe, expect, it } from 'vitest'
import type {
  InvoiceDispatchResult,
  InvoiceDispatchUpdateInput,
  InvoiceQuantity,
  InvoiceVoidInput,
  InvoiceVoidResult
} from '@shared/invoices'
import type { Result } from '@shared/types/result'
import {
  canConfirmVoid,
  lineDiscountText,
  quantityRowText,
  savedQuantityText,
  submitDispatchUpdate,
  submitInvoiceVoid,
  voidPlan,
  type InvoiceNotifier
} from './invoice-history'
import { invoiceDetail } from './invoice-test-data'

const RS = { minorDigits: 2, symbol: 'Rs' }

function recorder(): InvoiceNotifier & { messages: string[] } {
  const messages: string[] = []
  return {
    messages,
    success: (message) => messages.push(`success: ${message}`),
    error: (message) => messages.push(`error: ${message}`)
  }
}

function quantity(overrides: Partial<InvoiceQuantity>): InvoiceQuantity {
  return {
    id: 1,
    unitId: 10,
    unitName: 'Piece',
    unitShortName: null,
    unitBaseQty: 1,
    quantity: 1,
    unitPriceMinor: 11_000,
    amountMinor: 11_000,
    qtyBase: 1,
    ...overrides
  }
}

describe('voidPlan', () => {
  it('warns that an account customer keeps a posted counter payment as credit', () => {
    expect(voidPlan(invoiceDetail(), RS)).toEqual({
      moneyReturnedRequired: false,
      paymentWarning:
        "This invoice has a payment of Rs 1,000.00. Voiding the invoice will keep that payment on the customer's account as credit. Void the payment separately if the money was also returned."
    })
  })

  it('asks for "money returned" on a walk-in invoice with a posted payment', () => {
    const plan = voidPlan(
      invoiceDetail({ customerCode: 'C-00001', customerName: 'Cash / Walk-in' }),
      RS
    )
    expect(plan.moneyReturnedRequired).toBe(true)
    expect(plan.paymentWarning).toBe(
      'This cash sale was paid Rs 1,000.00 (RCP-000001). The walk-in account stays at zero, so the invoice can be voided only if the money is returned: payment RCP-000001 is voided with it.'
    )
  })

  it('allows the void only with a reason, and for a walk-in sale only once the money is returned', () => {
    const account = voidPlan(invoiceDetail(), RS)
    const walkIn = voidPlan(invoiceDetail({ customerCode: 'C-00001' }), RS)
    expect(canConfirmVoid(account, '', false)).toBe(false)
    expect(canConfirmVoid(account, '   ', false)).toBe(false)
    expect(canConfirmVoid(account, 'Wrong customer', false)).toBe(true)
    expect(canConfirmVoid(walkIn, 'Returned', false)).toBe(false)
    expect(canConfirmVoid(walkIn, '', true)).toBe(false)
    expect(canConfirmVoid(walkIn, 'Returned', true)).toBe(true)
  })

  it('has nothing to say without a payment, or when the payment is already void', () => {
    const none = { moneyReturnedRequired: false, paymentWarning: null }
    expect(voidPlan(invoiceDetail({ payment: null, receivedMinor: 0 }), RS)).toEqual(none)
    const voided = invoiceDetail()
    expect(voidPlan({ ...voided, payment: { ...voided.payment!, status: 'VOID' } }, RS)).toEqual(
      none
    )
    expect(
      voidPlan(
        { ...voided, customerCode: 'C-00001', payment: { ...voided.payment!, status: 'VOID' } },
        RS
      )
    ).toEqual(none)
  })
})

describe('saved quantities and amounts', () => {
  const box = quantity({ id: 2, unitName: 'Box', unitBaseQty: 24 })
  const piece = quantity({})

  it('writes a base quantity in the units saved on the line, largest first', () => {
    expect(savedQuantityText(26, [piece, box])).toBe('1 Box + 2 Piece')
    expect(savedQuantityText(3, [box, piece])).toBe('3 Piece')
    expect(savedQuantityText(48, [box])).toBe('2 Box')
    // Free goods in a unit the saved rows cannot express.
    expect(savedQuantityText(26, [box])).toBe('1 Box + 2 base units')
    expect(savedQuantityText(1, [box])).toBe('1 base unit')
  })

  it('writes a quantity row with its price and amount', () => {
    expect(
      quantityRowText(
        quantity({ unitName: 'Box', quantity: 2, unitPriceMinor: 240_000, amountMinor: 480_000 }),
        RS
      )
    ).toBe('2 Box × Rs 2,400.00 = Rs 4,800.00')
  })

  it('writes a line discount as an amount, with the percentage when one was entered', () => {
    const line = invoiceDetail().lines[0]
    expect(lineDiscountText({ ...line, discountBps: 250, discountMinor: 13_125 }, RS)).toBe(
      'Rs 131.25 (2.5%)'
    )
    expect(lineDiscountText({ ...line, discountBps: null, discountMinor: 5_000 }, RS)).toBe(
      'Rs 50.00'
    )
    expect(lineDiscountText({ ...line, discountBps: null, discountMinor: 0 }, RS)).toBe('—')
  })
})

describe('submitInvoiceVoid', () => {
  const input: InvoiceVoidInput = { id: 1, reason: 'Wrong customer', moneyReturned: false }

  function api(result: Result<InvoiceVoidResult> | Error): {
    void(input: InvoiceVoidInput): Promise<Result<InvoiceVoidResult>>
    calls: InvoiceVoidInput[]
  } {
    const calls: InvoiceVoidInput[] = []
    return {
      calls,
      void: async (sent) => {
        calls.push(sent)
        if (result instanceof Error) throw result
        return result
      }
    }
  }

  it('says the invoice was voided and what the balance is now', async () => {
    const notify = recorder()
    const voided: InvoiceVoidResult = {
      ...invoiceDetail({ status: 'VOID' }),
      balanceAfterMinor: -100_000
    }
    const outcome = await submitInvoiceVoid(api({ ok: true, data: voided }), input, notify, RS)
    expect(outcome).toEqual({ voided })
    expect(notify.messages).toEqual([
      'success: Invoice INV-000001 voided. Balance now: Rs 1,000.00 Advance.'
    ])
  })

  it('says the payment was voided with a walk-in invoice', async () => {
    const notify = recorder()
    const base = invoiceDetail({ status: 'VOID', customerCode: 'C-00001' })
    const voided: InvoiceVoidResult = {
      ...base,
      payment: { ...base.payment!, status: 'VOID' },
      balanceAfterMinor: 0
    }
    await submitInvoiceVoid(
      api({ ok: true, data: voided }),
      { ...input, moneyReturned: true },
      notify,
      RS
    )
    expect(notify.messages).toEqual([
      'success: Invoice INV-000001 voided. Payment RCP-000001 was voided with it. Balance now: Settled.'
    ])
  })

  it('shows a refusal and returns its field errors', async () => {
    const notify = recorder()
    const outcome = await submitInvoiceVoid(
      api({
        ok: false,
        error: {
          code: 'VALIDATION',
          message: 'Walk-in invoice cannot be voided without reversing its received payment.',
          fieldErrors: { moneyReturned: ['Confirm the money was returned.', 'Second'] }
        }
      }),
      input,
      notify,
      RS
    )
    expect(outcome).toEqual({
      voided: null,
      fieldErrors: { moneyReturned: 'Confirm the money was returned.' }
    })
    expect(notify.messages).toEqual([
      'error: Walk-in invoice cannot be voided without reversing its received payment.'
    ])

    const again = recorder()
    await submitInvoiceVoid(
      api({
        ok: false,
        error: { code: 'FORBIDDEN_STATE', message: 'Invoice INV-000001 is already void.' }
      }),
      input,
      again,
      RS
    )
    expect(again.messages).toEqual(['error: Invoice INV-000001 is already void.'])
  })

  it('never shows the raw error of a failed call', async () => {
    const notify = recorder()
    const outcome = await submitInvoiceVoid(
      api(new Error('SQLITE_BUSY: database is locked')),
      input,
      notify,
      RS
    )
    expect(outcome).toEqual({ voided: null, fieldErrors: {} })
    expect(notify.messages).toEqual(['error: The invoice could not be voided. Try again.'])
  })
})

describe('submitDispatchUpdate', () => {
  const input: InvoiceDispatchUpdateInput = {
    id: 1,
    biltyNo: 'BL-2',
    transportName: null,
    addaName: null,
    note: null
  }

  function api(result: Result<InvoiceDispatchResult> | Error): {
    updateDispatch(input: InvoiceDispatchUpdateInput): Promise<Result<InvoiceDispatchResult>>
  } {
    return {
      updateDispatch: async () => {
        if (result instanceof Error) throw result
        return result
      }
    }
  }

  it('says whether the details changed', async () => {
    const notify = recorder()
    const saved: InvoiceDispatchResult = { ...invoiceDetail(), changedFields: ['bilty_no'] }
    expect(await submitDispatchUpdate(api({ ok: true, data: saved }), input, notify)).toEqual({
      saved
    })
    await submitDispatchUpdate(
      api({ ok: true, data: { ...saved, changedFields: [] } }),
      input,
      notify
    )
    expect(notify.messages).toEqual([
      'success: Dispatch details of INV-000001 saved.',
      'success: Nothing changed: the dispatch details were already as entered.'
    ])
  })

  it('returns field errors of a refusal, and a plain message when the call fails', async () => {
    const notify = recorder()
    expect(
      await submitDispatchUpdate(
        api({
          ok: false,
          error: {
            code: 'VALIDATION',
            message: 'Check the highlighted fields.',
            fieldErrors: { biltyNo: ['Use at most 40 characters.'] }
          }
        }),
        input,
        notify
      )
    ).toEqual({ saved: null, fieldErrors: { biltyNo: 'Use at most 40 characters.' } })
    await submitDispatchUpdate(api(new Error('boom')), input, notify)
    expect(notify.messages).toEqual([
      'error: Check the highlighted fields.',
      'error: The dispatch details could not be saved. Try again.'
    ])
  })
})
