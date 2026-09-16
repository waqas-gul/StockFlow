import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/adapter'
import { createSchemaDatabase, createTempDir, thrown, type TempDir } from '../db/test-utils'
import { takeSequenceValue } from './sequences'

let temp: TempDir
let db: Db

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
})

afterEach(() => {
  temp.remove()
})

describe('takeSequenceValue', () => {
  it('hands out consecutive values inside a transaction, and a rollback returns them', () => {
    expect(
      db.transaction(() => [takeSequenceValue(db, 'payment'), takeSequenceValue(db, 'payment')])
    ).toEqual([1, 2])
    thrown(() =>
      db.transaction(() => {
        takeSequenceValue(db, 'payment')
        throw new Error('not saved')
      })
    )
    expect(db.transaction(() => takeSequenceValue(db, 'payment'))).toBe(3)
    expect(db.transaction(() => takeSequenceValue(db, 'customer'))).toBe(2)
  })

  it('refuses to run outside a transaction, or for a missing sequence', () => {
    expect(String(thrown(() => takeSequenceValue(db, 'payment')))).toContain('inside a transaction')
    db.run("DELETE FROM sequences WHERE name = 'invoice'")
    expect(String(thrown(() => db.transaction(() => takeSequenceValue(db, 'invoice'))))).toContain(
      'The invoice sequence is missing.'
    )
  })
})
