import { describe, expect, it } from 'vitest'
import { fail, ok } from '@shared/types/result'
import { ApiError, unwrap } from './api'

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

describe('unwrap', () => {
  it('returns the data of a successful call', async () => {
    await expect(unwrap(Promise.resolve(ok({ schemaVersion: 0 })))).resolves.toEqual({
      schemaVersion: 0
    })
  })

  it('throws the AppError of a failed call as an ApiError', async () => {
    const error = await rejection(
      unwrap(
        Promise.resolve(
          fail({
            code: 'VALIDATION',
            message: 'Check the highlighted fields.',
            fieldErrors: { name: ['Required'] },
            details: { line: 2 },
            ref: 'A1B2C3'
          })
        )
      )
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: 'ApiError',
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors: { name: ['Required'] },
      details: { line: 2 },
      ref: 'A1B2C3'
    })
  })

  it('reports a call that never produced a Result as INTERNAL, without its raw message', async () => {
    const error = await rejection(
      unwrap(Promise.reject(new Error("Error invoking remote method 'app:info': secret detail")))
    )
    expect(error).toMatchObject({
      code: 'INTERNAL',
      message: 'The request could not be completed.'
    })
    expect(error.message).not.toMatch(/secret/)
  })
})
