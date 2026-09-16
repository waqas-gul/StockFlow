import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { win32 } from 'node:path'
import { z } from 'zod'
import type { BackupStatus } from '@shared/types/backup'
import { backupFolder, toDisplayLocation, toDisplayPath, type DataPaths } from '../data-paths'
import type { BackupErrorCode } from '../db/backup'
import { parseBackupFileName, type BackupName } from '../db/backup-files'
import { errorCodeOf, type Logger } from '../logging'

/** Where the main process keeps what no backup file records: `<root>\backups\backup-status.json`. */
export const BACKUP_STATUS_FILE_NAME = 'backup-status.json'
const STATUS_FORMAT = 'stockflow-backup-status'
const MAX_STATUS_BYTES = 64 * 1024
const MAX_MESSAGE_CHARS = 500

/** What started an automatic backup: the first launch or use of a day (LAUNCH, DAILY), or a normal quit. */
export const AUTOMATIC_BACKUP_TRIGGERS = Object.freeze(['LAUNCH', 'DAILY', 'SHUTDOWN'] as const)
export type AutomaticBackupTrigger = (typeof AUTOMATIC_BACKUP_TRIGGERS)[number]

const Time = z.iso.datetime()
const FileName = z.string().min(1).max(260)

const StatusFileSchema = z.object({
  format: z.literal(STATUS_FORMAT),
  formatVersion: z.literal(1),
  lastManual: z
    .object({ at: Time, fileName: FileName, folder: z.string().min(1).max(1024) })
    .nullable(),
  lastAutomaticFailure: z
    .object({
      at: Time,
      trigger: z.enum(AUTOMATIC_BACKUP_TRIGGERS),
      code: z.string().min(1).max(64)
    })
    .nullable(),
  lastRestore: z
    .object({
      at: Time,
      fileName: FileName,
      restored: z.boolean(),
      message: z.string().max(MAX_MESSAGE_CHARS)
    })
    .nullable()
})

/** The remembered backup events. `lastManual.folder` is an absolute path: it never leaves the main process. */
export type BackupStatusRecord = Omit<z.output<typeof StatusFileSchema>, 'format' | 'formatVersion'>

const EMPTY_RECORD: BackupStatusRecord = Object.freeze({
  lastManual: null,
  lastAutomaticFailure: null,
  lastRestore: null
})

/**
 * Backup events that no backup file records: the last manual backup (it is wherever the user saved it), the last
 * automatic backup that failed (so the next launch still shows it), and the last restore. They are kept in a small
 * JSON file outside the database, so a restore does not roll them back. A missing or invalid file starts empty, and
 * writing it never throws: the events are also kept in memory while StockFlow runs.
 */
export class BackupStatusStore {
  readonly #file: string
  readonly #log: Logger
  #record: BackupStatusRecord

  constructor(paths: DataPaths, log: Logger) {
    this.#file = win32.join(paths.backupsDir, BACKUP_STATUS_FILE_NAME)
    this.#log = log
    this.#record = this.#read()
  }

  get record(): BackupStatusRecord {
    return this.#record
  }

