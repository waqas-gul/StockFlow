# Phase 8B — Sales / Billing UI: Implementation Report

Status: implemented and verified. **Nothing committed.** Invoice history, void, editing, printing, returns, P&L and Phase 9 were not started.
Schema is still **2**: no migration, and `0001`/`0002` are unchanged.

## 1. Walk-in cash sale rule

- **Backend** (`invoices.service.ts`): for C-00001, `received_minor` must equal `total_minor`, and a zero total takes nothing.
  - An underpayment or overpayment is refused with `VALIDATION`: "Walk-in sales must be paid in full. Select a customer account for credit sales."
  - The error carries a field error on `receivedMinor` and `details: { rule: 'WALK_IN_FULL_PAYMENT', totalMinor, receivedMinor }`.
  - The check runs after the totals are calculated and before anything is written.
- **UI:** Deactivate is hidden for an active C-00001 on the Customers list and on its detail page. An old inactive walk-in can still be reactivated. The backend refusal from 8A stays.

## 2. Billing screen (`Sales → New Invoice`, `/invoices/new`)

- **Header:**
  - Customer picker (code, name, shop, phone, city; active only) with a **Cash Sale** button.
  - Invoice Date (min/max from the main process), Price Tier (Retail/Wholesale).
  - Optional Invoice Code, Bilty No, Transport, Adda, Checked By, Notes.
- **Next invoice number** is shown as a preview: "(assigned when the invoice is posted)". Nothing is reserved.
- **Customer:**
  - An account customer shows "Current balance Rs X Due / Advance / Settled", read fresh.
  - The walk-in shows "Cash Sale: paid in full at the counter. Choose a customer account for credit."
- **Date hint:** "Earliest allowed: 14-Sep-2026 (C-00002 Ali Raza has later account activity)", or "(P-001 Tea has later stock activity)". The floor comes from the backend (`invoices.context`); the renderer does not recalculate it.
- **Product lines:**
  - Add Product searches active products by code, name or company.
  - A product already on the invoice is refused with "… is already on line N. Add its other units on that line."
  - Each line card shows: product, company, packing, **In stock** in the product's units, unit rows (Unit, Quantity, Unit Price, Amount), Add unit, free scheme quantity rows, Discount (None / Percent / Amount), Scheme amount, Ctn (optional, "Printed as written"), Gross / Discount / Scheme / Net, **Leaving stock** (paid + free, in units) and remove.
- **Unsaved invoice:** leaving the screen (sidebar navigation) or pressing Clear with meaningful data asks "Discard this invoice?" (Keep Editing / Discard). Drafts live only in memory.

## 3. Pricing and unit workflow

- **Units:** a new line starts with the product's first active sellable unit. **Add unit** offers the unused sellable units (Box + Piece on one line). The same unit can't appear twice on a line.
- **Prices:**
  - A unit row starts at the configured price for the tier.
  - Switching the tier re-prices every row that still has its configured price; typed prices stay.
  - A unit with no price for the tier starts empty with "No wholesale price: enter a custom price." It is never borrowed from the other tier.
- **Custom price:**
  - Any typed price that differs from the configured one, zero included, gets a **Custom price** badge and "Use list price".
  - It is sent with `priceOverride: true`; retyping the configured price is not an override.
- **Free scheme quantity:** entered as Unit + Quantity. The preview shows it in units ("1 Box + 2 Piece (free goods included)"); the request sends unit rows, and the main process converts them with database unit sizes.
- **Base units** are never shown or typed. Quantities show in the sold units plus the base unit.

## 4. Totals and payment UX

- **Totals panel** (shared Phase 8A `calculateInvoiceTotals`; the backend recalculates everything): Gross, Line Discounts, Scheme Discounts, Extra Discount (input), Net Invoice, Freight (input), Total, Previous Balance, Received, Net Outstanding (Due / Settled / Advance).
- **Received:**
  - For an account customer, Received accepts 0, part, all or more; overpayment previews as "Rs X Advance".
  - Payment Method (Cash / Bank / Cheque / Other, default Cash) and Payment Reference appear once money is received.
  - For the walk-in, Received is **read-only and equals the total**.
