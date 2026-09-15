import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupFolder, resolveDataPaths } from '../data-paths'
import { openSqlite, type Db } from './adapter'
import { createVerifiedBackup, type BackupInfo } from './backup'
import { CONNECTION_PRAGMAS, readConnectionPragmas, readUserVersion } from './connection'
import type { DataSafetyFaults } from './context'
import { initializeDatabase } from './index'
import type { Migration } from './migrate'
import { migrations } from './migrations'
import {
  RestoreError,
  recoverInterruptedRestore,
  restoreDatabase,
  restoreFilesOf,
  validateRestoreCandidate,
  type RestoreErrorCode,
  type RestoreOutcome,
  type RestoreStage
} from './restore'
import { upgradeSchema } from './schema-upgrade'
import {
  TEST_TIME,
  createSchemaDatabase,
  createTempDir,
  editDatabaseFile,
  fileHash,
  fixtureMigration,
  holdOpen,
  insertRow,
  replaceFolderWithFile,
  testContext,
  thrown,
  violateCheckConstraint,
  type TempDir,
  type TestContext
} from './test-utils'
import { foreignKeyViolations, integrityProblems, verifyDatabaseFile } from './verify'

const CANDIDATE_TIME = new Date(2026, 8, 1, 18, 0, 0)
const NEWER_MESSAGE =
  'This backup was created by a newer version of StockFlow. Install the newer application version before restoring it.'

let temp: TempDir
let ctx: TestContext
let live: Db
let sources: number

beforeEach(async () => {
  temp = createTempDir()
  ctx = testContext(temp, { now: () => TEST_TIME })
  live = await createSchemaDatabase(temp)
  insertRow(live, 'companies', { name: 'Current data' })
  sources = 0
})

afterEach(() => {
  temp.remove()
})

function companies(db: Db): string[] {
  return db.all<{ name: string }>('SELECT name FROM companies ORDER BY id').map((row) => row.name)
}

/** The companies in the live database file, read through a separate connection. */
function companiesOnDisk(): string[] {
  const check = openSqlite(ctx.paths.databaseFile, { readonly: true })
  try {
    return companies(check)
  } finally {
    check.close()
  }
}

/** A verified backup, made by StockFlow 0.9.0, of another StockFlow database that holds `names`. */
async function candidateBackup(names: readonly string[]): Promise<BackupInfo> {
  sources++
  const sourceContext = testContext(temp, {
    paths: resolveDataPaths(temp.file(`source-${sources}`)),
    appVersion: '0.9.0',
    now: () => CANDIDATE_TIME
  })
  const source = await initializeDatabase(sourceContext)
  try {
    for (const name of names) insertRow(source, 'companies', { name })
    return await createVerifiedBackup(source, temp.file('candidates'), sourceContext)
  } finally {
    source.close()
  }
}

/** A copy of `file` in another folder, under `name`, without its sidecar. */
function copyAs(file: string, name: string): string {
  mkdirSync(temp.file('elsewhere'), { recursive: true })
  const copy = temp.file(`elsewhere\\${name}`)
  copyFileSync(file, copy)
  return copy
}

function validationError(file: string, context: TestContext = ctx): RestoreError {
  const error = thrown(() => validateRestoreCandidate(file, context))
  expect(error).toBeInstanceOf(RestoreError)
  return error as RestoreError
}

/** Working files a restore may leave in the data folder. */
function leftovers(): string[] {
  return readdirSync(ctx.paths.dataDir).filter((name) => name.includes('.restore-'))
}

function withFaults(faults: DataSafetyFaults): TestContext {
  ctx = testContext(temp, { now: () => TEST_TIME, faults })
  return ctx
}

