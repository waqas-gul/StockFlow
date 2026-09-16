import { describe, expect, it } from 'vitest'
import type {
  DuplicatePaymentCheck,
  PaymentCreateInput,
  PaymentSaveResult,
  PaymentSummary,
  PaymentVoidResult
} from '@shared/payments'
import type { Result } from '@shared/types/result'
import { submitPayment, submitPaymentVoid, type PaymentNotifier } from './payment-actions'
import {
  emptyPaymentForm,
  paymentFormSchema,
  paymentPreview,
  serverPaymentErrors,
  toPaymentInput,
  withCustomer,
  type PaymentFormValues
} from './payment-form'

const RS = { minorDigits: 2, symbol: 'Rs' }
const TODAY = '2026-09-16'

const summary: PaymentSummary = {
  id: 7,
  paymentNo: 'RCP-000001',
  paymentDate: TODAY,
  customerId: 2,
  customerCode: 'C-00002',
  customerName: 'Ali Raza',
  shopName: 'Ali Traders',
  amountMinor: 150000,
  method: 'CASH',
  reference: null,
  status: 'POSTED',
  createdAt: '2026-09-16T10:00:00.000Z'
}

const saved: PaymentSaveResult = {
  ...summary,
  customerActive: true,
  note: null,
  voidReason: null,
  voidDate: null,
  voidedAt: null,
  balanceAfterMinor: -50000,
  replayed: false
}

const input: PaymentCreateInput = {
  requestId: 'request-0001',
  customerId: 2,
  paymentDate: TODAY,
  amountMinor: 150000,
  method: 'CASH',
  reference: null,
  note: null,
  currencyMinorDigits: 2
}

function recorder(): PaymentNotifier & { messages: string[] } {
  const messages: string[] = []
  return {
    messages,
    success: (message) => messages.push(`success: ${message}`),
    error: (message) => messages.push(`error: ${message}`),
    warning: (message) => messages.push(`warning: ${message}`)
  }
}

function issuesOf(result: {
  success: boolean
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> }
}): Record<string, string[]> {
  const issues: Record<string, string[]> = {}
  for (const issue of result.error?.issues ?? []) {
    ;(issues[issue.path.map(String).join('.')] ??= []).push(issue.message)
  }
  return issues
}

describe('payment form', () => {
  const values = (overrides: Partial<PaymentFormValues> = {}): PaymentFormValues => ({
    ...withCustomer(emptyPaymentForm(TODAY), {
      id: 2,
      code: 'C-00002',
      name: 'Ali Raza',
      shopName: 'Ali Traders'
    }),
    amount: '1,500',
    ...overrides
  })

  it('starts dated today, paid in cash, with the chosen customer when there is one', () => {
    expect(emptyPaymentForm(TODAY)).toEqual({
      customerId: null,
      customerLabel: '',
      paymentDate: TODAY,
      amount: '',
      method: 'CASH',
      reference: '',
      note: ''
    })
    expect(values()).toMatchObject({
      customerId: 2,
      customerLabel: 'C-00002 Ali Raza (Ali Traders)'
    })
  })

  it('turns the typed payment into the IPC input', () => {
    const parsed = paymentFormSchema(2).safeParse(
      values({ method: 'CHEQUE', reference: ' CHQ 12 ', note: '' })
    )
    expect(parsed.success && toPaymentInput(parsed.data, 'request-0001', 2)).toEqual({
      ...input,
      method: 'CHEQUE',
      reference: 'CHQ 12'
    })
  })

  it('requires a customer, a date and an amount above zero', () => {
    expect(
      issuesOf(paymentFormSchema(2).safeParse({ ...emptyPaymentForm(TODAY), paymentDate: '' }))
    ).toEqual({
      customerId: ['Choose the customer.'],
      paymentDate: ['Enter a valid date.'],
      amount: ['Enter the amount received.']
    })
    expect(issuesOf(paymentFormSchema(2).safeParse(values({ amount: '0' })))).toEqual({
      amount: ['Enter an amount greater than zero.']
    })
    expect(issuesOf(paymentFormSchema(2).safeParse(values({ amount: '1.001' })))).toEqual({
      amount: ['Use at most 2 decimal places.']
    })
  })

  it('previews the balance after the payment, and the advance an overpayment creates', () => {
    expect(paymentPreview(100000, '400', 2)).toEqual({
      amountMinor: 40000,
      balanceAfterMinor: 60000,
      advanceMinor: null
    })
    expect(paymentPreview(100000, '1,500', 2)).toEqual({
      amountMinor: 150000,
      balanceAfterMinor: -50000,
      advanceMinor: 50000
    })
    // A customer who already has an advance: the whole payment adds to it.
    expect(paymentPreview(-10000, '100', 2)).toEqual({
      amountMinor: 10000,
      balanceAfterMinor: -20000,
      advanceMinor: 10000
    })
    expect(paymentPreview(100000, '1000', 2).advanceMinor).toBeNull()
    expect(paymentPreview(100000, '', 2)).toEqual({
      amountMinor: null,
      balanceAfterMinor: null,
      advanceMinor: null
    })
  })

  it('puts main-process field errors on the form fields', () => {
    expect(
      serverPaymentErrors({
        amountMinor: ['Too large'],
        paymentDate: ['Too early'],
        customerId: ['Inactive'],
        requestId: ['?']
      })
    ).toEqual([
      ['amount', 'Too large'],
      ['paymentDate', 'Too early'],
      ['customerId', 'Inactive'],
      ['root', '?']
    ])
  })
})

