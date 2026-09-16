import { win32 } from 'node:path'
import { backupFolder } from '../data-paths'
import { sqliteErrorCode } from '../db/adapter'
import { DatabaseOpenError } from '../db/connection'
import type { DataSafetyContext } from '../db/context'
import { MigrationError } from '../db/migrate'
import {
  RestoreError,
  restoreDatabase,
  validateRestoreCandidate,
  type RestoreOutcome,
  type RestoreSummary
} from '../db/restore'
import { SchemaChecksumMismatchError } from '../db/schema-upgrade'
import { DatabaseFileError } from '../db/verify'
import type { BackupStatusStore } from './backup-status'
import {
  fingerprintOf,
  restoredMessage,
  sameFingerprint,
  type Fingerprint
} from './restore.service'

/*
 * Recovery mode (plan §20.4): when normal startup refuses the database for a recoverable reason, the user can still
 * restore a backup, before any window or IPC exists. Everything happens in the main process with native dialogs:
 *
 *   StockFlow could not safely open its database.   [Restore Backup] [Exit]
 *
 * Restore Backup opens the Open dialog, validates the chosen file with validateRestoreCandidate, shows its summary and
 * asks for an explicit confirmation (a ticked box), then restores it with restoreDatabase (no open connection) and
 * StockFlow relaunches. It is the same engine as Settings → Backup & Restore: the candidate is validated before any
 * live file is touched, a damaged database is moved to the recovery folder (never called a backup), and a failed
 * restore puts the previous files back. A restore that fails after touching them relaunches StockFlow, which checks
 * the database again, instead of continuing with an uncertain state.
 */

/** Why normal startup refused the database, when a restore may help. */
export type StartupRecoveryReason =
  | 'DAMAGED'
  | 'INTEGRITY_CHECK_FAILED'
  | 'FOREIGN_KEY_CHECK_FAILED'
  | 'SCHEMA_CHECKSUM_MISMATCH'
  | 'INVALID_SCHEMA_VERSION'
  | 'NOT_STOCKFLOW'
  | 'CANNOT_OPEN_SAFELY'

/** A native message box. The text is plain and holds no folder path. */
export interface RecoveryMessage {
  readonly type: 'error' | 'warning' | 'info'
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly buttons: readonly string[]
  readonly defaultId: number
  /** The button that Esc or closing the box chooses. */
  readonly cancelId: number
  readonly checkboxLabel?: string
}

export interface RecoveryAnswer {
  readonly response: number
  readonly checkboxChecked: boolean
}

export interface RecoveryDialogs {
  showMessage(message: RecoveryMessage): Promise<RecoveryAnswer>
  /** The Open dialog of a restore, opened in `defaultFolder`. Null when the user cancels. */
  chooseRestoreFile(defaultFolder: string): Promise<string | null>
}

export interface StartupRecoveryDeps {
  readonly ctx: DataSafetyContext
  readonly dialogs: RecoveryDialogs
  readonly status: BackupStatusStore
  readonly reason: StartupRecoveryReason
  /** The log reference of the refused startup. */
  readonly ref: string
}

/** RELAUNCH: StockFlow restarts (app.relaunch, app.exit(0)). EXIT: the user chose to exit. */
export type StartupRecoveryOutcome = 'RELAUNCH' | 'EXIT'

const TITLE = 'Restore Backup'
const START_BUTTONS = ['Restore Backup', 'Exit'] as const
const CONFIRM_BUTTONS = ['Restore', 'Cancel'] as const
const MAX_CAUSE_DEPTH = 10

/**
 * The recovery reason of a startup failure, or null when recovery mode must not be offered: an application error
 * (such as an invalid migration list), a database made by a newer StockFlow (installing that version is the answer),
 * or a problem of the computer rather than of the database (a busy or locked file, a full disk, a folder that cannot
 * be created, a disk I/O error).
 */
