import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupFolder } from '../data-paths'
import { openSqlite } from './adapter'
import {
  CONNECTION_PRAGMAS,
  STOCKFLOW_APPLICATION_ID,
  openDatabase,
  readApplicationId,
  readConnectionPragmas,
  readUserVersion
} from './connection'
import { initializeDatabase, recordSchemaMigration } from './index'
import { validateMigrations, type Migration } from './migrate'
import { migrations } from './migrations'
import { initialMigration } from './migrations/0001_initial'
import { SCHEMA_VERIFICATION_MESSAGE, SchemaChecksumMismatchError } from './schema-upgrade'
import {
  TEST_APP_VERSION,
  TEST_TIME,
  createTempDir,
  editDatabaseFile,
  fileHash,
  isBetween,
  sqlChecksum,
  testContext,
  type TempDir,
  type TestContext
} from './test-utils'

let temp: TempDir
let ctx: TestContext

beforeEach(() => {
  temp = createTempDir()
  ctx = testContext(temp, { now: () => TEST_TIME })
})

afterEach(() => {
  temp.remove()
})

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const OTHER_CHECKSUM = `sha256:${'e'.repeat(64)}`

interface SchemaMigrationRow {
  version: number
  name: string
  applied_at: string
  app_version: string
  checksum: string
}

function schemaMigrations(db: ReturnType<typeof openDatabase>): SchemaMigrationRow[] {
  return db.all<SchemaMigrationRow>('SELECT * FROM schema_migrations ORDER BY version')
}

function messages(context: TestContext): string[] {
  return context.log.entries.map((entry) => `${entry.level} ${entry.message}`)
}

describe('production migrations', () => {
  it('form a valid list', () => {
    expect(() => validateMigrations(migrations)).not.toThrow()
  })

  it('are 0001_initial and 0002_stock_adjustment_receipt_item, in order', () => {
    expect(migrations.map((migration) => [migration.version, migration.name])).toEqual([
      [1, '0001_initial'],
      [2, '0002_stock_adjustment_receipt_item']
    ])
  })
})

