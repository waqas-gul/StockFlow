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
    expect(exposed).toEqual(['app:info:function'])
  })

  it('sends each call on its own channel with its input', async () => {
    const { sent, invoke } = recordingInvoke()
    const api = createApi(invoke)
    await expect(api.app.info()).resolves.toEqual({ ok: true, data: 'answer' })
    // Whatever a compromised renderer passes still goes to main, which validates it.
    await (api.app.info as (input: unknown) => Promise<unknown>)({ path: 'C:\\Windows' })
    expect(sent).toEqual([
      ['app:info', undefined],
      ['app:info', { path: 'C:\\Windows' }]
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
      expect(name in api.app).toBe(false)
    }
  })

  it('is frozen, so functions cannot be added or replaced', () => {
    const api = createApi(recordingInvoke().invoke)
    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.isFrozen(api.app)).toBe(true)
    expect(Reflect.set(api.app, 'info', () => 'replaced')).toBe(false)
    expect(Reflect.set(api, 'shell', {})).toBe(false)
  })
})
