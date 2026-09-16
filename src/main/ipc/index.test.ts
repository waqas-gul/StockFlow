import type { IpcMainInvokeEvent } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ipcCalls } from '@shared/ipc-contract'
import { MINOR_DIGITS_LOCKED_MESSAGE } from '@shared/settings'
import type { Result } from '@shared/types/result'
import { backupFolder } from '../data-paths'
import { createTempDir, insertMasters, insertRow, rows, type TempDir } from '../db/test-utils'
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
        schemaVersion: 1,
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
