import { describe, expect, it } from 'vitest'
import { guardUnload } from './unload-guard'

/** True when a beforeunload event on `target` was cancelled (the page is held open). */
function held(target: EventTarget): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

describe('guardUnload', () => {
  it('holds the page open only while the guard is on, so the main process can ask before closing', () => {
    const target = new EventTarget()
    expect(held(target)).toBe(false)
    const release = guardUnload(target)
    expect(held(target)).toBe(true)
    expect(held(target)).toBe(true)
    release()
    expect(held(target)).toBe(false)
  })
})
