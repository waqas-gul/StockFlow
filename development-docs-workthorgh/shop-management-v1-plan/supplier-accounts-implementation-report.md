# Supplier Accounts: Implementation Report

This report covers the Suppliers + Purchase Payables module. Nothing is committed, and the final installer was not rebuilt (`build:win` was not run).

- **Base:** HEAD `e3595bb`.
- **Schema:** version **3**; this module added migration `0003_supplier_accounts`.

## 1. Migration 0003

- **Files:** `src/main/db/migrations/0003_supplier_accounts.ts`, registered third in `migrations/index.ts`.
- **Checksum:** `sha256:5bcbe1726aee3f75a7240faab2c266ece5b6499e80f6e8ed6950870c0eaad0a0`, pinned in the migration and in the shipped-checksum registry test.
- **0001 and 0002:** unchanged. Their checksums are asserted:
  - 0001: `0cc4eb98…6cc4`
  - 0002: `fb50cb92…442d`
- **Additive only:**
  - It never uses DROP, RENAME, UPDATE or DELETE.
  - It creates three tables: `suppliers`, `supplier_payments` and `supplier_ledger`.
  - Its only inserts are the two new sequences.
- **Upgrade path:** the existing verified pre-migration backup runs before it. Each migration runs in its own transaction and must pass a foreign-key check before it commits.
- **Existing receipts:**
  - They keep `supplier_id = NULL` and their free-text `supplier_name`.
  - No supplier, link or ledger entry is created from them, because money may already have been paid outside StockFlow.
  - An old debt is entered as the new supplier's **Opening Balance**, at today's amount. The release notes tell the owner this.

## 2. Supplier schema

- **`suppliers`:**
  - `code` is unique and case-insensitive (`SUP-00001`, …, from the `supplier` sequence).
  - Names may repeat.
  - Other columns: `contact_person`, `phone`, `address`, `city`, `notes`, `is_active`, `created_at`, `updated_at`.
  - Indexes on name, contact, phone and city.
- **`stock_receipts`** gains two nullable columns:
  - `supplier_id`, a foreign key to `suppliers` (ON DELETE RESTRICT), indexed with the receipt date;
  - `supplier_bill_no`.
- **`supplier_name`** stays as the saved snapshot. With a supplier account it is the supplier's name at posting, so a later rename never rewrites old receipts.
- **Receipt triggers:**
  - A supplier-linked receipt must keep the name.
  - `supplier_id` and `supplier_bill_no` never change after posting; voiding is still allowed.
- **`supplier_payments`:**
  - `SPAY-000001` numbers come from the `supplier_payment` sequence.
  - The request id is unique.
  - `stock_receipt_id` is set for payments made with a receipt ("paid now").
  - Status is POSTED or VOID, with the void fields.
- **Payment triggers:**
  - A saved payment can only move from POSTED to VOID, and is never deleted.
  - A payment can only name a receipt of its own supplier.
- **`v_supplier_balance`:** `supplier_id` and `balance_minor`, with 0 for a supplier without history.

## 3. Supplier ledger and sign rules

`supplier_ledger` is append-only: UPDATE and DELETE triggers refuse any change.

| Type | Sign | References |
|---|---|---|
| OPENING | ± (not 0) | none; only as the supplier's first entry |
| PURCHASE | + receipt total | the receipt |
| PURCHASE_VOID | − receipt total | the receipt |
| PAYMENT | − amount | the payment |
| PAYMENT_VOID | + amount | the payment |
| ADJUSTMENT | ± (not 0) | none; reason required |

- **Balance:** `SUM(amount_minor)`. Positive is **Due** (the shop owes the supplier), negative is **Advance**, zero is **Settled**. No balance or total is ever stored.
- **One effect per source:** partial unique indexes allow one PURCHASE and one PURCHASE_VOID per receipt, one PAYMENT and one PAYMENT_VOID per payment, and one OPENING per supplier.
- **Right supplier:** a trigger requires a receipt or payment entry to be on that document's supplier.
- **Indexes:** `(supplier_id, entry_date, id)` and `entry_date`.
- **Dates:** every supplier change must be dated today or earlier, and not before the supplier's latest ledger entry. Other suppliers never block it.
- **Currency lock:** `hasMonetaryData` now also counts `supplier_ledger` and `supplier_payments`.

