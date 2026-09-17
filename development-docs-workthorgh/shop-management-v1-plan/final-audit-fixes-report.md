# StockFlow V1: Final Audit Fixes Report

All confirmed final-audit fixes are implemented, tested, built into a new installer, and checked in the packaged app.

- **Schema:** version 2, with only `0001_initial` and `0002_stock_adjustment_receipt_item`. There is no migration 0003.
- **Scope:** no new feature, and no change to stock valuation, invoice posting or voids, the customer ledger, payments, backup/restore, printing layout, dashboard calculations or installer identity. `better-sqlite3` is still 12.11.1.
- **Commits:** nothing is committed.

## 1. P&L: receipt cost corrections no longer change profit

**Problem.** Phase 11 counted `RECEIPT_COST_CORRECTION` movement values as an inventory data correction, so they changed Profit After Data Corrections. A cost correction also changes the inventory value, which reaches profit through the COGS of later sales. The same effect was therefore counted twice.

**Fix.**
- **`src/shared/stock.ts`:** `RECEIPT_COST_CORRECTION` now has the new, documented P&L treatment `DISCLOSURE_ONLY`. `RECEIPT_QTY_CORRECTION` and `OTHER_CORRECTION` keep `INVENTORY_DATA_CORRECTION`.
- **`src/main/services/reports.service.ts`:** inventory corrections now cover only receipt quantity and other corrections. The report adds `receiptCostCorrections` (count, value added, value removed, net) and `receiptCostCorrectionDetails`. Neither is in any profit figure. Nothing else in the formulas changed.
- **`ProfitLossReportView.tsx`:** a separate **Receipt Cost Corrections** card sits below the statement.
  - It is headed "For information only: not included in any profit figure above." and shows the net change in inventory value.
  - It carries the note "Receipt cost corrections update inventory value and affect future COGS. Historical COGS is not recalculated." and lists each correction.
  - The statement line is renamed **Inventory Quantity Corrections**.

**Formulas now:**
- Goods Revenue − COGS = **Gross Profit**
- Gross Profit + Freight Income + Stock Gains − Operating Expenses − Stock Losses = **Net Operating Profit**
- Net Operating Profit − Purchase Cost Corrections (expense category id 4) ± Inventory Quantity Corrections (receipt quantity and other corrections) = **Profit After Data Corrections**
- Receipt cost corrections are disclosed only.

**Regression tests** (`reports.service.test.ts`):

| Test | What it proves |
|---|---|
| A | A +100,000 correction moves inventory value 900,000 → 1,000,000; Net Operating Profit and Profit After Data Corrections stay 190,000 |
| B | A −100,000 correction moves inventory value 900,000 → 800,000; both profit figures stay 190,000 |
| C | A later sale of 5 Piece costs round(1,000,000 × 5 ÷ 15) = **333,333** (300,000 without the correction) |
| D | The earlier invoice keeps COGS 300,000 on its header, its line and its SALE movement; the period before the correction still shows COGS 300,000 |
| E (test H) | Quantity (−122,000) and other (+100,000) corrections keep their treatment, net −22,000; the +20,000 cost correction is disclosed only |

UI tests check that the disclosure never appears in the statement.

## 2. Corrected accounting scenario and results

### Isolated scenario (unit test `final accounting acceptance scenario`, August 2026, computed by hand)

**Steps**

| # | Event | Figures |
|---|---|---|
| 1 | Receipt: widget 20 Piece @ 600.00; gadget 10 Kg @ 300.00 | Inventory V 1,500,000 |
| 2 | Sale A: 5 Piece | Revenue 500,000; COGS 300,000 |
| 3 | Receipt cost correction to 650.00 | +100,000 (widget V 1,000,000) |
| 4 | Sale B: 5 Piece | Revenue 500,000; COGS 333,333 (corrected cost reaches COGS) |
| 5 | Receipt quantity correction OUT 1 Piece | −66,667 |
| 6 | Other correction IN 1 Kg @ 250.00 | +25,000 |
| 7 | Damage 1 Piece | −66,667 |
| 8 | Count surplus 1 Kg | +29,545 |
| 9 | Expenses: Shop 20,000; Monthly / General 50,000; Purchase Cost Correction 15,000; one void of 9,999 | |
| 10 | Sale C: 2 Kg + freight 10,000 | Revenue 100,000; COGS 59,091 |
| 11 | Sale D: 2 Piece, voided | Excluded |

