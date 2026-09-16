# Phase 6 — Stock In, Adjustments, Inventory / Stock Card: Implementation Report

Status: implemented and verified. **Nothing committed. Phase 7 was not started.**

## 1. What was implemented

- **Stock In**:
  - A multi-line receipt with:
    - a generated number (`GRN-000001`);
    - a date, and a free-text supplier, reference and note;
    - lines for product, active purchasable unit, quantity and unit cost.
  - The form shows each line's base quantity and exact cost, and the receipt total.
  - The whole receipt is posted in one transaction, with one `STOCK_IN` movement per line.
- **Receipt history and detail**:
  - The history shows the receipt number, date, supplier, total cost, status and a View action.
  - The status is one of **Posted · Void available**, **Posted · Locked** or **Void**.
  - The detail shows:
    - the lines as saved, with each unit's name, size and costs;
    - the void details, when voided;
    - the linked correction adjustments.
- **Receipt void**:
  - Void is offered only while no other document has touched the receipt's products.
  - A locked receipt explains why and offers **Correct Stock**. That button opens a receipt correction already set to that receipt.
- **Stock adjustments**:
  - All 8 fixed reasons are supported, and a reason note is always required.
  - The fields shown depend on the reason. The operator never enters signs or values for stock that leaves.
  - Below the form is the adjustment history.
- **Opening stock** is an `OPENING_STOCK` adjustment with an `OPENING` movement.
- **Stock card**:
  - It is opened from the Products table and is read-only.
  - It shows date, type, reference, quantity in and out, value in and out, and running quantity and value.
  - It pages from the oldest entry and opens on the latest page.
- **Products table**:
  - It shows real stock from `v_product_stock` in the product's units, for example `9 Box + 14 Piece`.
  - A subtle **Low** badge appears when the low-stock level is above 0 and stock is at or below it.
  - Each row has a **Stock Card** action.
- **Phase 5 unit locks** now switch on with the first real movement (receipt, opening stock or adjustment). A later void does not unlock them.

## 2. Migration 0002 — required

**Check 0 result:**
- 0001 stored only `stock_adjustments.receipt_id`.
- A receipt can hold the same product on several lines, for example 2 Box @ 2,400 and 5 Pcs @ 110.
- So a receipt correction could not identify the line whose cost it adds stock at, or the recorded cost it corrects. That is an auditability defect.

**`0002_stock_adjustment_receipt_item`** only adds:
- a nullable column `receipt_item_id` referencing `stock_receipt_items (id)`, with `ON DELETE RESTRICT`;
- an index on that column;
- a `BEFORE INSERT` trigger with two rules:
  - A receipt quantity or cost correction must name a line of **its own receipt**, for the **same product**.
  - Every other adjustment names no receipt line.

The table is append-only, so checking each insert covers every future row.

**What stayed the same:**
- `0001_initial.ts` and its checksum are unchanged. The checksum is still `sha256:0cc4eb98…6cc4`.
- 0002 has its own pinned checksum, `sha256:fb50cb92…442d`.
- No other schema object changed.

**How the upgrade was verified:**
- **Automated tests:**
  - 1 → 2 with a verified pre-migration backup, keeping every row and the 0001 checksum;
  - a new database migrating 0 → 2;
  - a failure inside 0002 rolling back to schema 1;
  - every trigger rule.
- **Packaged app:** a Phase 5 style schema 1 database, with products, was migrated at startup. The backup `…_s1.db` plus its sidecar was written to `backups\pre-migration`, and schema 2 was confirmed.

## 3. Stock and valuation rules

- **Ledger-derived stock:** stock is never stored. Q = Σ `qty_base` and V = Σ `value_minor` per product.
- **One invariant function:** `assertStockInvariants` in `services/inventory.ts` requires Q ≥ 0, V ≥ 0, and Q = 0 ⇒ V = 0.
  - It runs last in every receipt, void and adjustment transaction, and a violation rolls the whole transaction back.
  - It is shared, so Phase 8 invoices can use the same check.
