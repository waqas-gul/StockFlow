import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDataPaths } from '../data-paths'
import { initializeDatabase } from '../db'
import { openSqlite } from '../db/adapter'
import { createVerifiedBackup } from '../db/backup'
import { DatabaseOpenError, openDatabase, readUserVersion } from '../db/connection'
import { MigrationError, type Migration } from '../db/migrate'
import { migrations } from '../db/migrations'
import { initialMigration } from '../db/migrations/0001_initial'
import { restoreFilesOf } from '../db/restore'
import {
  TEST_TIME,
  corruptIndex,
  createTempDir,
  editDatabaseFile,
  fileHash,
  insertRow,
  testContext,
  thrown,
  type TempDir,
  type TestContext
} from '../db/test-utils'
import { DatabaseFileError } from '../db/verify'
import { BackupStatusStore } from './backup-status'
import { readSettings, updateSettings } from './settings.service'
import {
  runStartupRecovery,
  startupRecoveryReason,
  type RecoveryDialogs,
  type RecoveryMessage,
  type StartupRecoveryReason
} from './startup-recovery'

const OTHER_CHECKSUM = `sha256:${'e'.repeat(64)}`
const REF = 'E-TEST42'
const START_MESSAGE = 'StockFlow could not safely open its database.'

type Answer = { response: number; checkboxChecked?: boolean }

interface FakeRecoveryDialogs extends RecoveryDialogs {
  readonly shown: RecoveryMessage[]
  readonly openRequests: string[]
  /** Answers in order; a function runs when its dialog is shown. An empty queue answers Cancel (or Exit). */
  readonly answers: Array<Answer | ((message: RecoveryMessage) => Answer)>
  readonly files: Array<string | null>
}

function fakeRecoveryDialogs(): FakeRecoveryDialogs {
  const dialogs: FakeRecoveryDialogs = {
    shown: [],
    openRequests: [],
    answers: [],
    files: [],
    showMessage: async (message) => {
      dialogs.shown.push(message)
      const next = dialogs.answers.shift()
      const answer = typeof next === 'function' ? next(message) : next
      return {
        response: answer?.response ?? message.cancelId,
        checkboxChecked: answer?.checkboxChecked ?? false
      }
    },
    chooseRestoreFile: async (defaultFolder) => {
      dialogs.openRequests.push(defaultFolder)
      return dialogs.files.shift() ?? null
    }
  }
  return dialogs
}

const RESTORE: Answer = { response: 0 }
const EXIT: Answer = { response: 1 }
const OK: Answer = { response: 0 }
const CONFIRM: Answer = { response: 0, checkboxChecked: true }

let temp: TempDir
let ctx: TestContext
let dialogs: FakeRecoveryDialogs

beforeEach(() => {
  temp = createTempDir()
  ctx = testContext(temp, {
    paths: resolveDataPaths(temp.file('StockFlow')),
    now: () => TEST_TIME
  })
  dialogs = fakeRecoveryDialogs()
})

afterEach(() => {
  temp.remove()
})

/** The error normal startup refuses the database with. */
async function startupError(context: TestContext = ctx): Promise<unknown> {
  try {
    temp.track(await initializeDatabase(context)).close()
  } catch (error) {
    return error
  }
  throw new Error('Expected startup to refuse the database.')
}

/** A verified backup on a "USB drive" of a database named `business` with one product. */
async function makeBackup(business = 'Backup Shop', context: TestContext = ctx): Promise<string> {
  const source = testContext(temp, {
    paths: resolveDataPaths(temp.file(`source-${business.replace(/\W/g, '')}`)),
    now: () => TEST_TIME,
    migrations: context.migrations
  })
  const db = await initializeDatabase(source)
  try {
    updateSettings(db, { 'business.name': business })
    insertRow(db, 'products', { code: 'P-001', name: 'Tea 950g' })
    const backup = await createVerifiedBackup(db, temp.file('USB'), source)
    return backup.file
  } finally {
    db.close()
  }
}

/** A live database that normal startup refuses: its file is not a database at all. */
function damageLiveDatabase(): string {
  mkdirSync(ctx.paths.dataDir, { recursive: true })
  writeFileSync(ctx.paths.databaseFile, 'this is no longer a database '.repeat(200))
  return fileHash(ctx.paths.databaseFile)
}

