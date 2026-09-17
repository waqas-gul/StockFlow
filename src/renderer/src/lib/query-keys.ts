import type { CustomerLedgerInput, CustomerListInput, CustomerSearchInput } from '@shared/customers'
import type { InvoiceContextInput, InvoiceListInput } from '@shared/invoices'
import type { PaymentListInput } from '@shared/payments'
import type { ProductListInput, ProductSearchInput } from '@shared/products'
import type { AdjustmentListInput, ReceiptListInput, StockCardInput } from '@shared/stock'

/** TanStack Query keys for every query in the renderer, from one factory (plan §15). */
export const queryKeys = {
  app: {
    info: ['app', 'info'] as const
  },
  settings: ['settings'] as const,
  backup: {
    status: ['backup', 'status'] as const
  },
  companies: ['companies'] as const,
  products: {
    /** Every product query: invalidated after any product, company or stock change. */
    all: ['products'] as const,
    list: (input: ProductListInput) => ['products', 'list', input] as const,
    detail: (id: number) => ['products', 'detail', id] as const,
    search: (input: ProductSearchInput) => ['products', 'search', input] as const
  },
  stock: {
    /** Every stock query: invalidated after any receipt, void or adjustment. */
    all: ['stock'] as const,
    receipts: (input: ReceiptListInput) => ['stock', 'receipts', input] as const,
    receipt: (id: number) => ['stock', 'receipt', id] as const,
    adjustments: (input: AdjustmentListInput) => ['stock', 'adjustments', input] as const,
    card: (input: StockCardInput) => ['stock', 'card', input] as const,
    summary: (productId: number) => ['stock', 'summary', productId] as const,
    postingFloor: (productIds: readonly number[]) => ['stock', 'posting-floor', productIds] as const
  },
  customers: {
    /** Every customer query: invalidated after any customer, payment or balance change. */
    all: ['customers'] as const,
    list: (input: CustomerListInput) => ['customers', 'list', input] as const,
    detail: (id: number) => ['customers', 'detail', id] as const,
    search: (input: CustomerSearchInput) => ['customers', 'search', input] as const,
    ledger: (input: CustomerLedgerInput) => ['customers', 'ledger', input] as const
  },
  payments: {
    /** Every payment query: invalidated after any payment or void. */
    all: ['payments'] as const,
    list: (input: PaymentListInput) => ['payments', 'list', input] as const,
    detail: (id: number) => ['payments', 'detail', id] as const
  },
  invoices: {
    /** Every invoice query: invalidated after an invoice is posted, voided or its dispatch details change. */
    all: ['invoices'] as const,
    context: (input: InvoiceContextInput) => ['invoices', 'context', input] as const,
    list: (input: InvoiceListInput) => ['invoices', 'list', input] as const,
    detail: (id: number) => ['invoices', 'detail', id] as const
  }
}
