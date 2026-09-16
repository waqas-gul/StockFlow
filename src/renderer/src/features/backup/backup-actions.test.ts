import { describe, expect, it } from 'vitest'
import type { ManualBackupResult } from '@shared/types/backup'
import { fail, ok, type Result } from '@shared/types/result'
import {
  createManualBackupAction,
  createOpenFolderAction,
  type ManualBackupState
} from './backup-actions'

const CREATED: ManualBackupResult = {
  status: 'CREATED',
  backup: { at: '2026-09-14T10:00:00.000Z', fileName: 'shop.db', location: 'E:\\Backups' }
}

function recorder(): {
  states: ManualBackupState[]
  toasts: string[]
  notify: { success: (m: string) => void; error: (m: string) => void }
} {
  const states: ManualBackupState[] = []
  const toasts: string[] = []
  return {
    states,
    toasts,
    notify: {
      success: (message) => toasts.push(`success: ${message}`),
      error: (message) => toasts.push(`error: ${message}`)
    }
  }
}

describe('Backup Now', () => {
  it('goes Creating… → Success and says where the backup was saved', async () => {
    const { states, toasts, notify } = recorder()
    const backupNow = createManualBackupAction(
      { createManual: async () => ok(CREATED) },
      (state) => states.push(state),
      notify
    )
    await backupNow()
    expect(states).toEqual([
      { state: 'creating' },
      { state: 'success', backup: CREATED.status === 'CREATED' ? CREATED.backup : undefined }
    ])
    expect(toasts).toEqual(['success: Backup saved: shop.db'])
  })

  it('returns to Idle, without a message, when the Save dialog is cancelled', async () => {
    const { states, toasts, notify } = recorder()
    const backupNow = createManualBackupAction(
      { createManual: async () => ok({ status: 'CANCELLED' }) },
      (state) => states.push(state),
      notify
    )
    await backupNow()
    expect(states).toEqual([{ state: 'creating' }, { state: 'idle' }])
    expect(toasts).toEqual([])
  })

  it('goes Creating… → Failed with the safe message of the main process', async () => {
    const { states, toasts, notify } = recorder()
    const message = 'The backup folder could not be used. Check that the drive is connected.'
    const backupNow = createManualBackupAction(
      { createManual: async () => fail({ code: 'BACKUP_FAILED', message }) },
      (state) => states.push(state),
      notify
    )
    await backupNow()
    expect(states).toEqual([{ state: 'creating' }, { state: 'failed', message }])
    expect(toasts).toEqual([`error: ${message}`])
  })

  it('starts only one backup when clicked twice', async () => {
    let calls = 0
    let answer!: (result: Result<ManualBackupResult>) => void
    const { notify } = recorder()
    const backupNow = createManualBackupAction(
      {
        createManual: () => {
          calls++
          return new Promise((resolve) => (answer = resolve))
        }
      },
      () => undefined,
      notify
    )
    const first = backupNow()
    const second = backupNow()
    answer(ok(CREATED))
    await Promise.all([first, second])
    expect(calls).toBe(1)
  })
})

describe('Open Backup Folder', () => {
  it('shows why the folder could not be opened', async () => {
    const toasts: string[] = []
    const open = createOpenFolderAction(
      {
        openFolder: async () =>
          fail({ code: 'INTERNAL', message: 'Something went wrong. (ref: ABC123)' })
      },
      { error: (message) => toasts.push(message) }
    )
    await open()
    expect(toasts).toEqual(['Something went wrong. (ref: ABC123)'])
  })

  it('says nothing when it opened', async () => {
    const toasts: string[] = []
    await createOpenFolderAction(
      { openFolder: async () => ok(undefined) },
      {
        error: (message) => toasts.push(message)
      }
    )()
    expect(toasts).toEqual([])
  })
})
