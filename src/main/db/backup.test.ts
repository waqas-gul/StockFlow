import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupFolder, type BackupCategory } from '../data-paths'
import { openSqlite, type Db } from './adapter'
import {
  BackupError,
  SIDECAR_FORMAT,
  createCategoryBackup,
  createVerifiedBackup,
  ensureBackupFolders,
  readSidecar,
  type BackupErrorCode
} from './backup'
import { formatBackupFileName, sidecarFileOf } from './backup-files'
import { STOCKFLOW_APPLICATION_ID, readApplicationId, readUserVersion } from './connection'
import {
  LATEST_SCHEMA_VERSION,
  TEST_APP_VERSION,
  TEST_TIME,
  createSchemaDatabase,
  createTempDir,
  editDatabaseFile,
  fileHash,
  holdOpen,
  insertRow,
  replaceFolderWithFile,
  testContext,
  violateCheckConstraint,
  withFailingBackup,
  type TempDir,
  type TestContext
} from './test-utils'
import { DatabaseFileError, verifyDatabaseFile } from './verify'

const EXPECTED_NAME = `stockflow-backup_2026-09-14_153045_v1.0.0-test_s${LATEST_SCHEMA_VERSION}.db`
const EXPECTED_SIDECAR = `stockflow-backup_2026-09-14_153045_v1.0.0-test_s${LATEST_SCHEMA_VERSION}.json`
const EARLIER = new Date(2026, 8, 13, 9, 0, 0)

let temp: TempDir
let ctx: TestContext
let db: Db

beforeEach(async () => {
  temp = createTempDir()
  ctx = testContext(temp, { now: () => TEST_TIME })
  db = await createSchemaDatabase(temp)
})

afterEach(() => {
  temp.remove()
})

function folder(category: BackupCategory = 'auto'): string {
  return backupFolder(ctx.paths, category)
}

function listing(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).sort() : []
}

async function backupError(attempt: Promise<unknown>): Promise<BackupError> {
  const error = await attempt.then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(BackupError)
  return error as BackupError
}

/** A valid backup made the day before, to prove that failures never touch existing backups. */
async function earlierBackup(): Promise<{ file: string; hash: string; names: string[] }> {
  const earlier = await createVerifiedBackup(
    db,
    folder(),
    testContext(temp, { now: () => EARLIER })
  )
  return { file: earlier.file, hash: fileHash(earlier.file), names: listing(folder()) }
}

/** A stand-in for an older backup file (rotation reads names only). */
function oldBackup(category: BackupCategory, time: Date): string {
  mkdirSync(folder(category), { recursive: true })
  const file = win32.join(folder(category), formatBackupFileName(time, '1.0.0', 1))
  writeFileSync(file, 'older backup')
  writeFileSync(sidecarFileOf(file), '{}')
  return win32.basename(file)
}