describe('initializeDatabase', () => {
  it('creates a new StockFlow database at the latest schema with every connection pragma verified', async () => {
    const db = temp.track(await initializeDatabase(ctx))
    expect(existsSync(ctx.paths.databaseFile)).toBe(true)
    expect(readApplicationId(db)).toBe(STOCKFLOW_APPLICATION_ID)
    expect(readUserVersion(db)).toBe(migrations.length)
    expect(readConnectionPragmas(db)).toEqual(CONNECTION_PRAGMAS)
  })

  it('records each applied migration in schema_migrations with the app version and checksum', async () => {
    const before = new Date().toISOString()
    const db = temp.track(await initializeDatabase(ctx))
    const after = new Date().toISOString()
    const recorded = schemaMigrations(db)
    expect(recorded).toEqual(
      migrations.map((migration) =>
        expect.objectContaining({
          version: migration.version,
          name: migration.name,
          app_version: TEST_APP_VERSION,
          checksum: migration.checksum
        })
      )
    )
    for (const row of recorded) {
      expect(row.applied_at).toMatch(ISO_UTC)
      expect(isBetween(row.applied_at, before, after)).toBe(true)
    }
  })

  it('opens the same database again without migrating or seeding it again', async () => {
    const first = await initializeDatabase(ctx)
    const firstRows = schemaMigrations(first)
    const firstCustomers = first.all('SELECT * FROM customers')
    first.close()

    const again = temp.track(await initializeDatabase(testContext(temp, { appVersion: '9.9.9' })))
    expect(readUserVersion(again)).toBe(migrations.length)
    expect(schemaMigrations(again)).toEqual(firstRows)
    expect(again.all('SELECT * FROM customers')).toEqual(firstCustomers)
  })

  it('refuses a database from a newer StockFlow version and releases the file', async () => {
    const newer = openDatabase(ctx.paths.databaseFile)
    newer.exec(`PRAGMA user_version = ${migrations.length + 1}`)
    newer.close()
    await expect(initializeDatabase(ctx)).rejects.toMatchObject({ code: 'DATABASE_TOO_NEW' })
    // Windows refuses to delete a file that is still open.
    rmSync(ctx.paths.databaseFile)
  })

  it('refuses a file that is not a StockFlow database', async () => {
    mkdirSync(ctx.paths.dataDir, { recursive: true })
    writeFileSync(ctx.paths.databaseFile, 'not a database '.repeat(100))
    await expect(initializeDatabase(ctx)).rejects.toMatchObject({
      code: 'NOT_STOCKFLOW_DATABASE'
    })
  })

  it('makes no pre-migration backup for a new database, which has nothing to lose', async () => {
    temp.track(await initializeDatabase(ctx))
    expect(readdirSync(backupFolder(ctx.paths, 'pre-migration'))).toEqual([])
  })

  it('backs up a schema-0 database that already holds data before migrating it', async () => {
    const existing = openDatabase(ctx.paths.databaseFile)
    existing.exec("CREATE TABLE probe (v TEXT) STRICT; INSERT INTO probe VALUES ('kept')")
    existing.close()

    const db = temp.track(await initializeDatabase(ctx))

    expect(readUserVersion(db)).toBe(migrations.length)
    expect(db.all('SELECT v FROM probe')).toEqual([{ v: 'kept' }])
    const [backup] = readdirSync(backupFolder(ctx.paths, 'pre-migration')).filter((name) =>
      name.endsWith('.db')
    )
    expect(backup).toBe('stockflow-backup_2026-09-14_153045_v1.0.0-test_s0.db')
    const copy = temp.track(
      openSqlite(win32.join(backupFolder(ctx.paths, 'pre-migration'), backup), { readonly: true })
    )
    expect(readUserVersion(copy)).toBe(0)
    expect(copy.all('SELECT v FROM probe')).toEqual([{ v: 'kept' }])
  })

  it('creates the backup folders', async () => {
    temp.track(await initializeDatabase(ctx))
    expect(readdirSync(ctx.paths.backupsDir).sort()).toEqual([
      'auto',
      'pre-migration',
      'pre-restore'
    ])
  })

  it('first removes temporary files an interrupted backup left in the backup folders, even if the database is refused', async () => {
    const stale = win32.join(
      backupFolder(ctx.paths, 'auto'),
      'stockflow-backup_2026-09-13_220000_v1.0.0_s1.db.tmp'
    )
    mkdirSync(backupFolder(ctx.paths, 'auto'), { recursive: true })
    writeFileSync(stale, 'half-written backup')
    const yesterday = new Date(TEST_TIME.getTime() - 24 * 3600_000)
    utimesSync(stale, yesterday, yesterday)
    mkdirSync(ctx.paths.dataDir, { recursive: true })
    writeFileSync(ctx.paths.databaseFile, 'not a database '.repeat(100))

    await expect(initializeDatabase(ctx)).rejects.toMatchObject({
      code: 'NOT_STOCKFLOW_DATABASE'
    })

    expect(existsSync(stale)).toBe(false)
    expect(messages(ctx)[0]).toBe(
      'INFO [backup] removed temporary files left by an interrupted backup'
    )
  })

  it('logs the migration and the verified schema history', async () => {
    temp.track(await initializeDatabase(ctx))
    expect(messages(ctx)).toEqual([
      'INFO [migrate] new database: no pre-migration backup is needed',
      'INFO [migrate] schema migrated',
      'INFO [startup] database ready',
      'INFO [startup] schema history verified'
    ])
    expect(ctx.log.entries[2].context).toEqual({
      schema: migrations.length,
      migrated: migrations.length
    })
  })

  it('refuses normal startup when an applied migration has a different checksum, and changes nothing', async () => {
    temp.track(await initializeDatabase(ctx)).close()
    const before = fileHash(ctx.paths.databaseFile)
    const changed: Migration[] = [
      { ...initialMigration, checksum: OTHER_CHECKSUM },
      ...migrations.slice(1)
    ]
    const reopen = testContext(temp, { migrations: changed })

    const error = await initializeDatabase(reopen).then(
      () => undefined,
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(SchemaChecksumMismatchError)
    expect(error).toMatchObject({
      code: 'SCHEMA_CHECKSUM_MISMATCH',
      message: SCHEMA_VERIFICATION_MESSAGE,
      mismatches: [
        {
          version: 1,
          migration: '0001_initial',
          expected: OTHER_CHECKSUM,
          actual: initialMigration.checksum
        }
      ]
    })
    expect(reopen.log.entries).toContainEqual({
      level: 'ERROR',
      message:
        '[schema] applied migration checksum mismatch: the database is refused and left unchanged',
      context: {
        version: 1,
        migration: '0001_initial',
        expected: OTHER_CHECKSUM,
        actual: initialMigration.checksum
      }
    })
    expect(messages(reopen)).not.toContain('INFO [startup] database ready')
    // The file was released and not changed: the recorded checksum is never "corrected".
    expect(fileHash(ctx.paths.databaseFile)).toBe(before)
    const check = temp.track(openSqlite(ctx.paths.databaseFile, { readonly: true }))
    expect(schemaMigrations(check).map((row) => row.checksum)).toEqual(
      migrations.map((migration) => migration.checksum)
    )
  })

  it('shows the user a safe message and puts the technical detail in the cause', () => {
    const error = new SchemaChecksumMismatchError([
      { version: 1, migration: '0001_initial', expected: OTHER_CHECKSUM, actual: 'sha256:recorded' }
    ])
    expect(error.message).toBe(
      'StockFlow detected a database schema verification problem.\nYour data has not been changed.\n' +
        'Restore a verified backup or contact support.'
    )
    expect(error.message).not.toContain('sha256')
    expect((error.cause as Error).message).toBe(
      `Migration 1 (0001_initial) is recorded with checksum sha256:recorded, but this version of StockFlow ` +
        `expects ${OTHER_CHECKSUM}.`
    )
  })

  it('still opens the database when only the recorded name differs: a warning, not a refusal', async () => {
    temp.track(await initializeDatabase(ctx)).close()
    const renamed = testContext(temp, {
      migrations: [{ ...initialMigration, name: '0001_renamed' }, ...migrations.slice(1)]
    })
    const db = temp.track(await initializeDatabase(renamed))
    expect(db.isOpen).toBe(true)
    expect(renamed.log.entries).toContainEqual({
      level: 'WARN',
      message:
        '[startup] the recorded schema history does not match this version of StockFlow; it is reported, not changed',
      context: { issues: 1, detail: expect.stringContaining('0001_renamed') }
    })
  })

  it('still opens a database whose migration record is missing: a warning, not a refusal', async () => {
    temp.track(await initializeDatabase(ctx)).close()
    editDatabaseFile(
      ctx.paths.databaseFile,
      'DROP TRIGGER trg_schema_migrations_no_delete; DELETE FROM schema_migrations'
    )
    const reopen = testContext(temp)
    const db = temp.track(await initializeDatabase(reopen))
    expect(db.isOpen).toBe(true)
    expect(reopen.log.entries).toContainEqual(
      expect.objectContaining({
        level: 'WARN',
        context: {
          issues: 1,
          detail: `schema_migrations records versions none, but the schema version is ${migrations.length}.`
        }
      })
    )
  })

  it('still reports a newer database as DATABASE_TOO_NEW when a checksum differs as well', async () => {
    temp.track(await initializeDatabase(ctx)).close()
    editDatabaseFile(ctx.paths.databaseFile, `PRAGMA user_version = ${migrations.length + 1}`)
    const changed = testContext(temp, {
      migrations: [{ ...initialMigration, checksum: OTHER_CHECKSUM }]
    })
    await expect(initializeDatabase(changed)).rejects.toMatchObject({ code: 'DATABASE_TOO_NEW' })
  })

  it('still opens the database when the backup folders cannot be created, and logs it', async () => {
    temp.track(await initializeDatabase(ctx)).close()
    rmSync(ctx.paths.backupsDir, { recursive: true })
    writeFileSync(ctx.paths.backupsDir, 'a file where the folder should be')
    const reopen = testContext(temp)
    const db = temp.track(await initializeDatabase(reopen))
    expect(db.isOpen).toBe(true)
    expect(reopen.log.entries).toContainEqual({
      level: 'WARN',
      message: '[startup] the backup folders could not be created',
      context: { code: expect.stringMatching(/^E[A-Z]+$/) }
    })
  })
})

describe('recordSchemaMigration', () => {
  it('writes version, name, UTC time, app version and checksum', async () => {
    const db = temp.track(await initializeDatabase(ctx))
    const sql = 'CREATE TABLE fixture_later (id INTEGER PRIMARY KEY) STRICT'
    const later: Migration = {
      version: migrations.length + 1,
      name: '9999_fixture_later',
      checksum: sqlChecksum(sql),
      up: (target) => target.exec(sql)
    }
    db.transaction(() => recordSchemaMigration('2.0.0')(db, later))
    const row = schemaMigrations(db)[migrations.length]
    expect(row).toMatchObject({
      version: migrations.length + 1,
      name: '9999_fixture_later',
      app_version: '2.0.0',
      checksum: sqlChecksum(sql)
    })
    expect(row.applied_at).toMatch(ISO_UTC)
  })
})
