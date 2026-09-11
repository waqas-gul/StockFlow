import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ipcCalls } from '@shared/ipc-contract'
import { openDatabase } from '../db/connection'
import { createTempDir, type TempDir } from '../db/test-utils'
import { registerIpc } from './index'

type Listener = (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>

const APP_URL = 'http://localhost:5173/#/settings'
const trusted = { senderFrame: { url: APP_URL } } as unknown as IpcMainInvokeEvent
const untrusted = { senderFrame: { url: 'https://evil.example/' } } as unknown as IpcMainInvokeEvent

let temp: TempDir
let listeners: Map<string, Listener>

beforeEach(() => {
  temp = createTempDir()
  const db = temp.track(openDatabase(temp.file('shop.db')))
  listeners = new Map()
  registerIpc(
    { handle: (channel, listener) => listeners.set(channel, listener as Listener) },
    {
      appInfo: {
        db,
        appVersion: '1.0.0',
        isDev: true,
        dataDir: 'C:\\Users\\owner\\AppData\\Roaming\\StockFlow-dev\\data',
        appDataPath: 'C:\\Users\\owner\\AppData\\Roaming'
      }
    },
    {
      isTrustedSender: (event) => event.senderFrame?.url === APP_URL,
      logError: () => undefined
    }
  )
})

afterEach(() => {
  temp.remove()
})

function call(channel: string, event: IpcMainInvokeEvent, input?: unknown): Promise<unknown> {
  const listener = listeners.get(channel)
  if (!listener) throw new Error(`No listener registered for ${channel}`)
  return listener(event, input)
}

describe('registerIpc', () => {
  it('registers exactly the calls of the shared contract', () => {
    expect([...listeners.keys()]).toEqual(ipcCalls.map((ipcCall) => ipcCall.channel))
  })

  it('answers app:info from the open database', async () => {
    await expect(call('app:info', trusted)).resolves.toEqual({
      ok: true,
      data: {
        appVersion: '1.0.0',
        mode: 'development',
        databaseDriver: 'better-sqlite3',
        sqliteVersion: expect.stringMatching(/^3\./),
        schemaVersion: 0,
        dataDirectory: '%APPDATA%\\StockFlow-dev\\data'
      }
    })
  })

  it('rejects any input to app:info', async () => {
    await expect(call('app:info', trusted, { path: 'C:\\Windows' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' }
    })
  })

  it('refuses app:info from an untrusted sender', async () => {
    await expect(call('app:info', untrusted)).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' }
    })
  })
})
