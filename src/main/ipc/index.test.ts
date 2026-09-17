import type { IpcMainInvokeEvent } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ipcCalls } from '@shared/ipc-contract'
import { MINOR_DIGITS_LOCKED_MESSAGE } from '@shared/settings'
import type { Result } from '@shared/types/result'
import { backupFolder } from '../data-paths'
import {
  LATEST_SCHEMA_VERSION,
  createTempDir,
  insertMasters,
  insertRow,
  rows,
  type TempDir
} from '../db/test-utils'
import { DEFAULT_SETTINGS, readSettings } from '../services/settings.service'
import { createServicesFixture, type ServicesFixture } from '../services/test-utils'
import { registerIpc } from './index'

type Listener = (event: IpcMainInvokeEvent, input?: unknown) => Promise<Result<unknown>>

const APP_URL = 'http://localhost:5173/#/settings'
const trusted = { senderFrame: { url: APP_URL } } as unknown as IpcMainInvokeEvent
const untrusted = { senderFrame: { url: 'https://evil.example/' } } as unknown as IpcMainInvokeEvent

const EDITABLE_DEFAULTS = {
  'business.name': 'StockFlow',
  'currency.code': 'PKR',
  'currency.symbol': 'Rs',
  'currency.minorDigits': 2,
  'invoice.prefix': 'INV-',
  'invoice.padding': 6,
  'invoice.startNumber': 1,
  'invoice.paperSize': 'A4'
}

/** Path-like values a compromised renderer could try to send. */
const PATHS: unknown[] = [
  'C:\\Windows\\System32\\x.db',
  { path: 'C:\\Windows\\x.db' },
  { folder: 'E:\\' },
  { file: '..\\..\\shop.db' },
  ['C:\\x.db'],
  null
]

let temp: TempDir
let fixture: ServicesFixture
let listeners: Map<string, Listener>

beforeEach(async () => {
  temp = createTempDir()
  fixture = await createServicesFixture(temp)
  listeners = new Map()
  registerIpc(
    { handle: (channel, listener) => listeners.set(channel, listener as Listener) },
    {
      appInfo: {
        appVersion: '1.0.0',
        isDev: true,
        dataDir: 'C:\\Users\\owner\\AppData\\Roaming\\StockFlow-dev\\data',
        appDataPath: 'C:\\Users\\owner\\AppData\\Roaming'
      },
      database: fixture.database,
      backups: fixture.backups,
      restore: fixture.restore,
      ctx: fixture.ctx
    },
    {
      isTrustedSender: (event) => event.senderFrame?.url === APP_URL,
      log: { warn: () => undefined, error: () => undefined }
    }
  )
})

afterEach(() => {
  temp.remove()
})

function call(
  channel: string,
  input?: unknown,
  event: IpcMainInvokeEvent = trusted
): Promise<Result<unknown>> {
  const listener = listeners.get(channel)
  if (!listener) throw new Error(`No listener registered for ${channel}`)
  return listener(event, input)
}

function backupFiles(): string[] {
  const folder = fixture.ctx.paths.backupsDir
  return existsSync(folder) ? readdirSync(folder, { recursive: true }).map(String).sort() : []
}

describe('registerIpc', () => {
  it('registers exactly the calls of the shared contract', () => {
    expect([...listeners.keys()]).toEqual(ipcCalls.map((ipcCall) => ipcCall.channel))
  })

  it('answers app:info from the open database', async () => {
    await expect(call('app:info')).resolves.toEqual({
      ok: true,
      data: {
        appVersion: '1.0.0',
        mode: 'development',
        databaseDriver: 'better-sqlite3',
        sqliteVersion: expect.stringMatching(/^3\./),
        schemaVersion: LATEST_SCHEMA_VERSION,
        dataDirectory: '%APPDATA%\\StockFlow-dev\\data'
      }
    })
  })

  it('rejects any input to app:info', async () => {
    await expect(call('app:info', { path: 'C:\\Windows' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' }
    })
  })

  it('refuses every call from an untrusted sender without running it', async () => {
    for (const { channel } of ipcCalls) {
      await expect(call(channel, undefined, untrusted)).resolves.toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' }
      })
    }
    expect(fixture.dialogs.saveRequests).toEqual([])
    expect(fixture.dialogs.openRequests).toEqual([])
    expect(fixture.opened).toEqual([])
    expect(backupFiles()).toEqual(['auto', 'pre-migration', 'pre-restore'])
  })
})