## 4. Stock In integration

- **Form:**
  - Header: Receipt Date, Supplier (search by code, name, contact, phone or city; active suppliers only), Supplier Bill No, Reference and Note.
  - The product lines are unchanged.
- **Without a supplier:** the receipt only adds stock. This is still allowed (see §16).
- **New Product:** opens the existing Product form (no second form). The new product goes on the first empty line.
- **Posting is one transaction:**
  1. Receipt, lines, STOCK_IN movements and the receipt number.
  2. The stock checks.
  3. PURCHASE +total.
  4. The optional supplier payment, its PAYMENT entry and its SPAY number.
  5. A check that the balance equals the previous balance + total − paid.

  Any failure rolls everything back, sequence numbers included; the tests cover each failure point.
- **Date:** the receipt date must satisfy both the product floors and the supplier floor. `DATE_NOT_ALLOWED` names whichever floor is later, product or supplier, and `stock.postingFloor` returns `supplierSetBy`.
- **Refused:** an inactive supplier (FORBIDDEN_STATE); Paid Now without a supplier (VALIDATION).
- **Zero-cost receipt:** creates no PURCHASE entry (the ledger forbids zero amounts).
- **Prices:** receipt unit cost never overwrites retail, wholesale or default cost; valuation is still weighted average.
- **API:** `stock.receive` gains three optional fields: `supplierId`, `supplierBillNo` and `paidNow`. Existing callers are unchanged.
- **Wording:** the product "Company" field now reads **Brand / Company**. The database table is not renamed.

## 5. Paid Now

- **Input:** optional amount, method (Cash, Bank, Cheque or Other) and reference.
- **Preview:** a live panel shows Supplier Current Balance, Purchase Total, Paid Now and Projected Supplier Balance.
- **Posting:**
  - An amount above zero creates a **real** `supplier_payments` row, dated on the receipt date and linked to the receipt, with its PAYMENT entry.
  - Its request id is derived from the receipt's (a form a renderer never sends), so a retry of the receipt returns the saved receipt and creates nothing.
  - Blank or 0 creates no payment and no zero entry.
- **Overpaying:** allowed; the extra becomes a supplier advance.

## 6. Supplier payments and voids

- **Pay Supplier:** available from the Suppliers page, the supplier page and the Dashboard quick action.
  - It shows the current balance and the projected balance, and warns when the payment creates an advance.
  - The request id makes a double click or retry post only one payment.
- **Duplicate warning:** a posted payment with the same supplier, date and amount triggers the soft warning "A payment with the same supplier, date and amount already exists." Continue or Cancel; there is no database rule.
- **Void:**
  - Needs a reason and is dated today.
  - POSTED becomes VOID and PAYMENT_VOID +amount is appended; the original PAYMENT entry is untouched.
  - A second void is refused.
- **Inactive suppliers:** can still be paid, have payments voided and have their balance adjusted.

## 7. Receipt void interaction

- **Unchanged Phase 6 rules:** the later-activity lock, and exact STOCK_IN_VOID reversal of each line's quantity and value.
- **Supplier receipt:** also appends PURCHASE_VOID −total; the original PURCHASE stays. Everything happens in one transaction, and a failure rolls back both stock and ledger (tested).
- **Payments are not voided automatically:** with Rs 50,000 bought and Rs 20,000 paid, the void leaves a **Rs 20,000 Advance**.
- **Warning:** Receipt detail shows "This receipt has supplier payments. Voiding the receipt will keep those payments on the supplier account as advance. Void the payment separately if the money was returned."
- **Corrections:** RECEIPT_QTY, RECEIPT_COST and OTHER corrections never touch the supplier ledger. On a supplier receipt the correction form shows "This correction changes inventory only. If the supplier bill or amount due also changed, adjust the supplier account separately."

## 8. Supplier balance adjustment

