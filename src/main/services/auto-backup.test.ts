import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backupFolder } from '../data-paths'
import { formatBackupFileName, parseBackupFileName, type BackupName } from '../db/backup-files'
import {
  LATEST_SCHEMA_VERSION,
  TEST_APP_VERSION,
  createTempDir,
  fileHash,
  type TempDir
} from '../db/test-utils'
import { verifyDatabaseFile } from '../db/verify'
import {
  AUTOMATIC_BACKUP_CHECK_INTERVAL_MS,
  AUTOMATIC_BACKUP_LAUNCH_DELAY_MS,
  AUTOMATIC_BACKUP_MIN_INTERVAL_MS,
  SHUTDOWN_BACKUP_TIMEOUT_MS,
  automaticBackupDecision,
  type AutomaticBackupFacts
} from './auto-backup'
import { BackupStatusStore, backupFailureMessage } from './backup-status'
import { createServicesFixture, type FixtureOptions, type ServicesFixture } from './test-utils'

const HOUR = AUTOMATIC_BACKUP_MIN_INTERVAL_MS
const MINUTE = 60 * 1000
/** 14 Sep 2026, 09:00 local time. */
const MORNING = new Date(2026, 8, 14, 9, 0, 0)

function at(day: number, hour: number, minute = 0): Date {
  return new Date(2026, 8, day, hour, minute, 0)
}

function backupAt(time: Date): BackupName {
  return parseBackupFileName(formatBackupFileName(time, '1.0.0', 1)) as BackupName
}

function facts(overrides: Partial<AutomaticBackupFacts>): AutomaticBackupFacts {
  return { trigger: 'LAUNCH', now: MORNING, backups: [], lastFailureAt: null, ...overrides }
}

describe('automaticBackupDecision', () => {
  it('is due at the first launch or use of a day that has no automatic backup yet', () => {
    const yesterday = [backupAt(at(13, 18))]
    expect(automaticBackupDecision(facts({ backups: yesterday }))).toBe('DUE')
    expect(automaticBackupDecision(facts({ trigger: 'DAILY', backups: yesterday }))).toBe('DUE')
    expect(automaticBackupDecision(facts({}))).toBe('DUE')
  })

  it('is not due again on a day that already has one', () => {
    for (const trigger of ['LAUNCH', 'DAILY'] as const) {
      expect(automaticBackupDecision(facts({ trigger, backups: [backupAt(at(14, 0, 5))] }))).toBe(
        'DONE_TODAY'
      )
    }
  })

  it('waits an hour after the last backup, also across midnight', () => {
    const lateEvening = [backupAt(at(14, 23, 50))]
    expect(automaticBackupDecision(facts({ now: at(15, 0, 20), backups: lateEvening }))).toBe(
      'THROTTLED'
    )
    expect(automaticBackupDecision(facts({ now: at(15, 0, 50), backups: lateEvening }))).toBe('DUE')
  })

  it('makes a shutdown backup, even on a day that has one, unless the last is under an hour old', () => {
    const morning = [backupAt(at(14, 8, 30))]
    const shutdown = (now: Date): string =>
      automaticBackupDecision(facts({ trigger: 'SHUTDOWN', now, backups: morning }))
    expect(shutdown(at(14, 9, 0))).toBe('THROTTLED')
    expect(shutdown(at(14, 9, 30))).toBe('DUE')
    expect(shutdown(at(14, 18, 0))).toBe('DUE')
  })

  it('after a failure, waits an hour before the periodic check tries again; a launch and a quit always try', () => {
    const lastFailureAt = at(14, 8, 30)
    expect(automaticBackupDecision(facts({ trigger: 'DAILY', lastFailureAt }))).toBe('THROTTLED')
    expect(automaticBackupDecision(facts({ trigger: 'LAUNCH', lastFailureAt }))).toBe('DUE')
    expect(automaticBackupDecision(facts({ trigger: 'SHUTDOWN', lastFailureAt }))).toBe('DUE')
    expect(
      automaticBackupDecision(facts({ trigger: 'DAILY', lastFailureAt, now: at(14, 9, 31) }))
    ).toBe('DUE')
  })

  it('never lets a backup dated in the future (a changed clock) hold new backups back', () => {
    const future = [backupAt(at(16, 9))]
    expect(automaticBackupDecision(facts({ backups: future }))).toBe('DUE')
    expect(automaticBackupDecision(facts({ trigger: 'SHUTDOWN', backups: future }))).toBe('DUE')
  })
})

