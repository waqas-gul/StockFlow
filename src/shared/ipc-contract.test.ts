import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ipcCalls,
  ipcChannel,
  ipcContract,
  type IpcChannel,
  type StockFlowApi
} from './ipc-contract'
import type { AppInfo } from './types/app-info'
import type { Result } from './types/result'

describe('IPC contract', () => {
  it('allow-lists exactly the Phase 3A calls', () => {
    expect(ipcCalls).toEqual([{ domain: 'app', action: 'info', channel: 'app:info' }])
  })

  it('names channels <domain>:<action>', () => {
    expect(ipcChannel('app', 'info')).toBe('app:info')
  })

  it('cannot be extended or changed at runtime', () => {
    expect(Object.isFrozen(ipcContract)).toBe(true)
    expect(Object.isFrozen(ipcContract.app)).toBe(true)
    expect(Object.isFrozen(ipcCalls)).toBe(true)
    expect(ipcCalls.every((call) => Object.isFrozen(call))).toBe(true)
    expect(Reflect.set(ipcContract, 'shell', {})).toBe(false)
    expect(Reflect.set(ipcContract.app, 'openPath', {})).toBe(false)
  })

  it('types window.api from the contract', () => {
    expectTypeOf<IpcChannel>().toEqualTypeOf<'app:info'>()
    expectTypeOf<StockFlowApi['app']['info']>().toEqualTypeOf<() => Promise<Result<AppInfo>>>()
    expectTypeOf<keyof StockFlowApi>().toEqualTypeOf<'app'>()
  })
})
