import { describe, expect, it } from 'vitest'
import type {
  RestoreCandidateSelection,
  RestoreCandidateSummary,
  RestoreRequest,
  RestoreResult
} from '@shared/types/backup'
import { fail, ok, type Result } from '@shared/types/result'
import {
  RESTORE_IDLE,
  createRestoreActions,
  isConfirmed,
  restoreDialogText,
  restoreFlowReducer,
  type RestoreApi,
  type RestoreFlow,
  type RestoreFlowEvent
} from './restore-flow'

const SUMMARY: RestoreCandidateSummary = {
  fileName: 'stockflow-backup_2026-09-01_180000_v1.0.0_s1.db',
  backupCreatedAt: '2026-09-01T13:00:00.000Z',
  schemaVersion: 1,
  appVersion: '1.0.0',
  products: 12,
  customers: 4,
  invoices: 30,
  sizeBytes: 250_000,
  needsMigration: false
}
const TOKEN = '0123456789abcdef0123456789abcdef'
const SELECTED: RestoreCandidateSelection = { status: 'SELECTED', token: TOKEN, summary: SUMMARY }
const RESTORED: RestoreResult = { restored: true, message: 'The backup was restored.' }

function run(events: RestoreFlowEvent[], from: RestoreFlow = RESTORE_IDLE): RestoreFlow {
  return events.reduce(restoreFlowReducer, from)
}

const confirming = run([{ type: 'choose' }, { type: 'chosen', selection: SELECTED }])

describe('restoreFlowReducer', () => {
  it('goes Choose → summary → typed confirmation → Restoring → Restarting', () => {
    expect(run([{ type: 'choose' }])).toEqual({ step: 'choosing' })
    expect(confirming).toEqual({ step: 'confirm', token: TOKEN, summary: SUMMARY, typed: '' })
    const typed = run([{ type: 'type', text: 'RESTORE' }], confirming)
    const restoring = run([{ type: 'confirm' }], typed)
    expect(restoring).toEqual({ step: 'restoring', summary: SUMMARY })
    expect(run([{ type: 'finished', result: RESTORED }], restoring)).toEqual({
      step: 'restarting',
      result: RESTORED
    })
  })

  it('returns to the start when the choice is cancelled or refused', () => {
    expect(run([{ type: 'choose' }, { type: 'chosen', selection: { status: 'CANCELLED' } }])).toBe(
      RESTORE_IDLE
    )
    expect(run([{ type: 'choose' }, { type: 'failed' }])).toBe(RESTORE_IDLE)
    expect(run([{ type: 'cancel' }], confirming)).toBe(RESTORE_IDLE)
  })

  it('needs the word RESTORE typed exactly before it restores', () => {
    for (const text of ['', 'restore', 'RESTOR', 'yes']) {
      expect(run([{ type: 'type', text }, { type: 'confirm' }], confirming)).toMatchObject({
        step: 'confirm'
      })
    }
    expect(run([{ type: 'type', text: '  RESTORE ' }, { type: 'confirm' }], confirming).step).toBe(
      'restoring'
    )
    expect(isConfirmed('RESTORE')).toBe(true)
    expect(isConfirmed('Restore')).toBe(false)
  })

  it('cannot be cancelled or confirmed again once restoring, and the restart is final', () => {
    const restoring: RestoreFlow = { step: 'restoring', summary: SUMMARY }
    for (const event of [
      { type: 'cancel' },
      { type: 'confirm' },
      { type: 'choose' },
      { type: 'type', text: 'x' }
    ] as RestoreFlowEvent[]) {
      expect(restoreFlowReducer(restoring, event)).toBe(restoring)
    }
    expect(run([{ type: 'failed' }], restoring)).toBe(RESTORE_IDLE)
    const restarting = run([{ type: 'finished', result: RESTORED }], restoring)
    for (const event of [
      { type: 'cancel' },
      { type: 'failed' },
      { type: 'choose' }
    ] as RestoreFlowEvent[]) {
      expect(restoreFlowReducer(restarting, event)).toBe(restarting)
    }
  })

  it('ignores events that do not fit the current step', () => {
    expect(restoreFlowReducer(RESTORE_IDLE, { type: 'chosen', selection: SELECTED })).toBe(
      RESTORE_IDLE
    )
    expect(restoreFlowReducer(RESTORE_IDLE, { type: 'finished', result: RESTORED })).toBe(
      RESTORE_IDLE
    )
    expect(restoreFlowReducer(confirming, { type: 'choose' })).toBe(confirming)
  })
})

