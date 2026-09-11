import { describe, expect, expectTypeOf, it } from 'vitest'
import { fail, ok, type AppError, type Result } from './result'

describe('Result envelope', () => {
  it('wraps successful data', () => {
    expect(ok({ version: 3 })).toEqual({ ok: true, data: { version: 3 } })
  })

  it('wraps an AppError', () => {
    const error: AppError = { code: 'NOT_FOUND', message: 'Invoice not found.' }
    expect(fail(error)).toEqual({ ok: false, error })
  })

  it('keeps optional error fields', () => {
    const error: AppError = {
      code: 'VALIDATION',
      message: 'The request was not valid.',
      fieldErrors: { name: ['Required'] },
      details: [{ line: 1 }],
      ref: 'A1B2C3'
    }
    expect(fail(error)).toEqual({ ok: false, error })
  })

  // The envelope crosses Electron IPC, which uses the structured clone algorithm.
  it('survives structured cloning unchanged', () => {
    const success = ok({ n: 1, list: ['a'] })
    const failure = fail({ code: 'DB_ERROR', message: 'The disk is full.', ref: 'FFFFFF' })
    expect(structuredClone(success)).toEqual(success)
    expect(structuredClone(failure)).toEqual(failure)
  })

  it('narrows on the ok flag', () => {
    const result = ok(5) as Result<number>
    if (result.ok) {
      expectTypeOf(result.data).toEqualTypeOf<number>()
    } else {
      expectTypeOf(result.error).toEqualTypeOf<AppError>()
    }
    expectTypeOf(fail({ code: 'INTERNAL', message: 'x' })).toExtend<Result<string>>()
  })
})
