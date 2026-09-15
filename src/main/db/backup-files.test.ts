import { describe, expect, it } from 'vitest'
import {
  BACKUP_FILE_PREFIX,
  formatBackupFileName,
  parseBackupFileName,
  sidecarFileOf
} from './backup-files'

const TIME = new Date(2026, 8, 14, 15, 30, 45)

describe('formatBackupFileName', () => {
  it('names a backup by local date and time, app version and schema version', () => {
    expect(BACKUP_FILE_PREFIX).toBe('stockflow-backup_')
    expect(formatBackupFileName(TIME, '1.0.0', 1)).toBe(
      'stockflow-backup_2026-09-14_153045_v1.0.0_s1.db'
    )
  })

  it('is deterministic and zero-pads every field', () => {
    const early = new Date(2027, 0, 2, 3, 4, 5)
    expect(formatBackupFileName(early, '1.2.3', 12)).toBe(
      'stockflow-backup_2027-01-02_030405_v1.2.3_s12.db'
    )
    expect(formatBackupFileName(new Date(early), '1.2.3', 12)).toBe(
      formatBackupFileName(early, '1.2.3', 12)
    )
  })

  it('adds a sequence number from the second backup made in the same second', () => {
    expect(formatBackupFileName(TIME, '1.0.0', 1, 1)).toBe(
      'stockflow-backup_2026-09-14_153045_v1.0.0_s1.db'
    )
    expect(formatBackupFileName(TIME, '1.0.0', 1, 2)).toBe(
      'stockflow-backup_2026-09-14_153045_v1.0.0_s1_2.db'
    )
  })

  it('keeps only characters that are safe in Windows file names', () => {
    const name = formatBackupFileName(TIME, '1.0.0+build/7 "beta"<x>:*?|\\', 1)
    expect(name).toBe('stockflow-backup_2026-09-14_153045_v1.0.0-build-7--beta--x------_s1.db')
    expect(name).not.toMatch(/[<>:"/\\|?*\s]/)
    expect(parseBackupFileName(name)?.appVersion).toBe('1.0.0-build-7--beta--x------')
    expect(formatBackupFileName(TIME, '', 1)).toBe(
      'stockflow-backup_2026-09-14_153045_vunknown_s1.db'
    )
  })
})

describe('parseBackupFileName', () => {
  it('reads back what formatBackupFileName writes', () => {
    expect(parseBackupFileName('stockflow-backup_2026-09-14_153045_v1.0.0_s1_3.db')).toEqual({
      fileName: 'stockflow-backup_2026-09-14_153045_v1.0.0_s1_3.db',
      time: TIME,
      appVersion: '1.0.0',
      schemaVersion: 1,
      sequence: 3,
      dayKey: '2026-09-14',
      monthKey: '2026-09',
      sortKey: '20260914153045003'
    })
    expect(parseBackupFileName(formatBackupFileName(TIME, '1.0.0-test', 1))).toMatchObject({
      appVersion: '1.0.0-test',
      sequence: 1
    })
  })

  it.each([
    ['an unrelated file', 'notes.txt'],
    ['the live database', 'shop.db'],
    ['a temporary backup', 'stockflow-backup_2026-09-14_153045_v1.0.0_s1.db.tmp'],
    ['a sidecar', 'stockflow-backup_2026-09-14_153045_v1.0.0_s1.json'],
    ['another letter case', 'Stockflow-Backup_2026-09-14_153045_v1.0.0_s1.db'],
    ['another extension case', 'stockflow-backup_2026-09-14_153045_v1.0.0_s1.DB'],
    ['a date that does not exist', 'stockflow-backup_2026-02-30_153045_v1.0.0_s1.db'],
    ['a time that does not exist', 'stockflow-backup_2026-09-14_246060_v1.0.0_s1.db'],
    ['a missing version', 'stockflow-backup_2026-09-14_153045_v_s1.db'],
    ['a missing schema', 'stockflow-backup_2026-09-14_153045_v1.0.0_s.db'],
    ['sequence 1, which is never written', 'stockflow-backup_2026-09-14_153045_v1.0.0_s1_1.db'],
    ['sequence 0', 'stockflow-backup_2026-09-14_153045_v1.0.0_s1_0.db']
  ])('ignores %s', (_label, name) => {
    expect(parseBackupFileName(name)).toBeNull()
  })
})

describe('sidecarFileOf', () => {
  it('is the backup file with .json instead of .db', () => {
    expect(
      sidecarFileOf('C:\\backups\\auto\\stockflow-backup_2026-09-14_153045_v1.0.0_s1.db')
    ).toBe('C:\\backups\\auto\\stockflow-backup_2026-09-14_153045_v1.0.0_s1.json')
  })
})
