import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Customer } from '@shared/customers'
import type { Db } from '../db/adapter'
import {
  createSchemaDatabase,
  createTempDir,
  insertRow,
  thrown,
  type TempDir
} from '../db/test-utils'
import { AppFailure } from '../errors'
import { appendLedgerEntry } from './customer-ledger'
import {
  adjustCustomerBalance,
  createCustomer,
  customerLedger,
  getCustomer,
  listCustomers
} from './customers.service'
import { createPayment, voidPayment } from './payments.service'

// The customer ledger is the only source of a balance: SUM(customer_ledger.amount_minor), read in (entry_date, id) order.

const NOW = new Date(2026, 8, 16, 10, 30, 0)

let temp: TempDir
let db: Db

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
})

afterEach(() => {
  temp.remove()
})

function newCustomer(
  name: string,
  opening: Customer['balanceMinor'],
  date = '2026-09-01'
): Customer {
  return createCustomer(
    db,
    {
      name,
      shopName: null,
      phone: null,
      address: null,
      city: null,
      notes: null,
      opening:
        opening === 0
          ? null
          : { side: opening > 0 ? 'DUE' : 'ADVANCE', amountMinor: Math.abs(opening), date },
      currencyMinorDigits: 2
    },
    NOW
  )
}

function ledgerSum(customerId: number): number {
  return db.get<{ total: number }>(
    'SELECT coalesce(sum(amount_minor), 0) AS total FROM customer_ledger WHERE customer_id = ?',
    [customerId]
  )!.total
}

function viewBalance(customerId: number): number {
  return db.get<{ balance_minor: number }>(
    'SELECT balance_minor FROM v_customer_balance WHERE customer_id = ?',
    [customerId]
  )!.balance_minor
}

/** The balance every read path reports equals Σ ledger and v_customer_balance. */
function expectBalance(customer: Customer, expected: number): void {
  expect(ledgerSum(customer.id)).toBe(expected)
  expect(viewBalance(customer.id)).toBe(expected)
  expect(getCustomer(db, customer.id).balanceMinor).toBe(expected)
  const listed = listCustomers(db, {
    page: 1,
    pageSize: 100,
    search: '',
    status: 'all'
  }).items.find((item) => item.id === customer.id)
  expect(listed?.balanceMinor).toBe(expected)
  const ledger = customerLedger(db, { customerId: customer.id, page: null, pageSize: 100 })
  expect(ledger.rows.at(-1)?.runningBalanceMinor ?? 0).toBe(expected)
}

