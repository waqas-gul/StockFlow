import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSqlite, type Db } from './adapter'
import { openDatabase, readUserVersion } from './connection'
import {
  MigrationError,
  migrate,
  planMigrations,
  validateMigrations,
  type Migration,
  type MigrationPlan,
  type PreMigrationBackup
} from './migrate'
import { createTempDir, thrown, type TempDir } from './test-utils'

// Technical test fixtures only, for the generic runner. The production schema lives in
// src/main/db/migrations and has its own tests.
const createItems: Migration = {
  version: 1,
  name: '0001_fixture_items',
  checksum: 'sha256:fixture-items',
  up: (db) =>
    db.exec('CREATE TABLE fixture_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT')
}
const addNote: Migration = {
  version: 2,
  name: '0002_fixture_note',
  checksum: 'sha256:fixture-note',
  up: (db) => db.exec('ALTER TABLE fixture_items ADD COLUMN note TEXT')
}
const failsHalfway: Migration = {
  version: 3,
  name: '0003_fixture_fails',
  checksum: 'sha256:fixture-fails',
  up: (db) => {
    db.exec('CREATE TABLE fixture_partial (id INTEGER PRIMARY KEY) STRICT')
    throw new Error('simulated migration failure')
  }
}

let temp: TempDir

beforeEach(() => {
  temp = createTempDir()
})

afterEach(() => {
  temp.remove()
})

function openApp(): Db {
  return temp.track(openDatabase(temp.file('shop.db')))
}

function tables(db: Db): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .map((row) => row.name)
}

/** A pre-migration backup stand-in for runner tests that records when it is asked for. */
function recordingBackup(): { calls: MigrationPlan[]; hook: PreMigrationBackup } {
  const calls: MigrationPlan[] = []
  return {
    calls,
    hook: async (_db, plan) => {
      calls.push(plan)
    }
  }
}

async function migrationError(promise: Promise<unknown>): Promise<MigrationError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(MigrationError)
  return error as MigrationError
}

describe('validateMigrations', () => {
  it('accepts no migrations, or contiguous versions from 1', () => {
    expect(() => validateMigrations([])).not.toThrow()
    expect(() => validateMigrations([createItems, addNote, failsHalfway])).not.toThrow()
  })

  it.each<[string, Migration[]]>([
    ['a gap', [createItems, { ...addNote, version: 3 }]],
    ['a duplicate version', [createItems, { ...addNote, version: 1 }]],
    ['the wrong order', [addNote, createItems]],
    ['a first version other than 1', [{ ...createItems, version: 2 }]],
    ['a non-integer version', [{ ...createItems, version: 1.5 }]],
    ['a duplicate name', [createItems, { ...addNote, name: createItems.name }]],
    ['a blank name', [{ ...createItems, name: '  ' }]]
  ])('rejects %s', (_label, migrations) => {
    const error = thrown(() => validateMigrations(migrations))
    expect(error).toBeInstanceOf(MigrationError)
    expect(error).toMatchObject({ code: 'INVALID_MIGRATIONS' })
  })
})

describe('planMigrations', () => {
  it('finds every migration pending on a new database (version 0)', () => {
    expect(planMigrations(openApp(), [createItems, addNote])).toEqual({
      currentVersion: 0,
      latestVersion: 2,
      pending: [createItems, addNote]
    })
  })

  it('finds only the migrations after the current version', () => {
    const db = openApp()
    db.exec('PRAGMA user_version = 1')
    expect(planMigrations(db, [createItems, addNote]).pending).toEqual([addNote])
  })

  it('has nothing pending when the database is current', () => {
    const db = openApp()
    db.exec('PRAGMA user_version = 2')
    expect(planMigrations(db, [createItems, addNote]).pending).toEqual([])
  })

  it('refuses a negative schema version', () => {
    const db = openApp()
    db.exec('PRAGMA user_version = -1')
    const error = thrown(() => planMigrations(db, [createItems]))
    expect(error).toMatchObject({ code: 'UNKNOWN_SCHEMA_VERSION' })
  })

  it('refuses a database newer than the app understands', () => {
    const db = openApp()
    db.exec('PRAGMA user_version = 3')
    const error = thrown(() => planMigrations(db, [createItems, addNote]))
    expect(error).toBeInstanceOf(MigrationError)
    expect(error).toMatchObject({ code: 'DATABASE_TOO_NEW' })
    expect((error as Error).message).toMatch(/schema 3.*up to 2/)
  })
})

