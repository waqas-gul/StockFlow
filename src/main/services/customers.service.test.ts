import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BalanceAdjustmentInput, Customer, CustomerCreateInput } from '@shared/customers'
import type { Db } from '../db/adapter'
import {
  createSchemaDatabase,
  createTempDir,
  insertRow,
  thrown,
  type TempDir
} from '../db/test-utils'
import { AppFailure } from '../errors'
import {
  adjustCustomerBalance,
  createCustomer,
  customerLedger,
  getCustomer,
  listCustomers,
  postOpeningBalance,
  searchCustomers,
  setCustomerActive,
  updateCustomer
} from './customers.service'
import { failingWrites } from './test-utils'

// Test data lives only in temporary databases.

const NOW = new Date(2026, 8, 16, 10, 30, 0)
const TODAY = '2026-09-16'
const YESTERDAY = '2026-09-15'

let temp: TempDir
let db: Db

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
})

afterEach(() => {
  temp.remove()
})

function customerInput(overrides: Partial<CustomerCreateInput> = {}): CustomerCreateInput {
  return {
    name: 'Ali Raza',
    shopName: 'Ali Traders',
    phone: '0300-1234567',
    address: 'Main Bazar',
    city: 'Lahore',
    notes: null,
    opening: null,
    currencyMinorDigits: 2,
    ...overrides
  }
}

function create(overrides: Partial<CustomerCreateInput> = {}, target: Db = db): Customer {
  return createCustomer(target, customerInput(overrides), NOW)
}

function adjustmentInput(
  customerId: number,
  overrides: Partial<BalanceAdjustmentInput> = {}
): BalanceAdjustmentInput {
  return {
    customerId,
    entryDate: TODAY,
    direction: 'INCREASE',
    amountMinor: 10000,
    reason: 'Old bill found',
    currencyMinorDigits: 2,
    ...overrides
  }
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

function ledger(customerId: number): Array<Record<string, unknown>> {
  return db.all(
    'SELECT entry_date, type, amount_minor, payment_id, note FROM customer_ledger WHERE customer_id = ? ORDER BY id',
    [customerId]
  )
}

function ledgerSum(customerId: number): number {
  return db.get<{ total: number }>(
    'SELECT coalesce(sum(amount_minor), 0) AS total FROM customer_ledger WHERE customer_id = ?',
    [customerId]
  )!.total
}

describe('createCustomer', () => {
  it('creates a customer with the next code after the seeded walk-in customer, and no ledger entry', () => {
    const customer = create({ notes: '  Pays on Fridays ' })

    expect(customer).toEqual({
      id: expect.any(Number),
      code: 'C-00002',
      name: 'Ali Raza',
      shopName: 'Ali Traders',
      phone: '0300-1234567',
      address: 'Main Bazar',
      city: 'Lahore',
      notes: 'Pays on Fridays',
      isActive: true,
      balanceMinor: 0,
      latestEntryDate: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String)
    })
    expect(nextSequence('customer')).toBe(3)
    expect(count('customer_ledger')).toBe(0)
    expect(db.all('SELECT code, name, is_active FROM customers WHERE id = 1')).toEqual([
      { code: 'C-00001', name: 'Cash / Walk-in', is_active: 1 }
    ])
  })

  it('numbers customers C-00002, C-00003, … and keeps blank optional fields empty', () => {
    const first = create()
    const second = create({ name: 'Bilal', shopName: '', phone: ' ', address: null, city: '' })
    expect([first.code, second.code]).toEqual(['C-00002', 'C-00003'])
    expect(second).toMatchObject({ shopName: null, phone: null, address: null, city: null })
  })

  it('allows the same name and the same shop name for different customers', () => {
    const first = create({ name: 'Ali Raza', shopName: 'Ali Traders' })
    const second = create({ name: 'ali raza', shopName: 'Ali Traders' })
    expect(second.code).not.toBe(first.code)
    expect(count('customers')).toBe(3)
  })

  it('requires a name, and a refused customer does not use a code', () => {
    const error = failure(() => create({ name: '   ' }))
    expect(error.code).toBe('VALIDATION')
    expect(error.fieldErrors?.name).toEqual(['Enter the customer name.'])
    expect(count('customers')).toBe(1)
    expect(nextSequence('customer')).toBe(2)
  })

  it('does not use a code when saving fails part-way', () => {
    const error = thrown(() => create({}, failingWrites(db, /INSERT INTO customers/)))
    expect(String(error)).toContain('simulated write failure')
    expect(count('customers')).toBe(1)
    expect(nextSequence('customer')).toBe(2)
    expect(create().code).toBe('C-00002')
  })

  it('refuses cleanly when the next code is already taken, without saving anything', () => {
    insertRow(db, 'customers', { code: 'C-00002', name: 'Imported' })
    const error = failure(() => create())
    expect(error.code).toBe('CONFLICT')
    expect(error.message).toContain('C-00002')
    expect(count('customers')).toBe(2)
    expect(nextSequence('customer')).toBe(2)
  })

  it('refuses amounts entered with other currency decimal places', () => {
    const error = failure(() =>
      create({
        currencyMinorDigits: 0,
        opening: { side: 'DUE', amountMinor: 5000, date: TODAY }
      })
    )
    expect(error.code).toBe('CONFLICT')
    expect(count('customers')).toBe(1)
  })
})

