import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Customer, CustomerCreateInput } from '@shared/customers'
import type { PaymentCreateInput } from '@shared/payments'
import type { Db } from '../db/adapter'
import { createSchemaDatabase, createTempDir, thrown, type TempDir } from '../db/test-utils'
import { AppFailure } from '../errors'
import {
  adjustCustomerBalance,
  createCustomer,
  getCustomer,
  setCustomerActive
} from './customers.service'
import {
  checkDuplicatePayment,
  createPayment,
  getPayment,
  listPayments,
  voidPayment
} from './payments.service'
import { failingWrites } from './test-utils'

// Test data lives only in temporary databases.

const NOW = new Date(2026, 8, 16, 10, 30, 0)
const TODAY = '2026-09-16'
const YESTERDAY = '2026-09-15'

let temp: TempDir
let db: Db
let requests: number
/** Owes Rs 1,000.00 since 10-Sep-2026. */
let ali: Customer

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  requests = 0
  ali = customer({ opening: { side: 'DUE', amountMinor: 100000, date: '2026-09-10' } })
})

afterEach(() => {
  temp.remove()
})

function customer(overrides: Partial<CustomerCreateInput> = {}): Customer {
  return createCustomer(
    db,
    {
      name: 'Ali Raza',
      shopName: 'Ali Traders',
      phone: '0300-1234567',
      address: null,
      city: 'Lahore',
      notes: null,
      opening: null,
      currencyMinorDigits: 2,
      ...overrides
    },
    NOW
  )
}

function nextRequestId(): string {
  requests++
  return `payment-request-${String(requests).padStart(4, '0')}`
}

function paymentInput(overrides: Partial<PaymentCreateInput> = {}): PaymentCreateInput {
  return {
    requestId: nextRequestId(),
    customerId: ali.id,
    paymentDate: TODAY,
    amountMinor: 40000,
    method: 'CASH',
    reference: null,
    note: null,
    currencyMinorDigits: 2,
    ...overrides
  }
}

function pay(overrides: Partial<PaymentCreateInput> = {}): ReturnType<typeof createPayment> {
  return createPayment(db, paymentInput(overrides), NOW)
}