**Results**

| Figure | Amount |
|---|---|
| Inventory (proves the correction changed inventory value) | 828,787 = 1,500,000 + 100,000 − 692,424 − 66,667 + 25,000 − 66,667 + 29,545 |
| Goods revenue | 1,100,000 |
| COGS | 692,424 |
| Gross profit | 407,576 |
| **Net Operating Profit** | 407,576 + 10,000 + 29,545 − 70,000 − 66,667 = **310,454** |
| **Profit After Data Corrections** | 310,454 − 15,000 − 66,667 + 25,000 = **253,787** |
| Receipt cost corrections | +100,000, disclosed only |
| Purchase Cost Correction | 15,000, below Net Operating Profit |

The old rule would have given 353,787.

### Phase 12 acceptance scenario, recalculated

- **How:** the packaged final build ran the Phase 12 acceptance script again with corrected expectations: 37/37.
- **Figures:** revenue 12,135.00; COGS 10,490.00, already at the corrected average of 110.00 a Piece; gross profit 1,645.00; freight 300.00; operating expenses 1,400.00; damage 440.00.
- **Net Operating Profit:** 105.00.
- **Profit After Data Corrections: 105.00.** It was 2,505.00 before this fix, when the +2,400.00 receipt cost correction was counted a second time.
- **On screen:** the P&L shows the +Rs 2,400.00 only in the Receipt Cost Corrections card, and the statement has no Data Corrections section.

## 3. Purchase Cost Correction category protection

- **Constant:** `PURCHASE_COST_CORRECTION_CATEGORY_ID = 4` is now defined and documented once, in `src/shared/expenses.ts`, with `isProtectedExpenseCategory` and `PROTECTED_EXPENSE_CATEGORY_MESSAGE`. It was in `reports.ts`. Reports still identify the category by id, never by name.
- **Backend** (`expense-categories.service.ts`): changing the name or group of category 4 is refused with `FORBIDDEN_STATE`: "The Purchase Cost Correction category is used by Reports, so its name and group cannot be changed."
  - Saving it unchanged is accepted.
  - The only name accepted besides the current one is "Purchase Cost Correction" itself, so a copy renamed before this fix can be set back.
  - Deactivate and activate still work.
- **UI** (Manage Categories): Edit is disabled for category 4, with "Used by Reports: its name and group cannot change." Deactivate stays available.
- **Tests:**
  - rename, group change and letter-case change are refused, used or unused;
  - saving unchanged, deactivate and reactivate work;
  - normal unused categories can still change group, and used ones keep the Phase 10 lock;
  - Reports still recognise id 4 after refused edits, and a look-alike category is an ordinary expense;
  - the Purchase Cost Correction expense stays below Net Operating Profit (test G and the scenario).

## 4. Currency locking

- **Rule:** the same `hasMonetaryData` detector that locked decimal places now locks `currency.code`, `currency.symbol` and `currency.minorDigits`.
- **Backend** (`settings.service.ts`): a different value is refused with `SETTING_LOCKED`, "Currency settings cannot be changed after financial data has been entered.", with a field error per changed key. Saving the same values is accepted. Before any monetary data, all three stay editable.
- **View model:** `SettingsView.minorDigitsLocked` is replaced by `currencyLocked` and a new `startNumberLocked`.
- **UI:** Currency code, Currency symbol and Minor digits are read-only ("Locked."), and the Currency card shows the message. The renderer has no lock detector of its own.
- **Tests:**
  - with no monetary data, code, symbol and decimal places can all change;
  - each of these locks all three: a retail, wholesale or default price, a stock receipt or its line, an adjustment, a stock movement, an invoice or its line or quantity row, a payment, an expense, a customer ledger entry;
  - unchanged values are accepted;
  - an old printable invoice still reads PKR / Rs after refused changes to code, symbol or decimal places.

