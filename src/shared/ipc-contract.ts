// The single source of truth for IPC between the renderer and the main process.
//
// No runtime imports: the sandboxed preload bundles this file and cannot load packages such as Zod.
// Input validation lives with each handler in the main process (src/main/ipc).
import type { Company, CompanyCreateInput, CompanyUpdateInput } from './companies'
import type { DashboardData } from './dashboard'
import type {
  BalanceAdjustmentInput,
  BalanceAdjustmentResult,
  Customer,
  CustomerCreateInput,
  CustomerLedger,
  CustomerLedgerInput,
  CustomerListInput,
  CustomerListItem,
  CustomerSearchInput,
  CustomerUpdateInput,
  ListPage
} from './customers'
import type {
  Expense,
  ExpenseCategory,
  ExpenseCategoryCreateInput,
  ExpenseCategoryUpdateInput,
  ExpenseCreateInput,
  ExpenseListInput,
  ExpenseSaveResult,
  ExpenseSummary,
  ExpenseSummaryInput,
  ExpenseUpdateInput
} from './expenses'
import type {
  InvoiceContext,
  InvoiceContextInput,
  InvoiceCreateInput,
  InvoiceDetail,
  InvoiceDispatchResult,
  InvoiceDispatchUpdateInput,
  InvoiceListInput,
  InvoiceSaveResult,
  InvoiceSummary,
  InvoiceVoidInput,
  InvoiceVoidResult
} from './invoices'
import type {
  InvoicePdfResult,
  InvoicePrintInput,
  InvoicePrintResult,
  PrintableInvoice
} from './invoice-print'
import type {
  DuplicatePaymentCheck,
  PaymentCreateInput,
  PaymentDetail,
  PaymentDuplicateCheckInput,
  PaymentListInput,
  PaymentSaveResult,
  PaymentSummary,
  PaymentVoidInput,
  PaymentVoidResult
} from './payments'
import type {
  Product,
  ProductActiveResult,
  ProductCreateInput,
  ProductListInput,
  ProductListPage,
  ProductSearchInput,
  ProductSearchItem,
  ProductUpdateInput
} from './products'
import type {
  CustomerBalancesReport,
  ExpenseReport,
  ExpenseReportInput,
  ProductSalesReport,
  ProfitLossReport,
  ReportPeriod,
  SalesReport,
  SalesReportInput,
  StockReport
} from './reports'
import type { EditableSettingsPatch, SettingsView } from './settings'
import type {
  AdjustmentListInput,
  PostingFloor,
  PostingFloorInput,
  ReceiptListInput,
  ReceiptVoidInput,
  StockAdjustmentInput,
  StockAdjustmentResult,
  StockAdjustmentSummary,
  StockCard,
  StockCardInput,
  StockPage,
  StockReceiptDetail,
  StockReceiptInput,
  StockReceiptSummary,
  StockSummary
} from './stock'
import type { AppInfo } from './types/app-info'
import type {
  BackupStatus,
  ManualBackupResult,
  RestoreCandidateSelection,
  RestoreRequest,
  RestoreResult
} from './types/backup'
import type { IntegrityCheckReport } from './types/maintenance'
import type { Result } from './types/result'
import type { SetActiveInput } from './validation'

declare const callTypes: unique symbol

/** One allow-listed request/response call. It only carries its input and output types. */
export interface IpcCall<Input, Output> {
  readonly [callTypes]?: { readonly input: Input; readonly output: Output }
}

function call<Input, Output>(): IpcCall<Input, Output> {
  return Object.freeze({})
}

/**
 * Every call the renderer may make, as domain → action. The channel is `<domain>:<action>` and the renderer
 * calls it as `window.api.<domain>.<action>(input)`. Nothing outside this map is reachable over IPC.
 *
 * No call takes a file-system path or a printer: the main process opens the file and print dialogs and keeps what
 * they return.
 */
