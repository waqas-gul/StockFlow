import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupFolder, resolveDataPaths } from '../data-paths'
import { openSqlite, type Db } from './adapter'
import { openDatabase, readUserVersion } from './connection'
import type { DataSafetyFaults } from './context'
import { initializeDatabase } from './index'
import type { Migration } from './migrate'
import { migrations } from './migrations'
import {
  SchemaChecksumMismatchError,
  appliedChecksumMismatches,
  upgradeSchema,
  verifiedPreMigrationBackup
} from './schema-upgrade'
import {
  TEST_TIME,
  createSchemaDatabase,
  createTempDir,
  editDatabaseFile,
  fixtureMigration,
  holdOpen,
  insertRow,
  replaceFolderWithFile,
  rows,
  testContext,
  violateCheckConstraint,
  withFailingBackup,
  type TempDir,
  type TestContext
} from './test-utils'
import { verifyDatabaseFile, type DatabaseFileReport } from './verify'

const BACKUP_S1 = 'stockflow-backup_2026-09-14_153045_v1.0.0-test_s1.db'

let temp: TempDir
let db: Db
let migration2Ran: boolean

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
  migration2Ran = false
})

afterEach(() => {
  temp.remove()
})

function preMigrationFolder(): string {
  return backupFolder(resolveDataPaths(temp.path), 'pre-migration')
}

/** Backup files (not sidecars or temporary files) in the pre-migration folder. */
function preMigrationBackups(): string[] {
  const folder = preMigrationFolder()
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return []
  return readdirSync(folder)
    .filter((name) => name.endsWith('.db'))
    .sort()
}

/** TEST-ONLY migration 2: adds a technical table. `before` runs first, inside its transaction. */
function migration2(before?: (target: Db) => void): Migration {
  return fixtureMigration(
    2,
    '0002_fixture_later',
    'CREATE TABLE fixture_later (id INTEGER PRIMARY KEY) STRICT',
    (target) => {
      migration2Ran = true
      before?.(target)
    }
  )
}

function contextWith(list: readonly Migration[], faults?: DataSafetyFaults): TestContext {
  return testContext(temp, { now: () => TEST_TIME, migrations: list, faults })
}

function companies(target: Db): string[] {
  return target
    .all<{ name: string }>('SELECT name FROM companies ORDER BY id')
    .map((row) => row.name)
}