export function startupRecoveryReason(error: unknown): StartupRecoveryReason | null {
  if (error instanceof SchemaChecksumMismatchError) return 'SCHEMA_CHECKSUM_MISMATCH'
  if (error instanceof MigrationError) {
    if (error.code === 'UNKNOWN_SCHEMA_VERSION') return 'INVALID_SCHEMA_VERSION'
    if (error.code === 'FOREIGN_KEY_CHECK_FAILED') return 'FOREIGN_KEY_CHECK_FAILED'
    if (error.code === 'INVALID_MIGRATIONS' || error.code === 'DATABASE_TOO_NEW') return null
  }
  if (error instanceof DatabaseOpenError && error.code === 'CONFIGURATION_FAILED') {
    return 'CANNOT_OPEN_SAFELY'
  }
  const damage = damageIn(error)
  if (damage !== null) return damage
  return error instanceof DatabaseOpenError ? 'NOT_STOCKFLOW' : null
}

/** SQLite corruption, or a failed integrity or foreign key check, anywhere in the error's cause chain. */
function damageIn(error: unknown): StartupRecoveryReason | null {
  let current = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const code = sqliteErrorCode(current)
    if (code === 'SQLITE_NOTADB' || code?.startsWith('SQLITE_CORRUPT')) return 'DAMAGED'
    if (current instanceof DatabaseFileError) {
      if (current.code === 'INTEGRITY_CHECK_FAILED') return 'INTEGRITY_CHECK_FAILED'
      if (current.code === 'FOREIGN_KEY_CHECK_FAILED') return 'FOREIGN_KEY_CHECK_FAILED'
    }
    current = current.cause
  }
  return null
}

/**
 * Recovery mode: offers Restore Backup or Exit until a restore was attempted or the user exits. Nothing is touched
 * until a validated backup is confirmed. Never opens a window and never serves IPC.
 */
export async function runStartupRecovery(
  deps: StartupRecoveryDeps
): Promise<StartupRecoveryOutcome> {
  const { ctx, dialogs, reason, ref } = deps
  ctx.log.warn('[recovery] normal startup was refused; recovery mode offers a restore', {
    reason,
    ref
  })
  for (;;) {
    const start = await dialogs.showMessage(startMessage(ref))
    if (start.response !== 0) {
      ctx.log.info('[recovery] the user chose to exit')
      return 'EXIT'
    }
    const file = await dialogs.chooseRestoreFile(backupFolder(ctx.paths, 'auto'))
    if (file === null) continue
    const checked = await validate(deps, file)
    if (checked === null || !(await confirm(dialogs, checked.summary))) continue
    // Taken before the checks, so a change while they ran counts too.
    const before = checked.fingerprint
    const now = fingerprintOf(file)
    if (before === null || now === null || !sameFingerprint(now, before)) {
      ctx.log.warn('[recovery] the chosen backup changed after it was checked')
      await showRejected(dialogs, 'The backup file changed after it was checked. Choose it again.')
      continue
    }
    const outcome = await restore(deps, file, checked.summary)
    if (outcome !== 'RETRY') return outcome
  }
}

interface CheckedBackup {
  readonly summary: RestoreSummary
  /** The file before it was checked. */
  readonly fingerprint: Fingerprint | null
}

/** Validates a private copy of the chosen file. Null (after telling the user why) when it cannot be restored. */
async function validate(deps: StartupRecoveryDeps, file: string): Promise<CheckedBackup | null> {
  const { ctx, dialogs } = deps
  const fingerprint = fingerprintOf(file)
  try {
    const summary = validateRestoreCandidate(file, ctx)
    ctx.log.info('[recovery] a backup was chosen and validated; waiting for confirmation', {
      file: summary.fileName,
      schema: summary.schemaVersion
    })
    return { summary, fingerprint }
  } catch (error) {
    const known = error instanceof RestoreError
    ctx.log.warn('[recovery] the chosen backup cannot be restored', {
      file: win32.basename(file),
      code: known ? error.code : 'UNEXPECTED'
    })
    if (!known) ctx.log.error('[recovery] the chosen backup could not be checked', error)
    await showRejected(dialogs, known ? error.message : 'The backup could not be checked.')
    return null
  }
}

/** The summary with an explicit confirmation: Restore with the box ticked. Restore without it asks again. */
async function confirm(dialogs: RecoveryDialogs, summary: RestoreSummary): Promise<boolean> {
  let reminder = false
  for (;;) {
    const answer = await dialogs.showMessage(confirmationMessage(summary, reminder))
    if (answer.response !== 0) return false
    if (answer.checkboxChecked) return true
    reminder = true
  }
}

