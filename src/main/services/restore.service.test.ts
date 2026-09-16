import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RestoreCandidateSelection } from '@shared/types/backup'
import { backupFolder, resolveDataPaths } from '../data-paths'
import { initializeDatabase } from '../db'
import { openSqlite, type Db } from '../db/adapter'
import { createVerifiedBackup } from '../db/backup'
import {
  TEST_TIME,
  createTempDir,
  insertRow,
  replaceFolderWithFile,
  testContext,
  violateCheckConstraint,
  type TempDir
} from '../db/test-utils'
import { AppFailure } from '../errors'
import { BackupStatusStore } from './backup-status'
import { RESTORE_TOKEN_TTL_MS } from './restore.service'
import { createServicesFixture, type FixtureOptions, type ServicesFixture } from './test-utils'

const CANDIDATE_TIME = new Date(2026, 8, 1, 18, 0, 0)
const RESTORED_HEALTHY =
  'The backup was restored. A safety backup of the previous data was saved first.'

let temp: TempDir
let fixture: ServicesFixture
let sources: number

async function setUp(options: FixtureOptions = {}): Promise<void> {
  fixture = await createServicesFixture(temp, options)
  insertRow(fixture.db, 'companies', { name: 'Current data' })
}

beforeEach(async () => {
  temp = createTempDir()
  sources = 0
  await setUp()
})

afterEach(() => {
  temp.remove()
})

/** A verified backup, made by StockFlow 0.9.0, of another StockFlow database that holds `names`, on the "USB drive". */
async function candidateBackup(names: readonly string[]): Promise<string> {
  sources++
  const sourceContext = testContext(temp, {
    paths: resolveDataPaths(temp.file(`source-${sources}`)),
    appVersion: '0.9.0',
    now: () => CANDIDATE_TIME
  })
  const source = await initializeDatabase(sourceContext)
  try {
    for (const name of names) insertRow(source, 'companies', { name })
    return (await createVerifiedBackup(source, temp.file(`usb-${sources}`), sourceContext)).file
  } finally {
    source.close()
  }
}

function companies(db: Db): string[] {
  return db.all<{ name: string }>('SELECT name FROM companies ORDER BY id').map((row) => row.name)
}

/** The companies in the live database file, read through a separate connection. */
function companiesOnDisk(): string[] {
  const check = openSqlite(fixture.ctx.paths.databaseFile, { readonly: true })
  try {
    return companies(check)
  } finally {
    check.close()
  }
}

async function select(
  file: string
): Promise<Extract<RestoreCandidateSelection, { status: 'SELECTED' }>> {
  fixture.dialogs.openAnswers.push(file)
  const selection = await fixture.restore.selectCandidate()
  if (selection.status !== 'SELECTED') throw new Error('The backup was not selected.')
  return selection
}

function confirm(token: string): Promise<unknown> {
  return fixture.restore.restore({ token, confirmation: 'RESTORE' })
}

