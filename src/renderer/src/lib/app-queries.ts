import {
  keepPreviousData,
  queryOptions,
  type QueryClient,
  type UseQueryOptions
} from '@tanstack/react-query'
import type {
  Customer,
  CustomerLedger,
  CustomerLedgerInput,
  CustomerListInput,
  CustomerListItem,
  CustomerSearchInput,
  ListPage
} from '@shared/customers'
import type {
  InvoiceContext,
  InvoiceContextInput,
  InvoiceDetail,
  InvoiceListInput,
  InvoiceSummary
} from '@shared/invoices'
import type { PrintableInvoice } from '@shared/invoice-print'
import type { PaymentDetail, PaymentListInput, PaymentSummary } from '@shared/payments'
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

/** `window.api.customers.list(...)`: one page of the Customers table with balances. */
export function customerListQuery(
  input: CustomerListInput
): UseQueryOptions<
  ListPage<CustomerListItem>,
  Error,
  ListPage<CustomerListItem>,
  ReturnType<typeof queryKeys.customers.list>
> {
  return queryOptions({
    queryKey: queryKeys.customers.list(input),
    queryFn: () => unwrap(window.api.customers.list(input)),
    placeholderData: keepPreviousData
  })
}

/** `window.api.customers.get(id)`: always read fresh (the balance and posting-date floor come from the ledger). */
export function customerQuery(
  id: number
): UseQueryOptions<Customer, Error, Customer, ReturnType<typeof queryKeys.customers.detail>> {
  return queryOptions({
    queryKey: queryKeys.customers.detail(id),
    queryFn: () => unwrap(window.api.customers.get(id)),
    staleTime: 0
  })
}

/** `window.api.customers.search(...)`: quick customer lookup. */
export function customerSearchQuery(
  input: CustomerSearchInput
): UseQueryOptions<
  readonly CustomerListItem[],
  Error,
  readonly CustomerListItem[],
  ReturnType<typeof queryKeys.customers.search>
> {
  return queryOptions({
    queryKey: queryKeys.customers.search(input),
    queryFn: () => unwrap(window.api.customers.search(input)),
    placeholderData: keepPreviousData
  })
}

/** `window.api.customers.ledger(...)`: one page of a customer's ledger with the running balance. */
export function customerLedgerQuery(
  input: CustomerLedgerInput
): UseQueryOptions<
  CustomerLedger,
  Error,
  CustomerLedger,
  ReturnType<typeof queryKeys.customers.ledger>
> {
  return queryOptions({
    queryKey: queryKeys.customers.ledger(input),
    queryFn: () => unwrap(window.api.customers.ledger(input)),
    placeholderData: keepPreviousData,
    staleTime: 0
  })
}

/** `window.api.payments.list(...)`: payments, newest first. */
export function paymentListQuery(
  input: PaymentListInput
): UseQueryOptions<
  ListPage<PaymentSummary>,
  Error,
  ListPage<PaymentSummary>,
  ReturnType<typeof queryKeys.payments.list>
> {
  return queryOptions({
    queryKey: queryKeys.payments.list(input),
    queryFn: () => unwrap(window.api.payments.list(input)),
    placeholderData: keepPreviousData
  })
}

/** `window.api.payments.get(id)`: one payment as saved. */
export function paymentQuery(
  id: number
): UseQueryOptions<
  PaymentDetail,
  Error,
  PaymentDetail,
  ReturnType<typeof queryKeys.payments.detail>
> {
  return queryOptions({
    queryKey: queryKeys.payments.detail(id),
    queryFn: () => unwrap(window.api.payments.get(id)),
    staleTime: 0
  })
}

/** `window.api.invoices.context(...)`: today, the next invoice number (a preview) and the posting-date floor. */
export function invoiceContextQuery(
  input: InvoiceContextInput
): UseQueryOptions<
  InvoiceContext,
  Error,
  InvoiceContext,
  ReturnType<typeof queryKeys.invoices.context>
> {
  return queryOptions({
    queryKey: queryKeys.invoices.context(input),
    queryFn: () => unwrap(window.api.invoices.context(input)),
    placeholderData: keepPreviousData,
    staleTime: 0
  })
}

/** `window.api.invoices.list(...)`: Invoice History, newest first. */
export function invoiceListQuery(
  input: InvoiceListInput
): UseQueryOptions<
  ListPage<InvoiceSummary>,
  Error,
  ListPage<InvoiceSummary>,
  ReturnType<typeof queryKeys.invoices.list>
> {
  return queryOptions({
    queryKey: queryKeys.invoices.list(input),
    queryFn: () => unwrap(window.api.invoices.list(input)),
    placeholderData: keepPreviousData
  })
}

/** `window.api.invoices.get(id)`: always read fresh (its payment may have been voided since). */
export function invoiceQuery(
  id: number
): UseQueryOptions<
  InvoiceDetail,
  Error,
  InvoiceDetail,
  ReturnType<typeof queryKeys.invoices.detail>
> {
  return queryOptions({
    queryKey: queryKeys.invoices.detail(id),
    queryFn: () => unwrap(window.api.invoices.get(id)),
    staleTime: 0
  })
}

/**
 * `window.api.invoices.printable(id)`: the printed invoice, always read fresh (its dispatch details, status or the
 * business settings may have changed since).
 */
export function printableInvoiceQuery(
  id: number
): UseQueryOptions<
  PrintableInvoice,
  Error,
  PrintableInvoice,
  ReturnType<typeof queryKeys.invoices.print>
> {
  return queryOptions({
    queryKey: queryKeys.invoices.print(id),
    queryFn: () => unwrap(window.api.invoices.printable(id)),
    staleTime: 0
  })
}

/**
 * After an invoice is posted or voided: stock and products (quantities), customers and payments (balances, the counter payment),
 * invoices (the next number) and settings (the currency decimal places lock) are read again.
 */
export function refreshAfterInvoice(queryClient: QueryClient): void {
  refreshAfterStockChange(queryClient)
  refreshAfterCustomerChange(queryClient)
  void queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all })
}

/**
 * After a customer, payment, void or balance adjustment: customers (balances), payments, invoices (the status of a
 * counter payment) and settings (the currency decimal places lock once financial data exists) are read again.
 */
export function refreshAfterCustomerChange(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all })
  void queryClient.invalidateQueries({ queryKey: queryKeys.payments.all })
  void queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all })
  void queryClient.invalidateQueries({ queryKey: queryKeys.settings })
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
