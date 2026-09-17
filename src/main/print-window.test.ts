import { describe, expect, it } from 'vitest'
import { printOutcome } from './print-window'

describe('printOutcome', () => {
  it('is SENT when the job was sent to the printer', () => {
    expect(printOutcome(true, '')).toBe('SENT')
  })

  it('is CANCELLED however the print dialog reports a cancel', () => {
    // Electron documents "cancelled"; the Windows 11 print dialog reports "Print job canceled".
    expect(printOutcome(false, 'cancelled')).toBe('CANCELLED')
    expect(printOutcome(false, 'Print job canceled')).toBe('CANCELLED')
  })

  it('throws for any other failure', () => {
    expect(() => printOutcome(false, 'failed')).toThrow('Printing failed: failed')
    expect(() => printOutcome(false, 'Invalid printer settings')).toThrow(
      'Printing failed: Invalid printer settings'
    )
  })
})
