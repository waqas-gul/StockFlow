import type { ManualBackupRecord, ManualBackupResult } from '@shared/types/backup'
import type { Result } from '@shared/types/result'
import { unwrap } from '@renderer/lib/api'
import { errorMessage } from '@renderer/lib/format'
import { singleFlight } from '@renderer/lib/single-flight'

/** Backup Now: Idle → Creating… → Success or Failed. */
export type ManualBackupState =
  | { readonly state: 'idle' }
  | { readonly state: 'creating' }
  | { readonly state: 'success'; readonly backup: ManualBackupRecord }
  | { readonly state: 'failed'; readonly message: string }

export interface Notifier {
  success(message: string): void
  error(message: string): void
}

/**
 * Backup Now. The main process opens the Save dialog and writes the backup; the renderer only starts it and shows
 * the outcome. A second click while it runs does not start another one.
 */
export function createManualBackupAction(
  api: { createManual(): Promise<Result<ManualBackupResult>> },
  update: (state: ManualBackupState) => void,
  notify: Notifier
): () => Promise<void> {
  return singleFlight(async () => {
    update({ state: 'creating' })
    try {
      const result = await unwrap(api.createManual())
      if (result.status === 'CANCELLED') {
        update({ state: 'idle' })
        return
      }
      update({ state: 'success', backup: result.backup })
      notify.success(`Backup saved: ${result.backup.fileName}`)
    } catch (error) {
      const message = errorMessage(error)
      update({ state: 'failed', message })
      notify.error(message)
    }
  })
}

/** Open Backup Folder: a fixed folder chosen by the main process. */
export function createOpenFolderAction(
  api: { openFolder(): Promise<Result<void>> },
  notify: Pick<Notifier, 'error'>
): () => Promise<void> {
  return singleFlight(async () => {
    try {
      await unwrap(api.openFolder())
    } catch (error) {
      notify.error(errorMessage(error))
    }
  })
}
