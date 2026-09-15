import type { IpcMainInvokeEvent } from 'electron'
import type { z } from 'zod'
import type { IpcAction, IpcChannel, IpcDomain, IpcInput, IpcOutput } from '@shared/ipc-contract'
import { fail, ok, type AppError, type Result } from '@shared/types/result'
import { sqliteErrorCode } from '../db/adapter'
import { AppFailure, fieldErrorsOf } from '../errors'
import { createErrorRef, type Logger } from '../logging'

/** The validated input of a call: `undefined` for a call that takes none. */
export type HandlerInput<Input> = [Input] extends [void] ? undefined : Input

export interface IpcHandler<Input, Output> {
  /** Validates the untrusted input sent by the renderer. */
  readonly input: z.ZodType<Input>
  /** Runs the call with the validated input. */
  run(input: Input): Output | Promise<Output>
}

/** One handler for every call in the contract. The typecheck fails if one is missing or mistyped. */
export type IpcHandlers = {
  readonly [D in IpcDomain]: {
    readonly [A in IpcAction<D>]: IpcHandler<HandlerInput<IpcInput<D, A>>, IpcOutput<D, A>>
  }
}

export type IpcListener = (event: IpcMainInvokeEvent, input?: unknown) => Promise<Result<unknown>>

/** The part of Electron's `ipcMain` used here, injected so the tests need no Electron runtime. */
export interface IpcRegistrar {
  handle(channel: string, listener: IpcListener): void
}

export interface HandlerOptions {
  /** True when the request comes from the app's own renderer document. */
  readonly isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  /**
   * Receives refused requests and the full detail of unexpected failures, with their reference. Nothing logged is
   * sent to the renderer, and the request input is never logged.
   */
  readonly log: Pick<Logger, 'warn' | 'error'>
}

/**
 * Wraps one call: sender check → Zod validation → service → Result envelope. The returned listener never
 * throws, and nothing but user-safe text crosses to the renderer.
 */
export function createIpcHandler<Input, Output>(
  channel: string,
  handler: IpcHandler<Input, Output>,
  options: HandlerOptions
): (event: IpcMainInvokeEvent, input?: unknown) => Promise<Result<Output>> {
  return async (event, input) => {
    if (!options.isTrustedSender(event)) {
      options.log.warn(`[ipc] ${channel}: refused a request from an untrusted sender`, {
        sender: event.senderFrame?.url ?? null
      })
      return fail({ code: 'FORBIDDEN', message: 'This request is not allowed.' })
    }
    const parsed = handler.input.safeParse(input)
    if (!parsed.success) return fail(validationError(parsed.error))
    try {
      return ok(await handler.run(parsed.data))
    } catch (error) {
      return fail(failureOf(error, channel, options))
    }
  }
}

/** Registers every handler on channel `<domain>:<action>` and returns the channels. */
export function registerIpcHandlers(
  registrar: IpcRegistrar,
  handlers: IpcHandlers,
  options: HandlerOptions
): IpcChannel[] {
  const channels: IpcChannel[] = []
  for (const [domain, actions] of Object.entries(handlers)) {
    const entries = Object.entries(actions as Record<string, IpcHandler<unknown, unknown>>)
    for (const [action, handler] of entries) {
      const channel = `${domain}:${action}` as IpcChannel
      registrar.handle(channel, createIpcHandler(channel, handler, options))
      channels.push(channel)
    }
  }
  return channels
}

function validationError(error: z.ZodError): AppError {
  return {
    code: 'VALIDATION',
    message: 'The request was not valid.',
    fieldErrors: fieldErrorsOf(error)
  }
}

// User-facing guidance for SQLite failures caused by the environment rather than by a bug.
// Codes match with their extended forms (SQLITE_IOERR_WRITE, SQLITE_READONLY_DBMOVED, …).
const DATABASE_GUIDANCE: ReadonlyArray<readonly [code: string, message: string]> = [
  [
    'SQLITE_FULL',
    'The disk is full, so the change was not saved. Free some disk space and try again.'
  ],
  ['SQLITE_IOERR', 'The database file could not be read or written. Check the disk and try again.'],
  ['SQLITE_CORRUPT', 'The database file is damaged. Restore a recent backup.'],
  ['SQLITE_NOTADB', 'The database file is damaged. Restore a recent backup.'],
  ['SQLITE_BUSY', 'The database is busy. Try again.'],
  ['SQLITE_LOCKED', 'The database is busy. Try again.'],
  [
    'SQLITE_READONLY',
    'The database file cannot be written. Check the permissions of the data folder.'
  ],
  [
    'SQLITE_CANTOPEN',
    'The database file cannot be opened. Check the permissions of the data folder.'
  ]
]

function failureOf(error: unknown, channel: string, options: HandlerOptions): AppError {
  if (error instanceof AppFailure) return error.error

  // Unexpected: log everything here, send only a reference to the renderer.
  const ref = createErrorRef()
  options.log.error(`[ipc] ${channel} failed`, error, { ref })
  const code = sqliteErrorCode(error)
  const guidance = DATABASE_GUIDANCE.find(
    ([prefix]) => code === prefix || code?.startsWith(`${prefix}_`)
  )
  if (guidance) return { code: 'DB_ERROR', message: `${guidance[1]} (ref: ${ref})`, ref }
  return { code: 'INTERNAL', message: `Something went wrong. (ref: ${ref})`, ref }
}