- **Zero-cost stock** (Q > 0, V = 0) is valid.
- **Receipts** add each line's exact cost (quantity × unit cost).
- **Stock leaving** (damage, expiry, shortage, and the remove direction of other and receipt-quantity corrections):
  - The value leaving is `round_half_up(V × n / Q)`, using the Phase 2 helper.
  - The last unit takes exactly the remaining V.
  - Q can never go negative; the error is `INSUFFICIENT_STOCK`, with the quantities shown in the product's units.
- **Count surplus:**
  - With stock, it adds at the current average.
  - With Q = 0, a cost is required.
- **Opening stock** is valued at quantity × entered cost, and 0 is allowed. It is allowed only while the product has **no** movement.
- **Posting dates:**
  - A date can never be later than today.
  - It can never be earlier than the latest movement of **any affected product**. Unrelated products never block.
  - A refusal is `DATE_NOT_ALLOWED`, naming the product and date, for example "TEA-01 Tea 950g has stock activity on 16-Sep-2026. Use that date or later."
  - "Today" is the main process's local calendar day.
- **Idempotency:** each form submission carries a `request_id`. A retry returns the document already saved, so no second document is created.
- **Numbering:** `GRN-` and `ADJ-` numbers come from `sequences` inside the same transaction, so a rollback does not use up a number.

## 4. Receipt void and correction rules

- **Voidable:** no movement of any product on the receipt after its first `STOCK_IN` for that product belongs to another document. This is the plan's query.
  - The receipt's own lines never lock it, including repeated products.
  - A later receipt, adjustment (a linked correction included), sale or sale void locks it.
  - Activity on unrelated products does not.
- **Void:**
  - One `STOCK_IN_VOID` per line reverses the **exact** original quantity and value, never the current average.
  - The void is dated today, and the receipt status becomes VOID.
  - It runs in one transaction with the invariant check.
  - A second void, or a void of a locked receipt, is `FORBIDDEN_STATE`.
- **Quantity correction, add (IN):** stock is added at the corrected line's own cost, prorated per base unit when another unit is used.
- **Quantity correction, remove (OUT):** stock leaves at the current average.
- **Cost correction:**
  - δ = correct unit cost × line quantity − the line cost recorded so far (earlier corrections included). It uses a `COST_CORRECTION` movement with quantity 0.
  - It is blocked when Q = 0 (record an expense instead), or when V + δ < 0.
  - When other activity followed the receipt, the L1 warning shows in the form before saving and again after saving. Past cost of goods sold is not recalculated.

## 5. Screens and API

- **Routes:** `/stock/in` is Stock In (New Receipt and Receipt History tabs, plus the receipt detail dialog). `/stock/adjustments` is Stock Adjustments. `/stock/adjustments?receipt=<id>` opens a correction of that receipt.
- **Products:** Stock Card dialog, real stock, and the Low badge.
- **IPC (typed and allow-listed; the main process validates again):**
  - `stock.receive`, `listReceipts`, `getReceipt`, `voidReceipt`
  - `adjust`, `listAdjustments`
  - `stockCard`, `summary`, `postingFloor`
- There is no generic IPC, SQL or path access. Posting dates use the main process's clock.
- **Errors:** `VALIDATION` with field errors, `NOT_FOUND`, `INSUFFICIENT_STOCK`, `DATE_NOT_ALLOWED`, `FORBIDDEN_STATE`, `CONFLICT` (currency decimal places changed while a form was open) and `UNIT_LOCKED`. Raw SQLite text is never shown.

**Files added:**
- **Migration and main process:** `db/migrations/0002_stock_adjustment_receipt_item.ts`, `services/inventory.ts`, `services/stock.service.ts`.
- **Shared:** `shared/stock.ts`, `shared/dates.ts`.
- **Renderer:** `lib/form-text.ts`, and in `features/stock/`:
  - `receipt-form.ts`, `adjustment-form.ts`, `stock-display.ts`, `stock-actions.ts`
  - `ProductPicker`, `ReceiptForm`, `ReceiptHistory`, `ReceiptDetailDialog`, `ReceiptStatusBadge`, `Pager`
  - `StockInPage`, `AdjustmentForm`, `AdjustmentHistory`, `StockAdjustmentsPage`, `StockCardDialog`
