import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
import {
  TEST_APP_VERSION,
  TEST_TIME,
  createTempDir,
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

  it('contain only the V1 schema, 0001_initial, as schema version 1', () => {
    expect(migrations.map((migration) => [migration.version, migration.name])).toEqual([
      [1, '0001_initial']
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

  it('records the applied migration in schema_migrations with the app version and checksum', async () => {
    const before = new Date().toISOString()
    const db = temp.track(await initializeDatabase(ctx))
    const after = new Date().toISOString()
    const [row, ...others] = schemaMigrations(db)
    expect(others).toEqual([])
    expect(row).toMatchObject({
      version: 1,
      name: '0001_initial',
      app_version: TEST_APP_VERSION,
      checksum: migrations[0].checksum
    })
    expect(row.applied_at).toMatch(ISO_UTC)
    expect(isBetween(row.applied_at, before, after)).toBe(true)
  })

  it('opens the same database again without migrating or seeding it again', async () => {
    const first = await initializeDatabase(ctx)
    const firstRows = schemaMigrations(first)
    const firstCustomers = first.all('SELECT * FROM customers')
    first.close()

    const again = temp.track(await initializeDatabase(testContext(temp, { appVersion: '9.9.9' })))
    expect(readUserVersion(again)).toBe(1)
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

    expect(readUserVersion(db)).toBe(1)
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

  it('logs the migration and the verified schema history', async () => {
    temp.track(await initializeDatabase(ctx))
    expect(messages(ctx)).toEqual([
      'INFO [migrate] new database: no pre-migration backup is needed',
      'INFO [migrate] schema migrated',
      'INFO [startup] database ready',
      'INFO [startup] schema history verified'
    ])
    expect(ctx.log.entries[2].context).toEqual({ schema: 1, migrated: 1 })
  })

  it('logs a schema checksum mismatch without changing anything, and still opens the database', async () => {
    temp.track(await initializeDatabase(ctx)).close()
    const changed: Migration[] = [{ ...initialMigration, checksum: OTHER_CHECKSUM }]
    const reopen = testContext(temp, { migrations: changed })
    const db = temp.track(await initializeDatabase(reopen))
    expect(db.isOpen).toBe(true)
    expect(reopen.log.entries).toContainEqual({
      level: 'WARN',
      message:
        '[startup] the recorded schema history does not match this version of StockFlow; it is reported, not changed',
      context: { issues: 1, detail: expect.stringContaining(OTHER_CHECKSUM) }
    })
    expect(schemaMigrations(db).map((row) => row.checksum)).toEqual([initialMigration.checksum])
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
      version: 2,
      name: '0002_fixture_later',
      checksum: sqlChecksum(sql),
      up: (target) => target.exec(sql)
    }
    db.transaction(() => recordSchemaMigration('2.0.0')(db, later))
    const row = schemaMigrations(db)[1]
    expect(row).toMatchObject({
      version: 2,
      name: '0002_fixture_later',
      app_version: '2.0.0',
      checksum: sqlChecksum(sql)
    })
    expect(row.applied_at).toMatch(ISO_UTC)
  })
})
