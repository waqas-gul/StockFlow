import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONNECTION_PRAGMAS,
  STOCKFLOW_APPLICATION_ID,
  openDatabase,
  readApplicationId,
  readConnectionPragmas,
  readUserVersion
} from './connection'
import { initializeDatabase, preMigrationBackupNotAvailable, recordSchemaMigration } from './index'
import { migrate, validateMigrations, type Migration, type MigrationPlan } from './migrate'
import { migrations } from './migrations'
import { TEST_APP_VERSION, createTempDir, sqlChecksum, type TempDir } from './test-utils'

let temp: TempDir

beforeEach(() => {
  temp = createTempDir()
})

afterEach(() => {
  temp.remove()
})

const plan: MigrationPlan = { currentVersion: 0, latestVersion: 1, pending: [] }
const options = { appVersion: TEST_APP_VERSION }
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

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

describe('production migrations', () => {
  it('form a valid list', () => {
    expect(() => validateMigrations(migrations)).not.toThrow()
  })

  it('contain the V1 schema, 0001_initial, as schema version 1', () => {
    expect(migrations.map((migration) => [migration.version, migration.name])).toEqual([
      [1, '0001_initial']
    ])
  })
})

describe('initializeDatabase', () => {
  it('creates a new StockFlow database at the latest schema with verified pragmas', async () => {
    const file = temp.file('StockFlow-test/data/shop.db')
    const db = temp.track(await initializeDatabase(file, options))
    expect(existsSync(file)).toBe(true)
    expect(readApplicationId(db)).toBe(STOCKFLOW_APPLICATION_ID)
    expect(readUserVersion(db)).toBe(migrations.length)
    expect(readConnectionPragmas(db)).toEqual(CONNECTION_PRAGMAS)
  })

  it('records the applied migration in schema_migrations with the app version and checksum', async () => {
    const before = new Date().toISOString()
    const db = temp.track(await initializeDatabase(temp.file('shop.db'), options))
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
    expect(row.applied_at >= before && row.applied_at <= after).toBe(true)
  })

  it('opens the same database again without migrating or seeding it again', async () => {
    const file = temp.file('shop.db')
    const first = await initializeDatabase(file, options)
    const firstRows = schemaMigrations(first)
    const firstCustomers = first.all('SELECT * FROM customers')
    first.close()

    const again = temp.track(await initializeDatabase(file, { appVersion: '9.9.9' }))
    expect(readApplicationId(again)).toBe(STOCKFLOW_APPLICATION_ID)
    expect(readUserVersion(again)).toBe(1)
    expect(schemaMigrations(again)).toEqual(firstRows)
    expect(again.all('SELECT * FROM customers')).toEqual(firstCustomers)
  })

  it('refuses a database from a newer StockFlow version and releases the file', async () => {
    const file = temp.file('shop.db')
    const newer = openDatabase(file)
    newer.exec(`PRAGMA user_version = ${migrations.length + 1}`)
    newer.close()
    await expect(initializeDatabase(file, options)).rejects.toMatchObject({
      code: 'DATABASE_TOO_NEW'
    })
    // Windows refuses to delete a file that is still open.
    rmSync(file)
  })

  it('refuses a file that is not a StockFlow database', async () => {
    const file = temp.file('shop.db')
    writeFileSync(file, 'not a database '.repeat(100))
    await expect(initializeDatabase(file, options)).rejects.toMatchObject({
      code: 'NOT_STOCKFLOW_DATABASE'
    })
  })

  it('does not migrate a schema-0 database that already holds data, and leaves it unchanged', async () => {
    const file = temp.file('shop.db')
    const existing = openDatabase(file)
    existing.exec("CREATE TABLE probe (v TEXT) STRICT; INSERT INTO probe VALUES ('kept')")
    existing.close()

    await expect(initializeDatabase(file, options)).rejects.toMatchObject({
      code: 'BACKUP_FAILED'
    })
    const check = temp.track(openDatabase(file))
    expect(readUserVersion(check)).toBe(0)
    expect(check.all("SELECT name FROM sqlite_schema WHERE type = 'table'")).toEqual([
      { name: 'probe' }
    ])
  })
})

describe('recordSchemaMigration', () => {
  it('writes version, name, UTC time, app version and checksum', async () => {
    const db = temp.track(await initializeDatabase(temp.file('shop.db'), options))
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

describe('preMigrationBackupNotAvailable (placeholder until the Phase 4 backup system)', () => {
  it('lets migrations run on an empty database, which has nothing to back up', async () => {
    const db = temp.track(openDatabase(temp.file('shop.db')))
    await expect(preMigrationBackupNotAvailable(db, plan)).resolves.toBeUndefined()
  })

  it('refuses to migrate a database that holds a schema, since no verified backup can be made yet', async () => {
    const db = temp.track(openDatabase(temp.file('shop.db')))
    db.exec('CREATE TABLE probe (v TEXT) STRICT')
    await expect(preMigrationBackupNotAvailable(db, plan)).rejects.toThrow(
      /verified pre-migration backup/
    )
  })

  it('refuses to migrate a database at a later schema version', async () => {
    const db = temp.track(openDatabase(temp.file('shop.db')))
    db.exec('PRAGMA user_version = 1')
    await expect(
      preMigrationBackupNotAvailable(db, { ...plan, currentVersion: 1, latestVersion: 2 })
    ).rejects.toThrow(/verified pre-migration backup/)
  })

  it('never writes a backup file', async () => {
    const db = temp.track(openDatabase(temp.file('shop.db')))
    await preMigrationBackupNotAvailable(db, plan)
    db.exec('CREATE TABLE probe (v TEXT) STRICT')
    await preMigrationBackupNotAvailable(db, plan).catch(() => undefined)
    expect(readdirSync(temp.path).sort()).toEqual(['shop.db', 'shop.db-shm', 'shop.db-wal'])
  })

  it('blocks every future migration of a schema-1 database until verified backups exist', async () => {
    const db = temp.track(await initializeDatabase(temp.file('shop.db'), options))
    const sql = 'CREATE TABLE fixture_future (id INTEGER PRIMARY KEY) STRICT'
    const future: Migration = {
      version: 2,
      name: '0002_fixture_future',
      checksum: sqlChecksum(sql),
      up: (target) => target.exec(sql)
    }
    await expect(
      migrate(db, [...migrations, future], {
        backupBeforeMigrating: preMigrationBackupNotAvailable,
        recordMigration: recordSchemaMigration(TEST_APP_VERSION)
      })
    ).rejects.toMatchObject({ code: 'BACKUP_FAILED' })
    expect(readUserVersion(db)).toBe(1)
    expect(db.all("SELECT name FROM sqlite_schema WHERE name = 'fixture_future'")).toEqual([])
    expect(schemaMigrations(db).map((row) => row.version)).toEqual([1])
  })
})