describe('createVerifiedBackup', () => {
  it('copies the committed data, including data still in the WAL, while the source stays open', async () => {
    insertRow(db, 'companies', { name: 'In the WAL' })
    expect(statSync(`${ctx.paths.databaseFile}-wal`).size).toBeGreaterThan(0)
    const backup = await createVerifiedBackup(db, folder(), ctx)
    insertRow(db, 'companies', { name: 'After the backup' })
    expect(db.all('SELECT name FROM companies ORDER BY id')).toEqual([
      { name: 'In the WAL' },
      { name: 'After the backup' }
    ])
    const copy = temp.track(openSqlite(backup.file, { readonly: true }))
    expect(copy.all('SELECT name FROM companies')).toEqual([{ name: 'In the WAL' }])
  })

  it('writes one self-contained, verified file with application_id and user_version preserved', async () => {
    const backup = await createVerifiedBackup(db, folder(), ctx)
    expect(listing(folder())).toEqual([EXPECTED_NAME, EXPECTED_SIDECAR])
    const bytes = readFileSync(backup.file)
    expect([bytes[18], bytes[19]]).toEqual([1, 1])
    const copy = temp.track(openSqlite(backup.file, { readonly: true }))
    expect(readApplicationId(copy)).toBe(STOCKFLOW_APPLICATION_ID)
    expect(readUserVersion(copy)).toBe(LATEST_SCHEMA_VERSION)
    expect(copy.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(copy.all('PRAGMA foreign_key_check')).toEqual([])
  })

  it('names the file by local time, app version and schema version, and returns safe summary information', async () => {
    const backup = await createVerifiedBackup(db, folder(), ctx)
    const file = win32.join(folder(), EXPECTED_NAME)
    expect(backup).toEqual({
      file,
      fileName: EXPECTED_NAME,
      createdAt: TEST_TIME.toISOString(),
      appVersion: TEST_APP_VERSION,
      schemaVersion: LATEST_SCHEMA_VERSION,
      sqliteVersion: expect.stringMatching(/^3\.\d+\.\d+$/),
      applicationId: STOCKFLOW_APPLICATION_ID,
      sizeBytes: statSync(file).size,
      counts: { products: 0, customers: 1, invoices: 0 },
      sidecarWritten: true
    })
    expect(ctx.log.entries).toEqual([
      {
        level: 'INFO',
        message: '[backup] verified backup created',
        context: {
          file: EXPECTED_NAME,
          schema: LATEST_SCHEMA_VERSION,
          bytes: backup.sizeBytes,
          ms: expect.any(Number),
          sidecar: true
        }
      }
    ])
  })

  it('writes a JSON sidecar with safe summary metadata only', async () => {
    insertRow(db, 'customers', { code: 'C-00002', name: 'Ali Traders', phone: '0300-1234567' })
    const backup = await createVerifiedBackup(db, folder(), ctx)
    const text = readFileSync(sidecarFileOf(backup.file), 'utf8')
    expect(JSON.parse(text)).toEqual({
      format: SIDECAR_FORMAT,
      formatVersion: 1,
      backupFile: EXPECTED_NAME,
      backupCreatedAt: TEST_TIME.toISOString(),
      appVersion: TEST_APP_VERSION,
      schemaVersion: LATEST_SCHEMA_VERSION,
      sqliteVersion: backup.sqliteVersion,
      applicationId: STOCKFLOW_APPLICATION_ID,
      sizeBytes: backup.sizeBytes,
      counts: { products: 0, customers: 2, invoices: 0 }
    })
    expect(text).not.toMatch(/Ali|0300|Walk-in|\\/)
  })

  it('never overwrites a backup: another backup in the same second gets the next free name', async () => {
    const first = await createVerifiedBackup(db, folder(), ctx)
    const hash = fileHash(first.file)
    const second = await createVerifiedBackup(db, folder(), ctx)
    expect(second.fileName).toBe(EXPECTED_NAME.replace(/\.db$/, '_2.db'))
    expect(fileHash(first.file)).toBe(hash)
  })

  it('keeps the backup valid when its optional sidecar cannot be written', async () => {
    mkdirSync(win32.join(folder(), EXPECTED_SIDECAR), { recursive: true })
    const backup = await createVerifiedBackup(db, folder(), ctx)
    expect(backup.sidecarWritten).toBe(false)
    expect(verifyDatabaseFile(backup.file).schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(listing(folder())).toEqual([EXPECTED_NAME, EXPECTED_SIDECAR])
    expect(ctx.log.entries).toContainEqual({
      level: 'WARN',
      message: '[backup] the sidecar could not be written; the backup itself is valid',
      context: { file: EXPECTED_NAME, code: 'EPERM' }
    })
  })

  it('creates a missing backup folder', async () => {
    const elsewhere = temp.file('elsewhere\\backups')
    expect(existsSync(elsewhere)).toBe(false)
    await createVerifiedBackup(db, elsewhere, ctx)
    expect(listing(elsewhere)).toEqual([EXPECTED_NAME, EXPECTED_SIDECAR])
  })

  it('refuses to write into the data folder, beside the live database', async () => {
    for (const directory of [ctx.paths.dataDir, win32.join(ctx.paths.dataDir, 'copies')]) {
      expect((await backupError(createVerifiedBackup(db, directory, ctx))).code).toBe(
        'UNSAFE_DESTINATION'
      )
    }
    expect(listing(ctx.paths.dataDir)).toEqual(['shop.db', 'shop.db-shm', 'shop.db-wal'])
  })
})

describe('createVerifiedBackup: failure injection', () => {
  /** The failure is typed and logged; no backup or temporary file is left; the earlier backup is untouched. */
  async function expectCleanFailure(
    attempt: Promise<unknown>,
    code: BackupErrorCode,
    earlier: { file: string; hash: string; names: string[] }
  ): Promise<BackupError> {
    const error = await backupError(attempt)
    expect(error.code).toBe(code)
    expect(listing(folder())).toEqual(earlier.names)
    expect(fileHash(earlier.file)).toBe(earlier.hash)
    expect(ctx.log.entries).toContainEqual({
      level: 'ERROR',
      message: '[backup] the backup failed; existing backups were not touched',
      error,
      context: { code }
    })
    return error
  }

  function failingContext(faults: TestContext['faults']): TestContext {
    ctx = testContext(temp, { now: () => TEST_TIME, faults })
    return ctx
  }

  it('fails with DESTINATION_UNAVAILABLE when the backup folder cannot be created', async () => {
    replaceFolderWithFile(folder('pre-migration'))
    const error = await backupError(createVerifiedBackup(db, folder('pre-migration'), ctx))
    expect(error.code).toBe('DESTINATION_UNAVAILABLE')
    expect(listing(ctx.paths.backupsDir)).toEqual(['auto', 'pre-migration', 'pre-restore'])
    expect(listing(folder('auto'))).toEqual([])
  })

  it('fails with COPY_FAILED when the SQLite online backup fails', async () => {
    const earlier = await earlierBackup()
    const cause = new Error('simulated backup failure')
    const error = await expectCleanFailure(
      createVerifiedBackup(withFailingBackup(db, cause), folder(), ctx),
      'COPY_FAILED',
      earlier
    )
    expect(error.cause).toBe(cause)
  })

  it('fails with VERIFICATION_FAILED when the copy is not a StockFlow database', async () => {
    const earlier = await earlierBackup()
    const run = failingContext({
      afterBackupCopy: (tempFile) => editDatabaseFile(tempFile, 'PRAGMA application_id = 0')
    })
    const error = await expectCleanFailure(
      createVerifiedBackup(db, folder(), run),
      'VERIFICATION_FAILED',
      earlier
    )
    expect(error.cause).toMatchObject({ code: 'NOT_STOCKFLOW' })
  })

  it('fails with VERIFICATION_FAILED when integrity_check fails', async () => {
    const earlier = await earlierBackup()
    const run = failingContext({ afterBackupCopy: (tempFile) => violateCheckConstraint(tempFile) })
    const error = await expectCleanFailure(
      createVerifiedBackup(db, folder(), run),
      'VERIFICATION_FAILED',
      earlier
    )
    expect(error.cause).toBeInstanceOf(DatabaseFileError)
    expect(error.cause).toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' })
  })

  it('fails with VERIFICATION_FAILED when foreign_key_check finds violations', async () => {
    const earlier = await earlierBackup()
    const run = failingContext({
      afterBackupCopy: (tempFile) =>
        editDatabaseFile(
          tempFile,
          "INSERT INTO product_units (product_id, name, base_qty, is_base) VALUES (999, 'Orphan', 1, 1)"
        )
    })
    const error = await expectCleanFailure(
      createVerifiedBackup(db, folder(), run),
      'VERIFICATION_FAILED',
      earlier
    )
    expect(error.cause).toMatchObject({ code: 'FOREIGN_KEY_CHECK_FAILED' })
  })

  it('fails with FINALIZE_FAILED, never overwriting, when the final name is taken meanwhile', async () => {
    const earlier = await earlierBackup()
    const run = failingContext({
      beforeBackupFinalize: (_tempFile, finalFile) => writeFileSync(finalFile, 'someone else')
    })
    const error = await backupError(createVerifiedBackup(db, folder(), run))
    expect(error.code).toBe('FINALIZE_FAILED')
    expect(readFileSync(win32.join(folder(), EXPECTED_NAME), 'utf8')).toBe('someone else')
    expect(listing(folder())).toEqual([...earlier.names, EXPECTED_NAME].sort())
    expect(fileHash(earlier.file)).toBe(earlier.hash)
  })

  it('fails with FINALIZE_FAILED when the rename itself fails, and logs a temporary file it cannot remove', async () => {
    const earlier = await earlierBackup()
    let holder: Db | undefined
    const run = failingContext({
      beforeBackupFinalize: (tempFile) => {
        holder = holdOpen(temp, tempFile)
      }
    })
    const error = await backupError(createVerifiedBackup(db, folder(), run))
    expect(error.code).toBe('FINALIZE_FAILED')
    expect(error.cause).toMatchObject({ code: 'EBUSY' })
    holder?.close()
    expect(listing(folder())).toEqual([...earlier.names, `${EXPECTED_NAME}.tmp`].sort())
    expect(fileHash(earlier.file)).toBe(earlier.hash)
    expect(ctx.log.entries).toContainEqual({
      level: 'WARN',
      message: '[backup] a temporary backup file could not be removed',
      context: { file: `${EXPECTED_NAME}.tmp`, code: 'EBUSY' }
    })
  })

  it('wraps an unexpected failure as COPY_FAILED and still cleans up', async () => {
    const earlier = await earlierBackup()
    const run = failingContext({
      afterBackupCopy: () => {
        throw new Error('unexpected')
      }
    })
    const error = await expectCleanFailure(
      createVerifiedBackup(db, folder(), run),
      'COPY_FAILED',
      earlier
    )
    expect(error.message).toMatch(/unexpected/)
  })

  it('reports a thrown value that is not an Error', async () => {
    const run = failingContext({
      afterBackupCopy: () => {
        throw 'plain text failure'
      }
    })
    const error = await backupError(createVerifiedBackup(db, folder(), run))
    expect(error).toMatchObject({
      code: 'COPY_FAILED',
      message: 'The backup failed: plain text failure'
    })
  })

  it('fails with DESTINATION_UNAVAILABLE when every name for that second is taken', async () => {
    for (let sequence = 1; sequence <= 99; sequence++) {
      writeFileSync(
        win32.join(
          folder(),
          formatBackupFileName(TEST_TIME, TEST_APP_VERSION, LATEST_SCHEMA_VERSION, sequence)
        ),
        'taken'
      )
    }
    const error = await backupError(createVerifiedBackup(db, folder(), ctx))
    expect(error).toMatchObject({
      code: 'DESTINATION_UNAVAILABLE',
      message: 'Too many backups were started in the same second.'
    })
  })
})

describe('createCategoryBackup', () => {
  it('backs up into the category folder, then keeps only the last 5 pre-migration backups', async () => {
    const old = [1, 2, 3, 4, 5, 6].map((day) => oldBackup('pre-migration', new Date(2026, 7, day)))
    const backup = await createCategoryBackup(db, 'pre-migration', ctx)
    expect(backup.file).toBe(win32.join(folder('pre-migration'), EXPECTED_NAME))
    const kept = [...old.slice(2), EXPECTED_NAME]
    expect(listing(folder('pre-migration'))).toEqual(
      kept.flatMap((name) => [name, name.replace(/\.db$/, '.json')]).sort()
    )
  })

  it('never rotates when the backup fails', async () => {
    const old = [1, 2, 3, 4, 5, 6].map((day) => oldBackup('pre-restore', new Date(2026, 7, day)))
    await backupError(createCategoryBackup(withFailingBackup(db), 'pre-restore', ctx))
    expect(listing(folder('pre-restore'))).toEqual(
      old.flatMap((name) => [name, name.replace(/\.db$/, '.json')]).sort()
    )
  })

  it('keeps the new backup valid when rotation cannot delete an old one', async () => {
    const old = [1, 2, 3, 4, 5, 6].map((day) => oldBackup('pre-restore', new Date(2026, 7, day)))
    holdOpen(temp, win32.join(folder('pre-restore'), old[0]))
    const backup = await createCategoryBackup(db, 'pre-restore', ctx)
    expect(verifyDatabaseFile(backup.file).schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(existsSync(win32.join(folder('pre-restore'), old[0]))).toBe(true)
    expect(ctx.log.entries).toContainEqual(
      expect.objectContaining({
        level: 'WARN',
        message: '[backup] an old backup could not be deleted; it is kept'
      })
    )
  })

  it('applies the given retention policy to automatic backups', async () => {
    oldBackup('auto', new Date(2026, 8, 12))
    oldBackup('auto', new Date(2026, 8, 13))
    await createCategoryBackup(db, 'auto', ctx, { keepDaily: 1, keepMonthly: 0 })
    expect(listing(folder('auto'))).toEqual([EXPECTED_NAME, EXPECTED_SIDECAR])
  })
})

describe('createVerifiedBackup with a chosen file name (manual backups)', () => {
  const usb = (): string => temp.file('usb')

  it('writes the verified backup under that name, with its sidecar next to it', async () => {
    const backup = await createVerifiedBackup(db, usb(), ctx, { fileName: 'Shop backup.db' })
    expect(backup).toMatchObject({
      file: win32.join(usb(), 'Shop backup.db'),
      fileName: 'Shop backup.db',
      schemaVersion: LATEST_SCHEMA_VERSION,
      sidecarWritten: true
    })
    expect(listing(usb())).toEqual(['Shop backup.db', 'Shop backup.json'])
    expect(verifyDatabaseFile(backup.file).schemaVersion).toBe(LATEST_SCHEMA_VERSION)
  })

  it('never replaces a file: a name that is taken, or being written, fails with DESTINATION_EXISTS', async () => {
    mkdirSync(usb(), { recursive: true })
    writeFileSync(win32.join(usb(), 'taken.db'), 'a file of the user')
    writeFileSync(win32.join(usb(), 'busy.db.tmp'), 'a backup in progress')
    for (const fileName of ['taken.db', 'busy.db']) {
      const error = await backupError(createVerifiedBackup(db, usb(), ctx, { fileName }))
      expect(error.code).toBe('DESTINATION_EXISTS')
    }
    expect(readFileSync(win32.join(usb(), 'taken.db'), 'utf8')).toBe('a file of the user')
    expect(listing(usb())).toEqual(['busy.db.tmp', 'taken.db'])
  })

  it.each(['..\\shop.db', 'backups\\copy.db', 'notes.txt', 'copy.db.bak'])(
    'refuses %s, which is not a plain .db file name',
    async (fileName) => {
      const error = await backupError(createVerifiedBackup(db, usb(), ctx, { fileName }))
      expect(error.code).toBe('DESTINATION_UNAVAILABLE')
      expect(listing(usb())).toEqual([])
    }
  )

  it('never replaces a file that has the sidecar name: the backup stays valid without a sidecar', async () => {
    mkdirSync(usb(), { recursive: true })
    writeFileSync(win32.join(usb(), 'copy.json'), '{"mine":true}')
    const backup = await createVerifiedBackup(db, usb(), ctx, { fileName: 'copy.db' })
    expect(backup.sidecarWritten).toBe(false)
    expect(readFileSync(win32.join(usb(), 'copy.json'), 'utf8')).toBe('{"mine":true}')
    expect(verifyDatabaseFile(backup.file).schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(ctx.log.entries).toContainEqual({
      level: 'WARN',
      message:
        '[backup] the sidecar was not written: a file with its name already exists; the backup itself is valid',
      context: { file: 'copy.db' }
    })
  })
})

describe('ensureBackupFolders', () => {
  it('creates the auto, pre-migration and pre-restore folders', () => {
    ensureBackupFolders(ctx.paths)
    ensureBackupFolders(ctx.paths)
    expect(listing(ctx.paths.backupsDir)).toEqual(['auto', 'pre-migration', 'pre-restore'])
  })
})

describe('readSidecar', () => {
  it('reads the app version and creation time from a valid sidecar', async () => {
    const backup = await createVerifiedBackup(db, folder(), ctx)
    expect(readSidecar(backup.file)).toEqual({
      appVersion: TEST_APP_VERSION,
      backupCreatedAt: TEST_TIME.toISOString()
    })
  })

  it.each([
    ['a missing sidecar', null],
    ['malformed JSON', '{ not json'],
    [
      'another format',
      JSON.stringify({
        format: 'other',
        appVersion: '1.0.0',
        backupCreatedAt: TEST_TIME.toISOString()
      })
    ],
    [
      'an unsafe version',
      JSON.stringify({
        format: SIDECAR_FORMAT,
        appVersion: '<script>',
        backupCreatedAt: TEST_TIME.toISOString()
      })
    ],
    [
      'an invalid time',
      JSON.stringify({ format: SIDECAR_FORMAT, appVersion: '1.0.0', backupCreatedAt: 'yesterday' })
    ],
    [
      'an oversized file',
      JSON.stringify({
        format: SIDECAR_FORMAT,
        appVersion: '1.0.0',
        backupCreatedAt: TEST_TIME.toISOString(),
        pad: 'x'.repeat(70_000)
      })
    ]
  ])('ignores %s', (_label, content) => {
    const file = temp.file('stockflow-backup_2026-09-14_153045_v1.0.0_s1.db')
    if (content !== null) writeFileSync(sidecarFileOf(file), content)
    expect(readSidecar(file)).toBeNull()
  })
})
