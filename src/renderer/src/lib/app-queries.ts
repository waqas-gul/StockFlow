import {
  keepPreviousData,
  queryOptions,
  type QueryClient,
  type UseQueryOptions
} from '@tanstack/react-query'
import type {
  Product,
  ProductListInput,
  ProductListPage,
  ProductSearchInput,
  ProductSearchItem
} from '@shared/products'
import type {
  AdjustmentListInput,
  PostingFloor,
  ReceiptListInput,
  StockAdjustmentSummary,
  StockCard,
  StockCardInput,
  StockPage,
  StockReceiptDetail,
  StockReceiptSummary,
  StockSummary
} from '@shared/stock'
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

/** `window.api.products.search(...)`: quick product lookup for the stock forms. */
export function productSearchQuery(
  input: ProductSearchInput
): UseQueryOptions<
  readonly ProductSearchItem[],
  Error,
  readonly ProductSearchItem[],
  ReturnType<typeof queryKeys.products.search>
> {
  return queryOptions({
    queryKey: queryKeys.products.search(input),
    queryFn: () => unwrap(window.api.products.search(input)),
    placeholderData: keepPreviousData
  })
}

/** `window.api.stock.listReceipts(...)`: receipt history, newest first. */
export function receiptListQuery(
  input: ReceiptListInput
): UseQueryOptions<
  StockPage<StockReceiptSummary>,
  Error,
  StockPage<StockReceiptSummary>,
  ReturnType<typeof queryKeys.stock.receipts>
> {
  return queryOptions({
    queryKey: queryKeys.stock.receipts(input),
    queryFn: () => unwrap(window.api.stock.listReceipts(input)),
    placeholderData: keepPreviousData
  })
}

/** `window.api.stock.getReceipt(id)`: always read fresh (whether it can be voided depends on later activity). */
export function receiptQuery(
  id: number
): UseQueryOptions<
  StockReceiptDetail,
  Error,
  StockReceiptDetail,
  ReturnType<typeof queryKeys.stock.receipt>
> {
  return queryOptions({
    queryKey: queryKeys.stock.receipt(id),
    queryFn: () => unwrap(window.api.stock.getReceipt(id)),
    staleTime: 0
  })
}

/** `window.api.stock.listAdjustments(...)`: adjustment history, newest first. */
export function adjustmentListQuery(
  input: AdjustmentListInput
): UseQueryOptions<
  StockPage<StockAdjustmentSummary>,
  Error,
  StockPage<StockAdjustmentSummary>,
  ReturnType<typeof queryKeys.stock.adjustments>
> {
  return queryOptions({
    queryKey: queryKeys.stock.adjustments(input),
    queryFn: () => unwrap(window.api.stock.listAdjustments(input)),
    placeholderData: keepPreviousData
  })
}

/** `window.api.stock.stockCard(...)`: one page of a product's movements with running totals. */
export function stockCardQuery(
  input: StockCardInput
): UseQueryOptions<StockCard, Error, StockCard, ReturnType<typeof queryKeys.stock.card>> {
  return queryOptions({
    queryKey: queryKeys.stock.card(input),
    queryFn: () => unwrap(window.api.stock.stockCard(input)),
    placeholderData: keepPreviousData,
    staleTime: 0
  })
}

/** `window.api.stock.summary(productId)`: current quantity and value. */
export function stockSummaryQuery(
  productId: number
): UseQueryOptions<StockSummary, Error, StockSummary, ReturnType<typeof queryKeys.stock.summary>> {
  return queryOptions({
    queryKey: queryKeys.stock.summary(productId),
    queryFn: () => unwrap(window.api.stock.summary(productId)),
    staleTime: 0
  })
}

/** `window.api.stock.postingFloor(...)`: the allowed date range for a stock document of these products. */
export function postingFloorQuery(
  productIds: readonly number[]
): UseQueryOptions<
  PostingFloor,
  Error,
  PostingFloor,
  ReturnType<typeof queryKeys.stock.postingFloor>
> {
  return queryOptions({
    queryKey: queryKeys.stock.postingFloor(productIds),
    queryFn: () => unwrap(window.api.stock.postingFloor({ productIds: [...productIds] })),
    placeholderData: keepPreviousData,
    staleTime: 0
  })
}

/**
 * After a receipt, void or adjustment: stock figures, product lists (stock and unit locks) and settings (the currency
 * decimal places lock once financial data exists) are read again.
 */
export function refreshAfterStockChange(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.stock.all })
  void queryClient.invalidateQueries({ queryKey: queryKeys.products.all })
  void queryClient.invalidateQueries({ queryKey: queryKeys.settings })
}
