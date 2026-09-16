import {
  app,
  dialog,
  shell,
  type BrowserWindow,
  type OpenDialogOptions,
  type SaveDialogOptions
} from 'electron'
import type { BackupDialogs } from './services/backup.service'
import type { RecoveryDialogs } from './services/startup-recovery'

/*
 * The Electron side of Settings → Backup & Restore and of recovery mode: the file dialogs, message boxes, opening the
 * backup folder and relaunching. Only the main process calls these, with paths it chose itself; nothing here is
 * reachable from the renderer except through the fixed backup calls of the IPC contract.
 */

const BACKUP_FILTERS = [{ name: 'StockFlow backup', extensions: ['db'] }]

/** The Save and Open dialogs of manual backups and restores, modal to the main window. */
export function createBackupDialogs(getWindow: () => BrowserWindow | null): BackupDialogs {
  return {
    async chooseBackupFile(defaultPath) {
      const options: SaveDialogOptions = {
        title: 'Save a StockFlow backup',
        defaultPath,
        buttonLabel: 'Save backup',
        filters: BACKUP_FILTERS
      }
      const window = getWindow()
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      return result.canceled || !result.filePath ? null : result.filePath
    },
    async chooseRestoreFile(defaultFolder) {
      const options: OpenDialogOptions = {
        title: 'Choose a StockFlow backup to restore',
        defaultPath: defaultFolder,
        buttonLabel: 'Choose backup',
        filters: BACKUP_FILTERS,
        properties: ['openFile']
      }
      const window = getWindow()
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      return result.canceled || result.filePaths.length !== 1 ? null : result.filePaths[0]
    }
  }
}

/** The native dialogs of recovery mode (startup-recovery.ts). There is no window yet, so they have no parent. */
export function createRecoveryDialogs(): RecoveryDialogs {
  return {
    async showMessage(message) {
      const result = await dialog.showMessageBox({
        type: message.type,
        title: message.title,
        message: message.message,
        detail: message.detail,
        buttons: [...message.buttons],
        defaultId: message.defaultId,
        cancelId: message.cancelId,
        noLink: true,
        ...(message.checkboxLabel === undefined
          ? {}
          : { checkboxLabel: message.checkboxLabel, checkboxChecked: false })
      })
      return { response: result.response, checkboxChecked: result.checkboxChecked }
    },
    chooseRestoreFile: createBackupDialogs(() => null).chooseRestoreFile
  }
}

/** Opens a folder the main process chose (the automatic backup folder) in File Explorer. */
export async function openFolderInExplorer(folder: string): Promise<void> {
  const failure = await shell.openPath(folder)
  if (failure !== '') throw new Error(`The folder could not be opened: ${failure}`)
}

/**
 * Restarts StockFlow: a new instance starts once this one has exited. app.exit skips `will-quit`, so no shutdown
 * backup is made; the caller has already closed the database.
 */
export function relaunchApp(): void {
  app.relaunch()
  app.exit(0)
}