/** A fake window.api.backup that records its calls and answers when the test says so. */
function fakeApi(): RestoreApi & {
  selections: number
  requests: RestoreRequest[]
  answerSelection: (result: Result<RestoreCandidateSelection>) => void
  answerRestore: (result: Result<RestoreResult>) => void
} {
  let selection!: (result: Result<RestoreCandidateSelection>) => void
  let restore!: (result: Result<RestoreResult>) => void
  const api = {
    selections: 0,
    requests: [] as RestoreRequest[],
    selectRestoreCandidate: () => {
      api.selections++
      return new Promise<Result<RestoreCandidateSelection>>((resolve) => (selection = resolve))
    },
    restore: (request: RestoreRequest) => {
      api.requests.push(request)
      return new Promise<Result<RestoreResult>>((resolve) => (restore = resolve))
    },
    answerSelection: (result: Result<RestoreCandidateSelection>) => selection(result),
    answerRestore: (result: Result<RestoreResult>) => restore(result)
  }
  return api
}

function harness(api: RestoreApi): {
  flow: () => RestoreFlow
  dispatch: (event: RestoreFlowEvent) => void
  errors: string[]
  actions: ReturnType<typeof createRestoreActions>
} {
  let flow = RESTORE_IDLE
  const errors: string[] = []
  const dispatch = (event: RestoreFlowEvent): void => {
    flow = restoreFlowReducer(flow, event)
  }
  const actions = createRestoreActions(api, dispatch, (message) => errors.push(message))
  return { flow: () => flow, dispatch, errors, actions }
}

describe('createRestoreActions', () => {
  it('asks the main process once for a backup, even when clicked twice', async () => {
    const api = fakeApi()
    const { flow, actions } = harness(api)
    const first = actions.choose()
    const second = actions.choose()
    expect(flow()).toEqual({ step: 'choosing' })
    api.answerSelection(ok(SELECTED))
    await Promise.all([first, second])
    expect(api.selections).toBe(1)
    expect(flow()).toMatchObject({ step: 'confirm', token: TOKEN })
  })

  it('shows a refused backup and goes back to the start', async () => {
    const api = fakeApi()
    const { flow, errors, actions } = harness(api)
    const choosing = actions.choose()
    api.answerSelection(
      fail({ code: 'RESTORE_REJECTED', message: 'This file is not a StockFlow backup.' })
    )
    await choosing
    expect(flow()).toBe(RESTORE_IDLE)
    expect(errors).toEqual(['This file is not a StockFlow backup.'])
  })

  it('sends only the token and the confirmation word, once, and then shows the restart', async () => {
    const api = fakeApi()
    const { flow, dispatch, actions } = harness(api)
    const choosing = actions.choose()
    api.answerSelection(ok(SELECTED))
    await choosing
    dispatch({ type: 'type', text: 'RESTORE' })
    const first = actions.confirm(TOKEN)
    const second = actions.confirm(TOKEN)
    api.answerRestore(ok(RESTORED))
    await Promise.all([first, second])
    expect(api.requests).toEqual([{ token: TOKEN, confirmation: 'RESTORE' }])
    expect(flow()).toEqual({ step: 'restarting', result: RESTORED })
  })

  it('shows a failed restore and goes back to the start', async () => {
    const api = fakeApi()
    const { flow, dispatch, errors, actions } = harness(api)
    const choosing = actions.choose()
    api.answerSelection(ok(SELECTED))
    await choosing
    dispatch({ type: 'type', text: 'RESTORE' })
    const restoring = actions.confirm(TOKEN)
    api.answerRestore(
      fail({
        code: 'RESTORE_FAILED',
        message: 'A safety backup of the current data could not be made, so nothing was restored.'
      })
    )
    await restoring
    expect(flow()).toBe(RESTORE_IDLE)
    expect(errors).toEqual([
      'A safety backup of the current data could not be made, so nothing was restored.'
    ])
  })
})

describe('restoreDialogText', () => {
  it('names each step of the dialog', () => {
    expect(restoreDialogText(RESTORE_IDLE)).toBeNull()
    expect(restoreDialogText({ step: 'choosing' })).toBeNull()
    expect(restoreDialogText(confirming)?.title).toBe('Restore this backup?')
    expect(restoreDialogText({ step: 'restoring', summary: SUMMARY })?.title).toBe(
      'Restoring the backup…'
    )
    expect(restoreDialogText({ step: 'restarting', result: RESTORED })?.title).toBe(
      'Backup restored'
    )
    expect(
      restoreDialogText({ step: 'restarting', result: { restored: false, message: 'x' } })
    ).toEqual({
      title: 'The restore did not complete',
      description: 'StockFlow is restarting with your previous data.'
    })
  })
})
