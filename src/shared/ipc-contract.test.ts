import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ipcCalls,
  ipcChannel,
  ipcContract,
  type IpcChannel,
  type StockFlowApi
} from './ipc-contract'
import type { EditableSettingsPatch, SettingsView } from './settings'
import type { AppInfo } from './types/app-info'
import type {
  BackupStatus,
  ManualBackupResult,
  RestoreCandidateSelection,
  RestoreRequest,
  RestoreResult
} from './types/backup'
import type { IntegrityCheckReport } from './types/maintenance'
import type { Result } from './types/result'

const CHANNELS = [
  'app:info',
  'settings:get',
  'settings:update',
  'backup:status',
  'backup:createManual',
  'backup:openFolder',
  'backup:selectRestoreCandidate',
  'backup:restore',
  'maintenance:integrityCheck'
] as const

describe('IPC contract', () => {
  it('allow-lists exactly the Phase 3A and Phase 4B calls', () => {
    expect(ipcCalls.map((call) => call.channel)).toEqual(CHANNELS)
    expect(ipcCalls[0]).toEqual({ domain: 'app', action: 'info', channel: 'app:info' })
    expect(ipcCalls.at(-1)).toEqual({
      domain: 'maintenance',
      action: 'integrityCheck',
      channel: 'maintenance:integrityCheck'
    })
  })

  it('names channels <domain>:<action>', () => {
    expect(ipcChannel('app', 'info')).toBe('app:info')
    expect(ipcChannel('backup', 'restore')).toBe('backup:restore')
  })

  it('cannot be extended or changed at runtime', () => {
    expect(Object.isFrozen(ipcContract)).toBe(true)
    for (const domain of Object.values(ipcContract)) expect(Object.isFrozen(domain)).toBe(true)
    expect(Object.isFrozen(ipcCalls)).toBe(true)
    expect(ipcCalls.every((call) => Object.isFrozen(call))).toBe(true)
    expect(Reflect.set(ipcContract, 'shell', {})).toBe(false)
    expect(Reflect.set(ipcContract.app, 'openPath', {})).toBe(false)
    expect(Reflect.set(ipcContract.backup, 'writeFile', {})).toBe(false)
  })

  it('types window.api from the contract', () => {
    expectTypeOf<IpcChannel>().toEqualTypeOf<(typeof CHANNELS)[number]>()
    expectTypeOf<keyof StockFlowApi>().toEqualTypeOf<
      'app' | 'settings' | 'backup' | 'maintenance'
    >()
    expectTypeOf<StockFlowApi['app']['info']>().toEqualTypeOf<() => Promise<Result<AppInfo>>>()
    expectTypeOf<StockFlowApi['settings']['get']>().toEqualTypeOf<
      () => Promise<Result<SettingsView>>
    >()
    expectTypeOf<StockFlowApi['settings']['update']>().toEqualTypeOf<
      (input: EditableSettingsPatch) => Promise<Result<SettingsView>>
    >()
    expectTypeOf<StockFlowApi['backup']['status']>().toEqualTypeOf<
      () => Promise<Result<BackupStatus>>
    >()
    expectTypeOf<StockFlowApi['backup']['createManual']>().toEqualTypeOf<
      () => Promise<Result<ManualBackupResult>>
    >()
    expectTypeOf<StockFlowApi['backup']['openFolder']>().toEqualTypeOf<
      () => Promise<Result<void>>
    >()
    expectTypeOf<StockFlowApi['backup']['selectRestoreCandidate']>().toEqualTypeOf<
      () => Promise<Result<RestoreCandidateSelection>>
    >()
    expectTypeOf<StockFlowApi['backup']['restore']>().toEqualTypeOf<
      (input: RestoreRequest) => Promise<Result<RestoreResult>>
    >()
    expectTypeOf<StockFlowApi['maintenance']['integrityCheck']>().toEqualTypeOf<
      () => Promise<Result<IntegrityCheckReport>>
    >()
  })
})
