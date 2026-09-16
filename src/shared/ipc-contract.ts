// The single source of truth for IPC between the renderer and the main process.
//
// No runtime imports: the sandboxed preload bundles this file and cannot load packages such as Zod.
// Input validation lives with each handler in the main process (src/main/ipc).
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

declare const callTypes: unique symbol

/** One allow-listed request/response call. It only carries its input and output types. */
export interface IpcCall<Input, Output> {
  readonly [callTypes]?: { readonly input: Input; readonly output: Output }
}

function call<Input, Output>(): IpcCall<Input, Output> {
  return Object.freeze({})
}

/**
 * Every call the renderer may make, as domain → action. The channel is `<domain>:<action>` and the renderer
 * calls it as `window.api.<domain>.<action>(input)`. Nothing outside this map is reachable over IPC.
 *
 * No call takes a file-system path: the main process opens the file dialogs and keeps the paths they return.
 */
export const ipcContract = Object.freeze({
  app: Object.freeze({
    /** Safe, display-only facts about the app and its database. */
    info: call<void, AppInfo>()
  }),
  settings: Object.freeze({
    /** The business, currency and invoice settings, and whether the currency decimal places are locked. */
    get: call<void, SettingsView>(),
    /** Saves any of them (validated again by the main process) and returns them all, with the lock. */
    update: call<EditableSettingsPatch, SettingsView>()
  }),
  backup: Object.freeze({
    /** Automatic and manual backup status. */
    status: call<void, BackupStatus>(),
    /** Asks where to save (the main process's Save dialog), then writes a verified backup there. */
    createManual: call<void, ManualBackupResult>(),
    /** Opens the automatic backup folder in File Explorer. */
    openFolder: call<void, void>(),
    /** Asks for a backup (the main process's Open dialog), validates it, and returns its summary and a token. */
    selectRestoreCandidate: call<void, RestoreCandidateSelection>(),
    /** Restores the backup confirmed with that token; StockFlow then restarts. */
    restore: call<RestoreRequest, RestoreResult>()
  }),
  maintenance: Object.freeze({
    /** Runs the read-only integrity check and reports it in plain language. */
    integrityCheck: call<void, IntegrityCheckReport>()
  }),
  companies: Object.freeze({
    /** Every company (brand), active or not, by name. */
    list: call<void, readonly Company[]>(),
    create: call<CompanyCreateInput, Company>(),
    /** Renames a company. */
    update: call<CompanyUpdateInput, Company>(),
    /** Activates or deactivates a company; companies are never deleted. */
    setActive: call<SetActiveInput, Company>()
  }),
  products: Object.freeze({
    /** One page of the Products table: search, company and status filters. */
    list: call<ProductListInput, ProductListPage>(),
    /** One product with its units, stock and unit lock state. */
    get: call<number, Product>(),
    /** Creates a product with its units in one transaction. */
    create: call<ProductCreateInput, Product>(),
    /** Saves a product and its whole unit list in one transaction. */
    update: call<ProductUpdateInput, Product>(),
    /** Activates or deactivates a product; products are never deleted. */
    setActive: call<SetActiveInput, ProductActiveResult>(),
    /** Quick lookup by code, name or company name. */
    search: call<ProductSearchInput, readonly ProductSearchItem[]>()
  })
})

export type IpcContract = typeof ipcContract
export type IpcDomain = keyof IpcContract
export type IpcAction<D extends IpcDomain> = keyof IpcContract[D] & string
export type IpcChannel = { [D in IpcDomain]: `${D}:${IpcAction<D>}` }[IpcDomain]

type CallTypes<C> =
  C extends IpcCall<infer Input, infer Output> ? { input: Input; output: Output } : never
export type IpcInput<D extends IpcDomain, A extends IpcAction<D>> = CallTypes<
  IpcContract[D][A]
>['input']
export type IpcOutput<D extends IpcDomain, A extends IpcAction<D>> = CallTypes<
  IpcContract[D][A]
>['output']

/** The renderer-side function for one call. Calls without input take no argument. */
export type IpcFunction<Input, Output> = [Input] extends [void]
  ? () => Promise<Result<Output>>
  : (input: Input) => Promise<Result<Output>>

/** The shape of `window.api`, derived from the contract. */
export type StockFlowApi = {
  readonly [D in IpcDomain]: {
    readonly [A in IpcAction<D>]: IpcFunction<IpcInput<D, A>, IpcOutput<D, A>>
  }
}

export interface IpcCallInfo {
  readonly domain: IpcDomain
  readonly action: string
  readonly channel: IpcChannel
}

export function ipcChannel<D extends IpcDomain, A extends IpcAction<D>>(
  domain: D,
  action: A
): `${D}:${A}` {
  return `${domain}:${action}`
}

/** Every allow-listed call, flattened. The preload exposes exactly these; main registers exactly these. */
export const ipcCalls: readonly IpcCallInfo[] = Object.freeze(
  Object.entries(ipcContract).flatMap(([domain, actions]) =>
    Object.keys(actions).map((action) =>
      Object.freeze({ domain, action, channel: `${domain}:${action}` } as IpcCallInfo)
    )
  )
)
