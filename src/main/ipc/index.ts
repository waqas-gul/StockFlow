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
import { InvoiceContextInputSchema, InvoiceCreateSchema } from '@shared/invoices'
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
import { createInvoice, invoiceContext } from '../services/invoices.service'
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
  const { database, backups, restore, ctx } = deps
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
