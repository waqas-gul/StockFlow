# Shop / Stock Management — V1 Implementation Plan

> Status: **PLANNING ONLY — awaiting approval.** Nothing in this document has been implemented.
> Plan date: 2026-09-10. Based on direct inspection of `D:\waqas\shop-management`.
>
> **Revision 2 (2026-09-10), after review.** Changes:
>
> - Flexible packing/unit model (§9)
> - The client's real invoice fields (§11.1)
> - Safe stock-receipt void rule (§8.5)
> - Posting-date policy for backdating (§11.5)
> - Adjustment reason codes and their P&L mapping (§8.6, §13)
> - Negative stock prohibited, with no setting (§8.3)
> - Mixed-unit sale options (§9.6)
> - Regrouped approval questions (§27)
>
> The overall architecture is unchanged.
>
> **Revision 3 (2026-09-10), final corrections:**
>
> - **Scoped** posting-date floors: per customer and per product, replacing the global floor (§11.5).
> - The receipt-void rule ignores the receipt's own lines (§8.5).
> - An explicit V1 limitation **L1** for late purchase-cost corrections (§8.5, §13, §26–§28).
>
> **Business confirmation gate:** the database schema (Phase 3) is not finalised until the §27 Group A and B
> questions are answered.

---

## Table of Contents

1. Current Codebase Findings
2. Existing Technology/Dependencies
3. Missing Setup/Dependencies
4. V1 Scope
5. Architecture
6. Proposed Folder Structure
7. SQLite Database Design
8. Stock/Inventory Model
9. Box vs Piece Model (Packing / Unit Hierarchy)
10. Customer Balance / Payment Model
11. Invoice Data Model and Workflow
12. Expense Model
13. Profit & Loss Calculation
14. IPC / Preload Security Design
15. React State Management Strategy
16. UI Screens and Navigation
17. Invoice Printing/PDF Strategy
18. Local File/Image Strategy
19. Database Location
20. Backup and Restore Strategy
21. Database Migration Strategy
22. Manual App Update Strategy
23. Validation and Error Handling
24. Testing Strategy
25. Implementation Phases (exact recommended order)
26. Risks / Edge Cases / Failure Scenarios
27. Decisions That Need My Approval
28. Final V1 Acceptance Checklist

---

## 1. Current Codebase Findings

The project is an **unmodified `electron-vite` React + TypeScript template** with some libraries added to
`package.json`. The libraries are installed but not used anywhere. It contains no business code.

### 1.1 Files inspected

