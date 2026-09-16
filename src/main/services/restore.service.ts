import { randomBytes, timingSafeEqual } from 'node:crypto'
import { statSync } from 'node:fs'
import { win32 } from 'node:path'
import {
  RESTORE_CONFIRMATION,
  type RestoreCandidateSelection,
  type RestoreCandidateSummary,
  type RestoreRequest,
  type RestoreResult
} from '@shared/types/backup'
import { backupFolder } from '../data-paths'
import type { Db } from '../db/adapter'
import type { DataSafetyContext } from '../db/context'
import {
  RestoreError,
  restoreDatabase,
  validateRestoreCandidate,
  type RestoreOutcome,
  type RestoreSummary
} from '../db/restore'
import { AppFailure } from '../errors'
import type { BackupDialogs } from './backup.service'
import type { BackupStatusStore } from './backup-status'
import type { LiveDatabase } from './live-database'
import type { OperationLock } from './operation-lock'

/** How long a chosen and validated backup can be confirmed. */
export const RESTORE_TOKEN_TTL_MS = 10 * 60 * 1000

const UNEXPECTED_FAILURE =
  'The restore stopped unexpectedly. StockFlow restarts to open your data safely.'

/** A chosen backup file as it was checked: a different size or modification time means it changed since. */
export interface Fingerprint {
  readonly size: number
  readonly modifiedMs: number
}

interface PendingRestore extends Fingerprint {
  readonly token: string
  /** The chosen file: its path never leaves the main process. */
  readonly file: string
  readonly summary: RestoreSummary
  readonly expiresAt: number
}

export interface RestoreServiceDeps {
  readonly ctx: DataSafetyContext
  readonly database: LiveDatabase
  readonly lock: OperationLock
  readonly status: BackupStatusStore
  readonly dialogs: BackupDialogs
  /** Relaunches StockFlow a moment later (app.relaunch, app.exit); the automatic backups are stopped first. */
  readonly restart: () => void
  /** Makes a new random token; replaced in the tests. */
  readonly createToken?: () => string
}

/**
 * Restore for Settings → Backup & Restore (plan §20.4), with the Phase 4A engine:
 *
 * 1. selectCandidate: the main process's Open dialog chooses the file, validateRestoreCandidate checks a private copy,
 *    and the renderer receives only a summary and a one-time token. The path stays here.
 * 2. restore: the renderer confirms with that token (and the typed confirmation). The token is used up by any
 *    restore request, expires after 10 minutes, and is bound to the file as it was checked.
 * 3. restoreDatabase restores it. Then StockFlow restarts, unless the restore stopped before it changed anything:
 *    the app then keeps running on its current database.
 */
export class RestoreService {
  readonly #deps: RestoreServiceDeps
  #pending: PendingRestore | null = null

  constructor(deps: RestoreServiceDeps) {
    this.#deps = deps
  }

  async selectCandidate(): Promise<RestoreCandidateSelection> {
    const { ctx, database, lock, dialogs } = this.#deps
    database.get()
    return lock.run('RESTORE', async () => {
      this.#pending = null
      const file = await dialogs.chooseRestoreFile(backupFolder(ctx.paths, 'auto'))
      if (file === null) return { status: 'CANCELLED' }
      const before = fingerprintOf(file)
      let summary: RestoreSummary
      try {
        summary = validateRestoreCandidate(file, ctx)
      } catch (error) {
        if (!(error instanceof RestoreError)) throw error
        ctx.log.warn('[restore] the chosen backup cannot be restored', {
          file: win32.basename(file),
          code: error.code
        })
        throw new AppFailure({ code: 'RESTORE_REJECTED', message: error.message })
      }
      const after = fingerprintOf(file)
      if (before === null || after === null || !sameFingerprint(before, after)) {
        throw rejected('The backup file changed while it was being checked. Choose it again.')
      }
      const token = (this.#deps.createToken ?? randomToken)()
      this.#pending = {
        token,
        file,
        summary,
        ...after,
        expiresAt: ctx.now().getTime() + RESTORE_TOKEN_TTL_MS
      }
      ctx.log.info('[restore] a backup was chosen and validated; waiting for confirmation', {
        file: summary.fileName,
        schema: summary.schemaVersion
      })
      return { status: 'SELECTED', token, summary: candidateSummary(summary) }
    })
  }

