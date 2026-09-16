# Phase 8A — Sales / Invoice Posting Engine: Implementation Report

Status: implemented and verified, **backend and shared validation only**. **Nothing committed.** Phase 8B (billing UI) and Phase 9 were not started.
Schema is still **2**: no migration 0003, and `0001`/`0002` are unchanged. No schema defect was found.

## 1. Walk-in customer

- C-00001 "Cash / Walk-in" is identified by its code (`WALK_IN_CUSTOMER_CODE`, `isWalkInCustomer`). Codes never change.
- It **cannot be deactivated** and **keeps its name**. Both are refused with `FORBIDDEN_STATE`, and a rename carries a field error on `name`.
- Its other profile fields can still be edited.
- If an older version deactivated it, reactivating it still works.
- No other walk-in customer can be created by the system.

## 2. Invoice transaction flow

`createInvoice(db, input, now)` in `services/invoices.service.ts` parses the input with the shared schema, then runs **one `BEGIN IMMEDIATE` transaction**:

1. **Request id:** an invoice already saved with this `request_id` is returned (`replayed: true`).
2. **Currency:** the decimal places must match the setting (`CONFLICT` otherwise).
3. **Customer:** must exist (`NOT_FOUND`) and be active (`FORBIDDEN_STATE`). The walk-in customer is valid.
4. **Products and units:** each product must exist and be active. Each unit must belong to the product, be active and have `can_sell`. The problems of every line are reported together (`VALIDATION`).
5. **Date:** ≤ today (main-process clock), ≥ the customer's latest ledger date, and ≥ the latest stock movement of every product on the invoice. `DATE_NOT_ALLOWED` names the blocker; when both floors block, it names the later one. Other customers and products never block.
6. **Prices** (see §3).
7. **Totals:** calculated from database unit sizes and the accepted prices (see §3).
8. **Stock:** Q ≥ paid + free quantity for each product. Otherwise `INSUFFICIENT_STOCK`, with each short line's product, `availableQtyBase` and `requestedQtyBase`.
9. **COGS** (see §4).
10. **Invoice number:** `invoice.prefix` + the `invoice` sequence padded to `invoice.padding`, e.g. `INV-000001`.
    - `invoice.startNumber` applies only while no invoice exists and the sequence is still at 1.
    - A number that is already taken is refused with `CONFLICT`.
11. **Header:** customer snapshot (`cust_*`), dispatch fields, `invoice_code`, `checked_by`, `notes`, every total, previous balance, net outstanding and COGS.
12. **Per line, in order:** `invoice_items` (product snapshot), its `invoice_item_quantities` (unit snapshot), then one `SALE` movement (−qty_base, −cost).
13. **`INVOICE` ledger entry** of +total, linked to the invoice, only when total > 0.
14. **When received > 0:** a real payment (next `RCP-` number, `invoice_id` set, dated the invoice date) and its `PAYMENT` ledger entry of −received. This uses the same `insertPayment` as Receive Payment.
15. **Checks before commit:**
    - `assertStockInvariants` (Phase 6) on every affected product.
    - Σ ledger must equal previous + total − received. This is an internal safeguard; a mismatch rolls back.
16. **Return:** the saved invoice read back, plus `balanceAfterMinor`.

If any step fails, nothing is kept: no rows, no stock or balance change, and no invoice or payment number used. The stock check and the deduction always share the one write transaction.

`getInvoice(db, id)` returns an invoice as saved (header, lines, quantity rows, counter payment).

## 3. Pricing and calculation model

**Request** (`shared/invoices.ts`, `InvoiceCreateSchema`, strict: unknown fields are refused):
- **Invoice fields:** `priceTier` (`RETAIL`/`WHOLESALE`), `extraDiscountMinor`, `freightMinor`, `receivedMinor`, `paymentMethod` (required when received > 0, ignored otherwise), `paymentReference`, and the optional texts.
- **Per line:** `productId`, `quantities`, `freeQuantities`, `discount`, `schemeMinor` and `ctnCount` (informational only).
  - `quantities` is at least one `{ unitId, quantity, unitPriceMinor, priceOverride }`.
  - `freeQuantities` is `[{ unitId, quantity }]`.
  - `discount` is `null`, `{ type: 'PERCENT', bps }` or `{ type: 'AMOUNT', amountMinor }`.