describe('upgradeSchema: the verified pre-migration backup (schema 1 → test migration 2)', () => {
  it('makes a pre-migration backup that exists and passes verification before migration 2 runs', async () => {
    insertRow(db, 'companies', { name: 'Before 0002' })
    let seen: { files: string[]; report: DatabaseFileReport; companies: string[] } | undefined
    const later = migration2(() => {
      const [file] = preMigrationBackups()
      const backup = win32.join(preMigrationFolder(), file)
      const copy = openSqlite(backup, { readonly: true })
      const inBackup = companies(copy)
      copy.close()
      seen = {
        files: readdirSync(preMigrationFolder()).sort(),
        report: verifyDatabaseFile(backup),
        companies: inBackup
      }
    })
    const ctx = contextWith([...migrations, later])

    const result = await upgradeSchema(db, ctx)

    expect(result).toEqual({ fromVersion: 1, toVersion: 2, applied: ['0002_fixture_later'] })
    expect(seen).toEqual({
      files: [BACKUP_S1, BACKUP_S1.replace(/\.db$/, '.json')],
      report: expect.objectContaining({ schemaVersion: 1 }),
      companies: ['Before 0002']
    })
    expect(readUserVersion(db)).toBe(2)
    expect(
      db.all('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    ).toEqual([
      { version: 1, name: '0001_initial', checksum: migrations[0].checksum },
      { version: 2, name: '0002_fixture_later', checksum: later.checksum }
    ])
    expect(ctx.log.entries.map((entry) => entry.message)).toEqual([
      '[backup] verified backup created',
      '[migrate] verified pre-migration backup made',
      '[migrate] schema migrated'
    ])
    expect(ctx.log.entries[2].context).toEqual({ from: 1, to: 2, applied: '0002_fixture_later' })
  })

  it('keeps only the last 5 pre-migration backups', async () => {
    mkdirSync(preMigrationFolder(), { recursive: true })
    for (let day = 1; day <= 6; day++) {
      writeFileSync(
        win32.join(preMigrationFolder(), `stockflow-backup_2026-08-0${day}_120000_v1.0.0_s1.db`),
        'older backup'
      )
    }
    await upgradeSchema(db, contextWith([...migrations, migration2()]))
    expect(preMigrationBackups()).toEqual([
      'stockflow-backup_2026-08-03_120000_v1.0.0_s1.db',
      'stockflow-backup_2026-08-04_120000_v1.0.0_s1.db',
      'stockflow-backup_2026-08-05_120000_v1.0.0_s1.db',
      'stockflow-backup_2026-08-06_120000_v1.0.0_s1.db',
      BACKUP_S1
    ])
  })

  it('does nothing, and makes no backup, when the database is current', async () => {
    const ctx = contextWith(migrations)
    await expect(upgradeSchema(db, ctx)).resolves.toEqual({
      fromVersion: 1,
      toVersion: 1,
      applied: []
    })
    expect(preMigrationBackups()).toEqual([])
    expect(ctx.log.entries).toEqual([])
  })

  it('makes no backup of a new, empty database, which has nothing to lose', async () => {
    const empty = temp.track(openDatabase(temp.file('empty\\shop.db')))
    const ctx = contextWith(migrations)
    await upgradeSchema(empty, ctx)
    expect(readUserVersion(empty)).toBe(1)
    expect(preMigrationBackups()).toEqual([])
    expect(ctx.log.entries[0]).toEqual({
      level: 'INFO',
      message: '[migrate] new database: no pre-migration backup is needed',
      context: { from: 0, to: 1 }
    })
  })

  it('is the backup that initializeDatabase uses when a newer app opens a schema-1 database', async () => {
    insertRow(db, 'companies', { name: 'Before the update' })
    db.close()
    const reopened = temp.track(
      await initializeDatabase(contextWith([...migrations, migration2()]))
    )
    expect(readUserVersion(reopened)).toBe(2)
    expect(preMigrationBackups()).toEqual([BACKUP_S1])
    const copy = temp.track(
      openSqlite(win32.join(preMigrationFolder(), BACKUP_S1), { readonly: true })
    )
    expect(companies(copy)).toEqual(['Before the update'])
  })

  it('is exported as the runner hook for the migration runner', async () => {
    const hook = verifiedPreMigrationBackup(contextWith(migrations))
    await hook(db, { currentVersion: 1, latestVersion: 2, pending: [] })
    expect(preMigrationBackups()).toEqual([BACKUP_S1])
  })
})

describe('upgradeSchema: a failed pre-migration backup means migration 2 never starts', () => {
  interface Scenario {
    target?: () => Db
    faults?: DataSafetyFaults
    arrange?: () => void
  }

  const scenarios: Array<[string, () => Scenario]> = [
    [
      'the backup destination cannot be written',
      () => ({ arrange: () => replaceFolderWithFile(preMigrationFolder()) })
    ],
    ['the SQLite backup operation throws', () => ({ target: () => withFailingBackup(db) })],
    [
      'verification fails: the copy is not a StockFlow database',
      () => ({
        faults: {
          afterBackupCopy: (tempFile) => editDatabaseFile(tempFile, 'PRAGMA application_id = 0')
        }
      })
    ],
    [
      'integrity_check fails',
      () => ({ faults: { afterBackupCopy: (tempFile) => violateCheckConstraint(tempFile) } })
    ],
    [
      'foreign_key_check fails',
      () => ({
        arrange: () => {
          db.exec('PRAGMA foreign_keys = OFF')
          const m = { productId: 999 }
          db.run(
            'INSERT INTO product_units (product_id, name, base_qty, is_base) VALUES (?, ?, 1, 1)',
            [m.productId, rows.unit(m.productId).name as string]
          )
          db.exec('PRAGMA foreign_keys = ON')
        }
      })
    ],
    [
      'the rename (finalization) fails',
      () => ({
        faults: {
          beforeBackupFinalize: (tempFile) => {
            holdOpen(temp, tempFile)
          }
        }
      })
    ]
  ]

  it.each(scenarios)('%s', async (_label, scenario) => {
    const { target, faults, arrange } = scenario()
    arrange?.()
    const ctx = contextWith([...migrations, migration2()], faults)
    const error = await upgradeSchema(target?.() ?? db, ctx).then(
      () => undefined,
      (reason: unknown) => reason
    )
    expect(error).toMatchObject({ code: 'BACKUP_FAILED' })
    expect(migration2Ran).toBe(false)
    expect(readUserVersion(db)).toBe(1)
    expect(db.get("SELECT name FROM sqlite_schema WHERE name = 'fixture_later'")).toBeUndefined()
    expect(db.all('SELECT version FROM schema_migrations')).toEqual([{ version: 1 }])
    expect(preMigrationBackups()).toEqual([])
    expect(ctx.log.entries).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        message: '[backup] the backup failed; existing backups were not touched'
      })
    )
  })

  it('stops initializeDatabase too, leaving the database at schema 1 (backup failure)', async () => {
    db.close()
    replaceFolderWithFile(preMigrationFolder())
    await expect(
      initializeDatabase(contextWith([...migrations, migration2()]))
    ).rejects.toMatchObject({ code: 'BACKUP_FAILED' })
    expect(migration2Ran).toBe(false)
    const check = temp.track(openDatabase(resolveDataPaths(temp.path).databaseFile))
    expect(readUserVersion(check)).toBe(1)
  })
})

