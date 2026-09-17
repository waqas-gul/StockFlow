import { useEffect } from 'react'

/*
 * Keeps the app window from closing silently over unsaved work. While the guard is on, `beforeunload` is cancelled;
 * Electron then asks the main process, which shows "Stay / Close and Discard" (src/main/unsaved-close.ts).
 */

function holdUnload(event: Event): void {
  event.preventDefault()
  // Chromium also reads a non-empty returnValue as "keep the page".
  ;(event as BeforeUnloadEvent).returnValue = 'unsaved'
}

/** Turns the guard on for `target`; the returned function turns it off. */
export function guardUnload(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
): () => void {
  target.addEventListener('beforeunload', holdUnload)
  return () => target.removeEventListener('beforeunload', holdUnload)
}

/** The guard is on while `active` (e.g. a dirty invoice draft) and off as soon as it is not. */
export function useUnloadGuard(active: boolean): void {
  useEffect(() => (active ? guardUnload(window) : undefined), [active])
}
