import type { Db } from '../db/adapter'
import { BackupError, createCategoryBackup } from '../db/backup'
import type { BackupName } from '../db/backup-files'
import type { DataSafetyContext } from '../db/context'
import {
  listAutomaticBackups,
  type AutomaticBackupTrigger,
  type BackupStatusStore
} from './backup-status'
import type { LiveDatabase } from './live-database'
import type { OperationLock } from './operation-lock'

/** Automatic backups are never made more than once an hour. */
export const AUTOMATIC_BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000
/** How often a running StockFlow checks whether the day needs its backup (the day can change while it runs). */
export const AUTOMATIC_BACKUP_CHECK_INTERVAL_MS = 15 * 60 * 1000
/** The first check, shortly after startup. */
export const AUTOMATIC_BACKUP_LAUNCH_DELAY_MS = 5 * 1000
/** Quitting waits at most this long for the shutdown backup. */
export const SHUTDOWN_BACKUP_TIMEOUT_MS = 60 * 1000

export type AutomaticBackupDecision = 'DUE' | 'DONE_TODAY' | 'THROTTLED'

export interface AutomaticBackupFacts {
  readonly trigger: AutomaticBackupTrigger
  readonly now: Date
  /** The verified automatic backups, newest first (their names hold the local time they were made). */
  readonly backups: readonly BackupName[]
  /** The last failed automatic backup, while none has succeeded since. */
  readonly lastFailureAt: Date | null
}

/**
 * Whether an automatic backup is due:
 * - LAUNCH and DAILY (the first launch or use of a day): when no automatic backup exists for today (local time);
 * - SHUTDOWN (a normal quit): always, within the hourly limit;
 * - never within an hour of the last automatic backup. After a failure, the periodic check also waits an hour
 *   before it tries again; a launch and a quit always try.
 * A backup dated in the future (the clock was changed) never holds new backups back.
 */
export function automaticBackupDecision(facts: AutomaticBackupFacts): AutomaticBackupDecision {
  const { trigger, now, backups } = facts
  if (trigger !== 'SHUTDOWN' && backups.some((backup) => backup.dayKey === localDayKey(now))) {
    return 'DONE_TODAY'
  }
  const last = backups.find((backup) => backup.time.getTime() <= now.getTime())
  if (last !== undefined && isWithinInterval(last.time, now)) return 'THROTTLED'
  if (
    trigger === 'DAILY' &&
    facts.lastFailureAt !== null &&
    isWithinInterval(facts.lastFailureAt, now)
  ) {
    return 'THROTTLED'
  }
  return 'DUE'
}

/** What an automatic backup check did. */
export type AutomaticBackupOutcome =
  'CREATED' | 'FAILED' | 'NOT_DUE' | 'BUSY' | 'UNAVAILABLE' | 'TIMED_OUT'