describe('validateRestoreCandidate', () => {
  it('accepts a valid backup of the current schema and returns a safe summary', async () => {
    const candidate = await candidateBackup(['Restored A', 'Restored B'])
    expect(validateRestoreCandidate(candidate.file, ctx)).toEqual({
      fileName: candidate.fileName,
      schemaVersion: 1,
      appVersion: '0.9.0',
      backupCreatedAt: CANDIDATE_TIME.toISOString(),
      sizeBytes: candidate.sizeBytes,
      counts: { products: 0, customers: 1, invoices: 0 },
      needsMigration: false
    })
  })

  it('reads the app version and time from the backup file name when there is no sidecar', async () => {
    const candidate = await candidateBackup(['Restored'])
    const copy = copyAs(candidate.file, candidate.fileName)
    expect(validateRestoreCandidate(copy, ctx)).toMatchObject({
      appVersion: '0.9.0',
      backupCreatedAt: CANDIDATE_TIME.toISOString()
    })
  })

  it('uses the file time for a backup that has another name', async () => {
    const candidate = await candidateBackup(['Restored'])
    const copy = copyAs(candidate.file, 'my shop.db')
    expect(validateRestoreCandidate(copy, ctx)).toMatchObject({
      fileName: 'my shop.db',
      appVersion: null,
      backupCreatedAt: statSync(copy).mtime.toISOString()
    })
  })

  it('never modifies the candidate, not even a WAL-flagged raw copy', async () => {
    mkdirSync(temp.file('raw'))
    const candidate = temp.file('raw\\wal-copy.db')
    await live.backup(candidate)
    const before = { hash: fileHash(candidate), modified: statSync(candidate).mtimeMs }
    validateRestoreCandidate(candidate, ctx)
    expect({ hash: fileHash(candidate), modified: statSync(candidate).mtimeMs }).toEqual(before)
    expect(readdirSync(temp.file('raw'))).toEqual(['wal-copy.db'])
  })

  it('leaves no temporary copy behind', async () => {
    validateRestoreCandidate((await candidateBackup([])).file, ctx)
    expect(readdirSync(ctx.paths.dataDir).sort()).toEqual(['shop.db', 'shop.db-shm', 'shop.db-wal'])
  })

  it('accepts an older supported backup and reports that it will be migrated', async () => {
    const candidate = await candidateBackup(['Old'])
    const newer = testContext(temp, {
      migrations: [...migrations, fixtureMigration(2, '0002_fixture_later', 'SELECT 1')]
    })
    expect(validateRestoreCandidate(candidate.file, newer)).toMatchObject({
      schemaVersion: 1,
      needsMigration: true
    })
  })

  it('refuses a missing file or a folder', () => {
    expect(validationError(temp.file('missing.db'))).toMatchObject({
      code: 'CANDIDATE_NOT_FOUND',
      message: 'The backup file could not be found.'
    })
    mkdirSync(temp.file('folder.db'))
    expect(validationError(temp.file('folder.db')).code).toBe('CANDIDATE_NOT_FOUND')
  })

  it('refuses the live database, its WAL, and anything else in the data folder', () => {
    for (const file of [
      ctx.paths.databaseFile,
      `${ctx.paths.databaseFile}-wal`,
      win32.join(ctx.paths.dataDir, 'copy.db')
    ]) {
      expect(validationError(file).code).toBe('CANDIDATE_IS_LIVE_DATA')
    }
    expect(companies(live)).toEqual(['Current data'])
  })

  it('refuses a SQLite database of another application', () => {
    const other = openSqlite(temp.file('other.db'))
    other.exec('PRAGMA application_id = 42; CREATE TABLE t (v TEXT)')
    other.close()
    expect(validationError(temp.file('other.db'))).toMatchObject({
      code: 'NOT_STOCKFLOW',
      message: 'This file is not a StockFlow backup.'
    })
  })

  it('refuses a file that is not a database', () => {
    writeFileSync(temp.file('notes.db'), 'not a database '.repeat(100))
    expect(validationError(temp.file('notes.db'))).toMatchObject({
      code: 'NOT_A_DATABASE',
      message: 'This file is not a StockFlow backup.'
    })
  })

  it('refuses a damaged backup: integrity_check or foreign_key_check fails', async () => {
    const candidate = await candidateBackup(['x'])
    const damaged = copyAs(candidate.file, 'damaged.db')
    violateCheckConstraint(damaged)
    const orphaned = copyAs(candidate.file, 'orphaned.db')
    editDatabaseFile(
      orphaned,
      "INSERT INTO product_units (product_id, name, base_qty, is_base) VALUES (999, 'Orphan', 1, 1)"
    )
    for (const file of [damaged, orphaned]) {
      expect(validationError(file)).toMatchObject({
        code: 'DAMAGED',
        message: 'This backup is damaged and cannot be restored.'
      })
    }
  })

  it('refuses a backup made by a newer version of StockFlow, with a clear message', async () => {
    const candidate = await candidateBackup(['Future'])
    const newer = copyAs(candidate.file, 'newer.db')
    editDatabaseFile(newer, 'PRAGMA user_version = 2')
    expect(validationError(newer)).toMatchObject({ code: 'SCHEMA_TOO_NEW', message: NEWER_MESSAGE })
  })

  it('refuses a backup it cannot copy for checking, and logs the working file it cannot remove', async () => {
    const candidate = await candidateBackup(['x'])
    const { check } = restoreFilesOf(ctx.paths.databaseFile)
    mkdirSync(check)
    writeFileSync(`${check}\\blocker`, 'x')
    expect(validationError(candidate.file)).toMatchObject({
      code: 'UNREADABLE',
      message: 'This backup could not be read. Close any program that is using it and try again.'
    })
    expect(ctx.log.entries).toContainEqual({
      level: 'WARN',
      message: '[restore] a restore working file could not be removed',
      context: { file: 'shop.db.restore-check' }
    })
  })

  it('never puts a file path in the message', async () => {
    writeFileSync(temp.file('notes.db'), 'not a database')
    for (const file of [temp.file('missing.db'), temp.file('notes.db'), ctx.paths.databaseFile]) {
      expect(validationError(file).message).not.toMatch(/[\\/]|stockflow-test/i)
    }
  })
})

