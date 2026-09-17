import { describe, expect, it } from 'vitest'
import { UNSAVED_INVOICE_CLOSE_DIALOG, allowCloseWithUnsavedWork } from './unsaved-close'

describe('closing the window with an unsaved invoice', () => {
  it('asks with Stay as the default and cancel button', () => {
    expect(UNSAVED_INVOICE_CLOSE_DIALOG).toEqual({
      type: 'warning',
      title: 'Unsaved invoice',
      message: 'You have an unsaved invoice. Close StockFlow and discard it?',
      detail: 'The invoice has not been posted. Closing now discards it.',
      buttons: ['Stay', 'Close and Discard'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
  })

  it('closes only when the user chooses Close and Discard', () => {
    const shown: unknown[] = []
    expect(allowCloseWithUnsavedWork((options) => (shown.push(options), 1))).toBe(true)
    expect(allowCloseWithUnsavedWork((options) => (shown.push(options), 0))).toBe(false)
    // Escape or closing the message box answers cancelId (Stay).
    expect(allowCloseWithUnsavedWork(() => UNSAVED_INVOICE_CLOSE_DIALOG.cancelId)).toBe(false)
    expect(shown).toEqual([UNSAVED_INVOICE_CLOSE_DIALOG, UNSAVED_INVOICE_CLOSE_DIALOG])
  })
})
