// The single source of truth for IPC between the renderer and the main process.
//
// No runtime imports: the sandboxed preload bundles this file and cannot load packages such as Zod.
// Input validation lives with each handler in the main process (src/main/ipc).
import type { AppInfo } from './types/app-info'
import type { Result } from './types/result'

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
 */
export const ipcContract = Object.freeze({
  app: Object.freeze({
    /** Safe, display-only facts about the app and its database. */
    info: call<void, AppInfo>()
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