/** The timers of the checks; replaced in the tests. */
export interface SchedulerTimers {
  setTimeout(callback: () => void, ms: number): unknown
  setInterval(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const SYSTEM_TIMERS: SchedulerTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  setInterval: (callback, ms) => setInterval(callback, ms),
  // Node.js clears timeouts and intervals alike.
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface AutomaticBackupsDeps {
  readonly ctx: DataSafetyContext
  readonly database: LiveDatabase
  readonly lock: OperationLock
  readonly status: BackupStatusStore
  readonly timers?: SchedulerTimers
}

/**
 * Automatic backups (plan §20.2) made with the Phase 4A engine: a verified backup in `<root>\backups\auto`, then that
 * folder's rotation (14 daily, 12 monthly), which runs only after the new backup has passed verification.
 *
 * - The first launch or use of a day: checked shortly after startup, then every 15 minutes.
 * - A normal quit: runAtShutdown.
 * - Never more than one an hour.
 *
 * A failure never stops StockFlow: it is logged, remembered in the backup status (shown in Settings and the top bar,
 * also after a restart), and tried again later. Existing backups are never touched by a failure.
 */
export class AutomaticBackups {
  readonly #deps: AutomaticBackupsDeps
  readonly #timers: SchedulerTimers
  #handles: unknown[] = []

  constructor(deps: AutomaticBackupsDeps) {
    this.#deps = deps
    this.#timers = deps.timers ?? SYSTEM_TIMERS
  }

  /** Starts the checks: one shortly after startup (LAUNCH), then one every 15 minutes (DAILY). */
  start(): void {
    this.stop()
    const check = (trigger: AutomaticBackupTrigger) => (): void => {
      void this.runIfDue(trigger)
    }
    this.#handles = [
      this.#timers.setTimeout(check('LAUNCH'), AUTOMATIC_BACKUP_LAUNCH_DELAY_MS),
      this.#timers.setInterval(check('DAILY'), AUTOMATIC_BACKUP_CHECK_INTERVAL_MS)
    ]
  }

  /** Stops the checks. A backup already running finishes. */
  stop(): void {
    for (const handle of this.#handles.splice(0)) this.#timers.clear(handle)
  }

  /** Makes an automatic backup if one is due now. Never throws. */
  async runIfDue(trigger: AutomaticBackupTrigger): Promise<AutomaticBackupOutcome> {
    const { ctx, database, lock, status } = this.#deps
    if (lock.current !== null) return 'BUSY'
    let db: Db
    try {
      db = database.get()
    } catch {
      // A restore is running, or StockFlow is restarting or closing.
      return 'UNAVAILABLE'
    }
    const now = ctx.now()
    const failure = status.record.lastAutomaticFailure
    const decision = automaticBackupDecision({
      trigger,
      now,
      backups: listAutomaticBackups(ctx.paths),
      lastFailureAt: failure === null ? null : new Date(failure.at)
    })
    if (decision !== 'DUE') {
      if (trigger === 'SHUTDOWN') {
        ctx.log.info(
          '[backup] no automatic backup at shutdown: the last one is less than an hour old'
        )
      }
      return 'NOT_DUE'
    }
    return lock.run('AUTOMATIC_BACKUP', async () => {
      try {
        const backup = await createCategoryBackup(db, 'auto', ctx)
        status.update({ lastAutomaticFailure: null })
        ctx.log.info('[backup] automatic backup made', { trigger, file: backup.fileName })
        return 'CREATED'
      } catch (error) {
        const code = error instanceof BackupError ? error.code : 'UNEXPECTED'
        status.update({ lastAutomaticFailure: { at: now.toISOString(), trigger, code } })
        ctx.log.warn(
          '[backup] the automatic backup failed; StockFlow keeps working and tries again later',
          { trigger, code }
        )
        return 'FAILED'
      }
    })
  }

  /**
   * The backup of a normal quit: stops the checks, waits for a backup that is running, then makes one unless the
   * last is less than an hour old. Never throws, and quitting waits at most SHUTDOWN_BACKUP_TIMEOUT_MS.
   */
  async runAtShutdown(): Promise<AutomaticBackupOutcome> {
    this.stop()
    const { ctx, lock } = this.#deps
    let timer: unknown
    const timeout = new Promise<AutomaticBackupOutcome>((resolve) => {
      timer = this.#timers.setTimeout(() => resolve('TIMED_OUT'), SHUTDOWN_BACKUP_TIMEOUT_MS)
    })
    const attempt = lock.whenIdle().then(() => this.runIfDue('SHUTDOWN'))
    const outcome = await Promise.race([attempt, timeout])
    this.#timers.clear(timer)
    if (outcome === 'TIMED_OUT') {
      ctx.log.warn(
        '[backup] the shutdown backup is taking too long; StockFlow quits without waiting for it'
      )
    }
    return outcome
  }
}

function isWithinInterval(time: Date, now: Date): boolean {
  const elapsed = now.getTime() - time.getTime()
  return elapsed >= 0 && elapsed < AUTOMATIC_BACKUP_MIN_INTERVAL_MS
}

/** `YYYY-MM-DD` in local time, as in backup names. */
function localDayKey(time: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`
}
