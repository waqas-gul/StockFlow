import { writeFileSync } from 'node:fs'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AppInfo } from '@shared/types/app-info'
import type { Result } from '@shared/types/result'
import { openSqlite, type Db } from '../db/adapter'
import { createTempDir, type TempDir } from '../db/test-utils'
import { AppFailure } from '../errors'
import type { LogContext } from '../logging'
import {
  createIpcHandler,
  registerIpcHandlers,
  type HandlerOptions,
  type IpcHandlers
} from './handle'

const APP_URL = 'file:///C:/Program%20Files/StockFlow/resources/app.asar/out/renderer/index.html'

function eventFrom(url: string | null): IpcMainInvokeEvent {
  return { senderFrame: url === null ? null : { url } } as unknown as IpcMainInvokeEvent
}

const trusted = eventFrom(APP_URL)

interface Logged {
  level: 'warn' | 'error'
  message: string
  error?: unknown
  context?: LogContext
}

/** Handler options that trust only APP_URL and record every log entry. */
function testOptions(): HandlerOptions & { logged: Logged[] } {
  const logged: Logged[] = []
  return {
    logged,
    isTrustedSender: (event) => event.senderFrame?.url === APP_URL,
    log: {
      warn: (message, context) => logged.push({ level: 'warn', message, context }),
      error: (message, error, context) => logged.push({ level: 'error', message, error, context })
    }
  }
}

const doubleInput = z.strictObject({ n: z.number().int() })

let temp: TempDir

beforeEach(() => {
  temp = createTempDir()
})

afterEach(() => {
  temp.remove()
})

function openWithTable(): Db {
  const db = temp.track(openSqlite(temp.file('test.db')))
  db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE) STRICT')
  return db
}

/** Runs `fail` inside a handler and returns the handler's Result and the log. */
async function failingCall(
  fail: () => unknown
): Promise<{ result: Result<unknown>; logged: Logged[] }> {
  const options = testOptions()
  const handler = createIpcHandler('test:fail', { input: z.undefined(), run: fail }, options)
  return { result: await handler(trusted, undefined), logged: options.logged }
}

describe('createIpcHandler', () => {
  it('returns the data of a successful call', async () => {
    const handler = createIpcHandler(
      'test:double',
      { input: doubleInput, run: ({ n }) => n * 2 },
      testOptions()
    )
    await expect(handler(trusted, { n: 21 })).resolves.toEqual({ ok: true, data: 42 })
  })

  it('waits for async services', async () => {
    const handler = createIpcHandler(
      'test:double',
      { input: doubleInput, run: async ({ n }) => n * 2 },
      testOptions()
    )
    await expect(handler(trusted, { n: 5 })).resolves.toEqual({ ok: true, data: 10 })
  })

  it('rejects malformed input with VALIDATION field errors, without calling the service', async () => {
    let called = false
    const handler = createIpcHandler(
      'test:double',
      {
        input: doubleInput,
        run: () => {
          called = true
          return 0
        }
      },
      testOptions()
    )
    const result = await handler(trusted, { n: 'x', extra: true })
    expect(called).toBe(false)
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'The request was not valid.',
        fieldErrors: { n: [expect.any(String)], root: [expect.stringContaining('extra')] }
      }
    })
  })

  it('rejects input for a call that takes none', async () => {
    const handler = createIpcHandler(
      'test:none',
      { input: z.undefined(), run: () => 'ran' },
      testOptions()
    )
    await expect(handler(trusted, undefined)).resolves.toEqual({ ok: true, data: 'ran' })
    for (const input of [{}, 'C:\\Windows', 0, null, ['a']]) {
      const result = await handler(trusted, input)
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    }
  })

  it('refuses an untrusted sender with FORBIDDEN, without validating or calling the service', async () => {
    let called = false
    const options = testOptions()
    const handler = createIpcHandler(
      'test:double',
      {
        input: doubleInput,
        run: () => {
          called = true
          return 0
        }
      },
      options
    )
    for (const event of [eventFrom('https://evil.example/'), eventFrom(null)]) {
      await expect(handler(event, { n: 1 })).resolves.toEqual({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'This request is not allowed.' }
      })
    }
    expect(called).toBe(false)
    const refused = '[ipc] test:double: refused a request from an untrusted sender'
    expect(options.logged).toEqual([
      { level: 'warn', message: refused, context: { sender: 'https://evil.example/' } },
      { level: 'warn', message: refused, context: { sender: null } }
    ])
  })

  it('passes an expected AppFailure through unchanged, without logging', async () => {
    const error = { code: 'NOT_FOUND', message: 'Invoice not found.' } as const
    const { result, logged } = await failingCall(() => {
      throw new AppFailure(error)
    })
    expect(result).toEqual({ ok: false, error })
    expect(logged).toEqual([])
  })

  it('turns an unexpected error into INTERNAL with a reference and logs the full error', async () => {
    const secret = new Error('ENOENT C:\\Users\\owner\\AppData\\Roaming\\StockFlow\\data\\shop.db')
    const { result, logged } = await failingCall(() => {
      throw secret
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({
      code: 'INTERNAL',
      message: `Something went wrong. (ref: ${result.error.ref})`,
      ref: expect.stringMatching(/^[0-9A-F]{6}$/)
    })
    const sent = JSON.stringify(result)
    expect(sent).not.toMatch(/owner|ENOENT|shop\.db|\bat\b/)
    expect(logged).toEqual([
      {
        level: 'error',
        message: '[ipc] test:fail failed',
        error: secret,
        context: { ref: result.error.ref }
      }
    ])
  })

  it('never passes the request input to the log', async () => {
    const options = testOptions()
    const handler = createIpcHandler(
      'test:save',
      {
        input: z.strictObject({ customer: z.string(), phone: z.string() }),
        run: () => {
          throw new Error('boom')
        }
      },
      options
    )
    await handler(trusted, { customer: 'Ali Traders', phone: '0300-1234567' })
    expect(options.logged).toHaveLength(1)
    const logged = JSON.stringify(options.logged, (_key, value: unknown) =>
      value instanceof Error ? value.message : value
    )
    expect(logged).not.toMatch(/Ali|0300/)
  })

  it('treats a rejected promise and a thrown non-Error the same way', async () => {
    for (const fail of [() => Promise.reject(new Error('async secret')), () => 'thrown text']) {
      const { result } = await failingCall(async () => {
        const value = fail()
        if (typeof value === 'string') throw value
        return value
      })
      expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
      expect(JSON.stringify(result)).not.toMatch(/secret|thrown text/)
    }
  })

  it('gives each failure its own reference', async () => {
    const refs = new Set<string | undefined>()
    for (let i = 0; i < 5; i++) {
      const { result } = await failingCall(() => {
        throw new Error('boom')
      })
      if (!result.ok) refs.add(result.error.ref)
    }
    expect(refs.size).toBe(5)
  })
})