describe('opening balance', () => {
  it('a customer who owes the shop gets one positive OPENING entry on the opening date', () => {
    const customer = create({ opening: { side: 'DUE', amountMinor: 500000, date: YESTERDAY } })
    expect(customer.balanceMinor).toBe(500000)
    expect(customer.latestEntryDate).toBe(YESTERDAY)
    expect(ledger(customer.id)).toEqual([
      { entry_date: YESTERDAY, type: 'OPENING', amount_minor: 500000, payment_id: null, note: null }
    ])
  })

  it('a customer advance is a negative OPENING entry', () => {
    const customer = create({ opening: { side: 'ADVANCE', amountMinor: 75000, date: TODAY } })
    expect(customer.balanceMinor).toBe(-75000)
    expect(ledger(customer.id)).toMatchObject([{ type: 'OPENING', amount_minor: -75000 }])
  })

  it('a zero or missing opening balance writes no ledger entry', () => {
    const zero = create({ opening: { side: 'DUE', amountMinor: 0, date: TODAY } })
    const none = create({ opening: null })
    expect(ledger(zero.id)).toEqual([])
    expect(ledger(none.id)).toEqual([])
    expect([zero.balanceMinor, none.balanceMinor]).toEqual([0, 0])
  })

  it('requires an opening date that is not in the future', () => {
    const missing = failure(() =>
      createCustomer(db, { ...customerInput(), opening: { side: 'DUE', amountMinor: 100 } }, NOW)
    )
    expect(missing.code).toBe('VALIDATION')
    expect(missing.fieldErrors?.['opening.date']).toEqual(['Enter the date.'])

    const future = failure(() =>
      create({ opening: { side: 'DUE', amountMinor: 100, date: '2026-09-17' } })
    )
    expect(future.code).toBe('DATE_NOT_ALLOWED')
    expect(future.fieldErrors?.['opening.date']).toBeDefined()
    expect(count('customers')).toBe(1)
    expect(nextSequence('customer')).toBe(2)
  })

  it('saves the customer and its opening entry together, or neither', () => {
    const error = thrown(() =>
      create(
        { opening: { side: 'DUE', amountMinor: 500000, date: TODAY } },
        failingWrites(db, /INSERT INTO customer_ledger/)
      )
    )
    expect(String(error)).toContain('simulated write failure')
    expect(count('customers')).toBe(1)
    expect(count('customer_ledger')).toBe(0)
    expect(nextSequence('customer')).toBe(2)
  })

  it('refuses a second opening balance', () => {
    const customer = create({ opening: { side: 'DUE', amountMinor: 500000, date: TODAY } })
    const error = failure(() =>
      db.transaction(() =>
        postOpeningBalance(db, customer.id, { side: 'DUE', amountMinor: 100, date: TODAY }, TODAY)
      )
    )
    expect(error.code).toBe('FORBIDDEN_STATE')
    expect(error.message).toContain('Adjust Balance')
    expect(ledger(customer.id)).toHaveLength(1)
  })

  it('refuses an opening balance once any other ledger activity exists', () => {
    const customer = create()
    adjustCustomerBalance(db, adjustmentInput(customer.id), NOW)
    const error = failure(() =>
      db.transaction(() =>
        postOpeningBalance(
          db,
          customer.id,
          { side: 'ADVANCE', amountMinor: 100, date: TODAY },
          TODAY
        )
      )
    )
    expect(error.code).toBe('FORBIDDEN_STATE')
    expect(ledger(customer.id).map((row) => row.type)).toEqual(['ADJUSTMENT'])
  })

  it('cannot be changed through a profile edit', () => {
    const customer = create({ opening: { side: 'DUE', amountMinor: 500000, date: TODAY } })
    const error = failure(() =>
      updateCustomer(db, {
        id: customer.id,
        name: 'Ali',
        shopName: null,
        phone: null,
        address: null,
        city: null,
        notes: null,
        opening: { side: 'ADVANCE', amountMinor: 1, date: TODAY }
      })
    )
    expect(error.code).toBe('VALIDATION')
    expect(ledger(customer.id)).toMatchObject([{ type: 'OPENING', amount_minor: 500000 }])
  })
})