async function recover(reason: StartupRecoveryReason = 'DAMAGED'): Promise<string> {
  return runStartupRecovery({
    ctx,
    dialogs,
    status: new BackupStatusStore(ctx.paths, ctx.log),
    reason,
    ref: REF
  })
}

function titles(): string[] {
  return dialogs.shown.map((message) => message.message)
}

function listing(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).sort() : []
}

/** Nothing of a restore was left in the data folder. */
function expectNoRestoreFiles(): void {
  const files = restoreFilesOf(ctx.paths.databaseFile)
  for (const file of Object.values(files)) expect(existsSync(file), file).toBe(false)
}

/** The driver's own SQLite error class, taken from a real failure (tests use the Db adapter, not the driver). */
const SqliteError = ((): new (message: string, code: string) => Error => {
  const db = openSqlite(':memory:')
  try {
    return (thrown(() => db.exec('THIS IS NOT SQL')) as Error).constructor as new (
      message: string,
      code: string
    ) => Error
  } finally {
    db.close()
  }
})()

function sqliteError(code: string): Error {
  return new SqliteError(`simulated ${code}`, code)
}

describe('startupRecoveryReason: recovery is offered only for a recoverable database condition', () => {
  it('offers it for a database file that is corrupt (not a database any more)', async () => {
    damageLiveDatabase()
    expect(startupRecoveryReason(await startupError())).toBe('DAMAGED')
  })

  it('offers it when an applied migration checksum does not match', async () => {
    const mismatched: Migration[] = [{ ...initialMigration, checksum: OTHER_CHECKSUM }]
    temp
      .track(
        await initializeDatabase(testContext(temp, { paths: ctx.paths, migrations: mismatched }))
      )
      .close()
    const error = await startupError()
    expect(error).toMatchObject({ code: 'SCHEMA_CHECKSUM_MISMATCH' })
    expect(startupRecoveryReason(error)).toBe('SCHEMA_CHECKSUM_MISMATCH')
  })

  it('offers it for a SQLite file of another program', async () => {
    mkdirSync(ctx.paths.dataDir, { recursive: true })
    const other = openSqlite(ctx.paths.databaseFile)
    other.exec('PRAGMA application_id = 42; CREATE TABLE notes (text TEXT)')
    other.close()
    expect(startupRecoveryReason(await startupError())).toBe('NOT_STOCKFLOW')
  })

  it('offers it for an invalid schema version', async () => {
    const db = openDatabase(ctx.paths.databaseFile)
    db.exec('PRAGMA user_version = -1')
    db.close()
    expect(startupRecoveryReason(await startupError())).toBe('INVALID_SCHEMA_VERSION')
  })

  it('offers it when the database fails integrity_check before a migration', async () => {
    const db = openDatabase(ctx.paths.databaseFile)
    db.exec(
      "CREATE TABLE probe (v TEXT) STRICT; CREATE INDEX idx_probe ON probe (v); INSERT INTO probe VALUES ('a'), ('b')"
    )
    db.close()
    corruptIndex(ctx.paths.databaseFile, 'idx_probe')
    const error = await startupError()
    expect(error).toMatchObject({ code: 'BACKUP_FAILED' })
    expect(startupRecoveryReason(error)).toBe('INTEGRITY_CHECK_FAILED')
  })

  it.each<[string, unknown, StartupRecoveryReason]>([
    ['a corrupt page', sqliteError('SQLITE_CORRUPT'), 'DAMAGED'],
    [
      'a migration that hit a corrupt index',
      new MigrationError('MIGRATION_FAILED', 'failed', {
        cause: sqliteError('SQLITE_CORRUPT_INDEX')
      }),
      'DAMAGED'
    ],
    [
      'foreign key violations that block a migration',
      new MigrationError('FOREIGN_KEY_CHECK_FAILED', 'violations', { version: 2 }),
      'FOREIGN_KEY_CHECK_FAILED'
    ],
    [
      'a pre-migration backup whose copy failed foreign_key_check',
      new MigrationError('BACKUP_FAILED', 'failed', {
        cause: new Error('verification', {
          cause: new DatabaseFileError('FOREIGN_KEY_CHECK_FAILED', 'violations')
        })
      }),
      'FOREIGN_KEY_CHECK_FAILED'
    ],
    [
      'connection settings that cannot be applied',
      new DatabaseOpenError('CONFIGURATION_FAILED', 'journal_mode'),
      'CANNOT_OPEN_SAFELY'
    ]
  ])('offers it for %s', (_label, error, reason) => {
    expect(startupRecoveryReason(error)).toBe(reason)
  })

  it('does not offer it for a database made by a newer StockFlow: installing that version is the answer', async () => {
    const db = openDatabase(ctx.paths.databaseFile)
    db.exec(`PRAGMA user_version = ${migrations.length + 1}`)
    db.close()
    const error = await startupError()
    expect(error).toMatchObject({ code: 'DATABASE_TOO_NEW' })
    expect(startupRecoveryReason(error)).toBeNull()
  })

  it('does not offer it for an application error such as an invalid migration list', async () => {
    const broken: Migration[] = [{ ...initialMigration, version: 2 }]
    const error = await startupError(testContext(temp, { paths: ctx.paths, migrations: broken }))
    expect(error).toMatchObject({ code: 'INVALID_MIGRATIONS' })
    expect(startupRecoveryReason(error)).toBeNull()
  })

  it.each<[string, unknown]>([
    ['a program error', new TypeError('x is not a function')],
    ['a plain error', new Error('something else')],
    ['a folder that cannot be created', Object.assign(new Error('EACCES'), { code: 'EACCES' })],
    ['a busy database', sqliteError('SQLITE_BUSY')],
    ['a file that cannot be opened', sqliteError('SQLITE_CANTOPEN')],
    ['a full disk', sqliteError('SQLITE_FULL')],
    ['a disk I/O error', sqliteError('SQLITE_IOERR')],
    [
      'a pre-migration backup that could not be written',
      new MigrationError('BACKUP_FAILED', 'failed', { cause: sqliteError('SQLITE_FULL') })
    ],
    ['a migration bug', new MigrationError('MIGRATION_FAILED', 'syntax error')],
    ['nothing', undefined],
    ['a string', 'SQLITE_CORRUPT']
  ])('does not offer it for %s', (_label, error) => {
    expect(startupRecoveryReason(error)).toBeNull()
  })

  it('stops following a cause chain that loops', () => {
    const first = new Error('first')
    const second = new Error('second', { cause: first })
    Object.defineProperty(first, 'cause', { value: second })
    expect(startupRecoveryReason(first)).toBeNull()
  })
})

