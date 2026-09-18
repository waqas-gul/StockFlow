import type { CustomerLedgerInput, CustomerListInput, CustomerSearchInput } from '@shared/customers'
import type { ExpenseListInput, ExpenseSummaryInput } from '@shared/expenses'
import type { InvoiceContextInput, InvoiceListInput } from '@shared/invoices'
import type { PaymentListInput } from '@shared/payments'
import type { ProductListInput, ProductSearchInput } from '@shared/products'
import type { ExpenseReportInput, ReportPeriod, SalesReportInput } from '@shared/reports'
import type { AdjustmentListInput, ReceiptListInput, StockCardInput } from '@shared/stock'
import type {
  SupplierLedgerInput,
  SupplierListInput,
  SupplierPaymentListInput,
  SupplierSearchInput
} from '@shared/suppliers'

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
    postingFloor: (productIds: readonly number[], supplierId: number | null = null) =>
      ['stock', 'posting-floor', productIds, supplierId] as const
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
  suppliers: {
    /** Every supplier query: invalidated after any supplier, purchase, supplier payment or balance change. */
    all: ['suppliers'] as const,
    list: (input: SupplierListInput) => ['suppliers', 'list', input] as const,
    detail: (id: number) => ['suppliers', 'detail', id] as const,
    search: (input: SupplierSearchInput) => ['suppliers', 'search', input] as const,
    ledger: (input: SupplierLedgerInput) => ['suppliers', 'ledger', input] as const
  },
  supplierPayments: {
    /** Every supplier payment query: invalidated after any supplier payment, void or supplier purchase. */
    all: ['supplier-payments'] as const,
    list: (input: SupplierPaymentListInput) => ['supplier-payments', 'list', input] as const,
    detail: (id: number) => ['supplier-payments', 'detail', id] as const
  },
  invoices: {
    /** Every invoice query: invalidated after an invoice is posted, voided or its dispatch details change. */
    all: ['invoices'] as const,
    context: (input: InvoiceContextInput) => ['invoices', 'context', input] as const,
    list: (input: InvoiceListInput) => ['invoices', 'list', input] as const,
    detail: (id: number) => ['invoices', 'detail', id] as const,
    print: (id: number) => ['invoices', 'print', id] as const
  },
  expenseCategories: ['expense-categories'] as const,
  expenses: {
    /** Every expense query: invalidated after an expense or category is saved, edited or voided. */
    all: ['expenses'] as const,
    list: (input: ExpenseListInput) => ['expenses', 'list', input] as const,
    summary: (input: ExpenseSummaryInput) => ['expenses', 'summary', input] as const
  },
  reports: {
    /** Every report query. Reports are read again whenever they are shown (staleTime 0), so no change invalidates them. */
    all: ['reports'] as const,
    profitLoss: (input: ReportPeriod) => ['reports', 'profit-loss', input] as const,
    sales: (input: SalesReportInput) => ['reports', 'sales', input] as const,
    productSales: (input: ReportPeriod) => ['reports', 'product-sales', input] as const,
    stock: ['reports', 'stock'] as const,
    customerBalances: ['reports', 'customer-balances'] as const,
    supplierBalances: ['reports', 'supplier-balances'] as const,
    expenses: (input: ExpenseReportInput) => ['reports', 'expenses', input] as const
  },
  /** The Dashboard overview: read again whenever it is shown (staleTime 0), so no change invalidates it. */
  dashboard: ['dashboard'] as const
}