describe('updateCustomer and setCustomerActive', () => {
  it('edits the profile only: the code and every ledger entry stay as they were', () => {
    const customer = create({ opening: { side: 'DUE', amountMinor: 500000, date: TODAY } })
    const before = db.all('SELECT * FROM customer_ledger')
    const updated = updateCustomer(db, {
      id: customer.id,
      name: 'Ali Raza Khan',
      shopName: 'Khan Traders',
      phone: '0321-7654321',
      address: 'Anarkali',
      city: 'Karachi',
      notes: 'New shop'
    })
    expect(updated).toMatchObject({
      id: customer.id,
      code: 'C-00002',
      name: 'Ali Raza Khan',
      shopName: 'Khan Traders',
      city: 'Karachi',
      notes: 'New shop',
      balanceMinor: 500000
    })
    expect(db.all('SELECT * FROM customer_ledger')).toEqual(before)
    expect(getCustomer(db, customer.id)).toEqual(updated)
  })

  it('refuses a missing customer', () => {
    const error = failure(() =>
      updateCustomer(db, {
        id: 999,
        name: 'Nobody',
        shopName: null,
        phone: null,
        address: null,
        city: null,
        notes: null
      })
    )
    expect(error.code).toBe('NOT_FOUND')
    expect(failure(() => getCustomer(db, 999)).code).toBe('NOT_FOUND')
  })

  it('deactivates and reactivates a customer without touching the balance or history', () => {
    const customer = create({ opening: { side: 'DUE', amountMinor: 500000, date: TODAY } })
    const inactive = setCustomerActive(db, { id: customer.id, active: false })
    expect(inactive).toMatchObject({ isActive: false, balanceMinor: 500000 })
    expect(customerLedger(db, { customerId: customer.id, page: null, pageSize: 50 }).total).toBe(1)
    const active = setCustomerActive(db, { id: customer.id, active: true })
    expect(active).toMatchObject({ isActive: true, balanceMinor: 500000 })
    expect(count('customers')).toBe(2)
    expect(failure(() => setCustomerActive(db, { id: 999, active: false })).code).toBe('NOT_FOUND')
  })
})

