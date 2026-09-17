# Phase 9A — Invoice History, Detail and Void: Implementation Report

Status: implemented and verified. **Nothing committed.** Printing/PDF (Phase 9B), expenses and reports were not started.
Schema is still **2**: no migration, and `0001`/`0002` are unchanged. The schema already had everything needed: `invoice_change_log`, the dispatch columns, `SALE_VOID`, `INVOICE_VOID`/`PAYMENT_VOID`, and their unique indexes.

## 0. Phase 8B cleanups

**A. Walk-in financial protection (C-00001 keeps a zero account)**
- **Backend** refusals (`FORBIDDEN_STATE`, nothing written, no number used):
  - `payments.create` for C-00001: "C-00001 Cash / Walk-in is the walk-in customer, so it cannot receive a separate payment. Cash sales are paid in full on the invoice."
  - `customers.adjustBalance` for C-00001: "… so its balance cannot be adjusted. …"
  - **Added beyond the brief:** `payments.void` of a walk-in *counter* payment while its invoice is still POSTED: "Payment RCP-X was received with walk-in invoice INV-Y. Void the invoice instead: …". Without it, voiding that payment on its own would leave C-00001 with a due balance. Older standalone walk-in payments (no invoice) can still be voided.
- **UI:**
  - The C-00001 customer page has no Receive Payment or Adjust Balance, and explains why.
  - The Receive Payment picker never offers C-00001.
  - The payment detail of a walk-in counter payment has no Void Payment and says to void the invoice.
- Historical ledger rows are untouched.

**B. Success toast.** "Invoice INV-X saved successfully." now appears **top-centre for 2.5 s**. Error toasts stay bottom-right. The manual run confirmed the success toast no longer overlaps Post Invoice and the button stays clickable.

## 1. Invoice History (`Sales → Invoice History`, `/invoices`)

- **Columns:** Invoice No, Date, Customer (saved name + code), Shop, Total, Received, Outstanding (saved balance after the invoice: Due/Settled/Advance), Status, View. Void rows are muted with the total struck through.
- **Filters:** a search box, a From–To date range and a status filter (All/Posted/Void).
  - Search words must all match, against the invoice number, customer code, and the **saved** customer and shop names.
- **Pagination:** 25 per page (the API allows at most 100). Newest first by date, then number.
- The sidebar item is renamed "Invoices" → "Invoice History". It stays highlighted on `/invoices/:id` but not on `/invoices/new`.

## 2. Invoice Detail (`/invoices/:id`) — saved snapshots only

- **Header:** number, status, date, price tier, Invoice Code, Checked By, Notes, recorded time, total. A void invoice shows "Voided on …: reason".
- **Customer:** the copy saved on the invoice (name, code, shop, phone, city, address).
- **Dispatch:** Bilty No, Transport, Adda, the last change time, and the change log.
- **Items:**
  - product code/name/company and packing, all as saved;
  - each quantity row as "2 Box × Rs 2,400.00 = Rs 4,800.00";
  - free scheme quantity, gross, discount (with % when entered), scheme amount, net;
  - a Ctn column only when some line has one.
- **Payment received with the invoice:** Payment No (opens the existing payment detail dialog), amount, method and **current** status. A payment voided on its own shows Void; Received still shows the saved amount.
- **Totals:** Gross, Line Discounts, Scheme Discounts, Extra Discount, Net Invoice, Freight, Total, Previous Balance, Received, Net Outstanding.
- **Frozen COGS** appears only inside a collapsed "Internal" section.
- Nothing is read from the current customer, product, unit or price. Tests rename all of them and compare.

## 3. Dispatch details after posting

- **API:** `invoices.updateDispatch({ id, biltyNo, transportName, addaName, note })`. The strict schema refuses any other key: customer, date, lines, prices, discounts, totals, received, COGS.
- **Writing:**
  - One `invoice_change_log` row per field that really changes: field (`bilty_no`, `transport_name`, `adda_name`), old value, new value, `changed_at` and note.
  - The same time is written to `dispatch_updated_at`.
  - Nothing is written when nothing changed.
  - Cleared fields log a null new value.
- A **void invoice keeps its dispatch details** (FORBIDDEN_STATE).
- The database still refuses changes to financial columns (existing trigger), and the change log is append-only. Both are tested.

## 4. Invoice void algorithm (`invoice-void.service.ts`, one BEGIN IMMEDIATE transaction)

1. The invoice exists (NOT_FOUND) and is POSTED ("Invoice INV-X is already void.", FORBIDDEN_STATE).
2. **Void date = today.** Today must be on or after the latest stock movement of every product on the invoice, and on or after the customer's latest ledger entry (DATE_NOT_ALLOWED otherwise, e.g. the clock was set back). Nothing is back-dated.
3. **Exact-reversal checks:**
   - every line still has its own SALE movement of exactly −qty_base / −cost_minor (otherwise **INVENTORY_INVARIANT**, a new error code);
   - an INVOICE entry of +total exists exactly when total > 0;
   - the counter payment exists exactly when money was received, for that amount and customer (otherwise FORBIDDEN_STATE "cannot be voided …").