describe('restoreDatabase', () => {
  it('replaces the current data with the backup and returns the open, verified database', async () => {
    const candidate = await candidateBackup(['Restored A'])
    const outcome = await restoreDatabase(live, candidate.file, ctx)
    if (!outcome.ok) throw outcome.error
    const db = temp.track(outcome.db)
    expect(db).not.toBe(live)
    expect(live.isOpen).toBe(false)
    expect(companies(db)).toEqual(['Restored A'])
    expect(companiesOnDisk()).toEqual(['Restored A'])
    // Decision 6: the restored connection runs with every required pragma, recursive_triggers included.
    expect(readConnectionPragmas(db)).toEqual(CONNECTION_PRAGMAS)
    expect(outcome.summary).toMatchObject({ fileName: candidate.fileName, schemaVersion: 1 })
    expect(outcome.migration).toEqual({ fromVersion: 1, toVersion: 1, applied: [] })
    expect(readdirSync(ctx.paths.dataDir).sort()).toEqual(['shop.db', 'shop.db-shm', 'shop.db-wal'])
    expect(ctx.log.entries).toContainEqual({
      level: 'INFO',
      message: '[restore] the backup was restored',
      context: { file: candidate.fileName, schema: 1, migrated: 0 }
    })
  })

  it('first makes a verified pre-restore backup of the current data', async () => {
    const outcome = await restoreDatabase(live, (await candidateBackup(['Restored'])).file, ctx)
    if (!outcome.ok) throw outcome.error
    temp.track(outcome.db)
    const { preRestoreBackup } = outcome
    expect(win32.dirname(preRestoreBackup.file)).toBe(backupFolder(ctx.paths, 'pre-restore'))
    expect(verifyDatabaseFile(preRestoreBackup.file).schemaVersion).toBe(1)
    const copy = temp.track(openSqlite(preRestoreBackup.file, { readonly: true }))
    expect(companies(copy)).toEqual(['Current data'])
  })

  it('handles the WAL safely: WAL data is in the pre-restore backup and no stale WAL or SHM survives', async () => {
    insertRow(live, 'companies', { name: 'Only in the WAL' })
    expect(statSync(`${ctx.paths.databaseFile}-wal`).size).toBeGreaterThan(0)
    let atInstall: string[] = []
    const run = withFaults({
      afterRestoreInstall: () => {
        atInstall = readdirSync(ctx.paths.dataDir).sort()
      }
    })
    const outcome = await restoreDatabase(live, (await candidateBackup(['Restored'])).file, run)
    if (!outcome.ok) throw outcome.error
    temp.track(outcome.db)
    expect(atInstall).toEqual(['shop.db', 'shop.db.restore-pending', 'shop.db.restore-rollback'])
    const copy = temp.track(openSqlite(outcome.preRestoreBackup.file, { readonly: true }))
    expect(companies(copy)).toEqual(['Current data', 'Only in the WAL'])
    expect(companies(outcome.db)).toEqual(['Restored'])
  })

  it('never modifies the candidate', async () => {
    const candidate = await candidateBackup(['Restored'])
    const hash = fileHash(candidate.file)
    const outcome = await restoreDatabase(live, candidate.file, ctx)
    if (outcome.ok) temp.track(outcome.db)
    expect(fileHash(candidate.file)).toBe(hash)
    expect(readdirSync(temp.file('candidates')).sort()).toEqual([
      candidate.fileName,
      candidate.fileName.replace(/\.db$/, '.json')
    ])
  })

  it('migrates an older supported backup after restoring it, with its own verified pre-migration backup', async () => {
    const candidate = await candidateBackup(['Old backup'])
    const later = fixtureMigration(
      2,
      '0002_fixture_later',
      'CREATE TABLE fixture_later (id INTEGER PRIMARY KEY) STRICT'
    )
    const newer = testContext(temp, { now: () => TEST_TIME, migrations: [...migrations, later] })
    // The running app is already at schema 2.
    await upgradeSchema(live, newer)

    const outcome = await restoreDatabase(live, candidate.file, newer)

    if (!outcome.ok) throw outcome.error
    const db = temp.track(outcome.db)
    expect(outcome.summary.needsMigration).toBe(true)
    expect(outcome.migration).toEqual({
      fromVersion: 1,
      toVersion: 2,
      applied: ['0002_fixture_later']
    })
    expect(readUserVersion(db)).toBe(2)
    expect(companies(db)).toEqual(['Old backup'])
    expect(db.get("SELECT name FROM sqlite_schema WHERE name = 'fixture_later'")).toEqual({
      name: 'fixture_later'
    })
    const folder = backupFolder(ctx.paths, 'pre-migration')
    const backups = readdirSync(folder)
      .filter((name) => name.endsWith('.db'))
      .sort()
    expect(backups).toEqual([
      'stockflow-backup_2026-09-14_153045_v1.0.0-test_s1.db',
      'stockflow-backup_2026-09-14_153045_v1.0.0-test_s1_2.db'
    ])
    const restoredCopy = temp.track(openSqlite(win32.join(folder, backups[1]), { readonly: true }))
    expect(companies(restoredCopy)).toEqual(['Old backup'])
  })
})

