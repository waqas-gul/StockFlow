import { describe, expect, it } from 'vitest'
import {
  BACKUP_CATEGORIES,
  DATABASE_FILE_NAME,
  backupFolder,
  isSameOrInside,
  resolveDataPaths,
  toDisplayPath
} from './data-paths'

const appData = 'C:\\Users\\owner\\AppData\\Roaming'

describe('resolveDataPaths', () => {
  it('puts the database at <data-root>\\data\\shop.db, the log in logs\\ and the backups in backups\\', () => {
    const root = `${appData}\\StockFlow`
    expect(DATABASE_FILE_NAME).toBe('shop.db')
    expect(resolveDataPaths(root)).toEqual({
      root,
      dataDir: `${root}\\data`,
      databaseFile: `${root}\\data\\shop.db`,
      logsDir: `${root}\\logs`,
      logFile: `${root}\\logs\\app.log`,
      backupsDir: `${root}\\backups`
    })
  })

  it('keeps development and production databases apart', () => {
    expect(resolveDataPaths(`${appData}\\StockFlow`).databaseFile).toBe(
      'C:\\Users\\owner\\AppData\\Roaming\\StockFlow\\data\\shop.db'
    )
    expect(resolveDataPaths(`${appData}\\StockFlow-dev`).databaseFile).toBe(
      'C:\\Users\\owner\\AppData\\Roaming\\StockFlow-dev\\data\\shop.db'
    )
  })
})

describe('backupFolder', () => {
  it('gives each backup category its own folder under <data-root>\\backups', () => {
    const paths = resolveDataPaths(`${appData}\\StockFlow`)
    expect(BACKUP_CATEGORIES).toEqual(['auto', 'pre-migration', 'pre-restore'])
    expect(BACKUP_CATEGORIES.map((category) => backupFolder(paths, category))).toEqual([
      `${appData}\\StockFlow\\backups\\auto`,
      `${appData}\\StockFlow\\backups\\pre-migration`,
      `${appData}\\StockFlow\\backups\\pre-restore`
    ])
  })
})

describe('isSameOrInside', () => {
  const data = `${appData}\\StockFlow\\data`

  it('is true for the folder itself and for anything inside it, compared like Windows', () => {
    expect(isSameOrInside(data, data)).toBe(true)
    expect(isSameOrInside(`${data}\\`, data)).toBe(true)
    expect(isSameOrInside(`${data}\\shop.db`, data)).toBe(true)
    expect(
      isSameOrInside('C:\\USERS\\owner\\appdata\\roaming\\stockflow\\DATA\\x\\y.db', data)
    ).toBe(true)
    expect(isSameOrInside(`${data}\\..\\data\\shop.db`, data)).toBe(true)
  })

  it('is false for a sibling with the same prefix, a parent, or another drive', () => {
    expect(isSameOrInside(`${data}-old\\shop.db`, data)).toBe(false)
    expect(isSameOrInside(`${appData}\\StockFlow\\backups\\auto`, data)).toBe(false)
    expect(isSameOrInside(`${appData}\\StockFlow`, data)).toBe(false)
    expect(isSameOrInside('D:\\Users\\owner\\AppData\\Roaming\\StockFlow\\data', data)).toBe(false)
  })
})

describe('toDisplayPath', () => {
  it('shows a folder inside AppData with %APPDATA% instead of the user path', () => {
    expect(toDisplayPath(`${appData}\\StockFlow\\data`, appData)).toBe('%APPDATA%\\StockFlow\\data')
    expect(toDisplayPath(appData, appData)).toBe('%APPDATA%')
  })

  it('compares the AppData prefix case-insensitively, like Windows', () => {
    expect(toDisplayPath('c:\\users\\OWNER\\appdata\\roaming\\StockFlow-dev\\data', appData)).toBe(
      '%APPDATA%\\StockFlow-dev\\data'
    )
  })

  it('shows only the last folder name for a path outside AppData', () => {
    expect(toDisplayPath('D:\\Private\\Shop\\data', appData)).toBe('…\\data')
    expect(toDisplayPath('C:\\Users\\owner\\AppData\\RoamingX\\data', appData)).toBe('…\\data')
  })
})
