// Test-only helpers for the Phase 4B service tests. Excluded from coverage and never imported by application code.
import { mkdirSync } from 'node:fs'
import { resolveDataPaths } from '../data-paths'
import { initializeDatabase } from '../db'
import type { Db, SqlParams } from '../db/adapter'
import type { DataSafetyFaults } from '../db/context'
import { TEST_TIME, testContext, type TempDir, type TestContext } from '../db/test-utils'
import { AutomaticBackups, type SchedulerTimers } from './auto-backup'
import { BackupStatusStore } from './backup-status'
import { BackupService, type BackupDialogs } from './backup.service'
import { LiveDatabase } from './live-database'
import { OperationLock } from './operation-lock'
import { RestoreService } from './restore.service'

/** `db`, except that the `failAt`-th write matching `pattern` throws, as a disk failure part-way through would. */
export function failingWrites(db: Db, pattern: RegExp, failAt = 1): Db {
  let seen = 0
  return new Proxy(db, {
    get(target, property) {
      if (property === 'run') {
        return (sql: string, params?: SqlParams) => {
          if (pattern.test(sql) && ++seen === failAt) throw new Error('simulated write failure')
          return target.run(sql, params)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

/** A clock that only moves when the test moves it. */
export interface TestClock {
  readonly read: () => Date
  set(time: Date): void
  advance(ms: number): void
}

export function testClock(start: Date = TEST_TIME): TestClock {
  let now = new Date(start)
  return {
    read: () => new Date(now),
    set: (time) => {
      now = new Date(time)
    },
    advance: (ms) => {
      now = new Date(now.getTime() + ms)
    }
  }
}

/** File dialogs that answer from queues and record where they were opened. An empty queue means Cancel. */
export interface FakeDialogs extends BackupDialogs {
  readonly saveRequests: string[]
  readonly openRequests: string[]
  readonly saveAnswers: Array<string | null>
  readonly openAnswers: Array<string | null>
}

export function fakeDialogs(): FakeDialogs {
  const dialogs: FakeDialogs = {
    saveRequests: [],
    openRequests: [],
    saveAnswers: [],
    openAnswers: [],
    chooseBackupFile: async (defaultPath) => {
      dialogs.saveRequests.push(defaultPath)
      return dialogs.saveAnswers.shift() ?? null
    },
    chooseRestoreFile: async (defaultFolder) => {
      dialogs.openRequests.push(defaultFolder)
      return dialogs.openAnswers.shift() ?? null
    }
  }
  return dialogs
}

export interface ScheduledTimer {
  readonly kind: 'timeout' | 'interval'
  readonly ms: number
  readonly callback: () => void
  cleared: boolean
}

/** Timers that never fire on their own: the test runs their callbacks. */
export interface ManualTimers extends SchedulerTimers {
  readonly scheduled: ScheduledTimer[]
}

export function manualTimers(): ManualTimers {
  const scheduled: ScheduledTimer[] = []
  const add = (kind: ScheduledTimer['kind'], callback: () => void, ms: number): ScheduledTimer => {
    const timer: ScheduledTimer = { kind, ms, callback, cleared: false }
    scheduled.push(timer)
    return timer
  }
  return {
    scheduled,
    setTimeout: (callback, ms) => add('timeout', callback, ms),
    setInterval: (callback, ms) => add('interval', callback, ms),
    clear: (handle) => {
      if (handle !== undefined) (handle as ScheduledTimer).cleared = true
    }
  }
}

export interface ServicesFixture {
  readonly ctx: TestContext
  readonly clock: TestClock
  /** The live connection handed to LiveDatabase. */
  readonly db: Db
  readonly database: LiveDatabase
  readonly lock: OperationLock
  readonly status: BackupStatusStore
  readonly dialogs: FakeDialogs
  readonly timers: ManualTimers
  /** Folders the backup service asked File Explorer to open. */
  readonly opened: string[]
  /** How many times a restart was requested. */
  readonly restarts: { count: number }
  readonly backups: BackupService
  readonly restore: RestoreService
  readonly automatic: AutomaticBackups
  /** The Documents folder the first Save dialog opens in. */
  readonly documentsDir: string
}

export interface FixtureOptions {
  readonly start?: Date
  readonly faults?: DataSafetyFaults
  /** Wraps the live connection (e.g. withFailingBackup). */
  readonly wrap?: (db: Db) => Db
  readonly appDataPath?: string
  readonly homePath?: string
  readonly createToken?: () => string
}

/**
 * The Phase 4B services around a new schema database, as src/main/index.ts wires them, with fake dialogs, timers and
 * restart, a memory logger and a clock the test controls. The StockFlow data root is `<temp>\StockFlow` (database in
 * `data\shop.db`), so the rest of `<temp>` can stand for a USB drive or the Documents folder.
 */
export async function createServicesFixture(
  temp: TempDir,
  options: FixtureOptions = {}
): Promise<ServicesFixture> {
  const clock = testClock(options.start)
  const ctx = testContext(temp, {
    paths: resolveDataPaths(temp.file('StockFlow')),
    now: clock.read,
    faults: options.faults
  })
  const raw = temp.track(await initializeDatabase(ctx))
  // The startup entries are not what the tests are about.
  ctx.log.entries.length = 0
  const db = options.wrap ? options.wrap(raw) : raw
  const database = new LiveDatabase(db)
  const lock = new OperationLock()
  const status = new BackupStatusStore(ctx.paths, ctx.log)
  const dialogs = fakeDialogs()
  const timers = manualTimers()
  const opened: string[] = []
  const restarts = { count: 0 }
  const documentsDir = temp.file('Documents')
  mkdirSync(documentsDir, { recursive: true })
  const backups = new BackupService({
    ctx,
    database,
    lock,
    status,
    dialogs,
    openFolder: async (folder) => {
      opened.push(folder)
    },
    documentsDir,
    appDataPath: options.appDataPath ?? 'C:\\Elsewhere\\AppData\\Roaming',
    homePath: options.homePath ?? 'C:\\Elsewhere'
  })
  const restore = new RestoreService({
    ctx,
    database,
    lock,
    status,
    dialogs,
    restart: () => {
      restarts.count++
    },
    createToken: options.createToken
  })
  const automatic = new AutomaticBackups({ ctx, database, lock, status, timers })
  return {
    ctx,
    clock,
    db,
    database,
    lock,
    status,
    dialogs,
    timers,
    opened,
    restarts,
    backups,
    restore,
    automatic,
    documentsDir
  }
}