describe('restoreDatabase: failure recovery', () => {
  /** The failure is reported at `stage`, and the previous database is open, intact, usable and on disk. */
  function expectPreviousKept(
    outcome: RestoreOutcome,
    stage: RestoreStage,
    code: RestoreErrorCode
  ): Db {
    if (outcome.ok) throw new Error('The restore unexpectedly succeeded.')
    expect(outcome).toMatchObject({ stage, error: { code } })
    expect(outcome.error).toBeInstanceOf(RestoreError)
    expect(outcome.db).not.toBeNull()
    const db = temp.track(outcome.db as Db)
    expect(db.isOpen).toBe(true)
    expect(companies(db)).toEqual(['Current data'])
    insertRow(db, 'companies', { name: 'Written after the failure' })
    expect(companiesOnDisk()).toEqual(['Current data', 'Written after the failure'])
    expect(integrityProblems(db)).toEqual([])
    expect(foreignKeyViolations(db)).toEqual([])
    expect(readConnectionPragmas(db)).toEqual(CONNECTION_PRAGMAS)
    expect(leftovers()).toEqual([])
    expect(ctx.log.entries).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        message: '[restore] the restore failed',
        context: expect.objectContaining({ stage, code })
      })
    )
    return db
  }

  it('candidate validation fails: nothing is touched', async () => {
    writeFileSync(temp.file('notes.db'), 'not a database '.repeat(100))
    const outcome = await restoreDatabase(live, temp.file('notes.db'), ctx)
    expect(outcome).toMatchObject({ previousReinstated: false })
    expect(expectPreviousKept(outcome, 'VALIDATION', 'NOT_A_DATABASE')).toBe(live)
    expect(readdirSync(backupFolder(ctx.paths, 'pre-restore'))).toEqual([])
  })

  it('the pre-restore backup fails: nothing is replaced', async () => {
    const candidate = await candidateBackup(['Restored'])
    replaceFolderWithFile(backupFolder(ctx.paths, 'pre-restore'))
    const outcome = await restoreDatabase(live, candidate.file, ctx)
    expect(expectPreviousKept(outcome, 'PRE_RESTORE_BACKUP', 'PRE_RESTORE_BACKUP_FAILED')).toBe(
      live
    )
  })

  it('another connection is reading the database: nothing is closed or replaced', async () => {
    const candidate = await candidateBackup(['Restored'])
    const reader = holdOpen(temp, ctx.paths.databaseFile)
    reader.exec('BEGIN')
    reader.get('SELECT count(*) AS n FROM companies')
    const outcome = await restoreDatabase(live, candidate.file, ctx)
    reader.exec('COMMIT')
    reader.close()
    expect(expectPreviousKept(outcome, 'RELEASE', 'DATABASE_IN_USE')).toBe(live)
  }, 20_000)

  it('another program holds the database file: it is not set aside, and is reopened in place', async () => {
    const candidate = await candidateBackup(['Restored'])
    const holder = holdOpen(temp, ctx.paths.databaseFile)
    const outcome = await restoreDatabase(live, candidate.file, ctx)
    holder.close()
    expect(outcome).toMatchObject({ previousReinstated: false })
    expect(expectPreviousKept(outcome, 'RELEASE', 'DATABASE_IN_USE')).not.toBe(live)
  })

  it('the replacement fails after the database was closed: the previous database is put back', async () => {
    const candidate = await candidateBackup(['Restored'])
    const run = withFaults({
      beforeRestoreInstall: () => rmSync(restoreFilesOf(ctx.paths.databaseFile).staging)
    })
    const outcome = await restoreDatabase(live, candidate.file, run)
    expect(outcome).toMatchObject({ previousReinstated: true })
    expectPreviousKept(outcome, 'REPLACE', 'REPLACE_FAILED')
  })

  it('the replaced database cannot be opened: the previous database is put back', async () => {
    const candidate = await candidateBackup(['Restored'])
    const run = withFaults({
      afterRestoreInstall: (file) => writeFileSync(file, 'not a database '.repeat(100))
    })
    expectPreviousKept(await restoreDatabase(live, candidate.file, run), 'REOPEN', 'REOPEN_FAILED')
  })

  it('the restored database fails the final integrity check: the previous database is put back', async () => {
    const candidate = await candidateBackup(['Restored'])
    const run = withFaults({
      beforeRestoreFinalCheck: (db) => {
        db.exec('PRAGMA ignore_check_constraints = ON')
        db.run("INSERT INTO settings (key, value) VALUES ('probe.broken', 'not json')")
        db.exec('PRAGMA ignore_check_constraints = OFF')
      }
    })
    expectPreviousKept(
      await restoreDatabase(live, candidate.file, run),
      'VERIFICATION',
      'VERIFICATION_FAILED'
    )
  })

  it('the restored database fails the final foreign key check: the previous database is put back', async () => {
    const candidate = await candidateBackup(['Restored'])
    const run = withFaults({
      beforeRestoreFinalCheck: (db) => {
        db.exec('PRAGMA foreign_keys = OFF')
        db.run(
          "INSERT INTO product_units (product_id, name, base_qty, is_base) VALUES (999, 'Orphan', 1, 1)"
        )
        db.exec('PRAGMA foreign_keys = ON')
      }
    })
    expectPreviousKept(
      await restoreDatabase(live, candidate.file, run),
      'VERIFICATION',
      'VERIFICATION_FAILED'
    )
  })

  it('migrating a restored older backup fails: the previous database is put back', async () => {
    const candidate = await candidateBackup(['Old backup'])
    const failing: Migration = {
      version: 2,
      name: '0002_fixture_fails',
      checksum: `sha256:${'0'.repeat(64)}`,
      up: () => {
        throw new Error('simulated migration failure')
      }
    }
    ctx = testContext(temp, { now: () => TEST_TIME, migrations: [...migrations, failing] })
    expectPreviousKept(
      await restoreDatabase(live, candidate.file, ctx),
      'MIGRATION',
      'MIGRATION_FAILED'
    )
  })

  it('the previous database cannot be put back: nothing is deleted, and the next start puts it back', async () => {
    const candidate = await candidateBackup(['Restored'])
    let holder: Db | undefined
    const run = withFaults({
      afterRestoreInstall: (file) => {
        writeFileSync(file, 'not a database '.repeat(100))
        holder = holdOpen(temp, file)
      }
    })

    const outcome = await restoreDatabase(live, candidate.file, run)

    expect(outcome).toMatchObject({
      ok: false,
      stage: 'REOPEN',
      db: null,
      previousReinstated: false,
      error: { code: 'ROLLBACK_FAILED' }
    })
    if (outcome.ok) return
    const files = restoreFilesOf(ctx.paths.databaseFile)
    expect(existsSync(files.rollback)).toBe(true)
    expect(existsSync(files.pending)).toBe(true)
    const folder = backupFolder(ctx.paths, 'pre-restore')
    const [preRestore] = readdirSync(folder).filter((name) => name.endsWith('.db'))
    expect(outcome.error.message).toContain(preRestore)
    expect(verifyDatabaseFile(win32.join(folder, preRestore)).schemaVersion).toBe(1)

    // A restart releases the file; the next start puts the previous database back.
    holder?.close()
    const db = temp.track(await initializeDatabase(testContext(temp)))
    expect(companies(db)).toEqual(['Current data'])
    expect(leftovers()).toEqual([])
  })

  it('the restore marker cannot be written: nothing is closed or replaced', async () => {
    const candidate = await candidateBackup(['Restored'])
    mkdirSync(restoreFilesOf(ctx.paths.databaseFile).pending)
    const outcome = await restoreDatabase(live, candidate.file, ctx)
    expect(outcome).toMatchObject({
      ok: false,
      stage: 'RELEASE',
      error: { code: 'REPLACE_FAILED' },
      db: live,
      previousReinstated: false
    })
    expect(live.isOpen).toBe(true)
    expect(companies(live)).toEqual(['Current data'])
  })

  it('the set-aside copy fails its checks when put back: the verified pre-restore backup is put back instead', async () => {
    const candidate = await candidateBackup(['Restored'])
    const { rollback } = restoreFilesOf(ctx.paths.databaseFile)
    const run = withFaults({
      afterRestoreInstall: (file) => {
        writeFileSync(file, 'not a database '.repeat(100))
        editDatabaseFile(
          rollback,
          "INSERT INTO product_units (product_id, name, base_qty, is_base) VALUES (999, 'Orphan', 1, 1)"
        )
      }
    })
    const outcome = await restoreDatabase(live, candidate.file, run)
    expect(outcome).toMatchObject({ previousReinstated: true })
    expectPreviousKept(outcome, 'REOPEN', 'REOPEN_FAILED')
    expect(run.log.entries).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        message: '[restore] the previous database could not be put back from its set-aside copy'
      })
    )
  })

  it('succeeds when the copy of the previous database cannot be removed; the next start removes it', async () => {
    const candidate = await candidateBackup(['Restored'])
    let holder: Db | undefined
    const run = withFaults({
      beforeRestoreFinalCheck: () => {
        holder = holdOpen(temp, restoreFilesOf(ctx.paths.databaseFile).rollback)
        holder.get('SELECT count(*) AS n FROM sqlite_schema')
      }
    })
    const outcome = await restoreDatabase(live, candidate.file, run)
    if (!outcome.ok) throw outcome.error
    temp.track(outcome.db)
    expect(companies(outcome.db)).toEqual(['Restored'])
    expect(run.log.entries).toContainEqual({
      level: 'WARN',
      message:
        '[restore] the previous database copy could not be removed; the next start removes it'
    })
    holder?.close()
    expect(recoverInterruptedRestore(ctx.paths.databaseFile, ctx.log)).toBe('CLEANED_UP')
    expect(leftovers()).toEqual([])
    expect(companies(outcome.db)).toEqual(['Restored'])
  })
})

