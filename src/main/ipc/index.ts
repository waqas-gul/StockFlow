import { z } from 'zod'
import type { IpcChannel } from '@shared/ipc-contract'
import { CompanyCreateSchema, CompanyUpdateSchema } from '@shared/companies'
import {
  BalanceAdjustmentInputSchema,
  CustomerCreateSchema,
  CustomerIdSchema,
  CustomerLedgerInputSchema,
  CustomerListInputSchema,
  CustomerSearchInputSchema,
  CustomerUpdateSchema
} from '@shared/customers'
import {
  InvoiceContextInputSchema,
  InvoiceCreateSchema,
  InvoiceDispatchUpdateSchema,
  InvoiceIdSchema,
  InvoiceListInputSchema,
  InvoiceVoidInputSchema
} from '@shared/invoices'
import {
  PaymentCreateSchema,
  PaymentDuplicateCheckSchema,
  PaymentIdSchema,
  PaymentListInputSchema,
  PaymentVoidInputSchema
} from '@shared/payments'
import {
  ProductCreateSchema,
  ProductIdSchema,
  ProductListInputSchema,
  ProductSearchInputSchema,
  ProductUpdateSchema
} from '@shared/products'
import {
  ExpenseCategoryCreateSchema,
  ExpenseCategoryUpdateSchema,
  ExpenseCreateSchema,
  ExpenseIdSchema,
  ExpenseListInputSchema,
  ExpenseSummaryInputSchema,
  ExpenseUpdateSchema
} from '@shared/expenses'
import { InvoicePrintInputSchema } from '@shared/invoice-print'
import {
  ExpenseReportInputSchema,
  ReportPeriodSchema,
  SalesReportInputSchema
} from '@shared/reports'
import { EditableSettingsPatchSchema } from '@shared/settings'
import {
  AdjustmentListInputSchema,
  PostingFloorInputSchema,
  ReceiptListInputSchema,
  ReceiptVoidInputSchema,
  StockAdjustmentInputSchema,
  StockCardInputSchema,
  StockIdSchema,
  StockReceiptInputSchema
} from '@shared/stock'
import { RESTORE_CONFIRMATION } from '@shared/types/backup'
import { SetActiveSchema } from '@shared/validation'
import { readAppInfo, type AppInfoSources } from '../app-info'
import type { DataSafetyContext } from '../db/context'
import type { BackupService } from '../services/backup.service'
import {
  createCompany,
  listCompanies,
  setCompanyActive,
  updateCompany
} from '../services/companies.service'
import {
  adjustCustomerBalance,
  createCustomer,
  customerLedger,
  getCustomer,
  listCustomers,
  searchCustomers,
  setCustomerActive,
  updateCustomer
} from '../services/customers.service'
import {
  createExpenseCategory,
  listExpenseCategories,
  setExpenseCategoryActive,
  updateExpenseCategory
} from '../services/expense-categories.service'
import {
  createExpense,
  getExpense,
  listExpenses,
  summarizeExpenses,
  updateExpense,
  voidExpense
} from '../services/expenses.service'
import {
  customerBalancesReport,
  expenseReport,
  productSalesReport,
  profitLossReport,
  salesReport,
  stockReport
} from '../services/reports.service'
import { readPrintableInvoice, type InvoicePrintService } from '../services/invoice-print.service'
import { voidInvoice } from '../services/invoice-void.service'
import {
  createInvoice,
  getInvoice,
  invoiceContext,
  listInvoices,
  updateInvoiceDispatch
} from '../services/invoices.service'
import type { LiveDatabase } from '../services/live-database'
import { integrityCheckReport } from '../services/maintenance.service'
import {
  checkDuplicatePayment,
  createPayment,
  getPayment,
  listPayments,
  voidPayment
} from '../services/payments.service'
import {
  createProduct,
  getProduct,
  listProducts,
  searchProducts,
  setProductActive,
  updateProduct
} from '../services/products.service'
import type { RestoreService } from '../services/restore.service'
import { readSettingsView, updateSettingsView } from '../services/settings.service'
import {
  adjustStock,
  getReceipt,
  listAdjustments,
  listReceipts,
  postingFloor,
  receiveStock,
  stockCard,
  stockSummary,
  voidReceipt
} from '../services/stock.service'
import {
  registerIpcHandlers,
  type HandlerOptions,
  type IpcHandlers,
  type IpcRegistrar
} from './handle'