- Quantities are whole numbers from 1 to 1,000,000; amounts are whole minor units ≥ 0.
- The request never carries unit sizes, amounts, totals, balances or costs.
- **Refused by the schema:**
  - the same product on two lines (all of a product's units go on one line)
  - the same unit twice on a line

**Prices:**
- **`priceOverride: false`:** the price must equal the unit's configured price for the tier.
  - A different price gives `PRICE_CHANGED`, with the configured price per field, so a stale form never saves at a price the operator did not see.
  - If the tier has no price, the request is refused (`VALIDATION`) unless it is an override. There is **no fallback** between retail and wholesale.
- **`priceOverride: true`:** the operator's price (≥ 0, zero allowed) is accepted.
- Only the final price is stored; there is no approval workflow.

**Totals** (`shared/invoice-totals.ts`, `calculateInvoiceTotals`): pure, built on the Phase 2 `calculateLine`/`calculateInvoice`/`applyDeductions` with fixed keys. The 8B form can use it as the preview; the main process runs it again from database values.

| Level | Formula |
|---|---|
| Quantity row | `amount = quantity × unit price`; `qty_base = quantity × unit size` |
| Line | `gross = Σ row amounts` |
| | `discount` = % of gross rounded half-up (`discount_bps` kept), or a fixed amount |
| | `net = gross − discount − scheme_minor`, never below 0 |
| | `qty_base = paid + free`; `scheme_qty_base = free` |
| Invoice | `net = Σ line net − extra discount`, never below 0 |
| | `total = net + freight` |
| | `net_outstanding = previous balance + total − received` |

- A deduction larger than what it applies to is reported on its field (`lines.N.discount`, `lines.N.schemeMinor`, `extraDiscountMinor`).
- Amounts too large to keep exactly are reported on `lines.N` or `root`. Nothing is written in either case.
- **Free goods** add no revenue but leave stock and are costed. **Freight** is charged to the customer; no P&L was built.

## 4. COGS model

- For each line: `costOut = round_half_up(V × qtyOut ÷ Q)` (Phase 2 `applyOutflow`), where qtyOut = paid + free.
  - When qtyOut = Q, it is exactly the remaining V.
  - Zero-value stock sells at cost 0 (never −0).
- **A line is costed once, on its total quantity, not per unit row.** Example: 2 Box + 5 Piece = 53, against Q 247 and V 2,063,007, costs 442,670. Costing each row separately would give 442,669.
- The positions come from a transaction-local running Q/V map per product, updated after each line. Duplicate product lines are refused anyway, so each product is costed exactly once.
- The cost is frozen in `invoice_items.cost_minor` and in the `SALE` movement (`value_minor = −cost`). `invoices.cogs_minor = Σ line costs`. Later stock at other costs never changes it (tested).

## 5. Integration

- **Stock:** reuses the Phase 6 `inventory.ts` helpers `stockPositions`, `latestMovement`, `assertPostingDate`, `assertStockInvariants`, `quantityText` and `inventoryTransaction`. No separate stock logic.
- **Customer ledger:** reuses the Phase 7 `customer-ledger.ts` helpers `customerRow`, `customerBalance`, `latestLedgerDate`, `assertCustomerPostingDate` and `appendLedgerEntry`. `appendLedgerEntry` now accepts an `invoiceId`. The ledger is only appended to, and a zero total writes no `INVOICE` row. Previous balance is Σ ledger at posting, which the customer floor makes the chronological balance.
- **Payments:** Phase 7's posting steps were extracted as `insertPayment` (number → row → `PAYMENT` entry); `createPayment` keeps its checks and calls it. A counter payment is an ordinary payment: it appears in the Payments list, detail and ledger. Its request id is `invoice:<invoice request id>`, a form a renderer request id cannot take.
- **IPC:** not wired in 8A. There is no `invoices.*` channel yet; 8B adds it with the form.

## 6. Idempotency

- The same `request_id` returns the original invoice (`replayed: true`) before any other check, even if prices, stock or the input changed since.
- Nothing is written again: one invoice, one set of items and quantity rows, one `SALE` per line, one `INVOICE` entry, at most one payment, and no extra invoice or payment number (tested).

## 7. Tests and results

| File | Tests | Covers |
|---|---|---|
| `shared/invoice-totals.test.ts` | 8 | Box + Piece gross; % discount rounding; fixed discount + scheme; free quantity; extra discount + freight + outstanding; zero total and advance; oversized deductions reported per field; overflow |
| `shared/invoices.test.ts` | 9 | Strict shape (no unit sizes or totals); lines and quantities required; duplicate product and unit refused; value ranges; explicit `priceOverride`; payment method when received; invoice number format |
| `services/invoices.service.test.ts` | 55 | See below |
| `services/customers.service.test.ts` | +4 | Walk-in: identity, cannot deactivate, reactivation, keeps its name |

**`invoices.service.test.ts`:**
- **Math (§32):** one unit, Box + Piece, multiple products, retail, wholesale, override (incl. 0), missing tier price (no fallback), stale price, % discount, fixed discount, scheme amount, free quantity, extra discount, freight, received, zero total, overpayment advance; saved totals equal the shared preview.
- **Stock/COGS (§33):** Q and V decrease; insufficient stock (single and multiple products); free quantity counts against stock; weighted average; selling everything leaves V exactly 0; zero-value stock; line-level cost for mixed units; other products untouched; historical cost frozen.
- **Customer (§34):** balance increase; invoice + received; advance; no zero `INVOICE` row; payment linked (`invoice_id`, number, method, reference, request id); ledger append-only; walk-in sale; inactive and missing customer refused; previous balance includes same-day entries.
- **Atomicity (§35):** failures injected after the header, an item, the quantity rows, the first stock movement, the `INVOICE` entry, the payment row, and the `PAYMENT` entry (at the read-back). Each leaves every table, sequence, stock position and balance exactly as before, and the same request then saves as INV-000001 / RCP-000001.
- **Idempotency (§36)**, **dates (§37)** (product floor, customer floor, later floor named, future date, unrelated product/customer, floor date allowed), **snapshots (§38)** (customer name/shop/phone/address/city, product code/name, company, packing label, unit names and prices changed after posting: the invoice reads back identical).
- **Units (§22) and overflow (§23):**
  - Refused: a missing or inactive product; a unit of another product, an inactive unit, or one that cannot be sold (paid and free).
  - A unit size in the request is refused.
  - An oversized price × quantity or balance is refused before writing.
- The integrity check stays OK after invoices and a counter payment.

**Deliberate-break check:** I disabled 16 rules, one at a time. Each made at least one test fail, and the files were restored byte-for-byte (hash-checked). The rules were:
- idempotency
- customer floor, product floor, and naming the later floor
- configured-price check
- stock availability
- startNumber only while unused
- no zero `INVOICE` entry
- counter payment written
- inactive customer
- unit can be sold
- unit size from the database
- customer snapshot read-back
- free quantity leaving stock
- walk-in always active, and walk-in keeps its name

**Commands:**
- `npm run typecheck`: clean.
- `npm run lint`: 0 problems. Prettier check on the changed files: clean.
- `npm test`: **1627/1627 in 76 files** (Phase 7: 1551 in 73).
- `npm run build`: main 248.49 kB, preload 5.10 kB, renderer 2,032.37 kB.
- Coverage and a packaged run were not needed: there is no UI or Electron-specific change.

## 8. Files

- **Added:**
  - `src/shared/invoices.ts`, `src/shared/invoice-totals.ts`
  - `src/main/services/invoices.service.ts`
  - their three test files
- **Changed:**
  - `src/shared/customers.ts`: walk-in constant and helper.
  - `customers.service.ts`: walk-in protection.
  - `customer-ledger.ts`: `invoiceId` on ledger entries.
  - `payments.service.ts`: `insertPayment` extracted; behavior unchanged, Phase 7 tests pass.
  - `test-utils.ts`: `failingReads`.
  - `customers.service.test.ts`.

## 9. Decisions and needs attention

1. **Walk-in on credit:** an invoice for C-00001 may leave a balance, because no rule requires walk-in sales to be paid in full. **Please confirm** whether 8B should require received = total for the walk-in customer.
2. **Walk-in on the Customers screen:** Deactivate is still shown for C-00001. Clicking it shows the refusal message, and a rename shows a field error. Hiding the button is UI work for 8B.
3. **Paid quantity required:** a line needs at least one paid quantity row. A product given entirely free is entered as a row with price override 0.
4. **One line per product:** duplicate product lines are refused rather than merged.
5. **Scheme shape:**
   - `scheme_minor` is an amount only, with no percentage.
   - Free quantity is entered in units but stored as the base total (`scheme_qty_base`); print can split it back into units.
6. **Price override is not marked on the invoice:** the schema has no column for it, and only the final price is stored.
7. **Counter payment void:** the payment saved with an invoice can currently be voided on its own from the Payments screen (Phase 7 rules). How invoice void treats it (plan C5) is for the invoice-void phase.
8. **Integrity check:** there are no invoice-document checks yet (header = Σ lines, one `SALE` per line). The existing checks pass on posted invoices.
9. **No IPC channel yet** (see §5).

## 10. Scope

**Not started:** billing UI, invoice history, printing, invoice void, dispatch-detail edits, dashboard/P&L, Phase 8B, Phase 9. **Nothing was committed.**