4. The walk-in decision (§6); VALIDATION when it isn't given.
5. POSTED → VOID with reason, `voided_at` and `void_date`.
6. One **SALE_VOID per line: +qty_base at +cost_minor** (the frozen cost), dated today. It never uses today's weighted average.
7. **INVOICE_VOID of −total**, linked to the invoice, with the reason as its note. It is written only when total > 0; there is never a zero row.
8. Walk-in only: the counter payment's void (POSTED → VOID) and PAYMENT_VOID of +amount, through the payment service's shared `writePaymentVoid`, so payment-void logic isn't duplicated.
9. Stock invariants (existing helper).
10. Customer balance check: after = before − total (+ amount if the payment was voided); otherwise roll back.

Original SALE, INVOICE and PAYMENT rows are never changed. The SALE_VOID naturally becomes the product's new posting floor.

**Double action:** the status check inside BEGIN IMMEDIATE, the unique `(invoice_item_id, type)` and `(invoice_id, type)` indexes, `singleFlight`, and a disabled button while voiding. No void request id and no migration.

## 5. Linked-payment policy (account customers)

- Voiding does **not** void the counter payment. The money was received, so the payment stays and the customer's balance shows it as credit.
  - Example: Rs 1,000 invoice, Rs 1,000 received → after the void the customer has Rs 1,000 Advance.
- The confirmation shows exactly: "This invoice has a payment of Rs X. Voiding the invoice will keep that payment on the customer's account as credit. Void the payment separately if the money was also returned."
- `moneyReturned: true` is refused for account customers, with that guidance.
- A payment already voided on its own is handled: the invoice void still gives the mathematically correct balance.

## 6. Walk-in void policy (simplest safe option)

- A walk-in invoice with a posted counter payment voids **only with "money returned"**:
  - the confirmation has a required checkbox, "The money (Rs X) was returned to the customer";
  - without it the backend refuses with "Walk-in invoice cannot be voided without reversing its received payment." (VALIDATION).
- With it, the invoice and its payment are voided **in the same transaction**, and C-00001 stays exactly at zero.
- The "money not returned / move the credit to a real customer" path is **not offered** in V1.
- **Edge cases:**
  - zero-total walk-in invoice: no payment, voids without the checkbox;
  - payment already voided by older data: voids without the checkbox and returns the balance to zero;
  - payment missing when money was received: refused as inconsistent.

## 7. API

- **Added:** `invoices.list`, `invoices.get`, `invoices.updateDispatch`, `invoices.void`.
- **Reused:** `invoices.context` and `invoices.post`.
- Every handler validates with the shared Zod schemas and uses the main-process clock.
- No raw SQL or IPC in the renderer, and no SQLite text in any error (asserted in IPC tests and the manual run).
- `PaymentDetail` gains `invoiceId`, `invoiceNo` and `invoiceStatus`.

**Files:**
- **Added:**
  - `main/services/invoice-void.service.ts` (+ test);
  - `invoice-history.service.test.ts`;
  - `features/invoices/`: `InvoiceHistoryPage.tsx`, `InvoiceDetailPage.tsx`, `VoidInvoiceDialog.tsx`, `DispatchDialog.tsx`, `invoice-history.ts`, `invoice-test-data.ts` (test-only), and two test files.
- **Changed:**
  - shared: `invoices.ts`, `payments.ts`, `types/result.ts`, `ipc-contract.ts`
  - main: `invoices.service.ts`, `payments.service.ts`, `customers.service.ts`, `ipc/index.ts`
  - renderer: `app-queries.ts`, `query-keys.ts`, `routes.ts`, `navigation.ts`, `Sidebar.tsx`, `NewInvoicePage.tsx`, `CustomerDetailPage.tsx` (invoice ledger references now link to the invoice), `CustomerPicker.tsx`, `customer-display.ts`, `PaymentForm.tsx`, `PaymentDetailDialog.tsx`
  - tests

## 8. Tests, build and manual verification

