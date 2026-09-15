import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatBackupFileName, sidecarFileOf } from './backup-files'
import {
  DEFAULT_RETENTION,
  rotateBackups,
  selectBackupsToDelete,
  type RetentionPolicy
} from './rotation'
import { createMemoryLogger, createTempDir, holdOpen, type TempDir } from './test-utils'

/** A backup file name for the given local date and time. */
function name(year: number, month: number, day: number, hour = 12, sequence = 1): string {
  return formatBackupFileName(new Date(year, month - 1, day, hour, 0, 0), '1.0.0', 1, sequence)
}

function sorted(names: readonly string[]): string[] {
  return [...names].sort()
}

describe('DEFAULT_RETENTION', () => {
  it('is the approved policy', () => {
    expect(DEFAULT_RETENTION).toEqual({
      auto: { keepDaily: 14, keepMonthly: 12 },
      'pre-migration': { keepLast: 5 },
      'pre-restore': { keepLast: 5 }
    })
  })
})

describe('selectBackupsToDelete: keep the last N', () => {
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((day) => name(2026, 9, day))

  it('keeps the newest 5 and selects the older ones, whatever the listing order', () => {
    const shuffled = [
      eight[4],
      eight[0],
      eight[7],
      eight[2],
      eight[6],
      eight[1],
      eight[5],
      eight[3]
    ]
    expect(sorted(selectBackupsToDelete(shuffled, { keepLast: 5 }))).toEqual(eight.slice(0, 3))
  })

  it('deletes nothing while there are 5 or fewer', () => {
    expect(selectBackupsToDelete(eight.slice(0, 5), { keepLast: 5 })).toEqual([])
    expect(selectBackupsToDelete([], { keepLast: 5 })).toEqual([])
  })

  it('orders backups made in the same second by their sequence number', () => {
    const sameSecond = [
      name(2026, 9, 14, 15, 3),
      name(2026, 9, 14, 15, 1),
      name(2026, 9, 14, 15, 2)
    ]
    expect(selectBackupsToDelete(sameSecond, { keepLast: 2 })).toEqual([name(2026, 9, 14, 15, 1)])
  })

  it('never selects the protected (newest verified) backup, even when its clock time is the oldest', () => {
    const seven = eight.slice(0, 7)
    expect(selectBackupsToDelete(seven, { keepLast: 5 }, seven[0])).toEqual([seven[1]])
  })

  it('never selects files that are not StockFlow backups', () => {
    const old = name(2020, 1, 1)
    const others = [
      'notes.txt',
      'shop.db',
      `${old}.tmp`,
      sidecarFileOf(old),
      'stockflow-backup_broken.db',
      old.toUpperCase()
    ]
    expect(selectBackupsToDelete([...others, name(2026, 9, 14)], { keepLast: 1 })).toEqual([])
    expect(
      selectBackupsToDelete([...others, name(2026, 9, 13), name(2026, 9, 14)], { keepLast: 1 })
    ).toEqual([name(2026, 9, 13)])
  })
})

describe('selectBackupsToDelete: daily and monthly', () => {
  it('keeps the newest backup of each of the last 14 days and the first of each of the last 12 months', () => {
    const names: string[] = []
    for (
      let day = new Date(2025, 7, 1);
      day <= new Date(2026, 8, 14);
      day.setDate(day.getDate() + 1)
    ) {
      const [year, month, date] = [day.getFullYear(), day.getMonth() + 1, day.getDate()]
      names.push(name(year, month, date, 9), name(year, month, date, 18))
    }
    const deleted = new Set(selectBackupsToDelete(names, { keepDaily: 14, keepMonthly: 12 }))
    const daily = Array.from({ length: 14 }, (_, index) => name(2026, 9, index + 1, 18))
    const monthly = [
      [2025, 10],
      [2025, 11],
      [2025, 12],
      [2026, 1],
      [2026, 2],
      [2026, 3],
      [2026, 4],
      [2026, 5],
      [2026, 6],
      [2026, 7],
      [2026, 8],
      [2026, 9]
    ].map(([year, month]) => name(year, month, 1, 9))
    expect(sorted(names.filter((backup) => !deleted.has(backup)))).toEqual(
      sorted([...daily, ...monthly])
    )
  })

  it('counts days and months that have backups, so a long pause never deletes every backup', () => {
    const sparse = [name(2024, 1, 5), name(2024, 6, 5), name(2025, 3, 5)]
    expect(selectBackupsToDelete(sparse, { keepDaily: 14, keepMonthly: 12 })).toEqual([])
  })

  it('keeps one backup per day: the newest of that day', () => {
    const day = [name(2026, 9, 14, 9), name(2026, 9, 14, 12), name(2026, 9, 14, 18)]
    expect(sorted(selectBackupsToDelete(day, { keepDaily: 1, keepMonthly: 0 }))).toEqual(
      sorted([name(2026, 9, 14, 9), name(2026, 9, 14, 12)])
    )
  })

  it('keeps no monthly backup when keepMonthly is 0', () => {
    const backups = [name(2026, 7, 1), name(2026, 8, 1), name(2026, 9, 1)]
    expect(sorted(selectBackupsToDelete(backups, { keepDaily: 1, keepMonthly: 0 }))).toEqual(
      sorted([name(2026, 7, 1), name(2026, 8, 1)])
    )
    expect(selectBackupsToDelete(backups, { keepDaily: 1, keepMonthly: 2 })).toEqual([
      name(2026, 7, 1)
    ])
  })
})