- **Inputs:** supplier, date, direction (Increase: owe more; Decrease: owe less or more advance), a non-zero amount and a required reason.
- **Posting:** appends ADJUSTMENT and respects the supplier date floor. Allowed for inactive suppliers.
- **No new document table.**

## 9. Screens

- **Sidebar:** a new **Suppliers** section.
- **Suppliers list:**
  - Columns: Code, Supplier, Contact, Phone, City, Current Balance (Rs X Due, Rs X Advance or Settled), Status and Actions.
  - Search, an Active/Inactive/All filter, 25 rows per page, Add Supplier and Pay Supplier.
  - `?pay=1` opens Pay Supplier.
- **Add/Edit Supplier:**
  - Profile fields.
  - On **create only**: Opening Balance with "We owe supplier" or "Supplier advance", and its date. Amounts are never signed by the user.
  - Edit never changes the opening balance.
- **Deactivate:** shows "This supplier still has an outstanding balance. The account and history will remain available." when the balance is not zero.
- **Supplier Detail:**
  - Header with code, contact, phone, address and status; the balance with its meaning.
  - Actions: New Stock Purchase (opens Stock In with the supplier chosen), Pay Supplier, Adjust Balance, Edit Supplier and Deactivate/Reactivate.
  - Summary cards: Total Purchases (posted receipts, void excluded), Total Paid (posted payments), Current Due/Advance, Last Purchase and Last Payment.
- **Tabs:**
  - **Overview:** Products Purchased, derived from posted receipts (last date, last unit cost and unit, total quantity). History only; no mapping table.
  - **Purchases:** Receipt No, Supplier Bill No, Date, Reference, Total, Status and View. View opens the existing Receipt Detail, now with the supplier, bill number, linked payments and the supplier's balance.
  - **Payments:** Payment No, Date, Amount, Method, Reference, Status, Linked Receipt and View / Void.
  - **Ledger:** Date, Activity, Reference, Amount (+/−) and a running balance as Due/Advance, ordered by entry date then id, with the Due/Advance meaning explained.

**New IPC calls** (81 total, was 67). All are typed and schema-validated in the renderer and again in the main process:

| Domain | Calls |
|---|---|
| `suppliers` | list, get, create, update, setActive, ledger, adjustBalance, search |
| `supplierPayments` | list, get, create, checkDuplicate, void |
| `reports` | supplierBalances |

Also:
- `stock.listReceipts` gains `supplierId`, and `stock.postingFloor` gains `supplierId`.
- `dashboard.get` is extended.
- There is no generic, SQL or file call.
- Errors come back as VALIDATION, NOT_FOUND, DATE_NOT_ALLOWED, FORBIDDEN_STATE or CONFLICT, never as SQLite text (tested).

## 10. Reports

- **Supplier Balances tab:** a current-state report.
- **Columns:** Code, Supplier, Phone, Current Balance, Due / Advance, Last Purchase and Last Payment.
- **Summary:** Total Supplier Payables (sum of positive balances) and Supplier Advances (sum of negative balances, as positive amounts) are shown **apart**, with the counts.
- **Inactive suppliers:** included.
- **Rest of the Reports page:** unchanged.

## 11. Dashboard

- **One new KPI:** Supplier Payables. It shows the sum of positive balances only, "X suppliers due", and a small "Rs X supplier advances" line only when advances exist.
- **Layout:** the KPI grid is now 2 columns, then 4 at wider widths.
- **Quick action:** **Pay Supplier** (5 actions: 2, 3 or 5 per row).
- **Suppliers Due:** a compact panel showing at most 5, highest first, each linking to the supplier. When there are none: "No supplier payments are currently due."
- **Data:** everything comes from the single `dashboard.get()`, which reuses `supplierBalancesReport`. No sales, receivables, inventory, alert or expense calculation changed; the existing Dashboard tests still pass with unchanged figures.

## 12. P&L confirmation

The P&L formulas are unchanged, and no P&L query reads the supplier tables.

| Event | Effect on profit |
|---|---|
| Supplier purchase | None; it is inventory and a payable |
| Supplier payment | None; it settles a payable and is not an expense |
| Void or adjustment | None |
| Sale | Frozen COGS, as before |