describe('settings', () => {
  it('settings:get returns the business, currency and invoice settings only, and the decimal places lock', async () => {
    await expect(call('settings:get')).resolves.toEqual({
      ok: true,
      data: { values: EDITABLE_DEFAULTS, minorDigitsLocked: false }
    })
  })

  it('settings:update validates again in the main process, saves, and returns the settings', async () => {
    const result = await call('settings:update', {
      'business.name': '  Ali Traders  ',
      'invoice.paperSize': 'A5'
    })
    expect(result).toEqual({
      ok: true,
      data: {
        values: { ...EDITABLE_DEFAULTS, 'business.name': 'Ali Traders', 'invoice.paperSize': 'A5' },
        minorDigitsLocked: false
      }
    })
    expect(readSettings(fixture.db)['business.name']).toBe('Ali Traders')
  })

  it('settings:update refuses other decimal places once financial data exists, but not a symbol or code', async () => {
    insertRow(fixture.db, 'expenses', rows.expense(insertMasters(fixture.db)))
    await expect(call('settings:get')).resolves.toMatchObject({
      ok: true,
      data: { minorDigitsLocked: true }
    })

    await expect(call('settings:update', { 'currency.minorDigits': 0 })).resolves.toEqual({
      ok: false,
      error: {
        code: 'SETTING_LOCKED',
        message: MINOR_DIGITS_LOCKED_MESSAGE,
        fieldErrors: { 'currency.minorDigits': [MINOR_DIGITS_LOCKED_MESSAGE] }
      }
    })
    expect(readSettings(fixture.db)['currency.minorDigits']).toBe(2)

    await expect(
      call('settings:update', { 'currency.code': 'USD', 'currency.symbol': '$' })
    ).resolves.toEqual({
      ok: true,
      data: {
        values: { ...EDITABLE_DEFAULTS, 'currency.code': 'USD', 'currency.symbol': '$' },
        minorDigitsLocked: true
      }
    })
  })

  it.each<[string, unknown, string]>([
    ['an invalid value', { 'business.name': '   ' }, 'business.name'],
    ['a wrong type', { 'currency.minorDigits': '2' }, 'currency.minorDigits'],
    ['an automatic backup setting', { 'backup.autoEnabled': false }, 'root'],
    ['a retention setting', { 'backup.keepDaily': 1 }, 'root'],
    ['a negative-stock setting', { 'stock.allowNegative': true }, 'root'],
    ['a path next to a valid value', { 'business.name': 'Shop', path: 'C:\\x' }, 'root']
  ])('settings:update refuses %s and changes nothing', async (_label, input, field) => {
    const result = await call('settings:update', input)
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    if (!result.ok) expect(result.error.fieldErrors).toHaveProperty([field])
    expect(readSettings(fixture.db)).toEqual(DEFAULT_SETTINGS)
  })

  it('settings:update refuses anything that is not an object', async () => {
    for (const input of ['business.name', 42, null, undefined, [{ 'business.name': 'x' }]]) {
      await expect(call('settings:update', input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'VALIDATION' }
      })
    }
    expect(readSettings(fixture.db)).toEqual(DEFAULT_SETTINGS)
  })
})

describe('companies and products', () => {
  const unit = {
    id: null,
    name: 'Piece',
    shortName: null,
    baseQty: 1,
    isBase: true,
    canSell: true,
    canPurchase: true,
    wholesalePriceMinor: null,
    retailPriceMinor: 1250,
    defaultCostMinor: null,
    isActive: true
  }
  const product = {
    code: 'P-001',
    name: 'Tea 950g',
    companyId: null,
    packingLabel: '1*12*18',
    lowStockThresholdBase: 0,
    currencyMinorDigits: 2,
    units: [unit]
  }

  it('manages companies through IPC, with duplicate names refused cleanly', async () => {
    const created = await call('companies:create', { name: ' Acme ' })
    expect(created).toMatchObject({
      ok: true,
      data: { name: 'Acme', isActive: true, productCount: 0 }
    })
    const id = created.ok ? (created.data as { id: number }).id : 0
    await expect(call('companies:create', { name: 'ACME' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'DUPLICATE',
        message: 'A company named "ACME" already exists.',
        fieldErrors: { name: ['A company named "ACME" already exists.'] }
      }
    })
    await expect(call('companies:update', { id, name: 'Acme Foods' })).resolves.toMatchObject({
      ok: true,
      data: { name: 'Acme Foods' }
    })
    await expect(call('companies:setActive', { id, active: false })).resolves.toMatchObject({
      ok: true,
      data: { isActive: false }
    })
    await expect(call('companies:list')).resolves.toMatchObject({
      ok: true,
      data: [{ id, name: 'Acme Foods', isActive: false }]
    })
  })

  it('creates, reads, lists, searches, updates and deactivates a product through IPC', async () => {
    const created = await call('products:create', product)
    expect(created).toMatchObject({
      ok: true,
      data: { code: 'P-001', stockQtyBase: 0, hasStockMovements: false }
    })
    const saved = (created as { data: { id: number; units: Array<{ id: number }> } }).data

    await expect(call('products:get', saved.id)).resolves.toMatchObject({
      ok: true,
      data: { id: saved.id }
    })
    await expect(
      call('products:list', {
        page: 1,
        pageSize: 25,
        search: 'tea',
        companyId: null,
        status: 'active'
      })
    ).resolves.toMatchObject({ ok: true, data: { total: 1, items: [{ code: 'P-001' }] } })
    await expect(
      call('products:search', { query: 'p-001', limit: 10, includeInactive: false })
    ).resolves.toMatchObject({ ok: true, data: [{ id: saved.id }] })
    await expect(
      call('products:update', {
        ...product,
        id: saved.id,
        units: [{ ...unit, id: saved.units[0].id, retailPriceMinor: 1300 }]
      })
    ).resolves.toMatchObject({ ok: true, data: { units: [{ retailPriceMinor: 1300 }] } })
    await expect(call('products:setActive', { id: saved.id, active: false })).resolves.toEqual({
      ok: true,
      data: { id: saved.id, isActive: false, stockQtyBase: 0, warning: null }
    })
    // A configured price locks the currency decimal places (Phase 4C).
    await expect(call('settings:get')).resolves.toMatchObject({
      ok: true,
      data: { minorDigitsLocked: true }
    })
  })

  it('maps business errors to clean messages, never SQLite text', async () => {
    await call('products:create', product)
    const duplicate = await call('products:create', { ...product, name: 'Other' })
    expect(duplicate).toEqual({
      ok: false,
      error: {
        code: 'DUPLICATE',
        message: 'Another product already uses the code "P-001".',
        fieldErrors: { code: ['Another product already uses the code "P-001".'] }
      }
    })
    const nested = await call('products:create', {
      ...product,
      code: 'P-002',
      units: [
        unit,
        { ...unit, name: 'Pack', baseQty: 4, isBase: false },
        { ...unit, name: 'Box', baseQty: 6, isBase: false }
      ]
    })
    expect(nested).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION',
        fieldErrors: { 'units.2.baseQty': ['Must be a whole multiple of 4 (Pack).'] }
      }
    })
    await expect(call('products:get', 999)).resolves.toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'This product no longer exists.' }
    })
    expect(JSON.stringify([duplicate, nested])).not.toMatch(/SQLITE|constraint|UNIQUE/i)
  })

  it.each<[string, string, unknown]>([
    ['a product id as text', 'products:get', '1'],
    [
      'a product with an extra field',
      'products:create',
      { ...product, sql: 'DROP TABLE products' }
    ],
    [
      'a list page size over 100',
      'products:list',
      { page: 1, pageSize: 1000, search: '', companyId: null, status: 'all' }
    ],
    ['a company without a name', 'companies:create', {}],
    ['companies:list with input', 'companies:list', { path: 'C:\\x' }]
  ])('refuses %s at the IPC boundary', async (_label, channel, input) => {
    await expect(call(channel, input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' }
    })
  })
})

