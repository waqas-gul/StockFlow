import { describe, expect, it } from 'vitest'
import { DATABASE_FILE_NAME, resolveDataPaths, toDisplayPath } from './data-paths'

const appData = 'C:\\Users\\owner\\AppData\\Roaming'

describe('resolveDataPaths', () => {
  it('puts the database at <data-root>\\data\\shop.db', () => {
    const root = `${appData}\\StockFlow`
    expect(DATABASE_FILE_NAME).toBe('shop.db')
    expect(resolveDataPaths(root)).toEqual({
      root,
      dataDir: `${root}\\data`,
      databaseFile: `${root}\\data\\shop.db`
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
