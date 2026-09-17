# Phase 12 — Final V1 Release Hardening + Acceptance Test: Implementation Report

Status: implemented and verified. **Nothing committed** (starting point: HEAD `c0c498c`, clean tree).
- **Final:** StockFlow **1.0.0**, schema **2**. Migrations are only `0001_initial` and `0002_stock_adjustment_receipt_item`; there is no `0003`, and 0001/0002 are unchanged.
- **Scope:** no new business features; V1.1 not started.
- **Data safety:** every automated run used temporary appData folders. The real `%APPDATA%\StockFlow` and `StockFlow-dev` were fingerprinted before and after each run and are unchanged.

## 1. Changes made

| Area | Change |
|---|---|
| **Unsaved invoice on window close** | New Invoice keeps a `beforeunload` guard while the draft is dirty (`lib/unload-guard.ts`, `useUnloadGuard(dirty)`). Electron then fires `will-prevent-unload`, and the main process (`main/unsaved-close.ts`) asks *"You have an unsaved invoice. Close StockFlow and discard it?"* with **[Stay] [Close and Discard]**, modal to the window, Stay being default and cancel. No IPC is added: the renderer can only hold the page open, never close it. A clean, posted or cleared draft has no guard. In-app navigation blocking is unchanged. |
| **Dashboard** | The placeholder ("will be implemented in a later phase") becomes a start page: the business name and a link card per section with a one-line description. **It shows no figures.** The navigation `placeholder` text becomes a real `description`. `PlaceholderPage` is deleted (no route used it any more); a routes test now fails if any section lacks a real page. |
| **Installer** | `electron-builder.yml`: `oneClick: false`, `perMachine: true`, `allowToChangeInstallationDirectory: true` (assisted installer into Program Files; previously a per-user one-click install to `%LOCALAPPDATA%\Programs`). `publish: null`: no `app-update.yml` or `latest.yml` (they pointed at the Git remote; V1 has no updater). The zod TypeScript sources/tests are excluded from the package (708 files instead of 1,058). `deleteAppDataOnUninstall: false` and the desktop and Start Menu shortcuts are unchanged. |
| **Icon** | The default Electron atom icon (flagged in Phase 0 for Phase 12) is replaced by a StockFlow icon: the app's own Lucide "Boxes" brand mark in the sidebar amber on navy. It covers `build/icon.ico` (16–256 px), `build/icon.png` and `resources/icon.png`. **Please review.** |
| **Source hygiene** | Two literal control bytes in source (a NUL…US range in `invoice-print.ts`'s file-name regex, and a `\x01` temporary unit-name prefix in `products.service.ts`) are rewritten as escape sequences. Behaviour is identical and existing tests cover both. Tools previously treated those files as binary. |
| **Docs** | `stockflow-v1-release-notes.md`: the owner guide (install, data location, backups, USB backup, restore, updates, uninstall, limitations). |

- **New tests:** `unsaved-close.test.ts` (dialog wording, buttons, Close and Discard only on button 1), `unload-guard.test.ts` (guard on/off), `DashboardPage.test.tsx`, and the routes test.
- **No test was weakened or deleted.** The placeholder route test was replaced, because Dashboard (the last placeholder) is now a page.

## 2. Final app / schema / version

- **Identity (unchanged):**
  - productName `StockFlow`, appId `com.waqas.stockflow`;
  - production data `%APPDATA%\StockFlow\data\shop.db`, development data `%APPDATA%\StockFlow-dev\data\shop.db`;
  - Windows x64.
- **Version:** 1.0.0 lives only in `package.json`. The packaged app, `app.info`, backup names and sidecars, `schema_migrations.app_version` and the exe version resource (`ProductVersion 1.0.0.0`, `FileVersion 1.0.0`) all read it.

## 3. Installer result

> **Superseded (final audit, 17 Sep 2026).** The Phase 12 installer below is **not** the final V1 installer. It was rebuilt after the Dashboard visual improvement and the final audit fixes: `dist\StockFlow-1.0.0-setup.exe`, 95,250,189 bytes, built 17:00:17, SHA-256 `4524A385A6C13266BD7D74FD75F57CC5C35D6B7C20C5E8F48225687F894B9D67`, v1.0.0, x64, unsigned. See `final-audit-fixes-report.md` §11.

- **Build:** `npm run build:win` → NSIS, x64, `oneClick=false`, `perMachine=true`. Setup exe `95,236,888` bytes (~95 MB); unpacked app 333 MB, 92 files.
  - SHA-256 `EFD4C836ABF3125832B68D0D1E00044844478AAA9CEBB8317F98E4F65FA44244`.
- **Code signing: not configured. The installer and exe are NOT signed** (Authenticode status `NotSigned`). The build log's "signing with signtool.exe" lines do not sign without a certificate. Expect a SmartScreen warning.
- **Payload** (extracted with electron-builder's 7-Zip):
  - the app, Electron runtime and `better-sqlite3` native module;
  - `app.asar` is byte-identical to the verified `dist\win-unpacked` build and holds only `out/**`, `package.json`, `resources/icon.png` and production `node_modules`;
  - **no** `.db`, logs, screenshots, coverage, tests, docs or scratch files.
- **Uninstall data safety (from the generated NSIS uninstaller template):** it runs `RMDir /r "$APPDATA\StockFlow"` only if `deleteAppDataOnUninstall` is set (it is `false`) or the uninstaller is started with an explicit `--delete-app-data` switch. A normal uninstall or upgrade therefore keeps `%APPDATA%\StockFlow` (database, backups, logs, recovery).
- **Not installed on this PC** (see §14): the shell is not elevated, and this PC already has a real `%APPDATA%\StockFlow`, which an installed StockFlow would open.

## 4. Upgrade / reinstall result (packaged app, temporary data): 21/21

1. **First run:** no data folder → schema 2 with exactly 0001 and 0002 (app_version 1.0.0). Seeds are created once: walk-in customer, 4 expense categories, 11 settings, 5 counters. No pre-migration backup is needed.
2. **Second run:** identical table hashes and `applied_at`; no migration and no reseeding (log checked).
3. **Populated schema-2 database:** startup runs no migration and changes no row; checksums are accepted.
4. **Upgrade rehearsal:** a schema-1 database with Phase 5 master data (2 companies, Piece + Box products with wholesale/retail/cost, 3 customers, business name).
   - A verified `pre-migration` backup `…_v1.0.0_s1.db` is identical to the old data.
   - 0002 runs and every existing row is unchanged.
   - Schema 2, integrity OK; the app opens with the old products, prices and name.
5. **Newer database (schema 3):** "StockFlow cannot start … schema 3 … understands schemas up to 2. Install the newer version …" with a reference.
   - No recovery offered; exit 1.
   - The file is byte-identical, and no backup or restore is made.
6. **Checksum mismatch:** normal startup is refused; recovery offers **[Restore Backup] [Exit]**.
   - Exit leaves the file byte-identical, exit 1.
   - The reference and `SCHEMA_CHECKSUM_MISMATCH` are logged.

**Reinstall / update:** data lives only in `%APPDATA%\StockFlow`, and the installer writes only `$INSTDIR`. Installing 1.0.0 over itself was **not** run on this PC (§14).

## 5. Backup / restore / recovery result: 21/21

- **Automatic backup** at launch: verified (integrity ok, schema 2) with a sidecar in `backups\auto`.
- **Manual backup** through the Save dialog to a temporary "USB" folder: valid, and identical to the live data.
- **Invalid (foreign) file:** "This file is not a StockFlow backup." Nothing changes.
- **Restore** of the manual backup:
  - the validated summary shows schema 2 and the counts;
  - `RESTORE` confirmation → restored → relaunch requested, exit 0;
  - `pre-restore` holds the replaced data;
  - after the relaunch the data matches the backup source exactly (later changes gone).
- **Damaged live database** (header overwritten):
  - recovery mode → backup chosen in `backups\auto` → ticked confirmation → relaunch;
  - the damaged file is kept byte for byte in `recovery\damaged-live-db_*.db`;
  - the restored database equals the backup and passes the integrity check.
- **Automatic backup failure** (the temporary `backups\auto` made unwritable with an ACL, older backups dated yesterday):
  - health `FAILED` with a safe message ("The backup could not be written. Check that the drive is connected and has free space.");
  - the top bar shows **Backup failed** (after 55 s: the renderer refreshes backup status every minute, Phase 4B design) and Settings shows "Last automatic backup failed";
  - the app stays usable (a product was saved), a warning is logged, and prior backups keep the same files and bytes.
- **Integrity check** on populated data: overall OK. It covers SQLite integrity, foreign keys, application id, schema version, migration history, stock invariants, and ledger entries and balances. It fixes nothing.

## 6. Complete business acceptance scenario (packaged app): 37/37

The data was entered through the app's allow-listed IPC; the screens were driven through the real UI via CDP. It included:
- **Master data:** 2 companies; a Piece + Box product with retail and wholesale prices and a Kg product.
- **Stock:** opening stock, stock receipt, receipt cost correction, damage.
- **Customers:** account with an opening balance, two advance customers, walk-in.
- **Invoices:**
  - retail: Box + Piece, custom price, 5% discount, scheme money, 2 free pieces, freight, partial cash received, ctn and code;
  - wholesale: against an advance, with extra discount;
  - walk-in cash;
  - normal void; walk-in void with money returned.
- **Other documents:** bank payment, dispatch update, Shop / General / Freight Paid expenses and a void expense.
- **Screens:** all six report tabs; A4/A5 preview and PDF.

**Also verified:**
- **UI smoke:** all 11 sidebar routes plus invoice detail render content with no blank or broken route; sidebar navigation works; Add Expense opens and Escape closes it; **no renderer console errors or exceptions** in the whole run.
- **Unsaved invoice close:**
  - the prompt text and buttons are exact and modal;
  - Stay keeps the window and the draft; after Clear → Discard the form is clean;
  - Close and Discard closes normally: the shutdown backup decision is logged, "database was closed", exit 0.
  - A first-run clean window closes without asking.
- **Error messages** (codes checked, no SQLite text):
  - duplicate product code, both through the IPC call and shown in the real Products form: "Another product already uses the code "TEA-950".";
  - insufficient stock, posting date, inactive customer, already-void invoice, locked receipt;
  - duplicate payment warning (returns the matching RCP).
  - Invalid backup is covered in §5.

## 7. Ledger / inventory / report cross-check

Every figure was hand-calculated before running. Independent SQL agrees with the screens and reports.
- **Inventory:**
  - TEA-950: Q 157 = 6 Box + 13 Piece, V Rs 17,270.00;
  - SUG-1KG: Q 85 Kg, V Rs 10,200.00;
  - both equal Σ `stock_movements`, with Q ≥ 0, V ≥ 0 and Q = 0 ⇒ V = 0;
  - the Products screen, Products list API and Stock report agree; total Rs 27,470.00.
- **Customers** (Σ `customer_ledger`):
  - walk-in 0, Ali Rs 7,135.00 Due, Bilal Rs 2,500.00 Due, Chand Rs 1,000.00 Advance;
  - the Customers screen, Customer Detail, customers.get and the Balance report agree;
  - receivables Rs 9,635.00, advances Rs 1,000.00.
  - (My first hand figure for Ali, 6,635.00, was an arithmetic slip; the ledger was right.)
- **Invoices (every one):**
  - header totals = Σ lines;
  - net = Σ line net − extra discount; total = net + freight;
  - COGS = Σ frozen line cost = −Σ SALE movements;
  - ledger INVOICE entry = total; linked payment = received;
  - the voids reverse stock and ledger exactly; the walk-in void also voids its payment.
  - INV-000001: gross 7,300.00, discount 365.00, scheme 100.00, net 6,835.00, freight 300.00, total 7,135.00, previous 5,000.00, outstanding 9,135.00, COGS 6,050.00.
- **Reports (this month):**
  - **Sales:** 3 posted, gross 12,700.00, discounts 465.00, scheme 100.00, net 12,135.00, freight 300.00, billed 12,435.00, COGS 10,490.00, gross profit 1,645.00; 2 void (1,800.00).
  - **P&L:** Shop 400.00 (incl. Freight Paid 150.00), General 1,000.00, damage 440.00, **Net Operating Profit 105.00**, inventory correction +2,400.00, **Profit After Data Corrections 2,505.00**; opening stock 12,000.00 shown as information; frozen-COGS note shown.
  - **Products:** TEA 79 (3 Box + 7 Piece), 2 free, 9,935.00 / 8,690.00; SUGAR 15 Kg, 2,300.00 / 1,800.00; − extra discount 100.00 = 12,135.00.
  - **Expenses:** operating 1,400.00, 1 void (99.00) excluded.

## 8. Printing result

- **Print Preview of INV-000001:**
  - A4 and A5 (the paper toggle changes the document);
  - business name, customer snapshot, invoice code, Checked By, discount and scheme columns;
  - dispatch (Bilty BL-77, Daewoo Cargo, Badami Bagh);
  - total 7,135.00 and amount in words ("… Only").
- **Save as PDF:** a readable 210 mm-wide PDF containing the invoice number, dispatch and amount in words.
- **Historical snapshot:** after the customer was renamed, the invoice still prints "Ali Raza".
- **Void invoice:** prints with the **VOID** watermark.
- **Printer paths** (system print dialog, cancel) were validated in 9B and not repeated.

## 9. Security regression (packaged app)

- **Renderer:**
  - `window.electron`, `require`, `process`, `module`, `Buffer`, `global` and `ipcRenderer` are undefined;
  - no `api.invoke` / `api.send`; `window.api` and every domain object are frozen and contain only functions;
  - `window.open` returns null; navigation to `https://example.com` is blocked;
  - notification and geolocation permissions are denied.
- **Main window:** contextIsolation, sandbox and webSecurity on; nodeIntegration off; DevTools cannot be opened; no application menu. Packaged `StockFlow 1.0.0` with userData `<appData>\StockFlow`.
- **Single instance:** a second StockFlow on the same data folder exits 0 at once, and the first keeps its one window.
- **Nothing was loosened** for printing, recovery or the close prompt.
- **IPC inventory: 66 typed calls in 13 domains, all with a real caller** (several are called through action helpers). No dead API was found or removed:

  | Domain | Calls |
  |---|---|
  | `app` | `info` |
  | `settings` | `get`, `update` |
  | `backup` | `status`, `createManual`, `openFolder`, `selectRestoreCandidate`, `restore` |
  | `maintenance` | `integrityCheck` |
  | `companies` | `list`, `create`, `update`, `setActive` |
  | `products` | `list`, `get`, `create`, `update`, `setActive`, `search` |
  | `stock` | `receive`, `listReceipts`, `getReceipt`, `voidReceipt`, `adjust`, `listAdjustments`, `stockCard`, `summary`, `postingFloor` |
  | `customers` | `list`, `get`, `create`, `update`, `setActive`, `ledger`, `adjustBalance`, `search` |
  | `payments` | `list`, `get`, `create`, `checkDuplicate`, `void` |
  | `invoices` | `context`, `post`, `list`, `get`, `updateDispatch`, `void`, `printable`, `print`, `savePdf` |
  | `expenseCategories` | `list`, `create`, `update`, `setActive` |
  | `expenses` | `list`, `summary`, `get`, `create`, `update`, `void` |
  | `reports` | `profitLoss`, `sales`, `productSales`, `stock`, `customerBalances`, `expenses` |

- **Logging** (packaged):
  - error entries carry a `ref`, the stack and the code (for example a newer database: `ref=FADEFB`, `code: DATABASE_TOO_NEW`);
  - user folders are redacted (`%APPDATA%\StockFlow\data\shop.db`);
  - no customer, invoice, payment or expense data after the full acceptance run;
  - the stack shows the install path only;
  - rotation (5 MB, 3 files) is covered by the logging unit tests; the size was not reached in packaged runs.

## 10. Performance smoke check (packaged app): 4/4

Temporary dataset built with the app services in 5 s: 500 products, 501 customers, 2,000 invoices (5,000 lines), 5,500 stock movements, 3,100 ledger entries, 600 payments, 1,000 expenses.

| Measure | Result |
|---|---|
| Launch → app shell | ~0.95 s (includes inspector attach); database ready 15 ms |
| API calls: product / customer / invoice lists and searches, one year of P&L, sales, expenses, stock and balances, customer ledger | 2–14 ms each |
| Integrity check | 68 ms |
| Screens: Products, Customers, Invoice History, Payments, Expenses, Reports, New Invoice | 7–49 ms until their rows / fields render |
| Products search typing | 271 ms (including the 250 ms debounce) |

No performance defect was found and nothing was optimized.

## 11. Tests / coverage / build results (final tree)

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ 0 problems |
| `prettier --check src` | ✅ |
| `npm test` | ✅ **1928 passed in 98 files** (Phase 11: 1922 in 95) |
| `npm run test:coverage` | ✅ 99.00 % statements, 96.51 % branches, 99.28 % functions, 99.32 % lines |
| `npm run build` | ✅ main 347.03 kB, preload 8.04 kB, renderer 2,308.14 kB |
| `npm run build:unpack` | ✅ `dist\win-unpacked\StockFlow.exe` |
| `npm run build:win` | ✅ `dist\StockFlow-1.0.0-setup.exe` |

**Packaged acceptance on the final build:**
- startup / upgrade / refusal 21/21;
- backup / restore / recovery 21/21;
- business acceptance 37/37;
- performance 4/4.

## 12. Dependency / audit result

- `better-sqlite3` is exactly **12.11.1**. Also: electron 39.8.10, electron-builder 26.15.3, zod 4.6.1. Nothing was upgraded.
- `npm audit` (also with `--omit=dev`): **2 high**, the same inherited findings recorded since Phase 1.
  - `extract-zip` (symlink path traversal / arbitrary file write) through `electron`.
  - The only fix is `electron@44` (breaking), so it is not applied.
  - `extract-zip` is used by Electron's install-time download, not by the running app.

## 13. Known V1 limitations

- **No sales returns** (void and re-invoice).
- **No closed accounting periods:** back-dating is allowed down to each product's and customer's latest activity.
- **Historical COGS is frozen at posting:** later purchase-cost corrections affect future COGS only (L1).
- **Weighted-average costing;** payments are not allocated to invoices.
- **Stock and Customer Balance reports are current-only;** there are no report exports (invoice PDF only).
- **Updates are manual installers;** there is no auto-updater.
- **Single PC, single user:** no network database or logins.
- **Unsigned installer:** SmartScreen warning.
- **Backup-failure warning timing:** it appears within about a minute (status refresh interval).

## 14. Needs human / manual verification

1. **Real install / uninstall / reinstall on a clean Windows user account or VM** (not run here; see §3). Check:
   - UAC prompt; install to `C:\Program Files\StockFlow`; Start Menu and desktop shortcuts named StockFlow with the new icon;
   - first launch creates `%APPDATA%\StockFlow`;
   - reinstall 1.0.0 over it keeps data, backups and logs;
   - uninstall keeps `%APPDATA%\StockFlow`;
   - running the installer while StockFlow is open asks to close it.
2. **The new icon's appearance** (taskbar, shortcuts, installer) and SmartScreen wording.
3. **Native dialogs by eye:** the close prompt, recovery-mode boxes and the Windows message box layout. Automated runs stubbed them and checked their text and buttons.
4. **A real printer printout** of a representative invoice (the 9B print dialog path was not repeated).
5. **Code signing,** if SmartScreen warnings are not acceptable (a certificate is needed).

## 15. Installer / artifact paths

- **Final V1 installer (rebuilt after the Dashboard improvement and final audit fixes):** `D:\waqas\shop-management\dist\StockFlow-1.0.0-setup.exe`, NSIS, v1.0.0, x64, 95,250,189 bytes, SHA-256 `4524A385…9D67`, **unsigned**. The Phase 12 build of the same file name (95,236,888 bytes) has been replaced. Details: `final-audit-fixes-report.md` §11.
- `D:\waqas\shop-management\dist\StockFlow-1.0.0-setup.exe.blockmap`: electron-builder by-product (not needed to install).
- `D:\waqas\shop-management\dist\win-unpacked\StockFlow.exe`: the unpacked app (92 files; 349,704,976 bytes in the final build).
- `D:\waqas\shop-management\dist\builder-debug.yml`: build diagnostics (not part of the installer).

---

Phase 12 was the final phase. **Nothing is committed; no V1.1 work was started.**