let temp: TempDir
let fixture: ServicesFixture
/** Makes the next backups fail after SQLite wrote the copy, as a full or removed disk would. */
let failBackups: boolean

async function setUp(options: FixtureOptions = {}): Promise<void> {
  failBackups = false
  fixture = await createServicesFixture(temp, {
    start: MORNING,
    faults: {
      afterBackupCopy: () => {
        if (failBackups) throw new Error('simulated disk failure')
      }
    },
    ...options
  })
}

beforeEach(async () => {
  temp = createTempDir()
  await setUp()
})

afterEach(() => {
  temp.remove()
})

function autoFolder(): string {
  return backupFolder(fixture.ctx.paths, 'auto')
}

/** The .db files in backups\auto, oldest first. */
function autoBackups(): string[] {
  return existsSync(autoFolder())
    ? readdirSync(autoFolder())
        .filter((name) => name.endsWith('.db'))
        .sort()
    : []
}

function nameAt(time: Date): string {
  return formatBackupFileName(time, TEST_APP_VERSION, LATEST_SCHEMA_VERSION)
}

/** A stand-in earlier automatic backup (rotation reads names only). */
function earlierBackup(time: Date): string {
  mkdirSync(autoFolder(), { recursive: true })
  const name = formatBackupFileName(time, '1.0.0', 1)
  writeFileSync(win32.join(autoFolder(), name), 'earlier backup')
  return name
}