async function failure(attempt: Promise<unknown>): Promise<AppFailure['error']> {
  const error = await attempt.then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

function preRestoreBackups(): string[] {
  const folder = backupFolder(fixture.ctx.paths, 'pre-restore')
  return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.db')) : []
}

describe('RestoreService.selectCandidate', () => {
  it('opens the Open dialog in the automatic backup folder, and changes nothing when cancelled', async () => {
    await expect(fixture.restore.selectCandidate()).resolves.toEqual({ status: 'CANCELLED' })
    expect(fixture.dialogs.openRequests).toEqual([backupFolder(fixture.ctx.paths, 'auto')])
    expect(await failure(confirm('a'.repeat(32)))).toMatchObject({ code: 'RESTORE_REJECTED' })
  })

  it('validates the chosen backup and returns a safe summary with a one-time token, and no path', async () => {
    const file = await candidateBackup(['Restored A', 'Restored B'])
    const selection = await select(file)
    expect(selection).toEqual({
      status: 'SELECTED',
      token: expect.stringMatching(/^[0-9a-f]{32}$/),
      summary: {
        fileName: win32.basename(file),
        backupCreatedAt: CANDIDATE_TIME.toISOString(),
        schemaVersion: 1,
        appVersion: '0.9.0',
        products: 0,
        customers: 1,
        invoices: 0,
        sizeBytes: expect.any(Number),
        needsMigration: false
      }
    })
    expect(JSON.stringify(selection)).not.toContain(temp.path.replaceAll('\\', '\\\\'))
    expect(companies(fixture.db)).toEqual(['Current data'])
    expect(fixture.restarts.count).toBe(0)
  })

  it.each<[string, (file: string) => string, string]>([
    [
      'a file that is not a database',
      (file) => {
        const text = win32.join(win32.dirname(file), 'notes.db')
        writeFileSync(text, 'not a database '.repeat(100))
        return text
      },
      'This file is not a StockFlow backup.'
    ],
    [
      'a damaged backup',
      (file) => {
        const damaged = win32.join(win32.dirname(file), 'damaged.db')
        copyFileSync(file, damaged)
        violateCheckConstraint(damaged)
        return damaged
      },
      'This backup is damaged and cannot be restored.'
    ],
    [
      'the live database itself',
      () => fixture.ctx.paths.databaseFile,
      'This file is part of the StockFlow data folder. Choose a backup file instead.'
    ]
  ])(
    'refuses %s with the Phase 4A message, and issues no token',
    async (_label, choose, message) => {
      const file = choose(await candidateBackup(['Restored']))
      fixture.dialogs.openAnswers.push(file)
      expect(await failure(fixture.restore.selectCandidate())).toEqual({
        code: 'RESTORE_REJECTED',
        message
      })
      expect(companiesOnDisk()).toEqual(['Current data'])
      expect(preRestoreBackups()).toEqual([])
    }
  )

  it('makes an earlier token invalid when another backup is chosen', async () => {
    const file = await candidateBackup(['Restored'])
    const first = await select(file)
    const second = await select(file)
    expect(second.token).not.toBe(first.token)
    expect(await failure(confirm(first.token))).toMatchObject({ code: 'RESTORE_REJECTED' })
  })
})

describe('RestoreService.restore', () => {
  it('restores the confirmed backup with the Phase 4A engine, records it and restarts StockFlow', async () => {
    const selection = await select(await candidateBackup(['Restored A']))
    await expect(confirm(selection.token)).resolves.toEqual({
      restored: true,
      message: RESTORED_HEALTHY
    })
    expect(fixture.restarts.count).toBe(1)
    expect(companiesOnDisk()).toEqual(['Restored A'])
    expect(preRestoreBackups()).toHaveLength(1)
    expect(fixture.status.record.lastRestore).toEqual({
      at: TEST_TIME.toISOString(),
      fileName: selection.summary.fileName,
      restored: true,
      message: RESTORED_HEALTHY
    })
    expect(new BackupStatusStore(fixture.ctx.paths, fixture.ctx.log).record.lastRestore).toEqual(
      fixture.status.record.lastRestore
    )
    expect(fixture.db.isOpen).toBe(false)
    expect(() => fixture.database.get()).toThrow('StockFlow is restarting.')
  })

  it('refuses everything once StockFlow is restarting', async () => {
    const file = await candidateBackup(['Restored'])
    const selection = await select(file)
    await confirm(selection.token)
    for (const attempt of [fixture.restore.selectCandidate(), confirm(selection.token)]) {
      expect(await failure(attempt)).toEqual({
        code: 'FORBIDDEN_STATE',
        message: 'StockFlow is restarting.'
      })
    }
    expect(fixture.restarts.count).toBe(1)
  })

  it('refuses a forged token, which also uses up the pending confirmation', async () => {
    const selection = await select(await candidateBackup(['Restored']))
    expect(await failure(confirm('f'.repeat(32)))).toEqual({
      code: 'RESTORE_REJECTED',
      message: 'This restore confirmation is not valid any more. Choose the backup again.'
    })
    expect(await failure(confirm(selection.token))).toMatchObject({ code: 'RESTORE_REJECTED' })
    expect(companiesOnDisk()).toEqual(['Current data'])
    expect(fixture.restarts.count).toBe(0)
    expect(fixture.ctx.log.entries).toContainEqual({
      level: 'WARN',
      message: '[restore] a restore request was refused',
      context: { reason: 'UNKNOWN_TOKEN' }
    })
  })

  it('refuses a request without the typed confirmation, and keeps the confirmation for a proper one', async () => {
    const selection = await select(await candidateBackup(['Restored']))
    const unconfirmed = fixture.restore.restore({
      token: selection.token,
      confirmation: 'restore' as 'RESTORE'
    })
    expect(await failure(unconfirmed)).toEqual({
      code: 'RESTORE_REJECTED',
      message: 'Type RESTORE to confirm the restore.'
    })
    await expect(confirm(selection.token)).resolves.toMatchObject({ restored: true })
  })

  it('never accepts the same token twice, even when the first restore changed nothing', async () => {
    const selection = await select(await candidateBackup(['Restored']))
    replaceFolderWithFile(backupFolder(fixture.ctx.paths, 'pre-restore'))
    expect(await failure(confirm(selection.token))).toMatchObject({ code: 'RESTORE_FAILED' })
    expect(await failure(confirm(selection.token))).toMatchObject({ code: 'RESTORE_REJECTED' })
    expect(companiesOnDisk()).toEqual(['Current data'])
  })

  it('refuses a confirmation that comes more than 10 minutes later', async () => {
    const selection = await select(await candidateBackup(['Restored']))
    fixture.clock.advance(RESTORE_TOKEN_TTL_MS + 1)
    expect(await failure(confirm(selection.token))).toEqual({
      code: 'RESTORE_REJECTED',
      message: 'The confirmation took too long. Choose the backup again.'
    })
    expect(companiesOnDisk()).toEqual(['Current data'])
  })

  it.each<[string, (file: string) => void]>([
    ['changed', (file) => appendFileSync(file, 'x')],
    ['removed', (file) => rmSync(file)]
  ])('refuses a backup file that was %s after it was checked', async (_label, change) => {
    const file = await candidateBackup(['Restored'])
    const selection = await select(file)
    change(file)
    expect(await failure(confirm(selection.token))).toEqual({
      code: 'RESTORE_REJECTED',
      message: 'The backup file changed or was removed after it was checked. Choose it again.'
    })
    expect(companiesOnDisk()).toEqual(['Current data'])
  })

  it('keeps running on the current database when the restore stops before changing anything', async () => {
    const selection = await select(await candidateBackup(['Restored']))
    replaceFolderWithFile(backupFolder(fixture.ctx.paths, 'pre-restore'))
    expect(await failure(confirm(selection.token))).toEqual({
      code: 'RESTORE_FAILED',
      message: 'A safety backup of the current data could not be made, so nothing was restored.'
    })
    expect(fixture.restarts.count).toBe(0)
    expect(fixture.database.get()).toBe(fixture.db)
    insertRow(fixture.db, 'companies', { name: 'Still working' })
    expect(companies(fixture.db)).toEqual(['Current data', 'Still working'])
    expect(fixture.status.record.lastRestore).toMatchObject({ restored: false })
  })

  it('restarts on the previous data when the restore fails after the database was moved', async () => {
    temp.remove()
    temp = createTempDir()
    await setUp({
      faults: {
        beforeRestoreFinalCheck: () => {
          throw new Error('simulated final check failure')
        }
      }
    })
    const selection = await select(await candidateBackup(['Restored']))
    await expect(confirm(selection.token)).resolves.toEqual({
      restored: false,
      message: 'The restored database failed its final check. The previous data was put back.'
    })
    expect(fixture.restarts.count).toBe(1)
    expect(companiesOnDisk()).toEqual(['Current data'])
    expect(() => fixture.database.get()).toThrow('StockFlow is restarting.')
  })

  it('restores over a damaged current database, keeping it unchanged in the recovery folder', async () => {
    fixture.db.exec('PRAGMA ignore_check_constraints = ON')
    fixture.db.run("INSERT INTO settings (key, value) VALUES ('probe.broken', 'not json')")
    fixture.db.exec('PRAGMA ignore_check_constraints = OFF')
    const selection = await select(await candidateBackup(['Restored']))
    await expect(confirm(selection.token)).resolves.toEqual({
      restored: true,
      message:
        'The backup was restored. The previous database was damaged, so it was kept unchanged in the recovery folder.'
    })
    expect(fixture.restarts.count).toBe(1)
    expect(companiesOnDisk()).toEqual(['Restored'])
    expect(readdirSync(fixture.ctx.paths.recoveryDir)).toContain(
      'damaged-live-db_2026-09-14_153045.db'
    )
    expect(preRestoreBackups()).toEqual([])
  })

  it('refuses a restore while a backup is running, without using up the confirmation', async () => {
    const selection = await select(await candidateBackup(['Restored']))
    let release!: () => void
    const running = fixture.lock.run(
      'AUTOMATIC_BACKUP',
      () => new Promise<void>((resolve) => (release = resolve))
    )
    expect(await failure(confirm(selection.token))).toEqual({
      code: 'FORBIDDEN_STATE',
      message: 'An automatic backup is being made. Try again in a moment.'
    })
    release()
    await running
    await expect(confirm(selection.token)).resolves.toMatchObject({ restored: true })
  })

  it('restarts to open the data safely when the restore stops unexpectedly', async () => {
    let explode = false
    temp.remove()
    temp = createTempDir()
    await setUp({
      wrap: (db) =>
        new Proxy(db, {
          get(target, property) {
            if (property === 'isOpen' && explode) throw new Error('unexpected failure')
            const value: unknown = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
    })
    const selection = await select(await candidateBackup(['Restored']))
    explode = true
    await expect(confirm(selection.token)).resolves.toEqual({
      restored: false,
      message: 'The restore stopped unexpectedly. StockFlow restarts to open your data safely.'
    })
    explode = false
    expect(fixture.restarts.count).toBe(1)
    expect(companiesOnDisk()).toEqual(['Current data'])
    expect(fixture.ctx.log.entries).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        message:
          '[restore] the restore stopped unexpectedly; StockFlow restarts to open the data safely'
      })
    )
  })
})