export interface IpcDependencies {
  /** The display-only facts of app.info(); its database is `database`. */
  readonly appInfo: Omit<AppInfoSources, 'db'>
  /** The app's database connection. It is refused while a restore runs and once StockFlow restarts. */
  readonly database: LiveDatabase
  readonly backups: BackupService
  readonly restore: RestoreService
  /** Print and Save as PDF of the invoice shown in the print preview. */
  readonly printing: InvoicePrintService
  /** The migrations, clock and log of the running app. */
  readonly ctx: DataSafetyContext
}

/** Every call without input refuses any value, so no path can be passed where none is expected. */
const NO_INPUT = z.undefined()

/** backup.restore: the one-time token from selectRestoreCandidate and the typed confirmation. Never a path. */
export const RestoreRequestSchema = z.strictObject({
  token: z.string().regex(/^[0-9a-f]{32}$/),
  confirmation: z.literal(RESTORE_CONFIRMATION)
})

/** Every allow-listed IPC call and its implementation. The typecheck fails if one is missing. */
export function createIpcHandlers(deps: IpcDependencies): IpcHandlers {
  const { database, backups, restore, printing, ctx } = deps
  return {
    app: {
      info: { input: NO_INPUT, run: () => readAppInfo({ ...deps.appInfo, db: database.get() }) }
    },
    settings: {
      get: { input: NO_INPUT, run: () => readSettingsView(database.get(), ctx.log) },
      update: {
        input: EditableSettingsPatchSchema,
        run: (patch) => updateSettingsView(database.get(), patch)
      }
    },
    backup: {
      status: { input: NO_INPUT, run: () => backups.status() },
      createManual: { input: NO_INPUT, run: () => backups.createManual() },
      openFolder: { input: NO_INPUT, run: () => backups.openFolder() },
      selectRestoreCandidate: { input: NO_INPUT, run: () => restore.selectCandidate() },
      restore: { input: RestoreRequestSchema, run: (request) => restore.restore(request) }
    },
    maintenance: {
      integrityCheck: { input: NO_INPUT, run: () => integrityCheckReport(database.get(), ctx) }
    },
    // The services validate their input again with the same shared schemas.
    companies: {
      list: { input: NO_INPUT, run: () => listCompanies(database.get()) },
      create: { input: CompanyCreateSchema, run: (input) => createCompany(database.get(), input) },
      update: { input: CompanyUpdateSchema, run: (input) => updateCompany(database.get(), input) },
      setActive: { input: SetActiveSchema, run: (input) => setCompanyActive(database.get(), input) }
    },
    products: {
      list: { input: ProductListInputSchema, run: (input) => listProducts(database.get(), input) },
      get: { input: ProductIdSchema, run: (id) => getProduct(database.get(), id) },
      create: { input: ProductCreateSchema, run: (input) => createProduct(database.get(), input) },
      update: { input: ProductUpdateSchema, run: (input) => updateProduct(database.get(), input) },
      setActive: {
        input: SetActiveSchema,
        run: (input) => setProductActive(database.get(), input)
      },
      search: {
        input: ProductSearchInputSchema,
        run: (input) => searchProducts(database.get(), input)
      }
    },
    // Posting dates are checked against the main process's clock, never the renderer's.
    stock: {
      receive: {
        input: StockReceiptInputSchema,
        run: (input) => receiveStock(database.get(), input, ctx.now())
      },
      listReceipts: {
        input: ReceiptListInputSchema,
        run: (input) => listReceipts(database.get(), input)
      },
      getReceipt: { input: StockIdSchema, run: (id) => getReceipt(database.get(), id) },
      voidReceipt: {
        input: ReceiptVoidInputSchema,
        run: (input) => voidReceipt(database.get(), input, ctx.now())
      },
      adjust: {
        input: StockAdjustmentInputSchema,
        run: (input) => adjustStock(database.get(), input, ctx.now())
      },
      listAdjustments: {
        input: AdjustmentListInputSchema,
        run: (input) => listAdjustments(database.get(), input)
      },
      stockCard: { input: StockCardInputSchema, run: (input) => stockCard(database.get(), input) },
      summary: { input: StockIdSchema, run: (id) => stockSummary(database.get(), id) },
      postingFloor: {
        input: PostingFloorInputSchema,
        run: (input) => postingFloor(database.get(), input, ctx.now())
      }
    },
    customers: {
      list: {
        input: CustomerListInputSchema,
        run: (input) => listCustomers(database.get(), input)
      },
      get: { input: CustomerIdSchema, run: (id) => getCustomer(database.get(), id) },
      create: {
        input: CustomerCreateSchema,
        run: (input) => createCustomer(database.get(), input, ctx.now())
      },
      update: {
        input: CustomerUpdateSchema,
        run: (input) => updateCustomer(database.get(), input)
      },
      setActive: {
        input: SetActiveSchema,
        run: (input) => setCustomerActive(database.get(), input)
      },
      ledger: {
        input: CustomerLedgerInputSchema,
        run: (input) => customerLedger(database.get(), input)
      },
      adjustBalance: {
        input: BalanceAdjustmentInputSchema,
        run: (input) => adjustCustomerBalance(database.get(), input, ctx.now())
      },
      search: {
        input: CustomerSearchInputSchema,
        run: (input) => searchCustomers(database.get(), input)
      }
    },
    payments: {
      list: { input: PaymentListInputSchema, run: (input) => listPayments(database.get(), input) },
      get: { input: PaymentIdSchema, run: (id) => getPayment(database.get(), id) },
      create: {
        input: PaymentCreateSchema,
        run: (input) => createPayment(database.get(), input, ctx.now())
      },
      checkDuplicate: {
        input: PaymentDuplicateCheckSchema,
        run: (input) => checkDuplicatePayment(database.get(), input)
      },
      void: {
        input: PaymentVoidInputSchema,
        run: (input) => voidPayment(database.get(), input, ctx.now())
      }
    },
    invoices: {
      context: {
        input: InvoiceContextInputSchema,
        run: (input) => invoiceContext(database.get(), input, ctx.now())
      },
      post: {
        input: InvoiceCreateSchema,
        run: (input) => createInvoice(database.get(), input, ctx.now())
      },
      list: { input: InvoiceListInputSchema, run: (input) => listInvoices(database.get(), input) },
      get: { input: InvoiceIdSchema, run: (id) => getInvoice(database.get(), id) },
      updateDispatch: {
        input: InvoiceDispatchUpdateSchema,
        run: (input) => updateInvoiceDispatch(database.get(), input, ctx.now())
      },
      void: {
        input: InvoiceVoidInputSchema,
        run: (input) => voidInvoice(database.get(), input, ctx.now())
      },
      // Printing is read-only; the main process opens the print and Save dialogs.
      printable: { input: InvoiceIdSchema, run: (id) => readPrintableInvoice(database.get(), id) },
      print: { input: InvoicePrintInputSchema, run: (input) => printing.print(input) },
      savePdf: { input: InvoicePrintInputSchema, run: (input) => printing.savePdf(input) }
    },
    expenseCategories: {
      list: { input: NO_INPUT, run: () => listExpenseCategories(database.get()) },
      create: {
        input: ExpenseCategoryCreateSchema,
        run: (input) => createExpenseCategory(database.get(), input)
      },
      update: {
        input: ExpenseCategoryUpdateSchema,
        run: (input) => updateExpenseCategory(database.get(), input)
      },
      setActive: {
        input: SetActiveSchema,
        run: (input) => setExpenseCategoryActive(database.get(), input)
      }
    },
    // Expense dates are checked against the main process's clock (today or earlier).
    expenses: {
      list: { input: ExpenseListInputSchema, run: (input) => listExpenses(database.get(), input) },
      summary: {
        input: ExpenseSummaryInputSchema,
        run: (input) => summarizeExpenses(database.get(), input)
      },
      get: { input: ExpenseIdSchema, run: (id) => getExpense(database.get(), id) },
      create: {
        input: ExpenseCreateSchema,
        run: (input) => createExpense(database.get(), input, ctx.now())
      },
      update: {
        input: ExpenseUpdateSchema,
        run: (input) => updateExpense(database.get(), input, ctx.now())
      },
      void: { input: ExpenseIdSchema, run: (id) => voidExpense(database.get(), id) }
    },
    // Read-only: every report is summed from the saved records on request.
    reports: {
      profitLoss: {
        input: ReportPeriodSchema,
        run: (input) => profitLossReport(database.get(), input)
      },
      sales: { input: SalesReportInputSchema, run: (input) => salesReport(database.get(), input) },
      productSales: {
        input: ReportPeriodSchema,
        run: (input) => productSalesReport(database.get(), input)
      },
      stock: { input: NO_INPUT, run: () => stockReport(database.get()) },
      customerBalances: { input: NO_INPUT, run: () => customerBalancesReport(database.get()) },
      expenses: {
        input: ExpenseReportInputSchema,
        run: (input) => expenseReport(database.get(), input)
      }
    }
  }
}

/** Registers every contract call with Electron's `ipcMain`, which src/main/index.ts passes in. */
export function registerIpc(
  registrar: IpcRegistrar,
  deps: IpcDependencies,
  options: HandlerOptions
): IpcChannel[] {
  return registerIpcHandlers(registrar, createIpcHandlers(deps), options)
}
