import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAppInfo, type AppInfoSources } from './app-info'
import type { Db } from './db/adapter'
import { openDatabase } from './db/connection'
import { createTempDir, type TempDir } from './db/test-utils'

let temp: TempDir

beforeEach(() => {
  temp = createTempDir()
})

afterEach(() => {
  temp.remove()
})

function sources(db: Db, overrides: Partial<AppInfoSources> = {}): AppInfoSources {
  return {
    db,
    appVersion: '1.0.0',
    isDev: true,
    dataDir: 'C:\\Users\\owner\\AppData\\Roaming\\StockFlow-dev\\data',
    appDataPath: 'C:\\Users\\owner\\AppData\\Roaming',
    ...overrides
  }
}

describe('readAppInfo', () => {
  it('reports safe facts about the app and its open database', () => {
    const db = temp.track(openDatabase(temp.file('shop.db')))
    expect(readAppInfo(sources(db))).toEqual({
      appVersion: '1.0.0',
      mode: 'development',
      databaseDriver: 'better-sqlite3',
      sqliteVersion: expect.stringMatching(/^3\.\d+\.\d+$/),
      schemaVersion: 0,
      dataDirectory: '%APPDATA%\\StockFlow-dev\\data'
    })
  })

  it('reports production mode and the live schema version', () => {
    const db = temp.track(openDatabase(temp.file('shop.db')))
    db.exec('PRAGMA user_version = 7')
    const info = readAppInfo(
      sources(db, { isDev: false, dataDir: 'C:\\Users\\owner\\AppData\\Roaming\\StockFlow\\data' })
    )
    expect(info).toMatchObject({
      mode: 'production',
      schemaVersion: 7,
      dataDirectory: '%APPDATA%\\StockFlow\\data'
    })
  })

  it('never includes the full user path', () => {
    const db = temp.track(openDatabase(temp.file('shop.db')))
    expect(JSON.stringify(readAppInfo(sources(db)))).not.toMatch(/owner|Users/i)
  })
})
