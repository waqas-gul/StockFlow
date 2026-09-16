import { describe, expect, it } from 'vitest'
import type {
  BalanceAdjustmentResult,
  Customer,
  CustomerCreateInput,
  LedgerRow
} from '@shared/customers'
import type { Result } from '@shared/types/result'
import {
  adjustmentBalancePreview,
  balanceAdjustmentFormSchema,
  emptyBalanceAdjustmentForm,
  serverBalanceAdjustmentErrors,
  toBalanceAdjustmentInput,
  type BalanceAdjustmentFormValues
} from './balance-adjustment-form'
import {
  saveCustomer,
  submitBalanceAdjustment,
  toggleCustomerActive,
  type CustomerNotifier
} from './customer-actions'
import {
  balanceDescription,
  balanceText,
  ledgerAmounts,
  ledgerReference,
  ledgerTypeLabel
} from './customer-display'
import {
  customerFormSchema,
  customerFormValues,
  emptyCustomerForm,
  openingBalancePreview,
  serverCustomerErrors,
  toCustomerCreateInput,
  toCustomerUpdateInput,
  type CustomerFormValues
} from './customer-form'

const RS = { minorDigits: 2, symbol: 'Rs' }
const TODAY = '2026-09-16'

const customer: Customer = {
  id: 2,
  code: 'C-00002',
  name: 'Ali Raza',
  shopName: 'Ali Traders',
  phone: '0300-1234567',
  city: 'Lahore',
  isActive: true,
  balanceMinor: 500000,
  address: 'Main Bazar',
  notes: null,
  latestEntryDate: '2026-09-10',
  createdAt: '2026-09-10T10:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z'
}

function ledgerRow(overrides: Partial<LedgerRow>): LedgerRow {
  return {
    id: 1,
    entryDate: '2026-09-10',
    type: 'OPENING',
    amountMinor: 500000,
    runningBalanceMinor: 500000,
    paymentId: null,
    paymentNo: null,
    paymentMethod: null,
    paymentReference: null,
    paymentStatus: null,
    invoiceId: null,
    invoiceNo: null,
    note: null,
    createdAt: '2026-09-10T10:00:00.000Z',
    ...overrides
  }
}

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

function recorder(): CustomerNotifier & { messages: string[] } {
  const messages: string[] = []
  return {
    messages,
    success: (message) => messages.push(`success: ${message}`),
    error: (message) => messages.push(`error: ${message}`),
    warning: (message) => messages.push(`warning: ${message}`)
  }
}

describe('balance presentation', () => {
  it('shows a positive balance as Due, zero as Settled and a negative balance as Advance', () => {
    expect(balanceText(500000, RS)).toBe('Rs 5,000.00 Due')
    expect(balanceText(0, RS)).toBe('Settled')
    expect(balanceText(-75000, RS)).toBe('Rs 750.00 Advance')
    expect(balanceText(-5, { minorDigits: 0, symbol: 'PKR' })).toBe('PKR 5 Advance')
    expect(balanceDescription(500000)).toBe('The customer owes the shop.')
    expect(balanceDescription(0)).toBe('Nothing is owed either way.')
    expect(balanceDescription(-1)).toBe('The shop holds an advance for the customer.')
  })

  it('splits ledger amounts into increase and decrease columns, with plain type names and references', () => {
    expect(ledgerAmounts(ledgerRow({ amountMinor: 500000 }))).toEqual({
      increaseMinor: 500000,
      decreaseMinor: null
    })
    expect(ledgerAmounts(ledgerRow({ amountMinor: -75000 }))).toEqual({
      increaseMinor: null,
      decreaseMinor: 75000
    })
    const payment = ledgerRow({
      type: 'PAYMENT',
      amountMinor: -200000,
      paymentId: 7,
      paymentNo: 'RCP-000001',
      paymentMethod: 'CHEQUE',
      paymentStatus: 'VOID'
    })
    expect(ledgerTypeLabel(payment)).toBe('Payment received · Cheque')
    expect(ledgerReference(payment)).toBe('RCP-000001')
    expect(ledgerTypeLabel(ledgerRow({ type: 'OPENING', amountMinor: -1 }))).toBe(
      'Opening balance (advance)'
    )
    expect(ledgerTypeLabel(ledgerRow({ type: 'OPENING' }))).toBe('Opening balance (due)')
    expect(ledgerTypeLabel(ledgerRow({ type: 'PAYMENT_VOID', paymentNo: 'RCP-000001' }))).toBe(
      'Payment voided'
    )
    expect(ledgerTypeLabel(ledgerRow({ type: 'ADJUSTMENT' }))).toBe('Balance adjustment')
    expect(ledgerReference(ledgerRow({ type: 'ADJUSTMENT' }))).toBe('')
  })
})

