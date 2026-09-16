import {
  RESTORE_CONFIRMATION,
  type RestoreCandidateSelection,
  type RestoreCandidateSummary,
  type RestoreRequest,
  type RestoreResult
} from '@shared/types/backup'
import type { Result } from '@shared/types/result'
import { unwrap } from '@renderer/lib/api'
import { errorMessage } from '@renderer/lib/format'
import { singleFlight } from '@renderer/lib/single-flight'

/**
 * Restore: Choose backup → (main validates it) → summary → typed confirmation → Restoring → Restarting. The main
 * process keeps the file's path; the renderer only holds the one-time token it was given.
 */
export type RestoreFlow =
  | { readonly step: 'idle' }
  | { readonly step: 'choosing' }
  | {
      readonly step: 'confirm'
      readonly token: string
      readonly summary: RestoreCandidateSummary
      readonly typed: string
    }
  | { readonly step: 'restoring'; readonly summary: RestoreCandidateSummary }
  | { readonly step: 'restarting'; readonly result: RestoreResult }

export type RestoreFlowEvent =
  | { readonly type: 'choose' }
  | { readonly type: 'chosen'; readonly selection: RestoreCandidateSelection }
  | { readonly type: 'type'; readonly text: string }
  | { readonly type: 'confirm' }
  | { readonly type: 'finished'; readonly result: RestoreResult }
  | { readonly type: 'failed' }
  | { readonly type: 'cancel' }

export const RESTORE_IDLE: RestoreFlow = Object.freeze({ step: 'idle' })

/** True once the user has typed the confirmation word. */
export function isConfirmed(typed: string): boolean {
  return typed.trim() === RESTORE_CONFIRMATION
}

/** The next step. An event that does not fit the current step changes nothing (e.g. a second confirm). */
export function restoreFlowReducer(flow: RestoreFlow, event: RestoreFlowEvent): RestoreFlow {
  switch (event.type) {
    case 'choose':
      return flow.step === 'idle' ? { step: 'choosing' } : flow
    case 'chosen':
      if (flow.step !== 'choosing') return flow
      return event.selection.status === 'SELECTED'
        ? {
            step: 'confirm',
            token: event.selection.token,
            summary: event.selection.summary,
            typed: ''
          }
        : RESTORE_IDLE
    case 'type':
      return flow.step === 'confirm' ? { ...flow, typed: event.text } : flow
    case 'confirm':
      return flow.step === 'confirm' && isConfirmed(flow.typed)
        ? { step: 'restoring', summary: flow.summary }
        : flow
    case 'finished':
      return flow.step === 'restoring' ? { step: 'restarting', result: event.result } : flow
    case 'failed':
      return flow.step === 'choosing' || flow.step === 'restoring' ? RESTORE_IDLE : flow
    case 'cancel':
      return flow.step === 'confirm' ? RESTORE_IDLE : flow
  }
}

export interface RestoreApi {
  selectRestoreCandidate(): Promise<Result<RestoreCandidateSelection>>
  restore(request: RestoreRequest): Promise<Result<RestoreResult>>
}

export interface RestoreActions {
  /** Asks the main process to open its file dialog and validate the chosen backup. */
  choose(): Promise<void>
  /** Restores the confirmed backup. Only call it once the confirmation word has been typed. */
  confirm(token: string): Promise<void>
}

/** The restore calls. A second click while one runs does not send it again. */
export function createRestoreActions(
  api: RestoreApi,
  dispatch: (event: RestoreFlowEvent) => void,
  onError: (message: string) => void
): RestoreActions {
  return {
    choose: singleFlight(async () => {
      dispatch({ type: 'choose' })
      try {
        dispatch({ type: 'chosen', selection: await unwrap(api.selectRestoreCandidate()) })
      } catch (error) {
        dispatch({ type: 'failed' })
        onError(errorMessage(error))
      }
    }),
    confirm: singleFlight(async (token: string) => {
      dispatch({ type: 'confirm' })
      try {
        const result = await unwrap(api.restore({ token, confirmation: RESTORE_CONFIRMATION }))
        dispatch({ type: 'finished', result })
      } catch (error) {
        dispatch({ type: 'failed' })
        onError(errorMessage(error))
      }
    })
  }
}

/** The title and description of the restore dialog for each step. */
export function restoreDialogText(
  flow: RestoreFlow
): { readonly title: string; readonly description: string } | null {
  switch (flow.step) {
    case 'confirm':
      return {
        title: 'Restore this backup?',
        description: 'Check that this is the backup you want to restore.'
      }
    case 'restoring':
      return {
        title: 'Restoring the backup…',
        description: 'Do not close StockFlow or turn off the computer. This can take a minute.'
      }
    case 'restarting':
      return flow.result.restored
        ? {
            title: 'Backup restored',
            description: 'StockFlow is restarting with the restored data.'
          }
        : {
            title: 'The restore did not complete',
            description: 'StockFlow is restarting with your previous data.'
          }
    default:
      return null
  }
}