async function restore(
  deps: StartupRecoveryDeps,
  file: string,
  summary: RestoreSummary
): Promise<StartupRecoveryOutcome | 'RETRY'> {
  const { ctx, dialogs } = deps
  let outcome: RestoreOutcome
  try {
    outcome = await restoreDatabase(null, file, ctx)
  } catch (error) {
    ctx.log.error('[recovery] the restore stopped unexpectedly; StockFlow restarts', error)
    return failed(deps, summary, 'The restore stopped unexpectedly.')
  }
  if (outcome.ok) {
    // The relaunched StockFlow opens the restored database itself.
    outcome.db.close()
    const message = restoredMessage(outcome)
    record(deps, summary, true, message)
    ctx.log.info('[recovery] the backup was restored; StockFlow restarts', {
      file: summary.fileName,
      path: outcome.path
    })
    await dialogs.showMessage({
      type: 'info',
      title: TITLE,
      message: 'The backup was restored.',
      detail: `${message} StockFlow restarts now.`,
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0
    })
    return 'RELAUNCH'
  }
  if (outcome.stage === 'VALIDATION') {
    // It failed its checks when copied again: nothing was touched.
    await showRejected(dialogs, outcome.error.message)
    return 'RETRY'
  }
  return failed(deps, summary, outcome.error.message)
}

/** A restore that failed after it started: the previous files were put back (or the next start does it). */
async function failed(
  deps: StartupRecoveryDeps,
  summary: RestoreSummary,
  message: string
): Promise<StartupRecoveryOutcome> {
  record(deps, summary, false, message)
  await deps.dialogs.showMessage({
    type: 'error',
    title: TITLE,
    message: 'The backup was not restored.',
    detail: `${message}\n\nStockFlow restarts and checks its database again.`,
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0
  })
  return 'RELAUNCH'
}

function record(
  deps: StartupRecoveryDeps,
  summary: RestoreSummary,
  restored: boolean,
  message: string
): void {
  deps.status.update({
    lastRestore: {
      at: deps.ctx.now().toISOString(),
      fileName: summary.fileName,
      restored,
      message
    }
  })
}

async function showRejected(dialogs: RecoveryDialogs, detail: string): Promise<void> {
  await dialogs.showMessage({
    type: 'warning',
    title: TITLE,
    message: 'This backup cannot be restored.',
    detail,
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0
  })
}

function startMessage(ref: string): RecoveryMessage {
  return {
    type: 'error',
    title: 'StockFlow',
    message: 'StockFlow could not safely open its database.',
    detail:
      'Your data has not been changed. You can restore a StockFlow backup, or exit.\n\n' +
      `Reference: ${ref} (the details are in the StockFlow log file).`,
    buttons: START_BUTTONS,
    defaultId: 0,
    cancelId: 1
  }
}

function confirmationMessage(summary: RestoreSummary, reminder: boolean): RecoveryMessage {
  const lines = [
    `Backup: ${summary.fileName}`,
    `Backup date: ${localDateTime(summary.backupCreatedAt)}`,
    ...(summary.appVersion === null ? [] : [`StockFlow version: ${summary.appVersion}`]),
    `Schema version: ${summary.schemaVersion}`,
    `Products: ${count(summary.counts.products)}`,
    `Customers: ${count(summary.counts.customers)}`,
    `Invoices: ${count(summary.counts.invoices)}`,
    '',
    ...(summary.needsMigration
      ? ['It is upgraded to this version of StockFlow after restoring.']
      : []),
    'StockFlow keeps a copy of the current database before replacing it.'
  ]
  return {
    type: 'warning',
    title: TITLE,
    message: 'Restoring will replace the current StockFlow data.',
    detail: `${reminder ? 'Tick the box to confirm the restore.\n\n' : ''}${lines.join('\n')}`,
    buttons: CONFIRM_BUTTONS,
    defaultId: 1,
    cancelId: 1,
    checkboxLabel: 'I understand that restoring replaces the current StockFlow data.'
  }
}

function count(value: number | null): string {
  return value === null ? 'not recorded' : value.toLocaleString('en-US')
}

/** `YYYY-MM-DD HH:MM` in local time, like the backup file names. */
function localDateTime(iso: string): string {
  const time = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ` +
    `${pad(time.getHours())}:${pad(time.getMinutes())}`
  )
}
