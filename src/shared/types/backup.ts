/** Whether automatic backups are working: the last one succeeded, the last attempt failed, or there is none yet. */
export type BackupHealth = 'OK' | 'FAILED' | 'NONE'

/** A backup that was made: when (ISO-8601 UTC) and its file name. */
export interface BackupEvent {
  readonly at: string
  readonly fileName: string
}

/** An automatic backup that failed. The message is safe to show. */
export interface BackupFailure {
  readonly at: string
  readonly message: string
}

/** A manual backup: `location` is its folder in display form (e.g. `E:\Backups` or `%USERPROFILE%\Documents`). */
export interface ManualBackupRecord extends BackupEvent {
  readonly location: string
}

/** The last restore: whether the backup was restored, and what the user was told. */
export interface RestoreRecord extends BackupEvent {
  readonly restored: boolean
  readonly message: string
}

/** What Settings → Backup & Restore and the top bar show about backups. File names and display paths only. */
export interface BackupStatus {
  readonly health: BackupHealth
  /** The newest verified automatic backup. */
  readonly lastAutomatic: BackupEvent | null
  /** The last failed automatic backup, while none has succeeded since. */
  readonly lastFailure: BackupFailure | null
  /** The last manual backup made with this installation, when known. */
  readonly lastManual: ManualBackupRecord | null
  /** The last restore, when known. */
  readonly lastRestore: RestoreRecord | null
  /** The automatic backup folder in display form, e.g. `%APPDATA%\StockFlow\backups\auto`. */
  readonly folder: string
  /** True while a backup or a restore is running. */
  readonly busy: boolean
}

export type ManualBackupResult =
  | { readonly status: 'CANCELLED' }
  | { readonly status: 'CREATED'; readonly backup: ManualBackupRecord }

/** What the restore confirmation shows about the chosen backup. No paths or business data. */
export interface RestoreCandidateSummary {
  readonly fileName: string
  /** When the backup was made, ISO-8601 UTC. */
  readonly backupCreatedAt: string
  readonly schemaVersion: number
  /** The StockFlow version that made it; null when unknown. */
  readonly appVersion: string | null
  /** Record counts; null for a table the backup does not have. */
  readonly products: number | null
  readonly customers: number | null
  readonly invoices: number | null
  readonly sizeBytes: number
  /** True when the backup is from an older schema: it is upgraded after it is restored. */
  readonly needsMigration: boolean
}

export type RestoreCandidateSelection =
  | { readonly status: 'CANCELLED' }
  | {
      readonly status: 'SELECTED'
      /** Confirms this one backup, once, within a few minutes. The main process keeps the file's path. */
      readonly token: string
      readonly summary: RestoreCandidateSummary
    }

/** The text the user types to confirm a restore. */
export const RESTORE_CONFIRMATION = 'RESTORE'

export interface RestoreRequest {
  readonly token: string
  readonly confirmation: typeof RESTORE_CONFIRMATION
}

/**
 * A restore that ran. StockFlow restarts a moment later: with the restored data, or, when `restored` is false, with
 * the previous data put back. A restore that changed nothing is reported as a failed call instead, and StockFlow
 * keeps running.
 */
export interface RestoreResult {
  readonly restored: boolean
  /** What happened, safe to show. */
  readonly message: string
}
