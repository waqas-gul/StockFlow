import { describe, expect, it } from 'vitest'
import { ipcCalls } from '@shared/ipc-contract'
import type { Result } from '@shared/types/result'
import { createApi, type InvokeChannel } from './api'

function recordingInvoke(): { sent: Array<[string, unknown]>; invoke: InvokeChannel } {
  const sent: Array<[string, unknown]> = []
  return {
    sent,
    invoke: async (channel, input): Promise<Result<unknown>> => {
      sent.push([channel, input])
      return { ok: true, data: 'answer' }
    }
  }
}

describe('createApi (the preload bridge)', () => {
  it('exposes exactly one function per contract call, grouped by domain', () => {
    const api = createApi(recordingInvoke().invoke)
    const exposed = Object.entries(api).flatMap(([domain, actions]) =>
      Object.entries(actions).map(([action, fn]) => `${domain}:${action}:${typeof fn}`)
    )
    expect(exposed).toEqual(ipcCalls.map((call) => `${call.channel}:function`))
    expect(exposed).toEqual([
      'app:info:function',
      'settings:get:function',
      'settings:update:function',
      'backup:status:function',
      'backup:createManual:function',
      'backup:openFolder:function',
      'backup:selectRestoreCandidate:function',
      'backup:restore:function',
      'maintenance:integrityCheck:function',
      'companies:list:function',
      'companies:create:function',
      'companies:update:function',
      'companies:setActive:function',
      'products:list:function',
      'products:get:function',
      'products:create:function',
      'products:update:function',
      'products:setActive:function',
      'products:search:function',
      'stock:receive:function',
      'stock:listReceipts:function',
      'stock:getReceipt:function',
      'stock:voidReceipt:function',
      'stock:adjust:function',
      'stock:listAdjustments:function',
      'stock:stockCard:function',
      'stock:summary:function',
      'stock:postingFloor:function',
      'customers:list:function',
      'customers:get:function',
      'customers:create:function',
      'customers:update:function',
      'customers:setActive:function',
      'customers:ledger:function',
      'customers:adjustBalance:function',
      'customers:search:function',
      'payments:list:function',
      'payments:get:function',
      'payments:create:function',
      'payments:checkDuplicate:function',
      'payments:void:function',
      'invoices:context:function',
      'invoices:post:function',
      'invoices:list:function',
      'invoices:get:function',
      'invoices:updateDispatch:function',
      'invoices:void:function',
      'invoices:printable:function',
      'invoices:print:function',
      'invoices:savePdf:function',
      'expenseCategories:list:function',
      'expenseCategories:create:function',
      'expenseCategories:update:function',
      'expenseCategories:setActive:function',
      'expenses:list:function',
      'expenses:summary:function',
      'expenses:get:function',
      'expenses:create:function',
      'expenses:update:function',
      'expenses:void:function'
    ])
  })

  it('sends each call on its own channel with its input', async () => {
    const { sent, invoke } = recordingInvoke()
    const api = createApi(invoke)
    await expect(api.app.info()).resolves.toEqual({ ok: true, data: 'answer' })
    await api.settings.update({ 'business.name': 'Ali Traders' })
    await api.backup.restore({ token: 'a'.repeat(32), confirmation: 'RESTORE' })
    // Whatever a compromised renderer passes still goes to main, which validates it.
    await (api.backup.createManual as (input: unknown) => Promise<unknown>)({
      path: 'C:\\Windows\\x.db'
    })
    expect(sent).toEqual([
      ['app:info', undefined],
      ['settings:update', { 'business.name': 'Ali Traders' }],
      ['backup:restore', { token: 'a'.repeat(32), confirmation: 'RESTORE' }],
      ['backup:createManual', { path: 'C:\\Windows\\x.db' }]
    ])
  })

  it('forwards only one argument per call', async () => {
    const { sent, invoke } = recordingInvoke()
    const api = createApi(invoke)
    await (api.app.info as (...args: unknown[]) => Promise<unknown>)('first', 'second')
    expect(sent).toEqual([['app:info', 'first']])
  })

  it('offers no generic IPC access and no way to name a channel', () => {
    const api = createApi(recordingInvoke().invoke)
    const forbidden = ['invoke', 'send', 'sendSync', 'on', 'once', 'postMessage', 'ipcRenderer']
    for (const name of forbidden) {
      expect(name in api).toBe(false)
      for (const domain of Object.values(api)) expect(name in domain).toBe(false)
    }
  })

  it('is frozen, so functions cannot be added or replaced', () => {
    const api = createApi(recordingInvoke().invoke)
    expect(Object.isFrozen(api)).toBe(true)
    for (const domain of Object.values(api)) expect(Object.isFrozen(domain)).toBe(true)
    expect(Reflect.set(api.app, 'info', () => 'replaced')).toBe(false)
    expect(Reflect.set(api.backup, 'restore', () => 'replaced')).toBe(false)
    expect(Reflect.set(api, 'shell', {})).toBe(false)
  })
})