describe('migrate', () => {
  it('leaves a new database at version 0 when there are no migrations, and asks for no backup', async () => {
    const db = openApp()
    const backup = recordingBackup()
    await expect(migrate(db, [], { backupBeforeMigrating: backup.hook })).resolves.toEqual({
      fromVersion: 0,
      toVersion: 0,
      applied: []
    })
    expect(backup.calls).toEqual([])
    expect(readUserVersion(db)).toBe(0)
    expect(tables(db)).toEqual([])
  })

  it('applies pending migrations in order and advances user_version', async () => {
    const db = openApp()
    const result = await migrate(db, [createItems, addNote], {
      backupBeforeMigrating: recordingBackup().hook
    })
    expect(result).toEqual({
      fromVersion: 0,
      toVersion: 2,
      applied: ['0001_fixture_items', '0002_fixture_note']
    })
    expect(readUserVersion(db)).toBe(2)
    const columns = db.all<{ name: string }>('PRAGMA table_info(fixture_items)')
    expect(columns.map((column) => column.name)).toEqual(['id', 'label', 'note'])
  })

  it('applies only what is pending on an older database', async () => {
    const db = openApp()
    await migrate(db, [createItems], { backupBeforeMigrating: recordingBackup().hook })
    const result = await migrate(db, [createItems, addNote], {
      backupBeforeMigrating: recordingBackup().hook
    })
    expect(result).toEqual({ fromVersion: 1, toVersion: 2, applied: ['0002_fixture_note'] })
  })

  it('asks for the pre-migration backup once, before the first migration runs', async () => {
    const db = openApp()
    const events: string[] = []
    const traced = [createItems, addNote].map((migration): Migration => ({
      ...migration,
      up: (target) => {
        events.push(`up ${migration.version}`)
        migration.up(target)
      }
    }))
    await migrate(db, traced, {
      backupBeforeMigrating: async (target, plan) => {
        expect(target).toBe(db)
        events.push(`backup ${plan.currentVersion} -> ${plan.latestVersion}`)
      }
    })
    expect(events).toEqual(['backup 0 -> 2', 'up 1', 'up 2'])
  })

  it('applies nothing when the backup fails', async () => {
    const db = openApp()
    const cause = new Error('backup destination is full')
    const error = await migrationError(
      migrate(db, [createItems], {
        backupBeforeMigrating: async () => {
          throw cause
        }
      })
    )
    expect(error.code).toBe('BACKUP_FAILED')
    expect(error.cause).toBe(cause)
    expect(readUserVersion(db)).toBe(0)
    expect(tables(db)).toEqual([])
  })

  it('rolls a failed migration back completely and keeps the earlier ones', async () => {
    const db = openApp()
    const error = await migrationError(
      migrate(db, [createItems, addNote, failsHalfway], {
        backupBeforeMigrating: recordingBackup().hook
      })
    )
    expect(error.code).toBe('MIGRATION_FAILED')
    expect(error.version).toBe(3)
    expect(error.message).toMatch(/0003_fixture_fails/)
    expect((error.cause as Error).message).toBe('simulated migration failure')
    expect(readUserVersion(db)).toBe(2)
    expect(tables(db)).toEqual(['fixture_items'])
    expect(db.inTransaction).toBe(false)
  })

  it('reports a failure that is not an Error object', async () => {
    const db = openApp()
    const throwsText: Migration = {
      version: 1,
      name: '0001_fixture_throws_text',
      checksum: 'sha256:fixture-throws-text',
      up: () => {
        throw 'plain text failure'
      }
    }
    const error = await migrationError(
      migrate(db, [throwsText], { backupBeforeMigrating: recordingBackup().hook })
    )
    expect(error.message).toMatch(/0001_fixture_throws_text.*plain text failure/)
    expect(error.cause).toBe('plain text failure')
  })

  it('records each applied migration inside its transaction', async () => {
    const db = openApp()
    db.exec('CREATE TABLE fixture_log (version INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT')
    await migrate(db, [createItems, addNote], {
      backupBeforeMigrating: recordingBackup().hook,
      recordMigration: (target, migration) =>
        target.run('INSERT INTO fixture_log (version, name) VALUES (?, ?)', [
          migration.version,
          migration.name
        ])
    })
    expect(db.all('SELECT version, name FROM fixture_log ORDER BY version')).toEqual([
      { version: 1, name: '0001_fixture_items' },
      { version: 2, name: '0002_fixture_note' }
    ])
  })

  it('rolls the migration back when recording it fails', async () => {
    const db = openApp()
    const error = await migrationError(
      migrate(db, [createItems], {
        backupBeforeMigrating: recordingBackup().hook,
        recordMigration: () => {
          throw new Error('could not record')
        }
      })
    )
    expect(error).toMatchObject({ code: 'MIGRATION_FAILED', version: 1 })
    expect(readUserVersion(db)).toBe(0)
    expect(tables(db)).toEqual([])
  })

  it('refuses an async migration and rolls it back', async () => {
    const db = openApp()
    const asyncMigration = {
      version: 1,
      name: '0001_fixture_async',
      checksum: 'sha256:fixture-async',
      up: async (target: Db) => target.exec('CREATE TABLE fixture_async (id INTEGER) STRICT')
    } as unknown as Migration
    const error = await migrationError(
      migrate(db, [asyncMigration], { backupBeforeMigrating: recordingBackup().hook })
    )
    expect(error.code).toBe('MIGRATION_FAILED')
    expect(readUserVersion(db)).toBe(0)
    expect(tables(db)).toEqual([])
  })

  it('refuses a newer database before asking for a backup', async () => {
    const db = openApp()
    db.exec('PRAGMA user_version = 9')
    const backup = recordingBackup()
    const error = await migrationError(
      migrate(db, [createItems], { backupBeforeMigrating: backup.hook })
    )
    expect(error.code).toBe('DATABASE_TOO_NEW')
    expect(backup.calls).toEqual([])
    expect(readUserVersion(db)).toBe(9)
  })

  it('refuses an invalid migration list before touching the database', async () => {
    const db = openApp()
    const backup = recordingBackup()
    const error = await migrationError(
      migrate(db, [addNote], { backupBeforeMigrating: backup.hook })
    )
    expect(error.code).toBe('INVALID_MIGRATIONS')
    expect(backup.calls).toEqual([])
    expect(tables(db)).toEqual([])
  })
})

