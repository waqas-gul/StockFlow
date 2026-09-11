import { queryOptions } from '@tanstack/react-query'
import { unwrap } from './api'
import { queryKeys } from './query-keys'

/** `window.api.app.info()`. Version, driver and schema are fixed for the session, so it is fetched once. */
export const appInfoQuery = queryOptions({
  queryKey: queryKeys.app.info,
  queryFn: () => unwrap(window.api.app.info()),
  staleTime: Infinity
})