The regression test covers a purchase, then a payment, then a sale:
- **After the purchase:** P&L all zero.
- **After the payment and an adjustment:** the P&L is byte-identical and there are no expenses.
- **After selling 20 pieces at Rs 400 with cost Rs 300:** revenue Rs 8,000, COGS Rs 6,000, net operating profit Rs 2,000.
- **A later payment:** the P&L is identical again.

The packaged check showed the same figures.

## 13. Integrity check

19 checks, up from 16.

**`suppliers.ledger` (Supplier accounts):**
- Every entry's sign and references match its type.
- At most one opening balance per supplier.
- `v_supplier_balance` equals the sum of the ledger for every supplier.

**`suppliers.purchases`:**
- Every supplier-linked receipt with a total above 0 has exactly one PURCHASE of +total on its supplier and receipt date.
- A VOID receipt also has one PURCHASE_VOID of −total on its void date.
- A zero-total receipt has none.
- A receipt without a supplier account (every legacy receipt) must have **no** supplier entries.

**`suppliers.payments`:**
- One PAYMENT of −amount on the supplier and payment date.
- A VOID payment also has one PAYMENT_VOID of +amount on the void date.
- A paid-now receipt belongs to the same supplier.

**`dates.future`:** also covers supplier ledger entry dates, supplier payment dates and supplier payment void dates.

Behaviour:
- **Old databases:** the supplier checks report "Not applicable" on a database from before 0003.
- **Read-only:** the checks never change anything; each test asserts `total_changes()` is unchanged.
- **Logging:** only counts are logged.
- **Speed:** single-pass `MATERIALIZED` aggregates; the 2,000-invoice set checks in 130 ms packaged.

## 14. Tests, coverage and build

Ran once at completion, all exit 0: typecheck, lint, test, test:coverage, build and build:unpack.

**Tests:**
- **2,157 tests in 107 files**, all passing (2,009 in 102 before).
- **Coverage:** 99.00% statements, 96.77% branches, 99.18% functions, 99.25% lines. Thresholds unchanged.
- **Mutation check:** 20 deliberate bugs, one at a time.
  - 18 made the tests fail.
  - One was dead code: the final supplier date check could never fail. It was removed.
  - One did the same thing as the original code, so no test can catch it.

**Build:**
- **Lint:** 0 errors.
- **Lint warnings:** the count rose from 21 to 1,362, all Prettier line-ending (CRLF) warnings in six files this work did not touch:
  - `scripts/seed.mjs`
  - `src/main/db/seed.ts`, `seed-cli.ts` and `seed-verify.ts`
  - `vitest.config.ts`
  - `unload-guard.test.ts`
- **Build sizes:** main 438.39 kB, preload 9.97 kB, renderer JS 2,485.68 kB, CSS 76.10 kB.

**New tests:**

| File | Tests | What it covers |
|---|---|---|
| `0003_supplier_accounts.test.ts` | 21 | 2 → 3 upgrade with verified backup first; every record kept; supplier names kept; old receipts not linked; no ledger invented; sequences; objects created; idempotent second launch; rollback of a late failure leaving schema 2 identical; all constraints and triggers |
| `supplier-accounts.test.ts` | 57 | Sections 50–57 of the spec: suppliers, opening balances, stock purchases, dates, payments, receipt voids, adjustments, corrections, the report and Dashboard, P&L, and the ABC Distributors example end to end |
| `integrity-suppliers.test.ts` | 18 | A healthy supplier shop is OK. Corrupted copies report ERROR: missing, wrong-amount, wrong-supplier or misdated PURCHASE, PURCHASE_VOID, PAYMENT and PAYMENT_VOID; entries on a legacy receipt; balance view mismatch or missing; bad signs; a second opening; future dates |
| IPC round-trip tests | 4 (+ refusals) | The new calls end to end, with refusals at the boundary |
| Renderer SSR, form and action tests | 34 | Supplier list, detail tabs, forms, Pay Supplier preview and duplicate flow, Stock In supplier and Paid Now, receipt detail warning, the report, the Dashboard KPI and list |