describe('listCustomers and searchCustomers', () => {
  function seedCustomers(): Record<string, Customer> {
    return {
      ali: create({
        name: 'Ali Raza',
        shopName: 'Ali Traders',
        phone: '0300-1234567',
        city: 'Lahore'
      }),
      bilal: create({
        name: 'Bilal Ahmed',
        shopName: 'Madina Store',
        phone: '0321 5550000',
        city: 'Karachi',
        opening: { side: 'DUE', amountMinor: 250000, date: TODAY }
      }),
      zara: create({
        name: 'Zara 100% Stores',
        shopName: null,
        phone: null,
        city: 'Multan',
        opening: { side: 'ADVANCE', amountMinor: 1000, date: TODAY }
      })
    }
  }

  function names(search: string, status: 'active' | 'inactive' | 'all' = 'all'): string[] {
    return listCustomers(db, { page: 1, pageSize: 25, search, status }).items.map(
      (item) => item.name
    )
  }

  it('searches by code, name, shop, phone and city, ignoring letter case', () => {
    seedCustomers()
    expect(names('c-00003')).toEqual(['Bilal Ahmed'])
    expect(names('RAZA')).toEqual(['Ali Raza'])
    expect(names('madina')).toEqual(['Bilal Ahmed'])
    expect(names('0300-123')).toEqual(['Ali Raza'])
    expect(names('03001234567')).toEqual(['Ali Raza'])
    expect(names('03215550000')).toEqual(['Bilal Ahmed'])
    expect(names('karachi')).toEqual(['Bilal Ahmed'])
    expect(names('ali lahore')).toEqual(['Ali Raza'])
    expect(names('100%')).toEqual(['Zara 100% Stores'])
    expect(names('0%')).toEqual(['Zara 100% Stores'])
    expect(names('nobody')).toEqual([])
  })

  it('lists by name with each balance from the ledger, and filters by status', () => {
    const { bilal, zara } = seedCustomers()
    setCustomerActive(db, { id: zara.id, active: false })
    const all = listCustomers(db, { page: 1, pageSize: 25, search: '', status: 'all' })
    expect(
      all.items.map((item) => [item.code, item.name, item.balanceMinor, item.isActive])
    ).toEqual([
      ['C-00002', 'Ali Raza', 0, true],
      ['C-00003', 'Bilal Ahmed', 250000, true],
      ['C-00001', 'Cash / Walk-in', 0, true],
      ['C-00004', 'Zara 100% Stores', -1000, false]
    ])
    for (const item of all.items) expect(item.balanceMinor).toBe(ledgerSum(item.id))
    expect(names('', 'active')).toEqual(['Ali Raza', 'Bilal Ahmed', 'Cash / Walk-in'])
    expect(names('', 'inactive')).toEqual(['Zara 100% Stores'])
    expect(all.items[1]).toEqual({
      id: bilal.id,
      code: 'C-00003',
      name: 'Bilal Ahmed',
      shopName: 'Madina Store',
      phone: '0321 5550000',
      city: 'Karachi',
      isActive: true,
      balanceMinor: 250000
    })
  })

  it('pages the list', () => {
    for (let index = 1; index <= 30; index++) {
      create({ name: `Customer ${String(index).padStart(2, '0')}` })
    }
    const first = listCustomers(db, { page: 1, pageSize: 25, search: '', status: 'all' })
    const second = listCustomers(db, { page: 2, pageSize: 25, search: '', status: 'all' })
    expect(first.total).toBe(31)
    expect(first.items).toHaveLength(25)
    expect(second.items).toHaveLength(6)
    expect(second.items.at(-1)?.name).toBe('Customer 30')
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(31)
    expect(
      failure(() => listCustomers(db, { page: 1, pageSize: 500, search: '', status: 'all' })).code
    ).toBe('VALIDATION')
  })

  it('quick search puts an exact code first and leaves out inactive customers unless asked', () => {
    const { ali, zara } = seedCustomers()
    create({ name: 'C-00002 fan club' })
    setCustomerActive(db, { id: zara.id, active: false })
    const found = searchCustomers(db, { query: 'C-00002', limit: 10, includeInactive: false })
    expect(found[0].id).toBe(ali.id)
    expect(searchCustomers(db, { query: 'multan', limit: 10, includeInactive: false })).toEqual([])
    expect(
      searchCustomers(db, { query: 'multan', limit: 10, includeInactive: true }).map(
        (item) => item.id
      )
    ).toEqual([zara.id])
    expect(searchCustomers(db, { query: '  ', limit: 10, includeInactive: true })).toEqual([])
  })
})

