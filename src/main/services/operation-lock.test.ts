import { describe, expect, it } from 'vitest'
import { thrown } from '../db/test-utils'
import { AppFailure } from '../errors'
import { OperationLock, type DataSafetyOperation } from './operation-lock'

/** Starts `operation` on `lock` and returns the function that ends it. */
function hold(
  lock: OperationLock,
  operation: DataSafetyOperation
): { release: () => void; done: Promise<void> } {
  let release!: () => void
  const done = lock.run(operation, () => new Promise<void>((resolve) => (release = resolve)))
  return { release, done }
}

async function refusal(attempt: Promise<unknown>): Promise<AppFailure['error']> {
  const error = await attempt.then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

describe('OperationLock', () => {
  it('runs one operation at a time and refuses a second one at once, without running it', async () => {
    const lock = new OperationLock()
    const manual = hold(lock, 'MANUAL_BACKUP')
    expect(lock.current).toBe('MANUAL_BACKUP')
    let ran = false
    const second = lock.run('RESTORE', async () => {
      ran = true
    })
    expect(await refusal(second)).toEqual({
      code: 'FORBIDDEN_STATE',
      message: 'A backup is already being made. Wait until it is finished.'
    })
    expect(ran).toBe(false)
    manual.release()
    await manual.done
    expect(lock.current).toBeNull()
    await expect(lock.run('RESTORE', async () => 'restored')).resolves.toBe('restored')
  })

  it.each<[DataSafetyOperation, string]>([
    ['AUTOMATIC_BACKUP', 'An automatic backup is being made. Try again in a moment.'],
    ['RESTORE', 'A restore is in progress. Wait until it is finished.']
  ])('explains that %s is running', async (operation, message) => {
    const lock = new OperationLock()
    const running = hold(lock, operation)
    const error = thrown(() => lock.assertIdle())
    expect((error as AppFailure).error).toEqual({ code: 'FORBIDDEN_STATE', message })
    running.release()
    await running.done
    expect(() => lock.assertIdle()).not.toThrow()
  })

  it('is free again after an operation that failed', async () => {
    const lock = new OperationLock()
    await expect(
      lock.run('MANUAL_BACKUP', () => Promise.reject(new Error('disk full')))
    ).rejects.toThrow('disk full')
    expect(lock.current).toBeNull()
  })

  it('tells when no operation is running any more', async () => {
    const lock = new OperationLock()
    await expect(lock.whenIdle()).resolves.toBeUndefined()
    const running = hold(lock, 'AUTOMATIC_BACKUP')
    let idle = false
    const waiting = lock.whenIdle().then(() => {
      idle = true
    })
    await Promise.resolve()
    expect(idle).toBe(false)
    running.release()
    await waiting
    expect(idle).toBe(true)
  })
})