describe('AutomaticBackups.runIfDue', () => {
  it('makes a verified backup in backups\\auto at the first launch of the day', async () => {
    await expect(fixture.automatic.runIfDue('LAUNCH')).resolves.toBe('CREATED')
    expect(autoBackups()).toEqual([nameAt(MORNING)])
    expect(verifyDatabaseFile(win32.join(autoFolder(), nameAt(MORNING))).schemaVersion).toBe(
      LATEST_SCHEMA_VERSION
    )
    expect(fixture.ctx.log.entries).toContainEqual({
      level: 'INFO',
      message: '[backup] automatic backup made',
      context: { trigger: 'LAUNCH', file: nameAt(MORNING) }
    })
    expect(fixture.backups.status()).toMatchObject({
      health: 'OK',
      lastAutomatic: { fileName: nameAt(MORNING) }
    })
  })

  it('makes no second one the same day', async () => {
    await fixture.automatic.runIfDue('LAUNCH')
    fixture.clock.advance(3 * HOUR)
    await expect(fixture.automatic.runIfDue('DAILY')).resolves.toBe('NOT_DUE')
    await expect(fixture.automatic.runIfDue('LAUNCH')).resolves.toBe('NOT_DUE')
    expect(autoBackups()).toEqual([nameAt(MORNING)])
  })

  it("makes the new day's backup while StockFlow keeps running past midnight, an hour after the last", async () => {
    fixture.clock.set(at(14, 23, 30))
    await fixture.automatic.runIfDue('LAUNCH')
    fixture.clock.set(at(15, 0, 15))
    await expect(fixture.automatic.runIfDue('DAILY')).resolves.toBe('NOT_DUE')
    fixture.clock.set(at(15, 0, 31))
    await expect(fixture.automatic.runIfDue('DAILY')).resolves.toBe('CREATED')
    expect(autoBackups()).toEqual([nameAt(at(14, 23, 30)), nameAt(at(15, 0, 31))])
  })

  it('makes a shutdown backup when the last one is at least an hour old, and not otherwise', async () => {
    await fixture.automatic.runIfDue('LAUNCH')
    fixture.clock.advance(30 * MINUTE)
    await expect(fixture.automatic.runIfDue('SHUTDOWN')).resolves.toBe('NOT_DUE')
    expect(fixture.ctx.log.entries).toContainEqual({
      level: 'INFO',
      message: '[backup] no automatic backup at shutdown: the last one is less than an hour old'
    })
    fixture.clock.advance(30 * MINUTE)
    await expect(fixture.automatic.runIfDue('SHUTDOWN')).resolves.toBe('CREATED')
    expect(autoBackups()).toEqual([nameAt(MORNING), nameAt(at(14, 10))])
  })

  it('records a failure without throwing, keeps working, and never touches the existing backups', async () => {
    await fixture.automatic.runIfDue('LAUNCH')
    const kept = win32.join(autoFolder(), nameAt(MORNING))
    const hash = fileHash(kept)
    failBackups = true
    fixture.clock.set(at(15, 9))
    await expect(fixture.automatic.runIfDue('LAUNCH')).resolves.toBe('FAILED')
    expect(readdirSync(autoFolder()).sort()).toEqual([
      nameAt(MORNING),
      nameAt(MORNING).replace(/\.db$/, '.json')
    ])
    expect(fileHash(kept)).toBe(hash)
    expect(fixture.status.record.lastAutomaticFailure).toEqual({
      at: at(15, 9).toISOString(),
      trigger: 'LAUNCH',
      code: 'COPY_FAILED'
    })
    expect(fixture.ctx.log.entries).toContainEqual({
      level: 'WARN',
      message:
        '[backup] the automatic backup failed; StockFlow keeps working and tries again later',
      context: { trigger: 'LAUNCH', code: 'COPY_FAILED' }
    })
    expect(fixture.backups.status()).toMatchObject({
      health: 'FAILED',
      lastFailure: { message: backupFailureMessage('COPY_FAILED') }
    })
    expect(fixture.database.get()).toBe(fixture.db)
    expect(fixture.db.get('SELECT 1 AS alive')).toEqual({ alive: 1 })
  })

  it('shows the failure again after a restart, and clears it once a backup succeeds', async () => {
    failBackups = true
    await fixture.automatic.runIfDue('LAUNCH')
    const restarted = new BackupStatusStore(fixture.ctx.paths, fixture.ctx.log)
    expect(restarted.record.lastAutomaticFailure).toMatchObject({ code: 'COPY_FAILED' })
    failBackups = false
    fixture.clock.advance(30 * MINUTE)
    await expect(fixture.automatic.runIfDue('DAILY')).resolves.toBe('NOT_DUE')
    fixture.clock.advance(31 * MINUTE)
    await expect(fixture.automatic.runIfDue('DAILY')).resolves.toBe('CREATED')
    expect(fixture.status.record.lastAutomaticFailure).toBeNull()
    expect(
      new BackupStatusStore(fixture.ctx.paths, fixture.ctx.log).record.lastAutomaticFailure
    ).toBeNull()
    expect(fixture.backups.status().health).toBe('OK')
  })

  it('rotates backups\\auto (14 days, 12 months) only after a verified backup', async () => {
    const august = Array.from({ length: 16 }, (_, index) =>
      earlierBackup(new Date(2026, 7, index + 1, 12))
    )
    failBackups = true
    await expect(fixture.automatic.runIfDue('LAUNCH')).resolves.toBe('FAILED')
    expect(autoBackups()).toEqual([...august].sort())
    failBackups = false
    await expect(fixture.automatic.runIfDue('LAUNCH')).resolves.toBe('CREATED')
    const deleted = [august[1], august[2]]
    expect(autoBackups()).toEqual(
      [...august.filter((name) => !deleted.includes(name)), nameAt(MORNING)].sort()
    )
  })

  it('skips while another backup or a restore is running', async () => {
    let release!: () => void
    const running = fixture.lock.run(
      'MANUAL_BACKUP',
      () => new Promise<void>((resolve) => (release = resolve))
    )
    await expect(fixture.automatic.runIfDue('LAUNCH')).resolves.toBe('BUSY')
    release()
    await running
    expect(autoBackups()).toEqual([])
  })

  it('skips while the database belongs to a restore, and once StockFlow restarts', async () => {
    fixture.database.beginRestore()
    await expect(fixture.automatic.runIfDue('LAUNCH')).resolves.toBe('UNAVAILABLE')
    fixture.database.continueWith(fixture.db)
    fixture.database.restart(null)
    await expect(fixture.automatic.runIfDue('SHUTDOWN')).resolves.toBe('UNAVAILABLE')
    expect(autoBackups()).toEqual([])
  })
})