describe('database failures', () => {
  it('maps a full database or disk to DB_ERROR with guidance', async () => {
    const db = openWithTable()
    db.exec('PRAGMA max_page_count = 2')
    const { result, logged } = await failingCall(() => {
      for (let i = 0; i < 100; i++) {
        db.run('INSERT INTO probe (label) VALUES (?)', ['x'.repeat(500) + i])
      }
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DB_ERROR', message: expect.stringMatching(/disk is full/) }
    })
    expect(logged).toHaveLength(1)
  })

  it('maps a busy database to DB_ERROR', async () => {
    const db = openWithTable()
    const other = temp.track(openSqlite(temp.file('test.db')))
    other.exec('PRAGMA busy_timeout = 0')
    db.exec('BEGIN IMMEDIATE')
    const { result } = await failingCall(() => other.exec('BEGIN IMMEDIATE'))
    db.exec('ROLLBACK')
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DB_ERROR', message: expect.stringMatching(/busy/) }
    })
  })

  it('maps a read-only database to DB_ERROR', async () => {
    openWithTable()
    const readOnly = temp.track(openSqlite(temp.file('test.db'), { readonly: true }))
    const { result } = await failingCall(() =>
      readOnly.run('INSERT INTO probe (label) VALUES (?)', ['x'])
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'DB_ERROR' } })
  })

  it('maps a damaged database file to DB_ERROR', async () => {
    writeFileSync(temp.file('damaged.db'), 'not a database '.repeat(100))
    const damaged = temp.track(openSqlite(temp.file('damaged.db')))
    const { result } = await failingCall(() => damaged.all('SELECT * FROM sqlite_schema'))
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DB_ERROR', message: expect.stringMatching(/damaged/) }
    })
  })

  it('treats other SQLite errors, such as constraint violations, as INTERNAL', async () => {
    const db = openWithTable()
    db.run('INSERT INTO probe (label) VALUES (?)', ['dup'])
    const { result } = await failingCall(() =>
      db.run('INSERT INTO probe (label) VALUES (?)', ['dup'])
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(JSON.stringify(result)).not.toMatch(/UNIQUE|probe/)
  })
})

describe('registerIpcHandlers', () => {
  const info: AppInfo = {
    appVersion: '1.0.0',
    mode: 'development',
    databaseDriver: 'better-sqlite3',
    sqliteVersion: '3.50.0',
    schemaVersion: 0,
    dataDirectory: '%APPDATA%\\StockFlow-dev\\data'
  }

  it('registers one validating listener per call, on channel <domain>:<action>', async () => {
    const listeners = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    // One handler is enough: registration does not depend on the contract's other calls.
    const handlers = {
      app: { info: { input: z.undefined(), run: () => info } }
    } as unknown as IpcHandlers
    const channels = registerIpcHandlers(
      { handle: (channel, listener) => listeners.set(channel, listener) },
      handlers,
      testOptions()
    )
    expect(channels).toEqual(['app:info'])
    expect([...listeners.keys()]).toEqual(['app:info'])
    const listener = listeners.get('app:info')!
    await expect(listener(trusted, undefined)).resolves.toEqual({ ok: true, data: info })
    await expect(listener(trusted, { any: 'thing' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' }
    })
  })
})