describe('customer form', () => {
  const values = (overrides: Partial<CustomerFormValues> = {}): CustomerFormValues => ({
    ...emptyCustomerForm(TODAY),
    name: 'Ali Raza',
    ...overrides
  })

  it('starts empty, with no opening balance, dated today', () => {
    expect(emptyCustomerForm(TODAY)).toEqual({
      name: '',
      shopName: '',
      phone: '',
      address: '',
      city: '',
      notes: '',
      openingAmount: '',
      openingSide: 'DUE',
      openingDate: TODAY
    })
  })

  it('turns the typed opening balance into a signed-free input: owes us or advance, never a sign', () => {
    const schema = customerFormSchema(2)
    const due = schema.safeParse(values({ openingAmount: '5,000', openingSide: 'DUE' }))
    expect(due.success && toCustomerCreateInput(due.data, 2)).toEqual({
      name: 'Ali Raza',
      shopName: null,
      phone: null,
      address: null,
      city: null,
      notes: null,
      opening: { side: 'DUE', amountMinor: 500000, date: TODAY },
      currencyMinorDigits: 2
    } satisfies CustomerCreateInput)
    const advance = schema.safeParse(
      values({ openingAmount: '750.50', openingSide: 'ADVANCE', openingDate: '2026-09-01' })
    )
    expect(advance.success && advance.data.opening).toEqual({
      side: 'ADVANCE',
      amountMinor: 75050,
      date: '2026-09-01'
    })
    for (const openingAmount of ['', '0', '0.00']) {
      const none = schema.safeParse(values({ openingAmount }))
      expect(none.success && none.data.opening).toBeNull()
    }
  })

  it('refuses a missing name, a negative or malformed amount, and a missing opening date', () => {
    const schema = customerFormSchema(2)
    expect(issuesOf(schema.safeParse(values({ name: ' ' })))).toEqual({
      name: ['Enter the customer name.']
    })
    expect(issuesOf(schema.safeParse(values({ openingAmount: '-5' })))).toEqual({
      openingAmount: ['The amount cannot be negative.']
    })
    expect(issuesOf(schema.safeParse(values({ openingAmount: '12.345' })))).toEqual({
      openingAmount: ['Use at most 2 decimal places.']
    })
    expect(issuesOf(schema.safeParse(values({ openingAmount: '100', openingDate: '' })))).toEqual({
      openingDate: ['Enter the opening balance date.']
    })
    // Without an opening amount the date is not needed.
    expect(schema.safeParse(values({ openingDate: '' })).success).toBe(true)
  })

  it('previews the opening balance as it will be saved', () => {
    expect(openingBalancePreview(values({ openingAmount: '5000' }), 2)).toBe(500000)
    expect(openingBalancePreview(values({ openingAmount: '750', openingSide: 'ADVANCE' }), 2)).toBe(
      -75000
    )
    expect(openingBalancePreview(values({ openingAmount: 'abc' }), 2)).toBeNull()
    expect(openingBalancePreview(values({ openingAmount: '' }), 2)).toBe(0)
  })

  it('edits only the profile: saved values in, no opening balance out', () => {
    const edit = customerFormValues(customer, TODAY)
    expect(edit).toMatchObject({
      name: 'Ali Raza',
      shopName: 'Ali Traders',
      notes: '',
      openingAmount: ''
    })
    const parsed = customerFormSchema(2).safeParse({ ...edit, city: 'Karachi' })
    expect(parsed.success && toCustomerUpdateInput(customer.id, parsed.data)).toEqual({
      id: 2,
      name: 'Ali Raza',
      shopName: 'Ali Traders',
      phone: '0300-1234567',
      address: 'Main Bazar',
      city: 'Karachi',
      notes: null
    })
  })

  it('puts main-process field errors on the form fields', () => {
    expect(
      serverCustomerErrors({
        name: ['Enter the customer name.'],
        'opening.date': ['The date cannot be later than today (16-Sep-2026).'],
        'opening.amountMinor': ['The amount is too large.'],
        currencyMinorDigits: ['Invalid']
      })
    ).toEqual([
      ['name', 'Enter the customer name.'],
      ['openingDate', 'The date cannot be later than today (16-Sep-2026).'],
      ['openingAmount', 'The amount is too large.'],
      ['root', 'Invalid']
    ])
  })
})

describe('balance adjustment form', () => {
  const values = (
    overrides: Partial<BalanceAdjustmentFormValues> = {}
  ): BalanceAdjustmentFormValues => ({
    ...emptyBalanceAdjustmentForm(TODAY),
    direction: 'DECREASE',
    amount: '250',
    reason: 'Discount agreed',
    ...overrides
  })

  it('needs a direction, an amount above zero and a reason', () => {
    expect(emptyBalanceAdjustmentForm(TODAY)).toEqual({
      entryDate: TODAY,
      direction: '',
      amount: '',
      reason: ''
    })
    const schema = balanceAdjustmentFormSchema(2)
    expect(issuesOf(schema.safeParse(emptyBalanceAdjustmentForm(TODAY)))).toEqual({
      direction: ['Choose whether the customer owes more or less.'],
      amount: ['Enter the amount.'],
      reason: ['Enter the reason.']
    })
    expect(issuesOf(schema.safeParse(values({ amount: '0' })))).toEqual({
      amount: ['Enter an amount greater than zero.']
    })
    const parsed = schema.safeParse(values())
    expect(parsed.success && toBalanceAdjustmentInput(parsed.data, 2, 2)).toEqual({
      customerId: 2,
      entryDate: TODAY,
      direction: 'DECREASE',
      amountMinor: 25000,
      reason: 'Discount agreed',
      currencyMinorDigits: 2
    })
  })

  it('previews the balance after the adjustment', () => {
    expect(
      adjustmentBalancePreview(10000, values({ direction: 'DECREASE', amount: '250' }), 2)
    ).toBe(-15000)
    expect(adjustmentBalancePreview(10000, values({ direction: 'INCREASE', amount: '1' }), 2)).toBe(
      10100
    )
    expect(adjustmentBalancePreview(10000, values({ direction: '' }), 2)).toBeNull()
    expect(adjustmentBalancePreview(10000, values({ amount: 'x' }), 2)).toBeNull()
    expect(
      serverBalanceAdjustmentErrors({
        amountMinor: ['Too large'],
        entryDate: ['Too early'],
        x: ['?']
      })
    ).toEqual([
      ['amount', 'Too large'],
      ['entryDate', 'Too early'],
      ['root', '?']
    ])
  })
})