| Path | What it contains today |
|---|---|
| `package.json` | name `shop-management`, version `1.0.0`, `main: ./out/main/index.js`, placeholder `author: example.com`. No `productName` field. |
| `electron.vite.config.ts` | `main: {}`, `preload: {}`, renderer with `@vitejs/plugin-react` and alias `@renderer → src/renderer/src`. **No Tailwind plugin registered.** |
| `electron-builder.yml` | Placeholder `appId: com.electron.app`, `productName: shop-management`, NSIS config, mac/linux targets, `npmRebuild: false`, `asarUnpack: resources/**`, and **`publish: generic https://example.com/auto-updates`** (placeholder). |
| `tsconfig.json` | Project references only → `tsconfig.node.json`, `tsconfig.web.json`. |
| `tsconfig.node.json` | Extends `@electron-toolkit/tsconfig/tsconfig.node.json`; includes `electron.vite.config.*`, `src/main/**`, `src/preload/**`. |
| `tsconfig.web.json` | Extends toolkit web config; includes `src/renderer/src/**` and `src/preload/*.d.ts`; `paths: @renderer/*`. |
| `src/main/index.ts` | Template window (900×670, `sandbox: false`, `autoHideMenuBar`), `setWindowOpenHandler` → `shell.openExternal(any url)`, `ipcMain.on('ping')`, `setAppUserModelId('com.electron')`. |
| `src/preload/index.ts` | Exposes `window.electron = electronAPI` (from `@electron-toolkit/preload`) and an empty `window.api = {}`. |
| `src/preload/index.d.ts` | `window.electron: ElectronAPI`, `window.api: unknown`. |
| `src/renderer/index.html` | CSP meta: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`. Title "Electron". |
| `src/renderer/src/main.tsx` | `createRoot` + `StrictMode` + `App`, imports `assets/main.css`. |
| `src/renderer/src/App.tsx` | Template landing page; calls `window.electron.ipcRenderer.send('ping')`. |
| `src/renderer/src/components/Versions.tsx` | Reads `window.electron.process.versions`. |
| `src/renderer/src/assets/*.css` | Hand-written template CSS (`base.css`, `main.css`). **No Tailwind import.** |
| `eslint.config.mjs` | Flat config: toolkit TS + react + react-hooks + react-refresh + prettier. |
| `.prettierrc.yaml` | `singleQuote`, no semicolons, `printWidth: 100`, `trailingComma: none`. |
| `.editorconfig` | 2 spaces, LF, UTF-8. |
| `.vscode/launch.json` | Main + renderer debug configs (remote debugging port 9222). |
| `out/` | Stale build output (`out/main/index.js`, `out/preload/index.js`) matching the template. No renderer output. |
| `build/`, `resources/` | Template icons (`icon.ico`, `icon.icns`, `icon.png`), mac entitlements. |

### 1.2 Observations that affect the plan

1. **The project is not a git repository.** Before Phase 0, run `git init` and make a baseline commit so every
   phase can be reviewed as a diff. (Decision F3.)
2. **Security defaults need hardening.**
   - `sandbox: false` in `webPreferences`.
   - The preload exposes the whole `electronAPI` from `@electron-toolkit/preload`. That includes a **raw
     `ipcRenderer`** (send/invoke/on for any channel) and `process` information. The requirements forbid this.
   - `setWindowOpenHandler` passes **any** URL to `shell.openExternal`.
   - No `will-navigate` guard. No single-instance lock. Two running copies could write to the same database.
   - Good: `contextIsolation` and `nodeIntegration` use Electron's secure defaults (isolation on, Node off), and
     a CSP meta tag already exists.
3. **Identity placeholders exist:** `appId: com.electron.app`, `setAppUserModelId('com.electron')`,
   `author: example.com`. **`productName` and `name` together decide the default `userData` folder.** They
   must be fixed before the first real install, or a later rename will make the data folder look lost.
   (See §19, Decision F2.)
4. **`publish:` points to `https://example.com/auto-updates`.** V1 has no auto-updater, so remove this.
5. **`npmRebuild: false`** in `electron-builder.yml`. Native modules are rebuilt only by the `postinstall`
   script (`electron-builder install-app-deps`). This matters if a native SQLite driver is chosen (§3.2).
6. **Tailwind v4 packages are installed but not wired.** There is no `@tailwindcss/vite` plugin in the config
   and no `@import "tailwindcss"` in CSS.
7. **Renderer-only libraries are listed under `dependencies`** (`zustand`, `@tanstack/react-query`,
   `react-hook-form`, `@hookform/resolvers`, `tailwindcss`, `@tailwindcss/vite`). electron-vite bundles
   renderer code, so these could be `devDependencies`, which keeps `app.asar` smaller. `react`/`react-dom` are
   already dev deps. Low priority cleanup. **`zod` must stay in `dependencies`** because the main process will
   use it at runtime.
8. **No shared-code location.** Zod schemas and IPC types must be shared between main and renderer, but neither
   tsconfig includes a common folder yet (§6).
9. **Toolchain on this machine:** Node `v22.22.2`, npm `10.9.7`, Python 3.14. **No Visual Studio C++ Build
   Tools** (`vswhere.exe` is absent). A native module that has no prebuilt binary **cannot be compiled** here.
10. **Probed at runtime:** Electron `39.8.10` embeds Node `22.22.1` (module ABI `140`). Its built-in
    **`node:sqlite` works** (SQLite `3.51.2`; exports `DatabaseSync`, `StatementSync`, `backup`). It prints an
    "experimental" warning. `PRAGMA foreign_keys` and `STRICT` tables work. This result drives Decision F1.

---

## 2. Existing Technology/Dependencies

Versions below are **installed** versions read from `node_modules/*/package.json`.

| Area | Package | Installed | In package.json as | Wired/used? |
|---|---|---|---|---|
| Desktop shell | `electron` | 39.8.10 | devDependency | Yes (template) |
| Build | `electron-vite` | 5.0.0 | devDependency | Yes |
| Packaging | `electron-builder` | 26.15.3 | devDependency | Yes (config has placeholders) |
| Bundler | `vite` | 7.3.6 | devDependency | Yes |
| React | `react` / `react-dom` | 19.3.0 | devDependency | Yes |
| React plugin | `@vitejs/plugin-react` | 5.2.0 | devDependency | Yes |
| Language | `typescript` | 5.9.3 | devDependency | Yes |
| Electron helpers | `@electron-toolkit/utils` | 4.0.0 | dependency | Yes (`is.dev`, `optimizer`) |
| Electron helpers | `@electron-toolkit/preload` | 3.0.2 | dependency | Yes. **To be removed from the exposed API.** |
| CSS | `tailwindcss` / `@tailwindcss/vite` | 4.3.3 | dependency | **No — not wired** |
| UI state | `zustand` | 5.0.15 | dependency | **No** |
| Async state | `@tanstack/react-query` | 5.102.8 | dependency | **No** |
| Forms | `react-hook-form` | 7.87.0 | dependency | **No** |
| Form ↔ Zod | `@hookform/resolvers` | 5.9.1 | dependency | **No** (v5 supports Zod v4) |
| Validation | `zod` | 4.6.1 | dependency | **No** (note: **Zod v4** API) |
| Lint/format | eslint 9, prettier 3, toolkit configs | — | devDependency | Yes |

Scripts available: `dev`, `build` (typecheck + build), `build:win` / `build:unpack`, `typecheck`, `lint`,
`format`, `start` (preview), `postinstall` (`electron-builder install-app-deps`).

---

## 3. Missing Setup/Dependencies

### 3.1 Confirmed absent (checked in `node_modules`)

| Needed for | Package(s) | Status |
|---|---|---|
| SQLite driver | `better-sqlite3` (+ `@types/better-sqlite3`) **or** built-in `node:sqlite` | Absent / built-in available (F1) |
| Routing | `react-router` (v7, hash router) | Absent (F7) |
| shadcn/ui runtime | `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`, `radix-ui` (or `@radix-ui/*`), `tw-animate-css` | All absent |
| shadcn/ui config | `components.json` | Absent |
| Tests | `vitest` (+ optionally `@testing-library/react`, `jsdom`) | Absent |
| Dates (optional) | `date-fns` | Absent. Probably not needed; dates are plain `YYYY-MM-DD` strings. |

### 3.2 SQLite driver: the key finding

Two options are viable on this machine:

| | **A. `better-sqlite3`** | **B. built-in `node:sqlite`** |
|---|---|---|
| Install | npm package, **native**. It needs a prebuilt binary for Electron ABI 140 because there is no compiler here. | Nothing to install. It ships inside Electron 39. |
| Maturity | Very mature, the de-facto Electron choice | Marked **experimental** in Node 22; the API may change when Electron is upgraded |
| Transactions | `db.transaction(fn)` helper, including nested savepoints | Manual `BEGIN IMMEDIATE / COMMIT / ROLLBACK` wrapper (small, easy to write) |
| Online backup | `db.backup(path)` | `sqlite.backup(db, path)` (export confirmed present) |
| Testing in plain Node | Binary is built for Electron's ABI, so Vitest must run through Electron-as-Node, or you keep a second build | Works identically in Node 22 and Electron 39 |
| Packaging | Needs asar unpack of the `.node` file (electron-builder does this automatically) and a correct rebuild | Nothing extra |

**Recommendation:** use **`better-sqlite3`**, with a **go/no-go spike at the start of Phase 3**:

1. Install it.
2. Confirm that `postinstall` downloads a prebuilt Electron-39 binary. No compilation should happen, since no
   build tools exist here.
3. Confirm the packaged `build:unpack` app opens a database.

If the spike fails, fall back to `node:sqlite`. Services must not depend directly on either driver. They go
through a thin `Db` adapter (`run/get/all/transaction/backup/close`), so switching costs one file. **Approval
needed (F1).**

### 3.3 Setup work required (no code yet)

- Wire the Tailwind v4 Vite plugin into the **renderer** config and replace the template CSS.
- Initialise shadcn/ui: `components.json` and a `cn()` util. Map the alias to `@renderer/...`, and add the same
  `paths` to the root `tsconfig.json`, because the shadcn CLI reads the root config.
- Add a `src/shared/` folder to **both** tsconfigs, plus a Vite alias `@shared`.
- Harden the security config (§14).
- Fix identity: `appId`, `productName`, `setAppUserModelId`, `author`, window title. Remove `publish`. Add a
  single-instance lock.
- Add Vitest and `test` scripts.
- Remove the template UI (`Versions.tsx`, `electron.svg`, `wavy-lines.svg`, template CSS).

---

## 4. V1 Scope

### 4.1 In scope (V1)

| # | Module | Summary |
|---|---|---|
| 1 | Dashboard | Today/month sales, month expenses, gross/net profit, stock value & counts, low-stock list, total receivables |
| 2 | Products & Companies | CRUD, deactivate (never hard-delete once used), code, packing label (verbatim), configurable units per product (⚠ A1/A2), per-unit prices, threshold |
| 3 | Stock In | Receive stock (any defined unit, cost, date, reference), history; void only while no other document has touched its products (§8.5) |
| 3b | Stock Adjustments | Fixed reason codes (damage, expiry, shortage, count surplus, receipt corrections, other), each with a defined P&L treatment (§8.6). **Required** so stock is never edited by hand. |
| 4 | Sales / Billing | Invoice with customer, product search, configurable units (§9), retail/wholesale tier, discount, scheme, freight, balances, the client's invoice fields (Invoice Code, Bilty, Transport, Adda, Ctn, Sch; meanings ⚠ §27 Group B), save, print |
| 5 | Customers | Name, shop, phone, address, city, opening balance, ledger/history |
| 6 | Invoice History | Search/filter, view, reprint, void |
| 7 | Inventory | Ledger-based stock in base units, multi-unit display, quantity/value invariants, stock card per product |
| 8 | Expenses | Categories (Shop / Monthly-General, extendable), date, amount, note |
| 9 | Payments | Receive payment, history, balance impact through the ledger |
| 10 | Profit & Loss | Revenue, COGS (from cost snapshots), gross profit, expenses, stock loss, net profit |
| 11 | Reports | Daily sales, monthly sales, stock, low-stock, customer outstanding, expenses, basic P&L |
| 12 | Settings | Business profile, invoice prefix/numbering, currency, footer, backup settings |
| 13 | Backup / Restore | Manual, automatic, pre-migration, safe restore with validation |

### 4.2 Out of scope (V1)

Cloud sync, mobile app, online accounts, multi-user roles/permissions, multiple warehouses, purchase orders,
tax system (GST/VAT), barcode scanning
(the product-code search field will accept scanner "keyboard" input later with no redesign), e-commerce,
remote DB/PostgreSQL, Express/HTTP server, automatic updater, logo upload (planned as §18 "later"), full sales
returns UI (C3), editing posted invoices (C4), and any user-facing negative-stock option (§8.3).

> **Change after Phase 12 (supplier accounts, migration 0003):** supplier accounting was moved into V1. Suppliers
> (separate from product brands/companies), supplier-linked Stock In, "paid now" and later supplier payments, an
> append-only supplier ledger, balance adjustments, the Supplier Balances report and the Dashboard payables card are
> implemented; see `supplier-accounts-implementation-report.md`. Receipts saved before 0003 keep their free-text
> supplier name and are not linked to any supplier account. Purchase orders and supplier returns remain out of scope.

### 4.3 Future-proofing without over-engineering

- Integer IDs are kept. Transactional tables also get a `request_id` (UUID) column for idempotency. The same
  column can later serve as a sync identity.
- A single `warehouse` is implicit. Adding `location_id` to `stock_movements` later is a normal additive
  migration.
- Business logic lives in main-process **services** behind IPC. A future HTTP/sync layer could call the same
  services.

---

## 5. Architecture

```
┌───────────────────────── Renderer (Chromium, sandboxed) ─────────────────────────┐
│ React 19 + React Router (hash) + Tailwind v4 + shadcn/ui                          │
│ TanStack Query  ── all DB-backed reads/writes (cache, invalidation)               │
│ React Hook Form + Zod (shared schemas)  ── form validation / UX                   │
│ Zustand ── UI-only state (sidebar, invoice draft, filters)                        │
│            calls  window.api.<domain>.<action>(input) : Promise<Result<T>>        │
└───────────────────────────────────────┬───────────────────────────────────────────┘
                                        │ contextBridge (typed, allow-listed functions only)
┌───────────────────────── Preload (sandboxed) ─────────────────────────────────────┐
│ Builds `api` object; each function = ipcRenderer.invoke('<domain>:<action>', input)│
│ No raw ipcRenderer, no fs, no Node, no DB handle exposed                          │
└───────────────────────────────────────┬───────────────────────────────────────────┘
                                        │ IPC (invoke/handle only)
┌───────────────────────── Main process (Node) ─────────────────────────────────────┐
│ ipc/ registerHandlers: sender check → Zod parse → service call → Result envelope  │
│ services/ business rules (invoice, stock, ledger, reports) — SQL + transactions   │
│ db/ connection (pragmas), Db adapter, migrations, backup/restore                  │
│ print/ hidden BrowserWindow → print / printToPDF                                  │
└───────────────────────────────────────┬───────────────────────────────────────────┘
                                        │ single connection, synchronous, WAL
                              SQLite file in %APPDATA%\<AppDataFolder>\data\shop.db
```

Principles:

1. **SQLite is the only source of truth.** The renderer holds caches (TanStack Query) and drafts (Zustand/RHF)
   only.
2. **All business rules run in main.** The renderer only proposes input. Prices, stock, totals, balances, and
   COGS are recomputed and verified in main inside the transaction. The renderer's numbers are for display only.
3. **Append-only ledgers** for stock and customer money. Current values are sums, never hand-edited fields.
4. **Posted documents are immutable.** Corrections are made by voiding/reversing, not by editing.
5. **One process owns the DB.** There is one connection in main, protected by a single-instance lock. The
   driver is synchronous, so writes are serialised by construction.
6. **Money is integers** (minor units). Stock quantities are integers in each product's
   **base unit** (§9).

---

## 6. Proposed Folder Structure

Keeps the existing electron-vite layout and adds one `shared` folder. Abstraction is kept to one layer per
concern.

```
src/
  shared/                         # imported by main AND renderer (pure TS, no Node/DOM APIs)
    schemas/                      # Zod schemas: product, customer, invoice, payment, expense, settings, ...
    types/                        # DTOs inferred from schemas + response types, Result<T>, AppError codes
    ipc-contract.ts               # channel names + input/output type map (single source for preload & main)
    domain/
      money.ts                    # parse/format minor units, half-up rounding, BigInt-safe mul/div
      quantity.ts                 # unit ↔ base-unit conversion + multi-unit display (§9)
      amount-in-words.ts          # number → words (see E2)
      invoice-calc.ts             # pure line/total calculators (used by UI preview AND main)
  main/
    index.ts                      # app lifecycle, single-instance lock, window creation, security guards
    window.ts                     # BrowserWindow factory (secure webPreferences)
    paths.ts                      # data/backup/log directories (dev vs prod)
    db/
      adapter.ts                  # Db interface + chosen driver implementation
      connection.ts               # open, pragmas, application_id check
      migrations/                 # 0001_initial.ts, 0002_... (SQL embedded as TS strings)
      migrate.ts                  # runner: version check, pre-migration backup, per-migration txn
      backup.ts                   # online backup, verify, rotation, restore
    services/                     # one file per domain; SQL lives here (no separate repository layer)
      settings.service.ts  products.service.ts  companies.service.ts  customers.service.ts
      stock.service.ts  invoices.service.ts  payments.service.ts  expenses.service.ts
      reports.service.ts  dashboard.service.ts  sequences.ts
    ipc/
      handle.ts                   # wrapper: sender validation, zod parse, try/catch → Result
      index.ts                    # registers all domain handlers
      products.ipc.ts ...         # thin: schema + service call
    print/
      invoice-print.ts            # hidden window, print/PDF
    logging.ts                    # file logger in userData/logs
  preload/
    index.ts                      # builds typed `api` from ipc-contract, exposes via contextBridge
    index.d.ts                    # `window.api: Api`
  renderer/
    index.html
    src/
      main.tsx                    # QueryClientProvider, RouterProvider
      app/
        router.tsx                # hash routes
        layout/                   # AppShell, Sidebar, TopBar
        query-client.ts
      components/
        ui/                       # shadcn/ui generated components (button, input, dialog, table, ...)
        common/                   # MoneyText, QtyText, DateRangePicker, ConfirmDialog, EmptyState, ...
      features/                   # feature = pages + feature components + hooks (query/mutation)
        dashboard/  products/  stock/  invoices/  customers/  payments/
        expenses/  reports/  settings/  backup/
          e.g. invoices/
            pages/NewInvoicePage.tsx  InvoiceHistoryPage.tsx  InvoiceDetailPage.tsx  InvoicePrintPage.tsx
            components/InvoiceLineTable.tsx  ProductPicker.tsx  CustomerPicker.tsx  TotalsPanel.tsx
            hooks/useInvoices.ts (queries/mutations)
            store/invoiceDraft.store.ts (Zustand)
      lib/
        api.ts                    # unwraps Result<T>, throws typed AppError for TanStack Query
        query-keys.ts
        utils.ts                  # cn()
      assets/main.css             # @import "tailwindcss"; theme tokens
```

Deliberately **not** created: a generic `services/` layer in the renderer (the preload `api` is already the
service), a repository layer in main, or global `types/`/`hooks/` folders. Feature code stays inside its
feature folder.

Config changes this implies (Phase 0/1):

- `tsconfig.node.json` include `src/shared/**`.
- `tsconfig.web.json` include `src/shared/**`.
- `electron.vite.config.ts` alias `@shared` for main/preload/renderer.

## 7. SQLite Database Design

> **Schema freeze gate.** This section is the proposed design. Items marked **⚠** depend on the business
> answers in §27 **Group A** (packing/units) and **Group B** (invoice fields). Migration `0001_initial` is
> **not written until those answers arrive** (Phase 3 gate, §25).
>
> The unit model (§9) keeps the stock mathematics independent of what the packing text means. So the answers
> change product *configuration* and a few nullable, display-only columns. They cannot change how stock
> quantity or value is calculated.

### 7.1 Global conventions

| Concern | Rule |
|---|---|
| Table mode | Every table is `STRICT`, so SQLite rejects wrong types. This was verified to work in the probed SQLite 3.51.2. |
| Primary keys | `id INTEGER PRIMARY KEY` (rowid alias). Human-facing numbers (`invoice_no`, `code`) are separate UNIQUE columns. |
| Money | `INTEGER` in **minor units** (e.g. paisa, where 1 PKR = 100). Column suffix `_minor`. Never `REAL`. |
| Quantities | Stock quantity is `INTEGER` in the product's **base unit** (`qty_base`, §9). Each document line also stores the unit the user entered, the unit's size (`unit_base_qty`) at that moment, and the entered quantity. |
| Percentages | `INTEGER` basis points (`_bps`, 100 bps = 1%, 10000 = 100%). |
| Business dates | `TEXT 'YYYY-MM-DD'` (local calendar date), `CHECK(date(x) = x)`. Stock- and balance-affecting documents follow the posting-date rule in §11.5. |
| Timestamps | `created_at` / `updated_at` `TEXT` ISO-8601 UTC. |
| Booleans | `INTEGER CHECK(x IN (0,1))`. |
| Text search | Names use `COLLATE NOCASE`. |
| Foreign keys | `PRAGMA foreign_keys = ON` on every connection. FKs use `ON DELETE RESTRICT`, so history can never be orphaned. |
| Soft delete | Master data uses `is_active`. Posted documents use `status` (`POSTED` / `VOID`). Ledgers are **append-only**: `BEFORE UPDATE/DELETE` triggers `RAISE(ABORT)`. |
| Idempotency | Documents created from a form carry `request_id TEXT UNIQUE` (a UUID the renderer generates when the form opens). |
| File identity | `PRAGMA application_id = <fixed constant>` marks the file as "ours". `PRAGMA user_version` = schema version. |

Connection pragmas (set on every open):

- `journal_mode = WAL`
- `synchronous = FULL`
- `foreign_keys = ON`
- `busy_timeout = 5000`

### 7.2 Entity overview

```
companies 1─* products 1─* product_units
products  1─* stock_movements *─1 (source: receipt item / invoice item / adjustment)
customers 1─* invoices 1─* invoice_items 1─* invoice_item_quantities *─1 product_units
invoices  1─* invoice_change_log            (dispatch-detail edits only)
customers 1─* customer_ledger *─1 (source: invoice / payment / opening / adjustment)
customers 1─* payments
stock_receipts 1─* stock_receipt_items *─1 product_units
stock_adjustments (one line each, fixed reason codes, optional link to a receipt)
expense_categories 1─* expenses
settings (key/value)   sequences (counters)   schema_migrations
```

### 7.3 Tables

#### `companies` — brands/manufacturers

- **Columns:** `id`, `name TEXT NOT NULL COLLATE NOCASE`, `is_active`, `created_at`, `updated_at`.
- **Unique:** `name`.
- **Soft delete:** `is_active = 0`. A company cannot be deleted while products reference it (FK RESTRICT).

#### `products`

- **Purpose:** product master. Current prices live on `product_units`. Historical prices live on document
  lines.
- **Columns:**
  - `id`, `code TEXT NOT NULL COLLATE NOCASE`, `name TEXT NOT NULL`
  - `company_id → companies(id)` (nullable)
  - `packing_label TEXT`: the client's packing text **exactly as written** (e.g. `1*12*18`). It is
    **display/print only and is never parsed or used in any calculation** (§9).
  - `low_stock_threshold_base INTEGER NOT NULL DEFAULT 0` (in base units)
  - `is_active`, `created_at`, `updated_at`
- **Unique:** `code`.
- **Indexes:** `(name)`, `(company_id)`, `(is_active)`.
- **Rules:**
  - Never hard-deleted once referenced; deactivate instead.
  - Unit definitions are locked after the first stock movement (§9.4).

#### `product_units` **⚠ (structure fixed; which levels each product has depends on A1/A2)**

- **Purpose:** the units a product is counted, bought, and sold in, and **how many base units each contains**.
- **Columns:**
  - `id`, `product_id → products`
  - `name TEXT NOT NULL`: the client's own word, e.g. whatever they call the levels once confirmed.
  - `short_name TEXT`: printed abbreviation.
  - `base_qty INTEGER NOT NULL CHECK(base_qty >= 1)`
  - `is_base` (exactly one per product, and it must have `base_qty = 1`)
  - `can_sell`, `can_purchase`
  - `wholesale_price_minor` (nullable), `retail_price_minor` (nullable). A null price means the unit is not
    sold at that tier.
  - `default_cost_minor` (nullable). **Stock-In form pre-fill only; never used for profit.**
  - `sort_order`, `is_active`, `created_at`, `updated_at`
- **Unique:** `(product_id, name)`, `(product_id, base_qty)`, and a partial unique on `(product_id)
  WHERE is_base = 1`.
- **Checks:** `is_base = 1 ⇒ base_qty = 1`. All prices must be ≥ 0.
- **Service rule (nesting):** sort the units by `base_qty`. Each unit's `base_qty` must be an exact multiple of
  the next smaller unit's `base_qty`. This keeps displays like "4 Ctn + 7 Box + 1 Pcs" exact. If A1 confirms
  non-nested packing, the rule is relaxed and stock is displayed in base units plus the largest unit only.
- **Locking (§9.4):** once the product has any stock movement, the `base_qty` and `is_base` of existing units
  are frozen. Names, prices, `can_sell`, and `is_active` stay editable. New larger units may be added, because
  that does not change the base.

#### `customers`

- **Columns:**
  - `id`, `code TEXT NOT NULL` (auto `C-00001`, internal)
  - `name TEXT NOT NULL COLLATE NOCASE`, `shop_name TEXT COLLATE NOCASE`
  - `phone`, `address`, `city TEXT COLLATE NOCASE`, `notes`
  - `is_active`, `created_at`, `updated_at`
- **Unique:** `code`. **No unique on name.** Pickers show code + name + shop + city + phone.
- **Indexes:** `(name)`, `(shop_name)`, `(phone)`, `(city)`.
- **No balance column.** Balance = `SUM(customer_ledger.amount_minor)`.
- The customer code is **not** assumed to be the printed "Invoice Code" (B1).

#### `customer_ledger` — append-only money ledger

- **Columns:**
  - `id`, `customer_id`, `entry_date TEXT`
  - `type TEXT CHECK IN ('OPENING','INVOICE','INVOICE_VOID','PAYMENT','PAYMENT_VOID','ADJUSTMENT')`
  - `amount_minor INTEGER NOT NULL CHECK(amount_minor <> 0)` (+ means the customer owes more)
  - `invoice_id` (nullable), `payment_id` (nullable), `note`, `created_at`
- **Checks:** type/sign consistency (`INVOICE`, `PAYMENT_VOID` > 0; `PAYMENT`, `INVOICE_VOID` < 0).
- **Unique:** partial unique indexes allow one ledger entry per event: `(invoice_id)` per type,
  `(payment_id)` per type, and `(customer_id) WHERE type='OPENING'`.
- **Indexes:** `(customer_id, entry_date, id)`, `(entry_date)`.
- **Triggers:** block UPDATE/DELETE.
- **Ordering:** entries are ordered by `(entry_date, id)`. The customer's posting-date floor (§11.5) guarantees
  that within each customer's ledger, `id` order never contradicts date order.

#### `invoices` — immutable header + snapshot

- **Identity:**
  - `id`
  - `invoice_no TEXT NOT NULL`: the printed **"INV. Number"**, system-generated (`<prefix><padded seq>`,
    B7).
  - `seq_no INTEGER NOT NULL`, `request_id TEXT NOT NULL`
  - **⚠ `invoice_code TEXT NULL`**: the printed **"Invoice Code"**. **Meaning unconfirmed (B1).** It is *not*
    assumed to equal `invoice_no` or the customer code. It is stored as the literal printed value.
    - If B1 confirms it is derived from another record (e.g. a route, salesman, or customer attribute), that
      source is added in the same migration, and this column still keeps the printed snapshot.
    - If B1 says it is not needed, the column stays null and is hidden on the print.
- **Date & customer snapshot:**
  - `invoice_date` (posting-date rule §11.5), `customer_id`
  - `cust_name`, `cust_shop_name`, `cust_phone`, `cust_address`, `cust_city`
- **⚠ Dispatch details (B4):** `bilty_no TEXT`, `transport_name TEXT` ("Transport Service"),
  `adda_name TEXT` ("Adda Name"), `dispatch_updated_at`.
  - These have no money or stock effect.
  - If B4 confirms they are often known only *after* dispatch, they are the **only** fields editable after
    posting, through "Update dispatch details". Every change is logged in `invoice_change_log`.
- **Pricing:**
  - `price_tier ('RETAIL','WHOLESALE')`
  - `gross_minor` (Σ line gross), `line_discount_minor` (Σ line discount)
  - **⚠ `line_scheme_minor`**: Σ line scheme *amounts*, only if B3 = "scheme is an amount".
  - `extra_discount_minor` (optional, B5)
  - `net_minor`: printed **"Current Invoice"** (⚠ confirm it equals Σ line Net Amount − extra discount, B6)
  - `freight_minor`, `total_minor` = net + freight
- **Money received & balances:**
  - `received_minor` (counter cash, C7)
  - `previous_balance_minor`: the ledger balance **at this invoice's chronological position** (§11.5)
  - `net_outstanding_minor` = previous + total − received (print presentation B6)
- **Cost & status:**
  - `cogs_minor`
  - `status ('POSTED','VOID')`, `void_reason`, `voided_at`, `void_date`
  - `checked_by TEXT`, `notes`, `created_at`
- **Unique:** `invoice_no`, `seq_no`, `request_id`.
- **Indexes:** `(invoice_date)`, `(customer_id, invoice_date)`, `(status, invoice_date)`,
  `(invoice_code)`, `(bilty_no)`.
- **Checks:** all money ≥ 0. `net_minor = gross_minor − line_discount_minor − line_scheme_minor −
  extra_discount_minor` (exact formula ⚠ B3/B6). `total_minor = net_minor + freight_minor`.
- **Immutability trigger:** only these changes are allowed:
  - (a) `POSTED → VOID` with the void columns
  - (b) the three dispatch columns + `dispatch_updated_at`
  - Everything else is blocked. Delete is blocked.

#### `invoice_items` — one row per product line (immutable)

- **Identity:** `id`, `invoice_id`, `line_no`, `product_id`.
- **Snapshots:** `prod_code`, `prod_name`, `company_name`, `packing_label` (printed "Packing", verbatim).
- **Quantity:** `qty_base INTEGER NOT NULL CHECK(qty_base > 0)`: total base units leaving stock for this line.
  It equals Σ of its quantity rows, plus free scheme quantity if B3 says so.
- **Money:**
  - `gross_minor` (Σ quantity-row amounts)
  - `discount_bps` (nullable), `discount_minor`
  - **⚠ scheme (B3). Only the confirmed variant goes into `0001`:**
    - `scheme_qty_base INTEGER NULL`: free goods. They are included in `qty_base`, the SALE movement, and
      `cost_minor`, and generate no revenue.
    - `scheme_minor INTEGER NULL`: scheme as an amount or %, deducted like a discount.
  - **⚠ `ctn_count INTEGER NULL`**: only if B2 says "Ctn" is an *entered* number (e.g. physical cartons
    dispatched). It is **informational and never used in stock math**. If Ctn is *derived* from the quantity,
    there is no column; it is computed at print time.
  - `net_minor`
  - `cost_minor`: **frozen COGS for `qty_base`**, including any free goods (§8.4).
- **Unique:** `(invoice_id, line_no)`. **Index:** `(product_id)`. **Triggers:** block UPDATE/DELETE.

#### `invoice_item_quantities` — quantity/price breakdown of a line (immutable)

- **Columns:**
  - `id`, `invoice_item_id`, `unit_id → product_units`
  - Snapshots: `unit_name`, `unit_short_name`, `unit_base_qty`
  - `quantity INTEGER CHECK(quantity > 0)`
  - `unit_price_minor` (as charged)
  - `amount_minor` = quantity × unit_price_minor
  - `qty_base` = quantity × unit_base_qty
- **Unique:** `(invoice_item_id, unit_id)`.
- **Why a child table:** one schema serves **both** mixed-sale presentations (A3). With Option A, every line has
  exactly one quantity row. With Option B, a line has one row per unit (e.g. 2 Box + 5 Pcs). The decision
  changes the UI and print layout only, never the schema or stock math.

#### `stock_movements` — append-only inventory ledger (source of truth for stock)

- **Columns:**
  - `id`, `product_id`, `movement_date`
  - `type TEXT CHECK IN ('OPENING','STOCK_IN','STOCK_IN_VOID','SALE','SALE_VOID','SALE_RETURN','ADJUST_IN','ADJUST_OUT','COST_CORRECTION')`
  - `qty_base INTEGER NOT NULL` (signed), `value_minor INTEGER NOT NULL` (signed)
  - `receipt_item_id`, `invoice_item_id`, `adjustment_id` (exactly one non-null)
  - `note`, `created_at`
- **Checks:**
  - `type = 'COST_CORRECTION' ⇔ qty_base = 0`, and then `value_minor <> 0`. For every other type,
    `qty_base <> 0`.
  - Sign by type: `OPENING`, `STOCK_IN`, `SALE_VOID`, `SALE_RETURN`, `ADJUST_IN` are positive. `SALE`,
    `STOCK_IN_VOID`, `ADJUST_OUT` are negative.
- **Unique (partial):** `(invoice_item_id)` for `SALE` and for `SALE_VOID`; `(receipt_item_id)` for
  `STOCK_IN` and for `STOCK_IN_VOID`; `(adjustment_id)`.
- **Indexes:** `(product_id, id)`, `(product_id, movement_date)` (per-product posting floor, §11.5),
  `(movement_date)`, `(type, movement_date)`.
- **Triggers:** block UPDATE/DELETE.
- **Invariant** (§8.1): enforced inside every write transaction and re-checked by the integrity tool.

#### `stock_receipts` + `stock_receipt_items` — Stock In

- **`stock_receipts`:**
  - `id`, `receipt_no` (`GRN-000001`), `request_id UNIQUE`, `receipt_date`
  - `supplier_name` (free text), `reference`, `note`, `total_cost_minor`
  - `status ('POSTED','VOID')`, `void_reason`, `void_date`, `created_at`
- **`stock_receipt_items`:**
  - `id`, `receipt_id`, `line_no`, `product_id`, `unit_id`
  - Snapshots: `unit_name`, `unit_base_qty`
  - `quantity`, `qty_base`
  - `unit_cost_minor` (per entered unit), `line_cost_minor` = quantity × unit_cost (exact)
- Receipts use one unit per line. They are internal documents, so a mixed delivery is simply entered as two
  lines.
- **Void is allowed only while no other document has touched the receipt's products (§8.5). The receipt's own
  lines never lock it.** Otherwise the receipt is locked and
  corrected via adjustments linked to it.

#### `stock_adjustments`

- **Columns:**
  - `id`, `adjustment_no` (`ADJ-000001`), `request_id UNIQUE`, `adjustment_date`, `product_id`
  - `reason_code TEXT CHECK IN (§8.6 list)`, `direction ('IN','OUT','VALUE')`
  - `unit_id` + snapshots, `quantity`, `qty_base` (0 for `VALUE`)
  - `value_minor`
  - `receipt_id → stock_receipts` (required for receipt corrections, else null)
  - `reason_note TEXT NOT NULL`, `created_at`
- **Reason codes** are a **fixed list in V1**, not user-editable, because each code maps to a defined P&L
  treatment (§8.6, §13).

#### `payments`

- **Columns:**
  - `id`, `payment_no` (`RCP-000001`), `request_id UNIQUE`, `customer_id`, `payment_date`
  - `amount_minor CHECK(> 0)`, `method ('CASH','BANK','CHEQUE','OTHER')`, `reference`
  - `invoice_id` (nullable, informational)
  - `status`, `void_reason`, `voided_at`, `void_date`, `note`, `created_at`
- **Indexes:** `(customer_id, payment_date)`, `(payment_date)`.
- **Immutability:** only `POSTED → VOID` is allowed.

#### `expense_categories` + `expenses`

- **`expense_categories`:** `id`, `name UNIQUE NOCASE`, `grp ('SHOP','GENERAL')`, `is_active`. Seeded with
  "Shop Expenses", "Monthly / General Expenses", and a few examples.
- **`expenses`:** `id`, `request_id UNIQUE`, `expense_date`, `category_id`, `amount_minor CHECK(> 0)`,
  `description`, `status ('ACTIVE','VOID')`, `created_at`, `updated_at`.
- **Indexes:** `(expense_date)`, `(category_id, expense_date)`.
- Expenses are exempt from the posting-date rule, because they affect neither stock nor customer balances.

#### `invoice_change_log` — audit of post-save dispatch edits (append-only)

- **Columns:** `id`, `invoice_id`, `field`, `old_value`, `new_value`, `changed_at`, `note`.

#### `settings`

- **Columns:** `key TEXT PRIMARY KEY`, `value TEXT` (JSON, Zod-validated per key), `updated_at`.
- **Keys:**
  - Business profile: `business.name`, `business.address`, `business.phone`
  - Currency: `currency.code`, `currency.symbol`, `currency.minorDigits`
  - Invoice: `invoice.prefix`, `invoice.padding`, `invoice.startNumber` (B7), `invoice.footer`,
    `invoice.defaultCheckedBy`, `invoice.paperSize` (E1)
  - ⚠ Invoice field toggles: `invoice.showInvoiceCode` (B1), `invoice.showDispatchFields` (B4)
  - Backup: `backup.autoEnabled`, `backup.keepDaily`, `backup.keepMonthly`, `backup.extraFolder`
- **There is no negative-stock setting.** Negative stock is prohibited in V1 (§8.3).

#### `sequences`

- **Columns:** `name TEXT PRIMARY KEY` (`invoice`, `receipt`, `payment`, `adjustment`, `customer`),
  `next_value INTEGER NOT NULL`.
- Incremented inside the same transaction as the document insert. A rollback never burns a number.
  `invoice.startNumber` seeds the first value, so the app can continue the client's existing paper series
  (B7).

#### `schema_migrations`

- **Columns:** `version INTEGER PRIMARY KEY`, `name`, `applied_at`, `app_version`, `checksum`. Mirrors
  `PRAGMA user_version` (§21).

### 7.4 Views

- `v_product_stock(product_id, qty_base, value_minor)`: `SUM` over `stock_movements`.
- `v_customer_balance(customer_id, balance_minor)`: `SUM` over `customer_ledger`.

Indexed SUMs are fast at V1 volumes. A cached stock table can be added later without changing the model.

### 7.5 Integrity check tool (Settings → Maintenance)

Runs these checks:

- `PRAGMA integrity_check`, `PRAGMA foreign_key_check`
- Per product: Q ≥ 0, V ≥ 0, and Q = 0 ⇒ V = 0
- Each posted invoice: header totals = Σ lines; each line's `qty_base` = Σ its quantity rows (+ scheme qty);
  exactly one `SALE` movement per line; exactly one `INVOICE` ledger entry
- Each voided invoice/receipt has matching reversal rows
- Within each product's movements and within each customer's ledger, dates never decrease in `id` order
  (scoped floors, §11.5)

It reports only. It never auto-fixes.

---

## 8. Stock/Inventory Model

### 8.1 Rule: stock is never a stored, editable number

```
Q (current stock, base units) = Σ stock_movements.qty_base     for the product
V (inventory value, minor)    = Σ stock_movements.value_minor  for the product

  OPENING + STOCK_IN + SALE_RETURN + SALE_VOID + ADJUST_IN
− SALE − STOCK_IN_VOID − ADJUST_OUT
= Q          (COST_CORRECTION changes V only)
```

**Invariants.** They are checked at the end of every stock-affecting transaction. A violation aborts the whole
transaction.

```
For every product:   Q ≥ 0      V ≥ 0      Q = 0  ⇒  V = 0
```

A "stock card" per product lists the movements with a running Q and V. That is the audit trail.

### 8.2 Where movements come from

| Event | Movement | qty sign | value |
|---|---|---|---|
| Opening stock (go-live) | `OPENING` (adjustment reason `OPENING_STOCK`) | + | qty × entered cost |
| Stock In line | `STOCK_IN` | + | `line_cost_minor` (exact) |
| Receipt void (only if allowed, §8.5) | `STOCK_IN_VOID` | − | − exactly the original `line_cost_minor` |
| Invoice line | `SALE` | − | − frozen COGS of the line |
| Invoice void | `SALE_VOID` | + | + exactly the value removed by the original `SALE` |
| Adjustment | `ADJUST_IN` / `ADJUST_OUT` / `COST_CORRECTION` | per §8.6 | per §8.6 |

### 8.3 Negative stock: prohibited in V1

- **There is no user-facing setting.** Any transaction that would leave Q < 0 for any product is rejected with
  `INSUFFICIENT_STOCK` (per-product *required / available* in the error details).
- The check runs inside the write transaction (`BEGIN IMMEDIATE`). It **aggregates per product across all
  lines and all quantity rows** of the document, including free scheme quantity.
- The check lives in one function (`assertStockInvariants`). A future version could deliberately relax it,
  but V1 exposes no toggle.

### 8.4 Costing method: moving weighted average via the value ledger

```
avg cost per base unit = V / Q                         (implicit, never stored, never rounded)
COGS / out-value of n base units = round_half_up( V × n / Q )    (BigInt math; if n = Q the result is exactly V)
```

- Integer money. Rounding happens once per line, and the result is stored in `invoice_items.cost_minor`.
- **When stock reaches exactly 0, the last outflow takes exactly the remaining V.** V is then exactly 0, so
  rounding drift cannot accumulate. This is what upholds the invariant `Q = 0 ⇒ V = 0`.
- Historical profit never changes when costs change later, because COGS is frozen on the line.
- **Sale voids are always safe.** A void is an *inflow* at exactly the value the sale removed, so Q and V both
  rise. The invariants hold regardless of any later activity, and the returned goods blend into the average at
  their original cost. **Outflow reversals** (receipt voids) are the dangerous ones. §8.5 handles them.

### 8.5 Stock receipt void / correction rule (revised)

**Why "enough stock remains" is not a safe rule.** Worked example, single product:

| Step | Movement (qty, value) | Q | V | Avg |
|---|---|---|---|---|
| R1: receive 10 @ 100 | +10, +1,000 | 10 | 1,000 | 100 |
| Sell 10 (COGS frozen at 1,000) | −10, −1,000 | 0 | 0 | — |
| R2: receive 10 @ 150 | +10, +1,500 | 10 | 1,500 | 150 |
| **Void R1 at its original cost** ("10 in stock, so allowed") | −10, −1,000 | 0 | **500** | ✗ phantom value with no stock |
| *Alternative:* void R1 at the current average | −10, −1,500 | 0 | 0 | ✗ R2's 1,500 vanished without passing through COGS or P&L. The 1,000 COGS already booked came from goods that "never arrived". |

Both variants corrupt valuation. Voiding **requires that nothing has consumed or blended the receipt's stock
since it was posted.**

**V1 rule: a receipt can be voided only while no *other* document has touched its products since.**

- For each product *p* on receipt *R*, let `first_R(p)` be the smallest `id` among R's own `STOCK_IN`
  movements for *p*.
- *R* may be voided only if, for every such *p*, **no stock movement for *p* with `id > first_R(p)` belongs to a
  different document.** A different document means anything other than R's own receipt lines: a sale, a sale
  void, another receipt, or any adjustment, including corrections linked to R.
- **R's own movements never lock it**, including several lines of the same product.
- Otherwise the receipt is **locked**, and the UI offers the correction adjustments below.

```sql
-- conceptual lock test (true = locked)
SELECT EXISTS (
  SELECT 1
  FROM stock_movements m
  JOIN (SELECT sm.product_id, MIN(sm.id) AS first_id
          FROM stock_movements sm
          JOIN stock_receipt_items ri ON ri.id = sm.receipt_item_id
         WHERE ri.receipt_id = :R AND sm.type = 'STOCK_IN'
         GROUP BY sm.product_id) f
    ON f.product_id = m.product_id AND m.id > f.first_id
  WHERE m.receipt_item_id IS NULL
     OR m.receipt_item_id NOT IN (SELECT id FROM stock_receipt_items WHERE receipt_id = :R)
)
```

(R posts in one transaction on the single connection, so its movements are contiguous. Measuring from the
*first* of R's movements is the conservative choice even if that ever changed.)

**Why this is mathematically exact.** Let (Q₀, V₀) be product *p*'s totals just before R, and let R's lines for
*p* add (q₁, c₁), …, (qₖ, cₖ).

- Only R's own movements exist for *p* since then, so the current totals are (Q₀ + Σqᵢ, V₀ + Σcᵢ).
- The void writes one `STOCK_IN_VOID` (−qᵢ, −cᵢ) per line, which returns (Q₀, V₀).
- Quantity, value, and therefore average cost return **exactly** to the pre-receipt state.
- No other document drew value from R, so no frozen COGS depended on it.
- (Q₀, V₀) was a valid state, so the invariants hold. They are also asserted before COMMIT.

The void sets the receipt status to `VOID` with `void_date` = today. Typical use: a receipt was keyed wrongly
and noticed before any sale, receipt, or adjustment of those products.

**Stress test: a receipt with the same product twice.** Box of A = 24 base units, and A starts at (Q₀, V₀).

| Step | Movements (ids) | Void R7? |
|---|---|---|
| R7 posted: line 1 = A 2 Box @ 2,400 (48 base, 4,800); line 2 = B 10 Pcs; line 3 = A 5 Pcs @ 110 (5 base, 550) | #301 A +48/+4,800 (R7 L1) · #302 B (R7 L2) · #303 A +5/+550 (R7 L3) | ✅ **Voidable.** For A, #303 is after #301 but belongs to R7 itself. B has nothing after #302. |
| …void R7 now | #304 A −48/−4,800 · #305 B · #306 A −5/−550 | A returns to exactly (Q₀, V₀) ✓ |
| *Instead:* invoice INV-120 sells 1 Pcs of A | #304 A SALE | ❌ **Locked.** #304 > #301 and belongs to another document. |
| *Instead:* receipt R8 or any adjustment for A | #304 A STOCK_IN / ADJUST_* | ❌ **Locked** |
| *Instead:* a sale of B only | #304 B SALE | ❌ **Locked** (B is on R7) |
| *Instead:* activity only on product C (not on R7) | #304 C … | ✅ still voidable |

**Correcting a locked receipt** (adjustments linked by `receipt_id`; the receipt screen shows "Corrected by
ADJ-000045"):

| Problem | Correction | Valuation | Guard |
|---|---|---|---|
| Recorded quantity too high | `RECEIPT_QTY_CORRECTION` OUT | − round(V × n / Q) (current average) | Blocked if Q − n < 0 |
| Recorded quantity too low | `RECEIPT_QTY_CORRECTION` IN | + n × the receipt line's unit cost (the price actually paid) | — |
| Wrong unit cost, quantity right | `RECEIPT_COST_CORRECTION` (value only, qty 0) | ± δ = (correct − recorded) cost × receipt qty | Only while Q > 0 and V + δ ≥ 0 |

**Stress tests under weighted average** (continuing from Q = 10, V = 1,500):

1. **Qty correction OUT 2:** value = round(1,500 × 2 / 10) = 300, giving Q = 8, V = 1,200, avg 150. The
   average is unchanged and the invariants hold. Removing all 10 would remove exactly 1,500, giving (0, 0).
2. **Qty correction IN 2 @ 100:** Q = 12, V = 1,700, avg 141.67. The goods genuinely arrived at 100, so blending
   is correct. The invariants hold.
3. **Cost correction δ = +200 while Q = 10:** V = 1,700, avg 170, and future COGS absorb it.
   - If some of that receipt's units were already sold, see **limitation L1** below.
   - If Q = 0, the correction is **blocked**. The user may record the difference as an expense ("Purchase cost
     correction" category) in the current period.
4. **Negative δ larger than V** (e.g. δ = −2,000 with V = 1,500): blocked, because V + δ < 0.

> **⚠ V1 LIMITATION L1 — late purchase-cost corrections are not retrospective** (accepted, pending decision D7)
>
> - **Frozen historical COGS is not recalculated.** Invoices already saved keep the `cost_minor` computed from
>   the cost recorded at the time, even when that cost was wrong.
> - **A late correction affects future COGS instead of the original period.** δ is added to the product's
>   current inventory value. It is therefore charged to units sold *after* the correction, possibly in a later
>   month than the original purchase and sales.
> - **Lifetime inventory/value reconciliation remains correct.** The identity Σ inflow value = Σ COGS +
>   Σ out-adjustment value + V holds at all times. Over the life of the stock, total COGS equals the true total
>   purchase cost.
> - **Historical monthly P&L may temporarily differ from a fully retrospective accounting system.** The
>   original period's profit is overstated (or understated), and the correction period's is off by the same
>   amount in the opposite direction.
> - **Example** (product with no other stock). R2 was recorded as 10 @ 150, but the true cost was 170.
>
>   | | Recorded in this system | Fully retrospective system |
>   |---|---|---|
>   | August: 4 sold | COGS 600 | COGS 680 |
>   | Correction posted | δ = +200 while Q = 6; V goes 900 → 1,100 | — |
>   | September: 6 sold | COGS 1,100 | COGS 1,020 |
>   | Total | **1,700** | **1,700** ✓ |
>
>   August profit is +80 too high and September profit is −80 too low.
> - The same timing effect applies when Q = 0 and the difference is booked as a current expense.
> - **V1 mitigations:**
>   - Before saving, the correction form warns: "Stock from GRN-000031 has already been sold. Its share of
>     this correction will affect future cost of goods sold, not the original month."
>   - The P&L report lists every cost correction posted in the period, with the original receipt number,
>     receipt date, and δ.
> - A retrospective recalculation is a post-V1 option. It conflicts with frozen COGS and would change printed
>   history.

### 8.6 Adjustment reasons: effect on quantity, value, and P&L

Adjustments are the only way to change stock outside receipts and invoices. A reason code is mandatory, and
`reason_note` text is always required.

| Reason code | Direction | Qty | Inventory value | P&L treatment (§13) |
|---|---|---|---|---|
| `OPENING_STOCK` | IN | + | + qty × entered cost (cost required) | **None.** Opening inventory is capital, not income. Allowed only while the product has no other movement types. |
| `DAMAGE` | OUT | − | − avg × qty | **Operating loss**: "Stock loss – damage" |
| `EXPIRY` | OUT | − | − avg × qty | **Operating loss**: "Stock loss – expiry" |
| `SHORTAGE` (count lower / theft / missing) | OUT | − | − avg × qty | **Operating loss**: "Stock loss – shortage" |
| `COUNT_SURPLUS` (count higher) | IN | + | + avg × qty (entered cost if Q = 0) | **Operating gain**: "Stock gain – count surplus" |
| `RECEIPT_QTY_CORRECTION` | IN / OUT | ± | IN: + receipt unit cost × qty; OUT: − avg × qty | **Not operating.** Shown separately as "Inventory data corrections" |
| `RECEIPT_COST_CORRECTION` | VALUE | 0 | ± δ (guards §8.5) | **None at posting.** It stays in inventory and flows through future COGS (**V1 limitation L1**). |
| `OTHER_CORRECTION` (data-entry error not tied to a receipt) | IN / OUT | ± | IN: entered cost; OUT: − avg × qty | **Not operating.** "Inventory data corrections"; a note is mandatory |

- OUT values always use the current average. That is what guarantees V ≥ 0 and `Q = 0 ⇒ V = 0`.
- The mapping from reason code to P&L lives in **one shared constant**, used by both the adjustment form and
  the reports. Whether "Inventory data corrections" also appear inside headline net profit is decision D2.

### 8.7 Performance / concurrency

- Single connection in main, synchronous driver. Every mutating service uses `BEGIN IMMEDIATE`.
- Covering index `(product_id, id)` on movements.

### 8.8 Go-live data

- **Opening stock:** `OPENING_STOCK` adjustments with quantity in any defined unit plus cost. They are dated the
  go-live date, which sets each product's first stock floor (§11.5).
- **Customer opening balances:** `OPENING` ledger entries on the same date.
- A CSV import is a post-V1 nice-to-have.

---

## 9. Box vs Piece Model (Packing / Unit Hierarchy)

> **⚠ REQUIRES BUSINESS CONFIRMATION BEFORE IMPLEMENTATION (decisions A1, A2, A3).**
> The earlier single `pieces_per_box` simplification has been **withdrawn**. This section defines a model that
> works for whatever the client confirms, **without interpreting** the packing strings.

### 9.1 What the client's invoice shows, and what is unknown

Observed packing values: `1*12*18`, `1*18*24`, `1*24*24`, `1*60*18`.

**This plan does not assign a meaning to these numbers.** Questions for the client (decision A1/A2):

1. What does each position in `a*b*c` represent? Is the first number always `1`, and what does it count? Are
   the second and third numbers **counts** of smaller units, or is one of them a **size, weight, volume, or
   other attribute**?
2. Which physical levels exist, **in the client's own words** (for example: carton, box, dozen, packet,
   piece)?
3. At which levels does the shop **buy**, **count stock**, and **sell**? Answer separately for wholesale and
   retail.
4. On the invoice, what unit is the **Qty** column in? How does the **Ctn** column relate to it (B2)?
5. Can the same product be sold in different units, in the same invoice or on the same day?
6. Which unit's price is printed in the **Price** column?
7. Is every larger level always an exact whole multiple of the smaller one?

### 9.2 Model: one base unit + configurable units per product

- **Base unit** = the smallest unit the shop ever counts or sells (confirmed in A2). All stock is stored as an
  integer count of base units.
- Each product has **1..n rows in `product_units`**, each with an integer `base_qty` (how many base units it
  contains).
- The same schema supports every plausible answer. The rows below are **illustrative structures, not
  interpretations of the client's strings**:

| If the client confirms… | `product_units` rows |
|---|---|
| The product is sold and counted in a single unit only | Unit (1) |
| Two levels (e.g. Box → Piece) | Piece (1), Box (N) |
| Three levels (e.g. Carton → Box → Piece) | Piece (1), Box (N), Carton (N × M) |

- `packing_label` is stored and printed **verbatim**. If A1 later confirms a reliable pattern, the product form
  may *offer to prefill* units from the label, but the user always confirms the numbers. **There is no silent
  parsing.**
- Pure shared conversions:

```
toBase(quantity, unit)  = quantity × unit.base_qty
split(qtyBase, units)   = greedy from the largest active unit down:
                            n_u = floor(rest / base_qty_u);  rest = rest − n_u × base_qty_u
display                 = e.g. "4 Ctn + 7 Box + 1 Pcs" (zero parts omitted)
```

- Quantities are positive integers. There are no fractional units, and sub-base quantities are impossible by
  construction.

### 9.3 Stress tests

**(a) Two levels, Box = 24 base units:**

| Step | Entry | Δ base | Q | Displayed |
|---|---|---|---|---|
| Stock In | 10 Box | +240 | 240 | 10 Box |
| Sale | 2 Box + 5 Pcs | −53 | 187 | 7 Box + 19 Pcs (168 + 19 = 187 ✓) |
| Sale | 7 Box + 19 Pcs | −187 | 0 | 0 |
| Try to sell | 1 Pcs | −1 | ✗ | Blocked: available 0 |
| Stock In | 3 Pcs | +3 | 3 | 3 Pcs |
| Try to sell | 1 Box | −24 | ✗ | Blocked: available 3 Pcs |

**(b) Three levels, hypothetical Carton = 10 Box and Box = 6 Pcs** (so Carton = 60 base units). These numbers
were chosen arbitrarily and are *not* derived from the client's packing values.

| Step | Entry | Δ base | Q | Displayed |
|---|---|---|---|---|
| Stock In | 5 Ctn | +300 | 300 | 5 Ctn |
| Sale | 2 Box + 5 Pcs | −17 | 283 | 4 Ctn + 7 Box + 1 Pcs (240 + 42 + 1 ✓) |
| Sale | 1 Ctn | −60 | 223 | 3 Ctn + 7 Box + 1 Pcs (180 + 42 + 1 ✓) |
| Try to sell | 4 Ctn | −240 | ✗ | Blocked: available 223 |
| Sale | 3 Ctn + 7 Box + 1 Pcs | −223 | 0 | 0 |

**(c) Changing a unit size after stock exists.** Say Q = 283 and someone edits Box from 6 to 8. The counted
physical boxes would silently stop matching the display, and old lines would be misread. This is **blocked**
(§9.4).

**(d) Non-nested units.** Take Box = 6 and Pack = 4, where 6 is not a multiple of 4. The greedy display
becomes misleading. So the nesting rule is validated when units are saved (§7.3).

### 9.4 Locking unit definitions

- Once a product has any movement, its existing units' `base_qty` and `is_base` are frozen.
- A different real-world packing means a **new product** (new code).
- Past invoices are unaffected either way, because every quantity row snapshots `unit_base_qty`.

### 9.5 Prices per unit

- Each sellable unit stores its own wholesale and retail price explicitly.
  - Deriving a smaller unit's price from a larger one creates fractional paisa.
  - Deriving a larger unit's price from a smaller one prevents bulk pricing.
- A form helper "derive from the next larger unit" rounds the result and lets the user overwrite it.
- COGS never uses unit prices or unit costs. It comes from the value ledger (§8.4).

### 9.6 Mixed-unit sales on one invoice: DECISION A3 (not yet decided)

Both options below give identical, exact stock mathematics. They differ in data entry, discounts, and the
printed layout.

**Option A: one unit per line** (e.g. line 1 "2 Box", line 2 "5 Pcs" for the same product)

- *Stock math:* each line has its own `qty_base`. The stock check aggregates per product across lines. Exact.
- *Pricing:* one price, one gross, and one discount per line. Unambiguous.
- *Printed invoice:* Qty and Price are clean single values. But the product appears twice, the invoice gets
  longer, and the customer must add lines mentally to see the total quantity of a product.
- *Risks:* the operator may forget the second line, or apply different discounts to the two lines by accident.

**Option B: one line per product, with a quantity per unit** (e.g. "2 Box + 5 Pcs")

- *Stock math:* `qty_base = Σ quantity_u × base_qty_u` = 2×24 + 5 = 53. Exact, with one SALE movement per line.
- *Pricing:* gross = Σ quantity_u × price_u (2 × box price + 5 × piece price). There is one discount on the
  combined gross.
- *Printed invoice:* one row per product, which is closer to how many distributor bills are written. Qty prints
  as "2 Box + 5 Pcs".
  - **The single Price column becomes ambiguous.** It must print both prices (e.g. "2,400 / 110") or one price
    with a breakdown line.
  - Space is tight on A5.
- *Implementation:* a slightly more complex line editor (unit inputs side by side) and print cell.

**Option C (not recommended): sell everything in base units at a derived base price.** This introduces
fractional paisa and changes the customer-visible price.

**Schema impact:** none. `invoice_item_quantities` supports both A and B (§7.3).

**Question for the client:** on the current paper invoice, how is a mixed sale written? The recommendation is
to copy that practice. It may also interact with the meaning of **Ctn** (B2).

---

## 10. Customer Balance / Payment Model

### 10.1 Ledger, not a balance field

```
balance(customer) = Σ customer_ledger.amount_minor      (+ = customer owes shop)
```

| Event | Ledger entry | Amount | Date |
|---|---|---|---|
| Opening balance at go-live | `OPENING` (max one) | ± entered | go-live date |
| Invoice posted | `INVOICE` | + `total_minor` (net + freight) | invoice date |
| Cash received at invoice time | `PAYMENT` (payments row linked to the invoice) | − `received_minor` | invoice date |
| Payment received later | `PAYMENT` | − amount | payment date |
| Invoice voided | `INVOICE_VOID` | − original `total_minor` | void date |
| Payment voided | `PAYMENT_VOID` | + original amount | void date |
| Manual correction | `ADJUSTMENT` (reason required) | ± | entry date |

- Invoices, payments, voids, and adjustments all respect the customer's posting-date floor (§11.5). So the running balance
  in `(entry_date, id)` order is always consistent with every stored `previous_balance_minor`.
- A negative balance means the customer has an advance, which is displayed as "Advance".
- V1 uses a **running-account** balance (C8). A payment may optionally reference an invoice, but only for
  information.

### 10.2 Duplicate payments

- A `request_id` UUID is generated per form. Save is disabled while pending, and `UNIQUE(request_id)` means a
  retry returns the existing payment.
- A same-customer, same-day, same-amount payment triggers a soft warning, not a block.
- Corrections are made by **void** only.

### 10.3 Customer history screen

- Ledger with running balance, date filter, and links to invoices and payments.
- Header shows current balance, total invoiced, and total paid.
- No "recompute" is ever needed.

---

## 11. Invoice Data Model and Workflow

### 11.1 Fields on the client's current invoice

**Status legend:**

- ✅ **Understood:** the meaning is clear and the design is fixed.
- ⚠ **Meaning must be confirmed:** the design is provisional and marked in §7 as optional columns or
  computed/print-only values.

| Printed field | Stored as | Source | Status |
|---|---|---|---|
| **Invoice Code** | `invoices.invoice_code` (text snapshot) | Unknown. Manual entry until confirmed. **Not** assumed to be the invoice number or customer code. | ⚠ **B1** |
| **INV. Number** | `invoices.invoice_no` | System sequence + prefix; can continue the paper series | ✅ (format/start number: B7) |
| **Bilty Number** | `invoices.bilty_no` | Typed, possibly after dispatch | ⚠ **B4** (needed? when known?) |
| **Transport Service** | `invoices.transport_name` | Typed (pick list later if wanted) | ⚠ **B4** |
| **Adda Name** | `invoices.adda_name` | Typed | ⚠ **B4** |
| Date | `invoice_date` | Posting-date rule | ✅ policy C1 |
| Customer Name / Contact / Address / City | `cust_*` snapshot | Customer record at save time | ✅ |
| **Packing** | `invoice_items.packing_label` | Product snapshot, printed verbatim | ✅ printed as-is; meaning ⚠ **A1** |
| **Qty** | `invoice_item_quantities` | Entered | ⚠ unit **A2**, layout **A3** |
| **Price** | `invoice_item_quantities.unit_price_minor` | Tier price (or override **C2**) | ⚠ which price prints under **A3** |
| **Gross Amount** | `invoice_items.gross_minor` | Σ qty × price | ✅ |
| **Discount** | `invoice_items.discount_minor` (+ `discount_bps`) | Entered % or amount | ⚠ **B5** |
| **Ctn** | Computed at print time, or `invoice_items.ctn_count` | — | ⚠ **B2** |
| **Sch** | `invoice_items.scheme_qty_base` **or** `scheme_minor` | — | ⚠ **B3** (affects stock/COGS if it is free goods) |
| **Net Amount** | `invoice_items.net_minor` | Gross − Discount (− Sch if it is an amount) | ⚠ formula **B3** |
| **Current Invoice** | `invoices.net_minor` | Σ line net − extra discount | ⚠ **B6** |
| **Freight** | `invoices.freight_minor` | Entered | ✅ (P&L treatment **D4**) |
| **Previous Balance** | `invoices.previous_balance_minor` | Ledger balance at the invoice's chronological position | ✅ policy **C1** |
| **Net Outstanding** | `invoices.net_outstanding_minor` | Previous + current + freight − received | ⚠ counter-payment presentation **B6** |
| **Checked By** | `invoices.checked_by` | Typed or defaulted from settings | ✅ |
| **Signature** | — | Blank line on print | ✅ |
| Amount in Words | Computed at print | Which amount? | ⚠ **B6**, style **E2** |

**Why Sch matters for inventory:** if "Sch" means free goods given under a scheme, those units physically leave
stock.

- They must be part of `qty_base`, the SALE movement, and COGS, with zero revenue. Otherwise stock is overstated
  and profit is overstated.
- If Sch is a monetary scheme discount, it has no stock effect.

The schema reserves both shapes. Only the confirmed one ships in `0001`.

### 11.2 Line and total calculations (shared pure functions, integer minor units)

```
per quantity row:  qty_base_u = quantity_u × unit_base_qty_u ;  amount_u = quantity_u × unit_price_u
line.qty_base     = Σ qty_base_u  (+ scheme_qty_base if B3 = free goods)
line.gross        = Σ amount_u
line.discount     = discount_bps ? round_half_up(gross × bps / 10000) : discount_amount   (0 ≤ discount ≤ gross)
line.scheme       = (only if B3 = amount/percentage) computed like discount
line.net          = gross − discount − scheme
invoice.net       = Σ line.net − extra_discount            ("Current Invoice", ⚠ B6)
invoice.total     = invoice.net + freight
previous_balance  = customer ledger balance at this invoice's chronological position (§11.5)
net_outstanding   = previous_balance + invoice.total − received
```

Totals are sums of stored line values and are never recomputed from percentages. The same `invoice-calc.ts`
drives the live preview and the authoritative calculation in main.

### 11.3 Save workflow (main process, one transaction)

```
renderer: submit (button disabled; request_id from draft)
  └─ window.api.invoices.create(input)
main:
  1. Validate sender + Zod-parse input (shape, integers, positive quantities, limits, date format)
  2. If an invoice with this request_id exists → return it (idempotent retry)                     ─┐
  3. BEGIN IMMEDIATE                                                                                 │
  4. Scoped posting-date check (§11.5): invoice_date ≤ today, ≥ customer balance floor,             │
     and ≥ stock floor of every product on the invoice; else DATE_NOT_ALLOWED                       │
  5. Load customer (exists, active) and every product + unit (exist, active, unit can_sell,        │
     unit belongs to product)                                                                      │ one
  6. Recompute every quantity row, line and total from DB prices (reject mismatch → PRICE_CHANGED, │ SQLite
     unless override allowed by C2)                                                                │ transaction
  7. Aggregate qty_base per product over all lines + quantity rows (+ free scheme qty);           │
     verify Q ≥ required                                                                           │
  8. Allocate number from sequences                                                                │
  9. previous_balance = Σ ledger for customer (as-of-date correct: customer's floor)               │
 10. INSERT invoices (header, customer snapshot, invoice_code/dispatch fields, balances)           │
 11. For each line: COGS = round_half_up(V × qty_base / Q) from the value ledger;                  │
     INSERT invoice_items (snapshots, cost_minor) + invoice_item_quantities                        │
 12. INSERT stock_movements (SALE, −qty_base, −cost) per line                                      │
 13. INSERT customer_ledger (INVOICE, +total); if received > 0: payments row + ledger (PAYMENT)   │
 14. assertStockInvariants(affected products)                                                      │
 15. COMMIT (any throw → ROLLBACK; nothing persists; number not consumed)                         ─┘
 16. Return the saved invoice DTO read back from the DB
renderer:
 17. Success → invalidate [invoices, products/stock, customers, payments, dashboard, reports];
     clear draft; open Invoice Detail (saved data) with Print enabled
 18. Failure → show error, keep draft, no print option
```

Guarantees:

- It is impossible to have an invoice without its stock movement, or a stock reduction without an invoice.
- A crash before COMMIT leaves no trace.
- **Print is reachable only through a saved `invoice_id`.**

### 11.4 After posting: void, and dispatch details

- **Void** (instead of edit/delete, C4). This is one transaction dated `void_date` = today (always ≥ every scoped floor, because future dates are prohibited):
  - status → `VOID` with a reason
  - `SALE_VOID` per line with the exact original qty and value
  - `INVOICE_VOID` ledger entry for −total
  - the linked counter payment is handled per C5
  - the number stays used, and the invoice reprints with a VOID watermark
  - "Edit" = void + re-create
- **Dispatch details** (only if B4 confirms they may be filled in later): `bilty_no`, `transport_name`, and
  `adda_name` can be updated on a posted invoice.
  - Each change is written to `invoice_change_log` (old → new, timestamp).
  - The action cannot touch money, quantities, dates, or the customer.
  - Reprints show the current dispatch values and the log is visible on the detail page.

### 11.5 Backdated invoices: policy (DECISION C1)

**The problem.** If an invoice dated in the past is saved *after* newer documents, then either:

- its stored "Previous Balance" reflects today's balance, which is misleading on a historical bill, or
- inserting it "in date order" changes the true previous balance of later invoices that were **already
  printed and stored**.

The same applies to stock. A backdated sale could make stock negative *as of that date* even if today's stock is
sufficient. Its COGS would also use today's average instead of the average at that date.

| Option | How it works | Pros | Cons |
|---|---|---|---|
| **A. Recalculate as of the historical date/order** | Insert the invoice in date order and compute previous balance, stock, and average as of that date | Historically "true" | Every later invoice's stored previous balance, printed copy, stock check, and frozen COGS become wrong or need a recalculation cascade. That contradicts immutable snapshots. **Not safe for V1.** |
| **B. No backdating** | Invoice date is always today | Simplest; perfectly consistent | Cannot enter yesterday's paper bills the next morning (power cut, catch-up) with their real date |
| **C. Scoped posting-date floors (recommended)** | A document may be dated in the past, but **not earlier than the latest date already posted in the ledgers it touches**: the customer's ledger and/or each affected product's stock ledger. Never in the future. | Every ledger that receives an entry stays in date order. So the previous balance, stock check, weighted average, and frozen COGS computed at save time are **exactly** correct as of that date. Activity on **unrelated** customers or products never blocks a backdated entry. | A forgotten earlier bill is blocked only if **its own** customer or one of **its own** products already has later-dated activity. It then takes that later date, with the paper bill's date and number recorded in `notes`. |

A global floor (a single `MAX(date)` over everything) was considered and rejected. It is unnecessarily
restrictive: one sale of product A to customer Y would block yesterday's unrelated bill for customer X and
product B.

**Recommended V1 policy: C, scoped floors.**

| Document | Allowed date (always ≤ today) |
|---|---|
| Stock receipt; stock adjustment (incl. opening stock, receipt corrections) | ≥ `stockFloor(p)` for **each** affected product *p* |
| Customer payment; customer ledger adjustment; customer opening balance | ≥ `balanceFloor(c)` for that customer |
| Invoice (incl. its counter payment) | ≥ `balanceFloor(customer)` **and** ≥ `stockFloor(p)` for **every** product on the invoice |
| Voids (invoice, receipt, payment) | Always dated today, which is ≥ every floor because future dates are prohibited |
| Expenses | No floor (they affect neither stock nor balances) |

```
stockFloor(p)   = MAX(movement_date) FROM stock_movements WHERE product_id  = p   -- none if no movements
balanceFloor(c) = MAX(entry_date)    FROM customer_ledger WHERE customer_id = c   -- none if no entries
```

Both floors are computed inside the write transaction (`BEGIN IMMEDIATE`), so the check is race-free. They use
the indexes `(product_id, movement_date)` and `(customer_id, entry_date, id)`. A product or customer with no
history has no floor; only the future-date rule applies. Go-live opening entries naturally set the first
floors.

**Why scoped floors preserve correctness:**

- **Previous balance** depends only on customer *c*'s ledger.
  - The new entry's date is ≥ every existing date in that ledger. Appending it (highest `id`) keeps the ledger
    in `(entry_date, id)` order.
  - Σ ledger at save time is therefore the balance *as of that date and position*, and no stored
    `previous_balance_minor` of an earlier invoice is invalidated.
  - Other customers' ledgers are untouched.
- **Stock quantity, weighted-average cost, and COGS** of product *p* depend only on *p*'s movements.
  - The new movement's date is ≥ every existing movement date for *p*. So the (Q, V) read at save time is
    exactly (Q, V) *as of that date*.
  - The availability check and `COGS = round(V × n / Q)` are therefore correct as of that date, and **frozen
    COGS never needs recalculation**.
  - Other products' movements are untouched.
- **An invoice touches one customer ledger and several product ledgers,** so it must satisfy all of their
  floors at once.
- **No cross-ledger ordering is required.** Reports aggregate by date, and no calculation depends on the
  relative order of entries in two *different* ledgers.

**Stress test** (today = 10-Sep):

| Existing activity | New document | Result |
|---|---|---|
| Product A sold on 10-Sep to customer Y | Invoice 09-Sep: customer X (latest entry 08-Sep), product B (latest movement 07-Sep) | ✅ Allowed. The global floor would have blocked it. |
| Same | Invoice 09-Sep: customer X, products A **and** B | ❌ `DATE_NOT_ALLOWED`: "Product A has stock activity on 10-Sep; earliest date for this invoice is 10-Sep" |
| Customer X paid on 10-Sep | Invoice 09-Sep for X, product B | ❌ Blocked by X's balance floor |
| Customer X paid on 10-Sep | Payment 09-Sep from customer Z | ✅ |
| Receipt for A dated 10-Sep | Damage adjustment for B dated 08-Sep (B's floor 07-Sep) | ✅ |
| Invoice with A voided today (SALE_VOID dated 10-Sep) | Receipt for A dated 09-Sep | ❌ The void raised A's floor to 10-Sep |
| New product D, no movements | Opening stock dated 01-Sep | ✅ Only future dates are blocked |

**UI and API:**

- The date field shows "Earliest allowed date: 08-Sep-2026 (set by: Customer Ali Traders / Product P-102)". It
  recalculates as the customer and products change, and warns when the date is not today.
- `postingFloor({ customerId?, productIds? })` returns both the date and what sets it.

---

## 12. Expense Model

- `expenses(expense_date, category_id, amount_minor, description, status)`, with categories grouped as `SHOP`
  or `GENERAL`.
- Screens: list with date-range and category filters and totals by category, plus an add/edit dialog.
- Editing is allowed (D5). Delete = `status = VOID`, and voided rows are excluded from all totals.
- Expenses are not linked to stock or customers, and they are exempt from the posting-date floors.
- Freight the shop *pays* is an expense category. Freight *charged* to customers is invoice income (§13, D4).

---

## 13. Profit & Loss Calculation

For a range `[from, to]` on business dates. Only `POSTED` invoices and `ACTIVE` expenses are counted. Voided
receipts and adjustments reversed by voids net to zero.

```
Sales revenue (goods)        = Σ invoices.net_minor                  (after line discounts, scheme amounts, extra discount; excludes freight)
Cost of goods sold           = Σ invoices.cogs_minor                 (frozen at sale; includes free scheme goods if B3 = free quantity)
GROSS PROFIT                 = Revenue − COGS

Freight income               = Σ invoices.freight_minor              (other income, D4)
Expenses                     = Σ expenses.amount_minor
Operating stock losses       = value of DAMAGE + EXPIRY + SHORTAGE adjustments
Operating stock gains        = value of COUNT_SURPLUS adjustments
NET OPERATING PROFIT         = Gross profit + Freight income − Expenses − Operating stock losses + Operating stock gains

Inventory data corrections   = net value of RECEIPT_QTY_CORRECTION + OTHER_CORRECTION   (shown on a separate line)
NET PROFIT AFTER CORRECTIONS = Net operating profit ± Inventory data corrections        (headline choice: D2)
```

**Not in P&L at all:**

- `OPENING_STOCK` (capital)
- `STOCK_IN` / `STOCK_IN_VOID` (asset movements)
- `RECEIPT_COST_CORRECTION`: it stays in inventory and reaches P&L later through COGS (see **L1** below)
- Customer payments: cash, not revenue

**Historical correctness:**

- COGS comes from `invoice_items.cost_minor`, frozen at sale.
- Each product's scoped posting-date floor guarantees that the average used was the average *as of the invoice
  date*.
- Later price changes and new receipts at different costs never alter past profit.

> **⚠ V1 LIMITATION L1 — late purchase-cost corrections are not retrospective** (full explanation and example
> in §8.5; decision D7)
>
> - Historical COGS that is already frozen is **not recalculated**.
> - A late purchase-cost correction therefore affects **future COGS**, not the period in which the goods were
>   originally bought and sold.
> - **Lifetime inventory/value reconciliation remains correct.** Over the life of the stock, total COGS equals
>   the true purchase cost.
> - **Historical monthly P&L may temporarily differ from a fully retrospective accounting system.** The original
>   month and the correction month are misstated by equal and opposite amounts.
> - Disclosure: the P&L report shows a "Cost corrections posted in this period" section listing the receipt
>   number, receipt date, and δ for each correction. This section is informational and not added to profit
>   again.

**Voids:** a voided invoice is excluded from its original period. That period's P&L can therefore change if an
old invoice is voided later. This is shown with a "voided after period" note, and period locking is a later
feature.

**Reconciliation identity (tested):**

```
Σ inflow value (opening + receipts − receipt voids + IN adjustments + cost corrections + sale voids)
= Σ SALE values + Σ OUT-adjustment values + current V
```

This holds for every product at all times. It is checked by the integrity tool and by property tests.

---

## 14. IPC / Preload Security Design

### 14.1 BrowserWindow hardening (changes from the current template)

| Setting / guard | Now | V1 |
|---|---|---|
| `sandbox` | `false` | `true` |
| `contextIsolation` | default (true) | explicit `true` |
| `nodeIntegration` | default (false) | explicit `false` |
| `webSecurity` | default | explicit `true` |
| Exposed globals | `window.electron` (raw ipcRenderer + process) + `window.api = {}` | **only** `window.api` (typed functions) |
| `setWindowOpenHandler` | opens **any** URL externally | deny all. No external links are needed in V1. |
| Navigation | unguarded | `will-navigate` → `preventDefault()` unless it is the app's own URL |
| Permissions | default | `session.setPermissionRequestHandler(() => false)` (no camera/mic/geo) |
| DevTools | F12 in dev (toolkit) | dev only |
| Single instance | none | `app.requestSingleInstanceLock()`. A second launch focuses the existing window. |
| CSP | present | keep. Add `object-src 'none'; base-uri 'none'; form-action 'none'`. The dev server needs the Vite origin, which electron-vite handles. |

`@electron-toolkit/preload`'s `electronAPI` will **no longer be exposed**. `App.tsx`/`Versions.tsx` are the
only consumers, and both are replaced.

### 14.2 Contract (single source of truth in `src/shared/ipc-contract.ts`)

```ts
// conceptual shape — not code to be written yet
export const ipcContract = {
  'products:list':    { input: ProductListQuery,  output: ProductListItem[] },
  'products:create':  { input: ProductCreate,     output: Product },
  'invoices:create':  { input: InvoiceCreate,     output: InvoiceDetail },
  ...
} as const
```

Channel naming is `<domain>:<action>`. Only `ipcRenderer.invoke` / `ipcMain.handle` are used (request/response).
There are no fire-and-forget channels, and no main→renderer push is needed in V1. A future backup-progress
event can go through a single allow-listed `on` subscription.

Planned API surface (`window.api`):

| Domain | Functions |
|---|---|
| `app` | `info()` (version, schema version, data path) |
| `settings` | `get()`, `update(patch)` |
| `companies` | `list()`, `create()`, `update()`, `setActive()` |
| `products` | `list(query)`, `get(id)`, `create()` / `update()` (product + its units), `setActive()`, `search(term)` (picker) |
| `stock` | `receive(receipt)`, `listReceipts(q)`, `getReceipt(id)`, `voidReceipt()`, `adjust()`, `listAdjustments(q)`, `stockCard(productId, range)`, `summary()` |
| `customers` | `list(q)`, `get(id)`, `create()`, `update()`, `setActive()`, `ledger(id, range)`, `search(term)` |
| `invoices` | `create(input)`, `get(id)`, `list(q)`, `void(id, reason)`, `updateDispatch(id, fields)` (if B4), `nextNumberPreview()`, `postingFloor({ customerId?, productIds? })` (shared by every dated form; returns the date and what sets it) |
| `payments` | `create()`, `list(q)`, `void(id, reason)` |
| `expenses` | `list(q)`, `create()`, `update()`, `void()`, `categories.list/create/update` |
| `reports` | `dailySales(range)`, `monthlySales(year)`, `stock()`, `lowStock()`, `outstanding()`, `expenses(range)`, `profitLoss(range)` |
| `dashboard` | `summary(today)` |
| `backup` | `createManual()` (main opens save dialog), `listAuto()`, `restore()` (main opens file dialog), `openBackupFolder()` |
| `print` | `invoice(id, { mode: 'print' \| 'pdf' })` |
| `maintenance` | `integrityCheck()` |

The preload's `api` is **generated from the contract keys**, so the preload and the main handlers cannot drift
apart. Typecheck enforces both sides.

### 14.3 Result envelope and errors

```ts
type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }
type AppError = {
  code: 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INSUFFICIENT_STOCK' | 'PRICE_CHANGED'
      | 'DUPLICATE' | 'FORBIDDEN_STATE' | 'DATE_NOT_ALLOWED' | 'DB_ERROR' | 'INTERNAL'
  message: string                            // user-safe text
  fieldErrors?: Record<string, string[]>     // from Zod, mapped onto RHF fields
  details?: unknown                          // e.g. [{productId, required, available}]
}
```

- Handlers never throw across IPC. Electron serialises thrown errors poorly and can leak stack traces.
- `lib/api.ts` in the renderer unwraps the envelope: data is returned, and an `AppError` is thrown for TanStack
  Query / RHF.
- Unexpected errors are logged in full to `userData/logs/app.log`. The renderer gets `INTERNAL` plus a short id.

### 14.4 Validation boundaries

| Layer | Validation | Purpose |
|---|---|---|
| Renderer form | Zod schema via `zodResolver` | Fast UX feedback |
| Main IPC handler | **Same Zod schema, always re-parsed** | Security + correctness (the renderer is untrusted) |
| Service | Business rules (stock, active status, state transitions, price recompute) | Domain invariants |
| DB | `STRICT`, `CHECK`, FK, UNIQUE, triggers | Last line of defence |

The `handle()` wrapper also validates `event.senderFrame.url` belongs to the app (file:// app path or the dev
server URL).

---

## 15. React State Management Strategy

| State | Lives in | Examples |
|---|---|---|
| Persistent business data | **SQLite** (only) | products, stock, invoices, balances, settings |
| Server-state cache | **TanStack Query** | lists, details, reports, dashboard, settings read |
| Form state | **React Hook Form** (+ Zod) | product form, payment form, stock-in form |
| Cross-screen UI state | **Zustand** | sidebar collapsed, **new-invoice draft** (customer, lines, tier, freight, request_id), last-used filters |
| Ephemeral UI | `useState` | dialog open, hovered row, search box text before debounce |

Zustand rules:

- A draft is never "truth". The server recomputes everything on save.
- The invoice draft *may* persist to `localStorage` so an accidental navigation or window reload keeps the
  unsaved bill. It is cleared on successful save. A banner shows "Unsaved draft from 10:32 — Resume / Discard".
- No product, stock, or balance data is copied into Zustand stores. Components read those via queries.

TanStack Query configuration:

- `refetchOnWindowFocus: false`, `retry: 0` for mutations and `retry: 1` for queries (local DB errors are not
  transient), `staleTime: 30s`.
- Query keys come from a `queryKeys` factory, e.g. `['products','list',filters]`.
- **Invalidation map** after mutations:

| Mutation | Invalidate |
|---|---|
| invoice create/void | invoices, products (stock), stock, customers (balance/ledger), payments, dashboard, reports |
| stock receive/adjust/void | stock, products, dashboard, reports |
| payment create/void | payments, customers, dashboard, reports |
| expense * | expenses, dashboard, reports |
| product/customer/company * | the respective domain + pickers |
| settings update | settings (+ invoices print preview) |
| restore | **everything**. The app relaunches anyway. |

---

## 16. UI Screens and Navigation

Layout: a persistent left sidebar, a top bar (business name, date, backup status indicator), and the content
area. It targets 1366×768 minimum, a common shop PC resolution.

| Route (hash) | Screen | Key elements |
|---|---|---|
| `#/` | Dashboard | KPI cards (today sales, month sales, month expenses, gross/net profit month, stock value, receivables), low-stock table, recent invoices |
| `#/invoices/new` | **New Invoice** | Customer picker (code/name/shop/phone/city + balance), tier toggle, product search (code or name, keyboard-first), lines grid (unit quantities per A3, price, discount, Sch/Ctn per B2/B3, net, available/remaining), Invoice Code + dispatch fields if enabled (B1/B4), date field showing the earliest allowed date for the chosen customer and products (C1), extra discount, freight, received, totals panel (current, previous, outstanding), Save / Save & Print |
| `#/invoices` | Invoice History | Filters: invoice no, customer name, shop name, date range, status; table; row → detail |
| `#/invoices/:id` | Invoice Detail | Saved data, Print/PDF, Void (reason dialog), linked payments |
| `#/products` | Products | Table with stock (multi-unit breakdown), prices, active filter, company filter; add/edit dialog with units editor; deactivate |
| `#/products/:id` | Product / Stock Card | Details + movement history with running balance |
| `#/stock/in` | Stock In | Receipt form (date, supplier text, reference, lines: product, unit, qty, unit cost) + history tab |
| `#/stock/adjustments` | Adjustments | Reason-coded adjustments (§8.6), linked receipt corrections, history |
| `#/customers` | Customers | Table with balance, search; add/edit |
| `#/customers/:id` | Customer Detail | Profile, balance, ledger with running balance, invoices, payments, "Receive payment" |
| `#/payments` | Payments | List + receive payment dialog + void |
| `#/expenses` | Expenses | List, filters, totals by category, add/edit/void, categories manager |
| `#/reports` | Reports | Tabs: Daily sales, Monthly sales, Stock, Low stock, Outstanding, Expenses, Profit & Loss. Each is printable. |
| `#/settings` | Settings | Business profile, invoice numbering/prefix/footer/paper, currency, stock options, Backup & Restore, Maintenance (integrity check), About (versions, data folder) |
| `#/print/invoice/:id` | (internal) | Print layout. Only loaded in the hidden print window. |

Keyboard: the New Invoice screen is fully keyboard-operable. `F2` new invoice, `Ctrl+S` save, `Enter` to add a
line, `Del` to remove a line. Numbers are formatted per currency settings (`Rs 12,345.00`), and the user types
plain decimal input that is parsed to minor units.

shadcn/ui components expected: button, input, label, select, combobox (command + popover), dialog, alert-dialog,
table, tabs, card, badge, dropdown-menu, form helpers, sonner (toasts), calendar/date picker, separator,
skeleton.

---

## 17. Invoice Printing/PDF Strategy

- **Only saved invoices are printable.** The print API takes an `invoice_id`. Main loads the invoice from
  SQLite. Status `VOID` prints a "VOID" watermark.
- Mechanism:
  1. Main creates a hidden `BrowserWindow` (same secure preload) and loads `#/print/invoice/:id`.
  2. The print page fetches the invoice via `window.api.invoices.get(id)` plus settings and renders a
     print-only layout (CSS `@page` size from settings: A4, A5, or thermal per E1).
  3. The page signals readiness (fonts and data loaded). A dedicated `print:ready` invoke is the single
     allowed notification.
  4. Main calls `webContents.print({ silent: false })` (system print dialog, user picks the printer).
     For **PDF** it calls `webContents.printToPDF()` and writes the file to a path chosen in a main-process
     save dialog (default: `Documents/Invoices/INV-000123.pdf`).
  5. The hidden window is closed.
- Reprint from history uses the same path, because it is always loaded from the DB.
- Amount in words is a pure shared function with unit tests. The numbering system (lakh/crore vs
  million/billion) and currency words come from settings (E2).
- Thermal/receipt printers (80 mm) are a later option: another `@page` layout, no model change.

---

## 18. Local File/Image Strategy

V1 stores **no binary files in the DB**, and the renderer never gets filesystem access.

| Item | Location | Access |
|---|---|---|
| Database | `<data>/shop.db` (+ `-wal`, `-shm`) | main only |
| Auto backups | `<data>/backups/` | main only; "Open folder" via `shell.openPath` |
| Manual backups | user-chosen path (USB, etc.) via main `dialog.showSaveDialog` | main only |
| Logs | `<data>/logs/app.log` (rotating, ~5 MB × 3) | main only |
| PDFs | user-chosen path | main only |
| Logo (later) | copied into `<data>/assets/logo.<ext>` via main file dialog | renderer receives a **data: URL** through `settings.getLogo()` (CSP already allows `img-src data:`) |

Paths are never accepted from the renderer. All file dialogs are opened by main, so the renderer cannot request
arbitrary paths.

---

## 19. Database Location

- **Production:** `%APPDATA%\<AppDataFolder>\data\shop.db`, e.g.
  `C:\Users\<user>\AppData\Roaming\ShopManagement\data\shop.db`. This is outside Program Files and outside the
  install directory, so reinstalling, updating, or uninstalling the app does not touch it.
- **Folder name pinned in code**, not derived from `productName`. Electron's default `userData` is
  `%APPDATA%\<productName or name>` (currently it would be `%APPDATA%\shop-management`). A later rename of the
  product would silently point the app at an **empty new folder**. So `paths.ts` computes
  `app.getPath('appData') + '\\' + APP_DATA_FOLDER` from a constant that never changes, and calls
  `app.setPath('userData', …)` before `ready`. (F2: choose the permanent folder name.)
- **Development uses a different folder** (`<APP_DATA_FOLDER>-dev`), so `npm run dev` can never touch the real
  shop database.
- NSIS uninstaller: keep `deleteAppDataOnUninstall: false` (explicit in `electron-builder.yml`).
- Settings → About shows the data folder path, with an "Open folder" button.
- Portable/USB mode is out of scope.

## 20. Backup and Restore Strategy

### 20.1 How a backup is made

- Use SQLite's **online backup** (`db.backup(dest)` or `node:sqlite` `backup()`), or `VACUUM INTO 'dest'`.
  Both produce a consistent snapshot, including WAL content, while the app is running.
- **Never copy `shop.db` with the filesystem while it is open.** That can miss WAL pages or capture a torn
  state.
- Write to `dest.tmp` first. Then **verify**: open it read-only, run `PRAGMA integrity_check` = `ok`, check the
  `application_id` matches, and read `user_version`. Only then rename it to the final name.
- Filename: `shop-backup_2026-09-10_1830_v1.0.0_s3.db` (date, app version, schema version). A small JSON
  sidecar holds counts (products, invoices, last invoice no.) so the restore screen can show what is inside.

### 20.2 When backups are made

| Trigger | Where | Retention |
|---|---|---|
| Automatic: first launch of each day + on app quit (throttled to at most 1 per hour) | `<data>/backups/auto/` | last **14 daily** + first-of-month for **12 months** (configurable) |
| **Before every migration** | `<data>/backups/pre-migration/` | keep last 5 |
| **Before every restore** (backs up the current DB) | `<data>/backups/pre-restore/` | keep last 5 |
| Manual "Backup now" | user chooses a folder (USB/other drive) | user-managed |
| Optional extra copy of each auto backup | `backup.extraFolder` (e.g. a second drive `D:\ShopBackups`) | same rotation |

A backup on the same disk as the DB **does not protect against disk failure or theft**. The UI shows "Last
external backup: 9 days ago" in amber after 7 days, to nudge a USB backup.

### 20.3 Failure handling

- If a backup fails (disk full, permission, USB removed), the `.tmp` file is deleted, the error is logged, a
  toast appears, and the top-bar indicator turns red. **The app keeps working.** Backup failure never blocks
  sales, except that a failed **pre-migration** backup aborts the migration (§21).
- Rotation deletes old files only **after** a new backup has been verified.

### 20.4 Restore (Settings → Backup & Restore)

1. The user clicks Restore. **Main** opens a file dialog; the renderer never supplies the path.
2. Validate the candidate **in a temporary copy**:
   - It opens as SQLite.
   - `application_id` matches, so it is our file and not some other `.db`.
   - `PRAGMA integrity_check = ok`, `foreign_key_check` is empty.
   - `user_version` ≤ the app's latest schema version. A **newer** schema is refused: "This backup was made by
     a newer version of the app (schema 5). Install v1.3+ to restore it."
3. Show a summary (backup date, invoice count, last invoice no., products, customers) and require typed
   confirmation, e.g. `RESTORE`.
4. Back up the current database to `pre-restore/`.
5. Close the DB connection. Replace `shop.db` with the validated copy (atomic rename), and delete stale
   `-wal`/`-shm`.
6. Reopen the DB and run migrations if the backup is older (the pre-migration backup happens as usual).
7. `app.relaunch(); app.exit(0)`, so no stale renderer caches survive.
8. If any step after 4 fails, put the pre-restore copy back and report the error.

---

## 21. Database Migration Strategy

- Migrations are **TypeScript modules embedded in the main bundle** (`db/migrations/0001_initial.ts`, …), each
  `{ version, name, up(db) }`. They are not loose `.sql` files, which would need asar/extraResources handling.
  They are **forward-only**. Applied migrations are never edited. A checksum is stored to detect accidental
  edits in development.
- Startup sequence:
  1. Open the DB (create it if missing), set pragmas.
  2. Check `application_id`. A foreign file means refuse.
  3. Read `user_version`.
  4. If `user_version > LATEST`, **refuse to open** and show a dialog ("Database is from a newer app version;
     install the newer version or restore a compatible backup"). Downgrades are never allowed to corrupt data.
  5. If `user_version < LATEST`:
     - Take a **verified pre-migration backup**. If it fails, abort startup with a clear dialog, and do not
       migrate.
     - For each pending migration, run it in **its own transaction**. It performs the DDL/DML, inserts into
       `schema_migrations`, and sets `PRAGMA user_version`. The migration is atomic: it applies fully or not
       at all.
     - Run `PRAGMA foreign_key_check` + `integrity_check` after migrating. On failure, roll back and tell the
       user the pre-migration backup location.
  6. Seed defaults idempotently: settings keys, sequences, expense categories, and the walk-in customer.
- SQLite DDL is transactional, so a failed migration leaves the old schema intact.
- For table rebuilds (SQLite has limited `ALTER`), follow the documented 12-step pattern: `foreign_keys=OFF`
  outside the transaction, create new → copy → drop → rename → `foreign_key_check` → `foreign_keys=ON`.
- The DB is opened **before** the window is created. The renderer shows nothing until migrations finish. A
  small native splash/dialog appears on failure.
- Tests: each migration runs against a fresh DB **and** against a fixture DB of the previous version (§24).

---

## 22. Manual App Update Strategy

- Distribute a new NSIS installer (`shop-management-1.1.0-setup.exe`). The user closes the app and runs the
  installer. NSIS upgrades in place, because it has the same `appId` and the same install dir.
- **Data is untouched.** The DB is in `%APPDATA%\<AppDataFolder>`, not in the install directory. The new
  version opens it, takes a pre-migration backup, and migrates (§21).
- Requirements that make this safe:
  - `appId` is **final before the first install** (F2). Changing it later makes NSIS treat the app as a
    different product.
  - `APP_DATA_FOLDER` never changes.
  - The single-instance lock plus a "please close the app" check (NSIS detects the running app) prevents
    replacing files in use.
  - Remove the placeholder `publish:` block. No auto-update code is shipped.
- **Rollback:** install the previous installer. If the DB was already migrated to a newer schema, the old app
  **refuses to open it** (§21 step 4) instead of corrupting it. The user restores the pre-migration backup to
  go back. This is documented in a short `UPDATING.md` for the shop owner.
- Code signing: an unsigned installer triggers Windows SmartScreen warnings. That is acceptable for V1 on one
  or two known PCs. Certificate purchase is a later decision.

---

## 23. Validation and Error Handling

- **Schemas (shared, Zod v4)** use strict objects, which reject unknown keys.
  - Money input arrives as **integer minor units**. Parsing from the text field (`"1,250.50"` → `125050`) is
    done by `money.parse` in the renderer, with at most `minorDigits` decimals. Main re-checks
    `int().nonnegative().max(MAX_MONEY)`.
  - Quantities are `int().positive().max(1_000_000)`. Dates use `YYYY-MM-DD` regex + real-date check, not in
    the future.
  - Strings are trimmed with length limits. Product code matches `[A-Za-z0-9-_/.]{1,32}`.
- **Numeric safety:** money limits are chosen so that `amount × qty` stays below 2^53. All `value × n / qty`
  COGS math uses **BigInt**. Rounding is always half-up (away from zero for positive values), in one helper.
- **Business errors** return typed codes that the UI can act on:
  - `INSUFFICIENT_STOCK` includes per-product `required/available`. The lines are highlighted.
  - `PRICE_CHANGED` offers a "reload prices" action.
  - `CONFLICT` covers a duplicate product code, with the field error shown.
  - `DATE_NOT_ALLOWED` covers a stock- or balance-affecting document dated before its scoped posting floor
    (its customer and/or any of its products) or in the future (§11.5). The details name what sets the floor.
  - `FORBIDDEN_STATE` covers cases like voiding an already void invoice, voiding a locked stock receipt (§8.5), or deactivating a product (warning
    only if stock > 0).
- **Unexpected errors:**
  - Logged in main with the stack. The user sees "Something went wrong (ref: 7F3A)".
  - `process.on('uncaughtException')` in main logs, shows a dialog, and does not continue on an unknown state
    if the DB is suspect.
  - A React error boundary per route shows "Reload screen".
- **DB errors** (`SQLITE_FULL`, `SQLITE_CORRUPT`, `SQLITE_IOERR`) map to `DB_ERROR` with guidance ("disk full",
  "run integrity check / restore backup").

---

## 24. Testing Strategy

| Level | Tool | What |
|---|---|---|
| Pure domain | Vitest | `money` (parse/format/round, BigInt), `quantity` (toBase/split for 1-, 2- and 3-level unit sets, nesting validation, both §9.3 tables), `invoice-calc` (discount bps & amount, freight, totals), `amountInWords` (0, 1, 19, 100, 1 lakh/1 million, 99,99,999.99), sequence formatting |
| Services + DB | Vitest with a temp-file / `:memory:` SQLite DB migrated from scratch | Every service. Especially the invoice transaction, stock checks, COGS/average, voids, ledger balance, idempotency, triggers blocking UPDATE/DELETE. Also: the receipt-void rule (the §8.5 counter-example; a receipt with the same product on two lines stays voidable; any other document locks it), correction valuations and guards, the L1 cost-correction example (lifetime COGS = true cost), reason code → P&L mapping, scoped posting-date floors (unrelated customer/product activity doesn't block; related activity does), and free scheme goods in COGS |
| Failure injection | Vitest | Force an exception after step 10 of invoice save and assert **nothing** persisted (no invoice, no movement, no ledger row, sequence unchanged) |
| Migrations | Vitest | Fresh DB → latest; old-version fixture → latest; `user_version > latest` → refuse; failed migration → rollback |
| Backup/restore | Vitest (main code, temp dirs) | Backup verified; corrupt/foreign/newer file rejected; restore swaps + pre-restore copy exists |
| Invariants (property-style) | Vitest with random sequences of receive/sell/void/adjust | Q ≥ 0; V ≥ 0; V = 0 when Q = 0; Σ ledger = expected balance; the §13 reconciliation identity holds |
| IPC | Vitest | `handle()` wrapper rejects bad input with `VALIDATION`, never throws raw |
| UI (light) | Vitest + Testing Library (optional) | New Invoice totals panel and unit quantity inputs; draft persistence |
| Manual E2E | Checklist (§28) on the **packaged** build | install, create data, update, restore, print |

**Driver/test note:** if `better-sqlite3` is chosen, its binary is compiled for Electron's ABI and will not
load in plain Node. So tests run Vitest through Electron-as-Node (`ELECTRON_RUN_AS_NODE=1 electron
node_modules/vitest/vitest.mjs`) via an npm script. This is verified in the Phase 3 spike. With `node:sqlite`,
plain Node 22 works directly.

Scripts to add: `test`, `test:watch`, `test:coverage`. Services and domain must reach ≥ 90% coverage.

## 25. Implementation Phases (exact recommended order)

Each phase is a small, reviewable change set that ends with `npm run typecheck`, `npm run lint`, and tests
green. Nothing starts until the previous phase is approved.

Business-decision gates (details in §27):

- Phases 0–2 need only the Group F answers.
- **Phase 3 (schema) needs Groups A and B.**
- Phase 6 needs D1–D3 and D7.
- Phase 8 needs A3, B5, B6, and C1–C8.
- Phase 9 needs E1–E2.

Phases 0–2 can proceed while the client questions are being answered.

Ordering rationale:

- Safety infrastructure (security, DB, migrations, backup) comes **before** any data entry.
- Master data comes before transactions.
- Stock comes before invoices.
- Reports come last, because they depend on everything.

### Phase 0 — Repository baseline & project hygiene

- **Objective:** a clean, versioned, secure starting point with the final app identity.
- **Files:**
  - `.gitignore`, `package.json` (`productName`, `author`, `description`)
  - `electron-builder.yml` (appId, productName, remove `publish`, `deleteAppDataOnUninstall: false`, drop
    mac/linux targets if Windows-only, F4)
  - `src/main/index.ts`, `src/main/window.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`
  - `src/renderer/index.html` (title, CSP)
  - Remove the template `App.tsx` content, `Versions.tsx`, and template assets
- **Dependencies:** none.
- **DB changes:** none.
- **Tasks:**
  - `git init` + baseline commit (F3).
  - Set `appId`, `setAppUserModelId`, and `productName` (F2).
  - Single-instance lock.
  - `sandbox: true`, explicit secure webPreferences.
  - Deny window.open, guard `will-navigate`, deny permission requests.
  - Stop exposing `window.electron`. Expose an empty typed `window.api`.
  - Move renderer-only deps to devDependencies (optional; keep `zod` in dependencies).
- **Tests:** typecheck/lint; manual: `npm run dev` shows the blank app; DevTools console confirms
  `window.electron` is undefined and `window.api` is an object.
- **Completion:** app launches with the new title; a second launch focuses the first window; no template UI
  remains.

### Phase 1 — UI foundation (Tailwind, shadcn/ui, routing, shell, test runner)

- **Objective:** a navigable empty app with the design system and a test runner.
- **Files:**
  - `electron.vite.config.ts` (Tailwind plugin, `@shared` alias)
  - `tsconfig*.json` (shared include, root paths for shadcn), `components.json`
  - `src/renderer/src/assets/main.css`, `app/router.tsx`, `app/layout/*`, `components/ui/*`, `lib/utils.ts`
  - Placeholder page per route
  - `vitest.config.ts`, package scripts
- **Dependencies (to install in this phase, after approval):** `react-router`, `clsx`, `tailwind-merge`,
  `class-variance-authority`, `lucide-react`, `radix-ui`, `tw-animate-css`, `sonner`, `vitest` (dev). Add
  shadcn components through the CLI (`npx shadcn@latest add …`).
- **DB changes:** none.
- **Tasks:**
  - Wire Tailwind v4.
  - Init shadcn with the `@renderer` aliases.
  - `createHashRouter` with all §16 routes as placeholders.
  - Sidebar + top bar.
  - QueryClientProvider with the configured defaults.
  - Toaster.
  - Route error boundary.
- **Tests:** one trivial Vitest test proves the runner; manual navigation through all routes.
- **Completion:** every sidebar entry opens its placeholder page; the production build (`npm run build`)
  succeeds.

### Phase 2 — Shared domain library (pure functions, no DB)

- **Objective:** correct money, quantity, invoice math, and amount-in-words, test-first.
- **Files:** `src/shared/domain/{money,quantity,invoice-calc,amount-in-words}.ts` + tests.
- **Dependencies:** none.
- **DB changes:** none.
- **Tasks:**
  - Minor-unit parse/format per currency settings.
  - Half-up rounding and BigInt mul/div.
  - `toBase` and `split` for 1..n nested units (§9.2).
  - Line/total calculators.
  - Words in the E2 numbering system.
- **Tests:** exhaustive unit tests (§24 first row), including both stress tables from §9.3.
- **Completion:** ≥ 95% coverage on `shared/domain`; reviewed rounding rules.

### Phase 3 — SQLite foundation: driver spike, connection, migrations, IPC skeleton

- **Objective:** a real DB in the right place, with versioned schema, pragmas, and a typed, validated IPC path.
- **Files:**
  - `src/main/paths.ts`, `src/main/logging.ts`
  - `src/main/db/{adapter,connection,migrate}.ts`, `db/migrations/0001_initial.ts`
  - `src/shared/{ipc-contract.ts,types/result.ts}`
  - `src/main/ipc/{handle,index}.ts`, `src/preload/index.ts`, `renderer/src/lib/api.ts`
- **Dependencies:** `better-sqlite3` + `@types/better-sqlite3` (**spike gate**, F1), or none if falling back
  to `node:sqlite`.
- **Business gate:** `0001` is written only after §27 A1, A2, A4, A5, B1, B2, B3, B4, and B7 are answered.
  The driver spike and the IPC skeleton may start earlier.
- **DB changes:** migration `0001` creates **all V1 tables, indexes, triggers, and views from §7**, plus seeds
  (settings, sequences, expense categories, walk-in customer). The whole schema lands at once so later phases
  only add code.
- **Tasks:**
  - **Spike:** install; verify the prebuilt binary downloads without compilation; verify `build:unpack` opens
    a DB; verify Vitest via Electron-as-Node.
  - Dev/prod data dirs.
  - Pragmas and `application_id`.
  - Migration runner with a newer-version refusal (the pre-migration backup hook is stubbed until Phase 4).
  - `handle()` wrapper with sender check + Zod + Result.
  - The first channel, `app:info`, displayed in Settings → About.
- **Tests:**
  - Migration on a fresh DB.
  - `user_version > latest` refusal.
  - Triggers block UPDATE/DELETE on ledgers.
  - CHECK constraints reject bad signs/negative money.
  - `handle()` returns `VALIDATION` for bad input.
- **Completion:** in dev, the DB is created in the `-dev` folder and About shows the schema version and path;
  in the packaged build, it is created in `%APPDATA%\<AppDataFolder>\data`.

### Phase 4 — Settings + Backup/Restore (before any real data exists)

- **Objective:** business settings, and data safety that works from day one.
- **Files:** `services/settings.service.ts`, `db/backup.ts`, `ipc/{settings,backup,maintenance}.ipc.ts`,
  `features/settings/*`, `features/backup/*`.
- **Dependencies:** none.
- **DB changes:** none (the tables exist); maybe settings seed tweaks via migration `0002` if needed.
- **Tasks:**
  - Settings form (RHF + Zod).
  - Invoice prefix/padding with a "next number preview".
  - Currency.
  - Footer and paper size.
  - Manual backup (save dialog), verification, and the sidecar file.
  - Automatic daily/quit backups with rotation.
  - Wire the pre-migration backup into the runner.
  - Restore flow (§20.4) with relaunch.
  - Integrity check screen.
  - Top-bar backup status indicator.
- **Tests:**
  - A backup file passes `integrity_check`.
  - Restore rejects a foreign file, a corrupt file, and a newer schema.
  - Restore creates a pre-restore copy.
  - Rotation keeps the correct set.
  - A failed backup does not delete old backups.
- **Completion:** settings persist across restarts; backup → change data → restore returns the old data after
  the automatic relaunch.

### Phase 5 — Companies & Products

- **Objective:** product master data with safe deactivation.
- **Files:** `services/{companies,products}.service.ts`, IPC, `shared/schemas/{company,product}.ts`,
  `features/products/*`.
- **Dependencies:** none.
- **DB changes:** none.
- **Tasks:**
  - List with filters and search.
  - Create/edit dialog with the verbatim packing label and a **units editor**, following the confirmed A1/A2
    structure:
    - base unit + larger units with their base quantities
    - nesting check
    - per-unit wholesale/retail prices
    - "derive from larger unit" helper
  - Unique code handling.
  - Deactivate/reactivate.
  - Unit sizes (`base_qty`, `is_base`) locked once the product has any movement.
  - Company quick-add.
- **Tests:** duplicate code → `CONFLICT`; unit size edit blocked when movements exist; non-nested unit sets
  rejected; inactive products are excluded
  from search but kept in history queries.
- **Completion:** 20 sample products can be created, edited, and deactivated; the table shows stock as 0
  in the multi-unit display.

### Phase 6 — Stock In, Adjustments, Opening Stock, Stock Card

- **Objective:** a ledger-based inventory with an audit trail.
- **Files:** `services/stock.service.ts`, `ipc/stock.ipc.ts`, `features/stock/*`, and the product stock card
  page.
- **Dependencies:** none.
- **DB changes:** none.
- **Tasks:**
  - Receipt form (multi-line, any purchasable unit, unit cost, exact line cost) → `STOCK_IN` movements in one
    transaction.
  - Receipt history/detail.
  - Receipt void **only while no other document has touched any of its products** since it was posted (§8.5;
    its own lines, even repeated products, never lock it). Otherwise the
    receipt is locked and corrected with linked `RECEIPT_QTY_CORRECTION` / `RECEIPT_COST_CORRECTION`
    adjustments.
  - Adjustments with the fixed reason codes of §8.6: valuation rules, a mandatory note, and the per-product
    posting-date floor (receipts too).
  - The cost-correction form shows the L1 warning (§8.5) before saving.
  - `assertStockInvariants` (Q ≥ 0, V ≥ 0, Q = 0 ⇒ V = 0) in every stock transaction.
  - Stock card with a running balance.
  - Stock summary.
- **Tests:**
  - Qty/value sums.
  - Average-cost COGS helper.
  - Adjust-out beyond stock is blocked.
  - An allowed receipt void restores (Q, V) exactly.
  - The §8.5 counter-example (void after sale + re-receipt) is rejected.
  - A receipt with product A on two lines stays voidable with no other activity. It becomes locked after any
    other sale, receipt, or adjustment of A or of any other product on it. Activity on unrelated products does
    not lock it.
  - Stock floors: a backdated receipt or adjustment for product B is allowed while product A has later
    activity, and blocked for A.
  - L1 example: after a late cost correction, lifetime COGS + remaining V = the true total cost.
  - Correction valuations and guards (Q > 0, V + δ ≥ 0).
  - Idempotent `request_id`.
  - Property test: random receive/adjust sequences never produce negative stock.
- **Completion:** stock shown in the product list matches the stock card totals.

### Phase 7 — Customers, Customer Ledger, Payments

- **Objective:** customer master and auditable balances.
- **Files:** `services/{customers,payments}.service.ts`, IPC, `features/customers/*`, `features/payments/*`.
- **Dependencies:** none.
- **DB changes:** none.
- **Tasks:**
  - Customer CRUD with auto code.
  - Opening balance → `OPENING` entry.
  - Searchable picker showing code/shop/city/phone/balance.
  - Customer detail ledger with a running balance.
  - Receive payment (idempotent, duplicate warning, customer posting-date floor). A backdated payment is
    blocked only by later activity of the same customer.
  - Payment void.
  - Payments list.
- **Tests:**
  - Balance = Σ ledger through every event type.
  - A double submit with the same `request_id` creates one payment.
  - Void adds back the amount.
  - Only one `OPENING` per customer.
- **Completion:** the outstanding total on the customers list equals the Σ of the ledger.

### Phase 8 — New Invoice (the critical transaction)

- **Objective:** an atomic, validated invoice save.
- **Files:** `services/invoices.service.ts`, `ipc/invoices.ipc.ts`, `shared/schemas/invoice.ts`,
  `features/invoices/{pages/NewInvoicePage,components/*,store/invoiceDraft.store.ts,hooks/*}`.
- **Dependencies:** none.
- **DB changes:** none.
- **Tasks:**
  - Draft store (+ localStorage persistence).
  - Customer and product pickers.
  - Lines grid per A3: unit quantities, price per tier/unit, discount per B5, Sch per B3, Ctn per B2, live
    available/remaining.
  - Invoice Code and dispatch fields (B1/B4); scoped posting-date floor (customer + every product) on the date field (C1).
  - Extra discount, freight, and received.
  - Totals panel with previous balance and outstanding.
  - Server workflow §11.2 (recompute, stock check, sequence, snapshots, COGS, movements, ledger, optional
    payment).
  - Error mapping to lines.
  - Keyboard shortcuts.
- **Tests:**
  - Happy path totals.
  - The §9.3 stress sequences (two- and three-level units).
  - Free scheme goods reduce stock and add COGS (if B3 = free goods).
  - A date before the customer's floor, or before any invoiced product's floor → `DATE_NOT_ALLOWED`, naming
    the blocker. Later activity on an unrelated customer or product does **not** block.
  - The previous balance of a catch-up (earlier-day) invoice equals the ledger balance at that date.
  - Two lines of the same product are aggregated for the stock check.
  - Insufficient stock → no rows written.
  - **Injected failure mid-transaction → nothing persisted and the sequence is unchanged.**
  - Idempotent retry.
  - Price changed → `PRICE_CHANGED`.
  - An inactive product/customer is rejected.
  - COGS equals the average cost, and the historical COGS stays unchanged after a later stock-in at a
    different cost.
- **Completion:** saving an invoice reduces stock, increases the balance, and the new invoice appears in queries
  without a manual refresh.

### Phase 9 — Invoice History, Detail, Void, Printing/PDF

- **Objective:** find, view, reprint, and void saved invoices.
- **Files:** `features/invoices/pages/{InvoiceHistoryPage,InvoiceDetailPage,InvoicePrintPage}.tsx`,
  `main/print/invoice-print.ts`, `ipc/print.ipc.ts`.
- **Dependencies:** none.
- **DB changes:** none.
- **Tasks:**
  - Filters (no., customer, shop, date range, status) with paging.
  - Detail view.
  - Void with a reason (stock + ledger reversal, C5).
  - "Update dispatch details" with change log (only if B4 confirms post-dispatch entry).
  - Print layout per the §11.1 field table, in the paper sizes chosen in E1.
  - Hidden-window print and PDF.
  - VOID watermark.
  - "Save & Print" from the New Invoice screen, which runs only after a successful save.
- **Tests:**
  - Void reverses exactly (stock and value restored, balance restored).
  - A double void is rejected.
  - The print API with an unknown or unsaved id returns `NOT_FOUND`.
  - Amount-in-words appears on the print.
- **Completion:** reprinting an old invoice after changing the product price and the customer's address shows
  the **original** values.

### Phase 10 — Expenses

- **Objective:** expense recording.
- **Files:** `services/expenses.service.ts`, IPC, `features/expenses/*`.
- **Dependencies:** none.
- **DB changes:** none.
- **Tasks:**
  - Categories management (with a group).
  - Add/edit/void.
  - List with date/category filters and totals.
- **Tests:** voided expenses are excluded from totals; validation of amount and date.
- **Completion:** monthly totals by category are correct.

### Phase 11 — Dashboard, Reports, Profit & Loss

- **Objective:** the business overview and printable reports.
- **Files:** `services/{reports,dashboard}.service.ts`, IPC, `features/{dashboard,reports}/*`.
- **Dependencies:** none (tables/cards via shadcn; charts are optional and deferred).
- **DB changes:** possibly additional indexes via migration `0002` after measuring.
- **Tasks:**
  - Dashboard KPIs.
  - Daily and monthly sales.
  - Stock report (qty box/pcs, value).
  - Low stock (qty ≤ threshold, active only).
  - Customer outstanding (non-zero balances, sorted).
  - Expense report.
  - P&L per §13 (operating stock losses/gains, and inventory data corrections shown separately per D2).
  - Print each report via the same hidden-window mechanism.
- **Tests:**
  - A seeded scenario with known expected figures (revenue, COGS, gross, freight, operating stock
    losses/gains, inventory data corrections, expenses, net).
  - Each adjustment reason code lands in its defined P&L line.
  - Opening stock and cost corrections never appear as profit.
  - Voided documents are excluded.
  - Month boundaries.
- **Completion:** hand-calculated figures for the seeded scenario match every report.

### Phase 12 — Hardening, packaging, update & restore rehearsal

- **Objective:** release candidate V1.0.0.
- **Files:** `electron-builder.yml`, `build/icon.*` (real icon), `UPDATING.md`, `BACKUP-RESTORE.md` (short
  owner guides).
- **Dependencies:** none.
- **DB changes:** none.
- **Tasks:**
  - Real icon and product name.
  - `build:win`.
  - Install on a clean Windows user.
  - Full §28 checklist.
  - Rehearse an update: build 1.0.0 → enter data → install 1.0.1 with a dummy migration `0002` → data
    retained + pre-migration backup present.
  - Rehearse restore and rollback.
  - Large-data smoke test (seed 5k products, 50k invoices) for picker/report responsiveness.
- **Tests:** full automated suite + the manual checklist on the packaged build.
- **Completion:** every §28 item is ticked.

## 26. Risks / Edge Cases / Failure Scenarios

Each scenario was stress-tested against the design. The "Mitigation" column cites the relevant mechanism.

| # | Scenario | What could go wrong | Mitigation in this plan |
|---|---|---|---|
| 1 | Selling more stock than exists | Negative stock, phantom sales | **Negative stock is prohibited, and there is no setting.** The availability check runs inside `BEGIN IMMEDIATE`, aggregated per product over all lines, quantity rows, and free scheme qty. `assertStockInvariants` runs before COMMIT (§8.3). |
| 2 | Partial box / partial carton sales | Fractional quantities | Stock is counted in integer base units, and only whole units exist. Loose units are sold in the smaller unit (§9). |
| 3 | Misreading packing such as `1*18*24` | Every stock figure silently wrong | Packing text is **never parsed**. Unit sizes are entered explicitly per product after A1/A2 are confirmed. The schema gate blocks `0001` until then (§7, §9). |
| 4 | Unit conversion errors / stale unit sizes | Wrong multiplier | Conversion happens server-side from DB unit rows. `unit_base_qty` is snapshotted per quantity row. Unit sizes are locked after the first movement. A nesting rule applies. Tested pure functions for 1-, 2-, and 3-level structures (§9.3). |
| 5 | Mixed "2 Box + 5 Pcs" confusion on print | Customer disputes | Presentation is decision A3. Both options are mathematically exact, and the schema supports both (§9.6). |
| 6 | "Sch" is actually free goods | Stock and profit overstated if treated as a discount | B3 decides. If it is free goods, the scheme qty enters `qty_base`, the SALE movement, and COGS (§11.1). |
| 7 | Duplicate invoice numbers | Two bills with the same number | Sequence inside the save transaction + `UNIQUE(invoice_no, seq_no)` + single instance lock + single connection. |
| 8 | "Invoice Code" assumed to be something it isn't | Wrong data printed on legal documents | Stored as a separate literal field. It is not derived from invoice no. or customer code until B1 is answered (§7.3). |
| 9 | App crash / power cut while saving | Half-saved invoice | One transaction; WAL + `synchronous=FULL`; the draft survives and `request_id` prevents a double save on retry. |
| 10 | Deleting a product used by invoices | Broken history | No hard delete (FK RESTRICT + `is_active`). Snapshots on the lines. |
| 11 | Changing product price | Old invoices change | Quantity rows store `unit_price_minor`; lines store gross, discount, and net. Prints read snapshots only. |
| 12 | Changing product cost | Historical profit changes | COGS is frozen per line from the value ledger. The unit default cost is a pre-fill only. |
| 13 | Voiding a receipt whose stock was sold and replenished at another cost | Phantom inventory value or vanished cost (§8.5 example) | A receipt can be voided only while **no other document** has a movement for any of its products after the receipt's own movements. Its own lines, including repeated lines of the same product, never lock it. Otherwise it is locked and corrected by adjustments (§8.5, §8.6). The invariants are checked. |
| 14 | Stock corrections distorting profit | Data-entry fixes shown as operating profit/loss | Fixed reason codes, each with a defined P&L treatment. Data corrections are reported separately from operating results (§8.6, §13). |
| 15 | Backdated invoice with a misleading previous balance, or wrong as-of-date stock/COGS | Historical bill contradicts the ledger | **Scoped posting-date floors** (C1): the date can't be earlier than the latest activity of the invoice's customer or of any product on it, so the snapshot balance, stock check, average, and COGS are correct as of that date (§11.5). |
| 16 | Duplicate customer payments | Balance reduced twice | `request_id` UNIQUE, a disabled button, a same-day same-amount warning, and void-only corrections. |
| 17 | Rounding / money errors | Paisa drift | Integer minor units, BigInt, one half-up helper, sums of stored values, and DB `CHECK`s on totals. The final outflow takes exactly V (§8.4). |
| 18 | Inventory value drifting from quantity | V ≠ 0 at Q = 0 | Invariants `Q ≥ 0, V ≥ 0, Q = 0 ⇒ V = 0` are enforced per transaction; there is a reconciliation identity test and an integrity check. |
| 19 | Database corruption | Data loss | WAL + FULL sync, verified rotating backups (local + external), integrity tool, and a restore flow. The live file is never copied. |
| 20 | Update / migration failure | App won't start / half-migrated | A verified pre-migration backup is mandatory, each migration runs in its own transaction, integrity checks run after, and the old schema stays intact on failure. |
| 21 | Backup failure | False sense of safety | Verify before rename, no rotation without a new good backup, a red indicator, and a warning about the age of the last external backup. |
| 22 | Printing after a failed transaction | Bill for an invoice that doesn't exist | The print API takes a DB `invoice_id` only. "Save & Print" prints only after a successful save. |
| 23 | Restoring an incompatible DB | Crash / corruption | `application_id`, integrity, and FK checks; a newer schema is refused; older ones are migrated; a pre-restore backup is taken; the app relaunches. |
| 24 | Customers/shops with the same names | Invoice to the wrong customer | Unique internal code; the picker shows code, shop, city, phone, and balance. |
| 25 | Incorrect customer outstanding | Disputes | No stored balance; an append-only ledger with one entry per event; the customer's posting-date floor keeps that ledger in date order. |
| 26 | Dispatch fields (Bilty etc.) needed after printing | Pressure to "edit" posted invoices | If B4 confirms, only the dispatch fields are updatable, and every change is audit-logged. Money, stock, and customer stay immutable. |
| 27 | Dev run touches the production DB | Test data in the shop's books | Separate `-dev` data folder. |
| 28 | Product rename changes the data folder | "All data lost" after an update | Data folder name pinned in code; `appId` final before the first install. |
| 29 | Two app instances | Concurrent writers | Single-instance lock + SQLite locking. |
| 30 | Native driver fails to install (no C++ tools) | Blocked build | Phase 3 spike gate; `node:sqlite` fallback behind the `Db` adapter. |
| 31 | Very large numbers | Overflow | Zod limits + BigInt in value math. |
| 32 | Disk full | Save fails | Rollback + a `DB_ERROR` "disk full" message; backups check free space first. |
| 33 | Wrong system clock | Wrong dates, or a wrong floor | The date is visible on every document; future dates are blocked. A clock set far ahead would raise the floors of the customers/products touched, so the dashboard shows the system date prominently and the integrity tool flags dates after today. |
| 34 | Single-disk PC theft/failure | Total loss | External backup reminder, `backup.extraFolder`, owner routine. |
| 35 | Late purchase-cost correction after part of the receipt was sold | The original month's profit is misstated | **Accepted V1 limitation L1** (§8.5, §13): frozen COGS is not recalculated, δ flows into future COGS, and lifetime reconciliation stays exact. The form warns before saving, and the P&L discloses corrections posted in the period (D7). |
| 36 | Unrelated activity blocking catch-up entry | Operators forced to misdate bills | Floors are scoped per customer and per product (§11.5). Only the document's own customer and products can block it. |
| 37 | A receipt with repeated lines of the same product | The receipt is wrongly locked by its own lines | The lock test ignores movements that belong to the same receipt (§8.5 stress test). |

**Accepted weaknesses in V1:**

- There is no period locking, so a void changes the original period's P&L.
- There is no per-invoice payment allocation or aging.
- Costing is weighted average, not FIFO.
- **L1 — late purchase-cost corrections are not retrospective** (§8.5):
  - Frozen COGS is not recalculated, so part of a correction lands in future COGS.
  - Historical monthly P&L can differ from a fully retrospective system.
  - Lifetime totals reconcile exactly.
- There is no user login. A void reason is mandatory and every void is kept.
- A forgotten earlier bill keeps its real date only if its customer and every product on it have no
  later-dated activity. Otherwise it takes the latest of those dates (C1).

---

## 27. Decisions That Need My Approval

Answer by ID (e.g. "A3: Option B"). **Groups A and B are business questions about how the client works today.
They block the database schema (Phase 3).** Groups C–E shape specific screens. Group F contains technical
recommendations that only need a yes/no.

**Gate summary:**

| Phase | Needs answered first |
|---|---|
| 0–2 (setup, UI shell, pure math) | F1–F7 |
| 3 (schema `0001`) | **A1, A2, A4, A5, B1, B2, B3, B4, B7** |
| 6 (stock) | D1, D2, D3, D7 |
| 8 (new invoice) | A3, B5, B6, C1–C8 |
| 9 (print) | E1, E2 |

### Group A — Packing & selling units ⚠ business confirmation required

| ID | Question | Options / notes | Recommendation |
|---|---|---|---|
| **A1** | What does packing such as `1*12*18`, `1*18*24`, `1*24*24`, `1*60*18` mean, position by position? | Answer the questions in §9.1 (1, 2, 7). The plan does not interpret these values. | Client to answer. A photo of a filled invoice or a product carton label helps. |
| **A2** | Which **units** exist per product, which is the **smallest** unit counted/sold (base), and at which levels does the shop buy / count / sell (wholesale vs retail)? | e.g. only one unit; two levels; three levels, in the client's own words | Client to answer. The schema supports 1..n nested units. |
| **A3** | Mixed-unit sale presentation (e.g. 2 boxes + 5 pieces of one product) | **A:** two separate lines. **B:** one line with a quantity per unit. (Tradeoffs in §9.6.) | Follow the client's current paper practice. If they have none, B reads better but needs a two-price "Price" cell. **Your choice.** |
| **A4** | Lock unit sizes once a product has stock movements? | Yes (new packing = new product) / No | **Yes.** |
| **A5** | Store the wholesale and retail price explicitly for each sellable unit? | Explicit per unit / derived from one unit | **Explicit per unit.** |

### Group B — Meaning of the client's invoice fields ⚠ business confirmation required

| ID | Question | Why it matters | Recommendation |
|---|---|---|---|
| **B1** | What is **Invoice Code**? It is not assumed to be INV. Number or the customer code. Examples to rule in or out: series/book code, salesman/booker/route code, customer account code, something else. Is it typed per invoice, or fixed per customer/route? | Where it comes from; whether it's a new master field | Stored as a separate text field until answered. |
| **B2** | What is **Ctn**? | If derived (e.g. cartons in the quantity), it is computed at print. If entered (e.g. physical cartons dispatched), it becomes an informational column. **Never used in stock math** either way. | Client to answer. |
| **B3** | What is **Sch**? Free goods (quantity), a scheme discount (amount or %), or something else? And the exact formula for **Net Amount** (Gross − Discount − Sch?) | Free goods change stock and COGS; a discount changes only money | Client to answer with one real example line. |
| **B4** | Are **Bilty Number / Transport Service / Adda Name** required in V1? Known at billing time or only after dispatch? Free text, or pick lists? | Whether dispatch fields must be editable after posting (audit-logged) | Include them as optional text fields, editable after posting with a change log. |
| **B5** | **Discount:** per line as %, as amount, or both? Also an invoice-level extra discount? | Calculator and print columns | Per line % or amount, plus an optional extra discount. |
| **B6** | Is **Current Invoice** = Σ line Net Amount (before freight)? If cash is received at the counter, is it shown and deducted in **Net Outstanding** on the print? Which figure is written in **Amount in Words**? | Print totals block | Current Invoice = Σ net − extra discount. Show "Received" when > 0. Words = Current Invoice + Freight. **Please confirm.** |
| **B7** | **INV. Number** format: prefix, digits, and the **starting number**, e.g. continuing the paper book? | Sequence seed | Configurable prefix/padding/start. |

### Group C — Invoice workflow policies

| ID | Question | Options | Recommendation |
|---|---|---|---|
| **C1** | **Backdated documents** (invoices, payments, receipts, adjustments) | A: recalculate as of the historical date (unsafe with immutable snapshots). B: no backdating. **C: scoped posting-date floors**: per customer for balance documents, per product for stock documents, and both for invoices (§11.5). | **C.** |
| **C2** | **Invoice price override:** may the operator change a unit price on a line? | Allowed (the saved price is what was charged) / list price only / allowed with a note | Allowed, with the list price shown beside it and a "price changed" marker on the line. **Your choice.** |
| **C3** | **Sales returns** in V1? | V1 (return document → `SALE_RETURN` movement + ledger credit) / V1.1 | **V1.1.** The schema is ready and void covers mistakes. Choose V1 if partial returns are frequent. |
| **C4** | Correcting a posted invoice | Void + re-create / allow edits | **Void + re-create.** |
| **C5** | Counter cash on an invoice that is later voided | Keep as customer credit / void it too | Keep as credit. |
| **C6** | A "Cash / Walk-in" customer for counter sales? | Yes / No | Yes. |
| **C7** | "Received" field on the invoice (payment in the same transaction)? | Yes / No | Yes. |
| **C8** | Balance model | Running account / per-invoice allocation | Running account. |

### Group D — Inventory corrections & accounting

| ID | Question | Recommendation |
|---|---|---|
| **D1** | **Stock receipt correction policy:** void only while no *other* document has touched any of its products since it was posted (the receipt's own lines never lock it); otherwise quantity/cost corrections via linked adjustments (§8.5) | **Approve as proposed.** |
| **D2** | **Adjustment reason list and P&L mapping** (§8.6). Should "Inventory data corrections" be included in the headline net profit, or only shown below it? | Approve the list; show corrections **below** net operating profit. |
| **D3** | Weighted-average costing (negative stock is prohibited in V1 and not configurable) | Approve. |
| **D4** | Freight charged = other income (separate from goods revenue); freight paid = an expense category | Approve. |
| **D5** | Expenses editable; delete = void | Approve. |
| **D6** | Deactivating a product that still has stock | Allow, with a warning. |
| **D7** | **Late purchase-cost corrections (V1 limitation L1, §8.5).** Accept that a cost correction made after some of the receipt's stock was sold is charged to future COGS, and is not re-applied to past months (frozen COGS is never recalculated)? Alternatives: (b) forbid cost corrections once any stock of that product has been sold since the receipt, and book the difference as a current expense instead (same timing effect, less transparent); (c) retrospective recalculation (post-V1; conflicts with frozen COGS and printed history). | **Accept L1 (a)**, with the on-screen warning and the P&L disclosure. |

### Group E — Printing

| ID | Question | Recommendation |
|---|---|---|
| **E1** | Paper: **A4**, **A5**, or **thermal 80 mm**? One, or several? | A4 portrait first, A5 optional; thermal after V1 unless needed now. **Your choice.** |
| **E2** | Currency and amount-in-words style | PKR (Rs), 2 decimals, lakh/crore wording. **Please confirm.** |

### Group F — Technical & setup (recommendations; approve or change)

| ID | Decision | Recommendation |
|---|---|---|
| **F1** | SQLite driver | `better-sqlite3`, gated by the Phase 3 spike; `node:sqlite` as the fallback, behind the `Db` adapter. |
| **F2** | Permanent identity: `productName`, `appId`, data folder name (never changed after the first install) | Please choose, e.g. "Shop Management" / `com.<business>.shopmanagement` / `ShopManagement`. |
| **F3** | `git init` + baseline commit before Phase 0 | Yes. |
| **F4** | Windows-only build targets | Yes. |
| **F5** | `synchronous=FULL` | Yes. |
| **F6** | Backup policy and external location (USB / second drive) | Daily + on quit, keep 14 daily / 12 monthly, plus an external copy. Where? |
| **F7** | Routing | `react-router` v7 hash router. |

---

## 28. Final V1 Acceptance Checklist

**Installation & data safety**

- [ ] Installer installs to Program Files; the DB is created under `%APPDATA%\<AppDataFolder>\data\shop.db`.
- [ ] A second launch focuses the existing window.
- [ ] Dev runs use the `-dev` data folder only.
- [ ] Installing a newer build keeps all data; a pre-migration backup is created when the schema changes.
- [ ] An older build refuses to open a newer-schema DB with a clear message.
- [ ] Manual backup to USB works and the file passes an integrity check.
- [ ] Automatic backups are created and rotated; a backup failure warns but doesn't block work.
- [ ] Restore rejects foreign, corrupt, and newer-schema files; a valid restore makes a pre-restore copy and
  relaunches.
- [ ] The integrity check reports OK on a healthy DB, including the stock invariants and the reconciliation
  identity.

**Security**

- [ ] `window.electron` is undefined; `window.api` exposes only typed functions.
- [ ] Sandbox and context isolation are on; there is no Node/fs in the renderer; navigation/window.open are
  blocked.
- [ ] Every IPC handler rejects invalid input with a `VALIDATION` error.

**Products, units & inventory**

- [ ] Products store the packing label verbatim, with units configured per the confirmed A1/A2 structure and
  per-unit wholesale/retail prices.
- [ ] Unit sizes can't change after stock movements exist; non-nested unit sets are rejected (unless A1 says
  otherwise).
- [ ] The §9.3 stress tables reproduce exactly in the app (two-level and three-level products).
- [ ] Selling more than the available stock is blocked, and **there is no negative-stock setting anywhere in
  the UI**.
- [ ] Each adjustment requires a reason code and a note; the stock card shows it; stock is never directly
  editable.
- [ ] A receipt, including one with several lines for the same product, can be voided while no other document
  has touched its products. Once any other sale, receipt, or adjustment touches one of its products, the Void
  button is disabled with an explanation, and qty/cost corrections work and are linked to the receipt.
- [ ] After any sequence of receipts, sales, voids, and adjustments: Q ≥ 0, V ≥ 0, and V = 0 whenever Q = 0.

**Invoices**

- [ ] The invoice prints every confirmed field from §11.1 (Invoice Code, INV. Number, Bilty, Transport, Adda,
  customer block, Packing, Qty, Price, Gross, Discount, Ctn, Sch, Net, Current Invoice, Freight, Previous
  Balance, Net Outstanding, Amount in Words, Checked By, Signature), laid out per the answers to A3/B1–B7.
- [ ] Mixed-unit quantities print per the A3 decision and the stock deduction equals the sum of the base
  units.
- [ ] If Sch = free goods, free units reduce stock and are included in COGS.
- [ ] Saving reduces stock, increases the balance, and assigns the next sequential unique number (continuing
  from B7's start number).
- [ ] A forced failure during save leaves no invoice, stock change, ledger entry, or consumed number.
- [ ] A double-click on Save creates exactly one invoice.
- [ ] Scoped posting-date floors:
  - A document dated before the latest activity of its customer or of any of its products, or dated in the
    future, is rejected with a message naming what sets the floor.
  - Activity on unrelated customers or products never blocks a backdated entry.
  - The previous balance on a catch-up invoice equals that customer's ledger balance at that date, and its COGS
    equals the as-of-date average.
- [ ] Reprints after price/cost/customer changes show the original values; dispatch-field edits (if enabled)
  are logged.
- [ ] History filters by invoice number, invoice code, customer name, shop name, and date range.
- [ ] Voiding restores stock and balance, keeps the number, and prints with a VOID watermark.

**Customers & payments**

- [ ] Customers with identical names are distinguishable in the picker.
- [ ] The ledger shows opening, invoices, payments, and voids with a correct running balance.
- [ ] A payment reduces the balance; a duplicate submit creates one payment; a void restores the balance.

**Expenses, reports, P&L**

- [ ] Expenses can be added, edited, and voided per category; voided ones are excluded.
- [ ] Dashboard figures match the reports.
- [ ] Reports match a hand-calculated scenario.
- [ ] The P&L shows gross profit, freight income, expenses, operating stock losses/gains, and separately
  "Inventory data corrections" (per D2). Opening stock and cost corrections never appear as profit.
- [ ] A later stock-in at a higher cost does not change past profit.

**Known V1 limitations (accepted and visible to the owner)**

- [ ] **L1 — late purchase-cost corrections are not retrospective** (§8.5, §13, D7):
  - Frozen historical COGS is not recalculated.
  - A late correction affects future COGS instead of the original period.
  - Historical monthly P&L may temporarily differ from a fully retrospective accounting system.
  - The cost-correction form shows this warning before saving, the P&L report lists the cost corrections
    posted in the period, and the owner guide explains it.
- [ ] After a late cost correction, the reconciliation identity still holds, and total COGS over the life of
  the stock equals the corrected purchase cost (the §8.5 L1 example reproduces exactly).
- [ ] Other accepted limitations are listed in §26: no period locking, no per-invoice payment allocation,
  weighted-average costing, and no user login.

**Quality gates**

- [ ] `npm run typecheck`, `npm run lint`, and `npm test` pass; domain and services have ≥ 90% coverage.
- [ ] The packaged `build:win` build passes this checklist on a clean Windows user account.

---

*End of plan (Revision 2). No application code, packages, or database have been created. Implementation may
begin with Phases 0–2 once Group F is approved. The schema (Phase 3) waits for the Group A and B answers.*
