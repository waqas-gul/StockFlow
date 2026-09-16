import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ipcCalls,
  ipcChannel,
  ipcContract,
  type IpcChannel,
  type StockFlowApi
} from './ipc-contract'
import type { Company, CompanyCreateInput, CompanyUpdateInput } from './companies'
import type {
  Product,
  ProductActiveResult,
  ProductCreateInput,
  ProductListInput,
  ProductListPage,
  ProductSearchInput,
  ProductSearchItem,
  ProductUpdateInput
} from './products'
import type { EditableSettingsPatch, SettingsView } from './settings'
import type {
  AdjustmentListInput,
  PostingFloor,
  PostingFloorInput,
  ReceiptListInput,
  ReceiptVoidInput,
  StockAdjustmentInput,
  StockAdjustmentResult,
  StockAdjustmentSummary,
  StockCard,
  StockCardInput,
  StockPage,
  StockReceiptDetail,
  StockReceiptInput,
  StockReceiptSummary,
  StockSummary
} from './stock'
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
import type { SetActiveInput } from './validation'

const CHANNELS = [
  'app:info',
  'settings:get',
  'settings:update',
  'backup:status',
  'backup:createManual',
  'backup:openFolder',
  'backup:selectRestoreCandidate',
  'backup:restore',
  'maintenance:integrityCheck',
  'companies:list',
  'companies:create',
  'companies:update',
  'companies:setActive',
  'products:list',
  'products:get',
  'products:create',
  'products:update',
  'products:setActive',
  'products:search',
  'stock:receive',
  'stock:listReceipts',
  'stock:getReceipt',
  'stock:voidReceipt',
  'stock:adjust',
  'stock:listAdjustments',
  'stock:stockCard',
  'stock:summary',
  'stock:postingFloor'
] as const

describe('IPC contract', () => {
  it('allow-lists exactly the Phase 3A, 4B, 5 and 6 calls', () => {
    expect(ipcCalls.map((call) => call.channel)).toEqual(CHANNELS)
    expect(ipcCalls[0]).toEqual({ domain: 'app', action: 'info', channel: 'app:info' })
    expect(ipcCalls.at(-1)).toEqual({
      domain: 'stock',
      action: 'postingFloor',
      channel: 'stock:postingFloor'
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
      'app' | 'settings' | 'backup' | 'maintenance' | 'companies' | 'products' | 'stock'
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
    expectTypeOf<StockFlowApi['companies']['list']>().toEqualTypeOf<
      () => Promise<Result<readonly Company[]>>
    >()
    expectTypeOf<StockFlowApi['companies']['create']>().toEqualTypeOf<
      (input: CompanyCreateInput) => Promise<Result<Company>>
    >()
    expectTypeOf<StockFlowApi['companies']['update']>().toEqualTypeOf<
      (input: CompanyUpdateInput) => Promise<Result<Company>>
    >()
    expectTypeOf<StockFlowApi['companies']['setActive']>().toEqualTypeOf<
      (input: SetActiveInput) => Promise<Result<Company>>
    >()
    expectTypeOf<StockFlowApi['products']['list']>().toEqualTypeOf<
      (input: ProductListInput) => Promise<Result<ProductListPage>>
    >()
    expectTypeOf<StockFlowApi['products']['get']>().toEqualTypeOf<
      (input: number) => Promise<Result<Product>>
    >()
    expectTypeOf<StockFlowApi['products']['create']>().toEqualTypeOf<
      (input: ProductCreateInput) => Promise<Result<Product>>
    >()
    expectTypeOf<StockFlowApi['products']['update']>().toEqualTypeOf<
      (input: ProductUpdateInput) => Promise<Result<Product>>
    >()
    expectTypeOf<StockFlowApi['products']['setActive']>().toEqualTypeOf<
      (input: SetActiveInput) => Promise<Result<ProductActiveResult>>
    >()
    expectTypeOf<StockFlowApi['products']['search']>().toEqualTypeOf<
      (input: ProductSearchInput) => Promise<Result<readonly ProductSearchItem[]>>
    >()
    expectTypeOf<StockFlowApi['stock']['receive']>().toEqualTypeOf<
      (input: StockReceiptInput) => Promise<Result<StockReceiptDetail>>
    >()
    expectTypeOf<StockFlowApi['stock']['listReceipts']>().toEqualTypeOf<
      (input: ReceiptListInput) => Promise<Result<StockPage<StockReceiptSummary>>>
    >()
    expectTypeOf<StockFlowApi['stock']['getReceipt']>().toEqualTypeOf<
      (input: number) => Promise<Result<StockReceiptDetail>>
    >()
    expectTypeOf<StockFlowApi['stock']['voidReceipt']>().toEqualTypeOf<
      (input: ReceiptVoidInput) => Promise<Result<StockReceiptDetail>>
    >()
    expectTypeOf<StockFlowApi['stock']['adjust']>().toEqualTypeOf<
      (input: StockAdjustmentInput) => Promise<Result<StockAdjustmentResult>>
    >()
    expectTypeOf<StockFlowApi['stock']['listAdjustments']>().toEqualTypeOf<
      (input: AdjustmentListInput) => Promise<Result<StockPage<StockAdjustmentSummary>>>
    >()
    expectTypeOf<StockFlowApi['stock']['stockCard']>().toEqualTypeOf<
      (input: StockCardInput) => Promise<Result<StockCard>>
    >()
    expectTypeOf<StockFlowApi['stock']['summary']>().toEqualTypeOf<
      (input: number) => Promise<Result<StockSummary>>
    >()
    expectTypeOf<StockFlowApi['stock']['postingFloor']>().toEqualTypeOf<
      (input: PostingFloorInput) => Promise<Result<PostingFloor>>
    >()
  })
})
