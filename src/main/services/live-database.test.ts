import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/adapter'
import { openDatabase } from '../db/connection'
import { createTempDir, thrown, type TempDir } from '../db/test-utils'
import { AppFailure } from '../errors'
import { LiveDatabase } from './live-database'

let temp: TempDir
let db: Db

beforeEach(() => {
  temp = createTempDir()
  db = temp.track(openDatabase(temp.file('shop.db')))
})

afterEach(() => {
  temp.remove()
})

function refusal(fn: () => unknown): AppFailure['error'] {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

describe('LiveDatabase', () => {
  it('hands out the open connection', () => {
    const live = new LiveDatabase(db)
    expect(live.state).toBe('OPEN')
    expect(live.get()).toBe(db)
  })

  it('refuses every request while a restore runs, then continues on the connection the restore returns', () => {
    const live = new LiveDatabase(db)
    expect(live.beginRestore()).toBe(db)
    expect(live.state).toBe('RESTORING')
    expect(refusal(() => live.get())).toEqual({
      code: 'FORBIDDEN_STATE',
      message: 'A restore is in progress. Wait until it is finished.'
    })
    expect(() => live.beginRestore()).toThrow(AppFailure)
    const other = temp.track(openDatabase(temp.file('other.db')))
    live.continueWith(other)
    expect(live.get()).toBe(other)
  })

  it('closes the restored and the old connection, and refuses everything once StockFlow restarts', () => {
    const live = new LiveDatabase(db)
    const restored = temp.track(openDatabase(temp.file('restored.db')))
    live.beginRestore()
    live.restart(restored)
    expect([db.isOpen, restored.isOpen]).toEqual([false, false])
    expect(live.state).toBe('RESTARTING')
    expect(refusal(() => live.get()).message).toBe('StockFlow is restarting.')
    live.close()
    expect(live.state).toBe('RESTARTING')
    expect(refusal(() => live.get()).message).toBe('StockFlow is restarting.')
  })

  it('restarts without a connection when the restore handed none back', () => {
    const live = new LiveDatabase(db)
    live.restart(null)
    expect(db.isOpen).toBe(false)
    expect(live.state).toBe('RESTARTING')
  })

  it('closes the connection at quit and refuses further requests', () => {
    const live = new LiveDatabase(db)
    live.close()
    expect(db.isOpen).toBe(false)
    expect(live.state).toBe('CLOSED')
    expect(refusal(() => live.get()).message).toBe('StockFlow is closing.')
    expect(() => live.beginRestore()).toThrow(AppFailure)
  })
})