- **Stock warning:** when paid + free exceeds the stock, the line shows "Only 5 Box + 2 Piece in stock; this line needs 6 Box." and **Post Invoice is disabled**.
- **Other problems** (missing customer or quantity, bad amounts, a deduction larger than its amount) are shown at their fields once Post Invoice is pressed.
- **Post Invoice:**
  - A short confirmation shows customer, items, invoice total, received, and the account after posting (or "Cash sale: paid in full"). The dialog posts exactly the snapshot shown.
  - One `request_id` per draft; it changes only after a successful post or a discard. Retries reuse it, and a double click posts once (`singleFlight` and the disabled button).
  - Success toast "Invoice INV-000001 saved successfully." (or "… was already saved." on a replay). The form clears, focus returns to Customer, and stock, customers, payments, the next number and settings are re-read. No printing.
- **Error handling:**

| Error | What the screen does |
|---|---|
| `DATE_NOT_ALLOWED` | Shows the backend's message (it names the blocking customer or product and the date) at Invoice Date, plus a toast |
| `INSUFFICIENT_STOCK` | Line message, and the products' stock is re-read |
| `PRICE_CHANGED` | "A price changed since it was entered, so nothing was posted. The line now shows the current price: check it and post again." The products are re-read, non-custom prices refresh, and "The retail price is Rs 2,500.00." appears at the price |
| Walk-in rule | Shown at Received |
| `VALIDATION` / `NOT_FOUND` / `FORBIDDEN_STATE` | Mapped to their fields (e.g. `customerId` → Customer, `lines.N.schemeMinor` → that line's scheme) |

  No SQLite text is ever shown.

## 5. APIs added

- `invoices.context({ customerId | null, productIds })` → `{ today, nextInvoiceNo, earliestDate, earliestDateSetBy }`.
  - Read-only; reuses the 8A floor helpers.
  - The preview applies `invoice.startNumber` exactly as allocation does.
- `invoices.post(InvoiceCreateInput)` → `InvoiceSaveResult` (the 8A `createInvoice`).
- **Reused:** `customers.search/get`, `products.search/get`. No generic search was added, and no raw IPC or SQL.
- **Contract, preload and IPC boundary:** handlers validate with the shared schemas, and the main-process clock is used.

**Files:**
- **Added:** `features/invoices/`
  - `invoice-draft.ts` (state and reducer)
  - `invoice-summary.ts` (parsing, preview, per-field issues, request)
  - `invoice-actions.ts` (posting and error mapping)
  - `NewInvoicePage.tsx`, `InvoiceEditor.tsx`, `InvoiceLineCard.tsx`, `InvoiceTotalsPanel.tsx`, `PostInvoiceDialog.tsx`
  - three test files
- **Changed:**
  - `shared/invoices.ts`: walk-in message and rule, context schema and type.
  - `invoices.service.ts`: walk-in rule, `invoiceContext`.
  - `ipc-contract.ts`, `ipc/index.ts`, `app-queries.ts`, `query-keys.ts`, `routes.ts`
  - `CustomersTable.tsx`, `CustomerDetailPage.tsx`
  - tests

## 6. Tests, build and manual verification

| Tests | Count | Covers |
|---|---|---|
| `invoices.service.test.ts` | +9 | Walk-in under-, over- and unpaid refused, nothing written; exact payment settles; zero-total walk-in; account customers still credit or advance; context number preview (start number, prefix, padding; nothing consumed); floor naming customer or product; invalid input |
| IPC `invoices` | +5 | Context and post end to end, replay; walk-in, stale price, stock and date as clean AppErrors; boundary refusals |
| `invoice-draft.test.ts` | 15 | Retail/wholesale defaults, missing tier price, custom price and override flag, Box + Piece, duplicate product, unit change pricing, free quantity conversion, stock overrun block, discount/scheme preview, totals and overpayment, walk-in received lock, field issues, exact request (validated by `InvoiceCreateSchema`), product refresh |
| `invoice-actions.test.ts` | 7 | Success and replay messages; same request id on retry; double click posts once; stale price refresh; stock and date errors at fields; walk-in message at Received; field mapping |
| `InvoicesUi.test.tsx` | 9 | Header and number preview, balance states, walk-in received lock, line card (custom price, stock in units), missing tier price, stock warning and disabled Post, backend errors at fields, totals and payment method, confirmation |
| Customers UI, routes | +1, +1 | Walk-in Deactivate hidden; route |

**Deliberate-break check:** I disabled 10 rules, one at a time. Each broke at least one test, and the files were restored byte-for-byte. The rules were:
- backend walk-in rule
- walk-in received lock
- override flag
- stock block
- free quantity in the stock request
- tier re-pricing
- one product per invoice
- stable request id
- stale-price refresh
- walk-in Deactivate hidden

**Commands:**
- `npm run typecheck`: clean.
- `npm run lint`: 0 problems.
- Prettier on the changed files: clean.
- `npm test`: **1673/1673 in 79 files** (8A: 1627 in 76).
- `npm run build`: main 286.73 kB, preload 5.47 kB, renderer 2,127.17 kB.

**Manual verification:** the built app ran unpackaged with a redirected temporary appData, driven through its real UI over CDP. **19/19 checks passed.**
- The product, stock receipt and customer were created through the app's own IPC calls; everything else went through the screen.
- The real `%APPDATA%\StockFlow` and `StockFlow-dev` were unchanged, and the temporary data was removed.

1. Stock received (GRN-000001).
2. Customer C-00002 created (Rs 1,000 due) and selected in the picker.
3. Retail invoice INV-000001; the number was a preview; the confirmation summed up.
4. Box + Piece (one item, two quantity rows, 53 pieces).
5. Wholesale (Box at Rs 2,300).
6. Custom price (badge; Sugar with no wholesale price needed a typed price; saved at the typed prices).
7. 10% discount.
8. Free 2 Piece ("1 Box + 2 Piece (free goods included)", scheme 2, costed).
9. Freight Rs 150.
10. Partial Rs 500 by Bank (RCP-000001 linked).
11. Overpayment previews and saves as "Rs 100.00 Advance".
12. Walk-in Cash Sale with read-only Received = total; an underpaid walk-in post through IPC refused.
13. 6 Box against 5 Box + 2 Piece: inline warning, Post disabled.
14. Date refusal and stale-price refusal shown with nothing saved; posting again with a double click saved exactly INV-000010.
15. Stock and balances: Q and V = receipts − sold (paid + free) and − frozen COGS; SALE movements match their lines; each invoice's previous balance chains from the last; Ali Rs 2,400.00 Due on screen; integrity check OK.

Also verified: no Deactivate for C-00001 (the backend refuses it too), the unsaved-invoice guard, and a clean exit.

**Bugs the manual run caught (fixed):**
1. The confirmation dialog was unmounted while open when the form reset after a save, which left the page unclickable. The dialog now stays mounted and shows the snapshot being posted.
2. Focus returned to the Customer field before the reset had rendered, so it showed the previous customer and "No active customer matches". Focus now moves after the cleared form renders.

## 7. Needs attention

1. **Walk-in rule** is enforced for new invoices only. Payments and adjustments on C-00001 through Phase 7 screens are still possible and could move its balance.
2. **Closing the app window** with an unsaved invoice does not ask; only in-app navigation and Clear do.
3. **The toast** after saving sits over the bottom-right Post Invoice button for about 4 seconds.
4. **The stock shown on a line** is read when the product is added and refreshed after a stock or price refusal; posting always re-checks.

## 8. Scope

**Phase 9 was not started.** Invoice history (`/invoices` is still a placeholder), void, edit, printing/PDF, returns, P&L and dashboard sales were not built. Nothing was committed.
