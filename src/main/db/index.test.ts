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
import { initializeDatabase, preMigrationBackupNotAvailable } from './index'
import { validateMigrations, type MigrationPlan } from './migrate'
import { migrations } from './migrations'
import { createTempDir, type TempDir } from './test-utils'

let temp: TempDir

beforeEach(() => {
  temp = createTempDir()
})

afterEach(() => {
  temp.remove()
})

const plan: MigrationPlan = { currentVersion: 0, latestVersion: 1, pending: [] }

describe('production migrations', () => {
  it('form a valid list', () => {
    expect(() => validateMigrations(migrations)).not.toThrow()
  })

  it('contain no schema in Phase 3A (0001_initial waits for the business answers)', () => {
    expect(migrations).toEqual([])
  })
})

describe('initializeDatabase', () => {
  it('creates the technical database: StockFlow id, schema 0, verified pragmas and no tables', async () => {
    const file = temp.file('StockFlow-test/data/shop.db')
    const db = temp.track(await initializeDatabase(file))
    expect(existsSync(file)).toBe(true)
    expect(readApplicationId(db)).toBe(STOCKFLOW_APPLICATION_ID)
    expect(readUserVersion(db)).toBe(0)
    expect(readConnectionPragmas(db)).toEqual(CONNECTION_PRAGMAS)
    expect(db.all('SELECT type, name FROM sqlite_schema')).toEqual([])
  })

  it('opens the same database again', async () => {
    const file = temp.file('shop.db')
    ;(await initializeDatabase(file)).close()
    const again = temp.track(await initializeDatabase(file))
    expect(readApplicationId(again)).toBe(STOCKFLOW_APPLICATION_ID)
  })

  it('refuses a database from a newer StockFlow version and releases the file', async () => {
    const file = temp.file('shop.db')
    const newer = openDatabase(file)
    newer.exec('PRAGMA user_version = 1')
    newer.close()
    await expect(initializeDatabase(file)).rejects.toMatchObject({ code: 'DATABASE_TOO_NEW' })
    // Windows refuses to delete a file that is still open.
    rmSync(file)
  })

  it('refuses a file that is not a StockFlow database', async () => {
    const file = temp.file('shop.db')
    writeFileSync(file, 'not a database '.repeat(100))
    await expect(initializeDatabase(file)).rejects.toMatchObject({ code: 'NOT_STOCKFLOW_DATABASE' })
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
})
