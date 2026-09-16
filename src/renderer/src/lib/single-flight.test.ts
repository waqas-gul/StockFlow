import { describe, expect, it } from 'vitest'
import { singleFlight } from './single-flight'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('singleFlight', () => {
  it('returns the running call to a second caller instead of starting the action again', async () => {
    const pending = deferred<string>()
    let calls = 0
    const run = singleFlight(() => {
      calls++
      return pending.promise
    })
    const first = run()
    const second = run()
    expect(second).toBe(first)
    pending.resolve('done')
    await expect(Promise.all([first, second])).resolves.toEqual(['done', 'done'])
    expect(calls).toBe(1)
  })

  it('starts again once the call has settled, also after a failure', async () => {
    let calls = 0
    const run = singleFlight(async (fail: boolean) => {
      calls++
      if (fail) throw new Error('failed')
      return calls
    })
    await expect(run(true)).rejects.toThrow('failed')
    await expect(run(false)).resolves.toBe(2)
    await expect(run(false)).resolves.toBe(3)
  })
})