function failure(fn: () => unknown): AppFailure['error'] {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

function count(table: string): number {
  return db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n
}

function nextSequence(name: string): number {
  return db.get<{ next_value: number }>('SELECT next_value FROM sequences WHERE name = ?', [name])!
    .next_value
}

function balance(customerId: number): number {
  return db.get<{ total: number }>(
    'SELECT coalesce(sum(amount_minor), 0) AS total FROM customer_ledger WHERE customer_id = ?',
    [customerId]
  )!.total
}

function ledgerRows(paymentId: number): Array<Record<string, unknown>> {
  return db.all('SELECT * FROM customer_ledger WHERE payment_id = ? ORDER BY id', [paymentId])
}

describe('createPayment', () => {
  it('posts a payment and a PAYMENT ledger entry together, reducing the balance at once', () => {
    const payment = pay({ reference: ' Slip 12 ', note: 'Counter' })

    expect(payment).toEqual({
      id: expect.any(Number),
      paymentNo: 'RCP-000001',
      paymentDate: TODAY,
      customerId: ali.id,
      customerCode: 'C-00002',
      customerName: 'Ali Raza',
      shopName: 'Ali Traders',
      customerActive: true,
      amountMinor: 40000,
      method: 'CASH',
      reference: 'Slip 12',
      note: 'Counter',
      status: 'POSTED',
      voidReason: null,
      voidDate: null,
      voidedAt: null,
      createdAt: expect.any(String),
      balanceAfterMinor: 60000,
      replayed: false
    })
    expect(ledgerRows(payment.id)).toMatchObject([
      {
        customer_id: ali.id,
        entry_date: TODAY,
        type: 'PAYMENT',
        amount_minor: -40000,
        invoice_id: null
      }
    ])
    expect(db.get('SELECT invoice_id FROM payments WHERE id = ?', [payment.id])).toEqual({
      invoice_id: null
    })
    expect(getCustomer(db, ali.id).balanceMinor).toBe(60000)
  })

  it('an overpayment is valid and leaves the customer with an advance', () => {
    const payment = pay({ amountMinor: 150000 })
    expect(payment.balanceAfterMinor).toBe(-50000)
    expect(balance(ali.id)).toBe(-50000)
  })

  it('accepts every payment method and refuses others', () => {
    for (const method of ['CASH', 'BANK', 'CHEQUE', 'OTHER'] as const) {
      expect(pay({ method, amountMinor: 100 }).method).toBe(method)
    }
    const error = failure(() => createPayment(db, { ...paymentInput(), method: 'CARD' }, NOW))
    expect(error.fieldErrors?.method).toBeDefined()
    expect(count('payments')).toBe(4)
  })

  it('requires an amount above zero', () => {
    for (const amountMinor of [0, -100, 1.5]) {
      const error = failure(() => pay({ amountMinor }))
      expect(error.fieldErrors?.amountMinor).toBeDefined()
    }
    expect(count('payments')).toBe(0)
  })

  it('numbers payments RCP-000001, RCP-000002, …', () => {
    expect([pay().paymentNo, pay().paymentNo]).toEqual(['RCP-000001', 'RCP-000002'])
    expect(nextSequence('payment')).toBe(3)
  })

  it.each([
    ['the payment', /INSERT INTO payments/],
    ['its ledger entry', /INSERT INTO customer_ledger/]
  ])('saves nothing and uses no number when writing %s fails', (_label, pattern) => {
    thrown(() => createPayment(failingWrites(db, pattern), paymentInput(), NOW))
    expect(count('payments')).toBe(0)
    expect(balance(ali.id)).toBe(100000)
    expect(nextSequence('payment')).toBe(1)
    expect(pay().paymentNo).toBe('RCP-000001')
  })

  it('a retry with the same request id returns the saved payment and creates nothing more', () => {
    const input = paymentInput()
    const first = createPayment(db, input, NOW)
    const retry = createPayment(db, input, NOW)
    const changed = createPayment(db, { ...input, amountMinor: 999 }, NOW)
    expect(retry).toEqual({ ...first, replayed: true })
    expect(changed).toEqual({ ...first, replayed: true })
    expect(count('payments')).toBe(1)
    expect(ledgerRows(first.id)).toHaveLength(1)
    expect(balance(ali.id)).toBe(60000)
    expect(nextSequence('payment')).toBe(2)
  })

  it('refuses a new payment from an inactive customer, and saves nothing', () => {
    setCustomerActive(db, { id: ali.id, active: false })
    const error = failure(() => pay())
    expect(error.code).toBe('FORBIDDEN_STATE')
    expect(error.message).toContain('inactive')
    expect(count('payments')).toBe(0)
    expect(nextSequence('payment')).toBe(1)
    expect(getCustomer(db, ali.id).isActive).toBe(false)
  })

  it('refuses a missing customer', () => {
    const error = failure(() => pay({ customerId: 999 }))
    expect(error.code).toBe('NOT_FOUND')
    expect(error.fieldErrors?.customerId).toBeDefined()
  })

  it('refuses a date before the same customer’s latest ledger entry', () => {
    adjustCustomerBalance(
      db,
      {
        customerId: ali.id,
        entryDate: TODAY,
        direction: 'INCREASE',
        amountMinor: 500,
        reason: 'Freight',
        currencyMinorDigits: 2
      },
      NOW
    )
    const error = failure(() => pay({ paymentDate: YESTERDAY }))
    expect(error).toMatchObject({
      code: 'DATE_NOT_ALLOWED',
      details: { earliestDate: TODAY, customerId: ali.id, customerCode: 'C-00002' },
      fieldErrors: { paymentDate: [expect.stringContaining('16-Sep-2026')] }
    })
    expect(error.message).toContain('C-00002 Ali Raza')
    expect(pay({ paymentDate: TODAY }).paymentDate).toBe(TODAY)
  })

  it('a later payment of another customer does not block a backdated payment', () => {
    const bilal = customer({ name: 'Bilal' })
    pay({ customerId: bilal.id, paymentDate: TODAY })
    expect(pay({ paymentDate: '2026-09-12' }).paymentDate).toBe('2026-09-12')
  })

  it('refuses a future date', () => {
    const error = failure(() => pay({ paymentDate: '2026-09-17' }))
    expect(error.code).toBe('DATE_NOT_ALLOWED')
    expect(count('payments')).toBe(0)
  })

  it('refuses amounts entered with other currency decimal places', () => {
    expect(failure(() => pay({ currencyMinorDigits: 3 })).code).toBe('CONFLICT')
  })
})

describe('checkDuplicatePayment', () => {
  it('finds posted payments with the same customer, date and amount; a duplicate may still be saved', () => {
    const first = pay({ amountMinor: 40000 })
    const check = { customerId: ali.id, paymentDate: TODAY, amountMinor: 40000 }
    expect(checkDuplicatePayment(db, check).duplicates.map((item) => item.paymentNo)).toEqual([
      first.paymentNo
    ])
    expect(checkDuplicatePayment(db, { ...check, amountMinor: 40001 }).duplicates).toEqual([])
    expect(checkDuplicatePayment(db, { ...check, paymentDate: YESTERDAY }).duplicates).toEqual([])
    const bilal = customer({ name: 'Bilal' })
    expect(checkDuplicatePayment(db, { ...check, customerId: bilal.id }).duplicates).toEqual([])

    const second = pay({ amountMinor: 40000 })
    expect(second.paymentNo).toBe('RCP-000002')
    expect(checkDuplicatePayment(db, check).duplicates).toHaveLength(2)

    voidPayment(db, { id: first.id, reason: 'Entered twice' }, NOW)
    expect(checkDuplicatePayment(db, check).duplicates.map((item) => item.paymentNo)).toEqual([
      'RCP-000002'
    ])
  })
})

describe('voidPayment', () => {
  it('adds the amount back with a PAYMENT_VOID entry dated today, and never changes the PAYMENT entry', () => {
    const payment = pay({ paymentDate: YESTERDAY, amountMinor: 40000 })
    const original = ledgerRows(payment.id)
    const later = new Date(2026, 8, 16, 18, 0, 0)

    const voided = voidPayment(db, { id: payment.id, reason: '  Cheque bounced ' }, later)

    expect(voided).toMatchObject({
      id: payment.id,
      status: 'VOID',
      voidReason: 'Cheque bounced',
      voidDate: TODAY,
      voidedAt: later.toISOString(),
      paymentDate: YESTERDAY,
      amountMinor: 40000,
      balanceAfterMinor: 100000
    })
    const rows = ledgerRows(payment.id)
    expect(rows[0]).toEqual(original[0])
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({
      customer_id: ali.id,
      entry_date: TODAY,
      type: 'PAYMENT_VOID',
      amount_minor: 40000,
      note: 'Cheque bounced'
    })
    expect(balance(ali.id)).toBe(100000)
    expect(getPayment(db, payment.id)).toMatchObject({ status: 'VOID', voidDate: TODAY })
  })

  it('refuses a second void', () => {
    const payment = pay()
    voidPayment(db, { id: payment.id, reason: 'Wrong customer' }, NOW)
    const error = failure(() => voidPayment(db, { id: payment.id, reason: 'Again' }, NOW))
    expect(error.code).toBe('FORBIDDEN_STATE')
    expect(error.message).toContain('RCP-000001')
    expect(ledgerRows(payment.id)).toHaveLength(2)
    expect(balance(ali.id)).toBe(100000)
  })

  it('works for an inactive customer, who stays inactive', () => {
    const payment = pay()
    setCustomerActive(db, { id: ali.id, active: false })
    const voided = voidPayment(db, { id: payment.id, reason: 'Wrong amount' }, NOW)
    expect(voided).toMatchObject({ status: 'VOID', customerActive: false })
    expect(getCustomer(db, ali.id)).toMatchObject({ isActive: false, balanceMinor: 100000 })
  })

  it.each([
    ['the status change', /UPDATE payments/],
    ['the PAYMENT_VOID entry', /INSERT INTO customer_ledger/]
  ])('rolls back the whole void when writing %s fails', (_label, pattern) => {
    const payment = pay()
    thrown(() => voidPayment(failingWrites(db, pattern), { id: payment.id, reason: 'Oops' }, NOW))
    expect(getPayment(db, payment.id)).toMatchObject({ status: 'POSTED', voidReason: null })
    expect(ledgerRows(payment.id)).toHaveLength(1)
    expect(balance(ali.id)).toBe(60000)
  })

  it('requires a reason and an existing payment', () => {
    const payment = pay()
    expect(failure(() => voidPayment(db, { id: payment.id, reason: '' }, NOW)).code).toBe(
      'VALIDATION'
    )
    expect(failure(() => voidPayment(db, { id: 999, reason: 'Gone' }, NOW)).code).toBe('NOT_FOUND')
  })

  it('is refused when the computer clock is before the customer’s latest entry', () => {
    const payment = pay()
    const error = failure(() =>
      voidPayment(db, { id: payment.id, reason: 'Clock' }, new Date(2026, 8, 14, 9, 0, 0))
    )
    expect(error.code).toBe('DATE_NOT_ALLOWED')
    expect(getPayment(db, payment.id).status).toBe('POSTED')
  })
})

describe('getPayment and listPayments', () => {
  it('reads one payment and refuses a missing one', () => {
    const payment = pay({ method: 'CHEQUE', reference: 'CHQ 4471' })
    const { balanceAfterMinor, replayed, ...detail } = payment
    expect([balanceAfterMinor, replayed]).toEqual([60000, false])
    expect(getPayment(db, payment.id)).toEqual(detail)
    expect(failure(() => getPayment(db, 999)).code).toBe('NOT_FOUND')
  })

  it('lists newest first and filters by search, date range, status and method', () => {
    const bilal = customer({ name: 'Bilal Ahmed', shopName: 'Madina Store' })
    const p1 = pay({ paymentDate: '2026-09-11', method: 'BANK', reference: 'TT-889' })
    const p2 = pay({ customerId: bilal.id, paymentDate: '2026-09-12' })
    const p3 = pay({ paymentDate: '2026-09-13', method: 'CHEQUE' })
    voidPayment(db, { id: p3.id, reason: 'Bounced' }, NOW)

    const list = (overrides: Record<string, unknown> = {}): string[] =>
      listPayments(db, {
        page: 1,
        pageSize: 25,
        search: '',
        status: 'all',
        method: 'all',
        dateFrom: null,
        dateTo: null,
        ...overrides
      }).items.map((item) => item.paymentNo)

    expect(list()).toEqual([p3.paymentNo, p2.paymentNo, p1.paymentNo])
    expect(list({ search: 'madina' })).toEqual([p2.paymentNo])
    expect(list({ search: 'c-00002' })).toEqual([p3.paymentNo, p1.paymentNo])
    expect(list({ search: 'rcp-000001' })).toEqual([p1.paymentNo])
    expect(list({ search: 'tt-889' })).toEqual([p1.paymentNo])
    expect(list({ status: 'VOID' })).toEqual([p3.paymentNo])
    expect(list({ status: 'POSTED' })).toEqual([p2.paymentNo, p1.paymentNo])
    expect(list({ method: 'BANK' })).toEqual([p1.paymentNo])
    expect(list({ dateFrom: '2026-09-12' })).toEqual([p3.paymentNo, p2.paymentNo])
    expect(list({ dateTo: '2026-09-12' })).toEqual([p2.paymentNo, p1.paymentNo])
    expect(list({ dateFrom: '2026-09-12', dateTo: '2026-09-12' })).toEqual([p2.paymentNo])

    const page = listPayments(db, {
      page: 2,
      pageSize: 2,
      search: '',
      status: 'all',
      method: 'all',
      dateFrom: null,
      dateTo: null
    })
    expect(page).toMatchObject({ total: 3, page: 2, pageSize: 2 })
    expect(page.items).toEqual([
      {
        id: p1.id,
        paymentNo: 'RCP-000001',
        paymentDate: '2026-09-11',
        customerId: ali.id,
        customerCode: 'C-00002',
        customerName: 'Ali Raza',
        shopName: 'Ali Traders',
        amountMinor: 40000,
        method: 'BANK',
        reference: 'TT-889',
        status: 'POSTED',
        createdAt: expect.any(String)
      }
    ])
    const reversed = failure(() =>
      listPayments(db, {
        page: 1,
        pageSize: 25,
        search: '',
        status: 'all',
        method: 'all',
        dateFrom: '2026-09-13',
        dateTo: '2026-09-12'
      })
    )
    expect(reversed.fieldErrors?.dateTo).toBeDefined()
  })
})