describe('AutomaticBackups.start and stop', () => {
  it('checks shortly after startup (LAUNCH), then every 15 minutes (DAILY)', async () => {
    fixture.automatic.start()
    const [launch, daily] = fixture.timers.scheduled
    expect([launch, daily]).toMatchObject([
      { kind: 'timeout', ms: AUTOMATIC_BACKUP_LAUNCH_DELAY_MS, cleared: false },
      { kind: 'interval', ms: AUTOMATIC_BACKUP_CHECK_INTERVAL_MS, cleared: false }
    ])
    launch.callback()
    await vi.waitFor(() => expect(autoBackups()).toEqual([nameAt(MORNING)]), { timeout: 5000 })
    await fixture.lock.whenIdle()
    fixture.clock.advance(15 * MINUTE)
    daily.callback()
    await fixture.lock.whenIdle()
    expect(autoBackups()).toEqual([nameAt(MORNING)])
    fixture.automatic.stop()
    expect(fixture.timers.scheduled.map((timer) => timer.cleared)).toEqual([true, true])
  })

  it('replaces the earlier timers when started again', () => {
    fixture.automatic.start()
    fixture.automatic.start()
    expect(fixture.timers.scheduled.map((timer) => timer.cleared)).toEqual([
      true,
      true,
      false,
      false
    ])
  })
})

describe('AutomaticBackups.runAtShutdown', () => {
  it('stops the checks, then makes the shutdown backup', async () => {
    fixture.automatic.start()
    await expect(fixture.automatic.runAtShutdown()).resolves.toBe('CREATED')
    expect(autoBackups()).toEqual([nameAt(MORNING)])
    expect(fixture.timers.scheduled.every((timer) => timer.cleared)).toBe(true)
  })

  it('first waits for a backup that is running', async () => {
    let release!: () => void
    const running = fixture.lock.run(
      'MANUAL_BACKUP',
      () => new Promise<void>((resolve) => (release = resolve))
    )
    let outcome: string | undefined
    const shutdown = fixture.automatic.runAtShutdown().then((value) => (outcome = value))
    await Promise.resolve()
    expect(outcome).toBeUndefined()
    release()
    await running
    await shutdown
    expect(outcome).toBe('CREATED')
  })

  it('never keeps StockFlow from quitting for longer than the timeout', async () => {
    await fixture.automatic.runIfDue('LAUNCH')
    let release!: () => void
    const running = fixture.lock.run(
      'MANUAL_BACKUP',
      () => new Promise<void>((resolve) => (release = resolve))
    )
    const shutdown = fixture.automatic.runAtShutdown()
    const timeout = fixture.timers.scheduled.find(
      (timer) => timer.ms === SHUTDOWN_BACKUP_TIMEOUT_MS
    )
    timeout?.callback()
    await expect(shutdown).resolves.toBe('TIMED_OUT')
    expect(fixture.ctx.log.entries).toContainEqual({
      level: 'WARN',
      message:
        '[backup] the shutdown backup is taking too long; StockFlow quits without waiting for it'
    })
    release()
    await running
    await fixture.lock.whenIdle()
  })

  it('makes no backup once StockFlow is restarting', async () => {
    fixture.database.restart(null)
    await expect(fixture.automatic.runAtShutdown()).resolves.toBe('UNAVAILABLE')
    expect(autoBackups()).toEqual([])
  })
})