| Tests | Count | Covers |
|---|---|---|
| `invoice-void.service.test.ts` | 34 | Frozen Q/V restored exactly; not today's average after a dearer receipt; multi-product with Box + Piece and free scheme; zero-value goods; original rows unchanged; double void; mismatched SALE → INVENTORY_INVARIANT; future product/customer activity → DATE_NOT_ALLOWED; void becomes the posting floor; account ledger (INVOICE_VOID, payment stays, advance); zero total gives no INVOICE_VOID; payment voided first; `moneyReturned` refused for accounts; inactive customer; missing payment; walk-in (posts paid, needs money returned, voids both at exactly zero, standalone void refused, older void, zero total, inconsistent); **atomicity**: failure after status update / first SALE_VOID / INVOICE_VOID / balance check (account), and after status / SALE_VOID / INVOICE_VOID / payment update / PAYMENT_VOID (walk-in), with invoice, stock, balance and payment unchanged and a retry succeeding |
| `invoice-history.service.test.ts` | 17 | Pagination and ordering; number search; code/name/shop search with all words and literal wildcards; saved-name search after a rename; date and status filters; validation; full snapshot detail after customer/company/product/unit/price edits; payment VOID status; Bilty, Transport and Adda changes with old/new/time/note; multi-field and cleared fields; nothing written when unchanged; financial keys refused; triggers refuse financial columns and change-log UPDATE/DELETE; void/missing/invalid |
| Payments / customers services | +2 / +2 | Walk-in payment and adjustment refused; older walk-in payment still voidable; old ledger rows untouched |
| IPC | +7 | list/get/updateDispatch/void end to end; walk-in refusals and money-returned void as clean errors; boundary refusals |
| Renderer | +25 | `invoice-history.test.ts` (void plan and warnings, confirm-button rule, saved quantity text, messages, raw errors hidden), `InvoiceHistoryUi.test.tsx` (history table, detail sections, COGS collapsed, void/payment VOID views, change log, void confirmation for account and walk-in, dispatch form), customers/payments UI walk-in, sidebar highlight, routes |

**Deliberate-break check:** all 18 rules caught (§10).

**Commands:**
- `npm run typecheck`: clean.
- `npm run lint`: 0 problems.
- Prettier on changed files: clean.
- `npm test`: **1760/1760 in 83 files** (8B: 1673 in 79).
- `npm run build`: main 300.03 kB, preload 5.94 kB, renderer 2,178.83 kB.

**Manual verification:** the built app ran with a redirected temporary appData and was driven through its real UI over CDP. **16/16 checks passed.**
- Stock, the customer and one later receipt were created through the app's IPC; everything else went through the screens.
- The real `%APPDATA%\StockFlow` and `StockFlow-dev` were unchanged, and the temporary data was removed.

1. Stock (GRN-000001) and customer created.
2. Posted INV-000001 (Ali: 2 Box + 5 Piece, Rs 1,000 by Bank) and walk-in INV-000002, with a dearer receipt in between.
3. History lists both; number and saved-shop search; Void filter.
4. Detail shows the saved snapshot after the customer was renamed; COGS collapsed.
5. Edit Dispatch: two log rows, financials unchanged.
6. Voided INV-000001: exact warning, reason required; a double click voided once.
7. RCP-000001 stays posted and Ali shows Rs 1,000.00 Advance.
8. Walk-in: payment can't be voided alone; Void disabled until "money returned" is ticked; invoice and RCP-000002 voided together.
9. Walk-in ledger nets to exactly 0.
10. SALE_VOID = −SALE at frozen cost (Rs 5,300.00, not the Rs 8,278.92 average); tea back to 480 pieces / Rs 72,000.00.
11. Second void refused cleanly; integrity OK.

Also verified: walk-in actions hidden and refused, the payment picker, toast placement, and a clean exit.

## 9. Needs attention

1. **New error code** `INVENTORY_INVARIANT`, used only when an invoice's SALE records no longer match its lines. Stock-invariant failures after writing still use the existing helper's `INSUFFICIENT_STOCK`/`FORBIDDEN_STATE` (practically unreachable for a void, which only adds stock).
2. **Extra walk-in block:** voiding a walk-in counter payment on its own is refused while its invoice is posted (§0A). This wasn't explicitly requested; it keeps C-00001 at zero.
3. **Walk-in "money not returned"** has no path in V1: such a sale can't be voided. The operator would have to record it differently (e.g. a return, not yet built).
4. **Account customer, money also returned:** two steps — void the invoice, then void the payment from its detail.
5. **History search uses the saved names.** A renamed customer is found by code or the old name, not the new name.
6. **Free scheme quantity** is stored only in base units. The detail writes it in the line's saved units, and in "base units" when those can't express it.
7. **Void needs today's date to pass the floors.** If the computer clock is behind the latest activity, the void is refused with DATE_NOT_ALLOWED.
8. Still open from 8B: closing the window with an unsaved invoice doesn't ask; line stock on the billing screen is a snapshot until refused.

## 10. Deliberate-break check

I disabled 18 rules one at a time and ran the targeted tests; files were restored byte-for-byte (hash-checked).

- **Caught on the first run (17):**
  - void: exact frozen cost, double void refused, no zero INVOICE_VOID, account payment stays posted, walk-in needs money returned, sale records must match;
  - dispatch: change logged, void invoice keeps its details;
  - history search on saved names;
  - walk-in backend: standalone payment, counter-payment void, balance adjustment;
  - UI: walk-in vs account warning, no Receive Payment/Adjust Balance for walk-in, picker leaves out walk-in, no Void Payment for a walk-in counter payment, sidebar highlight.
- **Survived at first:** "the walk-in void button needs the money-returned tick". The render test starts with an empty reason, so the button was disabled anyway. I moved the rule into `canConfirmVoid` with its own test; the rerun catches it.

## 11. Scope

**Phase 9B was not started:** no print layout, PDF, printer dialog or invoice paper rendering. No returns, expenses or reports. Schema version 2. Nothing was committed.
