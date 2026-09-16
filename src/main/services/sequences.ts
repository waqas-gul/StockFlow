import type { Db } from '../db/adapter'

/** The document counters seeded by 0001 (plan §7.3 `sequences`). */
export type SequenceName = 'invoice' | 'receipt' | 'payment' | 'adjustment' | 'customer'

/**
 * Takes the next value of a sequence inside the caller's transaction: if the document is not saved, the rollback
 * returns the value, so no number is used up.
 */
export function takeSequenceValue(db: Db, name: SequenceName): number {
  if (!db.inTransaction) throw new Error('Sequence values are taken inside a transaction.')
  const row = db.get<{ next_value: number }>('SELECT next_value FROM sequences WHERE name = ?', [
    name
  ])
  if (row === undefined) throw new Error(`The ${name} sequence is missing.`)
  db.run('UPDATE sequences SET next_value = next_value + 1 WHERE name = ?', [name])
  return row.next_value
}