describe('runStartupRecovery', () => {
  it('offers Restore Backup or Exit; Exit leaves every file as it was', async () => {
    const hash = damageLiveDatabase()
    dialogs.answers.push(EXIT)

    await expect(recover()).resolves.toBe('EXIT')

    expect(dialogs.shown).toEqual([
      {
        type: 'error',
        title: 'StockFlow',
        message: START_MESSAGE,
        detail:
          'Your data has not been changed. You can restore a StockFlow backup, or exit.\n\n' +
          `Reference: ${REF} (the details are in the StockFlow log file).`,
        buttons: ['Restore Backup', 'Exit'],
        defaultId: 0,
        cancelId: 1
      }
    ])
    expect(fileHash(ctx.paths.databaseFile)).toBe(hash)
    expect(listing(ctx.paths.dataDir)).toEqual(['shop.db'])
    expect(dialogs.openRequests).toEqual([])
  })

  it('restores a valid backup after its summary is confirmed, keeps the damaged database, and relaunches', async () => {
    const backup = await makeBackup()
    const hash = damageLiveDatabase()
    dialogs.files.push(backup)
    dialogs.answers.push(RESTORE, CONFIRM, OK)

    await expect(recover()).resolves.toBe('RELAUNCH')

    expect(dialogs.openRequests).toEqual([win32.join(ctx.paths.backupsDir, 'auto')])
    const confirmation = dialogs.shown[1]
    expect(confirmation).toEqual({
      type: 'warning',
      title: 'Restore Backup',
      message: 'Restoring will replace the current StockFlow data.',
      detail: [
        `Backup: ${win32.basename(backup)}`,
        'Backup date: 2026-09-14 15:30',
        'StockFlow version: 1.0.0-test',
        'Schema version: 1',
        'Products: 1',
        'Customers: 1',
        'Invoices: 0',
        '',
        'StockFlow keeps a copy of the current database before replacing it.'
      ].join('\n'),
      buttons: ['Restore', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      checkboxLabel: 'I understand that restoring replaces the current StockFlow data.'
    })
    expect(dialogs.shown[2]).toMatchObject({
      type: 'info',
      message: 'The backup was restored.',
      buttons: ['OK']
    })
    expect(dialogs.shown[2].detail).toContain('StockFlow restarts now.')

    // The relaunched StockFlow opens the restored database normally.
    const reopened = temp.track(await initializeDatabase(ctx))
    expect(readSettings(reopened)['business.name']).toBe('Backup Shop')
    expect(readUserVersion(reopened)).toBe(1)
    const [preserved, ...others] = listing(ctx.paths.recoveryDir)
    expect(others).toEqual([])
    expect(preserved).toMatch(/^damaged-live-db_.*\.db$/)
    expect(fileHash(win32.join(ctx.paths.recoveryDir, preserved))).toBe(hash)
    expect(new BackupStatusStore(ctx.paths, ctx.log).record.lastRestore).toMatchObject({
      fileName: win32.basename(backup),
      restored: true
    })
    expectNoRestoreFiles()
  })

  it('restores over a database refused for a checksum mismatch, keeping it in a verified pre-restore backup', async () => {
    const mismatched: Migration[] = [{ ...initialMigration, checksum: OTHER_CHECKSUM }]
    temp
      .track(
        await initializeDatabase(testContext(temp, { paths: ctx.paths, migrations: mismatched }))
      )
      .close()
    const reason = startupRecoveryReason(await startupError())
    const backup = await makeBackup()
    dialogs.files.push(backup)
    dialogs.answers.push(RESTORE, CONFIRM, OK)

    await expect(recover(reason ?? 'DAMAGED')).resolves.toBe('RELAUNCH')

    const reopened = temp.track(await initializeDatabase(ctx))
    expect(readSettings(reopened)['business.name']).toBe('Backup Shop')
    expect(listing(win32.join(ctx.paths.backupsDir, 'pre-restore'))).toHaveLength(2)
    expect(listing(ctx.paths.recoveryDir)).toEqual([])
  })

  it.each<[string, () => Promise<string>, string]>([
    [
      'a file that is not a database',
      async () => {
        mkdirSync(temp.file('USB'), { recursive: true })
        writeFileSync(temp.file('USB\\photo.db'), 'not a database')
        return temp.file('USB\\photo.db')
      },
      'This file is not a StockFlow backup.'
    ],
    [
      'a backup from a newer schema',
      async () => {
        const backup = await makeBackup()
        editDatabaseFile(backup, `PRAGMA user_version = ${migrations.length + 1}`)
        return backup
      },
      'This backup was created by a newer version of StockFlow. Install the newer application version before restoring it.'
    ],
    [
      'a backup whose own migration checksum does not match',
      async () =>
        makeBackup(
          'Mismatched',
          testContext(temp, { migrations: [{ ...initialMigration, checksum: OTHER_CHECKSUM }] })
        ),
      'The schema of this backup could not be verified by this version of StockFlow, so it cannot be restored. ' +
        'Choose another backup or contact support.'
    ]
  ])(
    'rejects %s before any live file is touched, then offers the choice again',
    async (_label, make, reason) => {
      const candidate = await make()
      const hash = damageLiveDatabase()
      dialogs.files.push(candidate)
      dialogs.answers.push(RESTORE, OK, EXIT)

      await expect(recover()).resolves.toBe('EXIT')

      expect(titles()).toEqual([START_MESSAGE, 'This backup cannot be restored.', START_MESSAGE])
      expect(dialogs.shown[1]).toMatchObject({ type: 'warning', detail: reason, buttons: ['OK'] })
      expect(fileHash(ctx.paths.databaseFile)).toBe(hash)
      expect(listing(ctx.paths.dataDir)).toEqual(['shop.db'])
      expect(existsSync(ctx.paths.recoveryDir)).toBe(false)
    }
  )

  it('goes back to the first choice when the Open dialog is cancelled', async () => {
    damageLiveDatabase()
    dialogs.files.push(null)
    dialogs.answers.push(RESTORE, EXIT)

    await expect(recover()).resolves.toBe('EXIT')
    expect(titles()).toEqual([START_MESSAGE, START_MESSAGE])
  })

  it('restores nothing when the confirmation is cancelled, or given without ticking the box', async () => {
    const backup = await makeBackup()
    const hash = damageLiveDatabase()
    dialogs.files.push(backup, backup)
    dialogs.answers.push(RESTORE, { response: 1, checkboxChecked: true }, RESTORE, RESTORE)

    await expect(recover()).resolves.toBe('EXIT')

    expect(titles()).toEqual([
      START_MESSAGE,
      'Restoring will replace the current StockFlow data.',
      START_MESSAGE,
      'Restoring will replace the current StockFlow data.',
      'Restoring will replace the current StockFlow data.',
      START_MESSAGE
    ])
    expect(dialogs.shown[4].detail).toMatch(/^Tick the box to confirm the restore\.\n\n/)
    expect(fileHash(ctx.paths.databaseFile)).toBe(hash)
    expect(existsSync(ctx.paths.recoveryDir)).toBe(false)
  })

  it('refuses a backup that changed after it was checked', async () => {
    const backup = await makeBackup()
    const hash = damageLiveDatabase()
    dialogs.files.push(backup)
    dialogs.answers.push(
      RESTORE,
      () => {
        writeFileSync(backup, 'replaced while the confirmation was open')
        return CONFIRM
      },
      OK,
      EXIT
    )

    await expect(recover()).resolves.toBe('EXIT')

    expect(dialogs.shown[2]).toMatchObject({
      message: 'This backup cannot be restored.',
      detail: 'The backup file changed after it was checked. Choose it again.'
    })
    expect(fileHash(ctx.paths.databaseFile)).toBe(hash)
    expect(existsSync(ctx.paths.recoveryDir)).toBe(false)
  })

  it('puts the damaged database back when the restore fails after moving it, and relaunches to check again', async () => {
    const backup = await makeBackup()
    const hash = damageLiveDatabase()
    ctx = {
      ...ctx,
      faults: {
        beforeRestoreInstall: () => {
          throw new Error('simulated failure while installing the backup')
        }
      }
    }
    dialogs.files.push(backup)
    dialogs.answers.push(RESTORE, CONFIRM, OK)

    await expect(recover()).resolves.toBe('RELAUNCH')

    expect(dialogs.shown[2]).toEqual({
      type: 'error',
      title: 'Restore Backup',
      message: 'The backup was not restored.',
      detail:
        'The backup could not be put in place. The previous data was kept.\n\n' +
        'StockFlow restarts and checks its database again.',
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0
    })
    expect(fileHash(ctx.paths.databaseFile)).toBe(hash)
    expectNoRestoreFiles()
    expect(new BackupStatusStore(ctx.paths, ctx.log).record.lastRestore).toMatchObject({
      restored: false,
      message: 'The backup could not be put in place. The previous data was kept.'
    })
  })

  it('relaunches when the restore stops unexpectedly, so the next start checks the database again', async () => {
    const backup = await makeBackup()
    damageLiveDatabase()
    const log = ctx.log
    ctx = {
      ...ctx,
      log: {
        ...log,
        entries: log.entries,
        info: (message, context) => {
          if (message === '[restore] started') throw new Error('simulated unexpected failure')
          log.info(message, context)
        }
      }
    }
    dialogs.files.push(backup)
    dialogs.answers.push(RESTORE, CONFIRM, OK)

    await expect(recover()).resolves.toBe('RELAUNCH')

    expect(dialogs.shown[2]).toMatchObject({
      type: 'error',
      message: 'The backup was not restored.',
      detail:
        'The restore stopped unexpectedly.\n\nStockFlow restarts and checks its database again.'
    })
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        message: '[recovery] the restore stopped unexpectedly; StockFlow restarts'
      })
    )
  })

  it('logs the steps with file names only, never a folder', async () => {
    const backup = await makeBackup()
    damageLiveDatabase()
    dialogs.files.push(backup)
    dialogs.answers.push(RESTORE, CONFIRM, OK)

    await recover()

    const logged = JSON.stringify(
      ctx.log.entries.map(({ message, context }) => ({ message, context }))
    )
    expect(logged).not.toContain(temp.path.replace(/\\/g, '\\\\'))
    expect(ctx.log.entries.map((entry) => entry.message)).toEqual(
      expect.arrayContaining([
        '[recovery] normal startup was refused; recovery mode offers a restore',
        '[recovery] a backup was chosen and validated; waiting for confirmation',
        '[recovery] the backup was restored; StockFlow restarts'
      ])
    )
  })
})