describe('selectBackupsToDelete: policy validation', () => {
  it.each<RetentionPolicy>([
    { keepLast: 0 },
    { keepLast: 1.5 },
    { keepDaily: 0, keepMonthly: 12 },
    { keepDaily: 14, keepMonthly: -1 },
    { keepDaily: 14, keepMonthly: Number.NaN }
  ])('refuses %j', (policy) => {
    expect(() => selectBackupsToDelete([], policy)).toThrow(RangeError)
  })
})

describe('rotateBackups', () => {
  let temp: TempDir
  let folder: string

  beforeEach(() => {
    temp = createTempDir()
    folder = temp.file('pre-migration')
    mkdirSync(folder)
  })

  afterEach(() => {
    temp.remove()
  })

  function makeBackup(fileName: string): string {
    const file = win32.join(folder, fileName)
    writeFileSync(file, 'backup')
    writeFileSync(sidecarFileOf(file), '{}')
    return file
  }

  const seven = [1, 2, 3, 4, 5, 6, 7].map((day) => name(2026, 9, day))

  it('deletes the selected backups with their sidecars and keeps everything else', () => {
    seven.forEach(makeBackup)
    writeFileSync(win32.join(folder, 'notes.txt'), 'kept')
    mkdirSync(win32.join(folder, name(2020, 1, 1)))
    const log = createMemoryLogger()
    const result = rotateBackups(folder, { keepLast: 5 }, { log })
    expect({ deleted: sorted(result.deleted), failed: result.failed }).toEqual({
      deleted: seven.slice(0, 2),
      failed: []
    })
    expect(sorted(readdirSync(folder))).toEqual(
      sorted([
        ...seven.slice(2).flatMap((backup) => [backup, sidecarFileOf(backup)]),
        'notes.txt',
        name(2020, 1, 1)
      ])
    )
    expect(log.entries).toEqual([
      {
        level: 'INFO',
        message: '[backup] old backups rotated',
        context: { folder: 'pre-migration', deleted: 2, failed: 0 }
      }
    ])
  })

  it('logs nothing when there is nothing to delete', () => {
    seven.slice(0, 3).forEach(makeBackup)
    const log = createMemoryLogger()
    expect(rotateBackups(folder, { keepLast: 5 }, { log })).toEqual({ deleted: [], failed: [] })
    expect(log.entries).toEqual([])
  })

  it('never throws: a folder that cannot be read is logged', () => {
    const log = createMemoryLogger()
    expect(rotateBackups(temp.file('missing'), { keepLast: 5 }, { log })).toEqual({
      deleted: [],
      failed: []
    })
    expect(log.entries).toEqual([
      expect.objectContaining({ level: 'ERROR', message: '[backup] backup rotation stopped' })
    ])
  })

  it('never throws on an invalid policy, and deletes nothing', () => {
    seven.forEach(makeBackup)
    const log = createMemoryLogger()
    expect(rotateBackups(folder, { keepLast: 0 }, { log })).toEqual({ deleted: [], failed: [] })
    expect(readdirSync(folder)).toHaveLength(14)
    expect(log.entries[0]).toMatchObject({ level: 'ERROR', error: expect.any(RangeError) })
  })

  it('keeps going when a backup cannot be deleted, and logs it', () => {
    seven.forEach(makeBackup)
    holdOpen(temp, win32.join(folder, seven[0]))
    const log = createMemoryLogger()
    const result = rotateBackups(folder, { keepLast: 5 }, { log })
    expect(result).toEqual({ deleted: [seven[1]], failed: [seven[0]] })
    expect(existsSync(win32.join(folder, seven[0]))).toBe(true)
    expect(existsSync(sidecarFileOf(win32.join(folder, seven[0])))).toBe(true)
    expect(log.entries).toContainEqual({
      level: 'WARN',
      message: '[backup] an old backup could not be deleted; it is kept',
      context: { file: seven[0], code: 'EBUSY' }
    })
  })

  it('logs a sidecar that cannot be deleted, but still deletes its backup', () => {
    seven.forEach(makeBackup)
    const sidecar = sidecarFileOf(win32.join(folder, seven[0]))
    writeFileSync(sidecar, '')
    const blocker = holdOpen(temp, sidecar)
    const log = createMemoryLogger()
    const result = rotateBackups(folder, { keepLast: 5 }, { log })
    blocker.close()
    expect(sorted(result.deleted)).toEqual(seven.slice(0, 2))
    expect(existsSync(win32.join(folder, seven[0]))).toBe(false)
    expect(log.entries).toContainEqual({
      level: 'WARN',
      message: '[backup] the sidecar of a deleted backup could not be deleted',
      context: { file: seven[0], code: 'EBUSY' }
    })
  })
})