describe('stock', () => {
  // The fixture clock reads 14 Sep 2026: the main process dates documents by it.
  const TODAY = '2026-09-14'
  const pieceUnit = {
    id: null,
    name: 'Piece',
    shortName: null,
    baseQty: 1,
    isBase: true,
    canSell: true,
    canPurchase: true,
    wholesalePriceMinor: null,
    retailPriceMinor: null,
    defaultCostMinor: null,
    isActive: true
  }

  async function createTea(): Promise<{ productId: number; unitId: number }> {
    const created = await call('products:create', {
      code: 'P-001',
      name: 'Tea 950g',
      companyId: null,
      packingLabel: null,
      lowStockThresholdBase: 0,
      currencyMinorDigits: 2,
      units: [pieceUnit]
    })
    const data = (created as { data: { id: number; units: Array<{ id: number }> } }).data
    return { productId: data.id, unitId: data.units[0].id }
  }

  function adjustment(
    productId: number,
    unitId: number,
    overrides: Record<string, unknown>
  ): unknown {
    return {
      requestId: 'ipc-adjust-0001',
      adjustmentDate: TODAY,
      productId,
      reason: 'DAMAGE',
      direction: null,
      unitId,
      quantity: 1,
      unitCostMinor: null,
      receiptItemId: null,
      reasonNote: 'Broken',
      currencyMinorDigits: 2,
      ...overrides
    }
  }

  it('receives, lists, reads, voids and adjusts stock through IPC, dated by the main process clock', async () => {
    const { productId, unitId } = await createTea()
    const received = await call('stock:receive', {
      requestId: 'ipc-receipt-0001',
      receiptDate: TODAY,
      supplierName: 'Acme',
      reference: null,
      note: null,
      currencyMinorDigits: 2,
      lines: [{ productId, unitId, quantity: 10, unitCostMinor: 1000 }]
    })
    expect(received).toMatchObject({
      ok: true,
      data: { receiptNo: 'GRN-000001', totalCostMinor: 10000 }
    })
    const receiptId = (received as { data: { id: number } }).data.id

    await expect(
      call('stock:listReceipts', { page: 1, pageSize: 10, search: '' })
    ).resolves.toMatchObject({
      ok: true,
      data: { total: 1, items: [{ id: receiptId, voidable: true }] }
    })
    await expect(call('stock:getReceipt', receiptId)).resolves.toMatchObject({
      ok: true,
      data: { id: receiptId }
    })
    await expect(call('stock:summary', productId)).resolves.toEqual({
      ok: true,
      data: {
        productId,
        qtyBase: 10,
        valueMinor: 10000,
        hasMovements: true,
        latestMovementDate: TODAY
      }
    })
    await expect(call('stock:postingFloor', { productIds: [productId] })).resolves.toMatchObject({
      ok: true,
      data: { today: TODAY, earliestDate: TODAY }
    })
    await expect(
      call('stock:voidReceipt', { id: receiptId, reason: 'Keyed twice' })
    ).resolves.toMatchObject({ ok: true, data: { status: 'VOID', voidDate: TODAY } })

    const corrected = await call(
      'stock:adjust',
      adjustment(productId, unitId, {
        reason: 'OTHER_CORRECTION',
        direction: 'IN',
        quantity: 4,
        unitCostMinor: 500,
        reasonNote: 'Found in the store room'
      })
    )
    expect(corrected).toMatchObject({
      ok: true,
      data: { adjustmentNo: 'ADJ-000001', valueMinor: 2000 }
    })
    await expect(
      call('stock:listAdjustments', { page: 1, pageSize: 10, productId })
    ).resolves.toMatchObject({ ok: true, data: { total: 1 } })
    await expect(
      call('stock:stockCard', { productId, page: null, pageSize: 50 })
    ).resolves.toMatchObject({ ok: true, data: { qtyBase: 4, valueMinor: 2000, total: 3 } })
  })

  it('returns stock errors as clean AppErrors, never SQLite text', async () => {
    const { productId, unitId } = await createTea()
    const tooMuch = await call('stock:adjust', adjustment(productId, unitId, {}))
    expect(tooMuch).toMatchObject({ ok: false, error: { code: 'INSUFFICIENT_STOCK' } })
    const future = await call('stock:receive', {
      requestId: 'ipc-receipt-0002',
      receiptDate: '2026-09-15',
      supplierName: null,
      reference: null,
      note: null,
      currencyMinorDigits: 2,
      lines: [{ productId, unitId, quantity: 1, unitCostMinor: 1 }]
    })
    expect(future).toMatchObject({ ok: false, error: { code: 'DATE_NOT_ALLOWED' } })
    await expect(call('stock:getReceipt', 42)).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' }
    })
    expect(JSON.stringify([tooMuch, future])).not.toMatch(/SQLITE|constraint/i)
  })

  it.each<[string, string, unknown]>([
    [
      'a receipt with an extra field',
      'stock:receive',
      { requestId: 'ipc-receipt-0003', sql: 'DELETE FROM stock_movements' }
    ],
    [
      'a stock card page size over 100',
      'stock:stockCard',
      { productId: 1, page: 1, pageSize: 500 }
    ],
    ['a reason code outside the fixed list', 'stock:adjust', { reason: 'GIFT' }],
    ['a receipt id as text', 'stock:getReceipt', '1'],
    ['a void without a reason', 'stock:voidReceipt', { id: 1 }]
  ])('refuses %s at the IPC boundary', async (_label, channel, input) => {
    await expect(call(channel, input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' }
    })
  })
})

