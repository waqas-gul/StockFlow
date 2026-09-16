import { queryOptions } from '@tanstack/react-query'
import { unwrap } from './api'
import { queryKeys } from './query-keys'

/** `window.api.app.info()`. Version, driver and schema are fixed for the session, so it is fetched once. */
export const appInfoQuery = queryOptions({
  queryKey: queryKeys.app.info,
  queryFn: () => unwrap(window.api.app.info()),
  staleTime: Infinity
})

/** `window.api.settings.get()`: the business, currency and invoice settings. */
export const settingsQuery = queryOptions({
  queryKey: queryKeys.settings,
  queryFn: () => unwrap(window.api.settings.get())
})

/**
 * `window.api.backup.status()`. Refreshed every minute, so an automatic backup that fails while StockFlow runs shows
 * up in the top bar and in Settings.
 */
export const backupStatusQuery = queryOptions({
  queryKey: queryKeys.backup.status,
  queryFn: () => unwrap(window.api.backup.status()),
  refetchInterval: 60_000
})