interface RecordingPaymentsApi {
  readonly calls: string[]
  checkDuplicate(): Promise<Result<DuplicatePaymentCheck>>
  create(sent: PaymentCreateInput): Promise<Result<PaymentSaveResult>>
}

describe('submitPayment', () => {
  function api(
    duplicates: PaymentSummary[],
    created: Result<PaymentSaveResult> = { ok: true, data: saved }
  ): RecordingPaymentsApi {
    const calls: string[] = []
    return {
      calls,
      checkDuplicate: async (): Promise<Result<DuplicatePaymentCheck>> => {
        calls.push('checkDuplicate')
        return { ok: true, data: { duplicates } }
      },
      create: async (sent: PaymentCreateInput): Promise<Result<PaymentSaveResult>> => {
        calls.push(`create ${sent.requestId}`)
        return created
      }
    }
  }

  it('saves at once when no similar payment exists, and reports the advance', async () => {
    const notify = recorder()
    const target = api([])
    const asked: number[] = []
    const outcome = await submitPayment(target, input, {
      confirmDuplicate: async (found) => {
        asked.push(found.length)
        return true
      },
      onSaved: () => undefined,
      onFieldError: () => undefined,
      notify,
      currency: RS
    })
    expect(outcome).toBe('saved')
    expect(asked).toEqual([])
    expect(target.calls).toEqual(['checkDuplicate', 'create request-0001'])
    expect(notify.messages).toEqual([
      'success: Payment RCP-000001 saved. Balance now: Rs 500.00 Advance.'
    ])
  })

  it('warns about a possible duplicate: Cancel saves nothing, Continue saves with the same request id', async () => {
    const cancelled = api([summary])
    expect(
      await submitPayment(cancelled, input, {
        confirmDuplicate: async () => false,
        onSaved: () => undefined,
        onFieldError: () => undefined,
        notify: recorder(),
        currency: RS
      })
    ).toBe('cancelled')
    expect(cancelled.calls).toEqual(['checkDuplicate'])

    const continued = api([summary])
    const shown: PaymentSummary[][] = []
    expect(
      await submitPayment(continued, input, {
        confirmDuplicate: async (found) => {
          shown.push([...found])
          return true
        },
        onSaved: () => undefined,
        onFieldError: () => undefined,
        notify: recorder(),
        currency: RS
      })
    ).toBe('saved')
    expect(shown).toEqual([[summary]])
    expect(continued.calls).toEqual(['checkDuplicate', 'create request-0001'])
  })

  it('says so when a retry returned the payment already saved', async () => {
    const notify = recorder()
    await submitPayment(api([], { ok: true, data: { ...saved, replayed: true } }), input, {
      confirmDuplicate: async () => true,
      onSaved: () => undefined,
      onFieldError: () => undefined,
      notify,
      currency: RS
    })
    expect(notify.messages).toEqual([
      'success: Payment RCP-000001 was already saved. Balance now: Rs 500.00 Advance.'
    ])
  })

  it('puts a refused payment on its fields, and hides raw IPC failures', async () => {
    const notify = recorder()
    const fields: Array<[string, string]> = []
    const refused = api([], {
      ok: false,
      error: {
        code: 'DATE_NOT_ALLOWED',
        message: 'C-00002 Ali Raza has account activity on 16-Sep-2026. Use that date or later.',
        fieldErrors: { paymentDate: ['C-00002 Ali Raza has account activity on 16-Sep-2026.'] }
      }
    })
    const handlers = {
      confirmDuplicate: async () => true,
      onSaved: () => undefined,
      onFieldError: (path: string, message: string) => fields.push([path, message]),
      notify,
      currency: RS
    }
    expect(await submitPayment(refused, input, handlers)).toBe('failed')
    const broken = {
      checkDuplicate: async (): Promise<Result<DuplicatePaymentCheck>> => {
        throw new Error('ipc exploded')
      },
      create: refused.create
    }
    expect(await submitPayment(broken, input, handlers)).toBe('failed')
    expect(fields).toEqual([
      ['paymentDate', 'C-00002 Ali Raza has account activity on 16-Sep-2026.']
    ])
    expect(notify.messages).toEqual([
      'error: C-00002 Ali Raza has account activity on 16-Sep-2026. Use that date or later.',
      'error: The payment could not be saved. Try again.'
    ])
  })
})

describe('submitPaymentVoid', () => {
  it('returns the void payment and reports the balance, or null with the refusal', async () => {
    const notify = recorder()
    const voided: PaymentVoidResult = {
      ...saved,
      status: 'VOID',
      voidReason: 'Bounced',
      voidDate: TODAY,
      voidedAt: '2026-09-16T11:00:00.000Z',
      balanceAfterMinor: 100000
    }
    expect(
      await submitPaymentVoid(
        { void: async () => ({ ok: true, data: voided }) },
        { id: 7, reason: 'Bounced' },
        notify,
        RS
      )
    ).toEqual(voided)
    expect(
      await submitPaymentVoid(
        {
          void: async () => ({
            ok: false,
            error: { code: 'FORBIDDEN_STATE', message: 'Payment RCP-000001 is already void.' }
          })
        },
        { id: 7, reason: 'Again' },
        notify,
        RS
      )
    ).toBeNull()
    expect(notify.messages).toEqual([
      'success: Payment RCP-000001 voided. Balance now: Rs 1,000.00 Due.',
      'error: Payment RCP-000001 is already void.'
    ])
  })
})