- **Tests:** a test file for each of these, where logic exists.

**Files changed:**
- **Contract and wiring:** `migrations/index.ts`, `ipc-contract.ts`, `ipc/index.ts`, `validation.ts` (`DateSchema`, `RequestIdSchema`).
- **Services:**
  - `settings.service.ts`: `assertCurrencyDigits` moved here from the products service, unchanged.
  - `products.service.ts`: now imports it.
- **Products screen:** `ProductsPage`, `ProductsTable`, and `product-form.ts` (its text parsers moved to `lib/form-text.ts`, unchanged).
- **Renderer wiring:** `routes.ts`, `query-keys.ts`, `app-queries.ts`.
- **Tests:** 20 existing test files were adjusted for schema 2 (details in section 9).

## 6. Tests and results

**Targeted Phase 6 tests** (red first; see the note below):

| File | Tests |
|---|---|
| `0002_stock_adjustment_receipt_item.test.ts` | 11 |
| `stock.service.test.ts` | 60 |
| `stock-forms.test.ts` | 14 |
| `StockUi.test.tsx` | 9 |
| `dates.test.ts` | 3 |
| IPC `stock` suite | 7 |
| contract, preload, routes and Products UI updates | — |

**What `stock.service.test.ts` covers:**
- **Receipts:** one line; several lines; the same product twice; mixed units; zero cost; rollback when a write fails part-way; request-id retry; the number returned after a rollback.
- **Inventory:** Q/V sums, the weighted average, half-up rounding, zero-value stock, no negative Q, and the exact final outflow.
- **Void:**
  - a fresh void restores the exact position;
  - a receipt with the same product on several lines stays voidable;
  - it is locked by a later receipt, adjustment or simulated sale, and by a linked correction;
  - unrelated activity does not lock it;
  - the plan §8.5 counter-example, and a double void.
- **Adjustments:**
  - opening stock, and repeated opening stock blocked;
  - damage, expiry, shortage;
  - count surplus with stock, and from zero stock (cost required);
  - other correction, and receipt quantity correction in and out;
  - receipt cost correction up and down: blocked at Q = 0, never making V negative, the L1 warning, and the L1 lifetime-cost example.
- **Dates:** unrelated products don't block; the affected product blocks; the posting-floor API.
- **Unit lock:** after opening stock, and after a receipt, even once voided.
- **Views and stock card:** the view equals the movement sums; running Q/V and paging.
- **A seeded random sequence** of 150 receipts, shortages, surpluses and void attempts. After every step it checks the invariants and compares the ledger sums with an independent model.

**Deliberate-break check:** I broke four things in the service:
- the own-lines lock exclusion;
- voiding at exact cost (switched to the current average);
- the posting floor;
- the cost-correction baseline.

6 tests failed. Restoring the code made them pass.

**Full suite:** `npm test` passes **1443/1443 in 65 files**. `npm run typecheck` is clean, and `npm run lint` reports 0 problems.

## 7. Manual check (packaged app, isolated data)

I drove `dist\win-unpacked\StockFlow.exe` through its real UI with CDP, on a temporary appData starting from a Phase 5 style schema 1 database. **23/23 checks passed.** The real `%APPDATA%\StockFlow` and `StockFlow-dev` were unchanged.