describe('customers and payments', () => {
  // The fixture clock reads 14 Sep 2026: the main process dates payments and voids by it.
  const TODAY = '2026-09-14'

  function customerInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'Ali Raza',
      shopName: 'Ali Traders',
      phone: '0300-1234567',
      address: null,
      city: 'Lahore',
      notes: null,
      opening: { side: 'DUE', amountMinor: 500000, date: TODAY },
      currencyMinorDigits: 2,
      ...overrides
    }
  }

  function paymentInput(customerId: number, overrides: Record<string, unknown> = {}): unknown {
    return {
      requestId: 'ipc-payment-0001',
      customerId,
      paymentDate: TODAY,
      amountMinor: 200000,
      method: 'CASH',
      reference: null,
      note: null,
      currencyMinorDigits: 2,
      ...overrides
    }
  }

  it('creates, reads, lists, searches, edits, adjusts and deactivates a customer through IPC', async () => {
    const created = await call('customers:create', customerInput())
    expect(created).toMatchObject({ ok: true, data: { code: 'C-00002', balanceMinor: 500000 } })
    const id = (created as { data: { id: number } }).data.id

    await expect(call('customers:get', id)).resolves.toMatchObject({
      ok: true,
      data: { id, latestEntryDate: TODAY }
    })
    await expect(
      call('customers:list', { page: 1, pageSize: 25, search: 'traders', status: 'active' })
    ).resolves.toMatchObject({ ok: true, data: { total: 1, items: [{ id }] } })
    await expect(
      call('customers:search', { query: 'C-00002', limit: 10, includeInactive: false })
    ).resolves.toMatchObject({ ok: true, data: [{ id }] })
    await expect(
      call('customers:update', {
        id,
        name: 'Ali Raza Khan',
        shopName: null,
        phone: null,
        address: null,
        city: null,
        notes: null
      })
    ).resolves.toMatchObject({ ok: true, data: { name: 'Ali Raza Khan', balanceMinor: 500000 } })
    await expect(
      call('customers:adjustBalance', {
        customerId: id,
        entryDate: TODAY,
        direction: 'DECREASE',
        amountMinor: 1000,
        reason: 'Rounding',
        currencyMinorDigits: 2
      })
    ).resolves.toMatchObject({ ok: true, data: { customer: { balanceMinor: 499000 } } })
    await expect(
      call('customers:ledger', { customerId: id, page: null, pageSize: 50 })
    ).resolves.toMatchObject({
      ok: true,
      data: {
        total: 2,
        rows: [{ type: 'OPENING' }, { type: 'ADJUSTMENT', runningBalanceMinor: 499000 }]
      }
    })
    await expect(call('customers:setActive', { id, active: false })).resolves.toMatchObject({
      ok: true,
      data: { isActive: false }
    })
  })

  it('receives, checks, lists, reads and voids a payment through IPC, dated by the main process clock', async () => {
    const created = await call('customers:create', customerInput())
    const customerId = (created as { data: { id: number } }).data.id

    const paid = await call('payments:create', paymentInput(customerId))
    expect(paid).toMatchObject({
      ok: true,
      data: { paymentNo: 'RCP-000001', balanceAfterMinor: 300000, replayed: false }
    })
    const paymentId = (paid as { data: { id: number } }).data.id
    await expect(call('payments:create', paymentInput(customerId))).resolves.toMatchObject({
      ok: true,
      data: { id: paymentId, replayed: true }
    })
    await expect(
      call('payments:checkDuplicate', { customerId, paymentDate: TODAY, amountMinor: 200000 })
    ).resolves.toMatchObject({ ok: true, data: { duplicates: [{ id: paymentId }] } })
    await expect(
      call('payments:list', {
        page: 1,
        pageSize: 25,
        search: 'ali',
        status: 'all',
        method: 'all',
        dateFrom: TODAY,
        dateTo: TODAY
      })
    ).resolves.toMatchObject({ ok: true, data: { total: 1 } })
    await expect(call('payments:get', paymentId)).resolves.toMatchObject({
      ok: true,
      data: { id: paymentId, status: 'POSTED' }
    })
    await expect(
      call('payments:void', { id: paymentId, reason: 'Entered twice' })
    ).resolves.toMatchObject({
      ok: true,
      data: { status: 'VOID', voidDate: TODAY, balanceAfterMinor: 500000 }
    })
  })

  it('returns customer and payment errors as clean AppErrors, never SQLite text', async () => {
    const created = await call('customers:create', customerInput())
    const customerId = (created as { data: { id: number } }).data.id
    const future = await call(
      'payments:create',
      paymentInput(customerId, { paymentDate: '2026-09-15' })
    )
    expect(future).toMatchObject({ ok: false, error: { code: 'DATE_NOT_ALLOWED' } })
    await call('customers:setActive', { id: customerId, active: false })
    const inactive = await call('payments:create', paymentInput(customerId))
    expect(inactive).toMatchObject({ ok: false, error: { code: 'FORBIDDEN_STATE' } })
    await expect(call('customers:get', 42)).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' }
    })
    await expect(call('payments:void', { id: 42, reason: 'Gone' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' }
    })
    expect(JSON.stringify([future, inactive])).not.toMatch(/SQLITE|constraint/i)
  })

  it.each<[string, string, unknown]>([
    ['a customer with an extra field', 'customers:create', { ...customerInput(), balanceMinor: 1 }],
    [
      'an opening balance in a profile edit',
      'customers:update',
      {
        id: 1,
        name: 'Walk-in',
        shopName: null,
        phone: null,
        address: null,
        city: null,
        notes: null,
        opening: null
      }
    ],
    [
      'a signed opening amount',
      'customers:create',
      customerInput({ opening: { side: 'DUE', amountMinor: -5, date: TODAY } })
    ],
    ['a zero payment', 'payments:create', paymentInput(1, { amountMinor: 0 })],
    ['an unknown payment method', 'payments:create', paymentInput(1, { method: 'CARD' })],
    ['a payment id as text', 'payments:get', '1'],
    ['a void without a reason', 'payments:void', { id: 1 }],
    ['a ledger page size over 100', 'customers:ledger', { customerId: 1, page: 1, pageSize: 500 }],
    [
      'an adjustment without a reason',
      'customers:adjustBalance',
      {
        customerId: 1,
        entryDate: TODAY,
        direction: 'INCREASE',
        amountMinor: 1,
        currencyMinorDigits: 2
      }
    ]
  ])('refuses %s at the IPC boundary', async (_label, channel, input) => {
    await expect(call(channel, input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' }
    })
  })
})