  /** Changes some of the events and saves them (through a temporary file and a rename). */
  update(change: Partial<BackupStatusRecord>): void {
    const record = { ...this.#record, ...change }
    if (record.lastRestore !== null) {
      record.lastRestore = {
        ...record.lastRestore,
        message: record.lastRestore.message.slice(0, MAX_MESSAGE_CHARS)
      }
    }
    this.#record = record
    const tempFile = `${this.#file}.tmp`
    const content = { format: STATUS_FORMAT, formatVersion: 1, ...record }
    try {
      mkdirSync(win32.dirname(this.#file), { recursive: true })
      writeFileSync(tempFile, `${JSON.stringify(content, null, 2)}\n`, 'utf8')
      renameSync(tempFile, this.#file)
    } catch (error) {
      try {
        rmSync(tempFile, { force: true })
      } catch {
        // Nothing else to do: the next write replaces it.
      }
      this.#log.warn('[backup] the backup status file could not be written', {
        code: errorCodeOf(error)
      })
    }
  }

  #read(): BackupStatusRecord {
    let content: unknown
    try {
      if (statSync(this.#file).size > MAX_STATUS_BYTES) {
        throw new Error('The backup status file is too large.')
      }
      content = JSON.parse(readFileSync(this.#file, 'utf8'))
    } catch (error) {
      if (errorCodeOf(error) !== 'ENOENT') {
        this.#log.warn('[backup] the backup status file could not be read; it starts again', {
          code: errorCodeOf(error)
        })
      }
      return EMPTY_RECORD
    }
    const parsed = StatusFileSchema.safeParse(content)
    if (!parsed.success) {
      this.#log.warn('[backup] the backup status file is not valid; it starts again')
      return EMPTY_RECORD
    }
    const { lastManual, lastAutomaticFailure, lastRestore } = parsed.data
    return { lastManual, lastAutomaticFailure, lastRestore }
  }
}

/** The verified automatic backups in `<root>\backups\auto`, newest first. Only StockFlow backup names count. */
export function listAutomaticBackups(paths: DataPaths): BackupName[] {
  let fileNames: string[]
  try {
    fileNames = readdirSync(backupFolder(paths, 'auto'), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  return fileNames
    .map(parseBackupFileName)
    .filter((backup): backup is BackupName => backup !== null)
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
}

const FAILURE_MESSAGES: Readonly<Record<BackupErrorCode, string>> = {
  UNSAFE_DESTINATION:
    'Backups cannot be saved in this folder. Choose a folder outside the StockFlow data folder.',
  DESTINATION_UNAVAILABLE:
    'The backup folder could not be used. Check that the drive is connected, has free space and can be written to.',
  DESTINATION_EXISTS:
    'A file with this name already exists there. StockFlow never replaces a file: choose another name.',
  COPY_FAILED:
    'The backup could not be written. Check that the drive is connected and has free space.',
  VERIFICATION_FAILED:
    'The backup copy did not pass its check, so it was not kept. Run the integrity check in Settings.',
  FINALIZE_FAILED: 'The backup could not be saved under its name. Try again.'
}

const FAILURE_MESSAGE_BY_CODE = new Map<string, string>(Object.entries(FAILURE_MESSAGES))

/** What the user is told about a backup that failed with `code` (a BackupErrorCode, or null when unknown). */
export function backupFailureMessage(code: string | null): string {
  return FAILURE_MESSAGE_BY_CODE.get(code ?? '') ?? 'The backup could not be made. Try again.'
}

export interface BackupStatusSources {
  readonly paths: DataPaths
  readonly record: BackupStatusRecord
  /** A backup or a restore is running. */
  readonly busy: boolean
  /** Absolute AppData and profile folders, only to shorten the paths shown. */
  readonly appDataPath: string
  readonly homePath: string
}

/** The status shown in Settings → Backup & Restore and the top bar: file names and display paths only. */
export function describeBackupStatus(sources: BackupStatusSources): BackupStatus {
  const { paths, record, appDataPath, homePath } = sources
  const [newest] = listAutomaticBackups(paths)
  const failure = record.lastAutomaticFailure
  const manual = record.lastManual
  return {
    health: failure !== null ? 'FAILED' : newest !== undefined ? 'OK' : 'NONE',
    lastAutomatic:
      newest === undefined ? null : { at: newest.time.toISOString(), fileName: newest.fileName },
    lastFailure:
      failure === null ? null : { at: failure.at, message: backupFailureMessage(failure.code) },
    lastManual:
      manual === null
        ? null
        : {
            at: manual.at,
            fileName: manual.fileName,
            location: toDisplayLocation(manual.folder, appDataPath, homePath)
          },
    lastRestore: record.lastRestore,
    folder: toDisplayPath(backupFolder(paths, 'auto'), appDataPath),
    busy: sources.busy
  }
}