Beyond the migration above, the checks covered:
1. TEA-01 starts at 0 Piece, with the Low badge.
2. Receiving 10 Box @ 2,400 shows base quantity 240, line cost Rs 24,000.00 and the same total; it saves as GRN-000001.
3. Products shows "10 Box".
4. The stock card matches.
5. 19 Piece plus 5 Kg of a second product → "10 Box + 19 Piece".
6. Damaging 5 Piece asks for no cost; 259 → 254, value 25,900.00 → 25,400.00.
7. Removing 20 Box is blocked with a plain message, and nothing is saved.
8. A fresh receipt is voided through the dialog, and the product returns exactly to its earlier stock and value.
9. GRN-000001 shows locked with Correct Stock, and the main process refuses a void from the renderer.
10. Correct Stock leads to:
    - a quantity correction removing 1 Box at the average;
    - a cost correction to 2,500, with the L1 warning shown before and after saving;
    - both linked to receipt line 1 in the database;
    - the stock card rows and totals agreeing with the ledger.
11. Packing text `1*12*18` and `1*10` is untouched.
12. The form locks the Box size, and the main process returns `UNIT_LOCKED`; a price change still saves.
13. Settings loads with decimal places locked; a manual backup is verified; the integrity check is OK, including stock.

**Also verified:**
- Schema 2 is recorded with both pinned checksums.
- `integrity_check` and `foreign_key_check` are clean.
- `v_product_stock` equals the movement sums.
- The log records the migration, with no profile path and no product or supplier data.

**Bug found and fixed.** The manual check caught a real UI bug.
- **Symptom:** in Stock In, the chosen unit was cleared right after a product was picked.
- **Cause:** Radix Select briefly reports an empty value while a new value's option is not mounted.
- **Fix:** the stock forms now ignore that empty event.
- **Test coverage:** static render tests cannot catch this, so the packaged check is the regression evidence.

## 8. Build result

- `npm run build`: main 223.51 kB, preload 3.73 kB, renderer 1,931.71 kB (Phase 5: 1,830 kB).
- `npm run build:unpack`: OK. The packaged check above ran on this build.

## 9. Needs attention

**Migration 0002 is one-way.**
- On first start, this version backs the database up to `backups\pre-migration` and moves it to schema 2.
- The Phase 5 build refuses a schema 2 database as "too new". Going back means restoring that pre-migration backup.

**20 existing test files were adjusted for schema 2.**
- Backup, restore and upgrade tests now read the expected schema from `migrations.length` instead of assuming 1.
- The mechanics tests for fixture migrations start from a fixed "0001 only" database.
- The 0001 schema tests run on 0001 alone.
- No production behavior changed in them.

**Receipt lines keep no product code or name snapshot.** The 0001 schema snapshots only the unit name and size, so receipt detail shows the product's current code and name.

**Rules I added (please confirm):**
- a. A receipt quantity correction cannot remove more than that line's recorded quantity, after earlier corrections.
- b. A cost correction applies to the line's original quantity, measured from the cost corrected so far. Quantity corrections that add stock to the line are valued separately.
- c. A count surplus on a product with stock refuses a typed cost with a clear message, rather than ignoring it.
- d. Adjustments are allowed on **inactive** products, so stock of discontinued items can be written off. Receipts need active products and active purchasable units.
- e. Opening stock is blocked after **any** movement, including a voided receipt.
- f. Voids also respect the posting floor. This only matters if the PC clock goes backwards.
- g. Corrections of a void receipt are refused.

**Fixed and deferred items:**
- **Numbering:** `GRN-` and `ADJ-` numbers use a fixed 6-digit format and are not configurable.
- **Not built yet:** the low-stock indicator appears only on Products, with no dashboard alerts or P&L. `ADJUSTMENT_REASON_INFO` already records each reason's P&L treatment for later reports.
- **Product picker:** Enter picks the best match, which suits later barcode entry; there is no barcode scanning.

**Refactors:**
- `assertCurrencyDigits` moved from `products.service.ts` to `settings.service.ts`.
- The product form's text parsers moved to `lib/form-text.ts`.
- Both moves are behavior-neutral.

**Bundle size:** the renderer bundle grew by about 101 kB. No new dependency was added.

## 10. Scope

**Phase 7 (customers, payments) was not started.** Invoices were not started either, and nothing was committed.