describe('invoices', () => {
  // The fixture clock reads 14 Sep 2026: the main process dates the posting floor by it.
  const TODAY = '2026-09-14'

  async function seed(): Promise<{
    productId: number
    boxId: number
    pieceId: number
    customerId: number
  }> {
    const product = (await call('products:create', {
      code: 'P-001',
      name: 'Tea 950g',
      companyId: null,
      packingLabel: '1*12*18',
      lowStockThresholdBase: 0,
      currencyMinorDigits: 2,
      units: [
        {
          id: null,
          name: 'Piece',
          shortName: null,
          baseQty: 1,
          isBase: true,
          canSell: true,
          canPurchase: true,
          wholesalePriceMinor: 10_000,
          retailPriceMinor: 11_000,
          defaultCostMinor: null,
          isActive: true
        },
        {
          id: null,
          name: 'Box',
          shortName: null,
          baseQty: 24,
          isBase: false,
          canSell: true,
          canPurchase: true,
          wholesalePriceMinor: 230_000,
          retailPriceMinor: 240_000,
          defaultCostMinor: null,
          isActive: true
        }
      ]
    })) as { ok: true; data: { id: number; units: Array<{ id: number; name: string }> } }
    const unit = (name: string): number => product.data.units.find((item) => item.name === name)!.id
    await call('stock:receive', {
      requestId: 'ipc-receipt-0001',
      receiptDate: '2026-09-12',
      supplierName: null,
      reference: null,
      note: null,
      currencyMinorDigits: 2,
      lines: [
        { productId: product.data.id, unitId: unit('Box'), quantity: 5, unitCostMinor: 200_000 }
      ]
    })
    const customer = (await call('customers:create', {
      name: 'Ali Raza',
      shopName: null,
      phone: null,
      address: null,
      city: null,
      notes: null,
      opening: null,
      currencyMinorDigits: 2
    })) as { ok: true; data: { id: number } }
    return {
      productId: product.data.id,
      boxId: unit('Box'),
      pieceId: unit('Piece'),
      customerId: customer.data.id
    }
  }

  function invoiceInput(
    ids: { productId: number; boxId: number; pieceId: number },
    customerId: number,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      requestId: 'ipc-invoice-0001',
      invoiceDate: TODAY,
      customerId,
      priceTier: 'RETAIL',
      invoiceCode: null,
      biltyNo: null,
      transportName: null,
      addaName: null,
      checkedBy: null,
      notes: null,
      lines: [
        {
          productId: ids.productId,
          quantities: [
            { unitId: ids.boxId, quantity: 1, unitPriceMinor: 240_000, priceOverride: false },
            { unitId: ids.pieceId, quantity: 5, unitPriceMinor: 11_000, priceOverride: false }
          ],
          freeQuantities: [],
          discount: null,
          schemeMinor: 0,
          ctnCount: null
        }
      ],
      extraDiscountMinor: 0,
      freightMinor: 0,
      receivedMinor: 100_000,
      paymentMethod: 'CASH',
      paymentReference: null,
      currencyMinorDigits: 2,
      ...overrides
    }
  }

  it('previews the context and posts an invoice through IPC; a retry returns the saved invoice', async () => {
    const ids = await seed()
    await expect(
      call('invoices:context', { customerId: ids.customerId, productIds: [ids.productId] })
    ).resolves.toEqual({
      ok: true,
      data: {
        today: TODAY,
        nextInvoiceNo: 'INV-000001',
        earliestDate: '2026-09-12',
        earliestDateSetBy: { kind: 'PRODUCT', id: ids.productId, code: 'P-001', name: 'Tea 950g' }
      }
    })

    const posted = await call('invoices:post', invoiceInput(ids, ids.customerId))
    expect(posted).toMatchObject({
      ok: true,
      data: {
        invoiceNo: 'INV-000001',
        totalMinor: 295_000,
        payment: { paymentNo: 'RCP-000001', amountMinor: 100_000 },
        balanceAfterMinor: 195_000,
        replayed: false
      }
    })
    await expect(call('invoices:post', invoiceInput(ids, ids.customerId))).resolves.toMatchObject({
      ok: true,
      data: { invoiceNo: 'INV-000001', replayed: true }
    })
    await expect(call('stock:summary', ids.productId)).resolves.toMatchObject({
      ok: true,
      data: { qtyBase: 120 - 29 }
    })
    await expect(
      call('invoices:context', { customerId: null, productIds: [] })
    ).resolves.toMatchObject({
      ok: true,
      data: { nextInvoiceNo: 'INV-000002', earliestDate: null }
    })
  })

  it('returns invoice refusals as clean AppErrors: walk-in credit, stale price, stock and date', async () => {
    const ids = await seed()
    const walkIn = await call(
      'invoices:post',
      invoiceInput(ids, 1, { requestId: 'ipc-invoice-0002' })
    )
    expect(walkIn).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'Walk-in sales must be paid in full. Select a customer account for credit sales.',
        details: { rule: 'WALK_IN_FULL_PAYMENT', totalMinor: 295_000, receivedMinor: 100_000 }
      }
    })
    const stale = await call(
      'invoices:post',
      invoiceInput(ids, ids.customerId, { requestId: 'ipc-invoice-0003', priceTier: 'WHOLESALE' })
    )
    expect(stale).toMatchObject({ ok: false, error: { code: 'PRICE_CHANGED' } })
    const tooMuch = invoiceInput(ids, ids.customerId, { requestId: 'ipc-invoice-0004' })
    ;(
      tooMuch.lines as Array<{ quantities: Array<{ quantity: number }> }>
    )[0].quantities[0].quantity = 6
    const stock = await call('invoices:post', tooMuch)
    expect(stock).toMatchObject({ ok: false, error: { code: 'INSUFFICIENT_STOCK' } })
    const early = await call(
      'invoices:post',
      invoiceInput(ids, ids.customerId, {
        requestId: 'ipc-invoice-0005',
        invoiceDate: '2026-09-11'
      })
    )
    expect(early).toMatchObject({ ok: false, error: { code: 'DATE_NOT_ALLOWED' } })
    expect(JSON.stringify([walkIn, stale, stock, early])).not.toMatch(/SQLITE|constraint/i)
    await expect(
      call('invoices:context', { customerId: null, productIds: [] })
    ).resolves.toMatchObject({ ok: true, data: { nextInvoiceNo: 'INV-000001' } })
  })

  it('lists, reads, updates the dispatch details of and voids an invoice through IPC', async () => {
    const ids = await seed()
    const posted = (await call('invoices:post', invoiceInput(ids, ids.customerId))) as {
      ok: true
      data: { id: number; payment: { id: number } }
    }
    const id = posted.data.id
    await expect(
      call('invoices:list', {
        page: 1,
        pageSize: 25,
        search: 'ali',
        status: 'all',
        dateFrom: TODAY,
        dateTo: null
      })
    ).resolves.toMatchObject({
      ok: true,
      data: { total: 1, items: [{ id, invoiceNo: 'INV-000001', customerName: 'Ali Raza' }] }
    })
    await expect(call('invoices:get', id)).resolves.toMatchObject({
      ok: true,
      data: { id, status: 'POSTED', payment: { status: 'POSTED' }, changes: [] }
    })
    await expect(
      call('invoices:updateDispatch', {
        id,
        biltyNo: 'BL-7',
        transportName: null,
        addaName: null,
        note: 'Late bilty'
      })
    ).resolves.toMatchObject({
      ok: true,
      data: {
        biltyNo: 'BL-7',
        changedFields: ['bilty_no'],
        changes: [{ field: 'bilty_no', oldValue: null, newValue: 'BL-7', note: 'Late bilty' }]
      }
    })

    // Rs 2,950.00 invoice, Rs 1,000.00 received: the void leaves the payment as Rs 1,000.00 credit.
    await expect(
      call('invoices:void', { id, reason: 'Wrong customer', moneyReturned: false })
    ).resolves.toMatchObject({
      ok: true,
      data: {
        status: 'VOID',
        voidDate: TODAY,
        balanceAfterMinor: -100_000,
        payment: { status: 'POSTED' }
      }
    })
    await expect(call('stock:summary', ids.productId)).resolves.toMatchObject({
      ok: true,
      data: { qtyBase: 120 }
    })
    const again = await call('invoices:void', { id, reason: 'Twice', moneyReturned: false })
    expect(again).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN_STATE', message: 'Invoice INV-000001 is already void.' }
    })
    const dispatch = await call('invoices:updateDispatch', {
      id,
      biltyNo: 'BL-8',
      transportName: null,
      addaName: null,
      note: null
    })
    expect(dispatch).toMatchObject({ ok: false, error: { code: 'FORBIDDEN_STATE' } })
    const missing = await call('invoices:get', 999)
    expect(missing).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'This invoice no longer exists.' }
    })
    expect(JSON.stringify([again, dispatch, missing])).not.toMatch(/SQLITE|constraint|trigger/i)
  })

  it('keeps the walk-in account at zero: clean refusals, and a void that returns the money', async () => {
    const ids = await seed()
    const posted = (await call(
      'invoices:post',
      invoiceInput(ids, 1, { requestId: 'ipc-invoice-0006', receivedMinor: 295_000 })
    )) as { ok: true; data: { id: number; payment: { id: number } } }
    const { id, payment } = posted.data

    const withoutReturn = await call('invoices:void', {
      id,
      reason: 'Refund',
      moneyReturned: false
    })
    expect(withoutReturn).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION',
        message:
          'Walk-in invoice cannot be voided without reversing its received payment. Confirm that the money was returned.',
        fieldErrors: {
          moneyReturned: [
            'Walk-in invoice cannot be voided without reversing its received payment.'
          ]
        }
      }
    })
    const paymentVoid = await call('payments:void', { id: payment.id, reason: 'Refund' })
    expect(paymentVoid).toMatchObject({ ok: false, error: { code: 'FORBIDDEN_STATE' } })
    const standalone = await call('payments:create', {
      requestId: 'ipc-walk-in-payment',
      customerId: 1,
      paymentDate: TODAY,
      amountMinor: 1_000,
      method: 'CASH',
      reference: null,
      note: null,
      currencyMinorDigits: 2
    })
    expect(standalone).toMatchObject({ ok: false, error: { code: 'FORBIDDEN_STATE' } })
    const adjustment = await call('customers:adjustBalance', {
      customerId: 1,
      entryDate: TODAY,
      direction: 'INCREASE',
      amountMinor: 1_000,
      reason: 'Test',
      currencyMinorDigits: 2
    })
    expect(adjustment).toMatchObject({ ok: false, error: { code: 'FORBIDDEN_STATE' } })
    expect(JSON.stringify([withoutReturn, paymentVoid, standalone, adjustment])).not.toMatch(
      /SQLITE|constraint|trigger/i
    )

    await expect(
      call('invoices:void', { id, reason: 'Refund', moneyReturned: true })
    ).resolves.toMatchObject({
      ok: true,
      data: { status: 'VOID', balanceAfterMinor: 0, payment: { status: 'VOID' } }
    })
    await expect(call('customers:get', 1)).resolves.toMatchObject({
      ok: true,
      data: { balanceMinor: 0 }
    })
  })

  it.each<[string, string, unknown]>([
    ['an incomplete invoice', 'invoices:post', { requestId: 'ipc-invoice-0009' }],
    ['a context without product ids', 'invoices:context', { customerId: null }],
    [
      'a context with a customer id as text',
      'invoices:context',
      { customerId: '1', productIds: [] }
    ],
    ['a list without filters', 'invoices:list', { page: 1 }],
    ['an invoice id as text', 'invoices:get', '1'],
    [
      'a dispatch update that also changes the total',
      'invoices:updateDispatch',
      { id: 1, biltyNo: null, transportName: null, addaName: null, note: null, totalMinor: 0 }
    ],
    ['a void without a reason', 'invoices:void', { id: 1, moneyReturned: false }],
    ['a void without the money decision', 'invoices:void', { id: 1, reason: 'Duplicate' }]
  ])('refuses %s at the IPC boundary', async (_label, channel, input) => {
    await expect(call(channel, input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' }
    })
  })
})