export const ipcContract = Object.freeze({
  app: Object.freeze({
    /** Safe, display-only facts about the app and its database. */
    info: call<void, AppInfo>()
  }),
  settings: Object.freeze({
    /** The business, currency and invoice settings, and whether the currency decimal places are locked. */
    get: call<void, SettingsView>(),
    /** Saves any of them (validated again by the main process) and returns them all, with the lock. */
    update: call<EditableSettingsPatch, SettingsView>()
  }),
  backup: Object.freeze({
    /** Automatic and manual backup status. */
    status: call<void, BackupStatus>(),
    /** Asks where to save (the main process's Save dialog), then writes a verified backup there. */
    createManual: call<void, ManualBackupResult>(),
    /** Opens the automatic backup folder in File Explorer. */
    openFolder: call<void, void>(),
    /** Asks for a backup (the main process's Open dialog), validates it, and returns its summary and a token. */
    selectRestoreCandidate: call<void, RestoreCandidateSelection>(),
    /** Restores the backup confirmed with that token; StockFlow then restarts. */
    restore: call<RestoreRequest, RestoreResult>()
  }),
  maintenance: Object.freeze({
    /** Runs the read-only integrity check and reports it in plain language. */
    integrityCheck: call<void, IntegrityCheckReport>()
  }),
  companies: Object.freeze({
    /** Every company (brand), active or not, by name. */
    list: call<void, readonly Company[]>(),
    create: call<CompanyCreateInput, Company>(),
    /** Renames a company. */
    update: call<CompanyUpdateInput, Company>(),
    /** Activates or deactivates a company; companies are never deleted. */
    setActive: call<SetActiveInput, Company>()
  }),
  products: Object.freeze({
    /** One page of the Products table: search, company and status filters. */
    list: call<ProductListInput, ProductListPage>(),
    /** One product with its units, stock and unit lock state. */
    get: call<number, Product>(),
    /** Creates a product with its units in one transaction. */
    create: call<ProductCreateInput, Product>(),
    /** Saves a product and its whole unit list in one transaction. */
    update: call<ProductUpdateInput, Product>(),
    /** Activates or deactivates a product; products are never deleted. */
    setActive: call<SetActiveInput, ProductActiveResult>(),
    /** Quick lookup by code, name or company name. */
    search: call<ProductSearchInput, readonly ProductSearchItem[]>()
  }),
  stock: Object.freeze({
    /** Posts a Stock In receipt (one transaction; a repeated request id returns the saved receipt). */
    receive: call<StockReceiptInput, StockReceiptDetail>(),
    /** Receipt history, newest first. */
    listReceipts: call<ReceiptListInput, StockPage<StockReceiptSummary>>(),
    /** One receipt with its lines, void state and corrections. */
    getReceipt: call<number, StockReceiptDetail>(),
    /** Voids a receipt no later stock activity has touched. */
    voidReceipt: call<ReceiptVoidInput, StockReceiptDetail>(),
    /** Posts one stock adjustment (opening stock, damage, corrections, ...). */
    adjust: call<StockAdjustmentInput, StockAdjustmentResult>(),
    /** Adjustment history, newest first. */
    listAdjustments: call<AdjustmentListInput, StockPage<StockAdjustmentSummary>>(),
    /** One page of a product's stock movements with running totals. */
    stockCard: call<StockCardInput, StockCard>(),
    /** A product's current stock quantity and value. */
    summary: call<number, StockSummary>(),
    /** The earliest and latest date a stock document for these products may have. */
    postingFloor: call<PostingFloorInput, PostingFloor>()
  }),
  customers: Object.freeze({
    /** One page of the Customers table with balances: search and status filter. */
    list: call<CustomerListInput, ListPage<CustomerListItem>>(),
    /** One customer with the current balance and the latest ledger date (the posting-date floor). */
    get: call<number, Customer>(),
    /** Creates a customer with the next code and an optional opening balance, in one transaction. */
    create: call<CustomerCreateInput, Customer>(),
    /** Saves the profile only; the ledger is never changed. */
    update: call<CustomerUpdateInput, Customer>(),
    /** Activates or deactivates a customer; customers are never deleted. */
    setActive: call<SetActiveInput, Customer>(),
    /** One page of the customer's ledger with the running balance. */
    ledger: call<CustomerLedgerInput, CustomerLedger>(),
    /** Appends a balance correction (ADJUSTMENT) with its reason. */
    adjustBalance: call<BalanceAdjustmentInput, BalanceAdjustmentResult>(),
    /** Quick lookup by code, name, shop name, phone or city. */
    search: call<CustomerSearchInput, readonly CustomerListItem[]>()
  }),
  payments: Object.freeze({
    /** Payments, newest first: search, date range, status and method filters. */
    list: call<PaymentListInput, ListPage<PaymentSummary>>(),
    /** One payment as saved. */
    get: call<number, PaymentDetail>(),
    /** Posts a payment and its ledger entry (a repeated request id returns the saved payment). */
    create: call<PaymentCreateInput, PaymentSaveResult>(),
    /** Posted payments with the same customer, date and amount, for the soft duplicate warning. */
    checkDuplicate: call<PaymentDuplicateCheckInput, DuplicatePaymentCheck>(),
    /** Voids a posted payment, dated today, adding its amount back to the balance. */
    void: call<PaymentVoidInput, PaymentVoidResult>()
  }),
  invoices: Object.freeze({
    /** The billing screen's context: today, the next invoice number (a preview) and the posting-date floor. */
    context: call<InvoiceContextInput, InvoiceContext>(),
    /**
     * Posts an invoice with its stock movements, ledger entries and counter payment, in one transaction (a repeated
     * request id returns the saved invoice).
     */
    post: call<InvoiceCreateInput, InvoiceSaveResult>(),
    /** Invoice History: newest first, with search, date range and status filters. */
    list: call<InvoiceListInput, ListPage<InvoiceSummary>>(),
    /** One invoice exactly as saved, with its counter payment's status and dispatch change log. */
    get: call<number, InvoiceDetail>(),
    /** Changes the dispatch details (Bilty No, Transport, Adda) of a posted invoice, logging each change. */
    updateDispatch: call<InvoiceDispatchUpdateInput, InvoiceDispatchResult>(),
    /** Voids a posted invoice, dated today: exact stock and account reversals in one transaction. */
    void: call<InvoiceVoidInput, InvoiceVoidResult>(),
    /** The printed invoice: its saved snapshots, current dispatch details and total in words, from one read. */
    printable: call<number, PrintableInvoice>(),
    /** Prints the invoice shown in the print preview: the main process opens the system print dialog. */
    print: call<InvoicePrintInput, InvoicePrintResult>(),
    /** Saves the invoice shown in the print preview as a PDF, where the main process's Save dialog says. */
    savePdf: call<InvoicePrintInput, InvoicePdfResult>()
  }),
  expenseCategories: Object.freeze({
    /** Every expense category (the seeded ones included), active or not, by name. Categories are never deleted. */
    list: call<void, ExpenseCategory[]>(),
    create: call<ExpenseCategoryCreateInput, ExpenseCategory>(),
    /** Renames a category and/or moves it to the other group (Shop or Monthly / General). */
    update: call<ExpenseCategoryUpdateInput, ExpenseCategory>(),
    /** An inactive category stays on its expenses but cannot be chosen for another one. */
    setActive: call<SetActiveInput, ExpenseCategory>()
  }),
  expenses: Object.freeze({
    /** Expenses newest first, with search, group, status and date range filters. */
    list: call<ExpenseListInput, ListPage<Expense>>(),
    /** Active expense totals by group (Shop, Monthly / General) for a date range. */
    summary: call<ExpenseSummaryInput, ExpenseSummary>(),
    get: call<number, Expense>(),
    /** Saves an expense dated today or earlier (a repeated request id returns the saved expense). */
    create: call<ExpenseCreateInput, ExpenseSaveResult>(),
    /** Edits an active expense. */
    update: call<ExpenseUpdateInput, Expense>(),
    /** Voids an active expense; it is never deleted. */
    void: call<number, Expense>()
  }),
  // Read-only reports, derived on request from the saved records. No call runs a query of the renderer's choosing.
  reports: Object.freeze({
    /** Profit & Loss for an inclusive business-date range. */
    profitLoss: call<ReportPeriod, ProfitLossReport>(),
    /** Posted-invoice sales totals for a date range, and one page of its invoices. */
    sales: call<SalesReportInput, SalesReport>(),
    /** Quantity, revenue, frozen COGS and profit per product for a date range. */
    productSales: call<ReportPeriod, ProductSalesReport>(),
    /** Current stock quantity and value of every product. */
    stock: call<void, StockReport>(),
    /** Current balance of every customer, with receivables and advances apart. */
    customerBalances: call<void, CustomerBalancesReport>(),
    /** Active expense totals for a date range, by group and category, and one page of its expenses. */
    expenses: call<ExpenseReportInput, ExpenseReport>()
  }),
  // Read-only: the Dashboard overview, assembled from the reports and lists above in one call.
  dashboard: Object.freeze({
    /** Today, this month, balances, stock, the sales trend and recent activity, for the main process's business date. */
    get: call<void, DashboardData>()
  })
})

