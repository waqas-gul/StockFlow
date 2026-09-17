import type { BrowserWindow, MessageBoxSyncOptions } from 'electron'

/*
 * Closing StockFlow while New Invoice holds unsaved work. The page keeps a `beforeunload` guard while its draft is dirty
 * (src/renderer/src/lib/unload-guard.ts); Electron then refuses to unload it and emits `will-prevent-unload`, and the
 * main process asks here. No IPC is involved: the renderer can only hold the page open, never close it.
 */

export const UNSAVED_INVOICE_CLOSE_DIALOG = Object.freeze({
  type: 'warning',
  title: 'Unsaved invoice',
  message: 'You have an unsaved invoice. Close StockFlow and discard it?',
  detail: 'The invoice has not been posted. Closing now discards it.',
  buttons: ['Stay', 'Close and Discard'],
  defaultId: 0,
  cancelId: 0,
  noLink: true
}) satisfies MessageBoxSyncOptions

const CLOSE_AND_DISCARD = 1

/** True when the user chose Close and Discard; Stay, Escape or closing the box keeps the window open. */
export function allowCloseWithUnsavedWork(
  showMessageBox: (options: typeof UNSAVED_INVOICE_CLOSE_DIALOG) => number
): boolean {
  return showMessageBox(UNSAVED_INVOICE_CLOSE_DIALOG) === CLOSE_AND_DISCARD
}

/** Asks before the window closes over unsaved work; preventDefault on this event lets the unload go ahead. */
export function guardUnsavedWorkOnClose(
  window: BrowserWindow,
  showMessageBox: (window: BrowserWindow, options: MessageBoxSyncOptions) => number
): void {
  window.webContents.on('will-prevent-unload', (event) => {
    if (
      allowCloseWithUnsavedWork((options) =>
        showMessageBox(window, { ...options, buttons: [...options.buttons] })
      )
    ) {
      event.preventDefault()
    }
  })
}