  async restore(request: RestoreRequest): Promise<RestoreResult> {
    const { database, lock } = this.#deps
    if (request.confirmation !== RESTORE_CONFIRMATION) {
      throw rejected('Type RESTORE to confirm the restore.')
    }
    database.get()
    // A backup that is running refuses the request without using up the confirmation.
    lock.assertIdle()
    const pending = this.#take(request.token)
    return lock.run('RESTORE', () => this.#restore(pending))
  }

  /** The pending restore confirmed by `token`. Any request uses the pending confirmation up. */
  #take(token: string): PendingRestore {
    const { ctx } = this.#deps
    const pending = this.#pending
    this.#pending = null
    if (pending === null || !sameToken(pending.token, token)) {
      return this.#refuse(
        'UNKNOWN_TOKEN',
        'This restore confirmation is not valid any more. Choose the backup again.'
      )
    }
    if (ctx.now().getTime() > pending.expiresAt) {
      return this.#refuse('EXPIRED', 'The confirmation took too long. Choose the backup again.')
    }
    const current = fingerprintOf(pending.file)
    if (current === null || !sameFingerprint(current, pending)) {
      return this.#refuse(
        'FILE_CHANGED',
        'The backup file changed or was removed after it was checked. Choose it again.'
      )
    }
    return pending
  }

  #refuse(reason: string, message: string): never {
    this.#deps.ctx.log.warn('[restore] a restore request was refused', { reason })
    throw rejected(message)
  }

  async #restore(pending: PendingRestore): Promise<RestoreResult> {
    const { ctx, database } = this.#deps
    const live = database.beginRestore()
    let outcome: RestoreOutcome
    try {
      outcome = await restoreDatabase(live, pending.file, ctx)
    } catch (error) {
      // The engine reports its failures in the outcome: a throw leaves the state of the database uncertain.
      ctx.log.error(
        '[restore] the restore stopped unexpectedly; StockFlow restarts to open the data safely',
        error
      )
      return this.#restart(null, pending, false, UNEXPECTED_FAILURE)
    }
    if (outcome.ok) return this.#restart(outcome.db, pending, true, restoredMessage(outcome))
    if (outcome.db === live && live.isOpen) {
      // It stopped before the current database was touched: StockFlow keeps running on it.
      database.continueWith(live)
      this.#record(pending, false, outcome.error.message)
      throw new AppFailure({ code: 'RESTORE_FAILED', message: outcome.error.message })
    }
    // The current database was moved and put back, or the next start puts it back: restart to open it safely.
    return this.#restart(outcome.db, pending, false, outcome.error.message)
  }

  #restart(
    db: Db | null,
    pending: PendingRestore,
    restored: boolean,
    message: string
  ): RestoreResult {
    this.#record(pending, restored, message)
    this.#deps.database.restart(db)
    this.#deps.ctx.log.info('[restore] StockFlow restarts', { restored })
    this.#deps.restart()
    return { restored, message }
  }

  #record(pending: PendingRestore, restored: boolean, message: string): void {
    this.#deps.status.update({
      lastRestore: {
        at: this.#deps.ctx.now().toISOString(),
        fileName: pending.summary.fileName,
        restored,
        message
      }
    })
  }
}

/** What the user is told (and backup-status.json records) about a completed restore. */
export function restoredMessage(outcome: Extract<RestoreOutcome, { ok: true }>): string {
  const parts = ['The backup was restored.']
  if (outcome.migration.applied.length > 0) {
    parts.push('It was upgraded to this version of StockFlow.')
  }
  if (outcome.path === 'HEALTHY') {
    parts.push('A safety backup of the previous data was saved first.')
  } else if (outcome.recoveryArtifact !== null) {
    parts.push(
      'The previous database was damaged, so it was kept unchanged in the recovery folder.'
    )
  }
  return parts.join(' ')
}

function candidateSummary(summary: RestoreSummary): RestoreCandidateSummary {
  return {
    fileName: summary.fileName,
    backupCreatedAt: summary.backupCreatedAt,
    schemaVersion: summary.schemaVersion,
    appVersion: summary.appVersion,
    products: summary.counts.products,
    customers: summary.counts.customers,
    invoices: summary.counts.invoices,
    sizeBytes: summary.sizeBytes,
    needsMigration: summary.needsMigration
  }
}

function rejected(message: string): AppFailure {
  return new AppFailure({ code: 'RESTORE_REJECTED', message })
}

export function fingerprintOf(file: string): Fingerprint | null {
  try {
    const stats = statSync(file)
    return stats.isFile() ? { size: stats.size, modifiedMs: stats.mtimeMs } : null
  } catch {
    return null
  }
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.size === b.size && a.modifiedMs === b.modifiedMs
}

function sameToken(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function randomToken(): string {
  return randomBytes(16).toString('hex')
}
