import { keepPreviousData, queryOptions, type UseQueryOptions } from '@tanstack/react-query'
import type { Product, ProductListInput, ProductListPage } from '@shared/products'
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

/** `window.api.companies.list()`: every company, active or not. */
export const companiesQuery = queryOptions({
  queryKey: queryKeys.companies,
  queryFn: () => unwrap(window.api.companies.list())
})

/** `window.api.products.list(...)`: one page of the Products table; the previous page stays shown while loading. */
export function productListQuery(
  input: ProductListInput
): UseQueryOptions<
  ProductListPage,
  Error,
  ProductListPage,
  ReturnType<typeof queryKeys.products.list>
> {
  return queryOptions({
    queryKey: queryKeys.products.list(input),
    queryFn: () => unwrap(window.api.products.list(input)),
    placeholderData: keepPreviousData
  })
}

/** `window.api.products.get(id)`: always read fresh for the edit form (its unit lock state comes from the database). */
export function productQuery(
  id: number
): UseQueryOptions<Product, Error, Product, ReturnType<typeof queryKeys.products.detail>> {
  return queryOptions({
    queryKey: queryKeys.products.detail(id),
    queryFn: () => unwrap(window.api.products.get(id)),
    staleTime: 0
  })
}