export type IpcContract = typeof ipcContract
export type IpcDomain = keyof IpcContract
export type IpcAction<D extends IpcDomain> = keyof IpcContract[D] & string
export type IpcChannel = { [D in IpcDomain]: `${D}:${IpcAction<D>}` }[IpcDomain]

type CallTypes<C> =
  C extends IpcCall<infer Input, infer Output> ? { input: Input; output: Output } : never
export type IpcInput<D extends IpcDomain, A extends IpcAction<D>> = CallTypes<
  IpcContract[D][A]
>['input']
export type IpcOutput<D extends IpcDomain, A extends IpcAction<D>> = CallTypes<
  IpcContract[D][A]
>['output']

/** The renderer-side function for one call. Calls without input take no argument. */
export type IpcFunction<Input, Output> = [Input] extends [void]
  ? () => Promise<Result<Output>>
  : (input: Input) => Promise<Result<Output>>

/** The shape of `window.api`, derived from the contract. */
export type StockFlowApi = {
  readonly [D in IpcDomain]: {
    readonly [A in IpcAction<D>]: IpcFunction<IpcInput<D, A>, IpcOutput<D, A>>
  }
}

export interface IpcCallInfo {
  readonly domain: IpcDomain
  readonly action: string
  readonly channel: IpcChannel
}

export function ipcChannel<D extends IpcDomain, A extends IpcAction<D>>(
  domain: D,
  action: A
): `${D}:${A}` {
  return `${domain}:${action}`
}

/** Every allow-listed call, flattened. The preload exposes exactly these; main registers exactly these. */
export const ipcCalls: readonly IpcCallInfo[] = Object.freeze(
  Object.entries(ipcContract).flatMap(([domain, actions]) =>
    Object.keys(actions).map((action) =>
      Object.freeze({ domain, action, channel: `${domain}:${action}` } as IpcCallInfo)
    )
  )
)