describe('customer ledger', () => {
  it('Opening → Payment → Adjustment → Payment → Void: the balance is Σ ledger after every event', () => {
    const customer = newCustomer('Ali Raza', 500000)
    expectBalance(customer, 500000)

    const first = createPayment(
      db,
      {
        requestId: 'ledger-payment-0001',
        customerId: customer.id,
        paymentDate: '2026-09-05',
        amountMinor: 200000,
        method: 'CASH',
        reference: null,
        note: null,
        currencyMinorDigits: 2
      },
      NOW
    )
    expect(first.balanceAfterMinor).toBe(300000)
    expectBalance(customer, 300000)

    const adjusted = adjustCustomerBalance(
      db,
      {
        customerId: customer.id,
        entryDate: '2026-09-08',
        direction: 'DECREASE',
        amountMinor: 50000,
        reason: 'Damaged goods allowance',
        currencyMinorDigits: 2
      },
      NOW
    )
    expect(adjusted.customer.balanceMinor).toBe(250000)
    expectBalance(customer, 250000)

    const second = createPayment(
      db,
      {
        requestId: 'ledger-payment-0002',
        customerId: customer.id,
        paymentDate: '2026-09-10',
        amountMinor: 400000,
        method: 'BANK',
        reference: 'TT-1',
        note: null,
        currencyMinorDigits: 2
      },
      NOW
    )
    expect(second.balanceAfterMinor).toBe(-150000)
    expectBalance(customer, -150000)

    const voided = voidPayment(db, { id: second.id, reason: 'Transfer returned' }, NOW)
    expect(voided.balanceAfterMinor).toBe(250000)
    expectBalance(customer, 250000)

    const ledger = customerLedger(db, { customerId: customer.id, page: 1, pageSize: 100 })
    expect(
      ledger.rows.map((row) => [
        row.entryDate,
        row.type,
        row.amountMinor,
        row.runningBalanceMinor,
        row.paymentNo
      ])
    ).toEqual([
      ['2026-09-01', 'OPENING', 500000, 500000, null],
      ['2026-09-05', 'PAYMENT', -200000, 300000, 'RCP-000001'],
      ['2026-09-08', 'ADJUSTMENT', -50000, 250000, null],
      ['2026-09-10', 'PAYMENT', -400000, -150000, 'RCP-000002'],
      ['2026-09-16', 'PAYMENT_VOID', 400000, 250000, 'RCP-000002']
    ])
    expect(ledger.rows[1]).toMatchObject({
      paymentId: first.id,
      paymentMethod: 'CASH',
      paymentStatus: 'POSTED'
    })
    expect(ledger.rows[3]).toMatchObject({
      paymentId: second.id,
      paymentMethod: 'BANK',
      paymentReference: 'TT-1',
      paymentStatus: 'VOID'
    })
    expect(ledger.rows[2].note).toBe('Damaged goods allowance')
    expect(ledger.rows[4].note).toBe('Transfer returned')
  })

  it('runs the balance in entry date order, then id', () => {
    const customer = newCustomer('Ali Raza', 0)
    // Written directly, out of date order, to prove the reading order (the services never write this way).
    for (const [date, amount] of [
      ['2026-09-03', 300],
      ['2026-09-01', 100],
      ['2026-09-03', -50],
      ['2026-09-02', 20]
    ] as const) {
      insertRow(db, 'customer_ledger', {
        customer_id: customer.id,
        entry_date: date,
        type: 'ADJUSTMENT',
        amount_minor: amount,
        note: 'Test'
      })
    }
    const rows = customerLedger(db, { customerId: customer.id, page: null, pageSize: 10 }).rows
    expect(rows.map((row) => [row.entryDate, row.amountMinor, row.runningBalanceMinor])).toEqual([
      ['2026-09-01', 100, 100],
      ['2026-09-02', 20, 120],
      ['2026-09-03', 300, 420],
      ['2026-09-03', -50, 370]
    ])
  })

  it('refuses an entry that would make the balance too large to keep exactly, and writes nothing', () => {
    const customer = newCustomer('Huge', 0)
    insertRow(db, 'customer_ledger', {
      customer_id: customer.id,
      entry_date: '2026-09-01',
      type: 'OPENING',
      amount_minor: Number.MAX_SAFE_INTEGER
    })
    const error = thrown(() =>
      adjustCustomerBalance(
        db,
        {
          customerId: customer.id,
          entryDate: '2026-09-16',
          direction: 'INCREASE',
          amountMinor: 1,
          reason: 'Overflow',
          currencyMinorDigits: 2
        },
        NOW
      )
    )
    expect(error).toBeInstanceOf(AppFailure)
    expect((error as AppFailure).error.code).toBe('VALIDATION')
    expect(ledgerSum(customer.id)).toBe(Number.MAX_SAFE_INTEGER)
    expect(
      String(
        thrown(() =>
          appendLedgerEntry(db, {
            customerId: customer.id,
            date: '2026-09-16',
            type: 'ADJUSTMENT',
            amountMinor: 1,
            note: 'Outside'
          })
        )
      )
    ).toContain('inside a transaction')
  })

  it('v_customer_balance matches Σ ledger for every customer, and each ledger is separate', () => {
    const due = newCustomer('Due', 750000)
    const advance = newCustomer('Advance', -75000)
    const settled = newCustomer('Settled', 0)
    createPayment(
      db,
      {
        requestId: 'ledger-payment-0003',
        customerId: due.id,
        paymentDate: '2026-09-16',
        amountMinor: 250000,
        method: 'CHEQUE',
        reference: null,
        note: null,
        currencyMinorDigits: 2
      },
      NOW
    )
    expectBalance(due, 500000)
    expectBalance(advance, -75000)
    expectBalance(settled, 0)
    const mismatches = db.all(
      `SELECT c.id FROM customers AS c JOIN v_customer_balance AS b ON b.customer_id = c.id
       WHERE b.balance_minor <> (SELECT coalesce(sum(amount_minor), 0) FROM customer_ledger WHERE customer_id = c.id)`
    )
    expect(mismatches).toEqual([])
  })
})