Existing tests changed only where a list or contract legitimately grew:
- channel lists;
- check lists;
- the shipped-checksum registry;
- the 0002 test (run up to 0002 only);
- product wording;
- the new DTO fields.

## 15. Packaged check

Run on `dist\win-unpacked\StockFlow.exe` from this build, always on a temporary appData: **71/71**.

**Real 2 → 3 migration**, on copies of three earlier schema-2 shops: the realistic shop (74 invoices), the 2,000-invoice set and the acceptance data.
- Each opened at schema 3 in about 1 s.
- One verified `*_s2.db` pre-migration backup was made first, and logged before the migration.
- All 16 older tables were row-for-row identical; old supplier names were kept; no receipt was linked; no supplier was invented.
- Sequences: the old ones were unchanged; `supplier` and `supplier_payment` start at 1.
- The checksums of 0001 and 0002 were unchanged; the database and foreign-key checks passed; the integrity check was OK with 19 checks.
- A second launch migrated nothing and made no second backup.

**Scenario through the real UI:**

| Step | Supplier balance |
|---|---|
| Add Supplier "ABC Distributors" with an opening balance of Rs 10,000 | Rs 10,000 Due |
| Stock In: bill ABC-101, 10 Box A + 5 Box B = Rs 50,000, Rs 20,000 paid now (the form projected Rs 40,000.00 Due) | Rs 40,000 Due |
| Pay Supplier from the Dashboard quick action: Rs 15,000 | Rs 25,000 Due |
| The same payment again: the duplicate warning appeared, and Cancel saved nothing | Rs 25,000 Due |
| Purchase of Rs 30,000 | Rs 55,000 Due |
| Customer invoice (stock 200 → 180; the customer owes Rs 8,000) | Rs 55,000 Due (unchanged) |
| Supplier payment (stock and P&L unchanged, no expense) | Rs 50,000 Due |

Also checked in the same run:
- **Receipt void through the UI:** the warning was shown; the stock was reversed; the payment stayed as credit on the supplier account.
- **Stock correction:** the inventory-only note was shown.
- **Supplier Detail:** summary cards and all four tabs verified, including the running ledger 10k → 60k → 40k → 25k → 55k → 50k.
- **Inactive supplier:** deactivating showed the open-balance warning; a new purchase was refused and a payment was allowed.
- **Reports and Dashboard:** the Supplier Balances tab, and the Dashboard KPI and Suppliers Due list, at 1440, 1100 and 860 px with no overflow.
- **New Product:** Stock In → New Product opens the existing Add Product form.
- **Integrity and errors:** integrity OK; no renderer console errors.
- **Security:** `window.electron`, `require`, `process` and `ipcRenderer` are undefined; `window.api` is frozen with exactly 81 calls, none generic.
- **Real data:** the real `%APPDATA%\StockFlow` and `StockFlow-dev` folders were unchanged.
- **Screenshots:** saved in the session scratchpad (`sup\shots`).

## 16. Decisions and points needing attention

1. **Stock In without a supplier account is still allowed**, for goods with no supplier to track. The free-text supplier field was removed from the form (it is still accepted over the API for old callers). The form says to leave the supplier empty only for stock without an account. You may prefer to require a supplier.
2. **A zero-total supplier receipt** writes no PURCHASE entry, because ledger amounts cannot be 0. The integrity check expects exactly that.
3. **Pay Supplier later is not linked to a receipt.** Only Paid Now payments carry the receipt link. The account is a running balance, as for customers.
4. **Supplier pickers:** Stock In offers only active suppliers; Pay Supplier also offers inactive ones, so old debts can be settled.
5. **Dashboard KPI grid** is now 4 + 3 at full width, instead of one row of 6, to fit the seventh card.
6. **Lint warnings rose to 1,362.** All are CRLF-only warnings in six untouched files. Git shows those files unmodified, so they were probably re-checked-out with CRLF. They are not fixed here, because unrelated files were not to be touched.
7. **Not done yet:** `build:win` was not run, so the final installer awaits the supplier audit. The earlier installer (`dist\StockFlow-1.0.0-setup.exe`, 95,250,189 bytes) is from before this module and is **not** final. The demo `seed` script does not create suppliers.