describe('adjustCustomerBalance', () => {
  it('an increase makes the customer owe more; a decrease owe less, down to an advance', () => {
    const customer = create({ opening: { side: 'DUE', amountMinor: 50000, date: YESTERDAY } })
    const up = adjustCustomerBalance(
      db,
      adjustmentInput(customer.id, { amountMinor: 20000, reason: 'Missed freight' }),
      NOW
    )
    expect(up.customer.balanceMinor).toBe(70000)
    expect(up.entry).toMatchObject({
      entryDate: TODAY,
      type: 'ADJUSTMENT',
      amountMinor: 20000,
      runningBalanceMinor: 70000,
      note: 'Missed freight'
    })
    const down = adjustCustomerBalance(
      db,
      adjustmentInput(customer.id, {
        direction: 'DECREASE',
        amountMinor: 90000,
        reason: 'Discount agreed'
      }),
      NOW
    )
    expect(down.customer.balanceMinor).toBe(-20000)
    expect(down.entry.amountMinor).toBe(-90000)
    expect(ledgerSum(customer.id)).toBe(-20000)
  })

  it('requires a reason and an amount above zero', () => {
    const customer = create()
    const noReason = failure(() =>
      adjustCustomerBalance(db, adjustmentInput(customer.id, { reason: ' ' }), NOW)
    )
    expect(noReason.fieldErrors?.reason).toBeDefined()
    const zero = failure(() =>
      adjustCustomerBalance(db, adjustmentInput(customer.id, { amountMinor: 0 }), NOW)
    )
    expect(zero.fieldErrors?.amountMinor).toBeDefined()
    expect(count('customer_ledger')).toBe(0)
    expect(failure(() => adjustCustomerBalance(db, adjustmentInput(999), NOW)).code).toBe(
      'NOT_FOUND'
    )
  })

  it('corrects an inactive customer, who stays inactive', () => {
    const customer = create()
    setCustomerActive(db, { id: customer.id, active: false })
    const result = adjustCustomerBalance(db, adjustmentInput(customer.id), NOW)
    expect(result.customer).toMatchObject({ isActive: false, balanceMinor: 10000 })
  })

  it('respects the customer posting-date floor and refuses future dates', () => {
    const customer = create({ opening: { side: 'DUE', amountMinor: 50000, date: TODAY } })
    const early = failure(() =>
      adjustCustomerBalance(db, adjustmentInput(customer.id, { entryDate: YESTERDAY }), NOW)
    )
    expect(early).toMatchObject({
      code: 'DATE_NOT_ALLOWED',
      message:
        'C-00002 Ali Raza (Ali Traders) has account activity on 16-Sep-2026. Use that date or later.',
      details: { earliestDate: TODAY, customerId: customer.id, customerCode: 'C-00002' }
    })
    expect(early.fieldErrors?.entryDate).toBeDefined()
    const future = failure(() =>
      adjustCustomerBalance(db, adjustmentInput(customer.id, { entryDate: '2026-09-17' }), NOW)
    )
    expect(future.code).toBe('DATE_NOT_ALLOWED')
    expect(future.details).toEqual({ latestDate: TODAY })
    expect(ledger(customer.id)).toHaveLength(1)
  })

  it('activity of another customer never blocks a backdated entry', () => {
    const other = create({ name: 'Other', opening: { side: 'DUE', amountMinor: 100, date: TODAY } })
    const customer = create({ opening: { side: 'DUE', amountMinor: 100, date: '2026-09-10' } })
    adjustCustomerBalance(db, adjustmentInput(other.id), NOW)
    const result = adjustCustomerBalance(
      db,
      adjustmentInput(customer.id, { entryDate: '2026-09-12' }),
      NOW
    )
    expect(result.entry.entryDate).toBe('2026-09-12')
  })

  it('writes nothing when saving fails', () => {
    const customer = create()
    thrown(() =>
      adjustCustomerBalance(
        failingWrites(db, /INSERT INTO customer_ledger/),
        adjustmentInput(customer.id),
        NOW
      )
    )
    expect(count('customer_ledger')).toBe(0)
  })
})

describe('customerLedger', () => {
  it('pages the entries oldest first with the running balance, opening on the last page', () => {
    const customer = create({ opening: { side: 'DUE', amountMinor: 1000, date: '2026-09-01' } })
    for (let day = 2; day <= 5; day++) {
      adjustCustomerBalance(
        db,
        adjustmentInput(customer.id, {
          entryDate: `2026-09-0${day}`,
          amountMinor: 100 * day,
          reason: `Day ${day}`
        }),
        NOW
      )
    }
    const last = customerLedger(db, { customerId: customer.id, page: null, pageSize: 2 })
    expect(last).toMatchObject({ total: 5, page: 3, pageSize: 2 })
    expect(last.customer).toMatchObject({ code: 'C-00002', balanceMinor: 2400 })
    expect(
      last.rows.map((row) => [row.entryDate, row.amountMinor, row.runningBalanceMinor])
    ).toEqual([['2026-09-05', 500, 2400]])
    const first = customerLedger(db, { customerId: customer.id, page: 1, pageSize: 2 })
    expect(first.rows.map((row) => [row.type, row.runningBalanceMinor])).toEqual([
      ['OPENING', 1000],
      ['ADJUSTMENT', 1200]
    ])
    expect(customerLedger(db, { customerId: create().id, page: null, pageSize: 2 })).toMatchObject({
      total: 0,
      page: 1,
      rows: []
    })
    expect(
      failure(() => customerLedger(db, { customerId: 999, page: null, pageSize: 2 })).code
    ).toBe('NOT_FOUND')
  })
})
