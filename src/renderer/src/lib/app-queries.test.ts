import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '@shared/types/app-info'
import { fail, ok } from '@shared/types/result'
import { ApiError } from './api'
import { appInfoQuery, dashboardQuery } from './app-queries'
import { queryKeys } from './query-keys'

const info: AppInfo = {
  appVersion: '1.0.0',
  mode: 'development',
  databaseDriver: 'better-sqlite3',
  sqliteVersion: '3.50.4',
  schemaVersion: 0,
  dataDirectory: '%APPDATA%\\StockFlow-dev\\data'
}

function runQuery(): Promise<AppInfo> {
  return (appInfoQuery.queryFn as () => Promise<AppInfo>)()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('appInfoQuery', () => {
  it('uses the app.info key and stays fresh for the whole session', () => {
    expect(appInfoQuery.queryKey).toEqual(queryKeys.app.info)
    expect(appInfoQuery.staleTime).toBe(Infinity)
  })

  it('asks the main process through window.api.app.info()', async () => {
    const infoCall = vi.fn(async () => ok(info))
    vi.stubGlobal('window', { api: { app: { info: infoCall } } })
    await expect(runQuery()).resolves.toEqual(info)
    expect(infoCall).toHaveBeenCalledWith()
  })

  it('throws a failed answer as an ApiError', async () => {
    vi.stubGlobal('window', {
      api: {
        app: { info: async () => fail({ code: 'DB_ERROR', message: 'The database is busy.' }) }
      }
    })
    await expect(runQuery()).rejects.toBeInstanceOf(ApiError)
  })
})

describe('dashboardQuery', () => {
  it('reads the overview again whenever the Dashboard is shown, through window.api.dashboard.get()', async () => {
    expect(dashboardQuery.queryKey).toEqual(queryKeys.dashboard)
    expect(dashboardQuery.staleTime).toBe(0)
    const getCall = vi.fn(async () => ok({ today: '2026-09-17' }))
    vi.stubGlobal('window', { api: { dashboard: { get: getCall } } })
    await expect((dashboardQuery.queryFn as () => Promise<unknown>)()).resolves.toEqual({
      today: '2026-09-17'
    })
    expect(getCall).toHaveBeenCalledWith()
  })
})