describe('backup and restore: the renderer never supplies a path', () => {
  it.each([
    'backup:status',
    'backup:createManual',
    'backup:openFolder',
    'backup:selectRestoreCandidate'
  ])('%s refuses any input, so a path cannot be passed', async (channel) => {
    for (const input of PATHS) {
      await expect(call(channel, input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'VALIDATION' }
      })
    }
    expect(fixture.dialogs.saveRequests).toEqual([])
    expect(fixture.dialogs.openRequests).toEqual([])
    expect(fixture.opened).toEqual([])
    expect(backupFiles()).toEqual(['auto', 'pre-migration', 'pre-restore'])
  })

  it.each<[string, unknown]>([
    ['no input', undefined],
    ['a path', 'C:\\backups\\shop.db'],
    ['no token', { confirmation: 'RESTORE' }],
    ['no confirmation', { token: 'a'.repeat(32) }],
    ['another confirmation', { token: 'a'.repeat(32), confirmation: 'restore' }],
    ['a malformed token', { token: 'not-a-token', confirmation: 'RESTORE' }],
    [
      'a path next to the token',
      { token: 'a'.repeat(32), confirmation: 'RESTORE', path: 'C:\\x.db' }
    ],
    ['a file instead of a token', { file: 'C:\\x.db', confirmation: 'RESTORE' }]
  ])('backup:restore refuses %s', async (_label, input) => {
    await expect(call('backup:restore', input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' }
    })
    expect(fixture.restarts.count).toBe(0)
  })

  it('backup:restore refuses a well-formed token that main never issued, and nothing changes', async () => {
    const result = await call('backup:restore', { token: 'b'.repeat(32), confirmation: 'RESTORE' })
    expect(result).toMatchObject({ ok: false, error: { code: 'RESTORE_REJECTED' } })
    expect(fixture.restarts.count).toBe(0)
    expect(fixture.database.get()).toBe(fixture.db)
    expect(readSettings(fixture.db)).toEqual(DEFAULT_SETTINGS)
  })

  it('backup:createManual saves where the main process dialog was pointed', async () => {
    fixture.dialogs.saveAnswers.push(temp.file('usb\\shop-copy.db'))
    const result = await call('backup:createManual')
    expect(result).toMatchObject({
      ok: true,
      data: { status: 'CREATED', backup: { fileName: 'shop-copy.db' } }
    })
    expect(existsSync(temp.file('usb\\shop-copy.db'))).toBe(true)
  })

  it('backup:status answers without input', async () => {
    await expect(call('backup:status')).resolves.toMatchObject({
      ok: true,
      data: { health: 'NONE', lastAutomatic: null, busy: false }
    })
  })

  it('backup:openFolder opens the automatic backup folder, never another', async () => {
    await expect(call('backup:openFolder')).resolves.toEqual({ ok: true, data: undefined })
    expect(fixture.opened).toEqual([backupFolder(fixture.ctx.paths, 'auto')])
  })
})

describe('maintenance', () => {
  it('maintenance:integrityCheck reports in plain language', async () => {
    const result = await call('maintenance:integrityCheck')
    expect(result).toMatchObject({
      ok: true,
      data: { status: 'OK', message: 'No problems were found.', ref: null }
    })
    expect(JSON.stringify(result)).not.toMatch(/PRAGMA|SELECT|sqlite_|sha256|v_product_stock/i)
  })

  it('refuses database calls while StockFlow restarts', async () => {
    fixture.database.restart(null)
    for (const channel of ['app:info', 'settings:get', 'maintenance:integrityCheck']) {
      await expect(call(channel)).resolves.toEqual({
        ok: false,
        error: { code: 'FORBIDDEN_STATE', message: 'StockFlow is restarting.' }
      })
    }
  })
})
