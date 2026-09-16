/**
 * Wraps an async action so that calling it again while it runs returns the running call instead of starting a
 * second one: a double click never submits twice. Once it has settled, the next call starts it again.
 */
export function singleFlight<Args extends unknown[], T>(
  action: (...args: Args) => Promise<T>
): (...args: Args) => Promise<T> {
  let running: Promise<T> | null = null
  return (...args) => {
    running ??= action(...args).finally(() => {
      running = null
    })
    return running
  }
}