describe('customer actions', () => {
  it('creates a customer and reports the new code', async () => {
    const notify = recorder()
    const saved: Customer[] = []
    const ok = await saveCustomer(
      {
        create: async () => ({ ok: true, data: customer }),
        update: async () => ({ ok: true, data: customer })
      },
      {
        mode: 'create',
        input: {
          name: 'Ali Raza',
          shopName: null,
          phone: null,
          address: null,
          city: null,
          notes: null,
          opening: null,
          currencyMinorDigits: 2
        }
      },
      { onSaved: (item) => saved.push(item), onFieldError: () => undefined, notify }
    )
    expect(ok).toBe(true)
    expect(saved).toEqual([customer])
    expect(notify.messages).toEqual(['success: Customer C-00002 Ali Raza added.'])
  })

  it('puts a refused save on its fields, and never shows raw IPC failures', async () => {
    const notify = recorder()
    const fields: Array<[string, string]> = []
    const refused: Result<Customer> = {
      ok: false,
      error: {
        code: 'DATE_NOT_ALLOWED',
        message: 'The date cannot be later than today (16-Sep-2026).',
        fieldErrors: { 'opening.date': ['The date cannot be later than today (16-Sep-2026).'] }
      }
    }
    const api = {
      create: async () => refused,
      update: async (): Promise<Result<Customer>> => {
        throw new Error('ipc exploded: SQLITE_BUSY')
      }
    }
    const handlers = {
      onSaved: () => undefined,
      onFieldError: (path: string, message: string) => fields.push([path, message]),
      notify
    }
    const input = toCustomerUpdateInput(2, {
      name: 'x',
      shopName: null,
      phone: null,
      address: null,
      city: null,
      notes: null,
      opening: null
    })
    expect(
      await saveCustomer(
        api,
        { mode: 'create', input: { ...input, opening: null, currencyMinorDigits: 2 } },
        handlers
      )
    ).toBe(false)
    expect(await saveCustomer(api, { mode: 'update', input }, handlers)).toBe(false)
    expect(fields).toEqual([['openingDate', 'The date cannot be later than today (16-Sep-2026).']])
    expect(notify.messages).toEqual([
      'error: The date cannot be later than today (16-Sep-2026).',
      'error: The customer could not be saved. Try again.'
    ])
  })

  it('deactivates and reactivates with a plain message', async () => {
    const notify = recorder()
    const api = {
      setActive: async ({
        active
      }: {
        id: number
        active: boolean
      }): Promise<Result<Customer>> => ({
        ok: true,
        data: { ...customer, isActive: active }
      })
    }
    expect(await toggleCustomerActive(api, { id: 2, code: 'C-00002', active: false }, notify)).toBe(
      true
    )
    expect(await toggleCustomerActive(api, { id: 2, code: 'C-00002', active: true }, notify)).toBe(
      true
    )
    expect(notify.messages).toEqual([
      'success: Customer C-00002 deactivated.',
      'success: Customer C-00002 reactivated.'
    ])
  })

  it('reports a balance adjustment with the new balance', async () => {
    const notify = recorder()
    const result: BalanceAdjustmentResult = {
      entry: ledgerRow({ type: 'ADJUSTMENT', amountMinor: -600000, runningBalanceMinor: -100000 }),
      customer: { ...customer, balanceMinor: -100000 }
    }
    const saved: BalanceAdjustmentResult[] = []
    const ok = await submitBalanceAdjustment(
      { adjustBalance: async () => ({ ok: true, data: result }) },
      {
        customerId: 2,
        entryDate: TODAY,
        direction: 'DECREASE',
        amountMinor: 600000,
        reason: 'Settlement',
        currencyMinorDigits: 2
      },
      { onSaved: (item) => saved.push(item), onFieldError: () => undefined, notify, currency: RS }
    )
    expect(ok).toBe(true)
    expect(saved).toEqual([result])
    expect(notify.messages).toEqual([
      'success: Balance adjusted. New balance: Rs 1,000.00 Advance.'
    ])
  })
})