describe('migrate: PRAGMA foreign_key_check after each migration', () => {
  // TEST-ONLY fixtures: a parent and a child table, then migrations that do or do not leave orphans behind.
  const createFamilies: Migration = {
    version: 1,
    name: '0001_fixture_families',
    checksum: 'sha256:fixture-families',
    up: (db) =>
      db.exec(`
        CREATE TABLE fixture_parents (id INTEGER PRIMARY KEY) STRICT;
        CREATE TABLE fixture_children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES fixture_parents (id)
        ) STRICT;
      `)
  }
  /** Defers the foreign key checks, then leaves an orphan: SQLite itself would only object at COMMIT. */
  const leavesDeferredOrphan: Migration = {
    version: 2,
    name: '0002_fixture_deferred_orphan',
    checksum: 'sha256:fixture-deferred-orphan',
    up: (db) =>
      db.exec(
        'PRAGMA defer_foreign_keys = ON; INSERT INTO fixture_children (id, parent_id) VALUES (1, 999)'
      )
  }
  const addsFamily: Migration = {
    version: 2,
    name: '0002_fixture_family',
    checksum: 'sha256:fixture-family',
    up: (db) =>
      db.exec(
        'INSERT INTO fixture_parents (id) VALUES (7); INSERT INTO fixture_children (id, parent_id) VALUES (1, 7)'
      )
  }
  const createsLater: Migration = {
    version: 3,
    name: '0003_fixture_later',
    checksum: 'sha256:fixture-later',
    up: (db) => db.exec('CREATE TABLE fixture_later (id INTEGER PRIMARY KEY) STRICT')
  }

  it('rejects a migration that leaves foreign key violations: it is named, rolled back, and nothing after it runs', async () => {
    const db = openApp()
    db.exec('CREATE TABLE fixture_log (version INTEGER PRIMARY KEY) STRICT')
    const error = await migrationError(
      migrate(db, [createFamilies, leavesDeferredOrphan, createsLater], {
        backupBeforeMigrating: recordingBackup().hook,
        recordMigration: (target, migration) =>
          target.run('INSERT INTO fixture_log (version) VALUES (?)', [migration.version])
      })
    )
    expect(error).toMatchObject({ code: 'FOREIGN_KEY_CHECK_FAILED', version: 2 })
    expect(error.message).toBe(
      'Migration 0002_fixture_deferred_orphan (version 2) left 1 foreign key violation(s), the first in ' +
        'table fixture_children; it was rolled back.'
    )
    expect(readUserVersion(db)).toBe(1)
    expect(db.all('SELECT * FROM fixture_children')).toEqual([])
    expect(db.all('SELECT version FROM fixture_log')).toEqual([{ version: 1 }])
    expect(tables(db)).toEqual(['fixture_children', 'fixture_log', 'fixture_parents'])
    expect(db.inTransaction).toBe(false)
  })

  it('catches violations on a connection that does not enforce foreign keys, where they would otherwise be committed', async () => {
    const db = temp.track(openSqlite(temp.file('raw.db')))
    db.exec('PRAGMA foreign_keys = OFF')
    const leavesOrphan: Migration = {
      ...leavesDeferredOrphan,
      up: (target) => target.exec('INSERT INTO fixture_children (id, parent_id) VALUES (1, 999)')
    }
    const error = await migrationError(
      migrate(db, [createFamilies, leavesOrphan], { backupBeforeMigrating: recordingBackup().hook })
    )
    expect(error).toMatchObject({ code: 'FOREIGN_KEY_CHECK_FAILED', version: 2 })
    expect(readUserVersion(db)).toBe(1)
    expect(db.all('SELECT * FROM fixture_children')).toEqual([])
  })

  it('accepts migrations that leave every reference valid', async () => {
    const db = openApp()
    await expect(
      migrate(db, [createFamilies, addsFamily, createsLater], {
        backupBeforeMigrating: recordingBackup().hook
      })
    ).resolves.toEqual({
      fromVersion: 0,
      toVersion: 3,
      applied: ['0001_fixture_families', '0002_fixture_family', '0003_fixture_later']
    })
    expect(db.all('SELECT id, parent_id FROM fixture_children')).toEqual([{ id: 1, parent_id: 7 }])
  })
})