describe('upgradeSchema: applied migration checksums are verified before anything else', () => {
  const OTHER = `sha256:${'e'.repeat(64)}`

  it('refuses a database whose applied migration has another checksum: no backup, no migration, no change', async () => {
    insertRow(db, 'companies', { name: 'Kept' })
    const ctx = contextWith([{ ...migrations[0], checksum: OTHER }, migration2()])
    const error = await upgradeSchema(db, ctx).then(
      () => undefined,
      (reason: unknown) => reason
    )
    expect(error).toBeInstanceOf(SchemaChecksumMismatchError)
    expect(migration2Ran).toBe(false)
    expect(readUserVersion(db)).toBe(1)
    expect(preMigrationBackups()).toEqual([])
    expect(db.all('SELECT version, checksum FROM schema_migrations')).toEqual([
      { version: 1, checksum: migrations[0].checksum }
    ])
    expect(companies(db)).toEqual(['Kept'])
  })

  it('lists every applied migration whose checksum differs', async () => {
    const later = migration2()
    await upgradeSchema(db, contextWith([...migrations, later]))
    expect(
      appliedChecksumMismatches(db, [
        { ...migrations[0], checksum: OTHER },
        { ...later, checksum: OTHER }
      ])
    ).toEqual([
      { version: 1, migration: '0001_initial', expected: OTHER, actual: migrations[0].checksum },
      { version: 2, migration: '0002_fixture_later', expected: OTHER, actual: later.checksum }
    ])
  })

  it('finds no mismatch when the checksums match, the history is absent, or a migration is unknown', async () => {
    expect(appliedChecksumMismatches(db, migrations)).toEqual([])
    const empty = temp.track(openDatabase(temp.file('empty\\shop.db')))
    expect(appliedChecksumMismatches(empty, migrations)).toEqual([])
    // Version 2 is recorded but this app knows only version 1: a newer schema, reported as such elsewhere.
    await upgradeSchema(db, contextWith([...migrations, migration2()]))
    expect(appliedChecksumMismatches(db, migrations)).toEqual([])
  })
})

describe('upgradeSchema: a TEST-ONLY migration that breaks a reference is rejected', () => {
  it('rolls migration 2 back when it leaves an orphan, keeps schema 1, and never runs migration 3', async () => {
    insertRow(db, 'companies', { name: 'Before 0002' })
    const orphan = fixtureMigration(
      2,
      '0002_fixture_orphan',
      "PRAGMA defer_foreign_keys = ON; INSERT INTO product_units (product_id, name, base_qty, is_base) VALUES (999, 'Orphan', 1, 1)"
    )
    let migration3Ran = false
    const later = fixtureMigration(
      3,
      '0003_fixture_after',
      'CREATE TABLE fixture_after (id INTEGER PRIMARY KEY) STRICT',
      () => {
        migration3Ran = true
      }
    )
    const error = await upgradeSchema(db, contextWith([...migrations, orphan, later])).then(
      () => undefined,
      (reason: unknown) => reason
    )
    expect(error).toMatchObject({ code: 'FOREIGN_KEY_CHECK_FAILED', version: 2 })
    expect((error as Error).message).toContain('0002_fixture_orphan (version 2)')
    expect((error as Error).message).toContain('product_units')
    expect(migration3Ran).toBe(false)
    expect(readUserVersion(db)).toBe(1)
    expect(db.all("SELECT id FROM product_units WHERE name = 'Orphan'")).toEqual([])
    expect(db.all('SELECT version FROM schema_migrations')).toEqual([{ version: 1 }])
    expect(db.get("SELECT name FROM sqlite_schema WHERE name = 'fixture_after'")).toBeUndefined()
    // The verified pre-migration backup was made first, and is kept.
    expect(preMigrationBackups()).toEqual([BACKUP_S1])
  })
})