## 5. Expanded integrity checks

`src/main/db/integrity-documents.ts` adds eight read-only checks to Settings → Run Integrity Check. All earlier checks are kept, for 16 in total. The status values are still OK, WARNING and ERROR, and the findings are in plain language. The log records only finding counts for business checks, never payloads.

| Check | What it verifies (the services' own contracts) |
|---|---|
| Invoice lines and totals | Each quantity row: amount = quantity × price and base quantity = quantity × unit size. Line gross = Σ rows; line quantity = paid + free. Line discount, scheme, net and header gross, line discounts, schemes, net, total and net outstanding are recalculated with the production `calculateInvoiceTotals`. COGS = Σ frozen line costs. Also invoices without lines and lines without quantities. |
| Invoice stock | One SALE per line of −qty_base and −cost_minor on its product and invoice date. VOID invoices: one SALE_VOID per line of +qty_base and +cost_minor on the void date. POSTED invoices: no SALE_VOID. Missing, duplicate, wrong quantity, value, product or date, and unexpected kinds are reported. |
| Invoice customer accounts | Total > 0: one INVOICE entry of +total on the invoice date. Total = 0: none. VOID with total > 0: one INVOICE_VOID of −total on the void date. Money received: exactly one payment linked to the invoice, same amount, customer and date; it may have been voided later. |
| Payments | One PAYMENT entry of −amount on the payment date. VOID payments add one PAYMENT_VOID of +amount on the void date. POSTED payments have no PAYMENT_VOID. |
| Walk-in customer | The balance of C-00001 is exactly 0. A missing walk-in customer is reported. |
| Stock receipts | Total cost = Σ lines. Each line, by its own id, has one STOCK_IN of +qty_base and +line cost on the receipt date. VOID receipts add one STOCK_IN_VOID of exactly −qty_base and −line cost on the void date. |
| Stock adjustments | One movement on the adjustment's product and date, of the Phase 6 type: OPENING_STOCK → OPENING, COUNT_SURPLUS → ADJUST_IN, RECEIPT_COST_CORRECTION → COST_CORRECTION (quantity 0, value ±value_minor), otherwise IN → ADJUST_IN or OUT → ADJUST_OUT, with IN positive and OUT negative quantity and value. |
| Business dates | No invoice, invoice void, payment, payment void, expense, receipt, receipt void, adjustment, stock movement or ledger entry is dated after the main process's today. `created_at` is not used. |

**Speed.** In the first version, the invoice checks joined movements and ledger rows per line, and the partial unique indexes could not serve those joins. It took 2,556 ms on 2,000 invoices, and the time grows with invoices × rows. Each ledger and movement table is now aggregated once and then joined: 72 ms in-process and 138 ms end to end through the packaged app on the same dataset. The findings are unchanged, and all 67 integrity tests pass.

**Results.**

| Run | Result |
|---|---|
| **Healthy datasets:** a service-built shop covering every document kind (unit test); the Phase 12 performance dataset (500 products, 500 customers, 2,000 invoices, 1,000 expenses); the 74-invoice realistic shop; the Phase 12 acceptance dataset; a fresh shop | Overall **OK** for each |
| **Corrupted isolated fixtures** (unit tests, each proving the database was not modified) | Specific ERROR findings for every case the audit listed: wrong line gross, wrong total, quantity mismatch, missing SALE, wrong SALE value, missing SALE_VOID, wrong reversal value, missing INVOICE entry, bad INVOICE_VOID entry, PAYMENT entry of another amount, missing PAYMENT_VOID, receipt STOCK_IN of another quantity or value, adjustment movement of another kind, quantity or value, missing adjustment movement, future-dated expense, all future-dated business tables, non-zero walk-in balance |
| **Additional corrupted cases** | Duplicates, misdated entries, zero-total entries, payments that do not belong, receipts without lines or with a wrong total, reversals on posted documents, unexpected movement kinds, a missing walk-in customer |
| **Packaged corrupted copy** (one SALE value off by 1; one expense dated 2099) | Overall ERROR on Invoice stock and Business dates, with a log reference; the log holds counts only |

## 6. Invoice Code search

- **Change:** `listInvoices` also matches `i.invoice_code`. LIKE ignores letter case; every word must still match. The search box placeholder is now "Search by invoice no, invoice code, customer, customer code or shop".
- **Tests:** exact, other letter case and partial code; code together with customer name; unrelated code; invoice number, customer and shop search unchanged. A mutation check (column removed) makes the test fail.
- **Packaged:** Invoice History finds INV-000101 by typing "bk-2026/77".

## 7. Dashboard wording

- **Card:** "Low Stock" is now **Stock Alerts**, with the secondary text **Low or out of stock**.
- **Chart:** "Expenses This Month" is now **Operating Expenses This Month**.
- **Scope:** calculations are unchanged, and the tests are updated.

## 8. Invoice starting number lock

- **Rule:** numbering has begun once an invoice exists or the invoice sequence is no longer 1 (`invoiceNumberingStarted`).
- **Backend:** from then on, a different `invoice.startNumber` is refused with `SETTING_LOCKED`, "Starting number cannot be changed after invoice numbering has begun." Saving the same number is accepted. Before the first invoice it still changes and applies to the first invoice (Phase 8 behaviour). No invoice is renumbered and the sequence is untouched.
- **UI:** Starting number is read-only with that message, and "First invoice number" is hidden once locked.
- **Tests:** fresh system editable; a change before the first invoice gives INV-000501; locked after an invoice or a moved sequence; same value accepted; numbering continues INV-000501, 502, 503.

## 9. Tests, coverage and build

The full gates ran on the final tree:

| Gate | Result |
|---|---|
| `npm run typecheck` | Passes |
| `npm run lint` | 0 errors; the 21 warnings are the known CRLF line endings in `src/renderer/src/lib/unload-guard.test.ts` (not changed) |
| `npm test` | **2,009 passed in 102 files** (1,964 in 101 before this pass) |
| `npm run test:coverage` | **99.13% statements, 96.96% branches, 99.32% functions, 99.37% lines** |
| `npm run build` | main 380.70 kB, preload 8.31 kB, renderer JS 2,347.13 kB, CSS 75.67 kB |
| `npm run build:unpack` | Passes |
| `npm run build:win` | Passes |

- **First coverage run:** 94.68% branches, below the 95% threshold. I added failure tests for the uncovered integrity branches and did not lower the threshold. The query rewrite then required the gates to run again on the final tree.
- **Existing tests changed because approved behaviour changed:** Phase 11 test G no longer renames category 4. The integrity "consistent data" raw fixture now gives its SALE movement the line's frozen cost and its damage adjustment a movement. The start-number, currency and printable-currency tests now expect the locks. `SettingsView` fixtures use the new lock fields. No assertion was weakened.

## 10. Final packaged smoke test

The smoke test ran on `dist\win-unpacked`, which is byte-identical to the installer payload (same `app.asar` and `StockFlow.exe`), always on temporary appData. It passed **34/34**.

- **Security:**
  - `window.electron` is undefined, and the renderer has no `require`, `process`, `module`, `Buffer`, `fs` or raw `ipcRenderer`;
  - `window.api` is frozen with exactly the 67 approved typed calls;
  - context isolation, sandbox and web security are on, and node integration is off.
- **New visual Dashboard:** shows Stock Alerts / Low or out of stock and Operating Expenses This Month.
- **Settings:** currency and starting number are editable before data; starting number 101 applies (INV-000101, INV-000102); currency and starting number are refused after data; the same values save; the printed invoice keeps PKR / Rs; the Settings screen shows the four fields read-only with the reasons.
- **Integrity check:** Run Integrity Check shows "No problems were found." with the new checks; the API report is OK with 16 checks.
- **Invoice Code search:** works in Invoice History.
- **Pages:** New Invoice, Products, Stock In, Stock Adjustments, Customers, Payments, Expenses, Reports and Settings open; Print Preview opens with the Invoice Code; Backup Now writes a verified backup.
- **Corrected P&L:** a +2,400.00 receipt cost correction is disclosed only; Net Operating Profit = Profit After Data Corrections = 480.00, with COGS at the corrected average; the P&L screen shows the disclosure card.
- **Protected category:** rename and group change of category 4 are refused; deactivate and activate work; Manage Categories shows it protected.
- **Integrity on other datasets:** OK on the performance dataset (138 ms) and the realistic shop; ERROR with the expected checks on a corrupted copy.
- **Health:** no renderer console errors; every run closed normally.
- **Acceptance:** the Phase 12 acceptance scenario on the same build passed **37/37**. Its Dashboard check was updated from the old link-only page to the approved Dashboard, and its P&L to the corrected figures.
- **Real data:** `%APPDATA%\StockFlow` and `StockFlow-dev` were unchanged in every run.

## 11. New installer

This installer was built **after** the Dashboard visual improvement **and after** every final audit fix, on the final tree above. It replaces the Phase 12 installer (95,236,888 bytes, SHA-256 `EFD4C836…`), which is no longer final.

| | |
|---|---|
| Path | `D:\waqas\shop-management\dist\StockFlow-1.0.0-setup.exe` |
| Size | 95,250,189 bytes (~95.3 MB) |
| Built | 17 Sep 2026, 17:00:17 |
| SHA-256 | `4524A385A6C13266BD7D74FD75F57CC5C35D6B7C20C5E8F48225687F894B9D67` |
| Version | 1.0.0 (StockFlow.exe product version 1.0.0.0) |
| Architecture | x64 (NSIS `archs=x64`; PE machine 0x8664) |
| Signature | **Unsigned** (Authenticode `NotSigned` for the installer and StockFlow.exe) |
| Identity | productName StockFlow, appId `com.waqas.stockflow`, per-machine assisted NSIS installer; data stays in `%APPDATA%\StockFlow` |
| Payload | 92 files, 349,704,976 bytes; `app.asar` SHA-256 `DF128990…21FA`, identical to the tested build; no database or log files; all new strings present, old wording absent |

## 12. Schema and migrations

- **Version and migrations:** schema version 2, with migrations `0001_initial` and `0002_stock_adjustment_receipt_item`. No migration was added and no table, view, trigger or column changed.
- **Protections without schema change:**
  - Purchase Cost Correction category: service rule.
  - Currency and starting number locks: settings service.
  - P&L disclosure: report code.
  - Integrity checks: read-only queries.

## 13. Remaining human checks

None of these were performed here. This PC has real StockFlow data and no elevated shell.

1. Install on a clean Windows VM or user account; check Program Files, the admin prompt, and the **Start Menu** and **desktop shortcuts**.
2. **Reinstall** over itself, and run the installer while StockFlow is open.
3. **Uninstall** and confirm `%APPDATA%\StockFlow` is preserved.
4. **Taskbar and shortcut icon** appearance.
5. **Real printer** output of a representative invoice.
6. The **SmartScreen** experience for the unsigned installer, and the decision on code signing.

## Owner-facing notes

`stockflow-v1-release-notes.md` now explains:
- set the currency and invoice starting number before entering data, because they lock;
- receipt cost corrections are shown in P&L for information only;
- the Purchase Cost Correction category is fixed.

`phase-12-implementation-report.md` now points its installer information to this new build.