describe('recoverInterruptedRestore', () => {
  function files(): ReturnType<typeof restoreFilesOf> {
    return restoreFilesOf(ctx.paths.databaseFile)
  }

  function recover(): ReturnType<typeof recoverInterruptedRestore> {
    return recoverInterruptedRestore(ctx.paths.databaseFile, ctx.log)
  }

  it('names its working files after the database file', () => {
    expect(restoreFilesOf('C:\\data\\shop.db')).toEqual({
      staging: 'C:\\data\\shop.db.restore-staging',
      check: 'C:\\data\\shop.db.restore-check',
      rollback: 'C:\\data\\shop.db.restore-rollback',
      pending: 'C:\\data\\shop.db.restore-pending'
    })
  })

  it('does nothing when no restore was interrupted', () => {
    expect(recover()).toBe('NONE')
    expect(ctx.log.entries).toEqual([])
  })

  it('puts the previous database back when a restore stopped before the backup was in place', () => {
    live.close()
    renameSync(ctx.paths.databaseFile, files().rollback)
    writeFileSync(files().pending, '{}')
    expect(recover()).toBe('REINSTATED')
    expect(readdirSync(ctx.paths.dataDir)).toEqual(['shop.db'])
    expect(companiesOnDisk()).toEqual(['Current data'])
    expect(ctx.log.entries).toContainEqual({
      level: 'WARN',
      message:
        '[restore] an interrupted restore was rolled back: the previous database is back in place'
    })
  })

  it('puts the previous database back when a restore stopped after the backup was in place', async () => {
    const candidate = await candidateBackup(['Half restored'])
    live.close()
    renameSync(ctx.paths.databaseFile, files().rollback)
    copyFileSync(candidate.file, ctx.paths.databaseFile)
    writeFileSync(`${ctx.paths.databaseFile}-wal`, 'stale')
    writeFileSync(files().pending, '{}')
    expect(recover()).toBe('REINSTATED')
    expect(readdirSync(ctx.paths.dataDir)).toEqual(['shop.db'])
    expect(companiesOnDisk()).toEqual(['Current data'])
  })

  it('only removes the marker when a restore stopped before the database was set aside', () => {
    writeFileSync(files().pending, '{}')
    expect(recover()).toBe('CLEANED_UP')
    expect(leftovers()).toEqual([])
    expect(companies(live)).toEqual(['Current data'])
  })

  it('removes the previous database left behind by a completed restore', () => {
    writeFileSync(files().rollback, 'the previous database')
    expect(recover()).toBe('CLEANED_UP')
    expect(leftovers()).toEqual([])
    expect(companies(live)).toEqual(['Current data'])
  })

  it('removes leftover working copies', () => {
    writeFileSync(files().staging, 'copy')
    writeFileSync(`${files().staging}-journal`, 'journal')
    writeFileSync(files().check, 'copy')
    expect(recover()).toBe('CLEANED_UP')
    expect(leftovers()).toEqual([])
  })

  it('throws, changing nothing, when the previous database cannot be put back', () => {
    writeFileSync(files().rollback, 'the previous database')
    writeFileSync(files().pending, '{}')
    // The open live connection holds shop.db, so it cannot be replaced.
    expect(() => recover()).toThrow()
    expect(existsSync(files().rollback)).toBe(true)
    expect(existsSync(files().pending)).toBe(true)
    expect(companies(live)).toEqual(['Current data'])
  })

  it('runs at startup: initializeDatabase recovers an interrupted restore before opening the database', async () => {
    live.close()
    renameSync(ctx.paths.databaseFile, files().rollback)
    writeFileSync(files().pending, '{}')
    const db = temp.track(await initializeDatabase(ctx))
    expect(companies(db)).toEqual(['Current data'])
    expect(leftovers()).toEqual([])
  })
})
